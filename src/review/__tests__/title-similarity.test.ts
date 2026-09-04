import { describe, expect, it } from "vitest"
import { normalizeTitle, titleSimilarity } from "../title-similarity.js"

describe("normalizeTitle", () => {
  it("lowercases, splits on non-word characters, removes stop words, and sorts", () => {
    const result = normalizeTitle("Missing null check on user.email")

    expect(result).toEqual(["check", "email", "missing", "null", "user"])
  })

  it("deduplicates tokens", () => {
    const result = normalizeTitle("check the check before checking")

    expect(result).toEqual(["before", "check", "checking"])
  })

  it("returns an empty array for a title of only stop words", () => {
    const result = normalizeTitle("it is not a")

    expect(result).toEqual([])
  })

  it("returns an empty array for an empty string", () => {
    const result = normalizeTitle("")

    expect(result).toEqual([])
  })

  it("handles backtick-wrapped code identifiers", () => {
    const result = normalizeTitle(
      "Unguarded `toLowerCase` call on `user.email`",
    )

    expect(result).toEqual([
      "call",
      "email",
      "tolowercase",
      "unguarded",
      "user",
    ])
  })
})

describe("titleSimilarity", () => {
  it("returns 1.0 for identical token sets", () => {
    const tokens = ["check", "email", "missing", "null", "user"]

    expect(titleSimilarity(tokens, tokens)).toBe(1)
  })

  it("returns 0 for completely disjoint sets", () => {
    const a = ["alpha", "beta"]
    const b = ["gamma", "delta"]

    expect(titleSimilarity(a, b)).toBe(0)
  })

  it("returns 0 when the first set is empty", () => {
    expect(titleSimilarity([], ["alpha"])).toBe(0)
  })

  it("returns 0 when the second set is empty", () => {
    expect(titleSimilarity(["alpha"], [])).toBe(0)
  })

  it("computes Jaccard correctly for overlapping sets", () => {
    const a = ["check", "email", "missing", "null", "user"]
    const b = ["call", "email", "tolowercase", "unguarded", "user"]

    // intersection: {email, user} = 2
    // union: {check, email, missing, null, user, call, tolowercase, unguarded} = 8
    expect(titleSimilarity(a, b)).toBeCloseTo(2 / 8)
  })

  it("returns 0.5 for sets sharing exactly half their combined vocabulary", () => {
    const a = ["alpha", "beta", "gamma"]
    const b = ["alpha", "beta", "delta"]

    // intersection: {alpha, beta} = 2
    // union: {alpha, beta, gamma, delta} = 4
    expect(titleSimilarity(a, b)).toBe(0.5)
  })
})
