import { describe, expect, it } from "vitest"
import {
  renderReviewSummary,
  type ReviewSummaryStats,
} from "../review-summary.js"

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
        "**Instructions:** AGENTS.md",
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
        "**Instructions:** AGENTS.md",
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
        "**Instructions:** AGENTS.md",
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
        "| Duplicates (cross-phase) | 2 |",
        "| Duplicates (cross-run) | 3 |",
        "| Dropped below threshold | 1 |",
        "| Dropped as overlapping | 0 |",
        "| Dropped by cap | 1 |",
        "| **Posted** | **3** |",
      ].join("\n"),
    )
  })

  it("renders the budget split when changed files consumed everything", () => {
    const summary = renderReviewSummary({
      ...baseStats,
      tokenBudgetUsedByDiff: 92180,
      tokenBudgetPriorityDocFloor: 154,
      tokenBudgetRemainingForDocs: 154,
    })

    expect(summary).toContain(
      "**Token budget:** 300000 total · 92180 diff · 154 priority-doc floor · 154 left for docs",
    )
  })

  it("renders 'none' when conventionsFile is null", () => {
    const summary = renderReviewSummary({
      ...baseStats,
      conventionsFile: null,
    })

    expect(summary).toContain("**Instructions:** none")
    expect(summary).not.toContain("AGENTS.md")
  })

  it("truncates the commit SHA to 7 characters", () => {
    const summary = renderReviewSummary(baseStats)

    expect(summary).toContain("`abc123d`")
    expect(summary).not.toContain(baseStats.prContext.headSha)
  })

  it("escapes pipe characters in paths so they cannot break the markdown table", () => {
    const summary = renderReviewSummary({
      ...baseStats,
      changedFilePaths: ["src/a|b.ts"],
    })

    expect(summary).toContain("| Changed files | 1 | src/a\\|b.ts |")
    expect(summary).not.toContain("| src/a|b.ts |")
  })
})
