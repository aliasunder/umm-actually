import { describe, expect, it } from "vitest"
import type { PrContext } from "../../github/event.js"
import { resolvePhases } from "../phases.js"
import {
  buildSystemPrompt,
  buildUserPrompt,
  estimateTokens,
} from "../prompt.js"
import { makeFinding } from "./make-finding.js"

const resolvedPhases = resolvePhases("combined")
const combinedPhase = resolvedPhases[0]
if (combinedPhase === undefined)
  throw new Error("combined phase missing from resolvePhases")

const prContext: PrContext = {
  prNumber: 7,
  title: "feat: trim names before greeting",
  body: "Trims whitespace from names.",
  headSha: "abc123",
  headRef: "feat/trim-names",
  baseRef: "main",
}

const makeUserPromptParts = () => ({
  prContext,
  conventions: "# AGENTS.md\n\nUse explicit names.",
  changedFiles: [
    {
      path: "src/greeter.ts",
      content: 'export const greet = (): string => "hi"',
      includedAs: "full" as const,
    },
  ],
  relatedFiles: [
    {
      path: "src/caller.ts",
      content: 'import { greet } from "./greeter.js"',
      includedAs: "full" as const,
      reason: "references changed-file src/greeter.ts",
    },
  ],
  annotatedDiff:
    "=== src/greeter.ts ===\n@@ -1,1 +1,1 @@\n     1 + export const greet",
  priorFindings: [],
})

describe("buildSystemPrompt", () => {
  it("is deterministic for the same phase", () => {
    expect(buildSystemPrompt({ phase: combinedPhase })).toBe(
      buildSystemPrompt({ phase: combinedPhase }),
    )
  })

  it("carries the diff-anchored tracing scope, all dimensions, and the anchoring contract", () => {
    const systemPrompt = buildSystemPrompt({ phase: combinedPhase })

    expect(systemPrompt).toContain(
      "the diff is your entry point, not your boundary",
    )
    expect(systemPrompt).toContain("DIMENSION 1 — CORRECTNESS & SECURITY")
    expect(systemPrompt).toContain("DIMENSION 2 — CODE QUALITY & CONVENTIONS")
    expect(systemPrompt).toContain("DIMENSION 3 — TEST QUALITY & COVERAGE")
    expect(systemPrompt).toContain("DIMENSION 4 — SUBTLE BUG PATTERNS")
    expect(systemPrompt).toContain("For CI/workflow files")
    expect(systemPrompt).toContain('fill the "analysis" field')
    expect(systemPrompt).toContain("Severity rubric:")
    expect(systemPrompt).toContain(
      "new-file line numbers printed in\nthe annotated diff",
    )
  })
})

describe("buildUserPrompt", () => {
  it("is deterministic for the same inputs", () => {
    expect(buildUserPrompt(makeUserPromptParts())).toBe(
      buildUserPrompt(makeUserPromptParts()),
    )
  })

  it("orders sections metadata → conventions → changed files → related files → diff", () => {
    const userPrompt = buildUserPrompt(makeUserPromptParts())

    const metadataIndex = userPrompt.indexOf("PR title:")
    const conventionsIndex = userPrompt.indexOf("<conventions>")
    const changedFileIndex = userPrompt.indexOf('<file path="src/greeter.ts">')
    const relatedFileIndex = userPrompt.indexOf('<file path="src/caller.ts"')
    const diffIndex = userPrompt.indexOf("<diff")

    expect(metadataIndex).toBeGreaterThanOrEqual(0)
    expect(conventionsIndex).toBeGreaterThan(metadataIndex)
    expect(changedFileIndex).toBeGreaterThan(conventionsIndex)
    expect(relatedFileIndex).toBeGreaterThan(changedFileIndex)
    expect(diffIndex).toBeGreaterThan(relatedFileIndex)
  })

  it("notes a missing conventions file instead of omitting the section", () => {
    const userPrompt = buildUserPrompt({
      ...makeUserPromptParts(),
      conventions: null,
    })

    expect(userPrompt).toContain(
      "<conventions>\n(no conventions file found in this repository)\n</conventions>",
    )
  })

  it("truncates oversized conventions with an explicit notice", () => {
    const oversizedConventions = "x".repeat(40_000)

    const userPrompt = buildUserPrompt({
      ...makeUserPromptParts(),
      conventions: oversizedConventions,
    })

    expect(userPrompt).toContain("[conventions truncated at ~8000 tokens]")
    expect(userPrompt).not.toContain(oversizedConventions)
  })

  it("renders diff-only files as an omission marker without content", () => {
    const userPrompt = buildUserPrompt({
      ...makeUserPromptParts(),
      changedFiles: [
        { path: "src/huge.ts", content: "", includedAs: "diff-only" as const },
      ],
    })

    expect(userPrompt).toContain(
      '<file path="src/huge.ts" note="full content omitted: too large — see diff">',
    )
  })

  it("omits the prior_findings section when there are none", () => {
    expect(buildUserPrompt(makeUserPromptParts())).not.toContain(
      "<prior_findings",
    )
  })

  it("includes prior findings with a do-not-re-report instruction when present", () => {
    const priorFinding = makeFinding()

    const userPrompt = buildUserPrompt({
      ...makeUserPromptParts(),
      priorFindings: [priorFinding],
    })

    expect(userPrompt).toContain(
      '<prior_findings note="already reported by earlier phases — do not re-report">',
    )
    expect(userPrompt).toContain(priorFinding.title)
  })

  it("labels related files with their inclusion reason", () => {
    const userPrompt = buildUserPrompt(makeUserPromptParts())

    expect(userPrompt).toContain(
      '<file path="src/caller.ts" reason="references changed-file src/greeter.ts">',
    )
  })
})

describe("estimateTokens", () => {
  it("estimates four characters per token, rounding up", () => {
    expect(estimateTokens("12345678")).toBe(2)
    expect(estimateTokens("123456789")).toBe(3)
  })
})
