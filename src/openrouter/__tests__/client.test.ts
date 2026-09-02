import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
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

type StubOptions = { signal?: AbortSignal } | undefined

/** `pending` hands the call's options to a custom promise — for a request
 *  that never settles, settles late, or honours the abort signal. */
type StubResponse =
  | { value: unknown }
  | { error: unknown }
  | { pending: (options: StubOptions) => Promise<unknown> }

const makeSdkStub = ({
  sendResponses,
  generationResponses = [],
}: {
  sendResponses: StubResponse[]
  generationResponses?: StubResponse[]
}) => {
  const sendCalls: {
    chatRequest: ChatRequestSubset
    options: StubOptions
  }[] = []
  const generationCalls: {
    id: string
    options: StubOptions
  }[] = []

  const takeNext = ({
    queue,
    callCount,
    operation,
    options,
  }: {
    queue: StubResponse[]
    callCount: number
    operation: string
    options: StubOptions
  }): unknown => {
    const next = queue[callCount - 1]
    if (next === undefined) {
      throw new Error(`stub: unexpected ${operation} call #${callCount}`)
    }
    if ("error" in next) throw next.error
    if ("pending" in next) return next.pending(options)
    return next.value
  }

  const sdk: OpenRouterLike = {
    chat: {
      send: async (request, options) => {
        sendCalls.push({ ...request, options })
        return takeNext({
          queue: sendResponses,
          callCount: sendCalls.length,
          operation: "chat.send",
          options,
        })
      },
    },
    generations: {
      getGeneration: async (request, options) => {
        generationCalls.push({ ...request, options })
        return takeNext({
          queue: generationResponses,
          callCount: generationCalls.length,
          operation: "generations.getGeneration",
          options,
        })
      },
    },
  }

  return { sdk, sendCalls, generationCalls }
}

