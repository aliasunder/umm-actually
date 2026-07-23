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

    expect(result).toEqual({
      selected: [highFinding, mediumFinding],
      droppedBelowThreshold: 1,
      droppedAsOverlapping: 0,
      droppedByCap: [],
    })
  })

  it("keeps the higher-severity finding when same-category findings overlap in a file", () => {
    const lowDuplicate = makeFinding({ severity: "low", line: 145 })
    const highOriginal = makeFinding({ severity: "high", line: 145 })

    const result = selectFindings({
      findings: [lowDuplicate, highOriginal],
      severityThreshold: "low",
      maxFindings: undefined,
    })

    expect(result).toEqual({
      selected: [highOriginal],
      droppedBelowThreshold: 0,
      droppedAsOverlapping: 1,
      droppedByCap: [],
    })
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

    expect(result).toEqual({
      selected: [rangeFinding],
      droppedBelowThreshold: 0,
      droppedAsOverlapping: 1,
      droppedByCap: [],
    })
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

    expect(result).toEqual({
      selected: [invertedRangeFinding],
      droppedBelowThreshold: 0,
      droppedAsOverlapping: 1,
      droppedByCap: [],
    })
  })

  it("does not deduplicate same-category overlapping findings in different files", () => {
    const firstFileFinding = makeFinding({ file: "src/a.ts", line: 145 })
    const secondFileFinding = makeFinding({ file: "src/b.ts", line: 145 })

    const result = selectFindings({
      findings: [firstFileFinding, secondFileFinding],
      severityThreshold: "low",
      maxFindings: undefined,
    })

    expect(result).toEqual({
      selected: [firstFileFinding, secondFileFinding],
      droppedBelowThreshold: 0,
      droppedAsOverlapping: 0,
      droppedByCap: [],
    })
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

    expect(result).toEqual({
      selected: [correctnessFinding, testsFinding],
      droppedBelowThreshold: 0,
      droppedAsOverlapping: 0,
      droppedByCap: [],
    })
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

    expect(result).toEqual({
      selected: [criticalLate, mediumOtherFile, mediumSameFileLater, lowEarly],
      droppedBelowThreshold: 0,
      droppedAsOverlapping: 0,
      droppedByCap: [],
    })
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

    expect(result).toEqual({
      selected: manyFindings,
      droppedBelowThreshold: 0,
      droppedAsOverlapping: 0,
      droppedByCap: [],
    })
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

    expect(result).toEqual({
      selected: [criticalFinding, highFinding],
      droppedBelowThreshold: 0,
      droppedAsOverlapping: 0,
      droppedByCap: [lowFinding],
    })
  })

  it("does not report a cap drop when the cap exceeds the finding count", () => {
    const finding = makeFinding()

    const result = selectFindings({
      findings: [finding],
      severityThreshold: "low",
      maxFindings: 10,
    })

    expect(result).toEqual({
      selected: [finding],
      droppedBelowThreshold: 0,
      droppedAsOverlapping: 0,
      droppedByCap: [],
    })
  })
})
