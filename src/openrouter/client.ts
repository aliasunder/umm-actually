import { z } from "zod"
import type { Logger } from "../logger.js"
import {
  reviewResponseJsonSchema,
  reviewResponseSchema,
  type ReviewResponse,
} from "../review/finding.js"

export type AttemptOutcome =
  | "accepted"
  | "api_error"
  | "empty_content"
  | "invalid_json"
  | "schema_mismatch"

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
      options?: { timeoutMs?: number; retries?: { strategy: string } },
    ): Promise<unknown>
  }
  generations?: {
    getGeneration(
      request: { id: string },
      options?: { timeoutMs?: number; retries?: { strategy: string } },
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

/** Transient by nature: timeout, rate limit. 5xx and status-less network
 *  errors are retryable too; any other 4xx is structural and skips the retry. */
const RETRYABLE_STATUSES = new Set([408, 429])

const MAX_ATTEMPTS_PER_MODEL = 2

/** OpenRouter SDK errors carry a numeric `statusCode` — duck-typed so stubs
 *  and future SDK versions need no instanceof on SDK internals. */
const errorStatusCode = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  if (!("statusCode" in error) || typeof error.statusCode !== "number") {
    return undefined
  }
  return error.statusCode
}

const summarizeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 200 ? `${message.slice(0, 200)}…` : message
}

/** Converts a throwing promise into a discriminated result — avoids
 *  try/catch nesting at every SDK call site. */
const toResult = async <T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
  try {
    const value = await promise
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error }
  }
}

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
}: {
  systemPrompt: string
  userPrompt: string
  model: string
}): ChatRequestSubset => ({
  model,
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ],
  // High ceiling — providers clamp to each model's actual max output
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

const describeAttempt = (attempt: ModelAttempt): string => {
  const errorSuffix =
    attempt.errorSummary === null ? "" : ` (${attempt.errorSummary})`
  return `${attempt.model}: ${attempt.outcome}${errorSuffix}`
}

const summarizeAttempts = (attempts: ModelAttempt[]): string =>
  attempts.map(describeAttempt).join("; ")

export const createOpenRouterClient = (
  {
    sdk,
    requestTimeoutMs,
  }: {
    sdk: OpenRouterLike
    /** Per-attempt cap — a timed-out request aborts as a status-less
     *  (retryable) api_error and flows into the retry/fallback ladder,
     *  instead of hanging the job until the runner's 6-hour kill. */
    requestTimeoutMs: number
  },
  logger: Logger,
): OpenRouterClient => {
  const attemptOnce = async ({
    chatRequest,
    model,
  }: {
    chatRequest: ChatRequestSubset
    model: string
  }): Promise<SingleAttempt> => {
    const sendResult = await toResult(
      sdk.chat.send(
        { chatRequest },
        { timeoutMs: requestTimeoutMs, retries: { strategy: "none" } },
      ),
    )
    if (!sendResult.ok) {
      const statusCode = errorStatusCode(sendResult.error)
      const abort = statusCode !== undefined && ABORT_STATUSES.has(statusCode)
      const retryable =
        statusCode === undefined ||
        statusCode >= 500 ||
        RETRYABLE_STATUSES.has(statusCode)
      return {
        kind: "failed",
        attempt: {
          model,
          outcome: "api_error",
          promptTokens: null,
          completionTokens: null,
          costUsd: null,
          errorSummary:
            statusCode === undefined
              ? summarizeError(sendResult.error)
              : `HTTP ${statusCode}: ${summarizeError(sendResult.error)}`,
        },
        retryable: abort ? false : retryable,
        abort,
      }
    }

    const parsedResult = chatResultSchema.safeParse(sendResult.value)
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
    const failedValidation = (
      outcome: AttemptOutcome,
      errorSummary: string,
    ): SingleAttempt => ({
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
      return failedValidation(
        "invalid_json",
        "response content is not valid JSON",
      )
    }

    const parsedReview = reviewResponseSchema.safeParse(parsedContent.parsed)
    if (!parsedReview.success) {
      const firstIssue = parsedReview.error.issues[0]
      return failedValidation(
        "schema_mismatch",
        firstIssue === undefined
          ? "response JSON does not match the review schema"
          : `schema mismatch at ${firstIssue.path.join(".")}: ${firstIssue.message}`,
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

  /** Best-effort: a cost lookup failure must never fail a completed review. */
  const lookupGenerationCost = async (
    generationId: string,
  ): Promise<number | null> => {
    if (sdk.generations === undefined) return null
    const lookup = await toResult(
      sdk.generations.getGeneration(
        { id: generationId },
        { timeoutMs: requestTimeoutMs, retries: { strategy: "none" } },
      ),
    )
    if (!lookup.ok) {
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
    const modelLadder =
      fallbackModel === null ? [model] : [model, fallbackModel]
    const attempts: ModelAttempt[] = []

    for (const ladderModel of modelLadder) {
      const chatRequest = buildChatRequest({
        systemPrompt,
        userPrompt,
        model: ladderModel,
      })

      let attemptNumber = 1
      while (attemptNumber <= MAX_ATTEMPTS_PER_MODEL) {
        const attemptResult = await attemptOnce({
          chatRequest,
          model: ladderModel,
        })

        if (attemptResult.kind === "accepted") {
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
        if (attemptResult.abort) {
          throw new Error(
            `OpenRouter auth/credit error — aborting without fallback: ${summarizeAttempts(attempts)}`,
          )
        }
        if (!attemptResult.retryable) break
        attemptNumber++
      }
    }

    throw new Error(
      `review request failed after ${attempts.length} attempt(s): ${summarizeAttempts(attempts)}`,
    )
  }

  return { requestReview }
}
