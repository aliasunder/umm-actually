/**
 * Dispatch stack for phased reviews:
 *
 *   runStages        — loops over stages in order, threading prior findings
 *     └ runStage     — fires one stage's phases concurrently via Promise.all
 *         └ runPhase — caller-provided: one model call for one phase
 *
 * A stage is a group of phases that run at the same time. In `parallel`
 * mode there is one stage with all three phases; in `sequential` mode
 * there are three stages with one phase each (see phases.ts for the
 * layout table).
 */
import { describeError, type Logger } from "../logger.js"
import type { StructuredReviewResult } from "../openrouter/client.js"
import { filterNonFindings } from "./filter-non-findings.js"
import type { Finding } from "./finding.js"
import type { ReviewPhase, ReviewStage } from "./phases.js"

export type PhaseOutcome =
  | { phase: ReviewPhase; status: "completed"; result: StructuredReviewResult }
  | { phase: ReviewPhase; status: "failed"; error: unknown }

export type RunPhase = (params: {
  phase: ReviewPhase
  priorFindings: Finding[]
}) => Promise<StructuredReviewResult>

const describeFailure = (outcome: PhaseOutcome): string => {
  return outcome.status === "failed"
    ? `${outcome.phase.id}: ${describeError(outcome.error)}`
    : `${outcome.phase.id}: completed`
}

/** Thrown when no phase completed. `outcomes` keeps every phase's error so
 *  the caller can still account for the attempts the failed phases billed. */
export class AllPhasesFailedError extends Error {
  readonly outcomes: PhaseOutcome[]

  constructor(outcomes: PhaseOutcome[]) {
    super(
      `every review phase failed: ${outcomes.map(describeFailure).join("; ")}`,
    )
    this.name = "AllPhasesFailedError"
    this.outcomes = outcomes
  }
}

/** The client marks an auth/credit failure as aborted: the key is bad for
 *  every model, so no later stage can succeed either. */
const isAbortedRequest = (error: unknown): boolean => {
  return (
    typeof error === "object" &&
    error !== null &&
    "aborted" in error &&
    error.aborted === true
  )
}

/** Fires one stage's phases concurrently. Each phase is tried
 *  independently — a failed phase does not cancel its siblings. */
const runStage = async (
  {
    stage,
    priorFindings,
    runPhase,
  }: {
    stage: ReviewStage
    priorFindings: Finding[]
    runPhase: RunPhase
  },
  logger: Logger,
): Promise<PhaseOutcome[]> => {
  return Promise.all(
    stage.map(async (phase): Promise<PhaseOutcome> => {
      try {
        const result = await runPhase({ phase, priorFindings })
        logger.info("review phase completed", {
          phase: phase.id,
          modelUsed: result.modelUsed,
          attemptCount: result.attempts.length,
          findingsCount: result.review.findings.length,
        })
        return { phase, status: "completed", result }
      } catch (error) {
        logger.warn("review phase failed", {
          phase: phase.id,
          error: describeError(error),
        })
        return { phase, status: "failed", error }
      }
    }),
  )
}

const notAttempted = (phase: ReviewPhase): PhaseOutcome => {
  return {
    phase,
    status: "failed",
    error: new Error(
      "not attempted: an earlier phase aborted on an auth/credit error",
    ),
  }
}

/** Non-findings are dropped before threading: a "no bug here" entry in the
 *  prior-findings list could otherwise stop a later phase from reporting the
 *  real defect at that location. */
const completedFindings = (outcomes: PhaseOutcome[]): Finding[] => {
  const rawFindings = outcomes.flatMap((outcome) => {
    return outcome.status === "completed" ? outcome.result.review.findings : []
  })
  return filterNonFindings(rawFindings).findings
}

/**
 * Runs each stage's phases concurrently and the stages in order, passing
 * every earlier stage's findings (non-findings removed) to the next stage as
 * prior findings.
 * Outcomes come back in stage-then-phase order regardless of completion
 * order. Throws AllPhasesFailedError only when no phase completed.
 */
export const runStages = async (
  { stages, runPhase }: { stages: ReviewStage[]; runPhase: RunPhase },
  logger: Logger,
): Promise<PhaseOutcome[]> => {
  if (stages.length === 0 || stages.some((stage) => stage.length === 0)) {
    throw new Error("no review phases to run")
  }

  // Loop-threaded: each stage appends its outcomes, and the next stage's
  // prior findings are read from everything completed so far.
  let outcomes: PhaseOutcome[] = []
  for (const [stageIndex, stage] of stages.entries()) {
    const stageOutcomes = await runStage(
      { stage, priorFindings: completedFindings(outcomes), runPhase },
      logger,
    )
    outcomes = [...outcomes, ...stageOutcomes]

    const aborted = stageOutcomes.some(
      (outcome) =>
        outcome.status === "failed" && isAbortedRequest(outcome.error),
    )
    const remainingStages = stages.slice(stageIndex + 1)
    if (aborted && remainingStages.length > 0) {
      const skippedPhases = remainingStages.flat()
      logger.warn(
        "skipping remaining review stages after an auth/credit abort",
        {
          skippedPhases: skippedPhases.map((phase) => phase.id),
        },
      )
      outcomes = [...outcomes, ...skippedPhases.map(notAttempted)]
      break
    }
  }

  const anyCompleted = outcomes.some(
    (outcome) => outcome.status === "completed",
  )
  if (anyCompleted) return outcomes
  throw new AllPhasesFailedError(outcomes)
}
