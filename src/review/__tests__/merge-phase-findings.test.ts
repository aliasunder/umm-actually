import { describe, expect, it } from "vitest"
import { mergePhaseFindings } from "../merge-phase-findings.js"
import { makeFinding } from "./make-finding.js"

describe("mergePhaseFindings", () => {
  it("collapses a cross-phase overlap across categories, keeping the higher severity in the earlier position", () => {
    const correctnessFinding = makeFinding({
      line: 10,
      category: "correctness",
      severity: "medium",
      title: "Correctness phase",
    })
    const subtleBugsFinding = makeFinding({
      line: 10,
      category: "subtle_bugs",
      severity: "high",
      title: "Subtle bugs phase",
    })
    const unrelatedFinding = makeFinding({ line: 40, title: "Unrelated" })

    const merged = mergePhaseFindings([
      [correctnessFinding, unrelatedFinding],
      [subtleBugsFinding],
    ])

    expect(merged).toEqual({
      findings: [subtleBugsFinding, unrelatedFinding],
      duplicatesAcrossPhases: 1,
    })
  })

  it("keeps the earlier phase's finding on an equal-severity overlap", () => {
    const earlierFinding = makeFinding({ line: 10, title: "Earlier phase" })
    const laterFinding = makeFinding({
      line: 10,
      category: "subtle_bugs",
      title: "Later phase",
    })

    const merged = mergePhaseFindings([[earlierFinding], [laterFinding]])

    expect(merged).toEqual({
      findings: [earlierFinding],
      duplicatesAcrossPhases: 1,
    })
  })

  it("treats a range as overlapping when a later phase's line falls inside it", () => {
    const rangeFinding = makeFinding({ line: 10, end_line: 15 })
    const insideRangeFinding = makeFinding({
      line: 12,
      category: "tests",
      severity: "critical",
    })

    const merged = mergePhaseFindings([[rangeFinding], [insideRangeFinding]])

    expect(merged).toEqual({
      findings: [insideRangeFinding],
      duplicatesAcrossPhases: 1,
    })
  })

  it("never compares findings from the same phase, so a one-phase run passes through unchanged", () => {
    const correctnessFinding = makeFinding({ line: 10 })
    const subtleBugsFinding = makeFinding({
      line: 10,
      category: "subtle_bugs",
      severity: "high",
    })

    const merged = mergePhaseFindings([[correctnessFinding, subtleBugsFinding]])

    expect(merged).toEqual({
      findings: [correctnessFinding, subtleBugsFinding],
      duplicatesAcrossPhases: 0,
    })
  })

  it("keeps cross-phase findings on non-overlapping lines of the same file", () => {
    const firstFinding = makeFinding({ line: 10, end_line: 12 })
    const secondFinding = makeFinding({ line: 13, category: "subtle_bugs" })

    const merged = mergePhaseFindings([[firstFinding], [secondFinding]])

    expect(merged).toEqual({
      findings: [firstFinding, secondFinding],
      duplicatesAcrossPhases: 0,
    })
  })

  it("keeps cross-phase findings on the same lines of different files", () => {
    const greeterFinding = makeFinding({ line: 10 })
    const registryFinding = makeFinding({
      line: 10,
      file: "src/registry.ts",
      category: "subtle_bugs",
    })

    const merged = mergePhaseFindings([[greeterFinding], [registryFinding]])

    expect(merged).toEqual({
      findings: [greeterFinding, registryFinding],
      duplicatesAcrossPhases: 0,
    })
  })

  it("returns nothing for no phases", () => {
    expect(mergePhaseFindings([])).toEqual({
      findings: [],
      duplicatesAcrossPhases: 0,
    })
  })
})
