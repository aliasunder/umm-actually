import { readFileSync } from "node:fs"
import parseDiff from "parse-diff"
import { describe, expect, it } from "vitest"
import { computeCommentableLines, newFilePath } from "../commentable-lines.js"

const sampleDiff = readFileSync(
  new URL("../../../fixtures/sample.diff", import.meta.url),
  "utf8",
)
const parsedFiles = parseDiff(sampleDiff)

describe("newFilePath", () => {
  it("returns the new path for a modified file", () => {
    const greeter = parsedFiles.find((file) => file.to === "src/greeter.ts")

    expect(greeter).toBeDefined()
    expect(greeter === undefined ? null : newFilePath(greeter)).toBe(
      "src/greeter.ts",
    )
  })

  it("returns null for a deleted file", () => {
    const removed = parsedFiles.find(
      (file) => file.from === "src/removed-file.ts",
    )

    expect(removed?.to).toBe("/dev/null")
    expect(removed === undefined ? null : newFilePath(removed)).toBeNull()
  })
})

describe("computeCommentableLines", () => {
  const commentableByPath = computeCommentableLines(parsedFiles)

  it("indexes every non-deleted file by its new path, excluding deleted files", () => {
    expect([...commentableByPath.keys()].sort()).toEqual([
      "assets/logo.png",
      "src/added-file.ts",
      "src/greeter.ts",
      "src/new-name.ts",
      "src/no-trailing-newline.ts",
    ])
  })

  it("includes both added and context lines as commentable, excluding deleted lines", () => {
    const greeter = commentableByPath.get("src/greeter.ts")

    expect(greeter).toBeDefined()
    expect([...(greeter?.rightLines ?? [])].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 141, 142, 143, 144, 145, 146, 147,
    ])
  })

  it("computes exact hunk ranges from newStart and newLines", () => {
    const greeter = commentableByPath.get("src/greeter.ts")

    expect(greeter?.hunkRanges).toEqual([
      { start: 1, end: 6 },
      { start: 141, end: 147 },
    ])
  })

  it("maps an added file to all of its new lines", () => {
    const addedFile = commentableByPath.get("src/added-file.ts")

    expect([...(addedFile?.rightLines ?? [])].sort((a, b) => a - b)).toEqual([
      1, 2, 3,
    ])
    expect(addedFile?.hunkRanges).toEqual([{ start: 1, end: 3 }])
  })

  it("uses the post-rename path for renamed files", () => {
    const renamed = commentableByPath.get("src/new-name.ts")

    expect(renamed).toBeDefined()
    expect(commentableByPath.has("src/old-name.ts")).toBe(false)
    expect([...(renamed?.rightLines ?? [])].sort((a, b) => a - b)).toEqual([
      10, 11, 12, 13,
    ])
  })

  it("yields no commentable lines for a binary file", () => {
    const binary = commentableByPath.get("assets/logo.png")

    expect(binary?.rightLines.size).toBe(0)
    expect(binary?.hunkRanges).toEqual([])
  })

  it("yields no RIGHT lines for a deletion-only file", () => {
    expect(commentableByPath.has("src/removed-file.ts")).toBe(false)
  })
})
