import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  resolveSeverityThreshold,
  reviewResponseJsonSchema,
  reviewResponseSchema,
} from "../finding.js"
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

  it.each([
    { name: "an HTML-comment terminator", file: "src/a.ts --> injected <!--" },
    { name: "a newline", file: "src/a.ts\nsrc/b.ts" },
  ])("rejects a finding whose file contains $name", ({ file }) => {
    const response = {
      analysis: "checked",
      findings: [makeFinding({ file })],
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

describe("resolveSeverityThreshold", () => {
  it("resolves every valid severity value", () => {
    expect(resolveSeverityThreshold("critical")).toBe("critical")
    expect(resolveSeverityThreshold("high")).toBe("high")
    expect(resolveSeverityThreshold("medium")).toBe("medium")
    expect(resolveSeverityThreshold("low")).toBe("low")
  })

  it("throws on an unknown severity_threshold, listing the valid values", () => {
    expect(() => resolveSeverityThreshold("extreme")).toThrow(
      'unknown severity_threshold "extreme" — valid: critical | high | medium | low',
    )
  })
})
