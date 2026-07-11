import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { createTestLogger } from "../../__tests__/test-logger.js"
import { reviewResponseJsonSchema } from "../../review/finding.js"
import {
  createOpenRouterClient,
  type ChatRequestSubset,
  type OpenRouterLike,
} from "../client.js"

const readJsonFixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), "utf8"),
  )

const acceptedChatResult = readJsonFixture("openrouter.chat-result.json")
const invalidJsonChatResult = readJsonFixture("openrouter.invalid-json.json")
const schemaMismatchChatResult = readJsonFixture(
  "openrouter.schema-mismatch.json",
)

/** The review JSON embedded in the accepted chat-result fixture, parsed. */
const acceptedReview = {
  analysis:
    "src/greeter.ts: verified the empty-key guard and traced register() callers.",
  findings: [],
}

/** Accepted-shape chat result whose usage carries no cost — the case that
 *  routes the client to the generation cost lookup. */
const makeNoCostChatResult = (): unknown => ({
  id: "gen-no-cost",
  model: "openai/gpt-5-mini",
  choices: [{ message: { content: JSON.stringify(acceptedReview) } }],
  usage: { promptTokens: 12000, completionTokens: 800, cost: null },
})

type StubResponse = { value: unknown } | { error: unknown }

const makeSdkStub = ({
  sendResponses,
  generationResponses = [],
}: {
  sendResponses: StubResponse[]
  generationResponses?: StubResponse[]
}) => {
  const sendCalls: { chatRequest: ChatRequestSubset }[] = []
  const generationCalls: { id: string }[] = []

  const takeNext = (
    queue: StubResponse[],
    callCount: number,
    operation: string,
  ): unknown => {
    const next = queue[callCount - 1]
    if (next === undefined) {
      throw new Error(`stub: unexpected ${operation} call #${callCount}`)
    }
    if ("error" in next) throw next.error
    return next.value
  }

  const sdk: OpenRouterLike = {
    chat: {
      send: async (request) => {
        sendCalls.push(request)
        return takeNext(sendResponses, sendCalls.length, "chat.send")
      },
    },
    generations: {
      getGeneration: async (request) => {
        generationCalls.push(request)
        return takeNext(
          generationResponses,
          generationCalls.length,
          "generations.getGeneration",
        )
      },
    },
  }

  return { sdk, sendCalls, generationCalls }
}

const makeClient = (stub: { sdk: OpenRouterLike }) => {
  const logger = createTestLogger()
  const client = createOpenRouterClient({ sdk: stub.sdk }, logger)
  return { client, logger }
}

const makeStatusError = (statusCode: number): Error =>
  Object.assign(new Error(`HTTP ${statusCode}`), { statusCode })

const requestParams = {
  systemPrompt: "system prompt",
  userPrompt: "user prompt",
  model: "openai/gpt-5-mini",
  fallbackModel: "anthropic/claude-haiku-4.5",
}

