import { readFileSync } from "node:fs"
import { openResponsesResultFromJSON } from "@openrouter/sdk/models"
import {
  BadRequestResponseError,
  OpenRouterError,
  ResponseValidationError,
  UnauthorizedResponseError,
} from "@openrouter/sdk/models/errors"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createTestLogger, logsWithMessage } from "../../__tests__/test-logger.js"
import { reviewResponseJsonSchema } from "../../review/finding.js"
import {
  createOpenRouterClient,
  ReviewRequestError,
  type AgentLike,
  type GenerationsLike,
  type ResponsesResult,
  type ReviewRequest,
} from "../client.js"

const readJsonFixture = (name: string): unknown => {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), "utf8"))
}

// Raw Responses API payloads captured from live requests. The two variants
// are the accepted payload with only its message text edited
const acceptedWirePayload = readJsonFixture("openrouter.responses-accepted.json")
const invalidJsonWirePayload = readJsonFixture("openrouter.responses-invalid-json.json")
const schemaMismatchWirePayload = readJsonFixture("openrouter.responses-schema-mismatch.json")
const overflowErrorBody = readJsonFixture("openrouter.responses-overflow-body.json")
const badKeyErrorBody = readJsonFixture("openrouter.responses-bad-key-body.json")

/** The generation id and usage the accepted wire payload carries. */
const ACCEPTED_GENERATION_ID = "gen-1794440085-n7DSIWy7fBrBUcqMEvla"
const ACCEPTED_USAGE = { promptTokens: 54, completionTokens: 102, costUsd: 0.000021036 }

/** The review JSON in the accepted wire payload's message text, parsed. */
const acceptedReview = {
  analysis:
    'Reviewed the single-line change `export const greeting = "hello"`. This is a simple, valid module-level constant export. The syntax is correct, the value is a static string with no side effects, and naming follows common conventions. No security, correctness, style, or maintainability concerns were identified. As requested, there are no findings to report.',
  findings: [],
}

/** The output items of a wire payload; every other field passes through. */
const wirePayloadSchema = z.looseObject({
  output: z.array(
    z.looseObject({
      type: z.string(),
      content: z.array(z.looseObject({ type: z.string(), text: z.string() })).optional(),
    }),
  ),
})

/** The accepted payload also carries a priced usage block the variants edit. */
const acceptedPayloadSchema = wirePayloadSchema.extend({
  usage: z.looseObject({ cost: z.number() }),
})

const parseAcceptedPayload = (): z.infer<typeof acceptedPayloadSchema> => {
  return acceptedPayloadSchema.parse(acceptedWirePayload)
}

/** The text the Agent SDK extracts from a payload: the first message item's
 *  output text, or "" when the output holds no message item. This mirrors the
 *  SDK's convention rather than calling it, so the tests pin the client's
 *  text-to-outcome mapping, not the SDK's extraction. */
const extractMessageText = (payload: unknown): string => {
  const message = wirePayloadSchema.parse(payload).output.find((item) => item.type === "message")
  const outputText = message?.content?.find((part) => part.type === "output_text")

  if (!outputText) return ""
  return outputText.text
}

/** What the Agent SDK hands the client for a wire payload: the payload run
 *  through the SDK's own transform. The repo's @openrouter/sdk copy runs it
 *  here as a drift guard on hand-edited fixtures; the Agent SDK's bundled
 *  copy parses every field the client reads identically. */
const transformWirePayload = (payload: unknown): ResponsesResult => {
  const transformed = openResponsesResultFromJSON(JSON.stringify(payload))

  if (!transformed.ok) throw transformed.error
  return transformed.value
}

/** What one `callModel` stub call resolves: the transformed response and the
 *  SDK-extracted text, as the client reads them. */
type ModelCallResult = { response: ResponsesResult; text: string }

const toModelCallResult = (payload: unknown): ModelCallResult => ({
  response: transformWirePayload(payload),
  text: extractMessageText(payload),
})

const acceptedResult = toModelCallResult(acceptedWirePayload)
const invalidJsonResult = toModelCallResult(invalidJsonWirePayload)
const schemaMismatchResult = toModelCallResult(schemaMismatchWirePayload)

/** The accepted payload with its usage cost removed — the case that routes
 *  the client to the generation cost lookup. */
const makeNoCostResult = (): ModelCallResult => {
  const { usage, ...payload } = parseAcceptedPayload()
  const usageWithoutCost = Object.fromEntries(
    Object.entries(usage).filter(([key]) => key !== "cost"),
  )
  return toModelCallResult({ ...payload, usage: usageWithoutCost })
}

/** The accepted payload with no usage block at all. */
const makeNoUsageResult = (): ModelCallResult => {
  return toModelCallResult({ ...parseAcceptedPayload(), usage: null })
}

/** The accepted payload with only its reasoning item, so the SDK extracts no text. */
const makeReasoningOnlyResult = (): ModelCallResult => {
  const payload = parseAcceptedPayload()
  const reasoningItems = payload.output.filter((item) => item.type === "reasoning")
  return toModelCallResult({ ...payload, output: reasoningItems })
}

/** `pending` hands the call's request to a custom promise — for a request
 *  that never settles, settles late, or honours the abort signal. */
type StubModelResult =
  | { value: ModelCallResult }
  | { error: unknown }
  | { pending: (request: { signal: AbortSignal }) => Promise<ModelCallResult> }

type StubOptions = { signal?: AbortSignal } | undefined

type StubGenerationResponse =
  { value: unknown } | { error: unknown } | { pending: (options: StubOptions) => Promise<unknown> }

const makeClientStubs = ({
  modelResults,
  generationResponses = [],
}: {
  modelResults: StubModelResult[]
  generationResponses?: StubGenerationResponse[]
}) => {
  const modelCalls: {
    request: ReviewRequest & { signal: AbortSignal }
    options: { retries?: { strategy: "backoff" | "none" } } | undefined
  }[] = []
  const generationCalls: {
    id: string
    options: StubOptions
  }[] = []

  const takeNextModelResult = (request: { signal: AbortSignal }): Promise<ModelCallResult> => {
    const next = modelResults.at(modelCalls.length - 1)

    if (!next) {
      throw new Error(`stub: unexpected callModel call #${modelCalls.length}`)
    }
    if ("error" in next) throw next.error
    if ("pending" in next) return next.pending(request)
    return Promise.resolve(next.value)
  }

  const agent: AgentLike = {
    callModel: (request, options) => {
      modelCalls.push({ request, options })

      // Promise.try settles a synchronous throw from the queue as a rejection,
      // the way the SDK's materialized stream rejects
      const settled = Promise.try(takeNextModelResult, request)
      return {
        getResponse: async () => (await settled).response,
        getText: async () => (await settled).text,
      }
    },
  }

  const costLookupClient: GenerationsLike = {
    generations: {
      getGeneration: async (request, options) => {
        generationCalls.push({ ...request, options })
        const next = generationResponses.at(generationCalls.length - 1)

        if (!next) {
          throw new Error(`stub: unexpected getGeneration call #${generationCalls.length}`)
        }
        if ("error" in next) throw next.error
        if ("pending" in next) return next.pending(options)
        return next.value
      },
    },
  }

  return { agent, costLookupClient, modelCalls, generationCalls }
}

const makeClient = (stub: { agent: AgentLike; costLookupClient: GenerationsLike }) => {
  const logger = createTestLogger()
  const client = createOpenRouterClient({
    agent: stub.agent,
    costLookupClient: stub.costLookupClient,
    remainingReviewMs: () => Infinity,
    requestTimeoutMs: 45_000,
    retryDelayMs: 0,
  })
  return { client, logger }
}

const RESPONSES_URL = "https://openrouter.ai/api/v1/responses"

/** The HTTP metadata the SDK's error classes read their status and body from. */
const makeHttpMeta = (
  statusCode: number,
  body: string,
): { response: Response; request: Request; body: string } => ({
  response: new Response(body, { status: statusCode }),
  request: new Request(RESPONSES_URL),
  body,
})

