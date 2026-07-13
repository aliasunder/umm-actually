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

/** Characters that always indicate the match is a prefix of a longer path
 *  token (e.g. `greeter.ts` inside `greeter.tsx`). A `.` is treated as
 *  continuation only when followed by a word character (file extension like
 *  `.in`, `.bak`) — a sentence-ending period (`.` + space/EOF) is not. */
const PATH_CONTINUATION = /[\w/-]/

const isPathContinuation = (text: string, afterIndex: number): boolean => {
  const charAfter = text[afterIndex]
  if (charAfter === undefined) return false
  if (PATH_CONTINUATION.test(charAfter)) return true
  if (charAfter === ".") {
    const charAfterDot = text[afterIndex + 1]
    return charAfterDot !== undefined && /\w/.test(charAfterDot)
  }
  return false
}

/** True when `pathToken` appears in `text` as a complete path token — not as
 *  a prefix of a longer path (e.g. `greeter.ts` must not match `greeter.tsx`,
 *  and `Makefile` must not match `Makefile.in`). */
const hasPathMention = (text: string, pathToken: string): boolean => {
  let start = 0
  while (true) {
    const index = text.indexOf(pathToken, start)
    if (index === -1) return false
    if (!isPathContinuation(text, index + pathToken.length)) return true
    start = index + 1
  }
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
    if (hasPathMention(docContent, changedPath)) {
      mentionedPaths.push(changedPath)
      fullPathCount++
      continue
    }

    const basename = posix.basename(changedPath)
    const dotIndex = basename.lastIndexOf(".")
    const stem = dotIndex === -1 ? basename : basename.slice(0, dotIndex)
    if (stem === "") continue

    if (GENERIC_BASENAMES.has(stem)) {
      const segments = changedPath.split("/")
      if (segments.length < 2) continue
      const lastTwoSegments = segments.slice(-2).join("/")
      if (hasPathMention(docContent, lastTwoSegments)) {
        mentionedPaths.push(changedPath)
        basenameCount++
      }
      continue
    }

    if (hasPathMention(docContent, basename)) {
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
  if (a.path === b.path) return 0
  return a.path < b.path ? -1 : 1
}
