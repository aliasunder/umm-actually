import { hasExcessiveWildcards } from "./diff/exclusion.js"
import { normalizeWorkspacePath } from "./review/workspace-path.js"
import { z } from "zod"

const parsePositiveInteger = (value: string, ctx: z.RefinementCtx): number => {
  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed <= 0) {
    ctx.addIssue({
      code: "custom",
      message: `"${value}" is not a positive integer`,
    })
    return z.NEVER
  }
  return parsed
}

/** Empty string means "not provided"; anything else must parse as a positive integer. */
const optionalPositiveInteger = z.string().transform((value, ctx) => {
  return value ? parsePositiveInteger(value, ctx) : undefined
})

// An empty string means "not provided". A workflow wiring an unset repo
// variable passes "", and that must select the action.yml default rather than
// fail. Each default below mirrors action.yml, and a config.test.ts test
// fails when they drift apart

const positiveIntegerOrDefault = (defaultValue: number) => {
  return z.string().transform((value, ctx) => {
    return value ? parsePositiveInteger(value, ctx) : defaultValue
  })
}

/** Ceiling that keeps seconds × 1000 within the 2^31−1 ms timer cap.
 *  Beyond it, setTimeout clamps the delay to 1 ms and every request
 *  would time out instantly. https://nodejs.org/api/timers.html#settimeoutcallback-delay-args */
const maxTimeoutSeconds = Math.floor((2 ** 31 - 1) / 1000)

const timerSafeSeconds = (defaultSeconds: number) => {
  return z.string().transform((value, ctx) => {
    if (!value) return defaultSeconds

    const parsed = parsePositiveInteger(value, ctx)

    if (parsed > maxTimeoutSeconds) {
      ctx.addIssue({
        code: "custom",
        message: `"${value}" exceeds the ${maxTimeoutSeconds}-second cap (2^31−1 ms timer limit)`,
      })
      return z.NEVER
    }
    return parsed
  })
}

/**
 * Built-in diff exclusions — the file classes GitHub's linguist auto-collapses
 * via rules no .gitattributes entry expresses (ecosystem lockfiles, minified
 * sources, source maps). Snapshots are deliberately absent: linguist has no
 * snapshot rule and GitHub renders them expanded, so repos opt them out via
 * .gitattributes linguist-generated entries or the diff_exclude_paths input.
 */
export const DEFAULT_DIFF_EXCLUDE_PATTERNS = [
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/deno.lock",
  "**/composer.lock",
  "**/Cargo.lock",
  "**/Gemfile.lock",
  "**/poetry.lock",
  "**/uv.lock",
  "**/go.sum",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
]

export type DiffExcludeConfig = {
  /** The built-in list, or empty when a leading "none" disabled it. Kept
   *  separate: a negated gitattributes entry exempts a file from this tier
   *  but never from diff_exclude_paths patterns. */
  defaultPatterns: string[]
  diffExcludePathPatterns: string[]
}

/** Parses the diff_exclude_paths action input. A leading "none" disables
 *  the built-in default list; additional patterns extend whatever base
 *  survives. An empty input keeps the full default list. */
const diffExcludePathsInput = z.string().transform((value, ctx) => {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)

  const defaultsDisabled = entries[0] === "none"
  const patternEntries = defaultsDisabled ? entries.slice(1) : entries

  if (patternEntries.includes("none")) {
    ctx.addIssue({
      code: "custom",
      message:
        '"none" disables the default list only in leading position — move it first or remove it',
    })
    return z.NEVER
  }

  // normalizeWorkspacePath("") yields "." — strip it alongside empty entries
  const diffExcludePathPatterns = patternEntries
    .map(normalizeWorkspacePath)
    .filter((pattern) => pattern !== "" && pattern !== ".")

  const unsafePatterns = diffExcludePathPatterns.filter(hasExcessiveWildcards)

  if (unsafePatterns.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: `pattern(s) exceed the wildcard cap (at most 2 "*" per path segment; "**" segments exempt): ${unsafePatterns.join(", ")}`,
    })
    return z.NEVER
  }

  return {
    defaultPatterns: defaultsDisabled ? [] : DEFAULT_DIFF_EXCLUDE_PATTERNS,
    diffExcludePathPatterns,
  }
})

const configSchema = z.object({
  githubToken: z.string().min(1, "github_token is required"),
  openrouterApiKey: z.string().min(1, "openrouter_api_key is required"),
  model: z.string().transform((value) => value || "anthropic/claude-sonnet-4-6"),
  // Empty means no fallback model
  fallbackModel: z.string().transform((value) => value || null),
  requestTimeoutSeconds: timerSafeSeconds(900),
  reviewTimeoutSeconds: timerSafeSeconds(1500),
  maxFindings: optionalPositiveInteger,
  // Checked for shape only; review/finding.ts resolveSeverityThreshold
  // validates the value at startup
  severityThreshold: z.string().transform((value) => value || "low"),
  conventionsFile: z.string().transform((value) => value || "AGENTS.md"),
  conventionsBudgetTokens: positiveIntegerOrDefault(8_000),
  // Checked for shape only; review/phases.ts resolveStages validates the
  // value at startup
  phases: z.string().transform((value) => value || "combined"),
  contextBudgetTokens: positiveIntegerOrDefault(300_000),
  traceRelatedFiles: z.boolean().default(true),
  // The scans are bounded because missing a related file on a pathological
  // repo costs less than an unbounded walk
  maxScanFiles: positiveIntegerOrDefault(5_000),
  maxScanBytes: positiveIntegerOrDefault(524_288),
  maxRelatedFiles: positiveIntegerOrDefault(15),
  maxRelatedDocs: positiveIntegerOrDefault(10),
  // Empty is not the default here. action.yml defaults this input to
  // README.md, and an explicit empty value disables priority docs.
  // normalizeWorkspacePath("") yields ".", so it is stripped with empty entries
  priorityDocs: z.string().transform((value) => {
    return value
      .split(",")
      .map(normalizeWorkspacePath)
      .filter((segment) => segment !== "" && segment !== ".")
  }),
  excludePaths: z.string().transform((value) => {
    return value
      .split(",")
      .map(normalizeWorkspacePath)
      .filter((segment) => segment !== "" && segment !== ".")
  }),
  diffExcludePaths: diffExcludePathsInput,
  respectLinguistGenerated: z.boolean().default(true),
  costSummary: z.boolean().default(true),
  prNumberOverride: optionalPositiveInteger,
})

export type ActionConfig = z.infer<typeof configSchema>

/**
 * Raw action inputs as collected in main.ts: strings from @actions/core
 * getInput, except booleans, which arrive pre-parsed via getBooleanInput
 * (it enforces the YAML 1.2 core-schema list — true|True|TRUE and the
 * false equivalents — and throws on anything else, so string→boolean
 * parsing isn't reinvented here) or undefined when the input was empty.
 * Collected in main.ts so this module stays pure and testable with plain
 * objects; the remaining validation and coercion happens in parseConfig.
 */
export type RawInputs = Omit<
  Record<keyof ActionConfig, string>,
  "traceRelatedFiles" | "costSummary" | "respectLinguistGenerated"
> & {
  traceRelatedFiles: boolean | undefined
  costSummary: boolean | undefined
  respectLinguistGenerated: boolean | undefined
}

export const parseConfig = (rawInputs: RawInputs): ActionConfig => {
  const result = configSchema.safeParse(rawInputs)

  if (!result.success) {
    const issueSummaries = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    )
    throw new Error(`invalid action inputs — ${issueSummaries.join("; ")}`)
  }
  return result.data
}
