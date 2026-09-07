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
  "default_pattern" | "operator_pattern" | "linguist_generated"

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
 * unabortable match call for minutes. Both pattern channels (operator
 * input and repo .gitattributes) are bounded by this cap; "**" globstar
 * segments are exempt because globstar traversal does not backtrack.
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
 * malformed or wildcard-cap-violating line drops that rule with a warn and
 * never fails the run.
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

/** A pattern hits as a root-anchored folder prefix (the exclude_paths rule)
 *  or as a glob — the union keeps both operator mental models valid. */
const matchesExcludePattern = (filePath: string, pattern: string): boolean => {
  return (
    filePath === pattern ||
    filePath.startsWith(pattern + "/") ||
    posix.matchesGlob(filePath, pattern)
  )
}

/**
 * Compiles all three exclusion tiers into one classifier so per-file
 * evaluation carries no configuration. Gitattributes patterns get one
 * ignore() instance each — load-bearing: a shared instance would apply
 * gitignore "!" negation semantics across rules, which the gitattributes
 * format forbids; per-pattern instances keep last-match-wins a plain fold.
 */
export const createExclusionMatcher = (
  {
    defaultPatterns,
    operatorPatterns,
    gitAttributesContent,
  }: {
    defaultPatterns: string[]
    operatorPatterns: string[]
    gitAttributesContent: string | null
  },
  logger: Logger,
): ExclusionMatcher => {
  const linguistRules = gitAttributesContent
    ? parseLinguistGeneratedRules(gitAttributesContent, logger)
    : []
  const compiledLinguistRules = linguistRules.map((rule) => {
    const patternMatcher = createIgnoreMatcher().add(rule.pattern)
    return {
      matchesPath: (filePath: string) => patternMatcher.ignores(filePath),
      generated: rule.generated,
    }
  })

  const classify = (filePath: string): DiffExclusionSource | null => {
    // Precedence: operator patterns are the most intentional layer and beat
    // a repo's negated gitattributes entry; a negated entry in turn exempts
    // the file from the built-in default list.
    if (
      operatorPatterns.some((pattern) =>
        matchesExcludePattern(filePath, pattern),
      )
    ) {
      return "operator_pattern"
    }

    // Last matching rule wins, per gitattributes semantics
    const generated = compiledLinguistRules
      .filter((rule) => rule.matchesPath(filePath))
      .at(-1)?.generated
    if (generated === false) return null
    if (generated === true) return "linguist_generated"

    if (
      defaultPatterns.some((pattern) =>
        matchesExcludePattern(filePath, pattern),
      )
    ) {
      return "default_pattern"
    }
    return null
  }

  return { classify }
}

/** The path a file is judged by: the new path, or the old path for
 *  deletions — a rename out of an excluded folder into reviewable source is
 *  reviewed, while a rename into one is excluded. */
const exclusionPath = (file: File): string | null => {
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
    const filePath = exclusionPath(file)
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

/** Operator-facing label for each exclusion source, shown in the excluded-
 *  files trailer and the status comment's context notes. One convention
 *  across labels: a lowercase noun phrase naming the layer, with the
 *  external identifier (input name, gitattributes attribute) verbatim. */
export const describeExclusionSource = (
  source: DiffExclusionSource,
): string => {
  if (source === "default_pattern") return "built-in default list"
  if (source === "operator_pattern") return "diff_exclude_paths input"
  return "linguist-generated attribute"
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
  "operator_pattern",
  "linguist_generated",
  "default_pattern",
]

/** Per-source counts for one-line surfaces (check-run title, skip reason) —
 *  attributes the exclusion to the layer that actually caused it instead of
 *  naming an input the operator may never have set. */
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
