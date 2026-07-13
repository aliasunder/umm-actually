import { readFileSync } from "node:fs"
import parseDiff from "parse-diff"
import { describe, expect, it } from "vitest"
import type { ActionConfig } from "../config.js"
import type { GithubClient } from "../github/client.js"
import type { PrContext } from "../github/event.js"
import type { ContextReader } from "../context/workspace.js"
import type {
  ModelAttempt,
  OpenRouterClient,
  StructuredReviewResult,
} from "../openrouter/client.js"
import { estimateTokens, type PromptFile } from "../review/prompt.js"
import { annotateDiff } from "../diff/annotate-diff.js"
import { computeCommentableLines } from "../diff/commentable-lines.js"
import type { ReviewResponse } from "../review/finding.js"
import {
  buildRerunSummary,
  buildReviewBody,
  buildZeroFindingsBody,
  computeAnchorKey,
  mapFindingsToReview,
  RERUN_ANCHOR,
  type ReviewComment,
} from "../review/comment-mapping.js"
import { filterNonFindings } from "../review/filter-non-findings.js"
import { selectFindings } from "../review/select-findings.js"
import { renderCostSummary } from "../openrouter/cost-summary.js"
import {
  orchestrate,
  createPromptedGenerateFindings,
  type OrchestrateDeps,
  type GenerateFindings,
  type ReviewContext,
} from "../orchestrate.js"
import { makeFinding } from "../review/__tests__/make-finding.js"
import { createTestLogger } from "./test-logger.js"

const sampleDiff = readFileSync(
  new URL("../../fixtures/sample.diff", import.meta.url),
  "utf8",
)

const sampleDiffTokens = estimateTokens(annotateDiff(parseDiff(sampleDiff)))

const pullRequestPayload: Record<string, unknown> = JSON.parse(
  readFileSync(
    new URL("../../fixtures/pull_request.opened.json", import.meta.url),
    "utf8",
  ),
)

const fixtureReviewResponse: ReviewResponse = JSON.parse(
  readFileSync(
    new URL("../../fixtures/openrouter.response.json", import.meta.url),
    "utf8",
  ),
)

const fixturePrContext: PrContext = {
  prNumber: 7,
  title: "feat: trim names before greeting",
  body: "Trims whitespace from names and validates registry keys.",
  headSha: "abc123def456abc123def456abc123def456abc1",
  headRef: "feat/trim-names",
  baseRef: "main",
}

const fixtureAttempt: ModelAttempt = {
  model: "test/model",
  outcome: "accepted",
  promptTokens: 1000,
  completionTokens: 500,
  costUsd: 0.01,
  errorSummary: null,
}

const fixtureChangedFile: PromptFile = {
  path: "src/greeter.ts",
  content: "export const greet = (name: string) => name.trim()",
  includedAs: "full",
}

// Precomputed expected values from deterministic fixtures — used for exact
// assertions on the full result and submitReview params
const fixtureFiles = parseDiff(sampleDiff)
const fixtureCommentableByPath = computeCommentableLines(fixtureFiles)

const expectedSelection = selectFindings({
  findings: fixtureReviewResponse.findings,
  severityThreshold: "low",
  maxFindings: undefined,
})
const expectedMapped = mapFindingsToReview({
  findings: expectedSelection.selected,
  commentableByPath: fixtureCommentableByPath,
})
const expectedBody = buildReviewBody({
  bodyFindings: expectedMapped.bodyFindings,
  droppedByCap: expectedSelection.droppedByCap,
  model: "test/model",
  inlineCommentCount: expectedMapped.comments.length,
})
const expectedFallbackBody = buildReviewBody({
  bodyFindings: expectedSelection.selected,
  droppedByCap: expectedSelection.droppedByCap,
  model: "test/model",
  bodyFindingsHeading: "Findings",
  bodyFindingsDescription:
    "Inline comments were unavailable; all findings are listed here:",
})
const expectedCostSummary = renderCostSummary({
  attempts: [fixtureAttempt],
  modelUsed: "test/model",
})

const expectedCappedSelection = selectFindings({
  findings: fixtureReviewResponse.findings,
  severityThreshold: "low",
  maxFindings: 1,
})
const expectedCappedMapped = mapFindingsToReview({
  findings: expectedCappedSelection.selected,
  commentableByPath: fixtureCommentableByPath,
})
const expectedCappedBody = buildReviewBody({
  bodyFindings: expectedCappedMapped.bodyFindings,
  droppedByCap: expectedCappedSelection.droppedByCap,
  model: "test/model",
  inlineCommentCount: expectedCappedMapped.comments.length,
})

