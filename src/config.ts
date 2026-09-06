import { hasExcessiveWildcards } from "./diff/pattern-safety.js"
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
const optionalPositiveInteger = z
  .string()
  .transform((value, ctx) =>
    value === "" ? undefined : parsePositiveInteger(value, ctx),
  )

const requiredPositiveInteger = z.string().transform(parsePositiveInteger)

/** Ceiling that keeps seconds × 1000 within the 2^31−1 ms timer cap —
 *  beyond it, timer implementations clamp the delay to ~1 ms and every
 *  request would time out instantly instead of being bounded. */
const maxTimeoutSeconds = 2_147_483

/** Mirrors the action.yml default — keep the two in sync. */
const defaultRequestTimeoutSeconds = 900

const timerSafeSeconds = z.string().transform((value, ctx) => {
  // Empty string means "not provided": workflows wiring a bare unset repo
  // variable pass "", which would otherwise override the action.yml default.
  if (!value) return defaultRequestTimeoutSeconds
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
   *  separate from operatorPatterns: a repo's negated gitattributes entry
   *  exempts a file from this tier but never from operator patterns. */
  defaultPatterns: string[]
  operatorPatterns: string[]
}

/** "" = the built-in default list (bare repo-variable wiring); a leading
 *  "none" disables the defaults — with a non-empty default, the empty string
 *  cannot mean both "default" and "off", so this input carries the action's
 *  only off sentinel. Supplied patterns extend whichever base survives. */
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

  const operatorPatterns = patternEntries
    .map(normalizeWorkspacePath)
    .filter((pattern) => pattern !== "" && pattern !== ".")

  const unsafePatterns = operatorPatterns.filter(hasExcessiveWildcards)
  if (unsafePatterns.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: `pattern(s) exceed the wildcard cap (at most 2 "*" per path segment; "**" segments exempt): ${unsafePatterns.join(", ")}`,
    })
    return z.NEVER
  }

  return {
    defaultPatterns: defaultsDisabled ? [] : DEFAULT_DIFF_EXCLUDE_PATTERNS,
    operatorPatterns,
  }
})

/** Mirrors the action.yml default — keep the two in sync. */
const defaultPhases = "combined"

/** Shape-only: the value is validated by its domain owner
 *  (review/phases.ts resolveStages) at startup. Empty string means "not
 *  provided" for the same reason as timerSafeSeconds. */
const phasesOrDefault = z.string().transform((value) => value || defaultPhases)

const configSchema = z.object({
  githubToken: z.string().min(1, "github_token is required"),
  openrouterApiKey: z.string().min(1, "openrouter_api_key is required"),
  model: z.string().min(1, "model must not be empty"),
  fallbackModel: z.string(),
  requestTimeoutSeconds: timerSafeSeconds,
  maxFindings: optionalPositiveInteger,
  // Shape-only, like phases: the value is validated by its domain owner
  // (review/finding.ts resolveSeverityThreshold) at startup
  severityThreshold: z.string().min(1, "severity_threshold must not be empty"),
  conventionsFile: z.string().min(1, "conventions_file must not be empty"),
  phases: phasesOrDefault,
  contextBudgetTokens: requiredPositiveInteger,
  traceRelatedFiles: z.boolean(),
  maxScanFiles: requiredPositiveInteger,
  maxScanBytes: requiredPositiveInteger,
  maxRelatedFiles: requiredPositiveInteger,
  maxRelatedDocs: requiredPositiveInteger,
  priorityDocs: z.string().transform((value) =>
    value
      .split(",")
      .map(normalizeWorkspacePath)
      .filter((segment) => segment !== "" && segment !== "."),
  ),
  excludePaths: z.string().transform((value) =>
    value
      .split(",")
      .map(normalizeWorkspacePath)
      .filter((segment) => segment !== "" && segment !== "."),
  ),
  diffExcludePaths: diffExcludePathsInput,
  respectLinguistGenerated: z.boolean(),
  costSummary: z.boolean(),
  prNumberOverride: optionalPositiveInteger,
})

export type ActionConfig = z.infer<typeof configSchema>

/**
 * Raw action inputs as collected in main.ts: strings from @actions/core
 * getInput, except booleans, which arrive pre-parsed via getBooleanInput
 * (it enforces the YAML 1.2 core-schema list — true|True|TRUE and the
 * false equivalents — and throws on anything else, so string→boolean
 * parsing isn't reinvented here). Collected in main.ts so this module
 * stays pure and testable with plain objects; the remaining validation
 * and coercion happens in parseConfig.
 */
export type RawInputs = Omit<
  Record<keyof ActionConfig, string>,
  "traceRelatedFiles" | "costSummary" | "respectLinguistGenerated"
> & {
  traceRelatedFiles: boolean
  costSummary: boolean
  respectLinguistGenerated: boolean
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
