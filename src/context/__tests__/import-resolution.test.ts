import { describe, expect, it } from "vitest"
import {
  extractImportSpecifiers,
  resolveImportSpecifier,
} from "../import-resolution.js"

describe("extractImportSpecifiers", () => {
  it("extracts static, dynamic, and require specifiers from one source", () => {
    const source = [
      `import { a } from "./a.js"`,
      `import type { B } from '../b.js'`,
      `const lazy = await import("./lazy.js")`,
      `const legacy = require("./legacy.cjs")`,
      `import zod from "zod"`,
    ].join("\n")

    const specifiers = extractImportSpecifiers(source)

    expect(specifiers).toEqual([
      "./a.js",
      "../b.js",
      "./lazy.js",
      "./legacy.cjs",
      "zod",
    ])
  })

  it("returns an empty list for a source with no imports", () => {
    const specifiers = extractImportSpecifiers(`export const answer = 42`)

    expect(specifiers).toEqual([])
  })

  it("extracts a quoted specifier inside a comment (grep-style by design)", () => {
    const specifiers = extractImportSpecifiers(`// import { x } from "./x.js"`)

    expect(specifiers).toEqual(["./x.js"])
  })
})

describe("resolveImportSpecifier", () => {
  const scenarios = [
    {
      name: "remaps a sibling .js specifier to .ts and .tsx",
      importerPath: "src/caller.ts",
      specifier: "./greeter.js",
      expected: ["src/greeter.js", "src/greeter.ts", "src/greeter.tsx"],
    },
    {
      name: "resolves a parent-directory .js specifier",
      importerPath: "src/a/b.ts",
      specifier: "../util.js",
      expected: ["src/util.js", "src/util.ts", "src/util.tsx"],
    },
    {
      name: "remaps .mjs to .mts",
      importerPath: "src/caller.ts",
      specifier: "./worker.mjs",
      expected: ["src/worker.mjs", "src/worker.mts"],
    },
    {
      name: "remaps .cjs to .cts",
      importerPath: "src/caller.ts",
      specifier: "./legacy.cjs",
      expected: ["src/legacy.cjs", "src/legacy.cts"],
    },
    {
      name: "keeps an explicit .ts specifier as the only candidate",
      importerPath: "src/caller.ts",
      specifier: "./greeter.ts",
      expected: ["src/greeter.ts"],
    },
    {
      name: "expands an extensionless specifier with suffixes and index files",
      importerPath: "src/caller.ts",
      specifier: "./lib",
      expected: [
        "src/lib",
        "src/lib.ts",
        "src/lib.tsx",
        "src/lib.js",
        "src/lib.jsx",
        "src/lib/index.ts",
        "src/lib/index.js",
      ],
    },
    {
      name: "returns no candidates for a package specifier",
      importerPath: "src/caller.ts",
      specifier: "zod",
      expected: [],
    },
    {
      name: "returns no candidates for a node built-in",
      importerPath: "src/caller.ts",
      specifier: "node:path",
      expected: [],
    },
    {
      name: "returns no candidates when the join escapes the workspace root",
      importerPath: "src/caller.ts",
      specifier: "../../outside.js",
      expected: [],
    },
  ]

  it.each(scenarios)("$name", ({ importerPath, specifier, expected }) => {
    const candidates = resolveImportSpecifier({ importerPath, specifier })

    expect(candidates).toEqual(expected)
  })
})