/** An SDK error of the given status, as the SDK's base class carries it. The
 *  repo's @openrouter/sdk copy stands in for the copy bundled inside
 *  @openrouter/agent, which throws the production errors; both set
 *  `statusCode` from the HTTP response. An error without `statusCode` takes
 *  the status-less path the network-error test pins. */
const makeStatusError = (statusCode: number, message = `HTTP ${statusCode}`): OpenRouterError => {
  return new OpenRouterError(message, makeHttpMeta(statusCode, ""))
}

/** The error the SDK throws when a non-streamed 200 body fails its result
 *  schema, built the way the SDK's response matcher builds it. */
const makeResponseValidationError = (): ResponseValidationError => {
  const body = JSON.stringify({ object: "response" })
  const message = "Response validation failed"

  return new ResponseValidationError(message, {
    ...makeHttpMeta(200, body),
    cause: new Error("output: Invalid input: expected array, received undefined"),
    rawValue: JSON.parse(body),
    rawMessage: message,
  })
}

/** The `{ error: { code, message } }` body OpenRouter sends on a rejected request. */
const errorBodySchema = z.object({ error: z.object({ code: z.number(), message: z.string() }) })

/** The SDK's 400 error built from a captured error body. */
const makeBadRequestError = (body: unknown): BadRequestResponseError => {
  return new BadRequestResponseError(
    errorBodySchema.parse(body),
    makeHttpMeta(400, JSON.stringify(body)),
  )
}

/** The numbers in the captured overflow body's message: the window, the
 *  requested total, the input estimate and the output ceiling. */
const OVERFLOW_NUMBERS_PATTERN =
  /maximum context length is \d+ tokens\. However, you requested about \d+ tokens \(\d+ of text input, \d+ in the output\)/

/** OpenRouter's 400 when the prompt plus the requested output ceiling exceeds
 *  the routed endpoint's context window: the captured body's wording with
 *  only its numbers replaced, so every fitted-retry test runs on the live
 *  wording the detector must match. */
const makeContextOverflowError = ({
  contextLength,
  inputTokens,
}: {
  contextLength: number
  inputTokens: number
}): BadRequestResponseError => {
  const capturedMessage = errorBodySchema.parse(overflowErrorBody).error.message

  if (!OVERFLOW_NUMBERS_PATTERN.test(capturedMessage)) {
    throw new Error("the captured overflow body no longer carries the expected numbers")
  }
  const message = capturedMessage.replace(
    OVERFLOW_NUMBERS_PATTERN,
    `maximum context length is ${contextLength} tokens. However, you requested about ${inputTokens + 128_000} tokens (${inputTokens} of text input, 128000 in the output)`,
  )
  return makeBadRequestError({ error: { code: 400, message } })
}

/** The model and output ceiling of every review request sent, in order. */
const sentCeilings = (stub: {
  modelCalls: { request: ReviewRequest }[]
}): { model: string; maxOutputTokens: number }[] => {
  return stub.modelCalls.map(({ request }) => ({
    model: request.model,
    maxOutputTokens: request.maxOutputTokens,
  }))
}

const CEILING_RETRY_LOG = "retrying with an output ceiling that fits the endpoint's context window"

/** The rejection of a request expected to fail, so its fields can be asserted. */
const captureRejection = async (request: Promise<unknown>): Promise<unknown> => {
  try {
    await request
    return undefined
  } catch (error) {
    return error
  }
}

const requestParams = {
  systemPrompt: "system prompt",
  userPrompt: "user prompt",
  model: "z-ai/glm-5.3-flash",
  fallbackModel: "deepseek/deepseek-v4.1-flash",
}

describe("captured Responses fixtures", () => {
  it("the overflow and bad-key bodies build the SDK's error classes with their status and message", () => {
    const overflowError = makeBadRequestError(overflowErrorBody)
    const badKeyError = new UnauthorizedResponseError(
      errorBodySchema.parse(badKeyErrorBody),
      makeHttpMeta(401, JSON.stringify(badKeyErrorBody)),
    )

    expect([overflowError, badKeyError].map((error) => [error.statusCode, error.message])).toEqual([
      [
        400,
        "This endpoint's maximum context length is 8192 tokens. However, you requested about 11593 tokens (4593 of text input, 7000 in the output). Please reduce the length of either one, or use the context-compression plugin to compress your prompt automatically.",
      ],
      [401, "User not found."],
    ])
  })
})

