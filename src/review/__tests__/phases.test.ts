import { describe, expect, it } from "vitest"
import {
  CI_WORKFLOW_CHECKS,
  DIMENSION_CODE_QUALITY,
  DIMENSION_CORRECTNESS_SECURITY,
  DIMENSION_SUBTLE_BUGS,
  DIMENSION_TEST_QUALITY,
  REPORTING_RULES,
  resolvePhases,
} from "../phases.js"

describe("resolvePhases", () => {
  it("resolves combined to a single phase carrying all four dimensions plus CI checks and reporting rules", () => {
    const phases = resolvePhases("combined")

    expect(phases).toEqual([
      {
        id: "combined",
        instructionSections: [
          DIMENSION_CORRECTNESS_SECURITY,
          DIMENSION_CODE_QUALITY,
          DIMENSION_TEST_QUALITY,
          DIMENSION_SUBTLE_BUGS,
          CI_WORKFLOW_CHECKS,
          REPORTING_RULES,
        ],
      },
    ])
  })

  it("rejects an unknown phases value with remediation", () => {
    expect(() => resolvePhases("correctness,tests")).toThrow(
      'unknown phases value "correctness,tests" — V1 supports only "combined"',
    )
  })
})

describe("DIMENSION_CORRECTNESS_SECURITY", () => {
  it("includes the unchanged-doc staleness instruction", () => {
    expect(DIMENSION_CORRECTNESS_SECURITY.replace(/\s+/g, " ")).toContain(
      "When unchanged documentation files are provided as context",
    )
    expect(DIMENSION_CORRECTNESS_SECURITY).toContain(
      "stale descriptions, outdated architecture references",
    )
  })

  it("includes the multi-path doc coherence walkthrough with its single-path boundary", () => {
    expect(DIMENSION_CORRECTNESS_SECURITY.replace(/\s+/g, " ")).toContain(
      "walk EACH path through the whole document",
    )
    expect(DIMENSION_CORRECTNESS_SECURITY).toContain(
      "Skip this walkthrough for single-path docs.",
    )
  })

  it("requires widened eligibility checks to preserve the old filter's guarantees", () => {
    expect(DIMENSION_CORRECTNESS_SECURITY.replace(/\s+/g, " ")).toContain(
      "the new branch must preserve the guarantees the old filter implicitly provided",
    )
  })
})

describe("DIMENSION_CODE_QUALITY", () => {
  it("gates immutability findings on readability, exempting honest-loop mutation", () => {
    expect(DIMENSION_CODE_QUALITY.replace(/\s+/g, " ")).toContain(
      "a const-declared Set/array mutated via .add()/.push() in an honest loop is fine",
    )
    expect(DIMENSION_CODE_QUALITY.replace(/\s+/g, " ")).toContain(
      "readability is the deciding gate",
    )
  })

  it("keeps the conventions-file precedence and no-invented-conventions rule", () => {
    expect(DIMENSION_CODE_QUALITY.replace(/\s+/g, " ")).toContain(
      "it wins on conflict, and do not invent project conventions it doesn't state",
    )
  })
})

describe("DIMENSION_TEST_QUALITY", () => {
  it("names all four two-bar traps including wrong-item", () => {
    const normalized = DIMENSION_TEST_QUALITY.replace(/\s+/g, " ")
    expect(normalized).toContain("silent no-op")
    expect(normalized).toContain("wrong-error")
    expect(normalized).toContain("early-return")
    expect(normalized).toContain("wrong-item")
  })

  it("guards against false positives on optional chaining and loop-bounds continue", () => {
    expect(DIMENSION_TEST_QUALITY.replace(/\s+/g, " ")).toContain(
      'Do NOT flag these as violations: "?." array access and "?? fallback"',
    )
    expect(DIMENSION_TEST_QUALITY.replace(/\s+/g, " ")).toContain(
      "type narrowing, not a silent no-op",
    )
  })
})

describe("DIMENSION_SUBTLE_BUGS", () => {
  it("requires mechanism language to be earned by the implementation", () => {
    expect(DIMENSION_SUBTLE_BUGS.replace(/\s+/g, " ")).toContain(
      "Mechanism language must be earned",
    )
    expect(DIMENSION_SUBTLE_BUGS.replace(/\s+/g, " ")).toContain(
      "a per-call fallback is not a state transition",
    )
  })

  it("checks structural self-references in docs against the current document", () => {
    expect(DIMENSION_SUBTLE_BUGS.replace(/\s+/g, " ")).toContain(
      "must resolve against the current document after restructuring",
    )
  })
})

describe("REPORTING_RULES", () => {
  it("bans silent skipping and keeps pre-existing findings reportable", () => {
    const normalized = REPORTING_RULES.replace(/\s+/g, " ")
    expect(normalized).toContain("No silent skipping")
    expect(normalized).toContain('prefix the description "Pre-existing:"')
    expect(normalized).toContain("No environment-specific dismissals")
  })
})
