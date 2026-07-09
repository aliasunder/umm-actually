import type { File } from "parse-diff"

/**
 * The RIGHT-side (new file) lines a GitHub review comment may anchor to,
 * plus the hunk ranges used for near-miss snapping. GitHub rejects an entire
 * review when any inline comment targets a line outside the diff, so this is
 * the source of truth comment mapping validates against.
 */
export type CommentableFile = {
  rightLines: Set<number>
  hunkRanges: { start: number; end: number }[]
}

/** The new-file path of a diff entry, or null when the file was deleted. */
export const newFilePath = (file: File): string | null => {
  if (file.to === undefined || file.to === "/dev/null") return null
  return file.to
}

export const computeCommentableLines = (
  files: File[],
): Map<string, CommentableFile> => {
  const commentableByPath = new Map<string, CommentableFile>()

  for (const file of files) {
    const path = newFilePath(file)
    if (path === null) continue

    const rightLines = new Set<number>()
    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        // Both added and unchanged (context) lines are commentable on the RIGHT side
        if (change.type === "add") rightLines.add(change.ln)
        if (change.type === "normal") rightLines.add(change.ln2)
      }
    }

    const hunkRanges = file.chunks.map((chunk) => ({
      start: chunk.newStart,
      end: chunk.newStart + Math.max(chunk.newLines - 1, 0),
    }))

    commentableByPath.set(path, { rightLines, hunkRanges })
  }

  return commentableByPath
}
