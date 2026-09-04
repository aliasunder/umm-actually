import { describe, expect, it } from "vitest"
import type { CommentableFile } from "../../diff/commentable-lines.js"
import {
  buildStatusComment,
  coalesceAnchors,
  computeAnchorKey,
  extractAnchors,
  isDuplicateFinding,
  mapFindingsToReview,
  renderStandaloneFinding,
  STATUS_ANCHOR,
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
      model: "test/model",
    })

    expect(mapped.bodyFindings).toEqual([])
    // Exact whole-comment assertion: pins the full rendered body format and
    // proves the absence of start_line and of any extra comments
    expect(mapped.comments).toEqual([
      {
        path: "src/greeter.ts",
        line: 145,
        side: "RIGHT",
        body: `**Whitespace-only keys pass the empty-key guard**
Medium severity · correctness · high confidence

The guard rejects only the exact empty string.

**Failure scenario:** register(" ", "value") succeeds and the entry is orphaned.

---
*umm-actually · test/model*

<!-- umm-actually:src/greeter.ts:correctness:145 -->`,
      },
    ])
  })

  it("maps a valid multi-line finding with start_line first and line last, per GitHub's API", () => {
    const finding = makeFinding({ line: 143, end_line: 146 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
      model: "test/model",
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
      model: "test/model",
    })

    expect(mapped.comments[0]).toMatchObject({ line: 145, side: "RIGHT" })
    expect(mapped.comments[0]?.start_line).toBeUndefined()
  })

  it("degrades to a single-line comment when end_line precedes line", () => {
    const finding = makeFinding({ line: 145, end_line: 143 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
      model: "test/model",
    })

    expect(mapped.comments[0]).toMatchObject({ line: 145, side: "RIGHT" })
    expect(mapped.comments[0]?.start_line).toBeUndefined()
  })

  it("degrades to a single-line comment when end_line is not a commentable line", () => {
    const finding = makeFinding({ line: 145, end_line: 200 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
      model: "test/model",
    })

    expect(mapped.comments[0]).toMatchObject({ line: 145, side: "RIGHT" })
    expect(mapped.comments[0]?.start_line).toBeUndefined()
  })

  it("degrades to a single-line comment when end_line falls in a different hunk", () => {
    const finding = makeFinding({ line: 5, end_line: 142 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
      model: "test/model",
    })

    expect(mapped.comments[0]).toMatchObject({ line: 5, side: "RIGHT" })
    expect(mapped.comments[0]?.start_line).toBeUndefined()
  })

  it("snaps a near-miss line to the nearest commentable line and notes the original", () => {
    const finding = makeFinding({ line: 149 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
      model: "test/model",
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
      model: "test/model",
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
      model: "test/model",
    })

    expect(mapped.comments).toEqual([])
    expect(mapped.bodyFindings).toEqual([finding])
  })

  it("routes a finding one line beyond SNAP_DISTANCE to the review body", () => {
    const finding = makeFinding({ line: 151 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
      model: "test/model",
    })

    expect(mapped.comments).toEqual([])
    expect(mapped.bodyFindings).toEqual([finding])
  })

  it("routes a finding in a file outside the diff to the review body", () => {
    const finding = makeFinding({ file: "src/untouched.ts", line: 30 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
      model: "test/model",
    })

    expect(mapped.comments).toEqual([])
    expect(mapped.bodyFindings).toEqual([finding])
  })

  it("routes a finding far outside every hunk to the review body", () => {
    const finding = makeFinding({ line: 400 })

    const mapped = mapFindingsToReview({
      findings: [finding],
      commentableByPath: makeCommentableByPath(),
      model: "test/model",
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
      model: "test/model",
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
      model: "test/model",
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
      model: "test/model",
    })

    expect(mapped.comments[0]?.body).toContain(
      `<details>\n<summary>Suggested fix</summary>\n\n\`\`\`\`diff\n${fencedSuggestion}\n\`\`\`\`\n\n</details>`,
    )
  })
})

