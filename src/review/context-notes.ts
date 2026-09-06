import { posix } from "node:path"
import {
  describeExclusionSource,
  type ExcludedDiffFile,
} from "../diff/exclude-diff-files.js"
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
  diffExcludedFiles: ExcludedDiffFile[]
}

/** Paths arrive from three sources that spell them differently — action
 *  inputs (operator-typed, possibly "./README.md"), the parsed diff, and the
 *  workspace scan. Comparing raw strings silently reports a doc as absent
 *  when only its spelling differs. */
const normalizePath = (filePath: string): string => posix.normalize(filePath)

const renderPaths = (paths: string[]): string =>
  paths.map((filePath) => `\`${filePath}\``).join(", ")

const renderExcludedFile = (file: ExcludedDiffFile): string => {
  return `\`${file.path}\` (${describeExclusionSource(file.source)})`
}

/** Priority docs satisfied by a higher-priority channel (changed files,
 *  related files, conventions) — their full text already reached the prompt
 *  so the priority-doc reader skipped them. Returns the configured spelling,
 *  deduped by normalized path. */
export const findInContextPriorityDocs = ({
  priorityDocs,
  priorityDocsInContext,
}: Pick<
  ContextNotesInput,
  "priorityDocs" | "priorityDocsInContext"
>): string[] => {
  const inContextPaths = new Set(priorityDocsInContext.map(normalizePath))
  const seenPaths = new Set<string>()
  const matchedDocs: string[] = []

  for (const docPath of priorityDocs) {
    const normalizedPath = normalizePath(docPath)
    if (!inContextPaths.has(normalizedPath)) continue
    if (seenPaths.has(normalizedPath)) continue
    seenPaths.add(normalizedPath)
    matchedDocs.push(docPath)
  }

  return matchedDocs
}

/** Priority docs the model never received: neither claimed by another channel
 *  nor successfully read. Returns the configured spelling, deduped by
 *  normalized path — config parsing splits and trims but does not dedupe, so
 *  "README.md,./README.md" would otherwise name one file twice. */
export const findAbsentPriorityDocs = ({
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
 *  rendered into the status comment's collapsible section. */
export const buildContextNotes = ({
  priorityDocs,
  priorityDocsInContext,
  priorityDocsRead,
  relatedFilesExcludedPaths,
  docsExcludedPaths,
  diffExcludedFiles,
}: ContextNotesInput): string[] => {
  const inContextDocs = findInContextPriorityDocs({
    priorityDocs,
    priorityDocsInContext,
  })
  const absentPriorityDocs = findAbsentPriorityDocs({
    priorityDocs,
    priorityDocsInContext,
    priorityDocsRead,
  })

  const inContextNote =
    inContextDocs.length === 0
      ? null
      : `Priority docs already in context: ${renderPaths(inContextDocs)}`
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
  const diffExcludedNote =
    diffExcludedFiles.length === 0
      ? null
      : `${diffExcludedFiles.length} changed file(s) excluded from review: ${diffExcludedFiles.map(renderExcludedFile).join(", ")}`

  return [
    inContextNote,
    priorityDocsNote,
    relatedFilesNote,
    relatedDocsNote,
    diffExcludedNote,
  ].filter((note) => note !== null)
}