const expectedZeroBody = buildZeroFindingsBody({ model: "test/model" })

const buildSkipBody = (reason: string): string =>
  `**umm-actually** — review skipped\n\n${reason}\n\n---\n*umm-actually*`

const baseConfig: ActionConfig = {
  githubToken: "ghp_test",
  openrouterApiKey: "sk-test",
  model: "test/model",
  fallbackModel: "",
  maxFindings: undefined,
  severityThreshold: "low",
  conventionsFile: "AGENTS.md",
  phases: "combined",
  contextBudgetTokens: 80_000,
  traceRelatedFiles: true,
  maxScanFiles: 5000,
  maxScanBytes: 262144,
  maxRelatedFiles: 8,
  maxRelatedDocs: 4,
  priorityDocs: ["README.md"],
  costSummary: true,
  prNumberOverride: undefined,
}

type SubmitReviewParams = {
  prNumber: number
  commitId: string
  body: string
  comments: ReviewComment[]
  fallbackBody: string
}

type ReadChangedFilesParams = {
  changedPaths: string[]
  budgetTokens: number
}

type FindRelatedFilesParams = {
  changedPaths: string[]
  budgetTokens: number
}

type RequestReviewParams = {
  systemPrompt: string
  userPrompt: string
  model: string
  fallbackModel: string | null
}

const first = <T>(array: T[]): T => {
  const item = array[0]
  if (item === undefined) throw new Error("expected at least one element")
  return item
}

type ReadPriorityDocsParams = {
  priorityDocs: string[]
  budgetTokens: number
}

type FindRelatedDocsParams = {
  changedPaths: string[]
  budgetTokens: number
  conventionsFile: string
  excludePaths: string[]
}

type UpsertSummaryCommentParams = {
  prNumber: number
  body: string
  anchor: string
}

type RecordingStubs = {
  deps: OrchestrateDeps
  fetchPullRequestCalls: { prNumber: number }[]
  fetchDiffCalls: { prNumber: number }[]
  submitReviewCalls: SubmitReviewParams[]
  fetchReviewCommentsCalls: { prNumber: number }[]
  upsertSummaryCommentCalls: UpsertSummaryCommentParams[]
  readConventionsCalls: { conventionsFile: string }[]
  readChangedFilesCalls: ReadChangedFilesParams[]
  findRelatedFilesCalls: FindRelatedFilesParams[]
  readPriorityDocsCalls: ReadPriorityDocsParams[]
  findRelatedDocsCalls: FindRelatedDocsParams[]
  generateFindingsCalls: ReviewContext[]
}

