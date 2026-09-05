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

    expect(titleSimilarity({ leftTokens: tokens, rightTokens: tokens })).toBe(1)
  })

  it("returns 0 for completely disjoint sets", () => {
    expect(
      titleSimilarity({
        leftTokens: ["alpha", "beta"],
        rightTokens: ["gamma", "delta"],
      }),
    ).toBe(0)
  })

  it("returns 0 when the first set is empty", () => {
    expect(titleSimilarity({ leftTokens: [], rightTokens: ["alpha"] })).toBe(0)
  })

  it("returns 0 when the second set is empty", () => {
    expect(titleSimilarity({ leftTokens: ["alpha"], rightTokens: [] })).toBe(0)
  })

  it("returns 0 when both sets are empty", () => {
    expect(titleSimilarity({ leftTokens: [], rightTokens: [] })).toBe(0)
  })

  it("computes Jaccard correctly for overlapping sets", () => {
    // intersection: {email, user} = 2
    // union: {check, email, missing, null, user, call, tolowercase, unguarded} = 8
    expect(
      titleSimilarity({
        leftTokens: ["check", "email", "missing", "null", "user"],
        rightTokens: ["call", "email", "tolowercase", "unguarded", "user"],
      }),
    ).toBe(2 / 8)
  })

  it("returns 0.5 for sets sharing exactly half their combined vocabulary", () => {
    // intersection: {alpha, beta} = 2
    // union: {alpha, beta, gamma, delta} = 4
    expect(
      titleSimilarity({
        leftTokens: ["alpha", "beta", "gamma"],
        rightTokens: ["alpha", "beta", "delta"],
      }),
    ).toBe(0.5)
  })

  it("deduplicates left tokens so duplicates do not inflate the ratio", () => {
    // Without dedup: filter counts "check" twice + "email" → 3, union Set → 2, ratio 1.5
    // With dedup: both sides are {check, email} → ratio 1.0
    expect(
      titleSimilarity({
        leftTokens: ["check", "check", "email"],
        rightTokens: ["check", "email"],
      }),
    ).toBe(1)
  })

  it("deduplicates right tokens so duplicates do not inflate the ratio", () => {
    expect(
      titleSimilarity({
        leftTokens: ["alpha"],
        rightTokens: ["alpha", "alpha", "beta"],
      }),
    ).toBe(0.5)
  })
})
