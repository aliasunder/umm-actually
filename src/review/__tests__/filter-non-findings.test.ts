import { describe, expect, it } from "vitest"
import { filterNonFindings } from "../filter-non-findings.js"
import { makeFinding } from "./make-finding.js"

describe("filterNonFindings", () => {
  // --- Primary signal: prefix patterns ---

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
      failure_scenario: "NA — this is correct behavior.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose failure_scenario starts with 'None'", () => {
    const finding = makeFinding({
      failure_scenario: "None — logic appears correct.",
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

  // --- Secondary signal: body content ---

  it("drops a finding whose failure_scenario contains 'no actual bug'", () => {
    const finding = makeFinding({
      failure_scenario: "After analysis, no actual bug was found in this path.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose failure_scenario contains 'this is correct'", () => {
    const finding = makeFinding({
      failure_scenario:
        "The behavior triggered when input is empty, but this is correct per the spec.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose failure_scenario contains 'working as designed'", () => {
    const finding = makeFinding({
      failure_scenario:
        "The function returns null for missing keys, working as designed.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose failure_scenario contains 'correct behavior'", () => {
    const finding = makeFinding({
      failure_scenario:
        "The validation rejects empty strings — correct behavior, not a bug.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose failure_scenario contains 'by design'", () => {
    const finding = makeFinding({
      failure_scenario:
        "The guard rejects the empty string by design; this is not a bug.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  it("drops a finding whose failure_scenario contains 'no bug found'", () => {
    const finding = makeFinding({
      failure_scenario: "Reviewed the logic — no bug found after re-analysis.",
    })

    const result = filterNonFindings([finding])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 1 })
  })

  // --- Passthrough cases ---

  it("keeps a finding with a concrete failure scenario", () => {
    const finding = makeFinding({
      failure_scenario:
        "A CI step that gates deployment reads the env var, but the value is never set in the matrix.",
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

  it("returns empty findings when all findings are non-findings", () => {
    const findings = [
      makeFinding({ line: 1, failure_scenario: "N/A — tests are valid." }),
      makeFinding({ line: 2, failure_scenario: "None — logic is correct." }),
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

  it("handles an empty findings array", () => {
    const result = filterNonFindings([])

    expect(result).toEqual({ findings: [], droppedAsNonFinding: 0 })
  })
})
