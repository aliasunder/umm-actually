import { describe, expect, it } from "vitest"
import { DEFAULT_DIFF_EXCLUDE_PATTERNS } from "../../config.js"
import { hasExcessiveWildcards } from "../pattern-safety.js"

describe("hasExcessiveWildcards", () => {
  it("accepts every shipped default pattern", () => {
    // Production-consistency check across two constants, not a drift test:
    // a default the cap itself would reject could never match anything
    expect(DEFAULT_DIFF_EXCLUDE_PATTERNS.filter(hasExcessiveWildcards)).toEqual(
      [],
    )
  })

  it("accepts globstar segments regardless of how many appear", () => {
    expect(hasExcessiveWildcards("**/__snapshots__/**")).toBe(false)
  })

  it("accepts up to two stars in one segment", () => {
    expect(hasExcessiveWildcards("*.min.*")).toBe(false)
  })

  it("flags a segment with more than two stars", () => {
    expect(hasExcessiveWildcards("*a*a*b")).toBe(true)
  })

  it("flags a multi-star segment at any depth", () => {
    expect(hasExcessiveWildcards("src/**/*a*a*a.json")).toBe(true)
  })
})
