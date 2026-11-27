import { readFileSync } from "node:fs"
import { OpenRouter, type PostModelCallPayload } from "@openrouter/agent"

// @openrouter/sdk is not a declared dependency. These imports read the copy
// @openrouter/agent installs, so the tests build the same result and error
// classes, and the same HTTP client, production receives
import { HTTPClient, type Fetcher } from "@openrouter/sdk/lib/http"
import { openResponsesResultFromJSON, type OpenResponsesResult } from "@openrouter/sdk/models"
import {
  OpenRouterError,
  ResponsesBadRequestResponseError,
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
 *  through the SDK's own transform, here also a drift guard on hand-edited
 *  fixtures. The stub reads the full result to build its call report. */
const transformWirePayload = (payload: unknown): OpenResponsesResult => {
  const transformed = openResponsesResultFromJSON(JSON.stringify(payload))

  if (!transformed.ok) throw transformed.error
  return transformed.value
}

/** What one `callModel` stub call resolves: the transformed response and the
 *  SDK-extracted text, as the client reads them. */
type ModelCallResult = { response: OpenResponsesResult; text: string }

/** The duration every stub call report carries. */
const STUB_CALL_DURATION_MS = 1234

/** The report the Agent SDK's PostModelCall hook receives for a completed
 *  call, with the stub's fixed duration in place of a measured one. */
const makeCallReport = (response: OpenResponsesResult): PostModelCallPayload => {
  const reportedUsage = response.usage
    ? {
        usage: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          cachedTokens: response.usage.inputTokensDetails.cachedTokens,
          reasoningTokens: response.usage.outputTokensDetails.reasoningTokens,
          ...(typeof response.usage.cost === "number" ? { cost: response.usage.cost } : {}),
        },
      }
    : {}

  return {
    sessionId: "",
    responseId: response.id,
    model: response.model,
    durationMs: STUB_CALL_DURATION_MS,
    turnType: "initial",
    turnNumber: 0,
    ...reportedUsage,
  }
}

const toModelCallResult = (payload: unknown): ModelCallResult => ({
  response: transformWirePayload(payload),
  text: extractMessageText(payload),
})

const acceptedResult = toModelCallResult(acceptedWirePayload)
const invalidJsonResult = toModelCallResult(invalidJsonWirePayload)
const schemaMismatchResult = toModelCallResult(schemaMismatchWirePayload)

/** The accepted payload with its usage cost removed. */
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
const makeReasoningOnlyPayload = (): z.infer<typeof acceptedPayloadSchema> => {
  const payload = parseAcceptedPayload()
  const reasoningItems = payload.output.filter((item) => item.type === "reasoning")
  return { ...payload, output: reasoningItems }
}

/** The accepted payload with no output items: the empty final turn the SDK
 *  rejects after its call report. */
const makeEmptyOutputPayload = (): z.infer<typeof acceptedPayloadSchema> => {
  return { ...parseAcceptedPayload(), output: [] }
}

/** A payload the provider marked as stopped early, with the given
 *  `incomplete_details` wire field. */
const makeIncompleteResult = ({
  payload,
  incompleteDetails,
}: {
  payload: unknown
  incompleteDetails: { reason: string } | null
}): ModelCallResult => {
  return toModelCallResult({
    ...wirePayloadSchema.parse(payload),
    status: "incomplete",
    incomplete_details: incompleteDetails,
  })
}

/** The error the Agent SDK throws for the empty-output payload's final turn. */
const EMPTY_OUTPUT_REJECTION_MESSAGE = `Invalid final response: empty or invalid output — output array is empty (length 0) for response "${ACCEPTED_GENERATION_ID}". The model returned no output items. This can happen when the provider returns an empty final turn; see the strictFinalResponse/allowFinalResponse options`

/** That error's attempt summary, cut at the client's 200-character cap. */
const EMPTY_OUTPUT_REJECTION_SUMMARY = `Invalid final response: empty or invalid output — output array is empty (length 0) for response "${ACCEPTED_GENERATION_ID}". The model returned no output items. This can happen when the prov…`

/** How one stub call settles. The stub sends the call report the SDK would,
 *  before the call settles:
 *  - `value` and a resolved `pending` report their response.
 *  - `error` reports `completedResponse` when one is given: a call the SDK
 *    rejected after the model call completed, such as an empty final turn.
 *  - `pending` hands the call's request to a custom promise, for a request
 *    that never settles, settles late, or honours the abort signal. */
