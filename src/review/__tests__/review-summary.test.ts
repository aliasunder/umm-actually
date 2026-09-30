import { describe, expect, it } from "vitest"
import { renderReviewSummary, type ReviewSummaryStats } from "../review-summary.js"

const baseStats: ReviewSummaryStats = {
  prContext: {
    prNumber: 7,
    title: "feat: trim names",
    body: "Trims whitespace.",
    headSha: "abc123def456abc123def456abc123def456abc1",
    headRef: "feat/trim-names",
    baseRef: "main",
  },
  conventionsFile: "AGENTS.md",
  conventionsCoverage: { status: "full", characterCap: 32000, totalCharacters: 1200 },
  phasesCompleted: ["combined"],
  phasesIncomplete: [],
  changedFilePaths: ["src/greeter.ts"],
  relatedFilePaths: [],
  relatedFilesExcludedPaths: [],
  priorityDocPaths: [],
  priorityDocsInContextPaths: [],
  priorityDocsAbsentPaths: [],
  mentionMatchedDocPaths: [],
  docsExcludedPaths: [],
  tokenBudgetTotal: 300000,
  tokenBudgetUsedByDiff: 12000,
  tokenBudgetPriorityDocFloor: 30000,
  tokenBudgetRemainingForDocs: 250000,
  totalFromModel: 3,
  droppedAsNonFinding: 0,
  droppedAsUnknownFile: 0,
  droppedAsExcludedFile: 0,
  duplicatesAcrossPhases: 0,
  duplicatesRemoved: 0,
  droppedBelowThreshold: 0,
  droppedAsOverlapping: 0,
  droppedByCap: 0,
  posted: 3,
}

