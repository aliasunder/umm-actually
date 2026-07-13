import { describe, expect, it } from "vitest"
import type { CommentableFile } from "../../diff/commentable-lines.js"
import {
  buildRerunSummary,
  buildReviewBody,
  buildZeroFindingsBody,
  computeAnchorKey,
  extractAnchorKeys,
  mapFindingsToReview,
  RERUN_ANCHOR,
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
    // Exact whole-comment assertion: pins the full rendered body format and
    // proves the absence of start_line and of any extra comments
    expect(mapped.comments).toEqual([
      {
        path: "src/greeter.ts",
        line: 145,
        side: "RIGHT",
        body: `**[medium/correctness]** Whitespace-only keys pass the empty-key guard _(confidence: high)_

The guard rejects only the exact empty string.

**Failure scenario:** register(" ", "value") succeeds and the entry is orphaned.

<!-- umm-actually:src/greeter.ts:correctness:ffdf51bc -->`,
      },
    ])
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

  it("treats end_line equal to line as a single-line comment", () => {
    const finding = makeFinding({ line: 145, end_line: 145 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.comments[0]).toMatchObject({ line: 145, side: "RIGHT" })
    expect(mapped.comments[0]?.start_line).toBeUndefined()
  })

  it("degrades to a single-line comment when end_line precedes line", () => {
    const finding = makeFinding({ line: 145, end_line: 143 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.comments[0]).toMatchObject({ line: 145, side: "RIGHT" })
    expect(mapped.comments[0]?.start_line).toBeUndefined()
  })

  it("degrades to a single-line comment when end_line is not a commentable line", () => {
    const finding = makeFinding({ line: 145, end_line: 200 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.comments[0]).toMatchObject({ line: 145, side: "RIGHT" })
    expect(mapped.comments[0]?.start_line).toBeUndefined()
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
    expect(mapped.comments[0]?.body).toContain(
      `<!-- umm-actually:${computeAnchorKey(finding)} -->`,
    )
  })

  it("snaps a finding exactly SNAP_DISTANCE (3) beyond the hunk end", () => {
    const finding = makeFinding({ line: 150 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.comments[0]).toMatchObject({ line: 147, side: "RIGHT" })
    expect(mapped.bodyFindings).toEqual([])
  })

  it("routes to the body when the nearest commentable line exceeds SNAP_DISTANCE, even near a hunk", () => {
    // A pure-deletion hunk contributes a hunkRanges entry but no rightLines —
    // the finding is near that hunk, but every candidate line is distant
    const commentableByPath = new Map<string, CommentableFile>([
      [
        "src/greeter.ts",
        {
          rightLines: new Set([10, 11, 12]),
          hunkRanges: [
            { start: 10, end: 12 },
            { start: 499, end: 499 },
          ],
        },
      ],
    ])
    const finding = makeFinding({ line: 500 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath,
    })

    expect(mapped.comments).toEqual([])
    expect(mapped.bodyFindings).toEqual([finding])
  })

  it("routes a finding one line beyond SNAP_DISTANCE to the review body", () => {
    const finding = makeFinding({ line: 151 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.comments).toEqual([])
    expect(mapped.bodyFindings).toEqual([finding])
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

  it("sizes the suggestion fence beyond any backtick run inside the suggestion", () => {
    const fencedSuggestion = "```md\n-old fence\n+new fence\n```"
    const finding = makeFinding({ line: 145, suggestion: fencedSuggestion })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.comments[0]?.body).toContain(
      `\`\`\`\`diff\n${fencedSuggestion}\n\`\`\`\``,
    )
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

  it("renders the suggestion fence on beyond-diff findings", () => {
    const findingWithSuggestion = makeFinding({
      file: "src/untouched.ts",
      line: 30,
      suggestion: "-old line\n+new line",
    })

    const body = buildReviewBody({
      bodyFindings: [findingWithSuggestion],
      droppedByCap: [],
      model: "anthropic/claude-sonnet-4-6",
    })

    expect(body).toContain("```diff\n-old line\n+new line\n```")
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

describe("computeAnchorKey", () => {
  it("returns a deterministic key from file, category, and title hash", () => {
    const finding = makeFinding()
    const key = computeAnchorKey(finding)

    expect(key).toBe("src/greeter.ts:correctness:ffdf51bc")
    expect(computeAnchorKey(finding)).toBe(key)
  })

  it("produces a different key when the title differs", () => {
    const keyA = computeAnchorKey(makeFinding({ title: "Bug A" }))
    const keyB = computeAnchorKey(makeFinding({ title: "Bug B" }))

    expect(keyA).not.toBe(keyB)
  })

  it("produces a different key when the file differs", () => {
    const keyA = computeAnchorKey(makeFinding({ file: "src/a.ts" }))
    const keyB = computeAnchorKey(makeFinding({ file: "src/b.ts" }))

    expect(keyA).not.toBe(keyB)
  })

  it("produces a different key when the category differs", () => {
    const keyA = computeAnchorKey(makeFinding({ category: "correctness" }))
    const keyB = computeAnchorKey(makeFinding({ category: "security" }))

    expect(keyA).not.toBe(keyB)
  })
})

describe("extractAnchorKeys", () => {
  it("extracts keys from comment bodies with anchors", () => {
    const bodies = [
      "Some comment body\n\n<!-- umm-actually:src/a.ts:correctness:abcd1234 -->",
      "Another body\n\n<!-- umm-actually:src/b.ts:security:efgh5678 -->",
    ]

    const keys = extractAnchorKeys(bodies)

    expect(keys).toEqual(
      new Set(["src/a.ts:correctness:abcd1234", "src/b.ts:security:efgh5678"]),
    )
  })

  it("ignores bodies without anchors", () => {
    const bodies = [
      "A comment from a human reviewer",
      "CodeRabbit: some finding here",
      "Body with\n\n<!-- umm-actually:src/a.ts:correctness:abcd1234 -->",
    ]

    const keys = extractAnchorKeys(bodies)

    expect(keys).toEqual(new Set(["src/a.ts:correctness:abcd1234"]))
  })

  it("returns an empty set for an empty array", () => {
    expect(extractAnchorKeys([])).toEqual(new Set())
  })
})

describe("buildRerunSummary", () => {
  it("renders the summary with new findings", () => {
    const summary = buildRerunSummary({
      sha: "abc123def456abc1",
      newCount: 2,
      totalCount: 5,
      model: "anthropic/claude-sonnet-4-6",
    })

    expect(summary).toBe(
      `${RERUN_ANCHOR}\n\n**umm-actually** re-reviewed at \`abc123d\`\n\n2 new finding(s) posted as inline comments (5 total across all reviews).\n\n---\n*umm-actually · anthropic/claude-sonnet-4-6*`,
    )
  })

  it("renders the summary with zero new findings", () => {
    const summary = buildRerunSummary({
      sha: "abc123def456abc1",
      newCount: 0,
      totalCount: 3,
      model: "anthropic/claude-sonnet-4-6",
    })

    expect(summary).toBe(
      `${RERUN_ANCHOR}\n\n**umm-actually** re-reviewed at \`abc123d\`\n\nNo new findings (3 finding(s) from prior reviews).\n\n---\n*umm-actually · anthropic/claude-sonnet-4-6*`,
    )
  })

  it("truncates the sha to 7 characters", () => {
    const summary = buildRerunSummary({
      sha: "0000000999999",
      newCount: 1,
      totalCount: 1,
      model: "test/model",
    })

    expect(summary).toContain("`0000000`")
    expect(summary).not.toContain("999999")
  })

  it("starts with the rerun anchor for upsert detection", () => {
    const summary = buildRerunSummary({
      sha: "abc123d",
      newCount: 0,
      totalCount: 0,
      model: "test/model",
    })

    expect(summary.startsWith(RERUN_ANCHOR)).toBe(true)
  })
})
