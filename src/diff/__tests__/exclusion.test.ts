import type { File } from "parse-diff"
import { describe, expect, it } from "vitest"
import { DEFAULT_DIFF_EXCLUDE_PATTERNS } from "../../config.js"
import { createTestLogger } from "../../__tests__/test-logger.js"
import {
  createExclusionMatcher,
  hasExcessiveWildcards,
  partitionExcludedFiles,
  renderExcludedFilesNote,
  summarizeExclusionSources,
  type ExcludedDiffFile,
} from "../exclusion.js"

const makeFile = (overrides: Partial<File> = {}): File => ({
  chunks: [],
  additions: 3,
  deletions: 1,
  from: "src/app.ts",
  to: "src/app.ts",
  ...overrides,
})

type MatcherOverrides = {
  defaultPatterns?: string[]
  operatorPatterns?: string[]
  gitAttributesContent?: string
}

const makeMatcher = (overrides: MatcherOverrides = {}) => {
  return createExclusionMatcher(
    {
      defaultPatterns: overrides.defaultPatterns ?? [],
      operatorPatterns: overrides.operatorPatterns ?? [],
      gitAttributesContent: overrides.gitAttributesContent ?? null,
    },
    createTestLogger(),
  )
}

const partition = (files: File[], overrides: MatcherOverrides = {}) => {
  return partitionExcludedFiles({ files, matcher: makeMatcher(overrides) })
}

const keptPaths = (result: { kept: File[] }): (string | undefined)[] => {
  return result.kept.map((file) => file.to ?? file.from)
}

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

  it("does not count escaped stars toward the cap", () => {
    expect(hasExcessiveWildcards("a\\*b\\*c\\*d.json")).toBe(false)
  })

  it("still flags unescaped stars alongside escaped ones", () => {
    expect(hasExcessiveWildcards("\\*a*a*a*b")).toBe(true)
  })
})

describe("createExclusionMatcher — gitattributes rules", () => {
  it("honors all four attribute spellings", () => {
    const matcher = makeMatcher({
      // c.json and d.json also sit on the default list so the negative
      // spellings are observable as exemptions, not merely as no-rule
      defaultPatterns: ["**/c.json", "**/d.json"],
      gitAttributesContent: [
        "a.json linguist-generated",
        "b.json linguist-generated=true",
        "c.json linguist-generated=false",
        "d.json -linguist-generated",
      ].join("\n"),
    })

    expect(matcher.classify("a.json")).toBe("linguist_generated")
    expect(matcher.classify("b.json")).toBe("linguist_generated")
    expect(matcher.classify("c.json")).toBeNull()
    expect(matcher.classify("d.json")).toBeNull()
  })

  it("ignores comments, blank lines, and lines without the attribute", () => {
    const matcher = makeMatcher({
      gitAttributesContent: [
        "# generated artifacts",
        "",
        "*.pdf binary",
        "*.snap linguist-generated=true",
      ].join("\n"),
    })

    expect(matcher.classify("x.pdf")).toBeNull()
    expect(matcher.classify("x.snap")).toBe("linguist_generated")
  })

  it("ignores gitignore-style negation patterns, which gitattributes forbids", () => {
    const matcher = makeMatcher({
      gitAttributesContent: "!*.snap linguist-generated=true",
    })

    expect(matcher.classify("x.snap")).toBeNull()
  })

  it("drops a wildcard-cap-violating rule with a warn and keeps the rest", () => {
    const logger = createTestLogger()
    const matcher = createExclusionMatcher(
      {
        defaultPatterns: [],
        operatorPatterns: [],
        gitAttributesContent: [
          "*a*a*a*b linguist-generated=true",
          "*.snap linguist-generated=true",
        ].join("\n"),
      },
      logger,
    )

    expect(matcher.classify("aaaab")).toBeNull()
    expect(matcher.classify("x.snap")).toBe("linguist_generated")
    expect(logger.messages).toEqual([
      {
        level: "warn",
        message:
          "gitattributes pattern exceeds the wildcard cap — rule ignored",
        data: { pattern: "*a*a*a*b" },
      },
    ])
  })

  it("matches a backslash-escaped space as a literal space in the path", () => {
    const matcher = makeMatcher({
      gitAttributesContent: "a\\ b.json linguist-generated=true",
    })

    expect(matcher.classify("a b.json")).toBe("linguist_generated")
  })

  it("returns null when no rule matches", () => {
    const matcher = makeMatcher({
      gitAttributesContent: "*.snap linguist-generated=true",
    })

    expect(matcher.classify("src/app.ts")).toBeNull()
  })

  it("matches a slash-less pattern against basenames at any depth", () => {
    const matcher = makeMatcher({
      gitAttributesContent: "*.snap linguist-generated=true",
    })

    expect(matcher.classify("deep/nested/x.snap")).toBe("linguist_generated")
  })

  it("applies the last matching rule when rules overlap", () => {
    const matcher = makeMatcher({
      gitAttributesContent: [
        "snapshots/*.json linguist-generated=true",
        "snapshots/keep.json -linguist-generated",
      ].join("\n"),
    })

    expect(matcher.classify("snapshots/keep.json")).toBeNull()
    expect(matcher.classify("snapshots/other.json")).toBe("linguist_generated")
  })

  it("matches directory-style patterns against contained files", () => {
    // Deliberate over-approximation: gitattributes itself would not apply a
    // "dir/" pattern to contained paths, but excluding more than GitHub
    // collapses is visible in the review output and off-switchable
    const trailingSlash = makeMatcher({
      gitAttributesContent: "__snapshots__/ linguist-generated=true",
    })
    const bareName = makeMatcher({
      gitAttributesContent: "__snapshots__ linguist-generated=true",
    })

    expect(trailingSlash.classify("__snapshots__/x.json")).toBe(
      "linguist_generated",
    )
    expect(bareName.classify("__snapshots__/x.json")).toBe("linguist_generated")
  })
})

