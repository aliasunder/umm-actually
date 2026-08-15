import { describe, expect, it } from "vitest"
import { parseConfig, type RawInputs } from "../config.js"

const makeRawInputs = (overrides: Partial<RawInputs> = {}): RawInputs => ({
  githubToken: "ghs_testtoken",
  openrouterApiKey: "sk-or-testkey",
  model: "anthropic/claude-sonnet-4-6",
  fallbackModel: "",
  requestTimeoutSeconds: "600",
  maxFindings: "",
  severityThreshold: "low",
  conventionsFile: "AGENTS.md",
  phases: "combined",
  contextBudgetTokens: "80000",
  traceRelatedFiles: true,
  maxScanFiles: "5000",
  maxScanBytes: "262144",
  maxRelatedFiles: "8",
  maxRelatedDocs: "4",
  priorityDocs: "README.md",
  costSummary: true,
  prNumberOverride: "",
  ...overrides,
})

describe("parseConfig", () => {
  it("parses a full set of valid inputs into typed config", () => {
    const config = parseConfig(makeRawInputs())

    expect(config).toEqual({
      githubToken: "ghs_testtoken",
      openrouterApiKey: "sk-or-testkey",
      model: "anthropic/claude-sonnet-4-6",
      fallbackModel: "",
      requestTimeoutSeconds: 600,
      maxFindings: undefined,
      severityThreshold: "low",
      conventionsFile: "AGENTS.md",
      phases: "combined",
      contextBudgetTokens: 80000,
      traceRelatedFiles: true,
      maxScanFiles: 5000,
      maxScanBytes: 262144,
      maxRelatedFiles: 8,
      maxRelatedDocs: 4,
      priorityDocs: ["README.md"],
      costSummary: true,
      prNumberOverride: undefined,
    })
  })

  it("passes a false cost_summary through unchanged", () => {
    // Booleans arrive pre-parsed from getBooleanInput — the schema must not
    // coerce them (a truthiness bug here would flip false back to true)
    const config = parseConfig(makeRawInputs({ costSummary: false }))

    expect(config.costSummary).toBe(false)
  })

  it("parses a provided max_findings into a number", () => {
    const config = parseConfig(makeRawInputs({ maxFindings: "5" }))

    expect(config.maxFindings).toBe(5)
  })

  it("rejects a zero max_findings", () => {
    expect(() => parseConfig(makeRawInputs({ maxFindings: "0" }))).toThrow(
      'maxFindings: "0" is not a positive integer',
    )
  })

  it("rejects a non-numeric max_findings", () => {
    expect(() => parseConfig(makeRawInputs({ maxFindings: "many" }))).toThrow(
      'maxFindings: "many" is not a positive integer',
    )
  })

  it("rejects a zero request_timeout_seconds", () => {
    expect(() =>
      parseConfig(makeRawInputs({ requestTimeoutSeconds: "0" })),
    ).toThrow('requestTimeoutSeconds: "0" is not a positive integer')
  })

  it("rejects an empty context_budget_tokens", () => {
    expect(() =>
      parseConfig(makeRawInputs({ contextBudgetTokens: "" })),
    ).toThrow('contextBudgetTokens: "" is not a positive integer')
  })

  it("passes a false trace_related_files through unchanged", () => {
    const config = parseConfig(makeRawInputs({ traceRelatedFiles: false }))

    expect(config.traceRelatedFiles).toBe(false)
  })

  it("rejects an empty github token", () => {
    expect(() => parseConfig(makeRawInputs({ githubToken: "" }))).toThrow(
      "githubToken: github_token is required",
    )
  })

  it("passes severity_threshold through as a string for domain validation", () => {
    // Value validation lives in review/finding.ts resolveSeverityThreshold —
    // config checks shape only, same split as phases
    const config = parseConfig(makeRawInputs({ severityThreshold: "extreme" }))

    expect(config.severityThreshold).toBe("extreme")
  })

  it("rejects an empty severity_threshold", () => {
    expect(() => parseConfig(makeRawInputs({ severityThreshold: "" }))).toThrow(
      "severityThreshold: severity_threshold must not be empty",
    )
  })

  it("parses a provided pr_number override into a number", () => {
    const config = parseConfig(makeRawInputs({ prNumberOverride: "12" }))

    expect(config.prNumberOverride).toBe(12)
  })

  it("parses comma-separated priority_docs into an array", () => {
    const config = parseConfig(
      makeRawInputs({ priorityDocs: "README.md, CHANGELOG.md, docs/guide.md" }),
    )

    expect(config.priorityDocs).toEqual([
      "README.md",
      "CHANGELOG.md",
      "docs/guide.md",
    ])
  })

  it("parses empty priority_docs as empty array", () => {
    const config = parseConfig(makeRawInputs({ priorityDocs: "" }))

    expect(config.priorityDocs).toEqual([])
  })

  it("trims whitespace and filters empty segments from priority_docs", () => {
    const config = parseConfig(
      makeRawInputs({ priorityDocs: "README.md, , CHANGELOG.md," }),
    )

    expect(config.priorityDocs).toEqual(["README.md", "CHANGELOG.md"])
  })

  it("rejects a zero max_related_files", () => {
    expect(() => parseConfig(makeRawInputs({ maxRelatedFiles: "0" }))).toThrow(
      'maxRelatedFiles: "0" is not a positive integer',
    )
  })

  it("rejects a zero max_related_docs", () => {
    expect(() => parseConfig(makeRawInputs({ maxRelatedDocs: "0" }))).toThrow(
      'maxRelatedDocs: "0" is not a positive integer',
    )
  })

  it("aggregates multiple input errors into one message", () => {
    expect(() =>
      parseConfig(makeRawInputs({ githubToken: "", maxFindings: "-1" })),
    ).toThrow(/githubToken: github_token is required.*maxFindings/)
  })
})
