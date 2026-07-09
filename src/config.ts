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

const configSchema = z.object({
  githubToken: z.string().min(1, "github_token is required"),
  openrouterApiKey: z.string().min(1, "openrouter_api_key is required"),
  model: z.string().min(1, "model must not be empty"),
  fallbackModel: z.string(),
  maxFindings: optionalPositiveInteger,
  // Shape-only, like phases: the value is validated by its domain owner
  // (review/finding.ts resolveSeverityThreshold) at startup
  severityThreshold: z.string().min(1, "severity_threshold must not be empty"),
  conventionsFile: z.string().min(1, "conventions_file must not be empty"),
  phases: z.string().min(1, "phases must not be empty"),
  contextBudgetTokens: requiredPositiveInteger,
  traceRelatedFiles: z.boolean(),
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
  "traceRelatedFiles" | "costSummary"
> & {
  traceRelatedFiles: boolean
  costSummary: boolean
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
