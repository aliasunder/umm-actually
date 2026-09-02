import type { PrContext } from "../github/event.js"

export type ReviewSummaryStats = {
  prContext: PrContext
  conventionsFile: string | null
  phasesCompleted: string[]
  /** Phases that ended without an accepted response — their findings are absent. */
  phasesIncomplete: string[]
  changedFilePaths: string[]
  relatedFilePaths: string[]
  relatedFilesExcludedPaths: string[]
  priorityDocPaths: string[]
  /** Priority docs whose full text another channel already carried. */
  priorityDocsInContextPaths: string[]
  /** Priority docs the model never received — missing, unreadable, or over budget. */
  priorityDocsAbsentPaths: string[]
  mentionMatchedDocPaths: string[]
  docsExcludedPaths: string[]
  tokenBudgetTotal: number
  tokenBudgetUsedByDiff: number
  tokenBudgetPriorityDocFloor: number
  tokenBudgetRemainingForDocs: number
  totalFromModel: number
  droppedAsNonFinding: number
  /** Findings naming a file the model was never given. */
  droppedAsUnknownFile: number
  /** Findings two phases reported on overlapping lines of one file. */
  duplicatesAcrossPhases: number
  duplicatesRemoved: number
  droppedBelowThreshold: number
  droppedAsOverlapping: number
  droppedByCap: number
  posted: number
}

/** Formats paths for a markdown table cell — em-dash when empty so cells
 *  are never blank. Pipes are escaped so paths can't break the table. */
const renderPaths = (paths: string[]): string =>
  paths.length === 0
    ? "—"
    : paths.map((path) => path.replaceAll("|", "\\|")).join(", ")

/** Markdown summary for the workflow job summary — renders a context
 *  table showing what the model saw (and which priority docs it did not),
 *  the token budget split, and a pipeline table showing what happened to
 *  each finding. */
export const renderReviewSummary = (stats: ReviewSummaryStats): string => {
  const sha = stats.prContext.headSha.slice(0, 7)
  const incompleteClause =
    stats.phasesIncomplete.length === 0
      ? ""
      : ` · incomplete: ${stats.phasesIncomplete.join(", ")}`

  return [
    "### umm-actually review summary",
    "",
    `PR #${stats.prContext.prNumber} · \`${stats.prContext.headRef}\` → \`${stats.prContext.baseRef}\` · \`${sha}\``,
    "",
    `**Instructions:** ${stats.conventionsFile ?? "none"}`,
    "",
    `**Phases:** ${renderPaths(stats.phasesCompleted)}${incompleteClause}`,
    "",
    "#### Context",
    "",
    "| type | count | paths |",
    "| --- | --- | --- |",
    `| Changed files | ${stats.changedFilePaths.length} | ${renderPaths(stats.changedFilePaths)} |`,
    `| Related files | ${stats.relatedFilePaths.length} | ${renderPaths(stats.relatedFilePaths)} |`,
    `| Priority docs | ${stats.priorityDocPaths.length} | ${renderPaths(stats.priorityDocPaths)} |`,
    `| Priority docs (already in context) | ${stats.priorityDocsInContextPaths.length} | ${renderPaths(stats.priorityDocsInContextPaths)} |`,
    `| Priority docs (not included) | ${stats.priorityDocsAbsentPaths.length} | ${renderPaths(stats.priorityDocsAbsentPaths)} |`,
    `| Mention-matched docs | ${stats.mentionMatchedDocPaths.length} | ${renderPaths(stats.mentionMatchedDocPaths)} |`,
    `| Excluded (related files cap) | ${stats.relatedFilesExcludedPaths.length} | ${renderPaths(stats.relatedFilesExcludedPaths)} |`,
    `| Excluded (docs cap) | ${stats.docsExcludedPaths.length} | ${renderPaths(stats.docsExcludedPaths)} |`,
    "",
    `**Token budget:** ${stats.tokenBudgetTotal} total · ${stats.tokenBudgetUsedByDiff} diff · ${stats.tokenBudgetPriorityDocFloor} priority-doc floor · ${stats.tokenBudgetRemainingForDocs} left for docs`,
    "",
    "#### Findings pipeline",
    "",
    "| stage | count |",
    "| --- | --- |",
    `| Raw from model | ${stats.totalFromModel} |`,
    `| Dropped as non-findings | ${stats.droppedAsNonFinding} |`,
    `| Dropped as unknown file | ${stats.droppedAsUnknownFile} |`,
    `| Duplicates (cross-phase) | ${stats.duplicatesAcrossPhases} |`,
    `| Duplicates (cross-run) | ${stats.duplicatesRemoved} |`,
    `| Dropped below threshold | ${stats.droppedBelowThreshold} |`,
    `| Dropped as overlapping | ${stats.droppedAsOverlapping} |`,
    `| Dropped by cap | ${stats.droppedByCap} |`,
    `| **Posted** | **${stats.posted}** |`,
  ].join("\n")
}
