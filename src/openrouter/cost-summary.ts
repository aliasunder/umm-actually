import type { ModelAttempt } from "./client.js"

/** An attempt tagged with the review phase that made it. */
export type PhaseAttempt = ModelAttempt & { phase: string }

const formatCost = (costUsd: number | null): string =>
  costUsd === null ? "n/a" : `$${costUsd.toFixed(6)}`

const formatTokens = (tokens: number | null): string =>
  tokens === null ? "n/a" : String(tokens)

/** Markdown table for the workflow job summary — one row per attempt across
 *  every phase, failed ones included (any attempt that reached the provider
 *  was billed). */
export const renderCostSummary = ({
  attempts,
  modelUsed,
}: {
  attempts: PhaseAttempt[]
  modelUsed: string
}): string => {
  const rows = attempts.map(
    (attempt, attemptIndex) =>
      `| ${attemptIndex + 1} | ${attempt.phase} | ${attempt.model} | ${attempt.outcome} | ${formatTokens(attempt.promptTokens)} | ${formatTokens(attempt.completionTokens)} | ${formatCost(attempt.costUsd)} |`,
  )

  const knownCosts = attempts.flatMap((attempt) =>
    attempt.costUsd === null ? [] : [attempt.costUsd],
  )
  const totalCost = knownCosts.reduce((sum, costUsd) => sum + costUsd, 0)
  const unpricedSuffix =
    knownCosts.length < attempts.length ? " (some attempts unpriced)" : ""
  const totalLine =
    knownCosts.length === 0
      ? "Total cost: n/a"
      : `Total cost: ${formatCost(totalCost)}${unpricedSuffix}`

  return [
    "### umm-actually cost summary",
    "",
    `Model used: ${modelUsed}`,
    "",
    "| attempt | phase | model | outcome | prompt tokens | completion tokens | cost |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    totalLine,
  ].join("\n")
}
