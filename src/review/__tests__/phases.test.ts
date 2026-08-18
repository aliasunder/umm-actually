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
  it("carries the filesystem containment and symlinked-root rules", () => {
    const normalized = DIMENSION_CORRECTNESS_SECURITY.replace(/\s+/g, " ")
    expect(normalized).toContain("realpath-style containment")
    expect(normalized).toContain(
      "a symlinked search root bypasses per-entry validation",
    )
  })

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
  it("carries the structure triggers beyond immutability — optional chaining, thunks, loops, boolean mode params", () => {
    const normalized = DIMENSION_CODE_QUALITY.replace(/\s+/g, " ")
    expect(normalized).toContain("optional chaining (value?.prop ?? fallback)")
    expect(normalized).toContain("accept T directly")
    expect(normalized).toContain("for...of")
    expect(normalized).toContain(
      "A boolean mode parameter → the function does two things; split it",
    )
  })

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

  it("flags side-effect prefixes on value-returning functions with a call-site boundary", () => {
    const normalized = DIMENSION_CODE_QUALITY.replace(/\s+/g, " ")
    expect(normalized).toContain(
      "Side-effect prefixes (ensure*, check*, init*, setup*)",
    )
    expect(normalized).toContain(
      "keep the prefix when every call site in the provided files ignores the return",
    )
  })

  it("flags manual string surgery when a stdlib parser exists, with Wrong/Right pair", () => {
    const normalized = DIMENSION_CODE_QUALITY.replace(/\s+/g, " ")
    expect(normalized).toContain("Built-ins over manual string surgery")
    expect(normalized).toContain("split/slice/index arithmetic")
    expect(normalized).toContain(
      'Wrong: req.originalUrl.split("?")[0] ?? req.originalUrl',
    )
    expect(normalized).toContain("URL.parse(req.originalUrl")
  })

  it("carries docs and comment concision triggers with a trim-safety boundary", () => {
    const normalized = DIMENSION_CODE_QUALITY.replace(/\s+/g, " ")
    expect(normalized).toContain(
      "Docs and comment concision — name the unnecessary content and the drift",
    )
    expect(normalized).toContain("Doc-comment padding restates the signature")
    expect(normalized).toContain("Rationale duplication:")
    expect(normalized).toContain("never merge two distinct claims into one")
  })
})

describe("DIMENSION_TEST_QUALITY", () => {
  it("names the loose matchers as scan targets and demands the exact derivable value", () => {
    const normalized = DIMENSION_TEST_QUALITY.replace(/\s+/g, " ")
    expect(normalized).toContain(
      "toBeTruthy, toBeDefined, toBeNull, toBeGreaterThanOrEqual(0), toBeGreaterThan(0), expect.anything(), expect.stringMatching, expect.any(, expect.objectContaining,",
    )
    expect(normalized).toContain("the test must assert the exact value")
  })

  it("carries the objectContaining boundary for nondeterministic fields", () => {
    const normalized = DIMENSION_TEST_QUALITY.replace(/\s+/g, " ")
    expect(normalized).toContain(
      "objectContaining boundary: keep when omitted fields are nondeterministic",
    )
    expect(normalized).toContain("not test-owned (third-party params)")
  })

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
  it("carries the SQL, merge-asymmetry, and TOCTOU sub-checks", () => {
    const normalized = DIMENSION_SUBTLE_BUGS.replace(/\s+/g, " ")
    expect(normalized).toContain("COUNT(*) vs COUNT(DISTINCT)")
    expect(normalized).toContain(
      "apply filters and limits equivalently to each source BEFORE merging",
    )
    expect(normalized).toContain("TOCTOU gaps between stat/readdir")
  })

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

describe("CI_WORKFLOW_CHECKS", () => {
  it("carries the bash -e short-circuit and if:-evaluation-time rules", () => {
    const normalized = CI_WORKFLOW_CHECKS.replace(/\s+/g, " ")
    expect(normalized).toContain(
      'a failing "[ test ] && cmd" short-circuit aborts the job',
    )
    expect(normalized).toContain("GitHub evaluates if: before the step runs")
  })
})

describe("REPORTING_RULES", () => {
  it("bans silent skipping and keeps pre-existing findings reportable", () => {
    const normalized = REPORTING_RULES.replace(/\s+/g, " ")
    expect(normalized).toContain("No silent skipping")
    expect(normalized).toContain('prefix the description "Pre-existing:"')
    expect(normalized).toContain("No environment-specific dismissals")
  })

  it("requires same-pattern sweep when a trigger fires, with a scope boundary", () => {
    const normalized = REPORTING_RULES.replace(/\s+/g, " ")
    expect(normalized).toContain(
      "Same-pattern sweep: when a trigger fires on changed code, scan the rest of that file and the provided related files",
    )
    expect(normalized).toContain(
      "sweep the specific pattern that fired, not all dimensions",
    )
  })
})