describe("renderReviewSummary", () => {
  it("renders the full summary with context and pipeline tables", () => {
    const summary = renderReviewSummary(baseStats)

    expect(summary).toBe(
      [
        "### umm-actually review summary",
        "",
        "PR #7 · `feat/trim-names` → `main` · `abc123d`",
        "",
        "**Conventions:** AGENTS.md (1200 characters, within the 32000-character cap)",
        "",
        "**Phases:** combined",
        "",
        "#### Context",
        "",
        "| type | count | paths |",
        "| --- | --- | --- |",
        "| Changed files | 1 | src/greeter.ts |",
        "| Related files | 0 | — |",
        "| Priority docs | 0 | — |",
        "| Priority docs (already in context) | 0 | — |",
        "| Priority docs (not included) | 0 | — |",
        "| Mention-matched docs | 0 | — |",
        "| Excluded (related files cap) | 0 | — |",
        "| Excluded (docs cap) | 0 | — |",
        "",
        "**Token budget:** 300000 total · 12000 diff · 30000 priority-doc floor · 250000 left for docs",
        "",
        "#### Findings pipeline",
        "",
        "| stage | count |",
        "| --- | --- |",
        "| Raw from model | 3 |",
        "| Dropped as non-findings | 0 |",
        "| Dropped as unknown file | 0 |",
        "| Dropped as excluded file | 0 |",
        "| Duplicates (cross-phase) | 0 |",
        "| Duplicates (cross-run) | 0 |",
        "| Dropped below threshold | 0 |",
        "| Dropped as overlapping | 0 |",
        "| Dropped by cap | 0 |",
        "| **Posted** | **3** |",
      ].join("\n"),
    )
  })

  it("lists paths for populated context fields", () => {
    const summary = renderReviewSummary({
      ...baseStats,
      changedFilePaths: ["src/a.ts", "src/b.ts"],
      relatedFilePaths: ["src/caller.ts"],
      priorityDocPaths: ["AGENTS.md"],
      priorityDocsInContextPaths: ["README.md"],
      priorityDocsAbsentPaths: ["SECURITY.md", "deploy/README.md"],
      mentionMatchedDocPaths: ["docs/api.md"],
      relatedFilesExcludedPaths: ["src/excluded.ts"],
      docsExcludedPaths: ["docs/old.md"],
    })

    expect(summary).toBe(
      [
        "### umm-actually review summary",
        "",
        "PR #7 · `feat/trim-names` → `main` · `abc123d`",
        "",
        "**Conventions:** AGENTS.md (1200 characters, within the 32000-character cap)",
        "",
        "**Phases:** combined",
        "",
        "#### Context",
        "",
        "| type | count | paths |",
        "| --- | --- | --- |",
        "| Changed files | 2 | src/a.ts, src/b.ts |",
        "| Related files | 1 | src/caller.ts |",
        "| Priority docs | 1 | AGENTS.md |",
        "| Priority docs (already in context) | 1 | README.md |",
        "| Priority docs (not included) | 2 | SECURITY.md, deploy/README.md |",
        "| Mention-matched docs | 1 | docs/api.md |",
        "| Excluded (related files cap) | 1 | src/excluded.ts |",
        "| Excluded (docs cap) | 1 | docs/old.md |",
        "",
        "**Token budget:** 300000 total · 12000 diff · 30000 priority-doc floor · 250000 left for docs",
        "",
        "#### Findings pipeline",
        "",
        "| stage | count |",
        "| --- | --- |",
        "| Raw from model | 3 |",
        "| Dropped as non-findings | 0 |",
        "| Dropped as unknown file | 0 |",
        "| Dropped as excluded file | 0 |",
        "| Duplicates (cross-phase) | 0 |",
        "| Duplicates (cross-run) | 0 |",
        "| Dropped below threshold | 0 |",
        "| Dropped as overlapping | 0 |",
        "| Dropped by cap | 0 |",
        "| **Posted** | **3** |",
      ].join("\n"),
    )
  })

  it("reflects pipeline losses at each stage", () => {
    const summary = renderReviewSummary({
      ...baseStats,
      totalFromModel: 11,
      droppedAsNonFinding: 2,
      droppedAsUnknownFile: 1,
      duplicatesAcrossPhases: 2,
      duplicatesRemoved: 3,
      droppedBelowThreshold: 1,
      droppedAsOverlapping: 0,
      droppedByCap: 1,
      posted: 3,
    })

    expect(summary).toBe(
      [
        "### umm-actually review summary",
        "",
        "PR #7 · `feat/trim-names` → `main` · `abc123d`",
        "",
        "**Conventions:** AGENTS.md (1200 characters, within the 32000-character cap)",
        "",
        "**Phases:** combined",
        "",
        "#### Context",
        "",
        "| type | count | paths |",
        "| --- | --- | --- |",
        "| Changed files | 1 | src/greeter.ts |",
        "| Related files | 0 | — |",
        "| Priority docs | 0 | — |",
        "| Priority docs (already in context) | 0 | — |",
        "| Priority docs (not included) | 0 | — |",
        "| Mention-matched docs | 0 | — |",
        "| Excluded (related files cap) | 0 | — |",
        "| Excluded (docs cap) | 0 | — |",
        "",
        "**Token budget:** 300000 total · 12000 diff · 30000 priority-doc floor · 250000 left for docs",
        "",
        "#### Findings pipeline",
        "",
        "| stage | count |",
        "| --- | --- |",
        "| Raw from model | 11 |",
        "| Dropped as non-findings | 2 |",
        "| Dropped as unknown file | 1 |",
        "| Dropped as excluded file | 0 |",
        "| Duplicates (cross-phase) | 2 |",
        "| Duplicates (cross-run) | 3 |",
        "| Dropped below threshold | 1 |",
        "| Dropped as overlapping | 0 |",
        "| Dropped by cap | 1 |",
        "| **Posted** | **3** |",
      ].join("\n"),
    )
  })

  it("reports excluded-file drops on their own row next to unknown-file drops", () => {
    const summary = renderReviewSummary({
      ...baseStats,
      totalFromModel: 6,
      droppedAsUnknownFile: 1,
      droppedAsExcludedFile: 2,
      posted: 3,
    })

    expect(summary).toContain(
      [
        "#### Findings pipeline",
        "",
        "| stage | count |",
        "| --- | --- |",
        "| Raw from model | 6 |",
        "| Dropped as non-findings | 0 |",
        "| Dropped as unknown file | 1 |",
        "| Dropped as excluded file | 2 |",
        "| Duplicates (cross-phase) | 0 |",
        "| Duplicates (cross-run) | 0 |",
        "| Dropped below threshold | 0 |",
        "| Dropped as overlapping | 0 |",
        "| Dropped by cap | 0 |",
        "| **Posted** | **3** |",
      ].join("\n"),
    )
  })

  it.each([false, true])(
    "lists phase coverage and reports deadline expiry when reviewDeadlineExceeded is %s",
    (reviewDeadlineExceeded) => {
      const summary = renderReviewSummary({
        ...baseStats,
        phasesCompleted: ["correctness-security", "conventions-tests"],
        phasesIncomplete: ["subtle-bugs"],
        reviewDeadlineExceeded,
      })

      expect(summary).toBe(
        [
          "### umm-actually review summary",
          "",
          "PR #7 · `feat/trim-names` → `main` · `abc123d`",
          "",
          "**Conventions:** AGENTS.md (1200 characters, within the 32000-character cap)",
          "",
          "**Phases:** correctness-security, conventions-tests · incomplete: subtle-bugs",
          ...(reviewDeadlineExceeded
            ? ["", "The review deadline expired; results from completed phases are shown."]
            : []),
          "",
          "#### Context",
          "",
          "| type | count | paths |",
          "| --- | --- | --- |",
          "| Changed files | 1 | src/greeter.ts |",
          "| Related files | 0 | — |",
          "| Priority docs | 0 | — |",
          "| Priority docs (already in context) | 0 | — |",
          "| Priority docs (not included) | 0 | — |",
          "| Mention-matched docs | 0 | — |",
          "| Excluded (related files cap) | 0 | — |",
          "| Excluded (docs cap) | 0 | — |",
          "",
          "**Token budget:** 300000 total · 12000 diff · 30000 priority-doc floor · 250000 left for docs",
          "",
          "#### Findings pipeline",
          "",
          "| stage | count |",
          "| --- | --- |",
          "| Raw from model | 3 |",
          "| Dropped as non-findings | 0 |",
          "| Dropped as unknown file | 0 |",
          "| Dropped as excluded file | 0 |",
          "| Duplicates (cross-phase) | 0 |",
          "| Duplicates (cross-run) | 0 |",
          "| Dropped below threshold | 0 |",
          "| Dropped as overlapping | 0 |",
          "| Dropped by cap | 0 |",
          "| **Posted** | **3** |",
        ].join("\n"),
      )
    },
  )

  it("renders the budget split when changed files consumed everything", () => {
    const summary = renderReviewSummary({
      ...baseStats,
      tokenBudgetUsedByDiff: 92180,
      tokenBudgetPriorityDocFloor: 154,
      tokenBudgetRemainingForDocs: 154,
    })

    expect(summary.split("\n")[21]).toBe(
      "**Token budget:** 300000 total · 92180 diff · 154 priority-doc floor · 154 left for docs",
    )
  })

  it("renders 'none' when the conventions file was not found", () => {
    const summary = renderReviewSummary({
      ...baseStats,
      conventionsCoverage: { status: "not-found" },
    })

    expect(summary.split("\n")[4]).toBe("**Conventions:** none")
    expect(summary).not.toContain("AGENTS.md")
  })

  it.each([
    {
      label: "no full copy",
      fullCopyChannel: null,
      expected:
        "**Conventions:** AGENTS.md (truncated to 4000 of 14991 characters; no full copy reached the model)",
    },
    {
      label: "a priority-doc copy",
      fullCopyChannel: "priority-docs",
      expected:
        "**Conventions:** AGENTS.md (sent in full as a priority doc; its 14991 characters exceed the 4000-character section cap)",
    },
    {
      label: "a changed-file copy",
      fullCopyChannel: "changed-files",
      expected:
        "**Conventions:** AGENTS.md (truncated to 4000 of 14991 characters; full copy in changed files)",
    },
    {
      label: "a related-file copy",
      fullCopyChannel: "related-files",
      expected:
        "**Conventions:** AGENTS.md (truncated to 4000 of 14991 characters; full copy in related files)",
    },
    {
      label: "an added-file diff",
      fullCopyChannel: "added-in-diff",
      expected:
        "**Conventions:** AGENTS.md (truncated to 4000 of 14991 characters; full copy in the diff of the added file)",
    },
  ] as const)(
    "reports a truncated conventions file with $label",
    ({ fullCopyChannel, expected }) => {
      const summary = renderReviewSummary({
        ...baseStats,
        conventionsCoverage: {
          status: "truncated",
          fullCopyChannel,
          characterCap: 4000,
          totalCharacters: 14991,
        },
      })

      expect(summary.split("\n")[4]).toBe(expected)
    },
  )

  it("truncates the commit SHA to 7 characters", () => {
    const summary = renderReviewSummary(baseStats)

    expect(summary.split("\n")[2]).toBe("PR #7 · `feat/trim-names` → `main` · `abc123d`")
    expect(summary).not.toContain(baseStats.prContext.headSha)
  })

  it("escapes pipe characters in paths so they cannot break the markdown table", () => {
    const summary = renderReviewSummary({
      ...baseStats,
      changedFilePaths: ["src/a|b.ts"],
    })

    expect(summary.split("\n")[12]).toBe("| Changed files | 1 | src/a\\|b.ts |")
    expect(summary).not.toContain("| src/a|b.ts |")
  })
})
