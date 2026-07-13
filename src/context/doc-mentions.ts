import { posix } from "node:path"

export const DOC_EXTENSIONS = new Set([".md", ".json"])

/** Basenames too common for bare substring matches — a doc mentioning "index.ts"
 *  almost never means the specific `src/lib/index.ts` that changed. Require at
 *  least one parent directory segment (e.g. `lib/index.ts`). */
export const GENERIC_BASENAMES = new Set([
  "index",
  "main",
  "config",
  "types",
  "utils",
  "helpers",
  "constants",
  "mod",
])

export type MentionResult = {
  mentionedPaths: string[]
  fullPathCount: number
  basenameCount: number
}

export type DocCandidate = {
  path: string
  content: string
  fullPathCount: number
  basenameCount: number
  mentionedChangedPaths: string[]
}

/** For each changed path, determine the best match type in the doc content.
 *  Full-path matches outrank basename matches — a path that matches by full
 *  path is NOT also counted as a basename match (no double-counting). */
export const findMentionedChangedPaths = (
  docContent: string,
  changedPaths: string[],
): MentionResult => {
  const mentionedPaths: string[] = []
  let fullPathCount = 0
  let basenameCount = 0

  for (const changedPath of changedPaths) {
    if (docContent.includes(changedPath)) {
      mentionedPaths.push(changedPath)
      fullPathCount++
      continue
    }

    const basename = posix.basename(changedPath)
    const stem = basename.slice(0, basename.lastIndexOf("."))
    if (stem === "") continue

    if (GENERIC_BASENAMES.has(stem)) {
      const segments = changedPath.split("/")
      if (segments.length < 2) continue
      const lastTwoSegments = segments.slice(-2).join("/")
      if (docContent.includes(lastTwoSegments)) {
        mentionedPaths.push(changedPath)
        basenameCount++
      }
      continue
    }

    if (docContent.includes(basename)) {
      mentionedPaths.push(changedPath)
      basenameCount++
    }
  }

  return { mentionedPaths, fullPathCount, basenameCount }
}

/** Full-path count desc, then basename count desc, then path asc for determinism. */
export const byMentionRelevance = (
  a: DocCandidate,
  b: DocCandidate,
): number => {
  if (a.fullPathCount !== b.fullPathCount) {
    return b.fullPathCount - a.fullPathCount
  }
  if (a.basenameCount !== b.basenameCount) {
    return b.basenameCount - a.basenameCount
  }
  return a.path < b.path ? -1 : 1
}
