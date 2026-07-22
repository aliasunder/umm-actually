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
  changedFilePaths: ["src/greeter.ts"],
  relatedFilePaths: [],
  relatedFilesExcludedPaths: [],
  priorityDocPaths: [],
  mentionMatchedDocPaths: [],
  docsExcludedPaths: [],
  totalFromModel: 3,
  droppedAsNonFinding: 0,
  duplicatesRemoved: 0,
  droppedBelowThreshold: 0,
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
        "#### Context",
        "",
        "| type | count | paths |",
        "| --- | --- | --- |",
        "| Changed files | 1 | src/greeter.ts |",
        "| Related files | 0 | — |",
        "| Priority docs | 0 | — |",
        "| Mention-matched docs | 0 | — |",
        "| Excluded (related files cap) | 0 | — |",
        "| Excluded (docs cap) | 0 | — |",
        "",
        "#### Findings pipeline",
        "",
        "| stage | count |",
        "| --- | --- |",
        "| Raw from model | 3 |",
        "| Dropped as non-findings | 0 |",
        "| Duplicates (cross-run) | 0 |",
        "| Dropped below threshold | 0 |",
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
      mentionMatchedDocPaths: ["docs/api.md"],
      relatedFilesExcludedPaths: ["src/excluded.ts"],
      docsExcludedPaths: ["docs/old.md"],
    })

    expect(summary).toContain("| Changed files | 2 | src/a.ts, src/b.ts |")
    expect(summary).toContain("| Related files | 1 | src/caller.ts |")
    expect(summary).toContain("| Priority docs | 1 | AGENTS.md |")
    expect(summary).toContain("| Mention-matched docs | 1 | docs/api.md |")
    expect(summary).toContain(
      "| Excluded (related files cap) | 1 | src/excluded.ts |",
    )
    expect(summary).toContain("| Excluded (docs cap) | 1 | docs/old.md |")
  })

  it("reflects pipeline losses at each stage", () => {
    const summary = renderReviewSummary({
      ...baseStats,
      totalFromModel: 10,
      droppedAsNonFinding: 2,
      duplicatesRemoved: 3,
      droppedBelowThreshold: 1,
      droppedByCap: 1,
      posted: 3,
    })

    expect(summary).toContain("| Raw from model | 10 |")
    expect(summary).toContain("| Dropped as non-findings | 2 |")
    expect(summary).toContain("| Duplicates (cross-run) | 3 |")
    expect(summary).toContain("| Dropped below threshold | 1 |")
    expect(summary).toContain("| Dropped by cap | 1 |")
    expect(summary).toContain("| **Posted** | **3** |")
  })

  it("truncates the commit SHA to 7 characters", () => {
    const summary = renderReviewSummary(baseStats)

    expect(summary).toContain("`abc123d`")
    expect(summary).not.toContain(baseStats.prContext.headSha)
  })
})