const makeClient = (stub: { sdk: OpenRouterLike }) => {
  const logger = createTestLogger()
  const client = createOpenRouterClient(
    { sdk: stub.sdk, requestTimeoutMs: 45_000, retryDelayMs: 0 },
    logger,
  )
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
  it("sends the strict json_schema response format with the review schema and per-attempt timeout", async () => {
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
          maxCompletionTokens: 128_000,
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
        options: {
          retries: { strategy: "none" },
          signal: expect.any(AbortSignal),
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

  it("retries an SDK-thrown TimeoutError as an api_error through the action's ladder, not the SDK's", async () => {
    const timeoutError = new Error("Request timed out")
    timeoutError.name = "TimeoutError"
    const stub = makeSdkStub({
      sendResponses: [{ error: timeoutError }, { value: acceptedChatResult }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams)

    expect(
      stub.sendCalls.map((sendCall) => sendCall.chatRequest.model),
    ).toEqual(["openai/gpt-5-mini", "openai/gpt-5-mini"])
    expect(stub.sendCalls[0]?.options).toEqual({
      retries: { strategy: "none" },
      signal: expect.any(AbortSignal),
    })
    expect(result.attempts[0]).toEqual({
      model: "openai/gpt-5-mini",
      outcome: "api_error",
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      errorSummary: "Request timed out",
    })
    expect(logger.messages).toContainEqual({
      level: "warn",
      message: "review attempt failed",
      data: {
        model: "openai/gpt-5-mini",
        attemptNumber: 1,
        outcome: "api_error",
        errorSummary: "Request timed out",
      },
    })
  })

  it("passes a live (non-aborted) AbortSignal to the SDK call", async () => {
    const stub = makeSdkStub({
      sendResponses: [{ value: acceptedChatResult }],
      generationResponses: [{ value: { data: { totalCost: 0.01 } } }],
    })
    const { client } = makeClient(stub)

    await client.requestReview(requestParams)

    const signal = stub.sendCalls[0]?.options?.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
  })

  it("aborts the signal at the deadline and records the orphan settling with an AbortError when the SDK honours it", async () => {
    vi.useFakeTimers()
    try {
      // Shaped like the SDK's rejection: its own error wrapping the
      // DOMException the aborted fetch raised
      const rejectOnAbort = (options: StubOptions): Promise<unknown> => {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(
              Object.assign(new Error("Request aborted by client"), {
                name: "RequestAbortedError",
                cause: new DOMException(
                  "This operation was aborted",
                  "AbortError",
                ),
              }),
            ),
          )
        })
      }
      const stub = makeSdkStub({
        sendResponses: [{ pending: rejectOnAbort }, { pending: rejectOnAbort }],
      })
      const logger = createTestLogger()
      const client = createOpenRouterClient(
        { sdk: stub.sdk, requestTimeoutMs: 45_000, retryDelayMs: 0 },
        logger,
      )

      // Attach the rejection handler BEFORE advancing timers so the
      // second attempt's async abort rejection is caught immediately.
      const reviewPromise = client.requestReview({
        ...requestParams,
        fallbackModel: null,
      })
      void reviewPromise.catch(() => undefined)

      // Two attempts × 45s each — advance past both deadlines
      await vi.advanceTimersByTimeAsync(90_000)

      await expect(reviewPromise).rejects.toThrow(
        "review request failed after 2 attempt(s): openai/gpt-5-mini: timeout (no response within 45s); openai/gpt-5-mini: timeout (no response within 45s)",
      )
      expect(stub.sendCalls[0]?.options?.signal?.aborted).toBe(true)
      expect(logger.messages).toContainEqual({
        level: "warn",
        message: "deadline-elapsed request settled",
        data: {
          operation: "chat request",
          model: "openai/gpt-5-mini",
          elapsedMs: 45_000,
          timeoutMs: 45_000,
          settledWith: "abort_error",
          error: "Request aborted by client",
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("fails the attempt at the deadline as a retryable timeout even when the SDK ignores the abort signal", async () => {
    vi.useFakeTimers()
    try {
      const stub = makeSdkStub({
        sendResponses: [
          { pending: () => new Promise(() => undefined) },
          { value: acceptedChatResult },
        ],
      })
      const logger = createTestLogger()
      const client = createOpenRouterClient(
        { sdk: stub.sdk, requestTimeoutMs: 45_000, retryDelayMs: 0 },
        logger,
      )

      const reviewPromise = client.requestReview(requestParams)
      await vi.advanceTimersByTimeAsync(45_000)
      const result = await reviewPromise

      expect(
        stub.sendCalls.map((sendCall) => sendCall.chatRequest.model),
      ).toEqual(["openai/gpt-5-mini", "openai/gpt-5-mini"])
      expect(result.attempts).toEqual([
        {
          model: "openai/gpt-5-mini",
          outcome: "timeout",
          promptTokens: null,
          completionTokens: null,
          costUsd: null,
          errorSummary: "no response within 45s",
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
      expect(logger.messages).toContainEqual({
        level: "warn",
        message: "request deadline elapsed",
        data: {
          operation: "chat request",
          model: "openai/gpt-5-mini",
          timeoutMs: 45_000,
        },
      })
      expect(logger.messages).toContainEqual({
        level: "warn",
        message: "review attempt failed",
        data: {
          model: "openai/gpt-5-mini",
          attemptNumber: 1,
          outcome: "timeout",
          errorSummary: "no response within 45s",
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("logs a late response when the orphaned request completes after the deadline", async () => {
    vi.useFakeTimers()
    try {
      const resolveLate = (): Promise<unknown> => {
        return new Promise((resolve) => {
          setTimeout(() => resolve(acceptedChatResult), 120_000)
        })
      }
      const stub = makeSdkStub({
        sendResponses: [
          { pending: resolveLate },
          { value: acceptedChatResult },
        ],
      })
      const logger = createTestLogger()
      const client = createOpenRouterClient(
        { sdk: stub.sdk, requestTimeoutMs: 45_000, retryDelayMs: 0 },
        logger,
      )

      const reviewPromise = client.requestReview(requestParams)
      await vi.advanceTimersByTimeAsync(45_000)
      const result = await reviewPromise
      expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
        "timeout",
        "accepted",
      ])

      await vi.advanceTimersByTimeAsync(75_000)

      expect(logger.messages).toContainEqual({
        level: "warn",
        message: "deadline-elapsed request settled",
        data: {
          operation: "chat request",
          model: "openai/gpt-5-mini",
          elapsedMs: 120_000,
          timeoutMs: 45_000,
          settledWith: "response",
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("logs a late non-abort rejection without raising an unhandled rejection", async () => {
    vi.useFakeTimers()
    try {
      const rejectLate = (): Promise<unknown> => {
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("socket hang up")), 120_000)
        })
      }
      const stub = makeSdkStub({
        sendResponses: [{ pending: rejectLate }, { value: acceptedChatResult }],
      })
      const logger = createTestLogger()
      const client = createOpenRouterClient(
        { sdk: stub.sdk, requestTimeoutMs: 45_000, retryDelayMs: 0 },
        logger,
      )

      const reviewPromise = client.requestReview(requestParams)
      await vi.advanceTimersByTimeAsync(45_000)
      await reviewPromise
      await vi.advanceTimersByTimeAsync(75_000)

      expect(logger.messages).toContainEqual({
        level: "warn",
        message: "deadline-elapsed request settled",
        data: {
          operation: "chat request",
          model: "openai/gpt-5-mini",
          elapsedMs: 120_000,
          timeoutMs: 45_000,
          settledWith: "error",
          error: "socket hang up",
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("degrades to a null cost with both warnings when the generation lookup exceeds the deadline", async () => {
    vi.useFakeTimers()
    try {
      const stub = makeSdkStub({
        sendResponses: [{ value: makeNoCostChatResult() }],
        generationResponses: [{ pending: () => new Promise(() => undefined) }],
      })
      const logger = createTestLogger()
      const client = createOpenRouterClient(
        { sdk: stub.sdk, requestTimeoutMs: 45_000, retryDelayMs: 0 },
        logger,
      )

      const reviewPromise = client.requestReview(requestParams)
      await vi.advanceTimersByTimeAsync(45_000)
      const result = await reviewPromise

      expect(result.attempts[0]?.costUsd).toBeNull()
      expect(logger.messages).toContainEqual({
        level: "warn",
        message: "request deadline elapsed",
        data: {
          operation: "generation cost lookup",
          generationId: "gen-no-cost",
          timeoutMs: 45_000,
        },
      })
      expect(logger.messages).toContainEqual({
        level: "warn",
        message: "generation cost lookup failed",
        data: { error: "no response within 45s" },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears the chat attempt timeout timer after a successful response", async () => {
    const stub = makeSdkStub({
      sendResponses: [{ value: acceptedChatResult }],
    })
    delete stub.sdk.generations
    const { client } = makeClient(stub)

    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
    try {
      await client.requestReview(requestParams)
      expect(clearTimeoutSpy).toHaveBeenCalled()
    } finally {
      clearTimeoutSpy.mockRestore()
    }
  })

  it("does not sleep after the final attempt when retries are exhausted", async () => {
    const retryDelayMs = 50
    const stub = makeSdkStub({
      sendResponses: [
        { error: makeStatusError(429) },
        { error: makeStatusError(429) },
      ],
    })
    const logger = createTestLogger()
    const client = createOpenRouterClient(
      { sdk: stub.sdk, requestTimeoutMs: 45_000, retryDelayMs },
      logger,
    )

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
    try {
      await expect(
        client.requestReview({ ...requestParams, fallbackModel: null }),
      ).rejects.toThrow("review request failed")

      // retryDelayMs sleeps happen between retryable failures; the guard
      // `attemptNumber <= MAX_ATTEMPTS_PER_MODEL` prevents an extra sleep
      // after the final attempt. Only one sleep (between attempts 1 and 2).
      const retrySleepCalls = setTimeoutSpy.mock.calls.filter(
        (call) => call[1] === retryDelayMs,
      )
      expect(retrySleepCalls).toHaveLength(1)
      expect(stub.sendCalls).toHaveLength(2)
    } finally {
      setTimeoutSpy.mockRestore()
    }
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

    expect(stub.generationCalls).toEqual([
      {
        id: "gen-no-cost",
        options: {
          retries: { strategy: "none" },
          signal: expect.any(AbortSignal),
        },
      },
    ])
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