describe("partitionExcludedFiles", () => {
  it("keeps every file when no patterns or rules are configured", () => {
    const files = [makeFile(), makeFile({ from: "b.ts", to: "b.ts" })]

    expect(partition(files)).toEqual({ kept: files, excluded: [] })
  })

  it("excludes a root-anchored folder-prefix match and keeps files outside it", () => {
    const generated = makeFile({
      from: "generated/api.ts",
      to: "generated/api.ts",
    })
    const source = makeFile()

    const result = partition([generated, source], {
      operatorPatterns: ["generated"],
    })

    expect(result.kept).toEqual([source])
    expect(result.excluded).toEqual([
      {
        path: "generated/api.ts",
        additions: 3,
        deletions: 1,
        source: "operator_pattern",
      },
    ])
  })

  it("excludes a root-level lockfile via the shipped **/ default patterns", () => {
    // Pins matchesGlob's "**/ matches zero directories" semantics: the
    // shipped defaults must catch the standard npm layout's root lockfile
    const lockfile = makeFile({
      from: "package-lock.json",
      to: "package-lock.json",
    })
    const source = makeFile()

    const result = partition([lockfile, source], {
      defaultPatterns: DEFAULT_DIFF_EXCLUDE_PATTERNS,
    })

    expect(result.kept).toEqual([source])
    expect(result.excluded).toEqual([
      {
        path: "package-lock.json",
        additions: 3,
        deletions: 1,
        source: "default_pattern",
      },
    ])
  })

  it("excludes a glob match at any depth and keeps non-matching siblings", () => {
    const snapshot = makeFile({
      from: "src/a/__tests__/x.snap",
      to: "src/a/__tests__/x.snap",
    })
    const test = makeFile({
      from: "src/a/__tests__/x.test.ts",
      to: "src/a/__tests__/x.test.ts",
    })

    const result = partition([snapshot, test], {
      defaultPatterns: ["**/*.snap"],
    })

    expect(keptPaths(result)).toEqual(["src/a/__tests__/x.test.ts"])
    expect(result.excluded).toEqual([
      {
        path: "src/a/__tests__/x.snap",
        additions: 3,
        deletions: 1,
        source: "default_pattern",
      },
    ])
  })

  it("excludes a linguist-generated file and reports the source", () => {
    const marked = makeFile({ from: "gen/x.json", to: "gen/x.json" })

    const result = partition([marked, makeFile()], {
      gitAttributesContent: "gen/*.json linguist-generated=true",
    })

    expect(keptPaths(result)).toEqual(["src/app.ts"])
    expect(result.excluded).toEqual([
      {
        path: "gen/x.json",
        additions: 3,
        deletions: 1,
        source: "linguist_generated",
      },
    ])
  })

  it("keeps a default-list match the repo negated in gitattributes", () => {
    const lockfile = makeFile({
      from: "package-lock.json",
      to: "package-lock.json",
    })

    const result = partition([lockfile], {
      defaultPatterns: ["**/package-lock.json"],
      gitAttributesContent: "package-lock.json -linguist-generated",
    })

    expect(result).toEqual({ kept: [lockfile], excluded: [] })
  })

  it("excludes on an operator pattern even when the repo negated the file", () => {
    const lockfile = makeFile({
      from: "package-lock.json",
      to: "package-lock.json",
    })

    const result = partition([lockfile], {
      operatorPatterns: ["**/package-lock.json"],
      gitAttributesContent: "package-lock.json -linguist-generated",
    })

    expect(result.kept).toEqual([])
    expect(result.excluded).toEqual([
      {
        path: "package-lock.json",
        additions: 3,
        deletions: 1,
        source: "operator_pattern",
      },
    ])
  })

  it("judges a deleted file by its old path", () => {
    const deleted = makeFile({
      from: "generated/old.ts",
      to: "/dev/null",
      deleted: true,
    })

    const result = partition([deleted, makeFile()], {
      operatorPatterns: ["generated"],
    })

    expect(keptPaths(result)).toEqual(["src/app.ts"])
    expect(result.excluded).toEqual([
      {
        path: "generated/old.ts",
        additions: 3,
        deletions: 1,
        source: "operator_pattern",
      },
    ])
  })

  it("keeps a file renamed out of an excluded folder", () => {
    const renamedOut = makeFile({
      from: "generated/api.ts",
      to: "src/api.ts",
    })

    const result = partition([renamedOut], {
      operatorPatterns: ["generated"],
    })

    expect(result).toEqual({ kept: [renamedOut], excluded: [] })
  })

  it("excludes a file renamed into an excluded folder", () => {
    const renamedIn = makeFile({
      from: "src/api.ts",
      to: "generated/api.ts",
    })

    const result = partition([renamedIn], {
      operatorPatterns: ["generated"],
    })

    expect(result.kept).toEqual([])
    expect(result.excluded).toEqual([
      {
        path: "generated/api.ts",
        additions: 3,
        deletions: 1,
        source: "operator_pattern",
      },
    ])
  })

  it("strips leading slashes before classification", () => {
    const leadingSlash = makeFile({
      from: "/generated/api.ts",
      to: "/generated/api.ts",
    })

    const result = partition([leadingSlash], {
      operatorPatterns: ["generated"],
    })

    expect(result.excluded).toEqual([
      {
        path: "generated/api.ts",
        additions: 3,
        deletions: 1,
        source: "operator_pattern",
      },
    ])
  })
})

