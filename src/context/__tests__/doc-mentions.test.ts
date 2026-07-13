import { describe, it, expect } from "vitest"
import {
  findMentionedChangedPaths,
  byMentionRelevance,
  GENERIC_BASENAMES,
  DOC_EXTENSIONS,
  type DocCandidate,
} from "../doc-mentions.js"

describe("findMentionedChangedPaths", () => {
  it("detects a full relative path mention", () => {
    const result = findMentionedChangedPaths(
      "This module lives in `src/greeter.ts` and exports a greeting.",
      ["src/greeter.ts"],
    )

    expect(result).toEqual({
      mentionedPaths: ["src/greeter.ts"],
      fullPathCount: 1,
      basenameCount: 0,
    })
  })

  it("detects a non-generic basename mention", () => {
    const result = findMentionedChangedPaths(
      "The greeter.ts module handles all greetings.",
      ["src/greeter.ts"],
    )

    expect(result).toEqual({
      mentionedPaths: ["src/greeter.ts"],
      fullPathCount: 0,
      basenameCount: 1,
    })
  })

  it("requires path-ish match for generic basenames", () => {
    const result = findMentionedChangedPaths(
      "See index.ts for the barrel exports.",
      ["src/lib/index.ts"],
    )

    expect(result).toEqual({
      mentionedPaths: [],
      fullPathCount: 0,
      basenameCount: 0,
    })
  })

  it("detects generic basename with last-two-segment match", () => {
    const result = findMentionedChangedPaths(
      "The barrel re-export is in lib/index.ts.",
      ["src/lib/index.ts"],
    )

    expect(result).toEqual({
      mentionedPaths: ["src/lib/index.ts"],
      fullPathCount: 0,
      basenameCount: 1,
    })
  })

  it("returns empty result when no paths are mentioned", () => {
    const result = findMentionedChangedPaths(
      "This document has no file references at all.",
      ["src/greeter.ts", "src/registry.ts"],
    )

    expect(result).toEqual({
      mentionedPaths: [],
      fullPathCount: 0,
      basenameCount: 0,
    })
  })

  it("counts full-path match only — no double-counting as basename", () => {
    const result = findMentionedChangedPaths(
      "The file src/greeter.ts handles greetings. Also see greeter.ts.",
      ["src/greeter.ts"],
    )

    expect(result).toEqual({
      mentionedPaths: ["src/greeter.ts"],
      fullPathCount: 1,
      basenameCount: 0,
    })
  })

  it("counts multiple changed paths independently", () => {
    const result = findMentionedChangedPaths(
      "See src/greeter.ts for greetings and registry.ts for the registry.",
      ["src/greeter.ts", "src/registry.ts"],
    )

    expect(result).toEqual({
      mentionedPaths: ["src/greeter.ts", "src/registry.ts"],
      fullPathCount: 1,
      basenameCount: 1,
    })
  })

  it("matches extensionless paths by full-path substring", () => {
    const result = findMentionedChangedPaths("The Makefile is important.", [
      "Makefile",
    ])

    expect(result).toEqual({
      mentionedPaths: ["Makefile"],
      fullPathCount: 1,
      basenameCount: 0,
    })
  })

  it("does not match generic basename without parent directory context", () => {
    const result = findMentionedChangedPaths("See config.ts for settings.", [
      "src/config.ts",
    ])

    expect(result).toEqual({
      mentionedPaths: [],
      fullPathCount: 0,
      basenameCount: 0,
    })
  })

  it("requires parent directory context for extensionless generic basenames", () => {
    const result = findMentionedChangedPaths(
      "See the index for details.",
      ["src/index"],
    )

    expect(result).toEqual({
      mentionedPaths: [],
      fullPathCount: 0,
      basenameCount: 0,
    })
  })

  it("matches extensionless generic basename with parent directory context", () => {
    const result = findMentionedChangedPaths(
      "The entry point is src/index in the source tree.",
      ["src/index"],
    )

    expect(result).toEqual({
      mentionedPaths: ["src/index"],
      fullPathCount: 1,
      basenameCount: 0,
    })
  })

  it("skips a dot-prefixed file that does not match by full path", () => {
    const result = findMentionedChangedPaths(
      "The .gitignore file controls tracking.",
      ["src/.gitignore"],
    )

    expect(result).toEqual({
      mentionedPaths: [],
      fullPathCount: 0,
      basenameCount: 0,
    })
  })

  it("matches generic basename with parent directory context", () => {
    const result = findMentionedChangedPaths(
      "See src/config.ts for settings.",
      ["src/config.ts"],
    )

    expect(result).toEqual({
      mentionedPaths: ["src/config.ts"],
      fullPathCount: 1,
      basenameCount: 0,
    })
  })

  it("does not match a path that is a prefix of a longer path", () => {
    const result = findMentionedChangedPaths(
      "The component lives in src/greeter.tsx.",
      ["src/greeter.ts"],
    )

    expect(result).toEqual({
      mentionedPaths: [],
      fullPathCount: 0,
      basenameCount: 0,
    })
  })

  it("does not match a basename that is a prefix of a longer filename", () => {
    const result = findMentionedChangedPaths(
      "See greeter.tsx for the component.",
      ["src/greeter.ts"],
    )

    expect(result).toEqual({
      mentionedPaths: [],
      fullPathCount: 0,
      basenameCount: 0,
    })
  })

  it("matches a path followed by non-path punctuation", () => {
    const result = findMentionedChangedPaths(
      "Check `src/greeter.ts` for details.",
      ["src/greeter.ts"],
    )

    expect(result).toEqual({
      mentionedPaths: ["src/greeter.ts"],
      fullPathCount: 1,
      basenameCount: 0,
    })
  })
})

