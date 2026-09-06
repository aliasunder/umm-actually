import { describe, expect, it } from "vitest"
import { createTestLogger } from "../../__tests__/test-logger.js"
import {
  compileLinguistRules,
  linguistGeneratedState,
  parseLinguistGeneratedRules,
} from "../gitattributes.js"

const parseRules = (content: string) => {
  return parseLinguistGeneratedRules(content, createTestLogger())
}

const stateFor = (filePath: string, content: string): boolean | undefined => {
  return linguistGeneratedState(
    filePath,
    compileLinguistRules(parseRules(content)),
  )
}

describe("parseLinguistGeneratedRules", () => {
  it("parses all four attribute spellings into rules", () => {
    const content = [
      "a.json linguist-generated",
      "b.json linguist-generated=true",
      "c.json linguist-generated=false",
      "d.json -linguist-generated",
    ].join("\n")

    expect(parseRules(content)).toEqual([
      { pattern: "a.json", generated: true },
      { pattern: "b.json", generated: true },
      { pattern: "c.json", generated: false },
      { pattern: "d.json", generated: false },
    ])
  })

  it("skips comments, blank lines, and lines without the attribute", () => {
    const content = [
      "# generated artifacts",
      "",
      "*.pdf binary",
      "*.snap linguist-generated=true",
    ].join("\n")

    expect(parseRules(content)).toEqual([
      { pattern: "*.snap", generated: true },
    ])
  })

  it("skips gitignore-style negation patterns, which gitattributes forbids", () => {
    expect(parseRules("!*.snap linguist-generated=true")).toEqual([])
  })

  it("drops a wildcard-cap-violating pattern with a warn and keeps the rest", () => {
    const logger = createTestLogger()
    const content = [
      "*a*a*a*b linguist-generated=true",
      "*.snap linguist-generated=true",
    ].join("\n")

    const rules = parseLinguistGeneratedRules(content, logger)

    expect(rules).toEqual([{ pattern: "*.snap", generated: true }])
    expect(logger.messages).toEqual([
      {
        level: "warn",
        message:
          "gitattributes pattern exceeds the wildcard cap — rule ignored",
        data: { pattern: "*a*a*a*b" },
      },
    ])
  })

  it("keeps a backslash-escaped space inside the pattern token", () => {
    expect(parseRules("a\\ b.json linguist-generated=true")).toEqual([
      { pattern: "a\\ b.json", generated: true },
    ])
  })
})

describe("linguistGeneratedState", () => {
  it("returns undefined when no rule matches", () => {
    expect(stateFor("src/app.ts", "*.snap linguist-generated=true")).toBe(
      undefined,
    )
  })

  it("matches a slash-less pattern against basenames at any depth", () => {
    expect(
      stateFor("deep/nested/x.snap", "*.snap linguist-generated=true"),
    ).toBe(true)
  })

  it("applies the last matching rule when rules overlap", () => {
    const content = [
      "snapshots/*.json linguist-generated=true",
      "snapshots/keep.json -linguist-generated",
    ].join("\n")

    expect(stateFor("snapshots/keep.json", content)).toBe(false)
    expect(stateFor("snapshots/other.json", content)).toBe(true)
  })

  it("matches directory-style patterns against contained files", () => {
    // Deliberate over-approximation: gitattributes itself would not apply a
    // "dir/" pattern to contained paths, but excluding more than GitHub
    // collapses is visible in the review output and off-switchable
    expect(
      stateFor(
        "__snapshots__/x.json",
        "__snapshots__/ linguist-generated=true",
      ),
    ).toBe(true)
    expect(
      stateFor("__snapshots__/x.json", "__snapshots__ linguist-generated=true"),
    ).toBe(true)
  })
})
