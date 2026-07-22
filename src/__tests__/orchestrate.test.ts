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
import type { Finding, ReviewResponse } from "../review/finding.js"
import {
  buildStatusComment,
  computeAnchorKey,
  mapFindingsToReview,
  renderStandaloneFinding,
  REVIEW_MARKER,
  STATUS_ANCHOR,
  type ReviewComment,
} from "../review/comment-mapping.js"
import { filterNonFindings } from "../review/filter-non-findings.js"
import { selectFindings } from "../review/select-findings.js"
import { renderCostSummary } from "../openrouter/cost-summary.js"
import {
  renderReviewSummary,
  type ReviewSummaryStats,
} from "../review/review-summary.js"
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
const expectedCostSummary = renderCostSummary({
  attempts: [fixtureAttempt],
  modelUsed: "test/model",
})

const expectedReviewSummary = (
  overrides: Partial<ReviewSummaryStats> = {},
): string =>
  renderReviewSummary({
    prContext: fixturePrContext,
    conventionsFile: "AGENTS.md",
    changedFilePaths: [fixtureChangedFile.path],
    relatedFilePaths: [],
    relatedFilesExcludedPaths: [],
    priorityDocPaths: [],
    mentionMatchedDocPaths: [],
    docsExcludedPaths: [],
    totalFromModel: fixtureReviewResponse.findings.length,
    droppedAsNonFinding: 0,
    duplicatesRemoved: 0,
    droppedBelowThreshold: 0,
    droppedByCap: 0,
    posted: expectedSelection.selected.length,
    ...overrides,
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

/** Full expected postFindingsReview params for a run posting `findings` as
 *  new — exact whole-value asserts catch a wrong finding surviving dedup or
 *  an incomplete payload that count-only checks would miss. */
const expectedFindingsReview = (findings: Finding[]) => {
  const mapped = mapFindingsToReview({
    findings,
    commentableByPath: fixtureCommentableByPath,
  })
  return {
    prNumber: 7,
    commitId: fixturePrContext.headSha,
    body: REVIEW_MARKER,
    comments: mapped.comments,
  }
}

/** Full expected upsertSummaryComment params for the status comment. */
const expectedStatus = ({
  isFirstRun,
  postedCount,
  unpostedCount = 0,
  totalCount,
  droppedByCap = [],
  contextNotes = [],
}: {
  isFirstRun: boolean
  postedCount: number
  unpostedCount?: number
  totalCount: number
  droppedByCap?: Finding[]
  contextNotes?: string[]
}) => ({
  prNumber: 7,
  anchor: STATUS_ANCHOR,
  body: buildStatusComment({
    sha: fixturePrContext.headSha,
    isFirstRun,
    postedCount,
    unpostedCount,
    totalCount,
    droppedByCap,
    model: "test/model",
    contextNotes,
  }),
})

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
  priorityDocs: [],
  costSummary: true,
  prNumberOverride: undefined,
}

type SubmitReviewParams = {
  prNumber: number
  commitId: string
  body: string
}

type PostFindingsReviewParams = {
  prNumber: number
  commitId: string
  body: string
  comments: ReviewComment[]
}

type PostIssueCommentParams = {
  prNumber: number
  body: string
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
  postFindingsReviewCalls: PostFindingsReviewParams[]
  postIssueCommentCalls: PostIssueCommentParams[]
  fetchBotReviewCommentsCalls: { prNumber: number }[]
  fetchBotIssueCommentsCalls: { prNumber: number }[]
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
  const postFindingsReviewCalls: PostFindingsReviewParams[] = []
  const postIssueCommentCalls: PostIssueCommentParams[] = []
  const fetchBotReviewCommentsCalls: { prNumber: number }[] = []
  const fetchBotIssueCommentsCalls: { prNumber: number }[] = []
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
      return { url: "https://github.com/test/review/1" }
    },
    postFindingsReview: async (params) => {
      postFindingsReviewCalls.push(params)
      return { kind: "ok" as const, url: "https://github.com/test/review/1" }
    },
    postIssueComment: async (params) => {
      postIssueCommentCalls.push(params)
      return { url: "https://github.com/test/comment/1" }
    },
    fetchBotReviewComments: async (params) => {
      fetchBotReviewCommentsCalls.push(params)
      return []
    },
    fetchBotIssueComments: async (params) => {
      fetchBotIssueCommentsCalls.push(params)
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
      return { files: [], excludedByCapPaths: [] }
    },
    readPriorityDocs: async (params) => {
      readPriorityDocsCalls.push(params)
      return { files: [], remainingTokens: params.budgetTokens }
    },
    findRelatedDocs: async (params) => {
      findRelatedDocsCalls.push(params)
      return { files: [], excludedByCapPaths: [] }
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
    postFindingsReviewCalls,
    postIssueCommentCalls,
    fetchBotReviewCommentsCalls,
    fetchBotIssueCommentsCalls,
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
        reviewSummaryMarkdown: null,
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
        reviewSummaryMarkdown: null,
        costSummaryMarkdown: null,
      })
      expect(stubs.generateFindingsCalls).toHaveLength(0)
      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(first(stubs.submitReviewCalls)).toEqual({
        prNumber: fixturePrContext.prNumber,
        commitId: fixturePrContext.headSha,
        body: buildSkipBody(skipReason),
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
        reviewSummaryMarkdown: null,
        costSummaryMarkdown: null,
      })
      expect(stubs.generateFindingsCalls).toHaveLength(0)
      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(first(stubs.submitReviewCalls)).toEqual({
        prNumber: fixturePrContext.prNumber,
        commitId: fixturePrContext.headSha,
        body: buildSkipBody(skipReason),
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
        reviewSummaryMarkdown: null,
        costSummaryMarkdown: null,
      })
      expect(stubs.generateFindingsCalls).toHaveLength(0)
      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(first(stubs.submitReviewCalls)).toEqual({
        prNumber: fixturePrContext.prNumber,
        commitId: fixturePrContext.headSha,
        body: buildSkipBody(skipReason),
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
        reviewSummaryMarkdown: expectedReviewSummary(),
        costSummaryMarkdown: expectedCostSummary,
      })

      expect(stubs.submitReviewCalls).toHaveLength(0)
      expect(stubs.postFindingsReviewCalls).toEqual([
        expectedFindingsReview(expectedSelection.selected),
      ])
      expect(stubs.postIssueCommentCalls).toEqual(
        expectedMapped.bodyFindings.map((finding) => ({
          prNumber: fixturePrContext.prNumber,
          body: renderStandaloneFinding(finding),
        })),
      )
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: expectedSelection.selected.length,
          totalCount: expectedSelection.selected.length,
        }),
      ])
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
            return { files: [], excludedByCapPaths: [] }
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
          findRelatedFiles: async () => ({
            files: [
              {
                path: "src/caller.ts",
                content: relatedFileContent,
                includedAs: "full" as const,
                reason: "imports src/greeter.ts",
              },
            ],
            excludedByCapPaths: [],
          }),
          findRelatedDocs: async (params) => {
            localDocCalls.push(params)
            return { files: [], excludedByCapPaths: [] }
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

    it("passes priorityDocs as excludePaths to findRelatedDocs", async () => {
      const stubs = makeOrchestrateDeps({
        config: {
          traceRelatedFiles: true,
          priorityDocs: ["README.md", "CHANGELOG.md"],
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.findRelatedDocsCalls).toHaveLength(1)
      expect(first(stubs.findRelatedDocsCalls).excludePaths).toEqual([
        "README.md",
        "CHANGELOG.md",
      ])
    })

    it("clamps doc budget to zero when related files exhaust remaining tokens", async () => {
      const largeRelatedFileContent = "x".repeat(100)
      const largeRelatedFileTokens = estimateTokens(largeRelatedFileContent)
      const localPriorityDocsCalls: ReadPriorityDocsParams[] = []
      const stubs = makeOrchestrateDeps({
        config: { traceRelatedFiles: true },
        contextReader: {
          readChangedFiles: async () => ({
            files: [fixtureChangedFile],
            remainingTokens: 10,
          }),
          findRelatedFiles: async () => ({
            files: [
              {
                path: "src/caller.ts",
                content: largeRelatedFileContent,
                includedAs: "full" as const,
                reason: "imports src/greeter.ts",
              },
            ],
            excludedByCapPaths: [],
          }),
          readPriorityDocs: async (params) => {
            localPriorityDocsCalls.push(params)
            return { files: [], remainingTokens: params.budgetTokens }
          },
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(localPriorityDocsCalls).toHaveLength(1)
      // remainingTokens (10) < relatedFilesTokens (25) → Math.max(0, -15) = 0
      expect(first(localPriorityDocsCalls).budgetTokens).toBe(0)
      expect(largeRelatedFileTokens).toBeGreaterThan(10)
    })

    it("passes budget remaining after readPriorityDocs to findRelatedDocs", async () => {
      const priorityDocTokens = 500
      const priorityDocContent = "x".repeat(priorityDocTokens * 4)
      const expectedRemainingTokens = 20_000
      const localDocCalls: FindRelatedDocsParams[] = []
      const stubs = makeOrchestrateDeps({
        config: { traceRelatedFiles: true, priorityDocs: ["README.md"] },
        contextReader: {
          readChangedFiles: async () => ({
            files: [fixtureChangedFile],
            remainingTokens: expectedRemainingTokens,
          }),
          findRelatedFiles: async () => ({
            files: [],
            excludedByCapPaths: [],
          }),
          readPriorityDocs: async (params) => ({
            files: [
              {
                path: "README.md",
                content: priorityDocContent,
                includedAs: "full" as const,
                reason: "priority documentation",
              },
            ],
            remainingTokens: params.budgetTokens - priorityDocTokens,
          }),
          findRelatedDocs: async (params) => {
            localDocCalls.push(params)
            return { files: [], excludedByCapPaths: [] }
          },
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(localDocCalls).toHaveLength(1)
      expect(first(localDocCalls).budgetTokens).toBe(
        expectedRemainingTokens - priorityDocTokens,
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
          findRelatedDocs: async () => ({
            files: [docFile],
            excludedByCapPaths: [],
          }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      const reviewContext = first(stubs.generateFindingsCalls)
      expect(reviewContext.relatedDocs).toEqual([docFile])
    })

    it("adds a context note when a priority doc is skipped", async () => {
      const stubs = makeOrchestrateDeps({
        config: { priorityDocs: ["README.md", "CHANGELOG.md"] },
        contextReader: {
          readPriorityDocs: async (params) => ({
            files: [
              {
                path: "README.md",
                content: "# Readme",
                includedAs: "full" as const,
                reason: "priority documentation",
              },
            ],
            remainingTokens: params.budgetTokens - 10,
          }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: expectedSelection.selected.length,
          totalCount: expectedSelection.selected.length,
          contextNotes: [
            "Priority docs not included: `CHANGELOG.md` (missing, unreadable, or over budget)",
          ],
        }),
      ])
    })

    it("adds a context note when related files are excluded by cap", async () => {
      const stubs = makeOrchestrateDeps({
        config: { traceRelatedFiles: true },
        contextReader: {
          findRelatedFiles: async () => ({
            files: [],
            excludedByCapPaths: ["src/extra-a.ts", "src/extra-b.ts"],
          }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: expectedSelection.selected.length,
          totalCount: expectedSelection.selected.length,
          contextNotes: [
            "2 related file(s) excluded by `max_related_files` cap: `src/extra-a.ts`, `src/extra-b.ts`",
          ],
        }),
      ])
    })

    it("adds a context note when related docs are excluded by cap", async () => {
      const stubs = makeOrchestrateDeps({
        config: { traceRelatedFiles: true },
        contextReader: {
          findRelatedDocs: async () => ({
            files: [],
            excludedByCapPaths: ["docs/overflow.md"],
          }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: expectedSelection.selected.length,
          totalCount: expectedSelection.selected.length,
          contextNotes: [
            "1 related doc(s) excluded by `max_related_docs` cap: `docs/overflow.md`",
          ],
        }),
      ])
    })

    it("combines all three context notes when all conditions are met", async () => {
      const stubs = makeOrchestrateDeps({
        config: {
          traceRelatedFiles: true,
          priorityDocs: ["MISSING.md"],
        },
        contextReader: {
          readPriorityDocs: async (params) => ({
            files: [],
            remainingTokens: params.budgetTokens,
          }),
          findRelatedFiles: async () => ({
            files: [],
            excludedByCapPaths: ["src/capped.ts"],
          }),
          findRelatedDocs: async () => ({
            files: [],
            excludedByCapPaths: ["docs/capped.md"],
          }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: expectedSelection.selected.length,
          totalCount: expectedSelection.selected.length,
          contextNotes: [
            "Priority docs not included: `MISSING.md` (missing, unreadable, or over budget)",
            "1 related file(s) excluded by `max_related_files` cap: `src/capped.ts`",
            "1 related doc(s) excluded by `max_related_docs` cap: `docs/capped.md`",
          ],
        }),
      ])
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

    it("posts no review and a clean status comment when all findings are below threshold", async () => {
      const stubs = makeOrchestrateDeps({
        config: { severityThreshold: "critical" },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(0)
      expect(result.reviewUrl).toBe("")
      expect(result.skippedReason).toBe("")
      expect(stubs.postFindingsReviewCalls).toHaveLength(0)
      expect(stubs.postIssueCommentCalls).toHaveLength(0)
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({ isFirstRun: true, postedCount: 0, totalCount: 0 }),
      ])
    })

    it("respects maxFindings cap and notes dropped findings in the status comment", async () => {
      const stubs = makeOrchestrateDeps({
        config: { maxFindings: 1 },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(1)
      expect(stubs.postFindingsReviewCalls).toEqual([
        {
          prNumber: 7,
          commitId: fixturePrContext.headSha,
          body: REVIEW_MARKER,
          comments: expectedCappedMapped.comments,
        },
      ])
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: 1,
          totalCount: 1,
          droppedByCap: expectedCappedSelection.droppedByCap,
        }),
      ])
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

    it("re-routes inline findings to issue comments when GitHub rejects the anchors", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          postFindingsReview: async () => ({ kind: "rejected" as const }),
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.reviewUrl).toBe("")
      expect(result.findingsCount).toBe(expectedSelection.selected.length)
      expect(stubs.postIssueCommentCalls).toEqual(
        expectedSelection.selected.map((finding) => ({
          prNumber: 7,
          body: renderStandaloneFinding(finding),
        })),
      )
    })

    it("continues when the findings review post throws", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          postFindingsReview: async () => {
            throw new Error("boom")
          },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.reviewUrl).toBe("")
      expect(result.findingsCount).toBe(expectedMapped.bodyFindings.length)
      // Unposted findings are NOT re-routed — their missing anchors make the
      // next run re-report them, and the status comment says so instead of
      // claiming they were posted.
      expect(stubs.postIssueCommentCalls).toEqual(
        expectedMapped.bodyFindings.map((finding) => ({
          prNumber: 7,
          body: renderStandaloneFinding(finding),
        })),
      )
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: expectedMapped.bodyFindings.length,
          unpostedCount:
            expectedSelection.selected.length -
            expectedMapped.bodyFindings.length,
          totalCount: expectedMapped.bodyFindings.length,
        }),
      ])
      expect(logger.messages).toContainEqual({
        level: "warn",
        message:
          "failed to post findings review — findings will re-report next run",
        data: { error: "[Error]: boom" },
      })
    })

    it("continues when a beyond-diff comment post fails", async () => {
      const beyondDiffFinding = makeFinding({
        file: "src/untouched.ts",
        line: 400,
      })
      const stubs = makeOrchestrateDeps({
        fixtureResult: {
          review: { analysis: "checked", findings: [beyondDiffFinding] },
        },
        githubClient: {
          postIssueComment: async () => {
            throw new Error("boom")
          },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(0)
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: 0,
          unpostedCount: 1,
          totalCount: 0,
        }),
      ])
      expect(logger.messages).toContainEqual({
        level: "warn",
        message:
          "failed to post beyond-diff finding — it will re-report next run",
        data: {
          error: "[Error]: boom",
          file: "src/untouched.ts",
          line: 400,
        },
      })
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
        reviewSummaryMarkdown: expectedReviewSummary({
          totalFromModel: 2,
          droppedAsNonFinding: 1,
          posted: 1,
        }),
        costSummaryMarkdown: expectedCostSummary,
      })

      expect(stubs.postFindingsReviewCalls).toEqual([
        {
          prNumber: 7,
          commitId: fixturePrContext.headSha,
          body: REVIEW_MARKER,
          comments: mixedMapped.comments,
        },
      ])

      expect(logger.messages).toContainEqual({
        level: "info",
        message: "non-finding filter applied to model output",
        data: { totalFromModel: 2, kept: 1, droppedAsNonFinding: 1 },
      })
    })
  })

  describe("cross-run dedup", () => {
    const existingComment = (
      body: string,
      positions: { line?: number | null; originalLine?: number | null } = {},
    ) => ({
      path: "src/greeter.ts",
      body,
      line: positions.line ?? null,
      originalLine: positions.originalLine ?? null,
    })
    const statusComment = {
      body: `${STATUS_ANCHOR}\n\n**umm-actually** reviewed at \`abc1234\``,
    }
    const issueFinding = (key: string) => ({
      body: `finding text\n\n<!-- umm-actually:${key} -->`,
    })

    it("first run — no bot comments: posts findings and creates the status comment", async () => {
      const stubs = makeOrchestrateDeps()
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(expectedSelection.selected.length)
      expect(stubs.fetchBotReviewCommentsCalls).toEqual([{ prNumber: 7 }])
      expect(stubs.fetchBotIssueCommentsCalls).toEqual([{ prNumber: 7 }])
      expect(stubs.postFindingsReviewCalls).toEqual([
        expectedFindingsReview(expectedSelection.selected),
      ])
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: expectedSelection.selected.length,
          totalCount: expectedSelection.selected.length,
        }),
      ])
    })

    it("dedups findings matching inline-comment anchors and posts the rest", async () => {
      const findings = fixtureReviewResponse.findings
      const duplicateFinding = findings[0]
      if (!duplicateFinding) {
        throw new Error("expected at least one fixture finding")
      }

      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchBotReviewComments: async () => [
            existingComment(
              `some comment\n\n<!-- umm-actually:${computeAnchorKey(duplicateFinding)} -->`,
            ),
          ],
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(findings.length - 1)
      expect(stubs.postFindingsReviewCalls).toEqual([
        expectedFindingsReview(findings.slice(1)),
      ])
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: findings.length - 1,
          totalCount: findings.length,
        }),
      ])
    })

    it("a finding comment quoting the status marker mid-body does not make the run a re-run", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchBotIssueComments: async () => [
            { body: `finding text quoting \`${STATUS_ANCHOR}\` mid-body` },
          ],
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(expectedSelection.selected.length)
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: expectedSelection.selected.length,
          totalCount: expectedSelection.selected.length,
        }),
      ])
    })

    it("counts duplicate anchors for one finding once in the status comment", async () => {
      const findings = fixtureReviewResponse.findings
      const duplicateFinding = findings[0]
      if (!duplicateFinding) {
        throw new Error("expected at least one fixture finding")
      }

      // Two anchors within LINE_PROXIMITY of each other — the residue a
      // fail-open fetch leaves when it reposts an already-anchored finding.
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchBotIssueComments: async () => [
            issueFinding(computeAnchorKey(duplicateFinding)),
            issueFinding(
              computeAnchorKey({
                ...duplicateFinding,
                line: duplicateFinding.line + 2,
              }),
            ),
          ],
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(findings.length - 1)
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: findings.length - 1,
          totalCount: findings.length,
        }),
      ])
    })

    it("dedups findings matching beyond-diff issue-comment anchors", async () => {
      const findings = fixtureReviewResponse.findings
      const duplicateFinding = findings[0]
      if (!duplicateFinding) {
        throw new Error("expected at least one fixture finding")
      }

      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchBotIssueComments: async () => [
            issueFinding(computeAnchorKey(duplicateFinding)),
          ],
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(findings.length - 1)
      expect(stubs.postFindingsReviewCalls).toEqual([
        expectedFindingsReview(findings.slice(1)),
      ])
    })

    it("dedups a finding whose reported line drifted within the window", async () => {
      const findings = fixtureReviewResponse.findings
      const driftedFinding = findings[0]
      if (!driftedFinding) {
        throw new Error("expected at least one fixture finding")
      }
      const driftedAnchor = computeAnchorKey({
        ...driftedFinding,
        line: driftedFinding.line + 3,
      })

      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchBotReviewComments: async () => [
            existingComment(
              `some comment\n\n<!-- umm-actually:${driftedAnchor} -->`,
            ),
          ],
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(findings.length - 1)
      expect(stubs.postFindingsReviewCalls).toEqual([
        expectedFindingsReview(findings.slice(1)),
      ])
    })

    it("dedup follows the comment's live position across pushes", async () => {
      const findings = fixtureReviewResponse.findings
      const movedFinding = findings[0]
      if (!movedFinding) {
        throw new Error("expected at least one fixture finding")
      }
      // Anchor was posted 50 lines away from where the finding sits now; the
      // comment's live position tracked the code as it moved.
      const staleAnchor = computeAnchorKey({
        ...movedFinding,
        line: movedFinding.line - 50,
      })

      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchBotReviewComments: async () => [
            existingComment(
              `some comment\n\n<!-- umm-actually:${staleAnchor} -->`,
              {
                line: movedFinding.line,
                originalLine: movedFinding.line - 50,
              },
            ),
          ],
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(findings.length - 1)
      expect(stubs.postFindingsReviewCalls).toEqual([
        expectedFindingsReview(findings.slice(1)),
      ])
    })

    it("legacy title-hash anchors don't dedup", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchBotReviewComments: async () => [
            existingComment(
              "old format\n\n<!-- umm-actually:src/greeter.ts:correctness:ffdf51bc -->",
            ),
          ],
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(expectedSelection.selected.length)
      expect(stubs.postFindingsReviewCalls).toEqual([
        expectedFindingsReview(expectedSelection.selected),
      ])
    })

    it("an existing status comment flips wording to re-reviewed", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchBotIssueComments: async () => [statusComment],
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: false,
          postedCount: expectedSelection.selected.length,
          totalCount: expectedSelection.selected.length,
        }),
      ])
    })

    it("zero new findings on a re-run still updates the status comment", async () => {
      const stubs = makeOrchestrateDeps({
        fixtureResult: {
          review: { analysis: "clean", findings: [] },
        },
        githubClient: {
          fetchBotIssueComments: async () => [
            statusComment,
            issueFinding("src/a.ts:correctness:42"),
          ],
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(0)
      expect(stubs.postFindingsReviewCalls).toHaveLength(0)
      expect(stubs.postIssueCommentCalls).toHaveLength(0)
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({ isFirstRun: false, postedCount: 0, totalCount: 1 }),
      ])
    })

    it("does not fetch comments on skip paths", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchDiff: async () => ({ kind: "too_large" as const }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.fetchBotReviewCommentsCalls).toHaveLength(0)
      expect(stubs.fetchBotIssueCommentsCalls).toHaveLength(0)
    })

    it("posts every finding as new when the inline-comment fetch fails", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchBotReviewComments: async () => {
            throw new Error("network error")
          },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(expectedSelection.selected.length)
      expect(stubs.postFindingsReviewCalls).toEqual([
        expectedFindingsReview(expectedSelection.selected),
      ])
      expect(logger.messages).toContainEqual({
        level: "warn",
        message:
          "failed to fetch inline comments — treating their findings as new",
        data: { error: "[Error]: network error" },
      })
    })

    it("treats an issue-comment fetch failure as a first run", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchBotIssueComments: async () => {
            throw new Error("network error")
          },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(expectedSelection.selected.length)
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: expectedSelection.selected.length,
          totalCount: expectedSelection.selected.length,
        }),
      ])
      expect(logger.messages).toContainEqual({
        level: "warn",
        message: "failed to fetch issue comments — treating as a first run",
        data: { error: "[Error]: network error" },
      })
    })

    it("continues without throwing when the status comment upsert fails", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          upsertSummaryComment: async () => {
            throw new Error("API rate limit")
          },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(expectedSelection.selected.length)
      expect(result.reviewUrl).toBe("https://github.com/test/review/1")
      expect(logger.messages).toContainEqual({
        level: "warn",
        message: "failed to upsert status comment",
        data: { error: "[Error]: API rate limit" },
      })
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