describe("renderStandaloneFinding", () => {
  it("renders the full finding block with location note and anchor", () => {
    const finding = makeFinding({ file: "src/untouched.ts", line: 30 })

    const body = renderStandaloneFinding(finding, "test/model")

    expect(body).toBe(`**Whitespace-only keys pass the empty-key guard**
Medium severity · correctness · high confidence

\`src/untouched.ts:30\` — beyond the diff's line ranges, in code the changes touch or depend on.

The guard rejects only the exact empty string.

**Failure scenario:** register(" ", "value") succeeds and the entry is orphaned.

---
*umm-actually · test/model*

<!-- umm-actually:src/untouched.ts:correctness:30 -->`)
  })

  it("humanizes multi-word category slugs in the header but keeps the raw slug in the anchor", () => {
    const finding = makeFinding({
      file: "src/untouched.ts",
      line: 30,
      category: "subtle_bugs",
    })

    const body = renderStandaloneFinding(finding, "test/model")

    expect(body).toContain("Medium severity · subtle bugs · high confidence")
    expect(body).toContain(
      "<!-- umm-actually:src/untouched.ts:subtle_bugs:30 -->",
    )
  })

  it("renders the suggestion fence between failure scenario and anchor", () => {
    const finding = makeFinding({
      file: "src/untouched.ts",
      line: 30,
      suggestion: "-old line\n+new line",
    })

    const body = renderStandaloneFinding(finding, "test/model")

    expect(body).toBe(`**Whitespace-only keys pass the empty-key guard**
Medium severity · correctness · high confidence

\`src/untouched.ts:30\` — beyond the diff's line ranges, in code the changes touch or depend on.

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
*umm-actually · test/model*

<!-- umm-actually:src/untouched.ts:correctness:30 -->`)
  })
})

