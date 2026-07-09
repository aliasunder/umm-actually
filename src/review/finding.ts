import { z } from "zod"

export const FINDING_CATEGORIES = [
  "correctness",
  "security",
  "conventions",
  "tests",
  "subtle_bugs",
  "ci",
] as const
export type FindingCategory = (typeof FINDING_CATEGORIES)[number]

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

export const FINDING_CONFIDENCES = ["high", "medium", "low"] as const
export type FindingConfidence = (typeof FINDING_CONFIDENCES)[number]

/** Higher rank = more severe; used for sorting and threshold comparison. */
export const severityRank: Record<FindingSeverity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
}

/**
 * Wire format is snake_case — this is the JSON shape the LLM emits.
 * strictObject + nullable-instead-of-optional keeps the derived JSON schema
 * compatible with strict structured-output mode (every key required,
 * additionalProperties: false).
 */
const findingSchema = z.strictObject({
  file: z.string().min(1),
  line: z.int().positive(),
  end_line: z.int().positive().nullable(),
  category: z.enum(FINDING_CATEGORIES),
  severity: z.enum(FINDING_SEVERITIES),
  confidence: z.enum(FINDING_CONFIDENCES),
  title: z.string().min(1),
  description: z.string().min(1),
  suggestion: z.string().nullable(),
  failure_scenario: z.string().min(1),
})

export const reviewResponseSchema = z.strictObject({
  // First property on purpose: the model reasons before it reports, even
  // under strict structured output where free-form CoT is unavailable.
  analysis: z.string(),
  findings: z.array(findingSchema),
})

export type Finding = z.infer<typeof findingSchema>
export type ReviewResponse = z.infer<typeof reviewResponseSchema>

/** JSON schema handed to OpenRouter as response_format.json_schema.schema. */
export const reviewResponseJsonSchema: Record<string, unknown> =
  z.toJSONSchema(reviewResponseSchema)
