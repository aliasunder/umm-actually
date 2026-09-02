import { describeError, type Logger } from "../logger.js"
import type { StructuredReviewResult } from "../openrouter/client.js"
import type { Finding } from "./finding.js"
import type { ReviewPhase, ReviewStage } from "./phases.js"

export type PhaseOutcome =
  | { phase: ReviewPhase; status: "completed"; result: StructuredReviewResult }
  | { phase: ReviewPhase; status: "failed"; error: unknown }

export type RunPhase = (params: {
  phase: ReviewPhase
  priorFindings: Finding[]
}) => Promise<StructuredReviewResult>

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

const completedFindings = (outcomes: PhaseOutcome[]): Finding[] => {
  return outcomes.flatMap((outcome) => {
    return outcome.status === "completed" ? outcome.result.review.findings : []
  })
}

/**
 * Runs each stage's phases concurrently and the stages in order, passing
 * every earlier stage's raw findings to the next stage as prior findings.
 * Outcomes come back in stage-then-phase order regardless of completion
 * order. Throws only when no phase completed: one failure is rethrown as-is,
 * several are aggregated into one message.
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

  const failures = outcomes.filter((outcome) => outcome.status === "failed")
  if (failures.length < outcomes.length) return outcomes
  if (failures.length === 1 && failures[0]) throw failures[0].error
  throw new Error(
    `all ${failures.length} review phases failed: ${failures
      .map((failure) => `${failure.phase.id}: ${describeError(failure.error)}`)
      .join("; ")}`,
  )
}
