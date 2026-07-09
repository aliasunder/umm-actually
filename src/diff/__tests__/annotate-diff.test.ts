import { readFileSync } from "node:fs"
import parseDiff from "parse-diff"
import { describe, expect, it } from "vitest"
import { annotateDiff } from "../annotate-diff.js"
import { computeCommentableLines, newFilePath } from "../commentable-lines.js"

const sampleDiff = readFileSync(
  new URL("../../../fixtures/sample.diff", import.meta.url),
  "utf8",
)
const parsedFiles = parseDiff(sampleDiff)

describe("annotateDiff", () => {
  it("renders an added file with explicit new-file line numbers", () => {
    const addedFile = parsedFiles.filter(
      (file) => file.to === "src/added-file.ts",
    )

    expect(annotateDiff(addedFile)).toBe(
      [
        "=== src/added-file.ts (added) ===",
        "@@ -0,0 +1,3 @@",
        "     1 + export const brandNew = (): number => {",
        "     2 +   return 42",
        "     3 + }",
      ].join("\n"),
    )
  })

  it("renders deleted lines without a line number", () => {
    const renamedFile = parsedFiles.filter(
      (file) => file.to === "src/new-name.ts",
    )
    const annotated = annotateDiff(renamedFile)

    expect(annotated).toContain('       -   return "old"')
    expect(annotated).not.toContain("12 -")
  })

  it("labels renamed files with their previous path", () => {
    const renamedFile = parsedFiles.filter(
      (file) => file.to === "src/new-name.ts",
    )

    expect(annotateDiff(renamedFile)).toContain(
      "=== src/new-name.ts (renamed from src/old-name.ts) ===",
    )
  })

  it("filters no-newline markers so they don't render as phantom content lines", () => {
    const noNewlineFile = parsedFiles.filter(
      (file) => file.to === "src/no-trailing-newline.ts",
    )

    expect(annotateDiff(noNewlineFile)).toBe(
      [
        "=== src/no-trailing-newline.ts ===",
        "@@ -1,2 +1,2 @@",
        "     1   const configVersion = 1",
        '       - export const configName = "old"',
        '     2 + export const configName = "new"',
      ].join("\n"),
    )
  })

  it("renders binary files as a no-line-changes section", () => {
    const binaryFile = parsedFiles.filter(
      (file) => file.to === "assets/logo.png",
    )

    expect(annotateDiff(binaryFile)).toBe(
      "=== assets/logo.png ===\n(no line changes — binary or metadata-only)",
    )
  })

  it("prints exactly the line numbers that commentable-lines computes, for every file", () => {
    const commentableByPath = computeCommentableLines(parsedFiles)

    for (const file of parsedFiles) {
      const path = newFilePath(file)
      if (path === null) continue

      const annotated = annotateDiff([file])
      const printedLineNumbers = new Set(
        [...annotated.matchAll(/^\s*(\d+) [+ ] /gm)].map((match) =>
          Number(match[1]),
        ),
      )
      const commentable = commentableByPath.get(path)

      expect(commentable).toBeDefined()
      expect(printedLineNumbers).toEqual(commentable?.rightLines)
    }
  })
})
