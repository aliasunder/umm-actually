import { DateTime } from "luxon"
import { z } from "zod"
import type { Logger } from "../logger.js"
import {
  reviewResponseJsonSchema,
  reviewResponseSchema,
  type ReviewResponse,
} from "../review/finding.js"

export type AttemptOutcome =
  "accepted" | "api_error" | "timeout" | "empty_content" | "invalid_json" | "schema_mismatch"

export type ModelAttempt = {
  /** The model slug requested for this attempt (ladder position, not routing). */
  model: string
  outcome: AttemptOutcome
  promptTokens: number | null
  completionTokens: number | null
  costUsd: number | null
  /** Short human summary — never the raw response body. */
  errorSummary: string | null
}

export type StructuredReviewResult = {
  review: ReviewResponse
  /** The model the accepted response reports — OpenRouter's routed slug. */
  modelUsed: string
  /** Every attempt, failed ones included — they were billed too. */
  attempts: ModelAttempt[]
}

/** Structural subset of the SDK's ChatRequest — exactly what we send. */
export type ChatRequestSubset = {
  model: string
  messages: { role: "system" | "user"; content: string }[]
  maxCompletionTokens: number
  responseFormat: {
    type: "json_schema"
    jsonSchema: {
      name: string
      strict: boolean
      schema: Record<string, unknown>
    }
  }
  stream: false
}

/**
 * Structural subset of the OpenRouter SDK — test stubs are plain objects.
 * Method syntax keeps the real SDK assignable under strictFunctionTypes;
 * responses are `unknown` on purpose: Zod parses across the boundary.
 */
export type OpenRouterLike = {
  chat: {
    send(
      request: { chatRequest: ChatRequestSubset },
      options?: {
        retries?: { strategy: "backoff" | "none" }
        signal?: AbortSignal
      },
    ): Promise<unknown>
  }
  generations?: {
    getGeneration(
      request: { id: string },
      options?: {
        retries?: { strategy: "backoff" | "none" }
        signal?: AbortSignal
      },
    ): Promise<unknown>
  }
}

export type OpenRouterClient = {
  requestReview: (params: {
    systemPrompt: string
    userPrompt: string
    model: string
    fallbackModel: string | null
  }) => Promise<StructuredReviewResult>
}

const chatResultSchema = z.object({
  id: z.string(),
  model: z.string(),
  choices: z.array(z.object({ message: z.object({ content: z.unknown() }) })),
  usage: z
    .object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      cost: z.number().nullable().optional(),
    })
    .optional(),
})

const generationResponseSchema = z.object({
  data: z.object({ totalCost: z.number() }),
})

/** Auth/credit failures abort the ladder — the fallback model shares the key. */
const ABORT_STATUSES = new Set([401, 402, 403])

/** The transient 4xx statuses — HTTP request timeout (408) and rate limit
 *  (429). attemptOnce also marks 5xx and status-less network errors
 *  retryable, and a context-overflow 400 retries with a smaller output
 *  ceiling; any other 4xx is structural and skips the retry. */
const RETRYABLE_4XX_STATUSES = new Set([408, 429])

/** Cap on same-model attempts for failures that settle quickly (HTTP errors,
 *  validation failures), for context-overflow retries with a fitted output
 *  ceiling, and for timeouts on the last ladder model. A timeout with a
 *  fallback still available advances the ladder instead of retrying. */
const MAX_ATTEMPTS_PER_MODEL = 2

/** Fixed delay before a same-model retry. The SDK's backoff is disabled
 *  (`retries: { strategy: "none" }`); this replaces it so a brief
 *  rate-limit burst has a recovery window. */
const RETRY_DELAY_MS = 1_000

/** The output ceiling, sent as the request's `maxCompletionTokens`, for every
 *  attempt except a context-overflow retry. Without one, some providers apply
 *  a default output limit that cuts a large review off mid-JSON. */
const MAX_COMPLETION_TOKENS = 128_000