type StubModelResult =
  | { value: ModelCallResult }
  | { error: unknown; completedResponse?: OpenResponsesResult }
  | { pending: (request: { signal: AbortSignal }) => Promise<ModelCallResult> }

type StubRequest = Parameters<AgentLike["callModel"]>[0]

/** Runs the request's PostModelCall handlers with the report for `response`. */
const reportCompletedCall = (request: StubRequest, response: OpenResponsesResult): void => {
  const report = makeCallReport(response)

  for (const { handler } of request.hooks.PostModelCall) handler(report)
}

const makeClientStubs = ({ modelResults }: { modelResults: StubModelResult[] }) => {
  const modelCalls: {
    request: StubRequest
    options: { retries?: { strategy: "backoff" | "none" } } | undefined
  }[] = []

  const takeNextModelResult = async (request: StubRequest): Promise<ModelCallResult> => {
    const next = modelResults.at(modelCalls.length - 1)

    if (!next) {
      throw new Error(`stub: unexpected callModel call #${modelCalls.length}`)
    }

    if ("error" in next) {
      if (next.completedResponse) reportCompletedCall(request, next.completedResponse)
      throw next.error
    }

    const result = "pending" in next ? await next.pending(request) : next.value
    reportCompletedCall(request, result.response)
    return result
  }

  const agent: AgentLike = {
    callModel: (request, options) => {
      modelCalls.push({ request, options })

      // The async queue read settles every stub error as a rejection, the way
      // the SDK's materialized stream rejects
      const settled = takeNextModelResult(request)
      return {
        getResponse: async () => (await settled).response,
        getText: async () => (await settled).text,
      }
    },
  }

  return { agent, modelCalls }
}