const makeOrchestrateDeps = (
  overrides: {
    config?: Partial<ActionConfig>
    eventName?: string
    payload?: unknown
    githubClient?: Partial<GithubClient>
    contextReader?: Partial<ContextReader>
    generateFindings?: GenerateFindings
    fixtureResult?: Partial<StructuredReviewResult>
  } = {},
): RecordingStubs => {
  const fetchPullRequestCalls: { prNumber: number }[] = []
  const fetchDiffCalls: { prNumber: number }[] = []
  const submitReviewCalls: SubmitReviewParams[] = []
  const fetchReviewCommentsCalls: { prNumber: number }[] = []
  const upsertSummaryCommentCalls: UpsertSummaryCommentParams[] = []
  const readConventionsCalls: { conventionsFile: string }[] = []
  const readChangedFilesCalls: ReadChangedFilesParams[] = []
  const findRelatedFilesCalls: FindRelatedFilesParams[] = []
  const readPriorityDocsCalls: ReadPriorityDocsParams[] = []
  const findRelatedDocsCalls: FindRelatedDocsParams[] = []
  const generateFindingsCalls: ReviewContext[] = []

  const structuredResult: StructuredReviewResult = {
    review: fixtureReviewResponse,
    modelUsed: "test/model",
    attempts: [fixtureAttempt],
    ...overrides.fixtureResult,
  }

  const githubClient: GithubClient = {
    fetchPullRequest: async (params) => {
      fetchPullRequestCalls.push(params)
      return fixturePrContext
    },
    fetchDiff: async (params) => {
      fetchDiffCalls.push(params)
      return { kind: "ok" as const, diff: sampleDiff }
    },
    submitReview: async (params) => {
      submitReviewCalls.push(params)
      return {
        url: "https://github.com/test/review/1",
        usedFallbackBody: false,
      }
    },
    fetchReviewComments: async (params) => {
      fetchReviewCommentsCalls.push(params)
      return []
    },
    upsertSummaryComment: async (params) => {
      upsertSummaryCommentCalls.push(params)
      return {
        url: "https://github.com/test/comment/1",
        created: true,
      }
    },
    ...overrides.githubClient,
  }

  const contextReader: ContextReader = {
    readConventions: async (params) => {
      readConventionsCalls.push(params)
      return "# Test conventions"
    },
    readChangedFiles: async (params) => {
      readChangedFilesCalls.push(params)
      return { files: [fixtureChangedFile], remainingTokens: 40_000 }
    },
    findRelatedFiles: async (params) => {
      findRelatedFilesCalls.push(params)
      return []
    },
    readPriorityDocs: async (params) => {
      readPriorityDocsCalls.push(params)
      return { files: [], remainingTokens: params.budgetTokens }
    },
    findRelatedDocs: async (params) => {
      findRelatedDocsCalls.push(params)
      return []
    },
    ...overrides.contextReader,
  }

  const defaultGenerateFindings: GenerateFindings = async (reviewContext) => {
    generateFindingsCalls.push(reviewContext)
    return structuredResult
  }

  const deps: OrchestrateDeps = {
    config: { ...baseConfig, ...overrides.config },
    eventName: overrides.eventName ?? "pull_request",
    payload: overrides.payload ?? pullRequestPayload,
    githubClient,
    contextReader,
    generateFindings: overrides.generateFindings ?? defaultGenerateFindings,
  }

  return {
    deps,
    fetchPullRequestCalls,
    fetchDiffCalls,
    submitReviewCalls,
    fetchReviewCommentsCalls,
    upsertSummaryCommentCalls,
    readConventionsCalls,
    readChangedFilesCalls,
    findRelatedFilesCalls,
    readPriorityDocsCalls,
    findRelatedDocsCalls,
    generateFindingsCalls,
  }
}

