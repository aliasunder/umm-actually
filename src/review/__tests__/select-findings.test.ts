import { describe, expect, it } from "vitest"
import { selectFindings } from "../select-findings.js"
import { makeFinding } from "./make-finding.js"

describe("selectFindings", () => {
  it("drops findings below the severity threshold and counts them", () => {
    const lowFinding = makeFinding({ severity: "low", line: 1 })
    const mediumFinding = makeFinding({ severity: "medium", line: 10 })
    const highFinding = makeFinding({ severity: "high", line: 20 })

    const result = selectFindings({
      findings: [lowFinding, mediumFinding, highFinding],
      severityThreshold: "medium",
      maxFindings: undefined,
    })

    expect(result.selected).toEqual([highFinding, mediumFinding])
    expect(result.droppedBelowThreshold).toBe(1)
  })

  it("keeps the higher-severity finding when same-category findings overlap in a file", () => {
    const lowDuplicate = makeFinding({ severity: "low", line: 145 })
    const highOriginal = makeFinding({ severity: "high", line: 145 })

    const result = selectFindings({
      findings: [lowDuplicate, highOriginal],
      severityThreshold: "low",
      maxFindings: undefined,
    })

    expect(result.selected).toEqual([highOriginal])
  })

  it("deduplicates overlapping line ranges of the same category", () => {
    const rangeFinding = makeFinding({
      line: 140,
      end_line: 150,
      severity: "high",
    })
    const containedFinding = makeFinding({
      line: 145,
      end_line: null,
      severity: "medium",
    })

    const result = selectFindings({
      findings: [rangeFinding, containedFinding],
      severityThreshold: "low",
      maxFindings: undefined,
    })

    expect(result.selected).toEqual([rangeFinding])
  })

  it("deduplicates against an inverted range (end_line before line)", () => {
    const invertedRangeFinding = makeFinding({
      line: 150,
      end_line: 140,
      severity: "high",
    })
    const containedFinding = makeFinding({
      line: 145,
      end_line: null,
      severity: "medium",
    })

    const result = selectFindings({
      findings: [invertedRangeFinding, containedFinding],
      severityThreshold: "low",
      maxFindings: undefined,
    })

    expect(result.selected).toEqual([invertedRangeFinding])
  })

  it("does not deduplicate overlapping findings of different categories", () => {
    const correctnessFinding = makeFinding({
      category: "correctness",
      line: 145,
    })
    const testsFinding = makeFinding({ category: "tests", line: 145 })

    const result = selectFindings({
      findings: [correctnessFinding, testsFinding],
      severityThreshold: "low",
      maxFindings: undefined,
    })

    expect(result.selected).toHaveLength(2)
  })

  it("sorts by severity descending, then file, then line", () => {
    const lowEarly = makeFinding({ severity: "low", file: "a.ts", line: 1 })
    const criticalLate = makeFinding({
      severity: "critical",
      file: "z.ts",
      line: 900,
    })
    const mediumOtherFile = makeFinding({
      severity: "medium",
      file: "b.ts",
      line: 5,
    })
    const mediumSameFileLater = makeFinding({
      severity: "medium",
      file: "b.ts",
      line: 50,
    })

    const result = selectFindings({
      findings: [lowEarly, mediumSameFileLater, criticalLate, mediumOtherFile],
      severityThreshold: "low",
      maxFindings: undefined,
    })

    expect(result.selected).toEqual([
      criticalLate,
      mediumOtherFile,
      mediumSameFileLater,
      lowEarly,
    ])
  })

  it("posts every finding when no cap is provided", () => {
    const manyFindings = Array.from({ length: 25 }, (_, index) =>
      makeFinding({ line: index + 1, category: "correctness" }),
    )

    const result = selectFindings({
      findings: manyFindings,
      severityThreshold: "low",
      maxFindings: undefined,
    })

    expect(result.selected).toHaveLength(25)
    expect(result.droppedByCap).toEqual([])
  })

  it("caps at max_findings keeping the most severe, and reports the dropped ones", () => {
    const criticalFinding = makeFinding({ severity: "critical", line: 1 })
    const highFinding = makeFinding({ severity: "high", line: 10 })
    const lowFinding = makeFinding({ severity: "low", line: 20 })

    const result = selectFindings({
      findings: [lowFinding, highFinding, criticalFinding],
      severityThreshold: "low",
      maxFindings: 2,
    })

    expect(result.selected).toEqual([criticalFinding, highFinding])
    expect(result.droppedByCap).toEqual([lowFinding])
  })

  it("does not report a cap drop when the cap exceeds the finding count", () => {
    const result = selectFindings({
      findings: [makeFinding()],
      severityThreshold: "low",
      maxFindings: 10,
    })

    expect(result.selected).toHaveLength(1)
    expect(result.droppedByCap).toEqual([])
  })
})
