import { describe, expect, it } from "vitest"
import type { CommentableFile } from "../../diff/commentable-lines.js"
import {
  buildRerunSummary,
  buildReviewBody,
  buildZeroFindingsBody,
  computeAnchorKey,
  extractAnchors,
  isDuplicateFinding,
  mapFindingsToReview,
  RERUN_ANCHOR,
  type AnchorSource,
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

<!-- umm-actually:src/greeter.ts:correctness:145 -->`,
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
      "<details>\n<summary>Suggested fix</summary>\n\n```diff\n-old line\n+new line\n```\n\n</details>",
    )
    expect(mapped.comments[1]?.body).not.toContain("```diff")
  })

  it("omits the suggestion block for an empty-string suggestion", () => {
    const finding = makeFinding({ line: 145, suggestion: "" })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.comments[0]?.body).not.toContain("<details>")
    expect(mapped.comments[0]?.body).not.toContain("```diff")
  })

  it("sizes the suggestion fence beyond any backtick run inside the suggestion", () => {
    const fencedSuggestion = "```md\n-old fence\n+new fence\n```"
    const finding = makeFinding({ line: 145, suggestion: fencedSuggestion })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
    })

    expect(mapped.comments[0]?.body).toContain(
      `<details>\n<summary>Suggested fix</summary>\n\n\`\`\`\`diff\n${fencedSuggestion}\n\`\`\`\`\n\n</details>`,
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

    expect(body).toBe(`### Findings beyond the diff

These are in code the changes touch or depend on, outside the diff's line ranges:

- **[medium/correctness]** Whitespace-only keys pass the empty-key guard — \`src/untouched.ts:30\` _(confidence: high)_
  The guard rejects only the exact empty string.
  **Failure scenario:** register(" ", "value") succeeds and the entry is orphaned.

<details>
<summary>Suggested fix</summary>

\`\`\`diff
-old line
+new line
\`\`\`

</details>

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

describe("computeAnchorKey", () => {
  it("returns file:category:line", () => {
    const key = computeAnchorKey(makeFinding())

    expect(key).toBe("src/greeter.ts:correctness:145")
  })

  it("produces a different key when the line differs", () => {
    const keyA = computeAnchorKey(makeFinding({ line: 10 }))
    const keyB = computeAnchorKey(makeFinding({ line: 20 }))

    expect(keyA).not.toBe(keyB)
  })

  it("produces the same key regardless of title", () => {
    const keyA = computeAnchorKey(makeFinding({ title: "Bug A" }))
    const keyB = computeAnchorKey(makeFinding({ title: "Bug B" }))

    expect(keyA).toBe(keyB)
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

const anchorSource = (
  body: string,
  positions: { line?: number | null; originalLine?: number | null } = {},
): AnchorSource => ({
  body,
  line: positions.line ?? null,
  originalLine: positions.originalLine ?? null,
})

describe("extractAnchors", () => {
  it("prefers the comment's live line over the anchor's embedded line", () => {
    const comments = [
      anchorSource(
        "Some comment body\n\n<!-- umm-actually:src/a.ts:correctness:42 -->",
        { line: 48, originalLine: 42 },
      ),
      anchorSource(
        "Another body\n\n<!-- umm-actually:src/b.ts:security:100 -->",
        { line: 100, originalLine: 100 },
      ),
    ]

    const anchors = extractAnchors(comments)

    expect(anchors).toEqual([
      { file: "src/a.ts", category: "correctness", line: 48 },
      { file: "src/b.ts", category: "security", line: 100 },
    ])
  })

  it("falls back to originalLine when the comment has gone outdated", () => {
    const comments = [
      anchorSource("Body\n\n<!-- umm-actually:src/a.ts:correctness:42 -->", {
        line: null,
        originalLine: 40,
      }),
    ]

    const anchors = extractAnchors(comments)

    expect(anchors).toEqual([
      { file: "src/a.ts", category: "correctness", line: 40 },
    ])
  })

  it("falls back to the anchor's embedded line when both positions are null", () => {
    const comments = [
      anchorSource("Body\n\n<!-- umm-actually:src/a.ts:correctness:42 -->"),
    ]

    const anchors = extractAnchors(comments)

    expect(anchors).toEqual([
      { file: "src/a.ts", category: "correctness", line: 42 },
    ])
  })

  it("skips old-format title-hash keys", () => {
    const comments = [
      anchorSource(
        "Old format\n\n<!-- umm-actually:src/a.ts:correctness:abcd1234 -->",
      ),
      anchorSource("New format\n\n<!-- umm-actually:src/b.ts:security:55 -->"),
    ]

    const anchors = extractAnchors(comments)

    expect(anchors).toEqual([
      { file: "src/b.ts", category: "security", line: 55 },
    ])
  })

  it.each([
    { name: "no colons", key: "garbage" },
    { name: "missing category segment", key: "42" },
    { name: "non-integer line", key: "src/a.ts:correctness:4.2" },
    { name: "zero line", key: "src/a.ts:correctness:0" },
    { name: "negative line", key: "src/a.ts:correctness:-5" },
    { name: "empty line segment", key: "src/a.ts:correctness:" },
  ])("skips a malformed key ($name)", ({ key }) => {
    const comments = [anchorSource(`Body\n\n<!-- umm-actually:${key} -->`)]

    expect(extractAnchors(comments)).toEqual([])
  })

  it("uses only the first anchor when a body contains several", () => {
    const comments = [
      anchorSource(
        "Body\n\n<!-- umm-actually:src/a.ts:correctness:10 -->\n<!-- umm-actually:src/b.ts:security:20 -->",
      ),
    ]

    const anchors = extractAnchors(comments)

    expect(anchors).toEqual([
      { file: "src/a.ts", category: "correctness", line: 10 },
    ])
  })

  it("ignores bodies without anchors", () => {
    const comments = [
      anchorSource("A comment from a human reviewer"),
      anchorSource("CodeRabbit: some finding here"),
      anchorSource(
        "Body with\n\n<!-- umm-actually:src/a.ts:correctness:10 -->",
      ),
    ]

    const anchors = extractAnchors(comments)

    expect(anchors).toEqual([
      { file: "src/a.ts", category: "correctness", line: 10 },
    ])
  })

  it("returns an empty array for an empty input", () => {
    expect(extractAnchors([])).toEqual([])
  })
})

describe("isDuplicateFinding", () => {
  it("matches a finding at the exact same location", () => {
    const anchors = [{ file: "src/a.ts", category: "correctness", line: 50 }]

    expect(
      isDuplicateFinding(
        { file: "src/a.ts", category: "correctness", line: 50 },
        anchors,
      ),
    ).toBe(true)
  })

  it("matches a finding within LINE_PROXIMITY (5) lines", () => {
    const anchors = [{ file: "src/a.ts", category: "correctness", line: 50 }]

    expect(
      isDuplicateFinding(
        { file: "src/a.ts", category: "correctness", line: 55 },
        anchors,
      ),
    ).toBe(true)
    expect(
      isDuplicateFinding(
        { file: "src/a.ts", category: "correctness", line: 45 },
        anchors,
      ),
    ).toBe(true)
  })

  it("rejects a finding beyond LINE_PROXIMITY", () => {
    const anchors = [{ file: "src/a.ts", category: "correctness", line: 50 }]

    expect(
      isDuplicateFinding(
        { file: "src/a.ts", category: "correctness", line: 56 },
        anchors,
      ),
    ).toBe(false)
    expect(
      isDuplicateFinding(
        { file: "src/a.ts", category: "correctness", line: 44 },
        anchors,
      ),
    ).toBe(false)
  })

  it("rejects when file differs", () => {
    const anchors = [{ file: "src/a.ts", category: "correctness", line: 50 }]

    expect(
      isDuplicateFinding(
        { file: "src/b.ts", category: "correctness", line: 50 },
        anchors,
      ),
    ).toBe(false)
  })

  it("rejects when category differs", () => {
    const anchors = [{ file: "src/a.ts", category: "correctness", line: 50 }]

    expect(
      isDuplicateFinding(
        { file: "src/a.ts", category: "security", line: 50 },
        anchors,
      ),
    ).toBe(false)
  })

  it("returns false for empty anchors", () => {
    expect(
      isDuplicateFinding(
        { file: "src/a.ts", category: "correctness", line: 50 },
        [],
      ),
    ).toBe(false)
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
      `${RERUN_ANCHOR}\n\n**umm-actually** re-reviewed at \`abc123d\`\n\n2 new finding(s) posted as inline comments (5 tracked inline finding(s) across all reviews).\n\n---\n*umm-actually · anthropic/claude-sonnet-4-6*`,
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
      `${RERUN_ANCHOR}\n\n**umm-actually** re-reviewed at \`abc123d\`\n\nNo new findings (3 tracked inline finding(s) from prior reviews).\n\n---\n*umm-actually · anthropic/claude-sonnet-4-6*`,
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
