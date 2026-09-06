import type { File } from "parse-diff"
import { describe, expect, it } from "vitest"
import { DEFAULT_DIFF_EXCLUDE_PATTERNS } from "../../config.js"
import {
  partitionExcludedFiles,
  renderExcludedFilesNote,
  summarizeExclusionSources,
  type ExcludedDiffFile,
} from "../exclude-diff-files.js"

const makeFile = (overrides: Partial<File> = {}): File => ({
  chunks: [],
  additions: 3,
  deletions: 1,
  from: "src/app.ts",
  to: "src/app.ts",
  ...overrides,
})

const partition = (
  files: File[],
  overrides: {
    defaultPatterns?: string[]
    operatorPatterns?: string[]
    linguistRules?: { pattern: string; generated: boolean }[]
  } = {},
) => {
  return partitionExcludedFiles({
    files,
    defaultPatterns: overrides.defaultPatterns ?? [],
    operatorPatterns: overrides.operatorPatterns ?? [],
    linguistRules: overrides.linguistRules ?? [],
  })
}

const keptPaths = (result: { kept: File[] }): (string | undefined)[] => {
  return result.kept.map((file) => file.to ?? file.from)
}

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
      linguistRules: [{ pattern: "gen/*.json", generated: true }],
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
      linguistRules: [{ pattern: "package-lock.json", generated: false }],
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
      linguistRules: [{ pattern: "package-lock.json", generated: false }],
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
