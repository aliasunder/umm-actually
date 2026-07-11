import { posix } from "node:path"

/**
 * Matches static imports (`from "x"`), dynamic `import("x")`, and CommonJS
 * `require("x")`, capturing the quoted specifier. Deliberately grep-style:
 * a false positive inside a comment or string only costs a harmless extra
 * candidate lookup, never a wrong review.
 */
const IMPORT_SPECIFIER_PATTERN =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g

export const extractImportSpecifiers = (source: string): string[] => {
  return [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].flatMap(
    (specifierMatch) =>
      specifierMatch[1] === undefined ? [] : [specifierMatch[1]],
  )
}

/** Compiled `.js`-family specifiers and the source extensions they may compile from. */
const SOURCE_EXTENSION_REMAPS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
}

const EXTENSIONLESS_SUFFIXES = [".ts", ".tsx", ".js", ".jsx"]
const INDEX_BASENAMES = ["index.ts", "index.js"]

/**
 * Expands a relative import specifier into every workspace-relative posix
 * path it could resolve to: the exact join, `.js`→`.ts`-family remaps (the
 * ESM convention of importing compiled names from TS source), extensionless
 * resolution, and directory-index resolution. Non-relative specifiers
 * (packages, node built-ins) return no candidates.
 */
export const resolveImportSpecifier = ({
  importerPath,
  specifier,
}: {
  importerPath: string
  specifier: string
}): string[] => {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return []

  const joined = posix.join(posix.dirname(importerPath), specifier)
  // A join that climbs above the workspace root can never match a changed file
  if (joined.startsWith("../")) return []

  const extension = posix.extname(joined)
  if (extension === "") {
    return [
      joined,
      ...EXTENSIONLESS_SUFFIXES.map((suffix) => `${joined}${suffix}`),
      ...INDEX_BASENAMES.map((indexBasename) => `${joined}/${indexBasename}`),
    ]
  }

  const remappedExtensions = SOURCE_EXTENSION_REMAPS[extension] ?? []
  const withoutExtension = joined.slice(0, -extension.length)
  return [
    joined,
    ...remappedExtensions.map(
      (remappedExtension) => `${withoutExtension}${remappedExtension}`,
    ),
  ]
}
