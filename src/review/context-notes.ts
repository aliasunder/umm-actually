import { posix } from "node:path"
import type { PromptFile } from "./prompt.js"

export type ContextNotesInput = {
  /** config.priorityDocs, in the spelling the operator configured. */
  priorityDocs: string[]
  /** The excludePaths handed to readPriorityDocs — paths a higher-priority
   *  channel already claimed, so the doc was deliberately not re-read. */
  priorityDocsInContext: string[]
  /** What readPriorityDocs returned. */
  priorityDocsRead: PromptFile[]
  relatedFilesExcludedPaths: string[]
  docsExcludedPaths: string[]
}

/** Paths arrive from three sources that spell them differently — action
 *  inputs (operator-typed, possibly "./README.md"), the parsed diff, and the
 *  workspace scan. Comparing raw strings silently reports a doc as absent
 *  when only its spelling differs. */
const normalizePath = (filePath: string): string => posix.normalize(filePath)

const renderPaths = (paths: string[]): string =>
  paths.map((filePath) => `\`${filePath}\``).join(", ")

/** Priority docs the model never received: neither claimed by another channel
 *  nor successfully read. Returns the configured spelling, deduped by
 *  normalized path — config parsing splits and trims but does not dedupe, so
 *  "README.md,./README.md" would otherwise name one file twice. */
const findAbsentPriorityDocs = ({
  priorityDocs,
  priorityDocsInContext,
  priorityDocsRead,
}: Pick<
  ContextNotesInput,
  "priorityDocs" | "priorityDocsInContext" | "priorityDocsRead"
>): string[] => {
  const satisfiedPaths = new Set([
    ...priorityDocsInContext.map(normalizePath),
    ...priorityDocsRead.map((file) => normalizePath(file.path)),
  ])
  const seenPaths = new Set<string>()
  const absentPaths: string[] = []

  for (const docPath of priorityDocs) {
    const normalizedPath = normalizePath(docPath)
    if (satisfiedPaths.has(normalizedPath)) continue
    if (seenPaths.has(normalizedPath)) continue
    seenPaths.add(normalizedPath)
    absentPaths.push(docPath)
  }

  return absentPaths
}

/** Operator-facing notes on what the review context did and did not carry,
 *  rendered into the status comment's collapsible section. Every note states
 *  an absence — a channel that stayed silent had nothing to report. */
export const buildContextNotes = ({
  priorityDocs,
  priorityDocsInContext,
  priorityDocsRead,
  relatedFilesExcludedPaths,
  docsExcludedPaths,
}: ContextNotesInput): string[] => {
  const absentPriorityDocs = findAbsentPriorityDocs({
    priorityDocs,
    priorityDocsInContext,
    priorityDocsRead,
  })

  const priorityDocsNote =
    absentPriorityDocs.length === 0
      ? null
      : `Priority docs not included: ${renderPaths(absentPriorityDocs)} (missing, unreadable, or over budget)`
  const relatedFilesNote =
    relatedFilesExcludedPaths.length === 0
      ? null
      : `${relatedFilesExcludedPaths.length} related file(s) excluded by \`max_related_files\` cap: ${renderPaths(relatedFilesExcludedPaths)}`
  const relatedDocsNote =
    docsExcludedPaths.length === 0
      ? null
      : `${docsExcludedPaths.length} related doc(s) excluded by \`max_related_docs\` cap: ${renderPaths(docsExcludedPaths)}`

  return [priorityDocsNote, relatedFilesNote, relatedDocsNote].filter(
    (note) => note !== null,
  )
}
