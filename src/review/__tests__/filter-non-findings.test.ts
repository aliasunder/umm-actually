import { describe, expect, it } from "vitest"
import { filterNonFindings } from "../filter-non-findings.js"
import { makeFinding } from "./make-finding.js"

describe("filterNonFindings", () => {
  // --- Prefix patterns that should be dropped ---

  it("drops a finding whose failure_scenario starts with 'N/A'", () => {
    const finding = makeFinding({
      failure_scenario: "N/A — tests are valid.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose failure_scenario starts with 'n/a' (case-insensitive)", () => {
    const finding = makeFinding({
      failure_scenario: "n/a — Zod validation catches malformed responses.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose failure_scenario starts with 'NA' (no slash)", () => {
    const finding = makeFinding({
      failure_scenario: "NA — the code handles this edge case.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose failure_scenario starts with 'Not applicable'", () => {
    const finding = makeFinding({
      failure_scenario: "Not applicable — the code handles this edge case.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose failure_scenario starts with 'Placeholder'", () => {
    const finding = makeFinding({
      failure_scenario: "Placeholder — re-evaluating.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  // --- Passthrough: real findings must not be dropped ---

  it("keeps a finding with a concrete failure scenario", () => {
    const finding = makeFinding({
      failure_scenario:
        "A CI step that gates deployment reads the env var, but the value is never set in the matrix.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [finding], droppedAsNonFinding: 0 })
  })

  it("keeps a finding that mentions 'by design' as a qualifier", () => {
    const finding = makeFinding({
      failure_scenario:
        "The function returns null by design, but the caller never null-checks.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [finding], droppedAsNonFinding: 0 })
  })

  it("keeps a finding that mentions 'this is correct' as a qualifier", () => {
    const finding = makeFinding({
      failure_scenario:
        "This is correct for ASCII but breaks on multi-byte UTF-8.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [finding], droppedAsNonFinding: 0 })
  })

  it("keeps a finding starting with 'None of'", () => {
    const finding = makeFinding({
      failure_scenario: "None of the guards catch this input.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [finding], droppedAsNonFinding: 0 })
  })

  it("keeps all findings when none are non-findings", () => {
    const findings = [
      makeFinding({
        line: 1,
        failure_scenario:
          'register(" ", "value") succeeds and the entry is orphaned.',
      }),
      makeFinding({
        line: 10,
        failure_scenario:
          "A user configures the threshold to 'extreme' and the action crashes.",
      }),
    ]

    const result = filterNonFindings(findings)

    expect(result).toEqual({ findings, droppedAsNonFinding: 0 })
  })

  // --- Mixed and edge cases ---

  it("returns empty findings when all findings are non-findings", () => {
    const findings = [
      makeFinding({ line: 1, failure_scenario: "N/A — tests are valid." }),
      makeFinding({
        line: 2,
        failure_scenario: "Not applicable — already handled.",
      }),
    ]

    const result = filterNonFindings(findings)

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 2 })
  })

  it("filters selectively in a mixed set of findings", () => {
    const realFinding = makeFinding({
      line: 1,
      failure_scenario:
        'register(" ", "value") succeeds and the entry is orphaned.',
    })
    const nonFinding = makeFinding({
      line: 2,
      failure_scenario: "N/A — this is correct behavior.",
    })

    const result = filterNonFindings([realFinding, nonFinding])

    expect(result).toEqual({
      findings: [realFinding],
      droppedAsNonFinding: 1,
    })
  })

  it("does not drop a finding that contains 'None' mid-sentence", () => {
    const finding = makeFinding({
      failure_scenario:
        "Returns None instead of an empty list when the input is empty.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [finding], droppedAsNonFinding: 0 })
  })

  it("drops a finding with leading whitespace before the prefix", () => {
    const finding = makeFinding({
      failure_scenario: "  N/A — tests are valid.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("handles an empty findings array", () => {
    const result = filterNonFindings([])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 0 })
  })

  // --- Title signals (observed escapes on PRs #10/#12) ---

  it("drops a finding whose title starts with 'N/A' (observed on PR #12)", () => {
    const finding = makeFinding({
      title: "N/A — maintains unposted design (ignore)",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose title starts with 'Placeholder'", () => {
    const finding = makeFinding({
      title: "Placeholder — re-evaluate after the refactor lands",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose title ends with 'is correct' (observed on PR #10)", () => {
    const finding = makeFinding({
      title: "Extensionless path handling in posix.basename is correct",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose title ends with 'is accurate' (observed on PR #10)", () => {
    const finding = makeFinding({
      title: "README doc-mention description is accurate",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  // --- Confirmation phrases: separator-anchored (observed escapes) ---

  it("drops a finding whose failure_scenario starts with 'No failure —' (observed on PR #10)", () => {
    const finding = makeFinding({
      failure_scenario:
        "No failure — the code handles extensionless paths correctly by falling through to the basename match.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose failure_scenario starts with 'No concrete failure scenario —' (observed on PR #10)", () => {
    const finding = makeFinding({
      failure_scenario:
        "No concrete failure scenario — `fs.stat` handles forward-slash paths on Windows. This finding should be OMITTED under NOISE SUPPRESSION.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose failure_scenario starts with 'None —'", () => {
    const finding = makeFinding({
      failure_scenario: "None — the code handles this edge case.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose confirmation phrase is separated by a plain hyphen", () => {
    const finding = makeFinding({
      failure_scenario: "No bug - the guard already covers this input.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose failure_scenario ends with 'No bug here.' (observed on PR #10)", () => {
    const finding = makeFinding({
      failure_scenario:
        "After re-tracing, the guard handles EOF correctly. The code is correct; my initial analysis was wrong. The comment and code are aligned. No bug here.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose failure_scenario ends with 'analysis was wrong.'", () => {
    const finding = makeFinding({
      failure_scenario:
        "On closer inspection, the boundary check is fine. My analysis was wrong.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  // --- Suggestion signals (observed escapes) ---

  it("drops a finding whose suggestion starts with 'N/A' (observed on PR #12)", () => {
    const finding = makeFinding({
      suggestion: "N/A — designed behavior per PR description.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose suggestion starts with 'No bug —' (observed on PR #10)", () => {
    const finding = makeFinding({
      suggestion: "No bug — code is correct.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose suggestion starts with 'No action needed —' (observed on PR #10)", () => {
    const finding = makeFinding({
      suggestion:
        "No action needed — the code is correct. This is a documentation note: the budget subtraction correctly tracks only included files.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose suggestion starts with 'No change needed —' (observed on PR #10)", () => {
    const finding = makeFinding({
      suggestion:
        "No change needed — the existing code is safe because Node.js `fs.stat` normalizes path separators on all platforms. This is a note, not a fix.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  // --- Title-field confirmation prefix (path A via CONFIRMATION_PREFIX) ---

  it("drops a finding whose title starts with 'No bug —'", () => {
    const finding = makeFinding({
      title: "No bug — the fallback is intentional",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  // --- Separator anchoring: near-misses must survive ---

  it("keeps a finding whose failure_scenario starts with 'No failure occurs until'", () => {
    const finding = makeFinding({
      failure_scenario:
        "No failure occurs until the third retry aborts the batch.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [finding], droppedAsNonFinding: 0 })
  })

  it("keeps a finding whose suggestion is a concrete change", () => {
    const finding = makeFinding({
      suggestion: "Add a null check before dereferencing the config value.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [finding], droppedAsNonFinding: 0 })
  })

  it("keeps a finding with a verification-style title but real scenario and suggestion", () => {
    const finding = makeFinding({
      title: "Verify the timeout budget handles overflow",
      suggestion: "Clamp the timeout to the configured maximum.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [finding], droppedAsNonFinding: 0 })
  })

  it("keeps a finding whose failure_scenario mentions 'no bug' mid-sentence", () => {
    const finding = makeFinding({
      failure_scenario:
        "The fallback swallows the error, so callers see no bug reports but data is lost.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [finding], droppedAsNonFinding: 0 })
  })
})
