import { readFile, readdir, realpath, stat } from "node:fs/promises"
import path, { posix } from "node:path"
import type { Logger } from "../logger.js"
import {
  CHARS_PER_TOKEN,
  estimateTokens,
  type PromptFile,
} from "../review/prompt.js"
import {
  DOC_EXTENSIONS,
  byMentionRelevance,
  findMentionedChangedPaths,
  type DocCandidate,
} from "./doc-mentions.js"
import {
  extractImportSpecifiers,
  resolveImportSpecifier,
} from "./import-resolution.js"

export type BudgetedFiles = { files: PromptFile[]; remainingTokens: number }

export type ContextReader = {
  /** null when the file is missing — the prompt renders a "(no conventions…)" block. */
  readConventions: (params: {
    conventionsFile: string
  }) => Promise<string | null>
  readChangedFiles: (params: {
    changedPaths: string[]
    budgetTokens: number
  }) => Promise<BudgetedFiles>
  findRelatedFiles: (params: {
    changedPaths: string[]
    budgetTokens: number
  }) => Promise<PromptFile[]>
  findRelatedDocs: (params: {
    changedPaths: string[]
    budgetTokens: number
    conventionsFile: string
  }) => Promise<PromptFile[]>
}

const SCANNABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
])

/** Dependency, VCS, and build-output trees — never review context. */
const PRUNED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
])

/** Scan bounds: a related-files miss on a pathological repo beats an unbounded walk. */
export const MAX_SCAN_FILES = 5_000
export const MAX_SCAN_BYTES = 262_144
export const RELATED_FILES_MAX = 8
export const RELATED_DOCS_MAX = 4

type ImporterCandidate = {
  path: string
  importedChangedPaths: string[]
  content: string
}

const isTestFile = (filePath: string): boolean =>
  filePath.includes("__tests__/") || /\.test\.[^./]+$/.test(filePath)

/**
 * Import-count desc, then non-test files before test files (test files feed
 * the test-quality dimension but carry less caller context), then path asc
 * for determinism.
 */
const byRelevance = (a: ImporterCandidate, b: ImporterCandidate): number => {
  if (a.importedChangedPaths.length !== b.importedChangedPaths.length) {
    return b.importedChangedPaths.length - a.importedChangedPaths.length
  }
  const aIsTest = isTestFile(a.path)
  if (aIsTest !== isTestFile(b.path)) return aIsTest ? 1 : -1
  return a.path < b.path ? -1 : 1
}

const isMissingFileError = (error: unknown): boolean => {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
}

