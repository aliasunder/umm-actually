import { posix } from "node:path"
import type { File } from "parse-diff"
import { newFilePath } from "./commentable-lines.js"
import {
  compileLinguistRules,
  linguistGeneratedState,
  type CompiledLinguistRule,
  type LinguistRule,
} from "./gitattributes.js"

export type DiffExclusionSource =
  "default_pattern" | "operator_pattern" | "linguist_generated"

export type ExcludedDiffFile = {
  path: string
  additions: number
  deletions: number
  source: DiffExclusionSource
}

export type PartitionedDiffFiles = {
  kept: File[]
  excluded: ExcludedDiffFile[]
}

/** Operator-facing label for each exclusion source, shown in the excluded-
 *  files trailer and the status comment's context notes. */
export const describeExclusionSource = (
  source: DiffExclusionSource,
): string => {
  if (source === "default_pattern") return "default exclusion"
  if (source === "operator_pattern") return "diff_exclude_paths"
  return "linguist-generated"
}

/** A pattern hits as a root-anchored folder prefix (the exclude_paths rule)
 *  or as a glob — the union keeps both operator mental models valid. */
const matchesExcludePattern = (filePath: string, pattern: string): boolean => {
  return (
    filePath === pattern ||
    filePath.startsWith(pattern + "/") ||
    posix.matchesGlob(filePath, pattern)
  )
}

const matchesAnyPattern = (filePath: string, patterns: string[]): boolean => {
  return patterns.some((pattern) => matchesExcludePattern(filePath, pattern))
}

/** The path a file is judged by: the new path, or the old path for
 *  deletions — a rename out of an excluded folder into reviewable source is
 *  reviewed, while a rename into one is excluded. */
const exclusionPath = (file: File): string | null => {
  const filePath = newFilePath(file) ?? file.from
  if (!filePath || filePath === "/dev/null") return null
  // Leading slashes are stripped because ignore().ignores() throws on
  // absolute paths, and diff paths are PR-author-influenced
  return posix.normalize(filePath).replace(/^\/+/, "")
}

const resolveExclusionSource = ({
  filePath,
  defaultPatterns,
  operatorPatterns,
  compiledRules,
}: {
  filePath: string
  defaultPatterns: string[]
  operatorPatterns: string[]
  compiledRules: CompiledLinguistRule[]
}): DiffExclusionSource | null => {
  // Precedence: operator patterns are the most intentional layer and beat a
  // repo's negated gitattributes entry; a negated entry in turn exempts the
  // file from the built-in default list.
  if (matchesAnyPattern(filePath, operatorPatterns)) return "operator_pattern"

  const generatedState = linguistGeneratedState(filePath, compiledRules)
  if (generatedState === false) return null
  if (generatedState === true) return "linguist_generated"

  if (matchesAnyPattern(filePath, defaultPatterns)) return "default_pattern"
  return null
}

/**
 * Splits parsed diff files into the review subject and the excluded rest.
 * Runs before diff annotation and the token budget check so excluded files
 * consume no budget, no changed-file reads, and no commentable lines.
 */
export const partitionExcludedFiles = ({
  files,
  defaultPatterns,
  operatorPatterns,
  linguistRules,
}: {
  files: File[]
  defaultPatterns: string[]
  operatorPatterns: string[]
  linguistRules: LinguistRule[]
}): PartitionedDiffFiles => {
  const compiledRules = compileLinguistRules(linguistRules)
  const kept: File[] = []
  const excluded: ExcludedDiffFile[] = []

  for (const file of files) {
    const filePath = exclusionPath(file)
    if (filePath === null) {
      kept.push(file)
      continue
    }

    const source = resolveExclusionSource({
      filePath,
      defaultPatterns,
      operatorPatterns,
      compiledRules,
    })
    if (source === null) {
      kept.push(file)
      continue
    }

    excluded.push({
      path: filePath,
      additions: file.additions,
      deletions: file.deletions,
      source,
    })
  }

  return { kept, excluded }
}

/**
 * The changed-but-not-reviewed trailer appended after the annotated diff, so
 * the model knows these files changed without seeing their content. Lines
 * deliberately do not resemble the "=== path ===" file headers — the
 * anchoring contract only lets the model cite real headers and file blocks.
 */
export const renderExcludedFilesNote = (
  excluded: ExcludedDiffFile[],
): string => {
  if (excluded.length === 0) return ""

  const fileLines = excluded.map((file) => {
    const changeCounts = `+${file.additions}/-${file.deletions}`
    return `- ${file.path} (${changeCounts}, ${describeExclusionSource(file.source)})`
  })
  return [
    `${excluded.length} changed file(s) excluded from review (content not shown):`,
    ...fileLines,
  ].join("\n")
}
