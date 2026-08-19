import { readFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { createTestLogger } from "../../__tests__/test-logger.js"
import { estimateTokens } from "../../review/prompt.js"
import {
  createContextReader,
  DEFAULT_MAX_SCAN_FILES,
  DEFAULT_MAX_SCAN_BYTES,
  DEFAULT_RELATED_FILES_MAX,
  DEFAULT_RELATED_DOCS_MAX,
  type ContextReaderConfig,
} from "../workspace.js"

const defaultConfig = (workspaceRoot: string): ContextReaderConfig => ({
  workspaceRoot,
  maxScanFiles: DEFAULT_MAX_SCAN_FILES,
  maxScanBytes: DEFAULT_MAX_SCAN_BYTES,
  relatedFilesMax: DEFAULT_RELATED_FILES_MAX,
  relatedDocsMax: DEFAULT_RELATED_DOCS_MAX,
  excludePaths: [],
})

const workspaceRoot = fileURLToPath(
  new URL("../../../fixtures/workspace", import.meta.url),
)

const readFixture = (workspaceRelativePath: string): string =>
  readFileSync(path.join(workspaceRoot, workspaceRelativePath), "utf8")

const greeterContent = readFixture("src/greeter.ts")
const registryContent = readFixture("src/registry.ts")
const callerContent = readFixture("src/caller.ts")
const consumerContent = readFixture("src/consumer.ts")
const barrelConsumerContent = readFixture("src/barrel-consumer.ts")
const greeterTestContent = readFixture("src/__tests__/greeter.test.ts")
const apiDocContent = readFixture("docs/api.md")
const configJsonContent = readFixture("docs/config.json")

const makeReader = () => {
  const logger = createTestLogger()
  const contextReader = createContextReader(
    defaultConfig(workspaceRoot),
    logger,
  )
  return { contextReader, logger }
}

/** Writes a throwaway workspace tree for tests that need sizes or file
 *  counts too unwieldy to commit as fixtures. */
const makeTempWorkspace = async (
  files: Record<string, string>,
): Promise<{ root: string; cleanup: () => Promise<void> }> => {
  const root = await mkdtemp(path.join(tmpdir(), "umm-workspace-"))
  await Promise.all(
    Object.entries(files).map(async ([filePath, content]) => {
      await mkdir(path.dirname(path.join(root, filePath)), { recursive: true })
      await writeFile(path.join(root, filePath), content, "utf8")
    }),
  )
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe("readConventions", () => {
  it("returns the conventions file content", async () => {
    const { contextReader } = makeReader()

    const conventions = await contextReader.readConventions({
      conventionsFile: "AGENTS.md",
    })

    expect(conventions).toBe(
      "# Fixture conventions\n\nUse exact assertions. Never mock what you can stub.\n",
    )
  })

  it("returns null when the conventions file is missing", async () => {
    const { contextReader } = makeReader()

    const conventions = await contextReader.readConventions({
      conventionsFile: "MISSING.md",
    })

    expect(conventions).toBeNull()
  })

  it("throws when the conventions path escapes the workspace", async () => {
    const { contextReader } = makeReader()

    await expect(
      contextReader.readConventions({ conventionsFile: "../outside.md" }),
    ).rejects.toThrow(new Error("path escapes the workspace: ../outside.md"))
  })

  it("follows a symlinked conventions file whose target is inside the workspace", async () => {
    const { root, cleanup } = await makeTempWorkspace({
      "CLAUDE.md": "# Conventions behind a symlink\n",
    })
    await symlink(path.join(root, "CLAUDE.md"), path.join(root, "AGENTS.md"))
    const contextReader = createContextReader(
      defaultConfig(root),
      createTestLogger(),
    )

    try {
      const conventions = await contextReader.readConventions({
        conventionsFile: "AGENTS.md",
      })

      expect(conventions).toBe("# Conventions behind a symlink\n")
    } finally {
      await cleanup()
    }
  })

  it("throws when the conventions file symlinks to a target outside the workspace", async () => {
    // The outside target must exist: a dangling link would reject with ENOENT
    // (the missing-file path) and pass this test without the escape guard
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "umm-outside-"))
    await writeFile(
      path.join(outsideRoot, "secret.md"),
      "runner secret",
      "utf8",
    )
    const { root, cleanup } = await makeTempWorkspace({
      "README.md": "# fixture\n",
    })
    await symlink(
      path.join(outsideRoot, "secret.md"),
      path.join(root, "AGENTS.md"),
    )
    const contextReader = createContextReader(
      defaultConfig(root),
      createTestLogger(),
    )

    try {
      await expect(
        contextReader.readConventions({ conventionsFile: "AGENTS.md" }),
      ).rejects.toThrow(new Error("path escapes the workspace: AGENTS.md"))
    } finally {
      await cleanup()
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })
})

describe("readChangedFiles", () => {
  it("includes files in full and subtracts their tokens from the budget", async () => {
    const { contextReader } = makeReader()

    const result = await contextReader.readChangedFiles({
      changedPaths: ["src/greeter.ts", "src/registry.ts"],
      budgetTokens: 10_000,
      diffOnlyPaths: [],
    })

    expect(result).toEqual({
      files: [
        { path: "src/greeter.ts", content: greeterContent, includedAs: "full" },
        {
          path: "src/registry.ts",
          content: registryContent,
          includedAs: "full",
        },
      ],
      remainingTokens:
        10_000 -
        estimateTokens(greeterContent) -
        estimateTokens(registryContent),
    })
  })

  it("flips an over-budget file to diff-only while a later smaller file still fits", async () => {
    const { contextReader } = makeReader()

    const result = await contextReader.readChangedFiles({
      changedPaths: ["src/caller.ts", "src/greeter.ts"],
      budgetTokens: estimateTokens(greeterContent),
      diffOnlyPaths: [],
    })

    expect(result).toEqual({
      files: [
        { path: "src/caller.ts", content: "", includedAs: "diff-only" },
        { path: "src/greeter.ts", content: greeterContent, includedAs: "full" },
      ],
      remainingTokens: 0,
    })
  })

  it("includes a diffOnlyPaths entry as diff-only and spends no budget on it", async () => {
    const { contextReader, logger } = makeReader()

    const result = await contextReader.readChangedFiles({
      changedPaths: ["AGENTS.md", "src/greeter.ts"],
      budgetTokens: 10_000,
      diffOnlyPaths: ["AGENTS.md"],
    })

    expect(result).toEqual({
      files: [
        { path: "AGENTS.md", content: "", includedAs: "diff-only" },
        { path: "src/greeter.ts", content: greeterContent, includedAs: "full" },
      ],
      remainingTokens: 10_000 - estimateTokens(greeterContent),
    })
    expect(logger.messages).toContainEqual({
      level: "info",
      message:
        "changed file already rendered in full elsewhere — including diff-only",
      data: { path: "AGENTS.md" },
    })
  })

  it("normalizes diffOnlyPaths before matching changed paths", async () => {
    const { contextReader } = makeReader()

    const result = await contextReader.readChangedFiles({
      changedPaths: ["AGENTS.md"],
      budgetTokens: 10_000,
      diffOnlyPaths: ["./AGENTS.md"],
    })

    expect(result).toEqual({
      files: [{ path: "AGENTS.md", content: "", includedAs: "diff-only" }],
      remainingTokens: 10_000,
    })
  })

  it("includes changed lockfiles as diff-only by name, not size — a tiny lockfile is still demoted and consumes no budget", async () => {
    const appContent = "export const app = 1"
    const { root, cleanup } = await makeTempWorkspace({
      "package-lock.json": '{"lockfileVersion": 3}',
      "packages/cli/yarn.lock": "# yarn lockfile v1",
      "src/app.ts": appContent,
    })
    const contextReader = createContextReader(
      defaultConfig(root),
      createTestLogger(),
    )

    try {
      const result = await contextReader.readChangedFiles({
        changedPaths: [
          "package-lock.json",
          "packages/cli/yarn.lock",
          "src/app.ts",
        ],
        budgetTokens: 10_000,
        diffOnlyPaths: [],
      })

      expect(result).toEqual({
        files: [
          { path: "package-lock.json", content: "", includedAs: "diff-only" },
          {
            path: "packages/cli/yarn.lock",
            content: "",
            includedAs: "diff-only",
          },
          { path: "src/app.ts", content: appContent, includedAs: "full" },
        ],
        remainingTokens: 10_000 - estimateTokens(appContent),
      })
    } finally {
      await cleanup()
    }
  })

  it("demotes a file whose byte size exceeds the byte budget before reading it", async () => {
    // Multibyte content: 400 chars fit a 100-token budget, but 1200 UTF-8
    // bytes exceed it — only the stat-first byte guard demotes this file;
    // the post-read token check would have included it.
    const multibyteContent = "あ".repeat(400)
    const { root, cleanup } = await makeTempWorkspace({
      "src/large.ts": multibyteContent,
    })
    const contextReader = createContextReader(
      defaultConfig(root),
      createTestLogger(),
    )

    try {
      const result = await contextReader.readChangedFiles({
        changedPaths: ["src/large.ts"],
        budgetTokens: estimateTokens(multibyteContent),
        diffOnlyPaths: [],
      })

      expect(result).toEqual({
        files: [{ path: "src/large.ts", content: "", includedAs: "diff-only" }],
        remainingTokens: estimateTokens(multibyteContent),
      })
    } finally {
      await cleanup()
    }
  })

  it("includes a missing file as diff-only with an info log, not a warning", async () => {
    const { contextReader, logger } = makeReader()

    const result = await contextReader.readChangedFiles({
      changedPaths: ["src/missing.ts"],
      budgetTokens: 10_000,
      diffOnlyPaths: [],
    })

    expect(result.files).toEqual([
      { path: "src/missing.ts", content: "", includedAs: "diff-only" },
    ])
    expect(logger.messages).toContainEqual({
      level: "info",
      message: "changed file missing from checkout — including as diff-only",
      data: { path: "src/missing.ts" },
    })
    expect(
      logger.messages.filter((message) => message.level === "warn"),
    ).toEqual([])
  })

  it("includes an unreadable file as diff-only with a warning", async () => {
    const { root, cleanup } = await makeTempWorkspace({
      "src/locked.ts": "export const locked = 1\n",
    })
    await chmod(path.join(root, "src/locked.ts"), 0o000)
    const logger = createTestLogger()
    const contextReader = createContextReader(defaultConfig(root), logger)

    try {
      const result = await contextReader.readChangedFiles({
        changedPaths: ["src/locked.ts"],
        budgetTokens: 10_000,
        diffOnlyPaths: [],
      })

      expect(result.files).toEqual([
        { path: "src/locked.ts", content: "", includedAs: "diff-only" },
      ])
      expect(logger.messages).toContainEqual({
        level: "warn",
        message: "changed file unreadable — including as diff-only",
        data: {
          path: "src/locked.ts",
          error: expect.stringContaining("EACCES"),
        },
      })
    } finally {
      await cleanup()
    }
  })

  it("includes a binary file as diff-only without a warning", async () => {
    const { contextReader, logger } = makeReader()

    const result = await contextReader.readChangedFiles({
      changedPaths: ["src/data.bin"],
      budgetTokens: 10_000,
      diffOnlyPaths: [],
    })

    expect(result.files).toEqual([
      { path: "src/data.bin", content: "", includedAs: "diff-only" },
    ])
    expect(
      logger.messages.filter((message) => message.level === "warn"),
    ).toEqual([])
  })

  it("throws when a changed path escapes the workspace", async () => {
    const { contextReader } = makeReader()

    await expect(
      contextReader.readChangedFiles({
        changedPaths: ["../../etc/passwd"],
        budgetTokens: 10_000,
        diffOnlyPaths: [],
      }),
    ).rejects.toThrow(new Error("path escapes the workspace: ../../etc/passwd"))
  })

  it("degrades a changed file that symlinks outside the workspace to diff-only", async () => {
    // The outside target must exist: a dangling link would take the
    // unreadable path and pass this test without the escape guard
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "umm-outside-"))
    await writeFile(
      path.join(outsideRoot, "secret.txt"),
      "runner secret",
      "utf8",
    )
    const { root, cleanup } = await makeTempWorkspace({
      "src/ok.ts": "export const ok = 1\n",
    })
    await symlink(
      path.join(outsideRoot, "secret.txt"),
      path.join(root, "src/leak.ts"),
    )
    const logger = createTestLogger()
    const contextReader = createContextReader(defaultConfig(root), logger)

    try {
      const result = await contextReader.readChangedFiles({
        changedPaths: ["src/leak.ts"],
        budgetTokens: 10_000,
        diffOnlyPaths: [],
      })

      expect(result.files).toEqual([
        { path: "src/leak.ts", content: "", includedAs: "diff-only" },
      ])
      expect(logger.messages).toContainEqual({
        level: "warn",
        message:
          "changed file resolves outside the reviewable workspace — including as diff-only",
        data: { path: "src/leak.ts" },
      })
    } finally {
      await cleanup()
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it("degrades a changed file that symlinks into .git to diff-only", async () => {
    const { root, cleanup } = await makeTempWorkspace({
      ".git/config": "[http]\n\textraheader = AUTHORIZATION: basic abc123\n",
    })
    await symlink(path.join(root, ".git/config"), path.join(root, "leak.ts"))
    const logger = createTestLogger()
    const contextReader = createContextReader(defaultConfig(root), logger)

    try {
      const result = await contextReader.readChangedFiles({
        changedPaths: ["leak.ts"],
        budgetTokens: 10_000,
        diffOnlyPaths: [],
      })

      expect(result.files).toEqual([
        { path: "leak.ts", content: "", includedAs: "diff-only" },
      ])
      expect(logger.messages).toContainEqual({
        level: "warn",
        message:
          "changed file resolves outside the reviewable workspace — including as diff-only",
        data: { path: "leak.ts" },
      })
    } finally {
      await cleanup()
    }
  })
})

describe("findRelatedFiles", () => {
  it("ranks importers by changed-file import count with test files last", async () => {
    const { contextReader } = makeReader()

    const relatedFiles = await contextReader.findRelatedFiles({
      changedPaths: ["src/greeter.ts", "src/registry.ts"],
      budgetTokens: 100_000,
    })

    expect(relatedFiles.files).toEqual([
      {
        path: "src/caller.ts",
        content: callerContent,
        includedAs: "full",
        reason: "imports src/greeter.ts, src/registry.ts",
      },
      {
        path: "src/consumer.ts",
        content: consumerContent,
        includedAs: "full",
        reason: "imports src/greeter.ts",
      },
      {
        path: "src/__tests__/greeter.test.ts",
        content: greeterTestContent,
        includedAs: "full",
        reason: "imports src/greeter.ts",
      },
    ])
  })

  it("resolves a barrel import to the changed index file", async () => {
    const { contextReader } = makeReader()

    const relatedFiles = await contextReader.findRelatedFiles({
      changedPaths: ["src/lib/index.ts"],
      budgetTokens: 100_000,
    })

    expect(relatedFiles.files).toEqual([
      {
        path: "src/barrel-consumer.ts",
        content: barrelConsumerContent,
        includedAs: "full",
        reason: "imports src/lib/index.ts",
      },
    ])
  })

  it("excludes files that are themselves changed", async () => {
    const { contextReader } = makeReader()

    const relatedFiles = await contextReader.findRelatedFiles({
      changedPaths: ["src/greeter.ts", "src/caller.ts"],
      budgetTokens: 100_000,
    })

    expect(relatedFiles.files.map((relatedFile) => relatedFile.path)).toEqual([
      "src/consumer.ts",
      "src/__tests__/greeter.test.ts",
    ])
  })

  it("caps related files at eight, dropping the lowest-ranked importer", async () => {
    const { contextReader } = makeReader()

    const relatedFiles = await contextReader.findRelatedFiles({
      changedPaths: ["src/hub.ts"],
      budgetTokens: 100_000,
    })

    expect(relatedFiles.files.map((relatedFile) => relatedFile.path)).toEqual([
      "src/importers/importer-1.ts",
      "src/importers/importer-2.ts",
      "src/importers/importer-3.ts",
      "src/importers/importer-4.ts",
      "src/importers/importer-5.ts",
      "src/importers/importer-6.ts",
      "src/importers/importer-7.ts",
      "src/importers/importer-8.ts",
    ])
  })

  it("skips an over-budget candidate but keeps smaller ones that fit", async () => {
    const { contextReader } = makeReader()

    const relatedFiles = await contextReader.findRelatedFiles({
      changedPaths: ["src/greeter.ts", "src/registry.ts"],
      budgetTokens: estimateTokens(consumerContent),
    })

    expect(relatedFiles.files).toEqual([
      {
        path: "src/consumer.ts",
        content: consumerContent,
        includedAs: "full",
        reason: "imports src/greeter.ts",
      },
    ])
  })

  it("skips files larger than the scan byte cap", async () => {
    const oversizedContent = `import { target } from "./target.js"\n${"x".repeat(300_000)}`
    const { root, cleanup } = await makeTempWorkspace({
      "target.ts": `export const target = "target"\n`,
      "big.ts": oversizedContent,
      "small.ts": `import { target } from "./target.js"\nexport const small = target\n`,
    })
    const logger = createTestLogger()
    const contextReader = createContextReader(defaultConfig(root), logger)

    try {
      const relatedFiles = await contextReader.findRelatedFiles({
        changedPaths: ["target.ts"],
        budgetTokens: 1_000_000,
      })

      expect(relatedFiles.files.map((relatedFile) => relatedFile.path)).toEqual(
        ["small.ts"],
      )
    } finally {
      await cleanup()
    }
  })

  it("excludes importers under pruned and hidden directories from the scan", async () => {
    const importTarget = `import { target } from "../target.js"\nexport const found = target\n`
    const { root, cleanup } = await makeTempWorkspace({
      "target.ts": `export const target = "target"\n`,
      "src/legit.ts": importTarget,
      "node_modules/dependency.ts": importTarget,
      "dist/compiled.ts": importTarget,
      ".hidden/covert.ts": importTarget,
    })
    const contextReader = createContextReader(
      defaultConfig(root),
      createTestLogger(),
    )

    try {
      const relatedFiles = await contextReader.findRelatedFiles({
        changedPaths: ["target.ts"],
        budgetTokens: 100_000,
      })

      expect(relatedFiles.files.map((relatedFile) => relatedFile.path)).toEqual(
        ["src/legit.ts"],
      )
    } finally {
      await cleanup()
    }
  })

  it("excludes an unreadable scanned file from related files with a warning", async () => {
    const importTarget = `import { target } from "./target.js"\nexport const found = target\n`
    const { root, cleanup } = await makeTempWorkspace({
      "target.ts": `export const target = "target"\n`,
      "readable.ts": importTarget,
      "locked.ts": importTarget,
    })
    await chmod(path.join(root, "locked.ts"), 0o000)
    const logger = createTestLogger()
    const contextReader = createContextReader(defaultConfig(root), logger)

    try {
      const relatedFiles = await contextReader.findRelatedFiles({
        changedPaths: ["target.ts"],
        budgetTokens: 100_000,
      })

      // readable.ts still arriving proves the scan carried on past the failure
      expect(relatedFiles.files.map((relatedFile) => relatedFile.path)).toEqual(
        ["readable.ts"],
      )
      expect(logger.messages).toContainEqual({
        level: "warn",
        message: "scanned file unreadable — excluding from context",
        data: {
          path: "locked.ts",
          error: expect.stringContaining("EACCES"),
        },
      })
    } finally {
      await cleanup()
    }
  })

  it("excludes an importer carrying a NUL byte, matching the changed-file binary rule", async () => {
    const importTarget = `import { target } from "./target.js"\nexport const found = target\n`
    const { root, cleanup } = await makeTempWorkspace({
      "target.ts": `export const target = "target"\n`,
      "clean.ts": importTarget,
      "binary.ts": `${importTarget}export const marker = "\x00"\n`,
    })
    const contextReader = createContextReader(
      defaultConfig(root),
      createTestLogger(),
    )

    try {
      const relatedFiles = await contextReader.findRelatedFiles({
        changedPaths: ["target.ts"],
        budgetTokens: 100_000,
      })

      expect(relatedFiles.files.map((relatedFile) => relatedFile.path)).toEqual(
        ["clean.ts"],
      )
    } finally {
      await cleanup()
    }
  })

  it("stops scanning at the file cap and warns that detection may be incomplete", async () => {
    const fillerFiles = Object.fromEntries(
      Array.from({ length: DEFAULT_MAX_SCAN_FILES + 1 }, (_, fillerIndex) => [
        `filler-${String(fillerIndex).padStart(5, "0")}.ts`,
        "export {}\n",
      ]),
    )
    const { root, cleanup } = await makeTempWorkspace(fillerFiles)
    const logger = createTestLogger()
    const contextReader = createContextReader(defaultConfig(root), logger)

    try {
      await contextReader.findRelatedFiles({
        changedPaths: ["filler-00000.ts"],
        budgetTokens: 100_000,
      })

      expect(logger.messages).toContainEqual({
        level: "warn",
        message:
          "workspace scan capped — related-file and doc detection may be incomplete",
        data: { maxScanFiles: DEFAULT_MAX_SCAN_FILES },
      })
    } finally {
      await cleanup()
    }
  })

  it("excludes importers under paths listed in excludePaths", async () => {
    const importTarget = `import { target } from "../target.js"\nexport const found = target\n`
    const { root, cleanup } = await makeTempWorkspace({
      "target.ts": `export const target = "target"\n`,
      "src/legit.ts": importTarget,
      "evals/benchmark.ts": importTarget,
      "evals/nested/deep.ts": importTarget,
    })
    const contextReader = createContextReader(
      { ...defaultConfig(root), excludePaths: ["evals"] },
      createTestLogger(),
    )

    try {
      const relatedFiles = await contextReader.findRelatedFiles({
        changedPaths: ["target.ts"],
        budgetTokens: 100_000,
      })

      expect(relatedFiles.files.map((file) => file.path)).toEqual([
        "src/legit.ts",
      ])
    } finally {
      await cleanup()
    }
  })

  it("does not exclude a directory whose name only shares a prefix with an excluded path", async () => {
    const importTarget = `import { target } from "../target.js"\nexport const found = target\n`
    const { root, cleanup } = await makeTempWorkspace({
      "target.ts": `export const target = "target"\n`,
      "evaluation/report.ts": importTarget,
      "evals/benchmark.ts": importTarget,
    })
    const contextReader = createContextReader(
      { ...defaultConfig(root), excludePaths: ["eval"] },
      createTestLogger(),
    )

    try {
      const relatedFiles = await contextReader.findRelatedFiles({
        changedPaths: ["target.ts"],
        budgetTokens: 100_000,
      })

      expect(relatedFiles.files.map((file) => file.path)).toEqual([
        "evals/benchmark.ts",
        "evaluation/report.ts",
      ])
    } finally {
      await cleanup()
    }
  })

  it("excludes importers under multiple excluded paths", async () => {
    const importTarget = `import { target } from "../target.js"\nexport const found = target\n`
    const { root, cleanup } = await makeTempWorkspace({
      "target.ts": `export const target = "target"\n`,
      "src/legit.ts": importTarget,
      "fixtures/stub.ts": importTarget,
      "evals/benchmark.ts": importTarget,
    })
    const contextReader = createContextReader(
      { ...defaultConfig(root), excludePaths: ["fixtures", "evals"] },
      createTestLogger(),
    )

    try {
      const relatedFiles = await contextReader.findRelatedFiles({
        changedPaths: ["target.ts"],
        budgetTokens: 100_000,
      })

      expect(relatedFiles.files.map((file) => file.path)).toEqual([
        "src/legit.ts",
      ])
    } finally {
      await cleanup()
    }
  })
})

describe("findRelatedDocs", () => {
  it("finds docs that mention changed paths", async () => {
    const { contextReader } = makeReader()

    const relatedDocs = await contextReader.findRelatedDocs({
      changedPaths: ["src/greeter.ts"],
      budgetTokens: 100_000,
      conventionsFile: "AGENTS.md",
      excludePaths: [],
    })

    expect(relatedDocs.files).toEqual([
      {
        path: "docs/api.md",
        content: apiDocContent,
        includedAs: "full",
        reason: "mentions src/greeter.ts",
      },
    ])
  })

  it("finds docs with multiple mentioned paths", async () => {
    const { contextReader } = makeReader()

    const relatedDocs = await contextReader.findRelatedDocs({
      changedPaths: ["src/greeter.ts", "src/registry.ts"],
      budgetTokens: 100_000,
      conventionsFile: "AGENTS.md",
      excludePaths: [],
    })

    expect(relatedDocs.files).toEqual([
      {
        path: "docs/api.md",
        content: apiDocContent,
        includedAs: "full",
        reason: "mentions src/greeter.ts, src/registry.ts",
      },
    ])
  })

  it("finds JSON doc files that mention changed paths", async () => {
    const { contextReader } = makeReader()

    const relatedDocs = await contextReader.findRelatedDocs({
      changedPaths: ["src/hub.ts"],
      budgetTokens: 100_000,
      conventionsFile: "AGENTS.md",
      excludePaths: [],
    })

    expect(relatedDocs.files).toEqual([
      {
        path: "docs/config.json",
        content: configJsonContent,
        includedAs: "full",
        reason: "mentions src/hub.ts",
      },
    ])
  })

  it("excludes the conventions file from results even when it mentions changed paths", async () => {
    const { root, cleanup } = await makeTempWorkspace({
      "AGENTS.md": "# Conventions\n\nSee src/target.ts for the implementation.",
      "docs/other.md": "# Other\n\nAlso references src/target.ts here.",
      "src/target.ts": "export const target = true",
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const relatedDocs = await reader.findRelatedDocs({
        changedPaths: ["src/target.ts"],
        budgetTokens: 100_000,
        conventionsFile: "AGENTS.md",
        excludePaths: [],
      })

      // docs/other.md proves the scan ran and found results; AGENTS.md is
      // excluded despite mentioning the changed path
      expect(relatedDocs.files).toEqual([
        {
          path: "docs/other.md",
          content: "# Other\n\nAlso references src/target.ts here.",
          includedAs: "full",
          reason: "mentions src/target.ts",
        },
      ])
    } finally {
      await cleanup()
    }
  })

  it("excludes changed docs from results", async () => {
    const retainedContent = "# Retained\n\nAlso references src/target.ts here."
    const { root, cleanup } = await makeTempWorkspace({
      "docs/changed.md": "# Changed\n\nSee src/target.ts for details.",
      "docs/retained.md": retainedContent,
      "src/target.ts": "export const target = true",
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const relatedDocs = await reader.findRelatedDocs({
        changedPaths: ["src/target.ts", "docs/changed.md"],
        budgetTokens: 100_000,
        conventionsFile: "AGENTS.md",
        excludePaths: [],
      })

      expect(relatedDocs.files).toEqual([
        {
          path: "docs/retained.md",
          content: retainedContent,
          includedAs: "full",
          reason: "mentions src/target.ts",
        },
      ])
    } finally {
      await cleanup()
    }
  })

  it("returns empty array when no docs mention changed paths", async () => {
    const { contextReader } = makeReader()

    const relatedDocs = await contextReader.findRelatedDocs({
      changedPaths: ["src/nonexistent.ts"],
      budgetTokens: 100_000,
      conventionsFile: "AGENTS.md",
      excludePaths: [],
    })

    expect(relatedDocs.files).toEqual([])
  })

  it("respects the token budget", async () => {
    const { contextReader } = makeReader()

    const relatedDocs = await contextReader.findRelatedDocs({
      changedPaths: ["src/greeter.ts"],
      budgetTokens: 1,
      conventionsFile: "AGENTS.md",
      excludePaths: [],
    })

    expect(relatedDocs.files).toEqual([])
  })

  it("caps results at DEFAULT_RELATED_DOCS_MAX, keeping alphabetically first docs", async () => {
    const docFiles: Record<string, string> = {}
    for (
      let fileIndex = 0;
      fileIndex < DEFAULT_RELATED_DOCS_MAX + 2;
      fileIndex++
    ) {
      docFiles[`docs/doc-${fileIndex}.md`] =
        `# Doc ${fileIndex}\n\nSee src/target.ts for details.`
    }
    docFiles["src/target.ts"] = "export const target = true"

    const { root, cleanup } = await makeTempWorkspace(docFiles)
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const relatedDocs = await reader.findRelatedDocs({
        changedPaths: ["src/target.ts"],
        budgetTokens: 100_000,
        conventionsFile: "AGENTS.md",
        excludePaths: [],
      })

      // All 6 docs have identical relevance (1 full-path mention each), so
      // alphabetical tiebreaker determines which 4 survive the cap
      expect(relatedDocs.files.map((doc) => doc.path)).toEqual([
        "docs/doc-0.md",
        "docs/doc-1.md",
        "docs/doc-2.md",
        "docs/doc-3.md",
      ])
      expect(relatedDocs.excludedByCapPaths).toEqual([
        "docs/doc-4.md",
        "docs/doc-5.md",
      ])
    } finally {
      await cleanup()
    }
  })

  it("honors a custom relatedDocsMax cap", async () => {
    const { root, cleanup } = await makeTempWorkspace({
      "docs/a.md": "# A\n\nSee src/target.ts for details.",
      "docs/b.md": "# B\n\nSee src/target.ts for details.",
      "docs/c.md": "# C\n\nSee src/target.ts for details.",
      "src/target.ts": "export const target = true",
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(
        { ...defaultConfig(root), relatedDocsMax: 2 },
        logger,
      )

      const relatedDocs = await reader.findRelatedDocs({
        changedPaths: ["src/target.ts"],
        budgetTokens: 100_000,
        conventionsFile: "AGENTS.md",
        excludePaths: [],
      })

      expect(relatedDocs.files.map((doc) => doc.path)).toEqual([
        "docs/a.md",
        "docs/b.md",
      ])
    } finally {
      await cleanup()
    }
  })

  it("skips binary doc files", async () => {
    const { root, cleanup } = await makeTempWorkspace({
      "docs/binary.md": "# Binary\n\nSee src/target.ts\x00binary data",
      "src/target.ts": "export const target = true",
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const relatedDocs = await reader.findRelatedDocs({
        changedPaths: ["src/target.ts"],
        budgetTokens: 100_000,
        conventionsFile: "AGENTS.md",
        excludePaths: [],
      })

      expect(relatedDocs.files).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it("truncates the reason to three paths with an overflow count", async () => {
    const { root, cleanup } = await makeTempWorkspace({
      "docs/mentions-many.md": [
        "# Many mentions",
        "See src/a.ts, src/b.ts, src/c.ts, and src/d.ts for details.",
      ].join("\n"),
      "src/a.ts": "export const a = 1",
      "src/b.ts": "export const b = 2",
      "src/c.ts": "export const c = 3",
      "src/d.ts": "export const d = 4",
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const relatedDocs = await reader.findRelatedDocs({
        changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
        budgetTokens: 100_000,
        conventionsFile: "AGENTS.md",
        excludePaths: [],
      })

      expect(relatedDocs.files).toEqual([
        {
          path: "docs/mentions-many.md",
          content:
            "# Many mentions\nSee src/a.ts, src/b.ts, src/c.ts, and src/d.ts for details.",
          includedAs: "full",
          reason: "mentions src/a.ts, src/b.ts, src/c.ts, +1 more",
        },
      ])
    } finally {
      await cleanup()
    }
  })

  it("ranks full-path mentions above basename-only mentions", async () => {
    const basenameContent = "# Basename\n\nSee greeter.ts for greetings."
    const fullPathContent = "# Full Path\n\nSee src/greeter.ts for greetings."
    const { root, cleanup } = await makeTempWorkspace({
      "docs/basename-only.md": basenameContent,
      "docs/full-path.md": fullPathContent,
      "src/greeter.ts": "export const greet = () => 'hi'",
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const relatedDocs = await reader.findRelatedDocs({
        changedPaths: ["src/greeter.ts"],
        budgetTokens: 100_000,
        conventionsFile: "AGENTS.md",
        excludePaths: [],
      })

      expect(relatedDocs.files).toEqual([
        {
          path: "docs/full-path.md",
          content: fullPathContent,
          includedAs: "full",
          reason: "mentions src/greeter.ts",
        },
        {
          path: "docs/basename-only.md",
          content: basenameContent,
          includedAs: "full",
          reason: "mentions src/greeter.ts",
        },
      ])
    } finally {
      await cleanup()
    }
  })

  it("excludes paths listed in excludePaths from mention-matched results", async () => {
    const readmeContent = "# My Project\n\nSee src/target.ts for details."
    const { root, cleanup } = await makeTempWorkspace({
      "README.md": readmeContent,
      "src/target.ts": "export const target = true",
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const relatedDocs = await reader.findRelatedDocs({
        changedPaths: ["src/target.ts"],
        budgetTokens: 100_000,
        conventionsFile: "AGENTS.md",
        excludePaths: ["README.md"],
      })

      expect(relatedDocs.files).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it("excludes docs under paths listed in excludePaths", async () => {
    const { root, cleanup } = await makeTempWorkspace({
      "src/target.ts": `export const target = "target"\n`,
      "docs/guide.md": "See `src/target.ts` for the implementation.\n",
      "evals/report.md": "Evaluated `src/target.ts` on 100 samples.\n",
      "evals/iteration-1/summary.md":
        "The `src/target.ts` module scored 95%.\n",
    })
    const contextReader = createContextReader(
      { ...defaultConfig(root), excludePaths: ["evals"] },
      createTestLogger(),
    )

    try {
      const relatedDocs = await contextReader.findRelatedDocs({
        changedPaths: ["src/target.ts"],
        budgetTokens: 100_000,
        conventionsFile: "AGENTS.md",
        excludePaths: [],
      })

      expect(relatedDocs.files.map((file) => file.path)).toEqual([
        "docs/guide.md",
      ])
    } finally {
      await cleanup()
    }
  })
})

describe("readPriorityDocs", () => {
  it("reads a priority doc and tracks remaining budget", async () => {
    const readmeContent = "# My Project\n\nGeneral overview with no file refs."
    const { root, cleanup } = await makeTempWorkspace({
      "README.md": readmeContent,
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const result = await reader.readPriorityDocs({
        priorityDocs: ["README.md"],
        budgetTokens: 100_000,
        excludePaths: [],
      })

      expect(result).toEqual({
        files: [
          {
            path: "README.md",
            content: readmeContent,
            includedAs: "full",
            reason: "priority documentation",
          },
        ],
        remainingTokens: 100_000 - estimateTokens(readmeContent),
      })
    } finally {
      await cleanup()
    }
  })

  it("skips a doc whose byte size exceeds the byte budget before reading it", async () => {
    // Multibyte content: 400 chars fit a 100-token budget, but 1200 UTF-8
    // bytes exceed it — only the stat-first byte guard skips this doc;
    // the post-read token check would have included it.
    const multibyteContent = "あ".repeat(400)
    const { root, cleanup } = await makeTempWorkspace({
      "README.md": multibyteContent,
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const result = await reader.readPriorityDocs({
        priorityDocs: ["README.md"],
        budgetTokens: estimateTokens(multibyteContent),
        excludePaths: [],
      })

      expect(result).toEqual({
        files: [],
        remainingTokens: estimateTokens(multibyteContent),
      })
      expect(logger.messages).toContainEqual({
        level: "warn",
        message: "priority doc exceeds remaining context budget — skipping",
        data: { path: "README.md" },
      })
    } finally {
      await cleanup()
    }
  })

  it("skips a missing priority doc with an info log", async () => {
    const { root, cleanup } = await makeTempWorkspace({
      "src/target.ts": "export const target = true",
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const result = await reader.readPriorityDocs({
        priorityDocs: ["README.md"],
        budgetTokens: 100_000,
        excludePaths: [],
      })

      expect(result).toEqual({ files: [], remainingTokens: 100_000 })
      expect(logger.messages).toContainEqual({
        level: "info",
        message: "priority doc not found — skipping",
        data: { path: "README.md" },
      })
    } finally {
      await cleanup()
    }
  })

  it("skips a priority doc that escapes the workspace with a warn log", async () => {
    const { root, cleanup } = await makeTempWorkspace({
      "src/target.ts": "export const target = true",
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const result = await reader.readPriorityDocs({
        priorityDocs: ["../../etc/passwd"],
        budgetTokens: 100_000,
        excludePaths: [],
      })

      expect(result).toEqual({ files: [], remainingTokens: 100_000 })
      expect(logger.messages).toContainEqual({
        level: "warn",
        message: "priority doc path escapes workspace — skipping",
        data: { path: "../../etc/passwd" },
      })
    } finally {
      await cleanup()
    }
  })

  it("skips an unreadable priority doc with a warn log", async () => {
    const { root, cleanup } = await makeTempWorkspace({
      "README.md": "# Unreadable",
    })
    await chmod(path.join(root, "README.md"), 0o000)
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const result = await reader.readPriorityDocs({
        priorityDocs: ["README.md"],
        budgetTokens: 100_000,
        excludePaths: [],
      })

      expect(result).toEqual({ files: [], remainingTokens: 100_000 })
      expect(logger.messages).toContainEqual({
        level: "warn",
        message: "priority doc unreadable — skipping",
        data: { path: "README.md", error: expect.stringContaining("EACCES") },
      })
    } finally {
      await chmod(path.join(root, "README.md"), 0o644)
      await cleanup()
    }
  })

  it("skips a symlinked priority doc that resolves outside the workspace", async () => {
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "umm-outside-"))
    await writeFile(
      path.join(outsideRoot, "secret.md"),
      "runner secret",
      "utf8",
    )
    const { root, cleanup } = await makeTempWorkspace({
      "src/placeholder.ts": "export {}",
    })
    await symlink(
      path.join(outsideRoot, "secret.md"),
      path.join(root, "README.md"),
    )
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const result = await reader.readPriorityDocs({
        priorityDocs: ["README.md"],
        budgetTokens: 100_000,
        excludePaths: [],
      })

      expect(result).toEqual({ files: [], remainingTokens: 100_000 })
      expect(logger.messages).toContainEqual({
        level: "warn",
        message:
          "priority doc resolves outside the reviewable workspace — skipping",
        data: { path: "README.md" },
      })
    } finally {
      await cleanup()
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it("skips a priority doc that exceeds the budget", async () => {
    const readmeContent = "# Project\n\n" + "x".repeat(400)
    const { root, cleanup } = await makeTempWorkspace({
      "README.md": readmeContent,
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const result = await reader.readPriorityDocs({
        priorityDocs: ["README.md"],
        budgetTokens: 1,
        excludePaths: [],
      })

      expect(result).toEqual({ files: [], remainingTokens: 1 })
    } finally {
      await cleanup()
    }
  })

  it("skips binary priority docs", async () => {
    const { root, cleanup } = await makeTempWorkspace({
      "README.md": "# Binary\x00content",
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const result = await reader.readPriorityDocs({
        priorityDocs: ["README.md"],
        budgetTokens: 100_000,
        excludePaths: [],
      })

      expect(result).toEqual({ files: [], remainingTokens: 100_000 })
    } finally {
      await cleanup()
    }
  })

  it("skips a doc listed in excludePaths and reads the rest", async () => {
    const guideContent = "# Guide"
    const { root, cleanup } = await makeTempWorkspace({
      "README.md": "# Already a changed file",
      "GUIDE.md": guideContent,
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const result = await reader.readPriorityDocs({
        priorityDocs: ["README.md", "GUIDE.md"],
        budgetTokens: 100_000,
        excludePaths: ["README.md"],
      })

      expect(result).toEqual({
        files: [
          {
            path: "GUIDE.md",
            content: guideContent,
            includedAs: "full",
            reason: "priority documentation",
          },
        ],
        remainingTokens: 100_000 - estimateTokens(guideContent),
      })
      expect(logger.messages).toContainEqual({
        level: "info",
        message: "priority doc already in context — skipping re-read",
        data: { path: "README.md" },
      })
    } finally {
      await cleanup()
    }
  })

  it("reads a doc once when priority_docs names it under two spellings", async () => {
    const readmeContent = "# Listed twice"
    const guideContent = "# Guide"
    const { root, cleanup } = await makeTempWorkspace({
      "README.md": readmeContent,
      "GUIDE.md": guideContent,
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const result = await reader.readPriorityDocs({
        priorityDocs: ["README.md", "./README.md", "GUIDE.md"],
        budgetTokens: 100_000,
        excludePaths: [],
      })

      expect(result).toEqual({
        files: [
          {
            path: "README.md",
            content: readmeContent,
            includedAs: "full",
            reason: "priority documentation",
          },
          {
            path: "GUIDE.md",
            content: guideContent,
            includedAs: "full",
            reason: "priority documentation",
          },
        ],
        remainingTokens:
          100_000 -
          estimateTokens(readmeContent) -
          estimateTokens(guideContent),
      })
      expect(logger.messages).toContainEqual({
        level: "info",
        message: "priority doc listed more than once — skipping duplicate",
        data: { path: "./README.md" },
      })
    } finally {
      await cleanup()
    }
  })

  it("normalizes excludePaths before comparing against priority docs", async () => {
    const { root, cleanup } = await makeTempWorkspace({
      "README.md": "# Already a changed file",
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const result = await reader.readPriorityDocs({
        priorityDocs: ["./README.md"],
        budgetTokens: 100_000,
        excludePaths: ["README.md"],
      })

      expect(result).toEqual({ files: [], remainingTokens: 100_000 })
    } finally {
      await cleanup()
    }
  })

  it("leaves the token budget untouched for an excluded doc", async () => {
    // The point of the exclusion is that the doc's tokens are spent once, by
    // the channel that already claimed it — a skip that still decremented the
    // budget would starve findRelatedDocs for no gain.
    const readmeContent = "# A reasonably long readme body to spend budget on"
    const { root, cleanup } = await makeTempWorkspace({
      "README.md": readmeContent,
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const result = await reader.readPriorityDocs({
        priorityDocs: ["README.md"],
        budgetTokens: 100_000,
        excludePaths: ["README.md"],
      })

      expect(result).toEqual({ files: [], remainingTokens: 100_000 })
    } finally {
      await cleanup()
    }
  })

  it("returns empty files and full budget when priorityDocs is empty", async () => {
    const { root, cleanup } = await makeTempWorkspace({
      "README.md": "# Project",
    })
    try {
      const logger = createTestLogger()
      const reader = createContextReader(defaultConfig(root), logger)

      const result = await reader.readPriorityDocs({
        priorityDocs: [],
        budgetTokens: 100_000,
        excludePaths: [],
      })

      expect(result).toEqual({ files: [], remainingTokens: 100_000 })
    } finally {
      await cleanup()
    }
  })
})
