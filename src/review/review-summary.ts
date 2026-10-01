import { escapeLineBreaks } from "../diff/quoted-paths.js"
import type { PrContext } from "../github/event.js"
import type { ConventionsCoverage, ConventionsFullCopyChannel } from "./context-notes.js"
import { renderCodeSpan } from "./markdown.js"

export type ReviewSummaryStats = {
  prContext: PrContext
  /** The configured path, whether or not the file was found. */
  conventionsFile: string
  conventionsCoverage: ConventionsCoverage
  phasesCompleted: string[]
  /** Phases that ended without an accepted response — their findings are absent. */
  phasesIncomplete: string[]
  /** True when deadline expiry left phases incomplete. */
  reviewDeadlineExceeded?: boolean
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
  /** Tokens reserved for priority docs: what the early priority-doc read spent
   *  plus what was held back from related files. */
  tokenBudgetPriorityDocFloor: number
  tokenBudgetRemainingForDocs: number
  totalFromModel: number
  droppedAsNonFinding: number
  /** Findings naming a file the model was never given. */
  droppedAsUnknownFile: number
  /** Findings on a changed file diff exclusion removed from the review. */
  droppedAsExcludedFile: number
  /** Findings two phases reported on overlapping lines of one file. */
  duplicatesAcrossPhases: number
  /** Findings dropped because an earlier run already posted them. */
  duplicatesRemoved: number
  droppedBelowThreshold: number
  droppedAsOverlapping: number
  droppedByCap: number
  posted: number
}

/** Comma-joined items for one markdown line or table cell — em-dash when
 *  empty so cells are never blank. Line breaks, backslashes, and pipes are
 *  escaped, so no item can split or break the row. */
const renderCommaList = (items: string[]): string => {
  if (items.length === 0) return "—"

  // 1. Line breaks become octal escapes first. Workspace-scan paths never pass
  //    the diff decoder's line-break check, so a raw one would split the row.
  // 2. Backslashes are escaped next, including the ones step 1 wrote, so each
  //    renders as written.
  // 3. Pipes are escaped last. Escaping them before backslashes would double
  //    each pipe escape's own backslash and leave the pipe bare. For example,
  //    `a\|b` renders as `a\\\|b`.
  return items
    .map((item) => escapeLineBreaks(item).replaceAll("\\", "\\\\").replaceAll("|", "\\|"))
    .join(", ")
}

/** The conventions file and how much of it reached the model. */
const renderConventionsCoverage = ({
  conventionsFile,
  conventionsCoverage,
}: Pick<ReviewSummaryStats, "conventionsFile" | "conventionsCoverage">): string => {
  if (conventionsCoverage.status === "not-found") return "none"

  // The size against the cap shows how close a fitting file is to truncating
  if (conventionsCoverage.status === "full") {
    const { characterCap, totalCharacters } = conventionsCoverage
    return `${conventionsFile} (${totalCharacters} characters, within the ${characterCap}-character cap)`
  }

  // Only the truncated status remains
  const { fullCopyChannel, characterCap, totalCharacters } = conventionsCoverage

  // A priority-doc copy replaces the truncated section, so no head was sent
  if (fullCopyChannel === "priority-docs") {
    return `${conventionsFile} (sent in full as a priority doc; its ${totalCharacters} characters exceed the ${characterCap}-character section cap)`
  }

  const truncationClause = `truncated to ${characterCap} of ${totalCharacters} characters`

  if (!fullCopyChannel) {
    return `${conventionsFile} (${truncationClause}; no full copy reached the model)`
  }

  const channelLabels: Record<Exclude<ConventionsFullCopyChannel, "priority-docs">, string> = {
    "changed-files": "changed files",
    "related-files": "related files",
    "added-in-diff": "the diff of the added file",
  }

  return `${conventionsFile} (${truncationClause}; full copy in ${channelLabels[fullCopyChannel]})`
}

/** Markdown summary for the workflow job summary — renders a context
 *  table showing what the model saw (and which priority docs it did not),
 *  the token budget split, and a pipeline table showing what happened to
 *  each finding. */
export const renderReviewSummary = (stats: ReviewSummaryStats): string => {
  const sha = stats.prContext.headSha.slice(0, 7)
  const incompleteClause =
    stats.phasesIncomplete.length === 0 ? "" : ` · incomplete: ${stats.phasesIncomplete.join(", ")}`

  return [
    "### umm-actually review summary",
    "",
    `PR #${stats.prContext.prNumber} · ${renderCodeSpan(stats.prContext.headRef)} → ${renderCodeSpan(stats.prContext.baseRef)} · \`${sha}\``,
    "",
    `**Conventions:** ${renderConventionsCoverage(stats)}`,
    "",
    `**Phases:** ${renderCommaList(stats.phasesCompleted)}${incompleteClause}`,
    ...(stats.reviewDeadlineExceeded
      ? ["", "The review deadline expired; results from completed phases are shown."]
      : []),
    "",
    "#### Context",
    "",
    "| type | count | paths |",
    "| --- | --- | --- |",
    `| Changed files | ${stats.changedFilePaths.length} | ${renderCommaList(stats.changedFilePaths)} |`,
    `| Related files | ${stats.relatedFilePaths.length} | ${renderCommaList(stats.relatedFilePaths)} |`,
    `| Priority docs | ${stats.priorityDocPaths.length} | ${renderCommaList(stats.priorityDocPaths)} |`,
    `| Priority docs (already in context) | ${stats.priorityDocsInContextPaths.length} | ${renderCommaList(stats.priorityDocsInContextPaths)} |`,
    `| Priority docs (not included) | ${stats.priorityDocsAbsentPaths.length} | ${renderCommaList(stats.priorityDocsAbsentPaths)} |`,
    `| Mention-matched docs | ${stats.mentionMatchedDocPaths.length} | ${renderCommaList(stats.mentionMatchedDocPaths)} |`,
    `| Excluded (related files cap) | ${stats.relatedFilesExcludedPaths.length} | ${renderCommaList(stats.relatedFilesExcludedPaths)} |`,
    `| Excluded (docs cap) | ${stats.docsExcludedPaths.length} | ${renderCommaList(stats.docsExcludedPaths)} |`,
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
    `| Dropped as excluded file | ${stats.droppedAsExcludedFile} |`,
    `| Duplicates (cross-phase) | ${stats.duplicatesAcrossPhases} |`,
    `| Duplicates (cross-run) | ${stats.duplicatesRemoved} |`,
    `| Dropped below threshold | ${stats.droppedBelowThreshold} |`,
    `| Dropped as overlapping | ${stats.droppedAsOverlapping} |`,
    `| Dropped by cap | ${stats.droppedByCap} |`,
    `| **Posted** | **${stats.posted}** |`,
  ].join("\n")
}