describe("requestReview", () => {
  it("sends the strict json_schema response format with the review schema", async () => {
    const stub = makeSdkStub({ sendResponses: [{ value: acceptedChatResult }] })
    const { client } = makeClient(stub)

    await client.requestReview(requestParams)

    expect(stub.sendCalls).toEqual([
      {
        chatRequest: {
          model: "openai/gpt-5-mini",
          messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "user prompt" },
          ],
          responseFormat: {
            type: "json_schema",
            jsonSchema: {
              name: "review_response",
              strict: true,
              schema: reviewResponseJsonSchema,
            },
          },
          stream: false,
        },
      },
    ])
  })

  it("returns the parsed review and a single accepted attempt on first success", async () => {
    const stub = makeSdkStub({ sendResponses: [{ value: acceptedChatResult }] })
    const { client } = makeClient(stub)

    const result = await client.requestReview(requestParams)

    expect(result).toEqual({
      review: acceptedReview,
      modelUsed: "openai/gpt-5-mini",
      attempts: [
        {
          model: "openai/gpt-5-mini",
          outcome: "accepted",
          promptTokens: 12000,
          completionTokens: 800,
          costUsd: 0.0421,
          errorSummary: null,
        },
      ],
    })
  })

  it("retries the same model once on invalid JSON, recording both attempts", async () => {
    const stub = makeSdkStub({
      sendResponses: [
        { value: invalidJsonChatResult },
        { value: acceptedChatResult },
      ],
    })
    const { client } = makeClient(stub)

    const result = await client.requestReview(requestParams)

    expect(
      stub.sendCalls.map((sendCall) => sendCall.chatRequest.model),
    ).toEqual(["openai/gpt-5-mini", "openai/gpt-5-mini"])
    expect(result.attempts).toEqual([
      {
        model: "openai/gpt-5-mini",
        outcome: "invalid_json",
        promptTokens: 11800,
        completionTokens: 42,
        costUsd: null,
        errorSummary: "response content is not valid JSON",
      },
      {
        model: "openai/gpt-5-mini",
        outcome: "accepted",
        promptTokens: 12000,
        completionTokens: 800,
        costUsd: 0.0421,
        errorSummary: null,
      },
    ])
  })

  it("retries the same model once on empty content", async () => {
    const emptyContentResult = {
      id: "gen-empty",
      model: "openai/gpt-5-mini",
      choices: [{ message: { content: "" } }],
      usage: { promptTokens: 10, completionTokens: 0, cost: null },
    }
    const stub = makeSdkStub({
      sendResponses: [
        { value: emptyContentResult },
        { value: acceptedChatResult },
      ],
    })
    const { client } = makeClient(stub)

    const result = await client.requestReview(requestParams)

    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
      "empty_content",
      "accepted",
    ])
  })

  it("advances to the fallback model after two schema mismatches", async () => {
    const stub = makeSdkStub({
      sendResponses: [
        { value: schemaMismatchChatResult },
        { value: schemaMismatchChatResult },
        { value: acceptedChatResult },
      ],
    })
    const { client } = makeClient(stub)

    const result = await client.requestReview(requestParams)

    expect(
      stub.sendCalls.map((sendCall) => sendCall.chatRequest.model),
    ).toEqual([
      "openai/gpt-5-mini",
      "openai/gpt-5-mini",
      "anthropic/claude-haiku-4.5",
    ])
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
      "schema_mismatch",
      "schema_mismatch",
      "accepted",
    ])
  })

  it("retries the same model once on a 429", async () => {
    const stub = makeSdkStub({
      sendResponses: [
        { error: makeStatusError(429) },
        { value: acceptedChatResult },
      ],
    })
    const { client } = makeClient(stub)

    const result = await client.requestReview(requestParams)

    expect(
      stub.sendCalls.map((sendCall) => sendCall.chatRequest.model),
    ).toEqual(["openai/gpt-5-mini", "openai/gpt-5-mini"])
    expect(result.attempts[0]).toEqual({
      model: "openai/gpt-5-mini",
      outcome: "api_error",
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      errorSummary: "HTTP 429: HTTP 429",
    })
  })

  it("retries a status-less network error and records its bare message", async () => {
    const stub = makeSdkStub({
      sendResponses: [
        { error: new Error("socket hang up") },
        { value: acceptedChatResult },
      ],
    })
    const { client } = makeClient(stub)

    const result = await client.requestReview(requestParams)

    expect(
      stub.sendCalls.map((sendCall) => sendCall.chatRequest.model),
    ).toEqual(["openai/gpt-5-mini", "openai/gpt-5-mini"])
    expect(result.attempts[0]).toEqual({
      model: "openai/gpt-5-mini",
      outcome: "api_error",
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      errorSummary: "socket hang up",
    })
  })

  it("truncates an error message longer than 200 characters in the attempt summary", async () => {
    const stub = makeSdkStub({
      sendResponses: [
        {
          error: Object.assign(new Error("x".repeat(250)), {
            statusCode: 429,
          }),
        },
        { value: acceptedChatResult },
      ],
    })
    const { client } = makeClient(stub)

    const result = await client.requestReview(requestParams)

    expect(result.attempts[0]?.errorSummary).toBe(
      `HTTP 429: ${"x".repeat(200)}…`,
    )
  })

  it("advances to the fallback model without a retry on a 404", async () => {
    const stub = makeSdkStub({
      sendResponses: [
        { error: makeStatusError(404) },
        { value: acceptedChatResult },
      ],
    })
    const { client } = makeClient(stub)

    const result = await client.requestReview(requestParams)

    expect(
      stub.sendCalls.map((sendCall) => sendCall.chatRequest.model),
    ).toEqual(["openai/gpt-5-mini", "anthropic/claude-haiku-4.5"])
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
      "api_error",
      "accepted",
    ])
  })

  it.each([401, 402, 403])(
    "aborts the ladder after exactly one call on a %d",
    async (statusCode) => {
      const stub = makeSdkStub({
        sendResponses: [{ error: makeStatusError(statusCode) }],
      })
      const { client } = makeClient(stub)

      await expect(client.requestReview(requestParams)).rejects.toThrow(
        `OpenRouter auth/credit error — aborting without fallback: openai/gpt-5-mini: api_error (HTTP ${statusCode}: HTTP ${statusCode})`,
      )
      expect(stub.sendCalls).toHaveLength(1)
    },
  )

  it("throws a per-attempt summary after exhausting a fallback-less ladder", async () => {
    const stub = makeSdkStub({
      sendResponses: [
        { error: makeStatusError(500) },
        { error: makeStatusError(503) },
      ],
    })
    const { client } = makeClient(stub)

    await expect(
      client.requestReview({ ...requestParams, fallbackModel: null }),
    ).rejects.toThrow(
      "review request failed after 2 attempt(s): openai/gpt-5-mini: api_error (HTTP 500: HTTP 500); openai/gpt-5-mini: api_error (HTTP 503: HTTP 503)",
    )
    expect(stub.sendCalls).toHaveLength(2)
  })

  it("makes at most four calls across both ladder models", async () => {
    const stub = makeSdkStub({
      sendResponses: [
        { value: invalidJsonChatResult },
        { value: invalidJsonChatResult },
        { value: invalidJsonChatResult },
        { value: invalidJsonChatResult },
      ],
    })
    const { client } = makeClient(stub)

    await expect(client.requestReview(requestParams)).rejects.toThrow(
      "review request failed after 4 attempt(s)",
    )
    expect(stub.sendCalls).toHaveLength(4)
  })

  it("treats an unrecognized chat response shape as a retryable api_error", async () => {
    const stub = makeSdkStub({
      sendResponses: [
        { value: { unexpected: true } },
        { value: acceptedChatResult },
      ],
    })
    const { client } = makeClient(stub)

    const result = await client.requestReview(requestParams)

    expect(result.attempts[0]).toEqual({
      model: "openai/gpt-5-mini",
      outcome: "api_error",
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      errorSummary: "unexpected chat response shape",
    })
  })

  it("looks up the generation cost when the accepted attempt has no usage cost", async () => {
    const stub = makeSdkStub({
      sendResponses: [{ value: makeNoCostChatResult() }],
      generationResponses: [{ value: { data: { totalCost: 0.0399 } } }],
    })
    const { client } = makeClient(stub)

    const result = await client.requestReview(requestParams)

    expect(stub.generationCalls).toEqual([{ id: "gen-no-cost" }])
    expect(result.attempts[0]?.costUsd).toBe(0.0399)
  })

  it("degrades to a null cost with a warning when the generation lookup fails", async () => {
    const stub = makeSdkStub({
      sendResponses: [{ value: makeNoCostChatResult() }],
      generationResponses: [{ error: makeStatusError(500) }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams)

    expect(result.attempts[0]?.costUsd).toBeNull()
    expect(logger.messages).toContainEqual({
      level: "warn",
      message: "generation cost lookup failed",
      data: { error: "HTTP 500" },
    })
  })

  it("degrades to a null cost with a warning when the generation response has an unexpected shape", async () => {
    const stub = makeSdkStub({
      sendResponses: [{ value: makeNoCostChatResult() }],
      generationResponses: [{ value: { data: {} } }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams)

    expect(result.attempts[0]?.costUsd).toBeNull()
    expect(logger.messages).toContainEqual({
      level: "warn",
      message: "unexpected generation response shape",
      data: {},
    })
  })

  it("records null token counts when the response omits the usage block", async () => {
    const noUsageResult = {
      id: "gen-no-usage",
      model: "openai/gpt-5-mini",
      choices: [{ message: { content: JSON.stringify(acceptedReview) } }],
    }
    const stub = makeSdkStub({
      sendResponses: [{ value: noUsageResult }],
      generationResponses: [{ value: { data: { totalCost: 0.0399 } } }],
    })
    const { client } = makeClient(stub)

    const result = await client.requestReview(requestParams)

    // costUsd from the lookup proves the missing usage block routed the
    // accepted attempt through the generation-cost fallback
    expect(result.attempts).toEqual([
      {
        model: "openai/gpt-5-mini",
        outcome: "accepted",
        promptTokens: null,
        completionTokens: null,
        costUsd: 0.0399,
        errorSummary: null,
      },
    ])
  })

  it("skips the cost lookup entirely when the sdk has no generations surface", async () => {
    const sdkWithoutGenerations: OpenRouterLike = {
      chat: { send: async () => makeNoCostChatResult() },
    }
    const { client } = makeClient({ sdk: sdkWithoutGenerations })

    const result = await client.requestReview(requestParams)

    expect(result.attempts[0]?.costUsd).toBeNull()
  })
})
