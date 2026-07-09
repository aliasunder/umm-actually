import { describe, expect, it } from "vitest"
import type { CommentableFile } from "../../diff/commentable-lines.js"
import {
  buildReviewBody,
  buildZeroFindingsBody,
  mapFindingsToReview,
} from "../comment-mapping.js"
import { makeFinding } from "./make-finding.js"

const makeCommentableByPath = (): Map<string, CommentableFile> =>
  new Map([
    [
      "src/greeter.ts",
      {
        rightLines: new Set([
          1, 2, 3, 4, 5, 6, 141, 142, 143, 144, 145, 146, 147,
        ]),
        hunkRanges: [
          { start: 1, end: 6 },
          { start: 141, end: 147 },
        ],
      },
    ],
  ])

describe("mapFindingsToReview", () => {
  it("maps a finding on a commentable line to an inline RIGHT-side comment", () => {
    const finding = makeFinding({ line: 145 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.bodyFindings).toEqual([])
    expect(mapped.comments).toHaveLength(1)
    expect(mapped.comments[0]).toMatchObject({
      path: "src/greeter.ts",
      line: 145,
      side: "RIGHT",
    })
    expect(mapped.comments[0]?.start_line).toBeUndefined()
    expect(mapped.comments[0]?.body).toContain("**[medium/correctness]**")
    expect(mapped.comments[0]?.body).toContain("**Failure scenario:**")
    expect(mapped.comments[0]?.body).toContain("_(confidence: high)_")
  })

  it("maps a valid multi-line finding with start_line first and line last, per GitHub's API", () => {
    const finding = makeFinding({ line: 143, end_line: 146 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.comments[0]).toMatchObject({
      path: "src/greeter.ts",
      start_line: 143,
      start_side: "RIGHT",
      line: 146,
      side: "RIGHT",
    })
  })

  it("degrades to a single-line comment when end_line falls in a different hunk", () => {
    const finding = makeFinding({ line: 5, end_line: 142 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.comments[0]).toMatchObject({ line: 5, side: "RIGHT" })
    expect(mapped.comments[0]?.start_line).toBeUndefined()
  })

  it("snaps a near-miss line to the nearest commentable line and notes the original", () => {
    const finding = makeFinding({ line: 149 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.comments[0]).toMatchObject({ line: 147, side: "RIGHT" })
    expect(mapped.comments[0]?.body).toContain(
      "_Anchored near line 149 (the reported line is not part of the diff)._",
    )
  })

  it("routes a finding in a file outside the diff to the review body", () => {
    const finding = makeFinding({ file: "src/untouched.ts", line: 30 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.comments).toEqual([])
    expect(mapped.bodyFindings).toEqual([finding])
  })

  it("routes a finding far outside every hunk to the review body", () => {
    const finding = makeFinding({ line: 400 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.comments).toEqual([])
    expect(mapped.bodyFindings).toEqual([finding])
  })

  it("renders a diff fence only when the finding carries a suggestion", () => {
    const withSuggestion = makeFinding({
      line: 144,
      suggestion: "-old line\n+new line",
    })
    const withoutSuggestion = makeFinding({ line: 145 })

    const mapped = mapFindingsToReview({
      findings: [withSuggestion, withoutSuggestion],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.comments[0]?.body).toContain(
      "```diff\n-old line\n+new line\n```",
    )
    expect(mapped.comments[1]?.body).not.toContain("```diff")
  })
})

describe("buildReviewBody", () => {
  it("renders beyond-diff findings, the cap note, and attribution in full", () => {
    const beyondDiffFinding = makeFinding({
      file: "src/untouched.ts",
      line: 30,
      severity: "high",
      category: "correctness",
      title: "Caller assumes non-null return",
      description: "The caller dereferences the result without a null check.",
      failure_scenario: "greet(null) returns null and the caller throws.",
      confidence: "medium",
    })
    const cappedFinding = makeFinding({ file: "src/greeter.ts", line: 5 })

    const body = buildReviewBody({
      bodyFindings: [beyondDiffFinding],
      droppedByCap: [cappedFinding],
      model: "anthropic/claude-sonnet-4-6",
    })

    expect(body).toBe(`### Findings beyond the diff

These are in code the changes touch or depend on, outside the diff's line ranges:

- **[high/correctness]** Caller assumes non-null return — \`src/untouched.ts:30\` _(confidence: medium)_
  The caller dereferences the result without a null check.
  **Failure scenario:** greet(null) returns null and the caller throws.

_1 lower-severity finding(s) omitted by the max_findings cap: \`src/greeter.ts:5\`_

---
*umm-actually · anthropic/claude-sonnet-4-6*`)
  })

  it("renders only attribution when there is nothing beyond the diff and no cap drops", () => {
    const body = buildReviewBody({
      bodyFindings: [],
      droppedByCap: [],
      model: "anthropic/claude-sonnet-4-6",
    })

    expect(body).toBe("---\n*umm-actually · anthropic/claude-sonnet-4-6*")
  })
})

describe("buildZeroFindingsBody", () => {
  it("renders the confirmation body with attribution", () => {
    expect(
      buildZeroFindingsBody({ model: "anthropic/claude-sonnet-4-6" }),
    ).toBe(
      "Reviewed — no findings above threshold.\n\n---\n*umm-actually · anthropic/claude-sonnet-4-6*",
    )
  })
})
