import { describe, expect, it } from "vitest"
import {
  CI_WORKFLOW_CHECKS,
  DIMENSION_CODE_QUALITY,
  DIMENSION_CORRECTNESS_SECURITY,
  DIMENSION_SUBTLE_BUGS,
  DIMENSION_TEST_QUALITY,
  resolvePhases,
} from "../phases.js"

describe("resolvePhases", () => {
  it("resolves combined to a single phase carrying all four dimensions plus CI checks", () => {
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
    expect(DIMENSION_CORRECTNESS_SECURITY).toContain(
      "When unchanged\ndocumentation files are provided as context",
    )
    expect(DIMENSION_CORRECTNESS_SECURITY).toContain(
      "stale descriptions, outdated architecture references",
    )
  })
})