const makeClient = (stub: { agent: AgentLike }) => {
  const logger = createTestLogger()
  const client = createOpenRouterClient({
    agent: stub.agent,
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

/** An SDK error of the given status, as the SDK's base class carries it, with
 *  `statusCode` set from the HTTP response. An error without `statusCode`
 *  takes the status-less path the network-error test pins. */
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

/** The 400 error the SDK's Responses call throws, built from a captured error body. */
const makeBadRequestError = (body: unknown): ResponsesBadRequestResponseError => {
  return new ResponsesBadRequestResponseError(
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
}): ResponsesBadRequestResponseError => {
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
                  durationMs: null,
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
            durationMs: null,
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
            durationMs: STUB_CALL_DURATION_MS,
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

  it("returns an accepted review whose response arrives as the review deadline runs out", async () => {
    // The response spends the rest of this test's controllable deadline
    const deadline = { remainingMs: 100 }
    const stub = makeClientStubs({
      modelResults: [
        {
          pending: async () => {
            deadline.remainingMs = 0
            return acceptedResult
          },
        },
      ],
    })
    const logger = createTestLogger()
    const client = createOpenRouterClient({
      agent: stub.agent,
      requestTimeoutMs: 45_000,
      remainingReviewMs: () => deadline.remainingMs,
    })

    const result = await client.requestReview(requestParams, logger)

    expect(result).toEqual({
      review: acceptedReview,
      modelUsed: requestParams.model,
      attempts: [
        {
          model: requestParams.model,
          outcome: "accepted",
          ...ACCEPTED_USAGE,
          durationMs: STUB_CALL_DURATION_MS,
          errorSummary: null,
        },
      ],
    })
    expect(stub.modelCalls.map(({ request }) => request.model)).toEqual([requestParams.model])
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
          hooks: { PostModelCall: [{ handler: expect.any(Function) }] },
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
          durationMs: STUB_CALL_DURATION_MS,
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
          durationMs: STUB_CALL_DURATION_MS,
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
        durationMs: STUB_CALL_DURATION_MS,
        errorSummary: "response content is not valid JSON",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        promptTokens: 54,
        completionTokens: 102,
        costUsd: 0.000021036,
        durationMs: STUB_CALL_DURATION_MS,
        errorSummary: null,
      },
    ])
  })

  it("records empty_content and retries the same model once when the SDK extracts no text", async () => {
    const stub = makeClientStubs({
      modelResults: [
        { value: toModelCallResult(makeReasoningOnlyPayload()) },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "empty_content",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
        errorSummary: "response had no text content",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        promptTokens: 54,
        completionTokens: 102,
        costUsd: 0.000021036,
        durationMs: STUB_CALL_DURATION_MS,
        errorSummary: null,
      },
    ])
  })

  it("records the SDK's empty-output rejection as a billed empty_content attempt and logs its generation id", async () => {
    const stub = makeClientStubs({
      modelResults: [
        {
          error: new Error(EMPTY_OUTPUT_REJECTION_MESSAGE),
          completedResponse: transformWirePayload(makeEmptyOutputPayload()),
        },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "empty_content",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
        errorSummary: EMPTY_OUTPUT_REJECTION_SUMMARY,
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
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
          outcome: "empty_content",
          errorSummary: EMPTY_OUTPUT_REJECTION_SUMMARY,
          generationId: ACCEPTED_GENERATION_ID,
        },
      },
    ])
  })

  it("records an unreported empty-output rejection as empty_content with no usage, duration or generation id", async () => {
    const stub = makeClientStubs({
      modelResults: [
        { error: new Error(EMPTY_OUTPUT_REJECTION_MESSAGE) },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "empty_content",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        durationMs: null,
        errorSummary: EMPTY_OUTPUT_REJECTION_SUMMARY,
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
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
          outcome: "empty_content",
          errorSummary: EMPTY_OUTPUT_REJECTION_SUMMARY,
        },
      },
    ])
  })

  it("keeps api_error for a missing-fields rejection while recording the reported call's usage and duration", async () => {
    const stub = makeClientStubs({
      modelResults: [
        {
          error: new Error("Invalid final response: missing required fields: output"),
          completedResponse: acceptedResult.response,
        },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "api_error",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
        errorSummary: "Invalid final response: missing required fields: output",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
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
          errorSummary: "Invalid final response: missing required fields: output",
          generationId: ACCEPTED_GENERATION_ID,
        },
      },
    ])
  })

  it("records no usage, duration or generation id for an unreported failure that follows a billed attempt", async () => {
    const stub = makeClientStubs({
      modelResults: [
        { value: invalidJsonResult },
        { error: new Error("socket hang up") },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "invalid_json",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
        errorSummary: "response content is not valid JSON",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "api_error",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        durationMs: null,
        errorSummary: "socket hang up",
      },
      {
        model: "deepseek/deepseek-v4.1-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
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
          outcome: "invalid_json",
          errorSummary: "response content is not valid JSON",
          generationId: ACCEPTED_GENERATION_ID,
        },
      },
      {
        level: "warn",
        message: "review attempt failed",
        data: {
          model: "z-ai/glm-5.3-flash",
          modelAttemptNumber: 2,
          outcome: "api_error",
          errorSummary: "socket hang up",
        },
      },
    ])
  })

  it("records response_incomplete with the provider's reason when an incomplete response is not valid JSON, then retries", async () => {
    const stub = makeClientStubs({
      modelResults: [
        {
          value: makeIncompleteResult({
            payload: invalidJsonWirePayload,
            incompleteDetails: { reason: "max_output_tokens" },
          }),
        },
        { value: acceptedResult },
      ],
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
        outcome: "response_incomplete",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
        errorSummary: "response incomplete: max_output_tokens",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
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
          outcome: "response_incomplete",
          errorSummary: "response incomplete: max_output_tokens",
          generationId: ACCEPTED_GENERATION_ID,
        },
      },
    ])
  })

  it("records response_incomplete, not empty_content, for an incomplete reasoning-only response", async () => {
    const stub = makeClientStubs({
      modelResults: [
        {
          value: makeIncompleteResult({
            payload: makeReasoningOnlyPayload(),
            incompleteDetails: { reason: "content_filter" },
          }),
        },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "response_incomplete",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
        errorSummary: "response incomplete: content_filter",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
        errorSummary: null,
      },
    ])
  })

  it("names an unknown reason when an incomplete response that fails the schema carries no incomplete details", async () => {
    const stub = makeClientStubs({
      modelResults: [
        {
          value: makeIncompleteResult({
            payload: schemaMismatchWirePayload,
            incompleteDetails: null,
          }),
        },
        { value: acceptedResult },
      ],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "response_incomplete",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
        errorSummary: "response incomplete: unknown reason",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
        errorSummary: null,
      },
    ])
  })

  it("accepts a schema-valid review even when the response reports itself incomplete", async () => {
    const stub = makeClientStubs({
      modelResults: [
        {
          value: makeIncompleteResult({
            payload: acceptedWirePayload,
            incompleteDetails: { reason: "max_output_tokens" },
          }),
        },
      ],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result).toEqual({
      review: acceptedReview,
      modelUsed: "z-ai/glm-5.3-flash",
      attempts: [
        {
          model: "z-ai/glm-5.3-flash",
          outcome: "accepted",
          ...ACCEPTED_USAGE,
          durationMs: STUB_CALL_DURATION_MS,
          errorSummary: null,
        },
      ],
    })
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
      durationMs: STUB_CALL_DURATION_MS,
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
        durationMs: STUB_CALL_DURATION_MS,
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
        durationMs: null,
        errorSummary: `HTTP ${statusCode}: HTTP ${statusCode}`,
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
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
        durationMs: null,
        errorSummary: "HTTP 200: Response validation failed",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
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
        durationMs: null,
        errorSummary: "socket hang up",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
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
        durationMs: null,
        errorSummary: "Request timed out",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
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
              durationMs: null,
              errorSummary: "no response within 45s",
            },
            {
              model: "z-ai/glm-5.3-flash",
              outcome: "timeout",
              promptTokens: null,
              completionTokens: null,
              costUsd: null,
              durationMs: null,
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
          durationMs: null,
          errorSummary: "no response within 45s",
        },
        {
          model: "deepseek/deepseek-v4.1-flash",
          outcome: "accepted",
          promptTokens: 54,
          completionTokens: 102,
          costUsd: 0.000021036,
          durationMs: STUB_CALL_DURATION_MS,
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
          durationMs: null,
          errorSummary: "no response within 45s",
        },
        {
          model: "z-ai/glm-5.3-flash",
          outcome: "accepted",
          promptTokens: 54,
          completionTokens: 102,
          costUsd: 0.000021036,
          durationMs: STUB_CALL_DURATION_MS,
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
              durationMs: null,
              errorSummary: "no response within 45s",
            },
            {
              model: "deepseek/deepseek-v4.1-flash",
              outcome: "timeout",
              promptTokens: null,
              completionTokens: null,
              costUsd: null,
              durationMs: null,
              errorSummary: "no response within 45s",
            },
            {
              model: "deepseek/deepseek-v4.1-flash",
              outcome: "timeout",
              promptTokens: null,
              completionTokens: null,
              costUsd: null,
              durationMs: null,
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
              durationMs: null,
              errorSummary: "HTTP 429: HTTP 429",
            },
            {
              model: "z-ai/glm-5.3-flash",
              outcome: "api_error",
              promptTokens: null,
              completionTokens: null,
              costUsd: null,
              durationMs: null,
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
        durationMs: null,
        errorSummary: `HTTP 429: ${"x".repeat(200)}…`,
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
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
        durationMs: null,
        errorSummary: "HTTP 404: HTTP 404",
      },
      {
        model: "deepseek/deepseek-v4.1-flash",
        outcome: "accepted",
        promptTokens: 54,
        completionTokens: 102,
        costUsd: 0.000021036,
        durationMs: STUB_CALL_DURATION_MS,
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
          durationMs: null,
          errorSummary:
            "HTTP 400: This endpoint's maximum context length is 262144 tokens. However, you requested about 263762 tokens (135762 of text input, 128000 in the output). Please reduce the length of either one, or use the con…",
        },
        {
          model: "z-ai/glm-5.3-flash",
          outcome: "accepted",
          promptTokens: 54,
          completionTokens: 102,
          costUsd: 0.000021036,
          durationMs: STUB_CALL_DURATION_MS,
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
        durationMs: null,
        errorSummary:
          "HTTP 400: This endpoint's maximum context length is 8192 tokens. However, you requested about 11593 tokens (4593 of text input, 7000 in the output). Please reduce the length of either one, or use the context-co…",
      },
      {
        model: "deepseek/deepseek-v4.1-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: STUB_CALL_DURATION_MS,
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
            durationMs: null,
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
              durationMs: null,
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
            durationMs: null,
            errorSummary: "HTTP 500: HTTP 500",
          },
          {
            model: "z-ai/glm-5.3-flash",
            outcome: "api_error",
            promptTokens: null,
            completionTokens: null,
            costUsd: null,
            durationMs: null,
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
        durationMs: null,
        errorSummary: "HTTP 500: HTTP 500",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "api_error",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        durationMs: null,
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
        durationMs: null,
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
            durationMs: STUB_CALL_DURATION_MS,
            errorSummary: "response content is not valid JSON",
          },
          {
            model: "z-ai/glm-5.3-flash",
            outcome: "invalid_json",
            promptTokens: 54,
            completionTokens: 102,
            costUsd: 0.000021036,
            durationMs: STUB_CALL_DURATION_MS,
            errorSummary: "response content is not valid JSON",
          },
          {
            model: "deepseek/deepseek-v4.1-flash",
            outcome: "invalid_json",
            promptTokens: 54,
            completionTokens: 102,
            costUsd: 0.000021036,
            durationMs: STUB_CALL_DURATION_MS,
            errorSummary: "response content is not valid JSON",
          },
          {
            model: "deepseek/deepseek-v4.1-flash",
            outcome: "invalid_json",
            promptTokens: 54,
            completionTokens: 102,
            costUsd: 0.000021036,
            durationMs: STUB_CALL_DURATION_MS,
            errorSummary: "response content is not valid JSON",
          },
        ],
        keyRejected: false,
      }),
    )
    expect(stub.modelCalls).toHaveLength(4)
  })

  it("records null token counts and a null cost when the response carries no usage block", async () => {
    const stub = makeClientStubs({
      modelResults: [{ value: makeNoUsageResult() }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        durationMs: STUB_CALL_DURATION_MS,
        errorSummary: null,
      },
    ])
  })

  it("records a null cost with its token counts when the usage block carries no cost", async () => {
    const stub = makeClientStubs({ modelResults: [{ value: makeNoCostResult() }] })
    const { client, logger } = makeClient(stub)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        costUsd: null,
        durationMs: STUB_CALL_DURATION_MS,
        errorSummary: null,
      },
    ])
  })
})