describe("orchestrate", () => {
  describe("startup validation", () => {
    it("throws on invalid severity threshold before any network call", async () => {
      const stubs = makeOrchestrateDeps({
        config: { severityThreshold: "invalid" },
      })
      const logger = createTestLogger()

      await expect(orchestrate(stubs.deps, logger)).rejects.toThrow("severity")
      expect(stubs.fetchDiffCalls).toHaveLength(0)
      expect(stubs.generateFindingsCalls).toHaveLength(0)
      expect(stubs.submitReviewCalls).toHaveLength(0)
    })

    it("throws on invalid phases input before any network call", async () => {
      const stubs = makeOrchestrateDeps({
        config: { phases: "invalid" },
      })
      const logger = createTestLogger()

      await expect(orchestrate(stubs.deps, logger)).rejects.toThrow("phases")
      expect(stubs.fetchDiffCalls).toHaveLength(0)
      expect(stubs.generateFindingsCalls).toHaveLength(0)
    })
  })

  describe("event resolution", () => {
    it("returns skipped result for non-PR events without calling any stubs", async () => {
      const stubs = makeOrchestrateDeps({
        eventName: "push",
        payload: {},
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result).toEqual({
        findingsCount: 0,
        reviewUrl: "",
        modelUsed: "",
        skippedReason: "unsupported event: push",
        costSummaryMarkdown: null,
      })
      expect(stubs.generateFindingsCalls).toHaveLength(0)
      expect(stubs.submitReviewCalls).toHaveLength(0)
    })

    it("fetches PR context when event needs fetch", async () => {
      const stubs = makeOrchestrateDeps({
        config: { prNumberOverride: 42 },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.fetchPullRequestCalls).toHaveLength(1)
      expect(stubs.fetchPullRequestCalls[0]).toEqual({ prNumber: 42 })
    })
  })

  describe("skip paths — post body-only review", () => {
    it("posts skip review when diff is too large", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchDiff: async () => ({ kind: "too_large" as const }),
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      const skipReason = "diff exceeds GitHub's diff API limits"
      expect(result).toEqual({
        findingsCount: 0,
        reviewUrl: "https://github.com/test/review/1",
        modelUsed: "",
        skippedReason: skipReason,
        costSummaryMarkdown: null,
      })
      expect(stubs.generateFindingsCalls).toHaveLength(0)
      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(first(stubs.submitReviewCalls)).toEqual({
        prNumber: fixturePrContext.prNumber,
        commitId: fixturePrContext.headSha,
        body: buildSkipBody(skipReason),
        comments: [],
        fallbackBody: buildSkipBody(skipReason),
      })
    })

    it("posts skip review when diff parses to zero files", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchDiff: async () => ({ kind: "ok" as const, diff: "" }),
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      const skipReason = "empty diff"
      expect(result).toEqual({
        findingsCount: 0,
        reviewUrl: "https://github.com/test/review/1",
        modelUsed: "",
        skippedReason: skipReason,
        costSummaryMarkdown: null,
      })
      expect(stubs.generateFindingsCalls).toHaveLength(0)
      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(first(stubs.submitReviewCalls)).toEqual({
        prNumber: fixturePrContext.prNumber,
        commitId: fixturePrContext.headSha,
        body: buildSkipBody(skipReason),
        comments: [],
        fallbackBody: buildSkipBody(skipReason),
      })
    })

    it("posts skip review when annotated diff exceeds budget", async () => {
      const stubs = makeOrchestrateDeps({
        config: { contextBudgetTokens: 10 },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      const budgetHalf = Math.floor(10 / 2)
      const skipReason = `diff too large for context budget (${sampleDiffTokens} tokens, limit ${budgetHalf} of 10)`
      expect(result).toEqual({
        findingsCount: 0,
        reviewUrl: "https://github.com/test/review/1",
        modelUsed: "",
        skippedReason: skipReason,
        costSummaryMarkdown: null,
      })
      expect(stubs.generateFindingsCalls).toHaveLength(0)
      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(first(stubs.submitReviewCalls)).toEqual({
        prNumber: fixturePrContext.prNumber,
        commitId: fixturePrContext.headSha,
        body: buildSkipBody(skipReason),
        comments: [],
        fallbackBody: buildSkipBody(skipReason),
      })
    })

    it("passes correct prNumber and commitId in skip reviews", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchDiff: async () => ({ kind: "too_large" as const }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      const reviewCall = first(stubs.submitReviewCalls)
      expect(reviewCall.prNumber).toBe(fixturePrContext.prNumber)
      expect(reviewCall.commitId).toBe(fixturePrContext.headSha)
    })
  })

  describe("happy path", () => {
    it("posts review with correct params and returns expected result", async () => {
      const stubs = makeOrchestrateDeps()
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result).toEqual({
        findingsCount: expectedSelection.selected.length,
        reviewUrl: "https://github.com/test/review/1",
        modelUsed: "test/model",
        skippedReason: "",
        costSummaryMarkdown: expectedCostSummary,
      })

      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(first(stubs.submitReviewCalls)).toEqual({
        prNumber: fixturePrContext.prNumber,
        commitId: fixturePrContext.headSha,
        body: expectedBody,
        comments: expectedMapped.comments,
        fallbackBody: expectedFallbackBody,
      })
    })

    it("passes changed files and conventions to generateFindings", async () => {
      const stubs = makeOrchestrateDeps()
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.generateFindingsCalls).toHaveLength(1)
      const reviewContext = first(stubs.generateFindingsCalls)
      expect(reviewContext.conventions).toBe("# Test conventions")
      expect(reviewContext.changedFiles).toEqual([fixtureChangedFile])
      expect(reviewContext.prContext).toEqual(fixturePrContext)
    })

    it("includes annotated diff in review context", async () => {
      const stubs = makeOrchestrateDeps()
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      const reviewContext = first(stubs.generateFindingsCalls)
      expect(reviewContext.annotatedDiff).toContain("=== src/greeter.ts ===")
    })
  })

  describe("context wiring", () => {
    it("passes budget minus diff tokens to readChangedFiles", async () => {
      const localReadChangedFilesCalls: ReadChangedFilesParams[] = []
      const stubs = makeOrchestrateDeps({
        contextReader: {
          readChangedFiles: async (params) => {
            localReadChangedFilesCalls.push(params)
            return { files: [fixtureChangedFile], remainingTokens: 10_000 }
          },
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(localReadChangedFilesCalls).toHaveLength(1)
      const call = first(localReadChangedFilesCalls)
      expect(call.budgetTokens).toBe(
        baseConfig.contextBudgetTokens - sampleDiffTokens,
      )
    })

    it("passes remainingTokens from readChangedFiles to findRelatedFiles", async () => {
      const expectedRemainingTokens = 12_345
      const localFindRelatedFilesCalls: FindRelatedFilesParams[] = []
      const stubs = makeOrchestrateDeps({
        config: { traceRelatedFiles: true },
        contextReader: {
          readChangedFiles: async () => ({
            files: [fixtureChangedFile],
            remainingTokens: expectedRemainingTokens,
          }),
          findRelatedFiles: async (params) => {
            localFindRelatedFilesCalls.push(params)
            return []
          },
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(localFindRelatedFilesCalls).toHaveLength(1)
      const call = first(localFindRelatedFilesCalls)
      expect(call.budgetTokens).toBe(expectedRemainingTokens)
    })

    it("passes paths extracted from the diff to readChangedFiles", async () => {
      const stubs = makeOrchestrateDeps()
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.readChangedFilesCalls).toHaveLength(1)
      const changedPaths = first(stubs.readChangedFilesCalls).changedPaths
      // The fixture diff modifies src/greeter.ts, adds src/added-file.ts,
      // renames to src/new-name.ts, modifies src/no-trailing-newline.ts, and
      // deletes src/removed-file.ts (null newFilePath) + binary logo.png
      expect(changedPaths).toContain("src/greeter.ts")
      expect(changedPaths).toContain("src/added-file.ts")
      expect(changedPaths).toContain("src/new-name.ts")
      // Deleted file has no newFilePath — should NOT appear
      expect(changedPaths).not.toContain("src/removed-file.ts")
    })

    it("passes remaining budget after related files to findRelatedDocs", async () => {
      const expectedRemainingTokens = 20_000
      const relatedFileContent = "x".repeat(100)
      const relatedFileTokens = estimateTokens(relatedFileContent)
      const localDocCalls: FindRelatedDocsParams[] = []
      const stubs = makeOrchestrateDeps({
        config: { traceRelatedFiles: true },
        contextReader: {
          readChangedFiles: async () => ({
            files: [fixtureChangedFile],
            remainingTokens: expectedRemainingTokens,
          }),
          findRelatedFiles: async () => [
            {
              path: "src/caller.ts",
              content: relatedFileContent,
              includedAs: "full" as const,
              reason: "imports src/greeter.ts",
            },
          ],
          findRelatedDocs: async (params) => {
            localDocCalls.push(params)
            return []
          },
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(localDocCalls).toHaveLength(1)
      const call = first(localDocCalls)
      expect(call.budgetTokens).toBe(
        expectedRemainingTokens - relatedFileTokens,
      )
    })

    it("passes conventionsFile to findRelatedDocs for exclusion", async () => {
      const stubs = makeOrchestrateDeps({
        config: { traceRelatedFiles: true, conventionsFile: "CUSTOM.md" },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.findRelatedDocsCalls).toHaveLength(1)
      expect(first(stubs.findRelatedDocsCalls).conventionsFile).toBe(
        "CUSTOM.md",
      )
    })

    it("passes relatedDocs into generateFindings review context", async () => {
      const docFile: PromptFile = {
        path: "docs/api.md",
        content: "# API",
        includedAs: "full",
        reason: "mentions src/greeter.ts",
      }
      const stubs = makeOrchestrateDeps({
        config: { traceRelatedFiles: true },
        contextReader: {
          findRelatedDocs: async () => [docFile],
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      const reviewContext = first(stubs.generateFindingsCalls)
      expect(reviewContext.relatedDocs).toEqual([docFile])
    })
  })

  describe("conditional behaviors", () => {
    it("always calls readPriorityDocs even when traceRelatedFiles is false", async () => {
      const stubs = makeOrchestrateDeps({
        config: { traceRelatedFiles: false, priorityDocs: ["README.md"] },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.readPriorityDocsCalls).toHaveLength(1)
      expect(first(stubs.readPriorityDocsCalls).priorityDocs).toEqual([
        "README.md",
      ])
    })

    it("skips findRelatedFiles and findRelatedDocs when traceRelatedFiles is false", async () => {
      const stubs = makeOrchestrateDeps({
        config: { traceRelatedFiles: false },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.findRelatedFilesCalls).toHaveLength(0)
      expect(stubs.findRelatedDocsCalls).toHaveLength(0)
      const reviewContext = first(stubs.generateFindingsCalls)
      expect(reviewContext.relatedFiles).toEqual([])
      expect(reviewContext.relatedDocs).toEqual([])
    })

    it("calls findRelatedFiles when traceRelatedFiles is true", async () => {
      const stubs = makeOrchestrateDeps({
        config: { traceRelatedFiles: true },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.findRelatedFilesCalls).toHaveLength(1)
    })

    it("posts zero-findings body when all findings are below threshold", async () => {
      const stubs = makeOrchestrateDeps({
        config: { severityThreshold: "critical" },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(0)
      expect(result.reviewUrl).toBe("https://github.com/test/review/1")
      expect(result.skippedReason).toBe("")
      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(first(stubs.submitReviewCalls)).toEqual({
        prNumber: fixturePrContext.prNumber,
        commitId: fixturePrContext.headSha,
        body: expectedZeroBody,
        comments: [],
        fallbackBody: expectedZeroBody,
      })
    })

    it("respects maxFindings cap and includes dropped findings in body", async () => {
      const stubs = makeOrchestrateDeps({
        config: { maxFindings: 1 },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(1)
      expect(stubs.submitReviewCalls).toHaveLength(1)
      const reviewCall = first(stubs.submitReviewCalls)
      expect(reviewCall.body).toBe(expectedCappedBody)
    })

    it("returns costSummaryMarkdown when LLM call happened", async () => {
      const stubs = makeOrchestrateDeps()
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.costSummaryMarkdown).toBe(expectedCostSummary)
    })

    it("returns null costSummaryMarkdown when skipped before LLM call", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchDiff: async () => ({ kind: "too_large" as const }),
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.costSummaryMarkdown).toBeNull()
    })

    it("builds fallback body with all selected findings", async () => {
      const stubs = makeOrchestrateDeps()
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      const reviewCall = first(stubs.submitReviewCalls)
      expect(reviewCall.fallbackBody).toBe(expectedFallbackBody)
    })

    it("uses complete PrContext from pull_request event without fetching", async () => {
      const stubs = makeOrchestrateDeps()
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.fetchPullRequestCalls).toHaveLength(0)
    })

    it("filters non-findings from LLM output", async () => {
      const nonFinding = makeFinding({
        line: 3,
        failure_scenario: "N/A — this is correct behavior.",
      })
      const realFinding = makeFinding({
        line: 145,
        failure_scenario:
          'register(" ", "value") succeeds and the entry is orphaned.',
      })
      const mixedResponse: ReviewResponse = {
        analysis: "checked",
        findings: [nonFinding, realFinding],
      }

      const { findings: mixedFiltered } = filterNonFindings(
        mixedResponse.findings,
      )
      const mixedSelection = selectFindings({
        findings: mixedFiltered,
        severityThreshold: "low",
        maxFindings: undefined,
      })
      const mixedMapped = mapFindingsToReview({
        findings: mixedSelection.selected,
        commentableByPath: fixtureCommentableByPath,
      })
      const mixedBody = buildReviewBody({
        bodyFindings: mixedMapped.bodyFindings,
        droppedByCap: mixedSelection.droppedByCap,
        model: "test/model",
        inlineCommentCount: mixedMapped.comments.length,
      })
      const mixedFallbackBody = buildReviewBody({
        bodyFindings: mixedSelection.selected,
        droppedByCap: mixedSelection.droppedByCap,
        model: "test/model",
        bodyFindingsHeading: "Findings",
        bodyFindingsDescription:
          "Inline comments were unavailable; all findings are listed here:",
      })

      const stubs = makeOrchestrateDeps({
        fixtureResult: { review: mixedResponse },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result).toEqual({
        findingsCount: 1,
        reviewUrl: "https://github.com/test/review/1",
        modelUsed: "test/model",
        skippedReason: "",
        costSummaryMarkdown: expectedCostSummary,
      })

      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(first(stubs.submitReviewCalls)).toEqual({
        prNumber: fixturePrContext.prNumber,
        commitId: fixturePrContext.headSha,
        body: mixedBody,
        comments: mixedMapped.comments,
        fallbackBody: mixedFallbackBody,
      })

      expect(logger.messages).toContainEqual({
        level: "info",
        message: "filtered non-findings",
        data: { droppedAsNonFinding: 1 },
      })
    })
  })

  describe("cross-run dedup", () => {
    it("first run — posts normal review, no summary comment", async () => {
      const stubs = makeOrchestrateDeps()
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(expectedSelection.selected.length)
      expect(stubs.fetchReviewCommentsCalls).toHaveLength(1)
      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(stubs.upsertSummaryCommentCalls).toHaveLength(0)
    })

    it("re-run — filters duplicate findings and posts only new ones", async () => {
      const findings = fixtureReviewResponse.findings
      const duplicateFinding = findings[0]
      if (duplicateFinding === undefined) {
        throw new Error("expected at least one fixture finding")
      }
      const duplicateAnchor = computeAnchorKey(duplicateFinding)

      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchReviewComments: async () => [
            {
              path: duplicateFinding.file,
              body: `some comment\n\n<!-- umm-actually:${duplicateAnchor} -->`,
            },
          ],
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      const newFindingCount = findings.length - 1
      expect(result.findingsCount).toBe(newFindingCount)
      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(stubs.upsertSummaryCommentCalls).toHaveLength(1)

      const summaryCall = first(stubs.upsertSummaryCommentCalls)
      expect(summaryCall.anchor).toBe(RERUN_ANCHOR)
      expect(summaryCall.body).toBe(
        buildRerunSummary({
          sha: fixturePrContext.headSha,
          newCount: newFindingCount,
          totalCount: 1 + newFindingCount,
          model: "test/model",
        }),
      )
    })

    it("re-run — skips review when all findings are duplicates", async () => {
      const findings = fixtureReviewResponse.findings
      const existingComments = findings.map((finding) => ({
        path: finding.file,
        body: `comment\n\n<!-- umm-actually:${computeAnchorKey(finding)} -->`,
      }))

      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchReviewComments: async () => existingComments,
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(0)
      expect(result.reviewUrl).toBe("")
      expect(stubs.submitReviewCalls).toHaveLength(0)
      expect(stubs.upsertSummaryCommentCalls).toHaveLength(1)

      const summaryCall = first(stubs.upsertSummaryCommentCalls)
      expect(summaryCall.body).toBe(
        buildRerunSummary({
          sha: fixturePrContext.headSha,
          newCount: 0,
          totalCount: findings.length,
          model: "test/model",
        }),
      )
    })

    it("re-run — zero findings from LLM posts summary only", async () => {
      const stubs = makeOrchestrateDeps({
        fixtureResult: {
          review: { analysis: "clean", findings: [] },
        },
        githubClient: {
          fetchReviewComments: async () => [
            {
              path: "src/a.ts",
              body: "body\n\n<!-- umm-actually:src/a.ts:correctness:aaaaaaaa -->",
            },
          ],
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(0)
      expect(stubs.submitReviewCalls).toHaveLength(0)
      expect(stubs.upsertSummaryCommentCalls).toHaveLength(1)

      const summaryCall = first(stubs.upsertSummaryCommentCalls)
      expect(summaryCall.body).toBe(
        buildRerunSummary({
          sha: fixturePrContext.headSha,
          newCount: 0,
          totalCount: 1,
          model: "test/model",
        }),
      )
    })

    it("does not fetch review comments on skip paths", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchDiff: async () => ({ kind: "too_large" as const }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.fetchReviewCommentsCalls).toHaveLength(0)
    })

    it("continues without throwing when upsertSummaryComment fails", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchReviewComments: async () => [
            {
              path: "src/a.ts",
              body: "body\n\n<!-- umm-actually:src/a.ts:correctness:aaaaaaaa -->",
            },
          ],
          upsertSummaryComment: async () => {
            throw new Error("API rate limit")
          },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(expectedSelection.selected.length)
      expect(result.reviewUrl).toBe("https://github.com/test/review/1")
      expect(stubs.submitReviewCalls).toHaveLength(1)
    })

    it("degrades to first run when fetching review comments fails", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchReviewComments: async () => {
            throw new Error("network error")
          },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(expectedSelection.selected.length)
      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(stubs.upsertSummaryCommentCalls).toHaveLength(0)
    })
  })
})

describe("createPromptedGenerateFindings", () => {
  it("passes model and fallbackModel to openrouterClient.requestReview", async () => {
    const requestReviewCalls: RequestReviewParams[] = []
    const stubClient: OpenRouterClient = {
      requestReview: async (params) => {
        requestReviewCalls.push(params)
        return {
          review: fixtureReviewResponse,
          modelUsed: "test/model",
          attempts: [fixtureAttempt],
        }
      },
    }

    const generate = createPromptedGenerateFindings(
      {
        openrouterClient: stubClient,
        model: "test/primary",
        fallbackModel: "test/fallback",
      },
      createTestLogger(),
    )

    const files = parseDiff(sampleDiff)
    const { annotateDiff } = await import("../diff/annotate-diff.js")
    const { resolvePhases } = await import("../review/phases.js")
    const phases = resolvePhases("combined")
    const phase = phases[0]
    if (phase === undefined) throw new Error("expected a phase")

    await generate({
      prContext: fixturePrContext,
      phase,
      conventions: "test conventions",
      changedFiles: [fixtureChangedFile],
      relatedFiles: [],
      relatedDocs: [],
      annotatedDiff: annotateDiff(files),
      priorFindings: [],
    })

    expect(requestReviewCalls).toHaveLength(1)
    expect(requestReviewCalls[0]).toEqual(
      expect.objectContaining({
        model: "test/primary",
        fallbackModel: "test/fallback",
      }),
    )
  })

  it("includes annotated diff in the user prompt", async () => {
    const requestReviewCalls: RequestReviewParams[] = []
    const stubClient: OpenRouterClient = {
      requestReview: async (params) => {
        requestReviewCalls.push(params)
        return {
          review: fixtureReviewResponse,
          modelUsed: "test/model",
          attempts: [fixtureAttempt],
        }
      },
    }

    const generate = createPromptedGenerateFindings(
      { openrouterClient: stubClient, model: "m", fallbackModel: null },
      createTestLogger(),
    )

    const files = parseDiff(sampleDiff)
    const { annotateDiff } = await import("../diff/annotate-diff.js")
    const { resolvePhases } = await import("../review/phases.js")
    const phases = resolvePhases("combined")
    const phase = phases[0]
    if (phase === undefined) throw new Error("expected a phase")
    const annotated = annotateDiff(files)

    await generate({
      prContext: fixturePrContext,
      phase,
      conventions: null,
      changedFiles: [],
      relatedFiles: [],
      relatedDocs: [],
      annotatedDiff: annotated,
      priorFindings: [],
    })

    const call = first(requestReviewCalls)
    expect(call.userPrompt).toContain("src/greeter.ts")
  })

  it("generates a unique nonce per call", async () => {
    const userPrompts: string[] = []
    const stubClient: OpenRouterClient = {
      requestReview: async (params) => {
        userPrompts.push(params.userPrompt)
        return {
          review: { analysis: "", findings: [] },
          modelUsed: "m",
          attempts: [],
        }
      },
    }

    const generate = createPromptedGenerateFindings(
      { openrouterClient: stubClient, model: "m", fallbackModel: null },
      createTestLogger(),
    )

    const files = parseDiff(sampleDiff)
    const { annotateDiff } = await import("../diff/annotate-diff.js")
    const { resolvePhases } = await import("../review/phases.js")
    const phases = resolvePhases("combined")
    const phase = phases[0]
    if (phase === undefined) throw new Error("expected a phase")
    const annotated = annotateDiff(files)

    const context: ReviewContext = {
      prContext: fixturePrContext,
      phase,
      conventions: null,
      changedFiles: [],
      relatedFiles: [],
      relatedDocs: [],
      annotatedDiff: annotated,
      priorFindings: [],
    }

    await generate(context)
    await generate(context)

    expect(userPrompts).toHaveLength(2)
    // Nonce-suffixed tags should differ between calls
    const noncePattern = /<diff-([a-f0-9]{12})\b/
    const nonce1 = userPrompts[0]?.match(noncePattern)?.[1]
    const nonce2 = userPrompts[1]?.match(noncePattern)?.[1]
    expect(nonce1).toBeDefined()
    expect(nonce2).toBeDefined()
    expect(nonce1).not.toBe(nonce2)
  })
})