/** OpenRouter's 400 when the prompt plus the output ceiling exceeds the routed
 *  endpoint's context window, e.g. "This endpoint's maximum context length is
 *  262144 tokens. However, you requested about 263762 tokens (135762 of text
 *  input, 128000 in the output)". A model's endpoints differ in window size,
 *  and routing does not check the prompt against it. */
const CONTEXT_OVERFLOW_PATTERN =
  /maximum context length is (?<contextLength>\d+) tokens\. However, you requested about \d+ tokens \((?<inputTokens>\d+) of text input/

/** Headroom below the endpoint's window, because the error's input count is
 *  OpenRouter's estimate ("about"), not the provider tokenizer's count. */
const CONTEXT_FIT_MARGIN_TOKENS = 8_192

/** Smallest fitted ceiling worth a same-model retry. Reviews often spend tens
 *  of thousands of output tokens, reasoning included, so a smaller ceiling
 *  would cut many off mid-JSON and still bill the full prompt. Below it, the
 *  400 fails like any other structural 4xx. */
const MIN_FITTED_MAX_COMPLETION_TOKENS = 32_768

/** OpenRouter SDK errors carry a numeric `statusCode` — duck-typed so stubs
 *  and future SDK versions need no instanceof on SDK internals. */
const errorStatusCode = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  if (!("statusCode" in error) || typeof error.statusCode !== "number") {
    return undefined
  }
  return error.statusCode
}

/** The largest output ceiling that fits the endpoint a context-overflow error
 *  names, or null when the error is something else or no usable smaller
 *  ceiling fits. */
const fittedMaxCompletionTokens = ({
  error,
  rejectedMaxCompletionTokens,
}: {
  error: unknown
  rejectedMaxCompletionTokens: number
}): number | null => {
  if (errorStatusCode(error) !== 400 || !(error instanceof Error)) return null

  const overflowGroups = CONTEXT_OVERFLOW_PATTERN.exec(error.message)?.groups
  const contextLength = overflowGroups?.contextLength
  const inputTokens = overflowGroups?.inputTokens

  if (!contextLength || !inputTokens) return null

  const fittedCeiling = Number(contextLength) - Number(inputTokens) - CONTEXT_FIT_MARGIN_TOKENS

  // The endpoint leaves too little room for a review to finish its JSON
  if (fittedCeiling < MIN_FITTED_MAX_COMPLETION_TOKENS) return null

  // The estimated input plus the rejected ceiling already fit the window, so
  // that ceiling did not cause this 400 and lowering it cannot fix it
  if (fittedCeiling >= rejectedMaxCompletionTokens) return null

  return fittedCeiling
}

/** Caps the message at 200 characters because provider error bodies can run
 *  long and the ladder's final error joins every attempt's summary into one line. */
const summarizeError = (error: unknown): string => {
  const maxSummaryLength = 200
  const message = error instanceof Error ? error.message : String(error)
  return message.length > maxSummaryLength ? `${message.slice(0, maxSummaryLength)}…` : message
}

/** How the SDK call itself ended. */
type SettledResult<T> = { status: "resolved"; value: T } | { status: "rejected"; error: unknown }

/** A settled call, or the deadline winning before it settled. */
type BoundedResult<T> = SettledResult<T> | { status: "timed_out" }

/** Converts a throwing promise into a discriminated result — avoids
 *  try/catch nesting at every SDK call site. */
const toResult = async <T>(promise: Promise<T>): Promise<SettledResult<T>> => {
  try {
    const value = await promise
    return { status: "resolved", value }
  } catch (error) {
    return { status: "rejected", error }
  }
}

/** Real cause chains are two deep at most; capped at 5 as a generous
 *  margin so a cyclic `cause` cannot recurse forever. */
const MAX_CAUSE_DEPTH = 5

/** An honoured AbortSignal rejects with an error named "AbortError"; the
 *  SDK wraps it in its own error with the AbortError as `cause`. Duck-typed
 *  down the cause chain, like errorStatusCode, so stubs need no SDK internals. */
