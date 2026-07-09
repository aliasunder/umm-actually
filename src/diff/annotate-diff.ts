import type { Change, File } from "parse-diff"
import { newFilePath } from "./commentable-lines.js"

/**
 * parse-diff keeps the unified-diff marker (+, -, space) as the first
 * character of each change's content — strip it for display since we render
 * our own marker column.
 */
const changeText = (change: Change): string => change.content.slice(1)

const renderChange = (change: Change): string => {
  if (change.type === "add")
    return `${String(change.ln).padStart(6)} + ${changeText(change)}`
  if (change.type === "normal")
    return `${String(change.ln2).padStart(6)}   ${changeText(change)}`
  return `       - ${changeText(change)}`
}

const fileStatus = (file: File): string => {
  if (file.new === true) return " (added)"
  if (file.deleted === true) return " (deleted)"
  if (file.from !== undefined && file.to !== undefined && file.from !== file.to)
    return ` (renamed from ${file.from})`
  return ""
}

/**
 * Renders the diff with explicit new-file line numbers on added and context
 * lines. The model copies line numbers it can literally see instead of
 * counting hunk offsets — the single biggest lever for reliable inline
 * comment anchoring. Numbers printed here are exactly the commentable set
 * computed by commentable-lines.ts (verified by a cross-module test).
 */
export const annotateDiff = (files: File[]): string => {
  const sections = files.map((file) => {
    const path = newFilePath(file) ?? file.from ?? "(unknown)"
    const header = `=== ${path}${fileStatus(file)} ===`

    if (file.chunks.length === 0)
      return `${header}\n(no line changes — binary or metadata-only)`

    const chunkBlocks = file.chunks.map((chunk) => {
      const renderedChanges = chunk.changes.map(renderChange)
      return [chunk.content, ...renderedChanges].join("\n")
    })
    return [header, ...chunkBlocks].join("\n")
  })

  return sections.join("\n\n")
}
