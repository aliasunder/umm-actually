import { posix } from "node:path"
import { describeExclusionSource, type ExcludedDiffFile } from "../diff/exclusion.js"
import { CHARS_PER_TOKEN, conventionsRenderInFull, type PromptFile } from "./prompt.js"

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
}: Pick<ContextNotesInput, "priorityDocs" | "priorityDocsInContext">): string[] => {
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

/** A context channel that can carry the conventions file's whole text. */
export type ConventionsFullCopyChannel =
  "priority-docs" | "changed-files" | "related-files" | "added-in-diff"

/** How much of the conventions file reached the model. */
export type ConventionsCoverage =
  | { status: "not-found" }
  | { status: "full"; totalCharacters: number }
  | {
      status: "truncated"
      /** Channel that carried the whole text; null when only the head was sent. */
      fullCopyChannel: ConventionsFullCopyChannel | null
      characterCap: number
      totalCharacters: number
    }

type ConventionsChannels = {
  conventionsFile: string
  priorityDocFiles: PromptFile[]
  changedFiles: PromptFile[]
  relatedFiles: PromptFile[]
  /** True when the PR adds the conventions file — its diff hunks carry every line. */
  conventionsAddedInDiff: boolean
}

const findFullCopyChannel = ({
  conventionsFile,
  priorityDocFiles,
  changedFiles,
  relatedFiles,
  conventionsAddedInDiff,
}: ConventionsChannels): ConventionsFullCopyChannel | null => {
  const conventionsPath = normalizePath(conventionsFile)
  const carriesConventionsInFull = (file: PromptFile): boolean => {
    return file.includedAs === "full" && normalizePath(file.path) === conventionsPath
  }

  // Checked first because a priority-doc copy also suppresses the truncated
  // conventions section, so it decides what the prompt contains
  if (priorityDocFiles.some(carriesConventionsInFull)) return "priority-docs"
  if (changedFiles.some(carriesConventionsInFull)) return "changed-files"

  // Related files are traced only from JS/TS imports, so this matches only a
  // conventions file with a JS/TS extension
  if (relatedFiles.some(carriesConventionsInFull)) return "related-files"
  if (conventionsAddedInDiff) return "added-in-diff"

  return null
}

/** Classifies whether the conventions section carries the whole file, and when
 *  it truncates, which other channel (if any) still delivered the full text. */
export const classifyConventionsCoverage = ({
  conventions,
  conventionsBudgetTokens,
  ...channels
}: ConventionsChannels & {
  conventions: string | null
  conventionsBudgetTokens: number
}): ConventionsCoverage => {
  if (conventions === null) return { status: "not-found" }

  const totalCharacters = conventions.length

  if (conventionsRenderInFull(conventions, conventionsBudgetTokens)) {
    return { status: "full", totalCharacters }
  }

  return {
    status: "truncated",
    fullCopyChannel: findFullCopyChannel(channels),
    characterCap: conventionsBudgetTokens * CHARS_PER_TOKEN,
    totalCharacters,
  }
}

/** PR-facing line for a truncated conventions file. Null when the file fits
 *  its section, or a priority-doc or related-file copy delivered the whole text. */
export const buildConventionsNote = ({
  conventionsCoverage,
  conventionsFile,
  listedInPriorityDocs,
}: {
  conventionsCoverage: ConventionsCoverage
  conventionsFile: string
  /** Whether the priority_docs input names the file, in any spelling. */
  listedInPriorityDocs: boolean
}): string | null => {
  if (conventionsCoverage.status !== "truncated") return null

  const { fullCopyChannel, characterCap, totalCharacters } = conventionsCoverage
  const fileLabel = `\`${conventionsFile}\``

  // This PR changes or adds the file, so its review had the full text, but
  // the next PR that leaves the file alone gets only the head
  const onlyThisPrCarriesFullText =
    fullCopyChannel === "changed-files" || fullCopyChannel === "added-in-diff"

  if (onlyThisPrCarriesFullText) {
    return `Conventions file ${fileLabel} exceeds \`conventions_budget_tokens\` (${totalCharacters} characters against a ${characterCap}-character cap) — this PR carried the full text, but later PRs that don't change it will see only the first ${characterCap} characters.`
  }
  if (fullCopyChannel) return null

  const truncationLead = `Conventions file ${fileLabel} was truncated to its first ${characterCap} of ${totalCharacters} characters, and no full copy reached the model`

  if (listedInPriorityDocs) {
    return `${truncationLead} — raise \`conventions_budget_tokens\`; the file is listed in \`priority_docs\` but did not fit or was excluded.`
  }

  return `${truncationLead} — raise \`conventions_budget_tokens\` or list the file in \`priority_docs\`.`
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