describe("renderExcludedFilesNote", () => {
  it("returns an empty string for no exclusions", () => {
    expect(renderExcludedFilesNote([])).toBe("")
  })

  it("renders one line per file with change counts and source labels", () => {
    const excluded: ExcludedDiffFile[] = [
      {
        path: "package-lock.json",
        additions: 1200,
        deletions: 800,
        source: "default_pattern",
      },
      {
        path: "evals/run.json",
        additions: 10,
        deletions: 0,
        source: "operator_pattern",
      },
      {
        path: "gen/x.json",
        additions: 5,
        deletions: 5,
        source: "linguist_generated",
      },
    ]

    // Pinned format: the per-file lines must not resemble the diff's
    // "=== path ===" headers, which are the model's only citable anchors
    expect(renderExcludedFilesNote(excluded)).toBe(
      [
        "3 changed file(s) excluded from review (content not shown):",
        "- package-lock.json (+1200/-800, built-in default list)",
        "- evals/run.json (+10/-0, diff_exclude_paths input)",
        "- gen/x.json (+5/-5, linguist-generated attribute)",
      ].join("\n"),
    )
  })
})

describe("summarizeExclusionSources", () => {
  it("counts each source with operator patterns first and defaults last", () => {
    const excluded: ExcludedDiffFile[] = [
      {
        path: "package-lock.json",
        additions: 1,
        deletions: 1,
        source: "default_pattern",
      },
      {
        path: "yarn.lock",
        additions: 1,
        deletions: 1,
        source: "default_pattern",
      },
      {
        path: "evals/run.json",
        additions: 1,
        deletions: 1,
        source: "operator_pattern",
      },
      {
        path: "gen/x.json",
        additions: 1,
        deletions: 1,
        source: "linguist_generated",
      },
    ]

    expect(summarizeExclusionSources(excluded)).toBe(
      "1 by diff_exclude_paths input, 1 by linguist-generated attribute, 2 by built-in default list",
    )
  })

  it("omits sources that excluded nothing", () => {
    const excluded: ExcludedDiffFile[] = [
      {
        path: "package-lock.json",
        additions: 1,
        deletions: 1,
        source: "default_pattern",
      },
    ]

    expect(summarizeExclusionSources(excluded)).toBe(
      "1 by built-in default list",
    )
  })
})