export const createContextReader = (
  { workspaceRoot }: { workspaceRoot: string },
  logger: Logger,
): ContextReader => {
  const resolvedRoot = path.resolve(workspaceRoot)

  /** Changed-file paths come from the diff and are PR-author-influenced —
   *  a traversal outside the workspace is an attack, not a lookup miss. */
  const resolveUnderRoot = (relativePath: string): string => {
    const resolvedPath = path.resolve(resolvedRoot, relativePath)
    if (!resolvedPath.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`path escapes the workspace: ${relativePath}`)
    }
    return resolvedPath
  }

  /**
   * The lexical check above can't see symlinks: a PR can commit a link whose
   * target sits outside the workspace, or inside `.git/` (where the checkout
   * token lives in `.git/config` under persist-credentials) — and readFile
   * would follow it straight into the prompt, which is echoed into a public
   * review. Resolve the real path and re-check before any content is read.
   * In-workspace links (e.g. AGENTS.md → CLAUDE.md) stay readable. The root
   * is realpath'd too — it may itself sit behind a symlink (macOS tmpdir).
   * Missing files reject with ENOENT so callers keep their existing handling.
   */
  const realPathIfSafe = async (
    absolutePath: string,
  ): Promise<string | null> => {
    const [realRoot, realPath] = await Promise.all([
      realpath(resolvedRoot),
      realpath(absolutePath),
    ])
    const isUnderRoot = realPath.startsWith(realRoot + path.sep)
    const isInGitDirectory = realPath.startsWith(
      path.join(realRoot, ".git") + path.sep,
    )
    return isUnderRoot && !isInGitDirectory ? realPath : null
  }

  const readConventions = async ({
    conventionsFile,
  }: {
    conventionsFile: string
  }): Promise<string | null> => {
    const absolutePath = resolveUnderRoot(conventionsFile)
    try {
      const safePath = await realPathIfSafe(absolutePath)
      if (safePath === null) {
        throw new Error(`path escapes the workspace: ${conventionsFile}`)
      }
      return await readFile(safePath, "utf8")
    } catch (readError) {
      if (isMissingFileError(readError)) {
        logger.info("no conventions file found", { path: conventionsFile })
        return null
      }
      throw readError
    }
  }

  /** null on any unreadable changed file. A symlink that resolves outside
   *  the safe zone is degraded to diff-only rather than fatal — one hostile
   *  or broken file must not kill the whole review — but gets its own
   *  warning so the exclusion is auditable. A missing file logs at info,
   *  not warn: PRs routinely delete files, and the deleted path still
   *  appears in changedPaths. */
  const readChangedFileOrNull = async (
    absolutePath: string,
    changedPath: string,
  ): Promise<string | null> => {
    try {
      const safePath = await realPathIfSafe(absolutePath)
      if (safePath !== null) return await readFile(safePath, "utf8")
      logger.warn(
        "changed file resolves outside the reviewable workspace — including as diff-only",
        { path: changedPath },
      )
      return null
    } catch (readError) {
      if (isMissingFileError(readError)) {
        logger.info(
          "changed file missing from checkout — including as diff-only",
          {
            path: changedPath,
          },
        )
        return null
      }
      logger.warn("changed file unreadable — including as diff-only", {
        path: changedPath,
        error: String(readError),
      })
      return null
    }
  }

  /** Best-effort read for scan candidates — an unreadable file drops out of
   *  related-files context, logged so the exclusion is auditable. */
  const readScannedFileOrNull = async (
    scannedPath: string,
  ): Promise<string | null> => {
    try {
      return await readFile(path.join(resolvedRoot, scannedPath), "utf8")
    } catch (readError) {
      logger.warn("scanned file unreadable — excluding from related files", {
        path: scannedPath,
        error: String(readError),
      })
      return null
    }
  }

  const readChangedFiles = async ({
    changedPaths,
    budgetTokens,
  }: {
    changedPaths: string[]
    budgetTokens: number
  }): Promise<BudgetedFiles> => {
    const files: PromptFile[] = []
    // Sequential state by design: diff order is priority order, and each
    // file's inclusion depends on the budget left by the files before it.
    let remainingTokens = budgetTokens

    for (const changedPath of changedPaths) {
      const absolutePath = resolveUnderRoot(changedPath)
      // Stat before reading: a changed lockfile or bundle can be arbitrarily
      // large, and the token check below only runs after the full read. UTF-8
      // bytes ≥ chars, so a file whose bytes exceed the remaining character
      // budget can never fit — demote it without pulling it into memory.
      // A failed stat (e.g. deleted file) falls through to the read path,
      // which already logs and degrades per error kind.
      const fileStats = await stat(absolutePath).catch(() => null)
      if (
        fileStats !== null &&
        fileStats.size > remainingTokens * CHARS_PER_TOKEN
      ) {
        files.push({ path: changedPath, content: "", includedAs: "diff-only" })
        continue
      }
      const content = await readChangedFileOrNull(absolutePath, changedPath)
      if (content === null) {
        files.push({ path: changedPath, content: "", includedAs: "diff-only" })
        continue
      }
      // A NUL byte marks binary content — meaningless in a text prompt
      if (content.includes("\x00")) {
        files.push({ path: changedPath, content: "", includedAs: "diff-only" })
        continue
      }
      const contentTokens = estimateTokens(content)
      if (contentTokens > remainingTokens) {
        files.push({ path: changedPath, content: "", includedAs: "diff-only" })
        continue
      }
      remainingTokens -= contentTokens
      files.push({ path: changedPath, content, includedAs: "full" })
    }

    return { files, remainingTokens }
  }

  /** BFS walk parameterized by extension set — shared by source and doc scans. */
  const scanWorkspaceFiles = async (
    extensions: Set<string>,
  ): Promise<string[]> => {
    const filePaths: string[] = []
    // Mutable queue by design: a breadth-first walk — subdirectories found
    // during iteration join the queue and are visited by the advancing index.
    const directoryQueue = [""]

    for (let queueIndex = 0; queueIndex < directoryQueue.length; queueIndex++) {
      const currentDirectory = directoryQueue[queueIndex]
      if (currentDirectory === undefined) continue

      const entries = await readdir(path.join(resolvedRoot, currentDirectory), {
        withFileTypes: true,
      })
      // readdir order is platform-dependent — sort so scan-cap cutoffs are deterministic
      const sortedEntries = [...entries].sort((a, b) =>
        a.name < b.name ? -1 : 1,
      )

      for (const entry of sortedEntries) {
        const entryPath = posix.join(currentDirectory, entry.name)
        if (entry.isDirectory()) {
          const isPruned =
            PRUNED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")
          if (!isPruned) directoryQueue.push(entryPath)
          continue
        }
        if (!entry.isFile()) continue
        if (!extensions.has(posix.extname(entry.name))) continue

        if (filePaths.length >= MAX_SCAN_FILES) {
          logger.warn(
            "workspace scan capped — related-file detection may be incomplete",
            { maxScanFiles: MAX_SCAN_FILES },
          )
          return filePaths
        }
        const fileStats = await stat(path.join(resolvedRoot, entryPath))
        if (fileStats.size > MAX_SCAN_BYTES) continue
        filePaths.push(entryPath)
      }
    }

    return filePaths
  }

  const scanWorkspaceSourceFiles = (): Promise<string[]> =>
    scanWorkspaceFiles(SCANNABLE_EXTENSIONS)

  const findRelatedFiles = async ({
    changedPaths,
    budgetTokens,
  }: {
    changedPaths: string[]
    budgetTokens: number
  }): Promise<PromptFile[]> => {
    const changedPathSet = new Set(changedPaths)
    const scannedPaths = await scanWorkspaceSourceFiles()

    const importers: ImporterCandidate[] = []
    for (const scannedPath of scannedPaths) {
      if (changedPathSet.has(scannedPath)) continue
      const content = await readScannedFileOrNull(scannedPath)
      if (content === null) continue
      // A NUL byte marks binary content — the same exclusion readChangedFiles
      // applies; a source-extension file can still carry one in a string literal
      if (content.includes("\x00")) continue

      const importedChangedPaths = [
        ...new Set(
          extractImportSpecifiers(content)
            .flatMap((specifier) =>
              resolveImportSpecifier({ importerPath: scannedPath, specifier }),
            )
            .filter((candidatePath) => changedPathSet.has(candidatePath)),
        ),
      ].sort()
      if (importedChangedPaths.length === 0) continue
      importers.push({ path: scannedPath, importedChangedPaths, content })
    }

    const rankedImporters = [...importers].sort(byRelevance)

    const relatedFiles: PromptFile[] = []
    // Sequential state by design: rank order is priority order, and an
    // over-budget candidate is skipped so smaller candidates still fit.
    let remainingTokens = budgetTokens
    for (const importer of rankedImporters) {
      if (relatedFiles.length >= RELATED_FILES_MAX) break
      const contentTokens = estimateTokens(importer.content)
      if (contentTokens > remainingTokens) continue
      remainingTokens -= contentTokens
      relatedFiles.push({
        path: importer.path,
        content: importer.content,
        includedAs: "full",
        reason: `imports ${importer.importedChangedPaths.join(", ")}`,
      })
    }

    return relatedFiles
  }

  /** Finds documentation files that mention changed code paths, ranked by
   *  mention specificity (full-path matches outweigh basename-only). */
  const findRelatedDocs = async ({
    changedPaths,
    budgetTokens,
    conventionsFile,
  }: {
    changedPaths: string[]
    budgetTokens: number
    conventionsFile: string
  }): Promise<PromptFile[]> => {
    const changedPathSet = new Set(changedPaths)
    const normalizedConventionsFile = posix.normalize(conventionsFile)
    const scannedPaths = await scanWorkspaceFiles(DOC_EXTENSIONS)

    const candidates: DocCandidate[] = []
    for (const scannedPath of scannedPaths) {
      if (posix.normalize(scannedPath) === normalizedConventionsFile) continue
      if (changedPathSet.has(scannedPath)) continue

      const content = await readScannedFileOrNull(scannedPath)
      if (content === null) continue
      if (content.includes("\x00")) continue

      const { mentionedPaths, fullPathCount, basenameCount } =
        findMentionedChangedPaths(content, changedPaths)
      if (mentionedPaths.length === 0) continue

      candidates.push({
        path: scannedPath,
        content,
        fullPathCount,
        basenameCount,
        mentionedChangedPaths: mentionedPaths,
      })
    }

    const rankedCandidates = [...candidates].sort(byMentionRelevance)

    const relatedDocs: PromptFile[] = []
    // Sequential state by design: rank order is priority order, and an
    // over-budget candidate is skipped so smaller candidates still fit.
    let remainingTokens = budgetTokens
    for (const candidate of rankedCandidates) {
      if (relatedDocs.length >= RELATED_DOCS_MAX) break
      const contentTokens = estimateTokens(candidate.content)
      if (contentTokens > remainingTokens) continue
      remainingTokens -= contentTokens

      const displayPaths = candidate.mentionedChangedPaths.slice(0, 3)
      const overflow =
        candidate.mentionedChangedPaths.length - displayPaths.length
      const reasonSuffix = overflow > 0 ? `, +${overflow} more` : ""
      relatedDocs.push({
        path: candidate.path,
        content: candidate.content,
        includedAs: "full",
        reason: `mentions ${displayPaths.join(", ")}${reasonSuffix}`,
      })
    }

    return relatedDocs
  }

  return {
    readConventions,
    readChangedFiles,
    findRelatedFiles,
    findRelatedDocs,
  }
}
