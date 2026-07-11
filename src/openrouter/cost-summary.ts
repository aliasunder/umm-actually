import type { ModelAttempt } from "./client.js"

const formatCost = (costUsd: number | null): string =>
  costUsd === null ? "n/a" : `$${costUsd.toFixed(6)}`

const formatTokens = (tokens: number | null): string =>
  tokens === null ? "n/a" : String(tokens)

/** Markdown table for the workflow job summary — one row per billed attempt. */
export const renderCostSummary = ({
  attempts,
  modelUsed,
}: {
  attempts: ModelAttempt[]
  modelUsed: string
}): string => {
  const rows = attempts.map(
    (attempt, attemptIndex) =>
      `| ${attemptIndex + 1} | ${attempt.model} | ${attempt.outcome} | ${formatTokens(attempt.promptTokens)} | ${formatTokens(attempt.completionTokens)} | ${formatCost(attempt.costUsd)} |`,
  )

  const knownCosts = attempts.flatMap((attempt) =>
    attempt.costUsd === null ? [] : [attempt.costUsd],
  )
  const totalCost = knownCosts.reduce((sum, costUsd) => sum + costUsd, 0)
  const totalLine =
    knownCosts.length === 0
      ? "Total cost: n/a"
      : `Total cost: ${formatCost(totalCost)}${
          knownCosts.length < attempts.length ? " (some attempts unpriced)" : ""
        }`

  return [
    "### umm-actually cost summary",
    "",
    `Model used: ${modelUsed}`,
    "",
    "| attempt | model | outcome | prompt tokens | completion tokens | cost |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    totalLine,
  ].join("\n")
}
