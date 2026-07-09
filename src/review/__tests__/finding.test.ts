import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { reviewResponseJsonSchema, reviewResponseSchema } from "../finding.js"
import { makeFinding } from "./make-finding.js"

const fixtureResponse: unknown = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/openrouter.response.json", import.meta.url),
    "utf8",
  ),
)

describe("reviewResponseSchema", () => {
  it("accepts the fixture response and preserves every finding field", () => {
    const parsed = reviewResponseSchema.parse(fixtureResponse)

    expect(parsed.findings).toHaveLength(2)
    expect(parsed.findings[0]).toEqual({
      file: "src/greeter.ts",
      line: 145,
      end_line: null,
      category: "correctness",
      severity: "medium",
      confidence: "high",
      title: "Whitespace-only keys pass the empty-key guard",
      description:
        'The new guard rejects only the exact empty string. A key of " " passes and registers an entry that lookups by trimmed key will never find.',
      suggestion:
        '-  if (key === "") throw new Error("key must not be empty")\n+  if (key.trim() === "") throw new Error("key must not be empty")',
      failure_scenario:
        'register(" ", "value") succeeds; a later lookup for the trimmed key returns undefined and the entry is orphaned.',
    })
  })

  it("rejects a finding missing failure_scenario", () => {
    const { failure_scenario: _omitted, ...findingWithoutScenario } =
      makeFinding()
    const response = { analysis: "checked", findings: [findingWithoutScenario] }

    const result = reviewResponseSchema.safeParse(response)

    expect(result.success).toBe(false)
  })

  it("rejects a finding with a non-positive line", () => {
    const response = {
      analysis: "checked",
      findings: [makeFinding({ line: 0 })],
    }

    const result = reviewResponseSchema.safeParse(response)

    expect(result.success).toBe(false)
  })

  it("rejects a finding with an unknown category", () => {
    const response = {
      analysis: "checked",
      findings: [{ ...makeFinding(), category: "vibes" }],
    }

    const result = reviewResponseSchema.safeParse(response)

    expect(result.success).toBe(false)
  })

  it("rejects a finding carrying unknown extra keys", () => {
    const response = {
      analysis: "checked",
      findings: [{ ...makeFinding(), extra_field: "surprise" }],
    }

    const result = reviewResponseSchema.safeParse(response)

    expect(result.success).toBe(false)
  })
})

describe("reviewResponseJsonSchema", () => {
  it("satisfies strict structured-output constraints at the root", () => {
    expect(reviewResponseJsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["analysis", "findings"],
    })
  })

  it("marks every finding field required with no additional properties", () => {
    expect(reviewResponseJsonSchema).toMatchObject({
      properties: {
        findings: {
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "file",
              "line",
              "end_line",
              "category",
              "severity",
              "confidence",
              "title",
              "description",
              "suggestion",
              "failure_scenario",
            ],
          },
        },
      },
    })
  })
})
