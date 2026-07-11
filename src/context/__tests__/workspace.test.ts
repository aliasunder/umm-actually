import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { createTestLogger } from "../../__tests__/test-logger.js"
import { estimateTokens } from "../../review/prompt.js"
import { createContextReader, MAX_SCAN_FILES } from "../workspace.js"

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

const makeReader = () => {
  const logger = createTestLogger()
  const contextReader = createContextReader({ workspaceRoot }, logger)
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
    ).rejects.toThrow("path escapes the workspace: ../outside.md")
  })
})

describe("readChangedFiles", () => {
  it("includes files in full and subtracts their tokens from the budget", async () => {
    const { contextReader } = makeReader()

    const result = await contextReader.readChangedFiles({
      changedPaths: ["src/greeter.ts", "src/registry.ts"],
      budgetTokens: 10_000,
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
    })

    expect(result).toEqual({
      files: [
        { path: "src/caller.ts", content: "", includedAs: "diff-only" },
        { path: "src/greeter.ts", content: greeterContent, includedAs: "full" },
      ],
      remainingTokens: 0,
    })
  })

  it("includes an unreadable file as diff-only with a warning", async () => {
    const { contextReader, logger } = makeReader()

    const result = await contextReader.readChangedFiles({
      changedPaths: ["src/missing.ts"],
      budgetTokens: 10_000,
    })

    expect(result.files).toEqual([
      { path: "src/missing.ts", content: "", includedAs: "diff-only" },
    ])
    expect(logger.messages).toContainEqual({
      level: "warn",
      message: "changed file unreadable — including as diff-only",
      data: { path: "src/missing.ts" },
    })
  })

  it("includes a binary file as diff-only without a warning", async () => {
    const { contextReader, logger } = makeReader()

    const result = await contextReader.readChangedFiles({
      changedPaths: ["src/data.bin"],
      budgetTokens: 10_000,
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
      }),
    ).rejects.toThrow("path escapes the workspace: ../../etc/passwd")
  })
})

describe("findRelatedFiles", () => {
  it("ranks importers by changed-file import count with test files last", async () => {
    const { contextReader } = makeReader()

    const relatedFiles = await contextReader.findRelatedFiles({
      changedPaths: ["src/greeter.ts", "src/registry.ts"],
      budgetTokens: 100_000,
    })

    expect(relatedFiles).toEqual([
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

    expect(relatedFiles).toEqual([
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

    expect(relatedFiles.map((relatedFile) => relatedFile.path)).toEqual([
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

    expect(relatedFiles.map((relatedFile) => relatedFile.path)).toEqual([
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

    expect(relatedFiles).toEqual([
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
    const contextReader = createContextReader({ workspaceRoot: root }, logger)

    try {
      const relatedFiles = await contextReader.findRelatedFiles({
        changedPaths: ["target.ts"],
        budgetTokens: 1_000_000,
      })

      expect(relatedFiles.map((relatedFile) => relatedFile.path)).toEqual([
        "small.ts",
      ])
    } finally {
      await cleanup()
    }
  })

  it("stops scanning at the file cap and warns that detection may be incomplete", async () => {
    const fillerFiles = Object.fromEntries(
      Array.from({ length: MAX_SCAN_FILES + 1 }, (_, fillerIndex) => [
        `filler-${String(fillerIndex).padStart(5, "0")}.ts`,
        "export {}\n",
      ]),
    )
    const { root, cleanup } = await makeTempWorkspace(fillerFiles)
    const logger = createTestLogger()
    const contextReader = createContextReader({ workspaceRoot: root }, logger)

    try {
      await contextReader.findRelatedFiles({
        changedPaths: ["filler-00000.ts"],
        budgetTokens: 100_000,
      })

      expect(logger.messages).toContainEqual({
        level: "warn",
        message:
          "workspace scan capped — related-file detection may be incomplete",
        data: { maxScanFiles: MAX_SCAN_FILES },
      })
    } finally {
      await cleanup()
    }
  })
})