const isAbortError = (error: unknown, depth = 0): boolean => {
  if (depth > MAX_CAUSE_DEPTH) return false
  if (typeof error !== "object" || error === null) return false
  if ("name" in error && error.name === "AbortError") return true
  return "cause" in error && isAbortError(error.cause, depth + 1)
}

type LateSettlement = "response" | "abort_error" | "error"

const describeLateSettlement = <T>(late: SettledResult<T>): LateSettlement => {
  if (late.status === "resolved") return "response"
  if (isAbortError(late.error)) return "abort_error"
  return "error"
}

/** Bounds an SDK call with an authoritative deadline:
 *  - Resolve the deadline before aborting so it wins deterministically.
 *  - Return at the deadline even when the SDK ignores the abort.
 *  - Observe the abandoned call and log how it eventually settles. */
const withDeadline = async <T>(
  {
    start,
    timeoutMs,
    logContext,
  }: {
    start: (signal: AbortSignal) => Promise<T>
    timeoutMs: number
    logContext: Record<string, unknown>
  },
  logger: Logger,
): Promise<BoundedResult<T>> => {
  const controller = new AbortController()
  const startedAt = DateTime.now()

  // Promise.try settles a synchronous throw from start as a rejection, and
  // toResult wraps it before the race so a late rejection never goes unhandled
  const settled = toResult(Promise.try(start, controller.signal))
  const deadline = Promise.withResolvers<BoundedResult<T>>()

  // timeoutMs can be fractional because the review deadline is measured with
  // performance.now(); rounding up keeps the timer from firing early
  const timer = setTimeout(() => {
    // Resolve before aborting so the race winner never depends on
    // microtask ordering between the deadline and an honoured abort
    deadline.resolve({ status: "timed_out" })
    controller.abort()
  }, Math.ceil(timeoutMs))

  const bounded = await Promise.race([settled, deadline.promise]).finally(() => {
    clearTimeout(timer)
  })

  if (bounded.status !== "timed_out") return bounded

  logger.warn("request deadline elapsed", { ...logContext, timeoutMs })

  const logLateSettlement = (late: SettledResult<T>): void => {
    logger.warn("deadline-elapsed request settled", {
      ...logContext,
      elapsedMs: DateTime.now().diff(startedAt).toMillis(),
      timeoutMs,
      settledWith: describeLateSettlement(late),
      ...(late.status === "rejected" ? { error: summarizeError(late.error) } : {}),
    })
  }

  // Observed, not awaited: the deadline has already been reported and the
  // caller must move on; only the eventual settlement is of interest
  void settled.then(logLateSettlement)
  return bounded
}

/** Wraps the parsed value so a JSON `null` is distinguishable from a parse failure. */
const parseJsonOrNull = (text: string): { parsed: unknown } | null => {
  try {
    const parsed: unknown = JSON.parse(text)
    return { parsed }
  } catch {
    return null
  }
}

const buildChatRequest = ({
  systemPrompt,
  userPrompt,
  model,
  maxCompletionTokens,
}: {
  systemPrompt: string
  userPrompt: string
  model: string
  maxCompletionTokens: number
}): ChatRequestSubset => ({
  model,
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ],
  maxCompletionTokens,
  responseFormat: {
    type: "json_schema",
    jsonSchema: {
      name: "review_response",
      strict: true,
      schema: reviewResponseJsonSchema,
    },
  },
  stream: false,
})

type SingleAttempt =
  | {
      kind: "accepted"
      review: ReviewResponse
      routedModel: string
      generationId: string
      attempt: ModelAttempt
    }
  | {
      kind: "failed"
      attempt: ModelAttempt
      retryable: boolean
      abort: boolean
    }
  | {
      kind: "context_overflow"
      attempt: ModelAttempt
      fittedMaxCompletionTokens: number
    }

/** Thrown when the model ladder ends without an accepted review; retains every
 *  attempt, failed ones included. */