describe("byMentionRelevance", () => {
  const makeCandidate = (
    overrides: Partial<DocCandidate> & { path: string },
  ): DocCandidate => ({
    content: "",
    fullPathCount: 0,
    basenameCount: 0,
    mentionedChangedPaths: [],
    ...overrides,
  })

  it("ranks higher full-path count first", () => {
    const a = makeCandidate({ path: "docs/a.md", fullPathCount: 2 })
    const b = makeCandidate({ path: "docs/b.md", fullPathCount: 1 })

    expect(byMentionRelevance(a, b)).toBeLessThan(0)
    expect(byMentionRelevance(b, a)).toBeGreaterThan(0)
  })

  it("breaks full-path ties with basename count", () => {
    const a = makeCandidate({
      path: "docs/a.md",
      fullPathCount: 1,
      basenameCount: 3,
    })
    const b = makeCandidate({
      path: "docs/b.md",
      fullPathCount: 1,
      basenameCount: 1,
    })

    expect(byMentionRelevance(a, b)).toBeLessThan(0)
    expect(byMentionRelevance(b, a)).toBeGreaterThan(0)
  })

  it("breaks equal scores with alphabetical path", () => {
    const a = makeCandidate({ path: "docs/alpha.md", fullPathCount: 1 })
    const b = makeCandidate({ path: "docs/beta.md", fullPathCount: 1 })

    expect(byMentionRelevance(a, b)).toBeLessThan(0)
    expect(byMentionRelevance(b, a)).toBeGreaterThan(0)
  })

  it("returns zero for equal candidates", () => {
    const a = makeCandidate({ path: "docs/a.md", fullPathCount: 1 })
    const b = makeCandidate({ path: "docs/a.md", fullPathCount: 1 })

    expect(byMentionRelevance(a, b)).toBe(0)
  })
})

describe("constants", () => {
  it("DOC_EXTENSIONS includes .md and .json", () => {
    expect(DOC_EXTENSIONS).toEqual(new Set([".md", ".json"]))
  })

  it("GENERIC_BASENAMES contains the exact set of common stems", () => {
    expect(GENERIC_BASENAMES).toEqual(
      new Set([
        "index",
        "main",
        "config",
        "types",
        "utils",
        "helpers",
        "constants",
        "mod",
      ]),
    )
  })
})