/** A streamed Responses body as OpenRouter sends it: a created event with no
 *  output yet, then the terminal event carrying the whole payload. A response
 *  the provider stopped early ends with `response.incomplete` instead of
 *  `response.completed`. */
const makeStreamedWireResponse = (
  payload: z.infer<typeof wirePayloadSchema>,
  terminalEventType: "response.completed" | "response.incomplete" = "response.completed",
): Response => {
  const createdEvent = {
    type: "response.created",
    sequence_number: 0,
    response: { ...payload, status: "in_progress", incomplete_details: null, output: [] },
  }
  const terminalEvent = { type: terminalEventType, sequence_number: 1, response: payload }
  const body = [createdEvent, terminalEvent]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")

  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

const makeJsonErrorWireResponse = (statusCode: number, body: unknown): Response => {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  })
}

/** The one request-body field the real-SDK tests read back. */
const sentRequestBodySchema = z.looseObject({ model: z.string() })

/** The real Agent SDK client, whose HTTP client answers each request with the
 *  next wire response in order. `sentBodies` records each request's JSON
 *  body, and `sentModels` its model. */
const makeRealSdkAgent = (
  wireResponses: Response[],
): { agent: AgentLike; sentBodies: unknown[]; sentModels: string[] } => {
  const sentBodies: unknown[] = []
  const sentModels: string[] = []

  const fetcher: Fetcher = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const sentBody: unknown = await request.json()
    sentBodies.push(sentBody)
    sentModels.push(sentRequestBodySchema.parse(sentBody).model)
    const wireResponse = wireResponses.at(sentModels.length - 1)

    if (!wireResponse) throw new Error(`fetcher: unexpected request #${sentModels.length}`)
    return wireResponse
  }

  const agent = new OpenRouter({ apiKey: "sk-or-test", httpClient: new HTTPClient({ fetcher }) })
  return { agent, sentBodies, sentModels }
}