describe("requestReview", () => {
  it("does not start an attempt when the review deadline has expired", async () => {
    const stub = makeClientStubs({ modelResults: [] })
    const logger = createTestLogger()
    const client = createOpenRouterClient({
      agent: stub.agent,
      costLookupClient: stub.costLookupClient,
      requestTimeoutMs: 45_000,
      remainingReviewMs: () => 0,
    })
    const error = await captureRejection(client.requestReview(requestParams, logger))
    expect(error).toBeInstanceOf(ReviewRequestError)
    if (!(error instanceof ReviewRequestError)) throw error
    expect({
      message: error.message,
      attempts: error.attempts,
      keyRejected: error.keyRejected,
      deadlineExceeded: error.deadlineExceeded,
    }).toEqual({
      message: "review deadline exceeded",
      attempts: [],
      keyRejected: false,
      deadlineExceeded: true,
    })
    expect(stub.modelCalls).toEqual([])
    expect(stub.generationCalls).toEqual([])
  })

  it.each(["primary", "fallback"])(
    "stops the %s request at the shared deadline even when abort is ignored",
    async (rung) => {
      vi.useFakeTimers()
      try {
        const late = Promise.withResolvers<ModelCallResult>()
        const stub = makeClientStubs({
          modelResults: [
            ...(rung === "fallback" ? [{ error: makeStatusError(400) }] : []),
            { pending: () => late.promise },
          ],
        })
        const deadline = performance.now() + 100
        const logger = createTestLogger()
        const client = createOpenRouterClient({
          agent: stub.agent,
          costLookupClient: stub.costLookupClient,
          requestTimeoutMs: 45_000,
          remainingReviewMs: () => deadline - performance.now(),
        })
        const rejection = captureRejection(client.requestReview(requestParams, logger))
        await vi.advanceTimersByTimeAsync(100)
        const error = await rejection
        expect(error).toBeInstanceOf(ReviewRequestError)
        if (!(error instanceof ReviewRequestError)) throw error
        const expectedAttempts = [
          ...(rung === "fallback"
            ? [
                {
                  model: requestParams.model,
                  outcome: "api_error",
                  promptTokens: null,
                  completionTokens: null,
                  costUsd: null,
                  errorSummary: "HTTP 400: HTTP 400",
                },
              ]
            : []),
          {
            model: rung === "primary" ? requestParams.model : requestParams.fallbackModel,
            outcome: "timeout",
            promptTokens: null,
            completionTokens: null,
            costUsd: null,
            errorSummary: "review deadline exceeded",
          },
        ]
        expect({
          message: error.message,
          attempts: error.attempts,
          keyRejected: error.keyRejected,
          deadlineExceeded: error.deadlineExceeded,
        }).toEqual({
          message: "review deadline exceeded",
          attempts: expectedAttempts,
          keyRejected: false,
          deadlineExceeded: true,
        })
        expect(
          stub.modelCalls.map(({ request }) => ({
            model: request.model,
            aborted: request.signal.aborted,
          })),
        ).toEqual([
          ...(rung === "fallback" ? [{ model: requestParams.model, aborted: false }] : []),
          {
            model: rung === "primary" ? requestParams.model : requestParams.fallbackModel,
            aborted: true,
          },
        ])
        late.resolve(acceptedResult)
        await vi.advanceTimersByTimeAsync(1000)
        expect(error.attempts).toEqual(expectedAttempts)
        expect(stub.generationCalls).toEqual([])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it("expires during retry sleep without losing billed usage or starting another attempt", async () => {
    vi.useFakeTimers()
    try {
      const stub = makeClientStubs({ modelResults: [{ value: invalidJsonResult }] })
      const deadline = performance.now() + 100
      const logger = createTestLogger()
      const client = createOpenRouterClient({
        agent: stub.agent,
        costLookupClient: stub.costLookupClient,
        requestTimeoutMs: 45_000,
        remainingReviewMs: () => deadline - performance.now(),
      })
      const rejection = captureRejection(client.requestReview(requestParams, logger))
      await vi.advanceTimersByTimeAsync(100)
      const error = await rejection
      expect(error).toBeInstanceOf(ReviewRequestError)
      if (!(error instanceof ReviewRequestError)) throw error
      expect({
        message: error.message,
        deadlineExceeded: error.deadlineExceeded,
        attempts: error.attempts,
      }).toEqual({
        message: "review deadline exceeded",
        deadlineExceeded: true,
        attempts: [
          {
            model: requestParams.model,
            outcome: "invalid_json",
            ...ACCEPTED_USAGE,
            errorSummary: "response content is not valid JSON",
          },
        ],
      })
      expect(stub.modelCalls.map(({ request }) => request.model)).toEqual([requestParams.model])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("skips cost lookup when an accepted response exhausts the remaining review time", async () => {
    const remainingReviewMs = vi.fn(() => 100)
    const stub = makeClientStubs({
      modelResults: [
        {
          pending: async () => {
            remainingReviewMs.mockReturnValue(0)
            return makeNoCostResult()
          },
        },
      ],
    })
    const logger = createTestLogger()
    const client = createOpenRouterClient({
      agent: stub.agent,
      costLookupClient: stub.costLookupClient,
      requestTimeoutMs: 45_000,
      remainingReviewMs,
    })
    expect(await client.requestReview(requestParams, logger)).toEqual({
      review: acceptedReview,
      modelUsed: requestParams.model,
      attempts: [
        {
          model: requestParams.model,
          outcome: "accepted",
          promptTokens: 54,
          completionTokens: 102,
          costUsd: null,
          errorSummary: null,
        },
      ],
    })
    expect(stub.modelCalls.map(({ request }) => request.model)).toEqual([requestParams.model])
    expect(stub.generationCalls).toEqual([])
    expect(logsWithMessage(logger, "generation cost lookup skipped")).toEqual([
      {
        level: "debug",
        message: "generation cost lookup skipped",
        data: {
          operation: "generation cost lookup",
          generationId: ACCEPTED_GENERATION_ID,
          reason: "review deadline exceeded",
        },
      },
    ])
  })

  it("retains an accepted review when cost lookup reaches the review deadline and ignores its late response", async () => {
    vi.useFakeTimers()
    try {
      const late = Promise.withResolvers<unknown>()
      const stub = makeClientStubs({
        modelResults: [{ value: makeNoCostResult() }],
        generationResponses: [{ pending: () => late.promise }],
      })
      const deadline = performance.now() + 100
      const logger = createTestLogger()
      const client = createOpenRouterClient({
        agent: stub.agent,
        costLookupClient: stub.costLookupClient,
        requestTimeoutMs: 45_000,
        remainingReviewMs: () => deadline - performance.now(),
      })
      const request = client.requestReview(requestParams, logger)
      await vi.advanceTimersByTimeAsync(100)
      const result = await request
      const expected = {
        review: acceptedReview,
        modelUsed: requestParams.model,
        attempts: [
          {
            model: requestParams.model,
            outcome: "accepted",
            promptTokens: 54,
            completionTokens: 102,
            costUsd: null,
            errorSummary: null,
          },
        ],
      }
      expect(result).toEqual(expected)
      expect(
        stub.generationCalls.map(({ id, options }) => ({
          id,
          aborted: options?.signal?.aborted,
        })),
      ).toEqual([{ id: ACCEPTED_GENERATION_ID, aborted: true }])
      late.resolve({ data: { totalCost: 42 } })
      await vi.advanceTimersByTimeAsync(1000)
      expect(result).toEqual(expected)
      expect(stub.modelCalls.map(({ request }) => request.model)).toEqual([requestParams.model])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("sends one Responses request with the prompts, the full output ceiling, the strict review schema and an abort signal", async () => {
    const stub = makeClientStubs({ modelResults: [{ value: acceptedResult }] })
    const { client, logger } = makeClient(stub)

    await client.requestReview(requestParams, logger)

    expect(stub.modelCalls).toEqual([
      {
        request: {
          model: "z-ai/glm-5.3-flash",
          instructions: "system prompt",
          input: "user prompt",
          maxOutputTokens: 128_000,
          text: {
            format: {
              type: "json_schema",
              name: "review_response",
              strict: true,
              schema: reviewResponseJsonSchema,
            },
          },
          signal: expect.any(AbortSignal),
        },
        options: { retries: { strategy: "none" } },
      },
    ])
  })

  it("returns the parsed review and a single accepted attempt on first success", async () => {
    const stub = makeClientStubs({ modelResults: [{ value: acceptedResult }] })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result).toEqual({
      review: acceptedReview,
      modelUsed: "z-ai/glm-5.3-flash",
      attempts: [
        {
          model: "z-ai/glm-5.3-flash",
          outcome: "accepted",
          promptTokens: 54,
          completionTokens: 102,
          costUsd: 0.000021036,
          errorSummary: null,
        },
      ],
    })
  })

  it("reports the response's routed model as modelUsed when it differs from the requested model", async () => {
    const stub = makeClientStubs({ modelResults: [{ value: acceptedResult }] })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(
      { ...requestParams, model: "openrouter/auto", fallbackModel: null },
      logger,
    )

    expect(result).toEqual({
      review: acceptedReview,
      modelUsed: "z-ai/glm-5.3-flash",
      attempts: [
        {
          model: "openrouter/auto",
          outcome: "accepted",
          ...ACCEPTED_USAGE,
          errorSummary: null,
        },
      ],
    })
    expect(logsWithMessage(logger, "review response accepted")).toEqual([
      {
        level: "info",
        message: "review response accepted",
        data: {
          model: "openrouter/auto",
          routedModel: "z-ai/glm-5.3-flash",
          generationId: ACCEPTED_GENERATION_ID,
          totalAttemptCount: 1,
        },
      },
    ])
  })

  it("retries the same model once on invalid JSON, recording both attempts", async () => {
    const stub = makeClientStubs({
      modelResults: [{ value: invalidJsonResult }, { value: acceptedResult }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(stub.modelCalls.map((modelCall) => modelCall.request.model)).toEqual([
      "z-ai/glm-5.3-flash",
      "z-ai/glm-5.3-flash",
    ])
    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "invalid_json",
        promptTokens: 54,
        completionTokens: 102,
        costUsd: 0.000021036,
        errorSummary: "response content is not valid JSON",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        promptTokens: 54,
        completionTokens: 102,
        costUsd: 0.000021036,
        errorSummary: null,
      },
    ])
  })

  it("records empty_content and retries the same model once when the SDK extracts no text", async () => {
    const stub = makeClientStubs({
      modelResults: [{ value: makeReasoningOnlyResult() }, { value: acceptedResult }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "empty_content",
        ...ACCEPTED_USAGE,
        errorSummary: "response had no text content",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        promptTokens: 54,
        completionTokens: 102,
        costUsd: 0.000021036,
        errorSummary: null,
      },
    ])
  })

  it("advances to the fallback model after two schema mismatches", async () => {
    const stub = makeClientStubs({
      modelResults: [
        { value: schemaMismatchResult },
        { value: schemaMismatchResult },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(stub.modelCalls.map((modelCall) => modelCall.request.model)).toEqual([
      "z-ai/glm-5.3-flash",
      "z-ai/glm-5.3-flash",
      "deepseek/deepseek-v4.1-flash",
    ])

    const schemaMismatchAttempt = {
      model: "z-ai/glm-5.3-flash",
      outcome: "schema_mismatch",
      promptTokens: 54,
      completionTokens: 102,
      costUsd: 0.000021036,
      errorSummary:
        "schema mismatch at analysis: Invalid input: expected string, received undefined",
    }
    expect(result.attempts).toEqual([
      schemaMismatchAttempt,
      schemaMismatchAttempt,
      {
        model: "deepseek/deepseek-v4.1-flash",
        outcome: "accepted",
        promptTokens: 54,
        completionTokens: 102,
        costUsd: 0.000021036,
        errorSummary: null,
      },
    ])
  })

  it.each([408, 429])("retries the same model once on a %i", async (statusCode) => {
    const stub = makeClientStubs({
      modelResults: [{ error: makeStatusError(statusCode) }, { value: acceptedResult }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(stub.modelCalls.map((modelCall) => modelCall.request.model)).toEqual([
      "z-ai/glm-5.3-flash",
      "z-ai/glm-5.3-flash",
    ])
    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "api_error",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        errorSummary: `HTTP ${statusCode}: HTTP ${statusCode}`,
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        errorSummary: null,
      },
    ])
  })

  it("retries the same model once when the SDK rejects a non-streamed 200 body", async () => {
    const stub = makeClientStubs({
      modelResults: [{ error: makeResponseValidationError() }, { value: acceptedResult }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(stub.modelCalls.map((modelCall) => modelCall.request.model)).toEqual([
      "z-ai/glm-5.3-flash",
      "z-ai/glm-5.3-flash",
    ])
    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "api_error",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        errorSummary: "HTTP 200: Response validation failed",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        errorSummary: null,
      },
    ])
  })

  it("retries a status-less network error and records its bare message", async () => {
    const stub = makeClientStubs({
      modelResults: [{ error: new Error("socket hang up") }, { value: acceptedResult }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(stub.modelCalls.map((modelCall) => modelCall.request.model)).toEqual([
      "z-ai/glm-5.3-flash",
      "z-ai/glm-5.3-flash",
    ])
    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "api_error",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        errorSummary: "socket hang up",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        errorSummary: null,
      },
    ])
  })

  it("retries an SDK-thrown TimeoutError as an api_error through the action's ladder, not the SDK's", async () => {
    const timeoutError = new Error("Request timed out")
    timeoutError.name = "TimeoutError"
    const stub = makeClientStubs({
      modelResults: [{ error: timeoutError }, { value: acceptedResult }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    const actionLadderCall = {
      model: "z-ai/glm-5.3-flash",
      signal: expect.any(AbortSignal),
      options: { retries: { strategy: "none" } },
    }
    expect(
      stub.modelCalls.map(({ request, options }) => ({
        model: request.model,
        signal: request.signal,
        options,
      })),
    ).toEqual([actionLadderCall, actionLadderCall])
    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "api_error",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        errorSummary: "Request timed out",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        errorSummary: null,
      },
    ])
    expect(logsWithMessage(logger, "review attempt failed")).toEqual([
      {
        level: "warn",
        message: "review attempt failed",
        data: {
          model: "z-ai/glm-5.3-flash",
          modelAttemptNumber: 1,
          outcome: "api_error",
          errorSummary: "Request timed out",
        },
      },
    ])
  })

  it("passes a live (non-aborted) AbortSignal to the SDK call", async () => {
    const stub = makeClientStubs({
      modelResults: [{ value: acceptedResult }],
      generationResponses: [{ value: { data: { totalCost: 0.01 } } }],
    })
    const { client, logger } = makeClient(stub)

    await client.requestReview(requestParams, logger)

    const signal = stub.modelCalls[0]?.request.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
  })

  it("aborts the signal at the deadline and records the orphan settling with an AbortError when the SDK honours it", async () => {
    vi.useFakeTimers()
    try {
      // Shaped like the SDK's rejection: its own error wrapping the
      // DOMException the aborted fetch raised
      const rejectOnAbort = (request: { signal: AbortSignal }): Promise<ModelCallResult> => {
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(
              Object.assign(new Error("Request aborted by client"), {
                name: "RequestAbortedError",
                cause: new DOMException("This operation was aborted", "AbortError"),
              }),
            )
          })
        })
      }
      const stub = makeClientStubs({
        modelResults: [{ pending: rejectOnAbort }, { pending: rejectOnAbort }],
      })
      const logger = createTestLogger()
      const client = createOpenRouterClient({
        agent: stub.agent,
        costLookupClient: stub.costLookupClient,
        remainingReviewMs: () => Infinity,
        requestTimeoutMs: 45_000,
        retryDelayMs: 0,
      })

      // Attach the rejection handler BEFORE advancing timers so the
      // second attempt's async abort rejection is caught immediately.
      const reviewPromise = client.requestReview(
        {
          ...requestParams,
          fallbackModel: null,
        },
        logger,
      )
      void reviewPromise.catch(() => undefined)

      // Two attempts × 45s each — advance past both deadlines
      await vi.advanceTimersByTimeAsync(90_000)

      await expect(reviewPromise).rejects.toThrow(
        new ReviewRequestError({
          message:
            "review request failed after 2 attempt(s): z-ai/glm-5.3-flash: timeout (no response within 45s); z-ai/glm-5.3-flash: timeout (no response within 45s)",
          attempts: [
            {
              model: "z-ai/glm-5.3-flash",
              outcome: "timeout",
              promptTokens: null,
              completionTokens: null,
              costUsd: null,
              errorSummary: "no response within 45s",
            },
            {
              model: "z-ai/glm-5.3-flash",
              outcome: "timeout",
              promptTokens: null,
              completionTokens: null,
              costUsd: null,
              errorSummary: "no response within 45s",
            },
          ],
          keyRejected: false,
        }),
      )
      expect(stub.modelCalls[0]?.request.signal.aborted).toBe(true)

      // One orphan settlement per timed-out attempt
      const abortedSettlement = {
        level: "warn",
        message: "deadline-elapsed request settled",
        data: {
          operation: "review request",
          model: "z-ai/glm-5.3-flash",
          elapsedMs: 45_000,
          timeoutMs: 45_000,
          settledWith: "abort_error",
          error: "Request aborted by client",
        },
      }
      expect(logsWithMessage(logger, "deadline-elapsed request settled")).toEqual([
        abortedSettlement,
        abortedSettlement,
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("advances to the fallback model at the deadline even when the SDK ignores the abort signal", async () => {
    vi.useFakeTimers()
    try {
      const stub = makeClientStubs({
        modelResults: [{ pending: () => new Promise(() => undefined) }, { value: acceptedResult }],
      })
      const logger = createTestLogger()
      const client = createOpenRouterClient({
        agent: stub.agent,
        costLookupClient: stub.costLookupClient,
        remainingReviewMs: () => Infinity,
        requestTimeoutMs: 45_000,
        retryDelayMs: 0,
      })

      const reviewPromise = client.requestReview(requestParams, logger)
      await vi.advanceTimersByTimeAsync(45_000)
      const result = await reviewPromise

      expect(stub.modelCalls.map((modelCall) => modelCall.request.model)).toEqual([
        "z-ai/glm-5.3-flash",
        "deepseek/deepseek-v4.1-flash",
      ])
      expect(result.attempts).toEqual([
        {
          model: "z-ai/glm-5.3-flash",
          outcome: "timeout",
          promptTokens: null,
          completionTokens: null,
          costUsd: null,
          errorSummary: "no response within 45s",
        },
        {
          model: "deepseek/deepseek-v4.1-flash",
          outcome: "accepted",
          promptTokens: 54,
          completionTokens: 102,
          costUsd: 0.000021036,
          errorSummary: null,
        },
      ])
      expect(
        logsWithMessage(logger, "advancing to fallback model without same-model retry"),
      ).toEqual([
        {
          level: "info",
          message: "advancing to fallback model without same-model retry",
          data: {
            from: "z-ai/glm-5.3-flash",
            to: "deepseek/deepseek-v4.1-flash",
          },
        },
      ])
      expect(logsWithMessage(logger, "request deadline elapsed")).toEqual([
        {
          level: "warn",
          message: "request deadline elapsed",
          data: {
            operation: "review request",
            model: "z-ai/glm-5.3-flash",
            timeoutMs: 45_000,
          },
        },
      ])
      expect(logsWithMessage(logger, "review attempt failed")).toEqual([
        {
          level: "warn",
          message: "review attempt failed",
          data: {
            model: "z-ai/glm-5.3-flash",
            modelAttemptNumber: 1,
            outcome: "timeout",
            errorSummary: "no response within 45s",
          },
        },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("logs a late response when the orphaned request completes after the deadline", async () => {
    vi.useFakeTimers()
    try {
      const resolveLate = (): Promise<ModelCallResult> => {
        return new Promise((resolve) => {
          setTimeout(() => resolve(acceptedResult), 120_000)
        })
      }
      const stub = makeClientStubs({
        modelResults: [{ pending: resolveLate }, { value: acceptedResult }],
      })
      const logger = createTestLogger()
      const client = createOpenRouterClient({
        agent: stub.agent,
        costLookupClient: stub.costLookupClient,
        remainingReviewMs: () => Infinity,
        requestTimeoutMs: 45_000,
        retryDelayMs: 0,
      })

      const reviewPromise = client.requestReview(requestParams, logger)
      await vi.advanceTimersByTimeAsync(45_000)
      const result = await reviewPromise
      expect(result.attempts.map((attempt) => [attempt.model, attempt.outcome])).toEqual([
        ["z-ai/glm-5.3-flash", "timeout"],
        ["deepseek/deepseek-v4.1-flash", "accepted"],
      ])

      await vi.advanceTimersByTimeAsync(75_000)

      expect(logsWithMessage(logger, "deadline-elapsed request settled")).toEqual([
        {
          level: "warn",
          message: "deadline-elapsed request settled",
          data: {
            operation: "review request",
            model: "z-ai/glm-5.3-flash",
            elapsedMs: 120_000,
            timeoutMs: 45_000,
            settledWith: "response",
          },
        },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("tags a late settlement with the caller's logger context after the request has rejected", async () => {
    vi.useFakeTimers()
    try {
      const resolveLate = (): Promise<ModelCallResult> => {
        return new Promise((resolve) => {
          setTimeout(() => resolve(acceptedResult), 120_000)
        })
      }
      const stub = makeClientStubs({
        modelResults: [{ pending: resolveLate }, { error: makeStatusError(400) }],
      })
      const logger = createTestLogger()
      const client = createOpenRouterClient({
        agent: stub.agent,
        costLookupClient: stub.costLookupClient,
        remainingReviewMs: () => Infinity,
        requestTimeoutMs: 45_000,
        retryDelayMs: 0,
      })

      const rejection = captureRejection(
        client.requestReview(
          { ...requestParams, fallbackModel: null },
          logger.child({ phase: "subtle-bugs" }),
        ),
      )
      await vi.advanceTimersByTimeAsync(45_000)
      const error = await rejection

      if (!(error instanceof ReviewRequestError)) throw error
      expect(error.message).toBe(
        "review request failed after 2 attempt(s): z-ai/glm-5.3-flash: timeout (no response within 45s); z-ai/glm-5.3-flash: api_error (HTTP 400: HTTP 400)",
      )
      expect(logsWithMessage(logger, "deadline-elapsed request settled")).toEqual([])

      await vi.advanceTimersByTimeAsync(75_000)

      expect(logsWithMessage(logger, "deadline-elapsed request settled")).toEqual([
        {
          level: "warn",
          message: "deadline-elapsed request settled",
          data: {
            phase: "subtle-bugs",
            operation: "review request",
            model: "z-ai/glm-5.3-flash",
            elapsedMs: 120_000,
            timeoutMs: 45_000,
            settledWith: "response",
          },
        },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("logs a late non-abort rejection without raising an unhandled rejection", async () => {
    vi.useFakeTimers()
    try {
      const rejectLate = (): Promise<ModelCallResult> => {
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("socket hang up")), 120_000)
        })
      }
      const stub = makeClientStubs({
        modelResults: [{ pending: rejectLate }, { value: acceptedResult }],
      })
      const logger = createTestLogger()
      const client = createOpenRouterClient({
        agent: stub.agent,
        costLookupClient: stub.costLookupClient,
        remainingReviewMs: () => Infinity,
        requestTimeoutMs: 45_000,
        retryDelayMs: 0,
      })

      const reviewPromise = client.requestReview(requestParams, logger)
      await vi.advanceTimersByTimeAsync(45_000)
      const result = await reviewPromise
      expect(result.attempts.map((attempt) => [attempt.model, attempt.outcome])).toEqual([
        ["z-ai/glm-5.3-flash", "timeout"],
        ["deepseek/deepseek-v4.1-flash", "accepted"],
      ])
      await vi.advanceTimersByTimeAsync(75_000)

      expect(logsWithMessage(logger, "deadline-elapsed request settled")).toEqual([
        {
          level: "warn",
          message: "deadline-elapsed request settled",
          data: {
            operation: "review request",
            model: "z-ai/glm-5.3-flash",
            elapsedMs: 120_000,
            timeoutMs: 45_000,
            settledWith: "error",
            error: "socket hang up",
          },
        },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("retries a timeout on the same model when no fallback is configured", async () => {
    vi.useFakeTimers()
    try {
      const stub = makeClientStubs({
        modelResults: [{ pending: () => new Promise(() => undefined) }, { value: acceptedResult }],
      })
      const logger = createTestLogger()
      const client = createOpenRouterClient({
        agent: stub.agent,
        costLookupClient: stub.costLookupClient,
        remainingReviewMs: () => Infinity,
        requestTimeoutMs: 45_000,
        retryDelayMs: 0,
      })

      const reviewPromise = client.requestReview(
        {
          ...requestParams,
          fallbackModel: null,
        },
        logger,
      )
      await vi.advanceTimersByTimeAsync(45_000)
      const result = await reviewPromise

      expect(result.attempts).toEqual([
        {
          model: "z-ai/glm-5.3-flash",
          outcome: "timeout",
          promptTokens: null,
          completionTokens: null,
          costUsd: null,
          errorSummary: "no response within 45s",
        },
        {
          model: "z-ai/glm-5.3-flash",
          outcome: "accepted",
          promptTokens: 54,
          completionTokens: 102,
          costUsd: 0.000021036,
          errorSummary: null,
        },
      ])
      expect(
        logsWithMessage(logger, "advancing to fallback model without same-model retry"),
      ).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("exhausts the ladder in order when the fallback also times out, retrying only the last rung", async () => {
    vi.useFakeTimers()
    try {
      const neverSettle = (): Promise<ModelCallResult> => new Promise(() => undefined)
      const stub = makeClientStubs({
        modelResults: [
          { pending: neverSettle },
          { pending: neverSettle },
          { pending: neverSettle },
        ],
      })
      const logger = createTestLogger()
      const client = createOpenRouterClient({
        agent: stub.agent,
        costLookupClient: stub.costLookupClient,
        remainingReviewMs: () => Infinity,
        requestTimeoutMs: 45_000,
        retryDelayMs: 0,
      })

      const reviewPromise = client.requestReview(requestParams, logger)
      void reviewPromise.catch(() => undefined)
      // One primary deadline, then two fallback deadlines (last-rung retry)
      await vi.advanceTimersByTimeAsync(135_000)

      await expect(reviewPromise).rejects.toThrow(
        new ReviewRequestError({
          message:
            "review request failed after 3 attempt(s): z-ai/glm-5.3-flash: timeout (no response within 45s); deepseek/deepseek-v4.1-flash: timeout (no response within 45s); deepseek/deepseek-v4.1-flash: timeout (no response within 45s)",
          attempts: [
            {
              model: "z-ai/glm-5.3-flash",
              outcome: "timeout",
              promptTokens: null,
              completionTokens: null,
              costUsd: null,
              errorSummary: "no response within 45s",
            },
            {
              model: "deepseek/deepseek-v4.1-flash",
              outcome: "timeout",
              promptTokens: null,
              completionTokens: null,
              costUsd: null,
              errorSummary: "no response within 45s",
            },
            {
              model: "deepseek/deepseek-v4.1-flash",
              outcome: "timeout",
              promptTokens: null,
              completionTokens: null,
              costUsd: null,
              errorSummary: "no response within 45s",
            },
          ],
          keyRejected: false,
        }),
      )
      expect(stub.modelCalls.map((modelCall) => modelCall.request.model)).toEqual([
        "z-ai/glm-5.3-flash",
        "deepseek/deepseek-v4.1-flash",
        "deepseek/deepseek-v4.1-flash",
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not sleep the retry delay when a timeout advances the ladder", async () => {
    vi.useFakeTimers()
    try {
      const retryDelayMs = 50
      const stub = makeClientStubs({
        modelResults: [{ pending: () => new Promise(() => undefined) }, { value: acceptedResult }],
      })
      const logger = createTestLogger()
      const client = createOpenRouterClient({
        agent: stub.agent,
        costLookupClient: stub.costLookupClient,
        remainingReviewMs: () => Infinity,
        requestTimeoutMs: 45_000,
        retryDelayMs,
      })

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
      try {
        const reviewPromise = client.requestReview(requestParams, logger)
        await vi.advanceTimersByTimeAsync(45_000)
        await reviewPromise

        const retrySleepCalls = setTimeoutSpy.mock.calls.filter((call) => call[1] === retryDelayMs)
        expect(retrySleepCalls).toHaveLength(0)
      } finally {
        setTimeoutSpy.mockRestore()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports the review deadline as the cost lookup's failure when that deadline cuts the lookup short", async () => {
    vi.useFakeTimers()
    try {
      const stub = makeClientStubs({
        modelResults: [{ value: makeNoCostResult() }],
        generationResponses: [{ pending: () => new Promise(() => undefined) }],
      })
      const logger = createTestLogger()
      const deadline = performance.now() + 100
      const client = createOpenRouterClient({
        agent: stub.agent,
        costLookupClient: stub.costLookupClient,
        requestTimeoutMs: 45_000,
        remainingReviewMs: () => deadline - performance.now(),
      })

      const reviewPromise = client.requestReview(requestParams, logger)
      await vi.advanceTimersByTimeAsync(100)
      await reviewPromise

      expect(logger.messages.filter((entry) => entry.level === "warn")).toEqual([
        {
          level: "warn",
          message: "request deadline elapsed",
          data: {
            operation: "generation cost lookup",
            generationId: ACCEPTED_GENERATION_ID,
            timeoutMs: 100,
          },
        },
        {
          level: "warn",
          message: "generation cost lookup failed",
          data: {
            operation: "generation cost lookup",
            generationId: ACCEPTED_GENERATION_ID,
            error: "review deadline exceeded",
          },
        },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("degrades to a null cost with both warnings when the generation lookup exceeds the deadline", async () => {
    vi.useFakeTimers()
    try {
      const stub = makeClientStubs({
        modelResults: [{ value: makeNoCostResult() }],
        generationResponses: [{ pending: () => new Promise(() => undefined) }],
      })
      const logger = createTestLogger()
      const client = createOpenRouterClient({
        agent: stub.agent,
        costLookupClient: stub.costLookupClient,
        remainingReviewMs: () => Infinity,
        requestTimeoutMs: 45_000,
        retryDelayMs: 0,
      })

      const reviewPromise = client.requestReview(requestParams, logger)
      await vi.advanceTimersByTimeAsync(45_000)
      const result = await reviewPromise

      expect(result.attempts).toEqual([
        {
          model: requestParams.model,
          outcome: "accepted",
          ...ACCEPTED_USAGE,
          costUsd: null,
          errorSummary: null,
        },
      ])
      expect(logsWithMessage(logger, "request deadline elapsed")).toEqual([
        {
          level: "warn",
          message: "request deadline elapsed",
          data: {
            operation: "generation cost lookup",
            generationId: ACCEPTED_GENERATION_ID,
            timeoutMs: 45_000,
          },
        },
      ])
      expect(logsWithMessage(logger, "generation cost lookup failed")).toEqual([
        {
          level: "warn",
          message: "generation cost lookup failed",
          data: {
            operation: "generation cost lookup",
            generationId: ACCEPTED_GENERATION_ID,
            error: "no response within 45s",
          },
        },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears the review attempt timeout timer after a successful response", async () => {
    vi.useFakeTimers()
    try {
      const stub = makeClientStubs({
        modelResults: [{ value: acceptedResult }],
      })
      const { client, logger } = makeClient(stub)

      await client.requestReview(requestParams, logger)

      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not sleep after the final attempt when retries are exhausted", async () => {
    const retryDelayMs = 50
    const stub = makeClientStubs({
      modelResults: [{ error: makeStatusError(429) }, { error: makeStatusError(429) }],
    })
    const logger = createTestLogger()
    const client = createOpenRouterClient({
      agent: stub.agent,
      costLookupClient: stub.costLookupClient,
      remainingReviewMs: () => Infinity,
      requestTimeoutMs: 45_000,
      retryDelayMs,
    })

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
    try {
      await expect(
        client.requestReview({ ...requestParams, fallbackModel: null }, logger),
      ).rejects.toThrow(
        new ReviewRequestError({
          message:
            "review request failed after 2 attempt(s): z-ai/glm-5.3-flash: api_error (HTTP 429: HTTP 429); z-ai/glm-5.3-flash: api_error (HTTP 429: HTTP 429)",
          attempts: [
            {
              model: "z-ai/glm-5.3-flash",
              outcome: "api_error",
              promptTokens: null,
              completionTokens: null,
              costUsd: null,
              errorSummary: "HTTP 429: HTTP 429",
            },
            {
              model: "z-ai/glm-5.3-flash",
              outcome: "api_error",
              promptTokens: null,
              completionTokens: null,
              costUsd: null,
              errorSummary: "HTTP 429: HTTP 429",
            },
          ],
          keyRejected: false,
        }),
      )

      // retryDelayMs sleeps happen between retryable failures; the guard
      // `modelAttemptNumber <= MAX_ATTEMPTS_PER_MODEL` prevents an extra sleep
      // after the final attempt. Only one sleep (between attempts 1 and 2).
      const retrySleepCalls = setTimeoutSpy.mock.calls.filter((call) => call[1] === retryDelayMs)
      expect(retrySleepCalls).toHaveLength(1)
      expect(stub.modelCalls).toHaveLength(2)
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  it("truncates an error message longer than 200 characters in the attempt summary", async () => {
    const stub = makeClientStubs({
      modelResults: [{ error: makeStatusError(429, "x".repeat(250)) }, { value: acceptedResult }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "api_error",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        errorSummary: `HTTP 429: ${"x".repeat(200)}…`,
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        errorSummary: null,
      },
    ])
  })

  it("advances to the fallback model without a retry on a 404", async () => {
    const stub = makeClientStubs({
      modelResults: [{ error: makeStatusError(404) }, { value: acceptedResult }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(stub.modelCalls.map((modelCall) => modelCall.request.model)).toEqual([
      "z-ai/glm-5.3-flash",
      "deepseek/deepseek-v4.1-flash",
    ])
    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "api_error",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        errorSummary: "HTTP 404: HTTP 404",
      },
      {
        model: "deepseek/deepseek-v4.1-flash",
        outcome: "accepted",
        promptTokens: 54,
        completionTokens: 102,
        costUsd: 0.000021036,
        errorSummary: null,
      },
    ])
  })

  it("retries the same model with an output ceiling that fits after a context-overflow 400", async () => {
    const stub = makeClientStubs({
      modelResults: [
        { error: makeContextOverflowError({ contextLength: 262_144, inputTokens: 135_762 }) },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    // 262,144 window − 135,762 input − 8,192 margin
    expect(sentCeilings(stub)).toEqual([
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 128_000 },
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 118_190 },
    ])
    expect(result).toEqual({
      review: acceptedReview,
      modelUsed: "z-ai/glm-5.3-flash",
      attempts: [
        {
          model: "z-ai/glm-5.3-flash",
          outcome: "api_error",
          promptTokens: null,
          completionTokens: null,
          costUsd: null,
          errorSummary:
            "HTTP 400: This endpoint's maximum context length is 262144 tokens. However, you requested about 263762 tokens (135762 of text input, 128000 in the output). Please reduce the length of either one, or use the con…",
        },
        {
          model: "z-ai/glm-5.3-flash",
          outcome: "accepted",
          promptTokens: 54,
          completionTokens: 102,
          costUsd: 0.000021036,
          errorSummary: null,
        },
      ],
    })
    expect(logsWithMessage(logger, CEILING_RETRY_LOG)).toEqual([
      {
        level: "info",
        message: CEILING_RETRY_LOG,
        data: { model: "z-ai/glm-5.3-flash", maxOutputTokens: 118_190 },
      },
    ])
  })

  it("starts the fallback model at the full output ceiling after the primary lowered it", async () => {
    const stub = makeClientStubs({
      modelResults: [
        { error: makeContextOverflowError({ contextLength: 262_144, inputTokens: 135_762 }) },
        { error: makeStatusError(500) },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    await client.requestReview(requestParams, logger)

    expect(sentCeilings(stub)).toEqual([
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 128_000 },
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 118_190 },
      { model: "deepseek/deepseek-v4.1-flash", maxOutputTokens: 128_000 },
    ])
  })

  it("advances to the fallback without a retry when a context-overflow 400 leaves no room for output", async () => {
    const stub = makeClientStubs({
      modelResults: [
        { error: makeContextOverflowError({ contextLength: 262_144, inputTokens: 258_000 }) },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    await client.requestReview(requestParams, logger)

    expect(sentCeilings(stub)).toEqual([
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 128_000 },
      { model: "deepseek/deepseek-v4.1-flash", maxOutputTokens: 128_000 },
    ])
  })

  it("advances to the fallback without a retry when the fitted output ceiling is too small for a review", async () => {
    // 262,144 window − 240,000 input − 8,192 margin = 13,952, under the 32,768 floor
    const stub = makeClientStubs({
      modelResults: [
        { error: makeContextOverflowError({ contextLength: 262_144, inputTokens: 240_000 }) },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    await client.requestReview(requestParams, logger)

    expect(sentCeilings(stub)).toEqual([
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 128_000 },
      { model: "deepseek/deepseek-v4.1-flash", maxOutputTokens: 128_000 },
    ])
  })

  it("retries at a fitted output ceiling exactly at the 32,768-token floor", async () => {
    // 262,144 window − 221,184 input − 8,192 margin = 32,768, the floor itself
    const stub = makeClientStubs({
      modelResults: [
        { error: makeContextOverflowError({ contextLength: 262_144, inputTokens: 221_184 }) },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    await client.requestReview(requestParams, logger)

    expect(sentCeilings(stub)).toEqual([
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 128_000 },
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 32_768 },
    ])
  })

  it("advances to the fallback without a retry when the rejected ceiling already fit the endpoint's window", async () => {
    // 262,144 window − 125,952 input − 8,192 margin = 128,000, the rejected
    // ceiling itself, so lowering it cannot fix the 400
    const stub = makeClientStubs({
      modelResults: [
        { error: makeContextOverflowError({ contextLength: 262_144, inputTokens: 125_952 }) },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    await client.requestReview(requestParams, logger)

    expect(sentCeilings(stub)).toEqual([
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 128_000 },
      { model: "deepseek/deepseek-v4.1-flash", maxOutputTokens: 128_000 },
    ])
    expect(logsWithMessage(logger, CEILING_RETRY_LOG)).toEqual([])
  })

  it("does not lower the ceiling when the context-overflow 400 was the model's last attempt", async () => {
    const stub = makeClientStubs({
      modelResults: [
        { error: makeStatusError(500) },
        { error: makeContextOverflowError({ contextLength: 262_144, inputTokens: 135_762 }) },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    await client.requestReview(requestParams, logger)

    expect(sentCeilings(stub)).toEqual([
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 128_000 },
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 128_000 },
      { model: "deepseek/deepseek-v4.1-flash", maxOutputTokens: 128_000 },
    ])
    expect(logsWithMessage(logger, CEILING_RETRY_LOG)).toEqual([])
  })

  it("keeps the full ceiling when a non-400 error carries context-overflow wording", async () => {
    const overflowWordedGatewayError = makeStatusError(
      502,
      makeContextOverflowError({ contextLength: 262_144, inputTokens: 135_762 }).message,
    )
    const stub = makeClientStubs({
      modelResults: [{ error: overflowWordedGatewayError }, { value: acceptedResult }],
    })
    const { client, logger } = makeClient(stub)

    await client.requestReview(requestParams, logger)

    expect(sentCeilings(stub)).toEqual([
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 128_000 },
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 128_000 },
    ])
  })

  it("advances to the fallback without a retry on a 400 that is not a context overflow", async () => {
    const stub = makeClientStubs({
      modelResults: [{ error: makeStatusError(400) }, { value: acceptedResult }],
    })
    const { client, logger } = makeClient(stub)

    await client.requestReview(requestParams, logger)

    expect(sentCeilings(stub)).toEqual([
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 128_000 },
      { model: "deepseek/deepseek-v4.1-flash", maxOutputTokens: 128_000 },
    ])
  })

  it("advances to the fallback on the captured overflow body, whose 8K window leaves no room for a retry", async () => {
    const stub = makeClientStubs({
      modelResults: [{ error: makeBadRequestError(overflowErrorBody) }, { value: acceptedResult }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(sentCeilings(stub)).toEqual([
      { model: "z-ai/glm-5.3-flash", maxOutputTokens: 128_000 },
      { model: "deepseek/deepseek-v4.1-flash", maxOutputTokens: 128_000 },
    ])
    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "api_error",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        errorSummary:
          "HTTP 400: This endpoint's maximum context length is 8192 tokens. However, you requested about 11593 tokens (4593 of text input, 7000 in the output). Please reduce the length of either one, or use the context-co…",
      },
      {
        model: "deepseek/deepseek-v4.1-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        errorSummary: null,
      },
    ])
  })

  it("aborts the ladder after exactly one call on the captured bad-key body", async () => {
    const badKeyError = new UnauthorizedResponseError(
      errorBodySchema.parse(badKeyErrorBody),
      makeHttpMeta(401, JSON.stringify(badKeyErrorBody)),
    )
    const stub = makeClientStubs({ modelResults: [{ error: badKeyError }] })
    const { client, logger } = makeClient(stub)

    await expect(client.requestReview(requestParams, logger)).rejects.toThrow(
      new ReviewRequestError({
        message:
          "OpenRouter auth/credit error — aborting without fallback: z-ai/glm-5.3-flash: api_error (HTTP 401: User not found.)",
        attempts: [
          {
            model: "z-ai/glm-5.3-flash",
            outcome: "api_error",
            promptTokens: null,
            completionTokens: null,
            costUsd: null,
            errorSummary: "HTTP 401: User not found.",
          },
        ],
        keyRejected: true,
      }),
    )
    expect(stub.modelCalls).toHaveLength(1)
  })

  it.each([401, 402, 403])(
    "aborts the ladder after exactly one call on a %d",
    async (statusCode) => {
      const stub = makeClientStubs({
        modelResults: [{ error: makeStatusError(statusCode) }],
      })
      const { client, logger } = makeClient(stub)

      await expect(client.requestReview(requestParams, logger)).rejects.toThrow(
        new ReviewRequestError({
          message: `OpenRouter auth/credit error — aborting without fallback: z-ai/glm-5.3-flash: api_error (HTTP ${statusCode}: HTTP ${statusCode})`,
          attempts: [
            {
              model: "z-ai/glm-5.3-flash",
              outcome: "api_error",
              promptTokens: null,
              completionTokens: null,
              costUsd: null,
              errorSummary: `HTTP ${statusCode}: HTTP ${statusCode}`,
            },
          ],
          keyRejected: true,
        }),
      )
      expect(stub.modelCalls).toHaveLength(1)
    },
  )

  it("throws a per-attempt summary after exhausting a fallback-less ladder", async () => {
    const stub = makeClientStubs({
      modelResults: [{ error: makeStatusError(500) }, { error: makeStatusError(503) }],
    })
    const { client, logger } = makeClient(stub)

    await expect(
      client.requestReview({ ...requestParams, fallbackModel: null }, logger),
    ).rejects.toThrow(
      new ReviewRequestError({
        message:
          "review request failed after 2 attempt(s): z-ai/glm-5.3-flash: api_error (HTTP 500: HTTP 500); z-ai/glm-5.3-flash: api_error (HTTP 503: HTTP 503)",
        attempts: [
          {
            model: "z-ai/glm-5.3-flash",
            outcome: "api_error",
            promptTokens: null,
            completionTokens: null,
            costUsd: null,
            errorSummary: "HTTP 500: HTTP 500",
          },
          {
            model: "z-ai/glm-5.3-flash",
            outcome: "api_error",
            promptTokens: null,
            completionTokens: null,
            costUsd: null,
            errorSummary: "HTTP 503: HTTP 503",
          },
        ],
        keyRejected: false,
      }),
    )
    expect(stub.modelCalls).toHaveLength(2)
  })

  it("carries every billed attempt on the error when the ladder is exhausted", async () => {
    const stub = makeClientStubs({
      modelResults: [{ error: makeStatusError(500) }, { error: makeStatusError(503) }],
    })
    const { client, logger } = makeClient(stub)

    const failure = await captureRejection(
      client.requestReview({ ...requestParams, fallbackModel: null }, logger),
    )

    if (!(failure instanceof ReviewRequestError)) {
      throw new Error("expected a ReviewRequestError")
    }
    expect(failure.keyRejected).toBe(false)
    expect(failure.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "api_error",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        errorSummary: "HTTP 500: HTTP 500",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "api_error",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        errorSummary: "HTTP 503: HTTP 503",
      },
    ])
  })

  it("marks the error as key-rejected on an auth/credit failure", async () => {
    const stub = makeClientStubs({
      modelResults: [{ error: makeStatusError(402) }],
    })
    const { client, logger } = makeClient(stub)

    const failure = await captureRejection(client.requestReview(requestParams, logger))

    if (!(failure instanceof ReviewRequestError)) {
      throw new Error("expected a ReviewRequestError")
    }
    expect(failure.keyRejected).toBe(true)
    expect(failure.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "api_error",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        errorSummary: "HTTP 402: HTTP 402",
      },
    ])
  })

  it("makes at most four calls across both ladder models", async () => {
    const stub = makeClientStubs({
      modelResults: [
        { value: invalidJsonResult },
        { value: invalidJsonResult },
        { value: invalidJsonResult },
        { value: invalidJsonResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    await expect(client.requestReview(requestParams, logger)).rejects.toThrow(
      new ReviewRequestError({
        message:
          "review request failed after 4 attempt(s): z-ai/glm-5.3-flash: invalid_json (response content is not valid JSON); z-ai/glm-5.3-flash: invalid_json (response content is not valid JSON); deepseek/deepseek-v4.1-flash: invalid_json (response content is not valid JSON); deepseek/deepseek-v4.1-flash: invalid_json (response content is not valid JSON)",
        attempts: [
          {
            model: "z-ai/glm-5.3-flash",
            outcome: "invalid_json",
            promptTokens: 54,
            completionTokens: 102,
            costUsd: 0.000021036,
            errorSummary: "response content is not valid JSON",
          },
          {
            model: "z-ai/glm-5.3-flash",
            outcome: "invalid_json",
            promptTokens: 54,
            completionTokens: 102,
            costUsd: 0.000021036,
            errorSummary: "response content is not valid JSON",
          },
          {
            model: "deepseek/deepseek-v4.1-flash",
            outcome: "invalid_json",
            promptTokens: 54,
            completionTokens: 102,
            costUsd: 0.000021036,
            errorSummary: "response content is not valid JSON",
          },
          {
            model: "deepseek/deepseek-v4.1-flash",
            outcome: "invalid_json",
            promptTokens: 54,
            completionTokens: 102,
            costUsd: 0.000021036,
            errorSummary: "response content is not valid JSON",
          },
        ],
        keyRejected: false,
      }),
    )
    expect(stub.modelCalls).toHaveLength(4)
  })

  it("looks up the generation cost when the accepted attempt has no usage cost", async () => {
    const stub = makeClientStubs({
      modelResults: [{ value: makeNoCostResult() }],
      generationResponses: [{ value: { data: { totalCost: 0.0399 } } }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(stub.generationCalls).toEqual([
      {
        id: ACCEPTED_GENERATION_ID,
        options: {
          retries: { strategy: "none" },
          signal: expect.any(AbortSignal),
        },
      },
    ])
    expect(result.attempts).toEqual([
      {
        model: requestParams.model,
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        costUsd: 0.0399,
        errorSummary: null,
      },
    ])
    expect(logsWithMessage(logger, "generation cost looked up")).toEqual([
      {
        level: "info",
        message: "generation cost looked up",
        data: {
          operation: "generation cost lookup",
          generationId: ACCEPTED_GENERATION_ID,
          costUsd: 0.0399,
        },
      },
    ])
  })

  it("degrades to a null cost with a warning when the generation lookup fails", async () => {
    const stub = makeClientStubs({
      modelResults: [{ value: makeNoCostResult() }],
      generationResponses: [{ error: makeStatusError(500) }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: requestParams.model,
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        costUsd: null,
        errorSummary: null,
      },
    ])
    expect(logsWithMessage(logger, "generation cost lookup failed")).toEqual([
      {
        level: "warn",
        message: "generation cost lookup failed",
        data: {
          operation: "generation cost lookup",
          generationId: ACCEPTED_GENERATION_ID,
          error: "HTTP 500",
        },
      },
    ])
  })

  it("degrades to a null cost with a warning when the generation lookup throws synchronously", async () => {
    const throwingCostLookupClient: GenerationsLike = {
      generations: {
        getGeneration: () => {
          throw new Error("lookup threw before returning a promise")
        },
      },
    }
    const { agent } = makeClientStubs({ modelResults: [{ value: makeNoCostResult() }] })
    const { client, logger } = makeClient({ agent, costLookupClient: throwingCostLookupClient })

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: requestParams.model,
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        costUsd: null,
        errorSummary: null,
      },
    ])
    expect(logsWithMessage(logger, "generation cost lookup failed")).toEqual([
      {
        level: "warn",
        message: "generation cost lookup failed",
        data: {
          operation: "generation cost lookup",
          generationId: ACCEPTED_GENERATION_ID,
          error: "lookup threw before returning a promise",
        },
      },
    ])
  })

  it("degrades to a null cost with a warning when the generation response has an unexpected shape", async () => {
    const stub = makeClientStubs({
      modelResults: [{ value: makeNoCostResult() }],
      generationResponses: [{ value: { data: {} } }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: requestParams.model,
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        costUsd: null,
        errorSummary: null,
      },
    ])
    expect(logsWithMessage(logger, "unexpected generation response shape")).toEqual([
      {
        level: "warn",
        message: "unexpected generation response shape",
        data: { operation: "generation cost lookup", generationId: ACCEPTED_GENERATION_ID },
      },
    ])
  })

  it("records null token counts when the response carries no usage block", async () => {
    const stub = makeClientStubs({
      modelResults: [{ value: makeNoUsageResult() }],
      generationResponses: [{ value: { data: { totalCost: 0.0399 } } }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    // costUsd from the lookup proves the missing usage block routed the
    // accepted attempt through the generation-cost fallback
    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        promptTokens: null,
        completionTokens: null,
        costUsd: 0.0399,
        errorSummary: null,
      },
    ])
  })
})
