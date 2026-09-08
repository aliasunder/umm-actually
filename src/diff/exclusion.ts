/**
 * Classifies diff files into "excluded from review" or "kept for review"
 * based on three pattern tiers, checked in precedence order:
 *
 * 1. diff_exclude_paths — operator-configured patterns (action input)
 * 2. linguist_generated — .gitattributes linguist-generated rules
 * 3. default_list — built-in patterns (lockfiles, snapshots, etc.)
 *
 * A negated gitattributes rule (linguist-generated=false) exempts a file
 * from the default list but not from diff_exclude_paths.
 *
 * Entry points:
 * - createExclusionMatcher — compiles patterns into a reusable classifier
 * - partitionExcludedFiles — splits a parsed diff into kept and excluded
 * - renderExcludedFilesNote — formats the excluded-files trailer for the prompt
 */
import { posix } from "node:path"
import ignoreModule from "ignore"
import type { File } from "parse-diff"
import type { Logger } from "../logger.js"
import { newFilePath } from "./commentable-lines.js"

/** ignore ships CommonJS with an ESM-style "export default" declaration, so
 *  under NodeNext the callable factory sits behind .default in both the type
 *  and the runtime interop (the package sets module.exports.default itself). */
const createIgnoreMatcher = ignoreModule.default

export type DiffExclusionSource =
  "diff_exclude_paths" | "linguist_generated" | "default_list"

export type ExcludedDiffFile = {
  path: string
  additions: number
  deletions: number
  source: DiffExclusionSource
}

export type PartitionedDiffFiles = {
  kept: File[]
  excluded: ExcludedDiffFile[]
}

export type ExclusionMatcher = {
  classify: (filePath: string) => DiffExclusionSource | null
}

/**
 * Matching engines (path.matchesGlob, the ignore package) backtrack
 * exponentially when one segment interleaves several "*" wildcards with
 * literals — a crafted 40+-char filename hangs a single synchronous,
 * unabortable match call for minutes. Both pattern channels (the
 * diff_exclude_paths input and repo .gitattributes) are bounded by this
 * cap; "**" globstar segments are exempt because globstar traversal does
 * not backtrack.
 */
export const hasExcessiveWildcards = (pattern: string): boolean => {
  return pattern.split("/").some((segment) => {
    if (segment === "**") return false
    // An escaped character is a literal to every matcher — an escaped star
    // cannot backtrack, so it must not count toward the cap
    const unescapedSegment = segment.replace(/\\./g, "")
    const starCount = (unescapedSegment.match(/\*/g) ?? []).length
    return starCount > 2
  })
}

type LinguistRule = {
  pattern: string
  generated: boolean
}

/**
 * Only these spellings carry a linguist-generated signal. Git's
 * "!linguist-generated" means "unspecified" and other string values have no
 * defined truthiness here, so both produce no rule.
 */
const GENERATED_ATTRIBUTE_STATES = new Map<string, boolean>([
  ["linguist-generated", true],
  ["linguist-generated=true", true],
  ["linguist-generated=false", false],
  ["-linguist-generated", false],
])

/** Whitespace not preceded by a backslash — a backslash-escaped space is
 *  git's escaping for paths with spaces and stays inside the pattern token. */
const UNESCAPED_WHITESPACE = /(?<!\\)\s+/

/**
 * Extracts the linguist-generated rules from .gitattributes content. The
 * file arrives from the PR head checkout, so it is untrusted input: a
 * wildcard-cap-violating line drops that rule with a warn; lines with no
 * recognized linguist-generated attribute are ignored — and neither ever
 * fails the run.
 */
const parseLinguistGeneratedRules = (
  content: string,
  logger: Logger,
): LinguistRule[] => {
  const rules: LinguistRule[] = []

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const [pattern, ...attributes] = line
      .split(UNESCAPED_WHITESPACE)
      .filter(Boolean)
    if (!pattern) continue
    // gitattributes forbids gitignore-style "!" negation patterns — git
    // ignores such lines, and so does this parser
    if (pattern.startsWith("!")) continue

    // A line can carry multiple attributes; the last recognized one wins
    const generatedState = attributes
      .map((attribute) => GENERATED_ATTRIBUTE_STATES.get(attribute))
      .findLast((state) => state !== undefined)
    if (generatedState === undefined) continue

    if (hasExcessiveWildcards(pattern)) {
      logger.warn(
        "gitattributes pattern exceeds the wildcard cap — rule ignored",
        { pattern },
      )
      continue
    }

    rules.push({ pattern, generated: generatedState })
  }

  return rules
}

/** Exact match, folder prefix ("generated" matches "generated/x.ts"),
 *  or glob — the union lets operators write either bare names or globs. */
const matchesExcludePattern = (filePath: string, pattern: string): boolean => {
  return (
    filePath === pattern ||
    filePath.startsWith(pattern + "/") ||
    posix.matchesGlob(filePath, pattern)
  )
}

const matchesAnyExcludePattern = (
  filePath: string,
  patterns: string[],
): boolean => {
  return patterns.some((pattern) => matchesExcludePattern(filePath, pattern))
}

type CompiledLinguistRule = {
  matchesPath: (filePath: string) => boolean
  generated: boolean
}

/** Precedence: diff_exclude_paths patterns are the most intentional layer
 *  and beat a repo's negated gitattributes entry; a negated entry in turn
 *  exempts the file from the built-in default list. */