describe("buildStatusComment", () => {
  it("renders a first run with findings", () => {
    const body = buildStatusComment({
      sha: "abc123def456abc123def456abc123def456abc1",
      isFirstRun: true,
      postedCount: 2,
      unpostedCount: 0,
      totalCount: 2,
      droppedByCap: [],
      model: "anthropic/claude-sonnet-4-6",
    })

    expect(body).toBe(
      `${STATUS_ANCHOR}\n\n**umm-actually** reviewed at \`abc123d\`\n\n2 new finding(s) posted (2 tracked finding(s) across all runs).\n\n---\n*umm-actually · anthropic/claude-sonnet-4-6*`,
    )
  })

  it("renders a clean first run", () => {
    const body = buildStatusComment({
      sha: "abc123def456abc123def456abc123def456abc1",
      isFirstRun: true,
      postedCount: 0,
      unpostedCount: 0,
      totalCount: 0,
      droppedByCap: [],
      model: "anthropic/claude-sonnet-4-6",
    })

    expect(body).toBe(
      `${STATUS_ANCHOR}\n\n**umm-actually** reviewed at \`abc123d\`\n\nNo findings above threshold.\n\n---\n*umm-actually · anthropic/claude-sonnet-4-6*`,
    )
  })

  it("renders a re-run with new findings", () => {
    const body = buildStatusComment({
      sha: "abc123def456abc123def456abc123def456abc1",
      isFirstRun: false,
      postedCount: 1,
      unpostedCount: 0,
      totalCount: 5,
      droppedByCap: [],
      model: "anthropic/claude-sonnet-4-6",
    })

    expect(body).toBe(
      `${STATUS_ANCHOR}\n\n**umm-actually** re-reviewed at \`abc123d\`\n\n1 new finding(s) posted (5 tracked finding(s) across all runs).\n\n---\n*umm-actually · anthropic/claude-sonnet-4-6*`,
    )
  })

  it("renders a re-run with no new findings", () => {
    const body = buildStatusComment({
      sha: "abc123def456abc123def456abc123def456abc1",
      isFirstRun: false,
      postedCount: 0,
      unpostedCount: 0,
      totalCount: 3,
      droppedByCap: [],
      model: "anthropic/claude-sonnet-4-6",
    })

    expect(body).toBe(
      `${STATUS_ANCHOR}\n\n**umm-actually** re-reviewed at \`abc123d\`\n\nNo new findings (3 tracked finding(s) across all runs).\n\n---\n*umm-actually · anthropic/claude-sonnet-4-6*`,
    )
  })

  it("reports unposted findings instead of claiming they were posted", () => {
    const body = buildStatusComment({
      sha: "abc123def456abc123def456abc123def456abc1",
      isFirstRun: true,
      postedCount: 0,
      unpostedCount: 3,
      totalCount: 0,
      droppedByCap: [],
      model: "anthropic/claude-sonnet-4-6",
    })

    expect(body).toBe(
      `${STATUS_ANCHOR}\n\n**umm-actually** reviewed at \`abc123d\`\n\nNo new findings posted (0 tracked finding(s) across all runs).\n\n_3 finding(s) could not be posted — they will re-report on the next run._\n\n---\n*umm-actually · anthropic/claude-sonnet-4-6*`,
    )
  })

  it("includes the cap note when findings were dropped", () => {
    const body = buildStatusComment({
      sha: "abc123def456abc123def456abc123def456abc1",
      isFirstRun: true,
      postedCount: 1,
      unpostedCount: 0,
      totalCount: 1,
      droppedByCap: [makeFinding({ file: "src/greeter.ts", line: 5 })],
      model: "anthropic/claude-sonnet-4-6",
    })

    expect(body).toBe(
      `${STATUS_ANCHOR}\n\n**umm-actually** reviewed at \`abc123d\`\n\n1 new finding(s) posted (1 tracked finding(s) across all runs).\n\n_1 lower-severity finding(s) omitted by the max_findings cap: \`src/greeter.ts:5\`_\n\n---\n*umm-actually · anthropic/claude-sonnet-4-6*`,
    )
  })

  it("renders a collapsible context notes section when contextNotes are provided", () => {
    const body = buildStatusComment({
      sha: "abc123def456abc123def456abc123def456abc1",
      isFirstRun: true,
      postedCount: 2,
      unpostedCount: 0,
      totalCount: 2,
      droppedByCap: [],
      model: "anthropic/claude-sonnet-4-6",
      contextNotes: [
        "Priority docs not included: `README.md` (missing, unreadable, or over budget)",
        "2 related file(s) excluded by `max_related_files` cap: `src/a.ts`, `src/b.ts`",
      ],
    })

    expect(body).toBe(
      `${STATUS_ANCHOR}\n\n**umm-actually** reviewed at \`abc123d\`\n\n2 new finding(s) posted (2 tracked finding(s) across all runs).\n\n<details>\n<summary>Context notes</summary>\n\n- Priority docs not included: \`README.md\` (missing, unreadable, or over budget)\n- 2 related file(s) excluded by \`max_related_files\` cap: \`src/a.ts\`, \`src/b.ts\`\n\n</details>\n\n---\n*umm-actually · anthropic/claude-sonnet-4-6*`,
    )
  })

  it("omits the context notes section when contextNotes is empty", () => {
    const body = buildStatusComment({
      sha: "abc123def456abc123def456abc123def456abc1",
      isFirstRun: true,
      postedCount: 0,
      unpostedCount: 0,
      totalCount: 0,
      droppedByCap: [],
      model: "anthropic/claude-sonnet-4-6",
      contextNotes: [],
    })

    expect(body).toBe(
      `${STATUS_ANCHOR}\n\n**umm-actually** reviewed at \`abc123d\`\n\nNo findings above threshold.\n\n---\n*umm-actually · anthropic/claude-sonnet-4-6*`,
    )
  })

  it("omits the context notes section when contextNotes is not provided", () => {
    const withExplicitEmpty = buildStatusComment({
      sha: "abc123def456abc123def456abc123def456abc1",
      isFirstRun: true,
      postedCount: 0,
      unpostedCount: 0,
      totalCount: 0,
      droppedByCap: [],
      model: "anthropic/claude-sonnet-4-6",
      contextNotes: [],
    })

    const withoutParam = buildStatusComment({
      sha: "abc123def456abc123def456abc123def456abc1",
      isFirstRun: true,
      postedCount: 0,
      unpostedCount: 0,
      totalCount: 0,
      droppedByCap: [],
      model: "anthropic/claude-sonnet-4-6",
    })

    expect(withExplicitEmpty).toBe(withoutParam)
    expect(withoutParam).not.toContain("Context notes")
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
      { file: "src/a.ts", category: "correctness", line: 48, title: undefined },
      { file: "src/b.ts", category: "security", line: 100, title: undefined },
    ])
  })

  it("still finds the anchor behind the model attribution on a rendered comment", () => {
    const body = renderStandaloneFinding(
      makeFinding({ file: "src/untouched.ts", line: 30 }),
      "test/model",
    )

    const anchors = extractAnchors([anchorSource(body)])

    expect(anchors).toEqual([
      {
        file: "src/untouched.ts",
        category: "correctness",
        line: 30,
        title: "Whitespace-only keys pass the empty-key guard",
      },
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
      { file: "src/a.ts", category: "correctness", line: 40, title: undefined },
    ])
  })

  it("falls back to the anchor's embedded line when both positions are null", () => {
    const comments = [
      anchorSource("Body\n\n<!-- umm-actually:src/a.ts:correctness:42 -->"),
    ]

    const anchors = extractAnchors(comments)

    expect(anchors).toEqual([
      { file: "src/a.ts", category: "correctness", line: 42, title: undefined },
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
      { file: "src/b.ts", category: "security", line: 55, title: undefined },
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

  it("uses the trailing anchor when the body quotes another anchor earlier", () => {
    const comments = [
      anchorSource(
        "Body quoting <!-- umm-actually:src/a.ts:correctness:10 -->\n\n<!-- umm-actually:src/b.ts:security:20 -->",
      ),
    ]

    const anchors = extractAnchors(comments)

    expect(anchors).toEqual([
      { file: "src/b.ts", category: "security", line: 20, title: undefined },
    ])
  })

  it("ignores an anchor-shaped string that is not at the end of the body", () => {
    const comments = [
      anchorSource(
        "Quoting <!-- umm-actually:src/a.ts:correctness:10 --> mid-body",
      ),
    ]

    expect(extractAnchors(comments)).toEqual([])
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
      { file: "src/a.ts", category: "correctness", line: 10, title: undefined },
    ])
  })

  it("extracts the bold title from a rendered comment body", () => {
    const comments = [
      anchorSource(
        "**Null dereference on user.email**\nMedium severity · correctness · high confidence\n\nDescription here.\n\n<!-- umm-actually:src/a.ts:correctness:42 -->",
      ),
    ]

    const anchors = extractAnchors(comments)

    expect(anchors).toEqual([
      {
        file: "src/a.ts",
        category: "correctness",
        line: 42,
        title: "Null dereference on user.email",
      },
    ])
  })

  it("returns title as undefined when the body has no bold header", () => {
    const comments = [
      anchorSource(
        "Plain text body\n\n<!-- umm-actually:src/a.ts:correctness:42 -->",
      ),
    ]

    const anchors = extractAnchors(comments)

    expect(anchors).toEqual([
      { file: "src/a.ts", category: "correctness", line: 42, title: undefined },
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

  // --- Content dedup layer ---

  it("matches via content: same file, similar title, line within 50, different category", () => {
    const anchors = [
      {
        file: "src/a.ts",
        category: "correctness",
        line: 50,
        title: "Missing null check on user.email before toLowerCase",
      },
    ]

    expect(
      isDuplicateFinding(
        {
          file: "src/a.ts",
          category: "subtle_bugs",
          line: 70,
          title: "Null check missing on user.email toLowerCase call",
        },
        anchors,
      ),
    ).toBe(true)
  })

  it("rejects content match when title similarity is below threshold", () => {
    const anchors = [
      {
        file: "src/a.ts",
        category: "correctness",
        line: 50,
        title: "Missing null check on user.email",
      },
    ]

    expect(
      isDuplicateFinding(
        {
          file: "src/a.ts",
          category: "correctness",
          line: 70,
          title: "Race condition in async handler",
        },
        anchors,
      ),
    ).toBe(false)
  })

  it("rejects content match when line distance exceeds 50", () => {
    const anchors = [
      {
        file: "src/a.ts",
        category: "correctness",
        line: 50,
        title: "Missing null check on user.email",
      },
    ]

    expect(
      isDuplicateFinding(
        {
          file: "src/a.ts",
          category: "correctness",
          line: 101,
          title: "Missing null check on user.email",
        },
        anchors,
      ),
    ).toBe(false)
  })

  it("skips content match when the finding has no title", () => {
    const anchors = [
      {
        file: "src/a.ts",
        category: "correctness",
        line: 50,
        title: "Missing null check",
      },
    ]

    expect(
      isDuplicateFinding(
        { file: "src/a.ts", category: "security", line: 55 },
        anchors,
      ),
    ).toBe(false)
  })

  it("skips content match when the anchor has no title", () => {
    const anchors = [{ file: "src/a.ts", category: "correctness", line: 50 }]

    expect(
      isDuplicateFinding(
        {
          file: "src/a.ts",
          category: "security",
          line: 55,
          title: "Missing null check",
        },
        anchors,
      ),
    ).toBe(false)
  })

  it("matches via content at exactly CONTENT_LINE_PROXIMITY (50 lines apart)", () => {
    const anchors = [
      {
        file: "src/a.ts",
        category: "correctness",
        line: 50,
        title: "Missing null check on user.email",
      },
    ]

    expect(
      isDuplicateFinding(
        {
          file: "src/a.ts",
          category: "subtle_bugs",
          line: 100,
          title: "Missing null check on user.email",
        },
        anchors,
      ),
    ).toBe(true)
  })

  it("matches via content at exactly CONTENT_SIMILARITY_THRESHOLD (Jaccard 0.5)", () => {
    const anchors = [
      {
        file: "src/a.ts",
        category: "correctness",
        line: 50,
        title: "alpha beta gamma",
      },
    ]

    expect(
      isDuplicateFinding(
        {
          file: "src/a.ts",
          category: "subtle_bugs",
          line: 55,
          title: "alpha beta delta",
        },
        anchors,
      ),
    ).toBe(true)
  })

  it("rejects content match when file differs", () => {
    const anchors = [
      {
        file: "src/a.ts",
        category: "correctness",
        line: 50,
        title: "Missing null check on user.email",
      },
    ]

    expect(
      isDuplicateFinding(
        {
          file: "src/b.ts",
          category: "correctness",
          line: 50,
          title: "Missing null check on user.email",
        },
        anchors,
      ),
    ).toBe(false)
  })
})

describe("coalesceAnchors", () => {
  it("collapses anchors within LINE_PROXIMITY into the first one", () => {
    const anchors = [
      { file: "src/a.ts", category: "correctness", line: 50 },
      { file: "src/a.ts", category: "correctness", line: 53 },
    ]

    expect(coalesceAnchors(anchors)).toEqual([
      { file: "src/a.ts", category: "correctness", line: 50 },
    ])
  })

  it("keeps anchors beyond LINE_PROXIMITY as distinct findings", () => {
    const anchors = [
      { file: "src/a.ts", category: "correctness", line: 50 },
      { file: "src/a.ts", category: "correctness", line: 56 },
    ]

    expect(coalesceAnchors(anchors)).toEqual(anchors)
  })

  it("keeps same-line anchors that differ in file or category", () => {
    const anchors = [
      { file: "src/a.ts", category: "correctness", line: 50 },
      { file: "src/b.ts", category: "correctness", line: 50 },
      { file: "src/a.ts", category: "security", line: 50 },
    ]

    expect(coalesceAnchors(anchors)).toEqual(anchors)
  })

  it("keeps content-similar anchors across different categories as distinct findings", () => {
    const anchors = [
      {
        file: "src/a.ts",
        category: "correctness",
        line: 50,
        title: "Missing null check on user.email",
      },
      {
        file: "src/a.ts",
        category: "subtle_bugs",
        line: 55,
        title: "Missing null check on user.email",
      },
    ]

    expect(coalesceAnchors(anchors)).toEqual(anchors)
  })

  it("returns an empty array for no anchors", () => {
    expect(coalesceAnchors([])).toEqual([])
  })
})

describe("buildStatusComment — anchor and sha handling", () => {
  it("truncates the sha to 7 characters", () => {
    const body = buildStatusComment({
      sha: "0000000999999",
      isFirstRun: true,
      postedCount: 1,
      unpostedCount: 0,
      totalCount: 1,
      droppedByCap: [],
      model: "test/model",
    })

    expect(body).toContain("`0000000`")
    expect(body).not.toContain("999999")
  })

  it("starts with the status anchor for upsert detection", () => {
    const body = buildStatusComment({
      sha: "abc123d",
      isFirstRun: false,
      postedCount: 0,
      unpostedCount: 0,
      totalCount: 0,
      droppedByCap: [],
      model: "test/model",
    })

    expect(body.startsWith(STATUS_ANCHOR)).toBe(true)
  })
})
