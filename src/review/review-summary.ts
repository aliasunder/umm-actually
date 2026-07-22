import type { PrContext } from "../github/event.js"

export type ReviewSummaryStats = {
  prContext: PrContext
  conventionsFile: string | null
  changedFilePaths: string[]
  relatedFilePaths: string[]
  relatedFilesExcludedPaths: string[]
  priorityDocPaths: string[]
  mentionMatchedDocPaths: string[]
  docsExcludedPaths: string[]
  totalFromModel: number
  droppedAsNonFinding: number
  duplicatesRemoved: number
  droppedBelowThreshold: number
  droppedByCap: number
  posted: number
}

/** Formats paths for a markdown table cell — em-dash when empty so cells
 *  are never blank. */
const pathList = (paths: string[]): string =>
  paths.length === 0 ? "—" : paths.join(", ")

/** Markdown summary for the workflow job summary — renders a context
 *  table showing what the model saw and a pipeline table showing what
 *  happened to each finding. */
export const renderReviewSummary = (stats: ReviewSummaryStats): string => {
  const sha = stats.prContext.headSha.slice(0, 7)

  return [
    "### umm-actually review summary",
    "",
    `PR #${stats.prContext.prNumber} · \`${stats.prContext.headRef}\` → \`${stats.prContext.baseRef}\` · \`${sha}\``,
    "",
    `**Instructions:** ${stats.conventionsFile ?? "none"}`,
    "",
    "#### Context",
    "",
    "| type | count | paths |",
    "| --- | --- | --- |",
    `| Changed files | ${stats.changedFilePaths.length} | ${pathList(stats.changedFilePaths)} |`,
    `| Related files | ${stats.relatedFilePaths.length} | ${pathList(stats.relatedFilePaths)} |`,
    `| Priority docs | ${stats.priorityDocPaths.length} | ${pathList(stats.priorityDocPaths)} |`,
    `| Mention-matched docs | ${stats.mentionMatchedDocPaths.length} | ${pathList(stats.mentionMatchedDocPaths)} |`,
    `| Excluded (related files cap) | ${stats.relatedFilesExcludedPaths.length} | ${pathList(stats.relatedFilesExcludedPaths)} |`,
    `| Excluded (docs cap) | ${stats.docsExcludedPaths.length} | ${pathList(stats.docsExcludedPaths)} |`,
    "",
    "#### Findings pipeline",
    "",
    "| stage | count |",
    "| --- | --- |",
    `| Raw from model | ${stats.totalFromModel} |`,
    `| Dropped as non-findings | ${stats.droppedAsNonFinding} |`,
    `| Duplicates (cross-run) | ${stats.duplicatesRemoved} |`,
    `| Dropped below threshold | ${stats.droppedBelowThreshold} |`,
    `| Dropped by cap | ${stats.droppedByCap} |`,
    `| **Posted** | **${stats.posted}** |`,
  ].join("\n")
}