const classifyExclusion = (
  filePath: string,
  {
    diffExcludePathPatterns,
    linguistRules,
    defaultPatterns,
  }: {
    diffExcludePathPatterns: string[]
    linguistRules: CompiledLinguistRule[]
    defaultPatterns: string[]
  },
): DiffExclusionSource | null => {
  if (matchesAnyExcludePattern(filePath, diffExcludePathPatterns)) {
    return "diff_exclude_paths"
  }

  // Last matching rule wins, per gitattributes semantics.
  // Three states: true (generated), false (explicitly not generated —
  // exempts from defaults), undefined (no rule matched — fall through).
  const linguistGenerated = linguistRules.findLast((rule) => {
    return rule.matchesPath(filePath)
  })?.generated
  if (linguistGenerated === false) return null
  if (linguistGenerated === true) return "linguist_generated"

  if (matchesAnyExcludePattern(filePath, defaultPatterns)) return "default_list"
  return null
}

/** Compiles gitattributes patterns into per-pattern ignore() instances —
 *  load-bearing: a shared instance would apply gitignore "!" negation
 *  semantics across rules, which the gitattributes format forbids;
 *  per-pattern instances keep last-match-wins a plain fold. */
const compileLinguistRules = (
  gitAttributesContent: string | null,
  logger: Logger,
): CompiledLinguistRule[] => {
  if (!gitAttributesContent) return []

  return parseLinguistGeneratedRules(gitAttributesContent, logger).map(
    (rule) => {
      const patternMatcher = createIgnoreMatcher().add(rule.pattern)
      return {
        matchesPath: (filePath: string) => patternMatcher.ignores(filePath),
        generated: rule.generated,
      }
    },
  )
}

export const createExclusionMatcher = (
  {
    defaultPatterns,
    diffExcludePathPatterns,
    gitAttributesContent,
  }: {
    defaultPatterns: string[]
    diffExcludePathPatterns: string[]
    gitAttributesContent: string | null
  },
  logger: Logger,
): ExclusionMatcher => {
  const linguistRules = compileLinguistRules(gitAttributesContent, logger)

  return {
    classify: (filePath) => {
      return classifyExclusion(filePath, {
        diffExcludePathPatterns,
        linguistRules,
        defaultPatterns,
      })
    },
  }
}

/** The path a file is classified by: the new path, or the old path for
 *  deletions — a rename out of an excluded folder into reviewable source is
 *  reviewed, while a rename into one is excluded. */
const classificationPath = (file: File): string | null => {
  const filePath = newFilePath(file) ?? file.from
  if (!filePath || filePath === "/dev/null") return null
  // Leading slashes are stripped because ignore().ignores() throws on
  // absolute paths, and diff paths are PR-author-influenced
  return posix.normalize(filePath).replace(/^\/+/, "")
}

/**
 * Splits parsed diff files into the review subject and the excluded rest.
 * Runs before diff annotation and the token budget check so excluded files
 * consume no budget, no changed-file reads, and no commentable lines.
 */
export const partitionExcludedFiles = ({
  files,
  matcher,
}: {
  files: File[]
  matcher: ExclusionMatcher
}): PartitionedDiffFiles => {
  const kept: File[] = []
  const excluded: ExcludedDiffFile[] = []

  for (const file of files) {
    const filePath = classificationPath(file)
    const source = filePath ? matcher.classify(filePath) : null
    if (filePath && source) {
      excluded.push({
        path: filePath,
        additions: file.additions,
        deletions: file.deletions,
        source,
      })
    } else {
      kept.push(file)
    }
  }

  return { kept, excluded }
}

const SOURCE_LABELS: Record<DiffExclusionSource, string> = {
  diff_exclude_paths: "diff_exclude_paths input",
  linguist_generated: "linguist-generated attribute",
  default_list: "built-in default list",
}

/** Human-readable label for each exclusion source, shown in the excluded-
 *  files trailer and the status comment's context notes. */
export const describeExclusionSource = (
  source: DiffExclusionSource,
): string => {
  return SOURCE_LABELS[source]
}

/** One line per excluded file with change counts and the source that
 *  excluded it — shared by the prompt trailer and the all-excluded skip
 *  review so both surfaces name the same facts identically. */
export const renderExcludedFileLines = (
  excluded: ExcludedDiffFile[],
): string[] => {
  return excluded.map((file) => {
    const changeCounts = `+${file.additions}/-${file.deletions}`
    return `- ${file.path} (${changeCounts}, ${describeExclusionSource(file.source)})`
  })
}

const SOURCE_SUMMARY_ORDER: DiffExclusionSource[] = [
  "diff_exclude_paths",
  "linguist_generated",
  "default_list",
]

/** Per-source counts for one-line surfaces (check-run title, skip reason). */
export const summarizeExclusionSources = (
  excluded: ExcludedDiffFile[],
): string => {
  return SOURCE_SUMMARY_ORDER.flatMap((source) => {
    const count = excluded.filter((file) => file.source === source).length
    return count > 0 ? [`${count} by ${describeExclusionSource(source)}`] : []
  }).join(", ")
}

/**
 * The changed-but-not-reviewed trailer appended after the annotated diff, so
 * the model knows these files changed without seeing their content. Lines
 * deliberately do not resemble the "=== path ===" file headers — the
 * anchoring contract only lets the model cite real headers and file blocks.
 */
export const renderExcludedFilesNote = (
  excluded: ExcludedDiffFile[],
): string => {
  if (excluded.length === 0) return ""

  return [
    `${excluded.length} changed file(s) excluded from review (content not shown):`,
    ...renderExcludedFileLines(excluded),
  ].join("\n")
}