/** A real call's duration varies from run to run, so these tests check only
 *  that the SDK measured one. */
const measuredDuration = expect.toSatisfy((durationMs: unknown) => {
  return typeof durationMs === "number" && durationMs >= 0
}, "a measured, non-negative duration")

describe("requestReview through the real Agent SDK", () => {
  it("accepts the captured stream with its usage and a measured duration", async () => {
    const realSdk = makeRealSdkAgent([makeStreamedWireResponse(parseAcceptedPayload())])
    const { client, logger } = makeClient(realSdk)

    const result = await client.requestReview(requestParams, logger)

    expect(result).toEqual({
      review: acceptedReview,
      modelUsed: "z-ai/glm-5.3-flash",
      attempts: [
        {
          model: "z-ai/glm-5.3-flash",
          outcome: "accepted",
          ...ACCEPTED_USAGE,
          durationMs: measuredDuration,
          errorSummary: null,
        },
      ],
    })
    expect(realSdk.sentModels).toEqual(["z-ai/glm-5.3-flash"])
  })

  it("sends a streamed Responses body that carries neither the call-report hook nor the abort signal", async () => {
    const realSdk = makeRealSdkAgent([makeStreamedWireResponse(parseAcceptedPayload())])
    const { client, logger } = makeClient(realSdk)

    await client.requestReview(requestParams, logger)

    expect(realSdk.sentBodies).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        instructions: "system prompt",
        input: "user prompt",
        max_output_tokens: 128_000,
        text: {
          format: {
            type: "json_schema",
            name: "review_response",
            strict: true,
            schema: reviewResponseJsonSchema,
          },
        },
        service_tier: "auto",
        store: false,
        stream: true,
      },
    ])
  })

  it("records the captured stream with an empty output as a billed empty_content attempt, then retries", async () => {
    const realSdk = makeRealSdkAgent([
      makeStreamedWireResponse(makeEmptyOutputPayload()),
      makeStreamedWireResponse(parseAcceptedPayload()),
    ])
    const { client, logger } = makeClient(realSdk)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "empty_content",
        ...ACCEPTED_USAGE,
        durationMs: measuredDuration,
        errorSummary: EMPTY_OUTPUT_REJECTION_SUMMARY,
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: measuredDuration,
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
          outcome: "empty_content",
          errorSummary: EMPTY_OUTPUT_REJECTION_SUMMARY,
          generationId: ACCEPTED_GENERATION_ID,
        },
      },
    ])
    expect(realSdk.sentModels).toEqual(["z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash"])
  })

  it("records response_incomplete with the provider's reason for a stream that ends incomplete with invalid JSON, then retries", async () => {
    const incompletePayload = {
      ...wirePayloadSchema.parse(invalidJsonWirePayload),
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    }
    const realSdk = makeRealSdkAgent([
      makeStreamedWireResponse(incompletePayload, "response.incomplete"),
      makeStreamedWireResponse(parseAcceptedPayload()),
    ])
    const { client, logger } = makeClient(realSdk)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "response_incomplete",
        ...ACCEPTED_USAGE,
        durationMs: measuredDuration,
        errorSummary: "response incomplete: max_output_tokens",
      },
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: measuredDuration,
        errorSummary: null,
      },
    ])
    expect(realSdk.sentModels).toEqual(["z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash"])
  })

  it("stops the ladder as key-rejected after one call on the captured bad-key body", async () => {
    const realSdk = makeRealSdkAgent([makeJsonErrorWireResponse(401, badKeyErrorBody)])
    const { client, logger } = makeClient(realSdk)

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
            durationMs: null,
            errorSummary: "HTTP 401: User not found.",
          },
        ],
        keyRejected: true,
      }),
    )
    expect(realSdk.sentModels).toEqual(["z-ai/glm-5.3-flash"])
  })

  it("advances to the fallback with no fitted retry on the captured overflow body", async () => {
    const realSdk = makeRealSdkAgent([
      makeJsonErrorWireResponse(400, overflowErrorBody),
      makeStreamedWireResponse(parseAcceptedPayload()),
    ])
    const { client, logger } = makeClient(realSdk)

    const result = await client.requestReview(requestParams, logger)

    expect(result.attempts).toEqual([
      {
        model: "z-ai/glm-5.3-flash",
        outcome: "api_error",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        durationMs: null,
        errorSummary:
          "HTTP 400: This endpoint's maximum context length is 8192 tokens. However, you requested about 11593 tokens (4593 of text input, 7000 in the output). Please reduce the length of either one, or use the context-co…",
      },
      {
        model: "deepseek/deepseek-v4.1-flash",
        outcome: "accepted",
        ...ACCEPTED_USAGE,
        durationMs: measuredDuration,
        errorSummary: null,
      },
    ])
    expect(realSdk.sentModels).toEqual(["z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash"])
    expect(logsWithMessage(logger, CEILING_RETRY_LOG)).toEqual([])
  })
})