export class ReviewRequestError extends Error {
  readonly attempts: ModelAttempt[]
  /** An auth or credit error (401/402/403) stopped the ladder. The key fails
   *  for every model, so callers skip the remaining work. Unrelated to the
   *  AbortSignal that cancels a single HTTP call. */
  readonly aborted: boolean
  /** The review deadline ran out. That deadline is the whole run's time
   *  budget, which `remainingReviewMs` counts down. */
  readonly deadlineExceeded: boolean

  constructor({
    message,
    attempts,
    aborted,
    deadlineExceeded = false,
  }: {
    message: string
    attempts: ModelAttempt[]
    aborted: boolean
    deadlineExceeded?: boolean
  }) {
    super(message)
    this.name = "ReviewRequestError"
    this.attempts = attempts
    this.aborted = aborted
    this.deadlineExceeded = deadlineExceeded
  }
}

const describeAttempt = (attempt: ModelAttempt): string => {
  const errorSuffix = attempt.errorSummary === null ? "" : ` (${attempt.errorSummary})`
  return `${attempt.model}: ${attempt.outcome}${errorSuffix}`
}

const summarizeAttempts = (attempts: ModelAttempt[]): string => {
  return attempts.map(describeAttempt).join("; ")
}

export const createOpenRouterClient = (
  {
    sdk,
    requestTimeoutMs,
    remainingReviewMs,
    retryDelayMs = RETRY_DELAY_MS,
  }: {
    sdk: OpenRouterLike
    /** Per-attempt deadline. When it elapses the attempt records outcome
     *  `timeout` and the ladder moves on — to the next model when one
     *  exists, otherwise a same-model retry while attempts remain — whether
     *  or not the provider connection closes. The HTTP call is aborted
     *  best-effort. */
    requestTimeoutMs: number
    /** Milliseconds left in the whole review's time budget; 0 or less once
     *  it has run out. Caps every attempt, cost lookup, and retry delay. */
    remainingReviewMs: () => number
    retryDelayMs?: number
  },
  logger: Logger,
): OpenRouterClient => {
  const requestTimeoutSummary = `no response within ${Math.round(requestTimeoutMs / 1000)}s`

  const attemptOnce = async (chatRequest: ChatRequestSubset): Promise<SingleAttempt> => {
    const { model } = chatRequest
    const remainingMs = remainingReviewMs()

    // The review deadline, not the per-attempt timeout, ends this attempt
    // if it runs long
    const reviewDeadlineIsBinding = remainingMs <= requestTimeoutMs

    const sendResult = await withDeadline(
      {
        start: (signal) => {
          return sdk.chat.send({ chatRequest }, { retries: { strategy: "none" }, signal })
        },
        timeoutMs: Math.min(requestTimeoutMs, remainingMs),
        logContext: { operation: "chat request", model },
      },
      logger,
    )

    // Retryable even when the review deadline caused the timeout, because
    // requestReview checks the deadline before any retry and throws there
    if (sendResult.status === "timed_out") {
      return {
        kind: "failed",
        attempt: {
          model,
          outcome: "timeout",
          promptTokens: null,
          completionTokens: null,
          costUsd: null,
          errorSummary: reviewDeadlineIsBinding
            ? "review deadline exceeded"
            : requestTimeoutSummary,
        },
        retryable: true,
        abort: false,
      }
    }
    if (sendResult.status === "rejected") {
      const statusCode = errorStatusCode(sendResult.error)

      // A context overflow is still recorded as api_error because the attempt
      // did fail with an HTTP error; the context_overflow kind only steers the retry
      const attempt: ModelAttempt = {
        model,
        outcome: "api_error",
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        errorSummary: statusCode
          ? `HTTP ${statusCode}: ${summarizeError(sendResult.error)}`
          : summarizeError(sendResult.error),
      }
      const fittedCeiling = fittedMaxCompletionTokens({
        error: sendResult.error,
        rejectedMaxCompletionTokens: chatRequest.maxCompletionTokens,
      })

      if (fittedCeiling) {
        return { kind: "context_overflow", attempt, fittedMaxCompletionTokens: fittedCeiling }
      }

      const abort = statusCode ? ABORT_STATUSES.has(statusCode) : false

      // An unknown status, a 5xx, a 408, or a 429 is transient and retries;
      // any other 4xx, such as a 400 bad request or a 401/402/403 abort
      // status, is structural and does not
      const retryable = !statusCode || statusCode >= 500 || RETRYABLE_4XX_STATUSES.has(statusCode)

      return { kind: "failed", attempt, retryable, abort }
    }

    const parsedResult = chatResultSchema.safeParse(sendResult.value)

    // A malformed response body points at a provider or gateway glitch rather
    // than the request, so a second call can come back well-formed
    if (!parsedResult.success) {
      return {
        kind: "failed",
        attempt: {
          model,
          outcome: "api_error",
          promptTokens: null,
          completionTokens: null,
          costUsd: null,
          errorSummary: "unexpected chat response shape",
        },
        retryable: true,
        abort: false,
      }
    }

    const chatResult = parsedResult.data

    // Failed-validation attempts still carry usage — they were billed too
    const usage = {
      promptTokens: chatResult.usage?.promptTokens ?? null,
      completionTokens: chatResult.usage?.completionTokens ?? null,
      costUsd: chatResult.usage?.cost ?? null,
    }
    const failedValidation = (outcome: AttemptOutcome, errorSummary: string): SingleAttempt => ({
      kind: "failed",
      attempt: { model, outcome, ...usage, errorSummary },
      retryable: true,
      abort: false,
    })

    const content = chatResult.choices[0]?.message.content

    if (typeof content !== "string" || content === "") {
      return failedValidation("empty_content", "response had no text content")
    }

    const parsedContent = parseJsonOrNull(content)

    if (parsedContent === null) {
      return failedValidation("invalid_json", "response content is not valid JSON")
    }

    const parsedReview = reviewResponseSchema.safeParse(parsedContent.parsed)

    if (!parsedReview.success) {
      const firstIssue = parsedReview.error.issues[0]
      return failedValidation(
        "schema_mismatch",
        firstIssue
          ? `schema mismatch at ${firstIssue.path.join(".")}: ${firstIssue.message}`
          : "response JSON does not match the review schema",
      )
    }

    return {
      kind: "accepted",
      review: parsedReview.data,
      routedModel: chatResult.model,
      generationId: chatResult.id,
      attempt: { model, outcome: "accepted", ...usage, errorSummary: null },
    }
  }

  /** A cost lookup failure must never fail a completed review, so every
   *  failure degrades to a null cost. */
  const lookupGenerationCost = async (generationId: string): Promise<number | null> => {
    const generations = sdk.generations
    const remainingMs = remainingReviewMs()

    if (!generations || remainingMs <= 0) return null

    // The review deadline, not the per-request timeout, ends the lookup if it
    // runs long
    const reviewDeadlineIsBinding = remainingMs <= requestTimeoutMs

    const lookup = await withDeadline(
      {
        start: (signal) => {
          return generations.getGeneration(
            { id: generationId },
            { retries: { strategy: "none" }, signal },
          )
        },
        timeoutMs: Math.min(requestTimeoutMs, remainingMs),
        logContext: { operation: "generation cost lookup", generationId },
      },
      logger,
    )

    if (lookup.status === "timed_out") {
      logger.warn("generation cost lookup failed", {
        error: reviewDeadlineIsBinding ? "review deadline exceeded" : requestTimeoutSummary,
      })
      return null
    }
    if (lookup.status === "rejected") {
      logger.warn("generation cost lookup failed", {
        error: summarizeError(lookup.error),
      })
      return null
    }

    const parsed = generationResponseSchema.safeParse(lookup.value)

    if (!parsed.success) {
      logger.warn("unexpected generation response shape")
      return null
    }

    // parsed.data = Zod safeParse result; .data = API envelope's data property
    return parsed.data.data.totalCost
  }

  const requestReview = async ({
    systemPrompt,
    userPrompt,
    model,
    fallbackModel,
  }: {
    systemPrompt: string
    userPrompt: string
    model: string
    fallbackModel: string | null
  }): Promise<StructuredReviewResult> => {
    const modelLadder = fallbackModel === null ? [model] : [model, fallbackModel]
    const attempts: ModelAttempt[] = []
    const ensureReviewTimeRemaining = (): void => {
      if (remainingReviewMs() > 0) return
      throw new ReviewRequestError({
        message: "review deadline exceeded",
        attempts,
        aborted: false,
        deadlineExceeded: true,
      })
    }

    for (const [ladderIndex, ladderModel] of modelLadder.entries()) {
      const nextLadderModel = modelLadder[ladderIndex + 1]

      // Reassigned across attempts, like attemptNumber. Each model starts at
      // the full ceiling because that model's endpoints decide what fits, so
      // a context overflow lowers it only for the same model's retry
      let maxCompletionTokens = MAX_COMPLETION_TOKENS
      let attemptNumber = 1
      while (attemptNumber <= MAX_ATTEMPTS_PER_MODEL) {
        ensureReviewTimeRemaining()
        const attemptResult = await attemptOnce(
          buildChatRequest({ systemPrompt, userPrompt, model: ladderModel, maxCompletionTokens }),
        )

        if (attemptResult.kind === "accepted") {
          // The generation lookup runs only when the response's usage omits the cost
          const costUsd =
            attemptResult.attempt.costUsd ??
            (await lookupGenerationCost(attemptResult.generationId))
          attempts.push({ ...attemptResult.attempt, costUsd })
          logger.info("review response accepted", {
            model: ladderModel,
            routedModel: attemptResult.routedModel,
            generationId: attemptResult.generationId,
            attemptCount: attempts.length,
          })
          return {
            review: attemptResult.review,
            modelUsed: attemptResult.routedModel,
            attempts,
          }
        }

        attempts.push(attemptResult.attempt)
        logger.warn("review attempt failed", {
          model: ladderModel,
          attemptNumber,
          outcome: attemptResult.attempt.outcome,
          errorSummary: attemptResult.attempt.errorSummary,
        })

        if (attemptResult.kind === "failed" && attemptResult.abort) {
          throw new ReviewRequestError({
            message: `OpenRouter auth/credit error — aborting without fallback: ${summarizeAttempts(attempts)}`,
            attempts,
            aborted: true,
          })
        }

        // Checked again after the failure so a spent deadline ends the ladder
        // with the deadline error, never the generic ladder-exhausted error below
        ensureReviewTimeRemaining()

        // A timeout consumed a full deadline window and signals live provider
        // degradation. Retrying the same model would double the wait before
        // the fallback runs — past a typical workflow job timeout — so the
        // break skips the retry and its delay and the outer loop moves to the
        // next model. A last-rung timeout still retries because no other
        // model remains.
        if (attemptResult.attempt.outcome === "timeout" && nextLadderModel) {
          logger.info("advancing to fallback model without same-model retry", {
            from: ladderModel,
            to: nextLadderModel,
          })
          break
        }
        if (attemptResult.kind === "failed" && !attemptResult.retryable) break

        attemptNumber++
        const retryRemains = attemptNumber <= MAX_ATTEMPTS_PER_MODEL

        // An overflow on the model's last attempt has no retry left to use the
        // fitted ceiling, so the loop ends and any next model starts at the
        // full ceiling
        if (retryRemains && attemptResult.kind === "context_overflow") {
          maxCompletionTokens = attemptResult.fittedMaxCompletionTokens
          logger.info("retrying with an output ceiling that fits the endpoint's context window", {
            model: ladderModel,
            maxCompletionTokens,
          })
        }

        // The delay shrinks to the time left so it never outlasts the review
        // deadline; ensureReviewTimeRemaining above confirmed some time is left
        if (retryRemains && retryDelayMs > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, Math.ceil(Math.min(retryDelayMs, remainingReviewMs())))
          })
        }
      }
    }

    throw new ReviewRequestError({
      message: `review request failed after ${attempts.length} attempt(s): ${summarizeAttempts(attempts)}`,
      attempts,
      aborted: false,
    })
  }

  return { requestReview }
}
