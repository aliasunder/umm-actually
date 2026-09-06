import ignoreModule from "ignore"
import type { Logger } from "../logger.js"
import { hasExcessiveWildcards } from "./pattern-safety.js"

/** ignore ships CommonJS with an ESM-style "export default" declaration, so
 *  under NodeNext the callable factory sits behind .default in both the type
 *  and the runtime interop (the package sets module.exports.default itself). */
const createIgnoreMatcher = ignoreModule.default

export type LinguistRule = {
  pattern: string
  generated: boolean
}

export type CompiledLinguistRule = {
  matchesPath: (filePath: string) => boolean
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

const splitAttributeLine = (line: string): string[] => {
  return line.split(UNESCAPED_WHITESPACE).filter((token) => token !== "")
}

/**
 * Extracts the linguist-generated rules from .gitattributes content. The
 * file arrives from the PR head checkout, so it is untrusted input: a
 * malformed or wildcard-cap-violating line drops that rule with a warn and
 * never fails the run.
 */
export const parseLinguistGeneratedRules = (
  content: string,
  logger: Logger,
): LinguistRule[] => {
  const rules: LinguistRule[] = []

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue

    const [pattern, ...attributes] = splitAttributeLine(line)
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

/**
 * One ignore() instance per pattern — load-bearing: a shared instance would
 * apply gitignore "!" negation semantics across rules, which the
 * gitattributes format forbids. Per-pattern instances keep each rule an
 * independent match so last-match-wins stays a plain fold over the rules.
 */
export const compileLinguistRules = (
  rules: LinguistRule[],
): CompiledLinguistRule[] => {
  return rules.map((rule) => {
    const matcher = createIgnoreMatcher().add(rule.pattern)
    return {
      matchesPath: (filePath: string) => matcher.ignores(filePath),
      generated: rule.generated,
    }
  })
}

/** Last matching rule wins, per gitattributes semantics; undefined means no
 *  rule matched, so the caller falls through to the default pattern tier. */
export const linguistGeneratedState = (
  filePath: string,
  compiledRules: CompiledLinguistRule[],
): boolean | undefined => {
  return compiledRules.filter((rule) => rule.matchesPath(filePath)).at(-1)
    ?.generated
}
