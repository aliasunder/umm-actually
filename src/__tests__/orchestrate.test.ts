import { readFileSync } from "node:fs"
import parseDiff from "parse-diff"
import { describe, expect, it, vi } from "vitest"
import type { ActionConfig } from "../config.js"
import type { CheckRunConclusion, CheckRunOutput, GithubClient } from "../github/client.js"
import type { PrContext } from "../github/event.js"
import type { ContextReader } from "../context/workspace.js"
import {
  ReviewRequestError,
  createOpenRouterClient,
  type ChatRequestSubset,
  type ModelAttempt,
  type OpenRouterClient,
  type StructuredReviewResult,
} from "../openrouter/client.js"
import { buildUserPrompt, estimateTokens, type PromptFile } from "../review/prompt.js"
import { annotateDiff } from "../diff/annotate-diff.js"
import { computeCommentableLines } from "../diff/commentable-lines.js"
import type { AttributedFinding, Finding, ReviewResponse } from "../review/finding.js"
import {
  buildStatusComment,
  computeAnchorKey,
  mapFindingsToReview,
  renderBeyondDiffFinding,
  renderRejectedPathFinding,
  renderReroutedFinding,
  REVIEW_MARKER,
  STATUS_ANCHOR,
  type ReviewComment,
} from "../review/comment-mapping.js"
import { filterNonFindings } from "../review/filter-non-findings.js"
import {
  COMBINED_PHASE,
  CONVENTIONS_TESTS_PHASE,
  CORRECTNESS_SECURITY_PHASE,
  SUBTLE_BUGS_PHASE,
} from "../review/phases.js"
import { selectFindings } from "../review/select-findings.js"
import { renderCostSummary } from "../openrouter/cost-summary.js"
import { renderReviewSummary, type ReviewSummaryStats } from "../review/review-summary.js"
import {
  orchestrate,
  createPromptedGenerateFindings,
  type OrchestrateDeps,
  type GenerateFindings,
  type ReviewContext,
} from "../orchestrate.js"
import { makeFinding } from "../review/__tests__/make-finding.js"
import { createTestLogger, logsWithMessage } from "./test-logger.js"

const sampleDiff = readFileSync(new URL("../../fixtures/sample.diff", import.meta.url), "utf8")

const sampleDiffTokens = estimateTokens(annotateDiff(parseDiff(sampleDiff)))

const pullRequestPayload: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("../../fixtures/pull_request.opened.json", import.meta.url), "utf8"),
)

const fixtureReviewResponse: ReviewResponse = JSON.parse(
  readFileSync(new URL("../../fixtures/openrouter.response.json", import.meta.url), "utf8"),
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

const withRoutedModel = (finding: Finding, modelUsed: string): AttributedFinding => ({
  ...finding,
  modelUsed,
})

const findingsWithRoutedModel = (findings: Finding[], modelUsed: string): AttributedFinding[] => {
  return findings.map((finding) => withRoutedModel(finding, modelUsed))
}

const expectedSelection = selectFindings({
  findings: fixtureReviewResponse.findings,
  severityThreshold: "low",
  maxFindings: undefined,
})
const expectedMapped = mapFindingsToReview({
  findings: findingsWithRoutedModel(expectedSelection.selected, "test/model"),
  commentableByPath: fixtureCommentableByPath,
})
const expectedCostSummary = renderCostSummary({
  attempts: [{ ...fixtureAttempt, phase: "combined" }],
  modelUsed: "test/model",
})

const expectedReviewSummary = (overrides: Partial<ReviewSummaryStats> = {}): string =>
  renderReviewSummary({
    prContext: fixturePrContext,
    conventionsFile: "AGENTS.md",
    conventionsCoverage: {
      status: "full",
      characterCap: 32_000,
      totalCharacters: "# Test conventions".length,
    },
    phasesCompleted: ["combined"],
    phasesIncomplete: [],
    changedFilePaths: [fixtureChangedFile.path],
    relatedFilePaths: [],
    relatedFilesExcludedPaths: [],
    priorityDocPaths: [],
    priorityDocsInContextPaths: [],
    priorityDocsAbsentPaths: [],
    mentionMatchedDocPaths: [],
    docsExcludedPaths: [],
    tokenBudgetTotal: 80000,
    tokenBudgetUsedByDiff: 341,
    tokenBudgetPriorityDocFloor: 0,
    tokenBudgetRemainingForDocs: 40000,
    totalFromModel: fixtureReviewResponse.findings.length,
    droppedAsNonFinding: 0,
    droppedAsUnknownFile: 0,
    duplicatesAcrossPhases: 0,
    duplicatesRemoved: 0,
    droppedBelowThreshold: 0,
    droppedAsOverlapping: 0,
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
  findings: findingsWithRoutedModel(expectedCappedSelection.selected, "test/model"),
  commentableByPath: fixtureCommentableByPath,
})

/** Full expected postFindingsReview params for a run posting `findings` as
 *  new — exact whole-value asserts catch a wrong finding surviving dedup or
 *  an incomplete payload that count-only checks would miss. */
const expectedFindingsReview = (findings: Finding[]) => {
  const mapped = mapFindingsToReview({
    findings: findingsWithRoutedModel(findings, "test/model"),
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
  conventionsNote,
  incompletePhases = [],
}: {
  isFirstRun: boolean
  postedCount: number
  unpostedCount?: number
  totalCount: number
  droppedByCap?: Finding[]
  contextNotes?: string[]
  conventionsNote?: string
  incompletePhases?: string[]
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
    ...(conventionsNote && { conventionsNote }),
    incompletePhases,
  }),
})

const buildSkipBody = ({ reason, detail }: { reason: string; detail?: string }): string => {
  const detailSection = detail ? `\n\n${detail}` : ""
  return `**umm-actually** — review skipped\n\n${reason}${detailSection}\n\n---\n*umm-actually*`
}

const baseConfig: ActionConfig = {
  githubToken: "ghp_test",
  openrouterApiKey: "sk-test",
  model: "test/model",
  fallbackModel: null,
  requestTimeoutSeconds: 600,
  reviewTimeoutSeconds: 1500,
  maxFindings: undefined,
  severityThreshold: "low",
  conventionsFile: "AGENTS.md",
  conventionsBudgetTokens: 8_000,
  phases: "combined",
  contextBudgetTokens: 80_000,
  traceRelatedFiles: true,
  maxScanFiles: 5000,
  maxScanBytes: 262144,
  maxRelatedFiles: 8,
  maxRelatedDocs: 4,
  priorityDocs: [],
  excludePaths: [],
  diffExcludePaths: { defaultPatterns: [], diffExcludePathPatterns: [] },
  respectLinguistGenerated: true,
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
  diffOnlyPaths: string[]
}

type FindRelatedFilesParams = {
  changedPaths: string[]
  budgetTokens: number
  excludePaths: string[]
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
  excludePaths: string[]
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

type CreateCheckRunParams = { headSha: string; name: string }

type UpdateCheckRunParams = {
  checkRunId: number
  conclusion: CheckRunConclusion
  output: CheckRunOutput
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
  createCheckRunCalls: CreateCheckRunParams[]
  updateCheckRunCalls: UpdateCheckRunParams[]
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
    remainingReviewMs?: () => number
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
  const createCheckRunCalls: CreateCheckRunParams[] = []
  const updateCheckRunCalls: UpdateCheckRunParams[] = []
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
    createCheckRun: async (params) => {
      createCheckRunCalls.push(params)
      return { checkRunId: 555 }
    },
    updateCheckRun: async (params) => {
      updateCheckRunCalls.push(params)
    },
    ...overrides.githubClient,
  }

  const contextReader: ContextReader = {
    readConventions: async (params) => {
      readConventionsCalls.push(params)
      return "# Test conventions"
    },
    readGitAttributes: async () => null,
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
    remainingReviewMs: overrides.remainingReviewMs ?? (() => Infinity),
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
    createCheckRunCalls,
    updateCheckRunCalls,
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
        phases: [],
        reviewSummaryMarkdown: null,
        costSummaryMarkdown: null,
        conventionsNote: null,
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

      expect(stubs.fetchPullRequestCalls).toEqual([{ prNumber: 42 }])
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
        phases: [],
        reviewSummaryMarkdown: null,
        costSummaryMarkdown: null,
        conventionsNote: null,
      })
      expect(stubs.generateFindingsCalls).toHaveLength(0)
      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(first(stubs.submitReviewCalls)).toEqual({
        prNumber: fixturePrContext.prNumber,
        commitId: fixturePrContext.headSha,
        body: buildSkipBody({ reason: skipReason }),
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
        phases: [],
        reviewSummaryMarkdown: null,
        costSummaryMarkdown: null,
        conventionsNote: null,
      })
      expect(stubs.generateFindingsCalls).toHaveLength(0)
      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(first(stubs.submitReviewCalls)).toEqual({
        prNumber: fixturePrContext.prNumber,
        commitId: fixturePrContext.headSha,
        body: buildSkipBody({ reason: skipReason }),
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
        phases: [],
        reviewSummaryMarkdown: null,
        costSummaryMarkdown: null,
        conventionsNote: null,
      })
      expect(stubs.generateFindingsCalls).toHaveLength(0)
      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(first(stubs.submitReviewCalls)).toEqual({
        prNumber: fixturePrContext.prNumber,
        commitId: fixturePrContext.headSha,
        body: buildSkipBody({ reason: skipReason }),
      })
    })

    it("posts skip review when every changed file matches diff_exclude_paths", async () => {
      const stubs = makeOrchestrateDeps({
        config: {
          diffExcludePaths: {
            defaultPatterns: [],
            diffExcludePathPatterns: ["src/**", "assets/**"],
          },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      const skipReason =
        "all 6 changed file(s) excluded from review (6 by diff_exclude_paths input)"
      expect(result).toEqual({
        findingsCount: 0,
        reviewUrl: "https://github.com/test/review/1",
        modelUsed: "",
        skippedReason: skipReason,
        phases: [],
        reviewSummaryMarkdown: null,
        costSummaryMarkdown: null,
        conventionsNote: null,
      })
      expect(stubs.generateFindingsCalls).toHaveLength(0)
      expect(stubs.readChangedFilesCalls).toHaveLength(0)
      expect(stubs.submitReviewCalls).toHaveLength(1)
      expect(first(stubs.submitReviewCalls)).toEqual({
        prNumber: fixturePrContext.prNumber,
        commitId: fixturePrContext.headSha,
        body: buildSkipBody({
          reason: skipReason,
          detail: [
            "- src/greeter.ts (+4/-1, diff_exclude_paths input)",
            "- src/added-file.ts (+3/-0, diff_exclude_paths input)",
            "- src/removed-file.ts (+0/-3, diff_exclude_paths input)",
            "- src/new-name.ts (+1/-1, diff_exclude_paths input)",
            "- assets/logo.png (+0/-0, diff_exclude_paths input)",
            "- src/no-trailing-newline.ts (+1/-1, diff_exclude_paths input)",
          ].join("\n"),
        }),
      })
    })

    it("attributes the all-excluded skip to the default list when no operator pattern is set", async () => {
      const stubs = makeOrchestrateDeps({
        config: {
          diffExcludePaths: {
            defaultPatterns: ["src/**", "assets/**"],
            diffExcludePathPatterns: [],
          },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.skippedReason).toBe(
        "all 6 changed file(s) excluded from review (6 by built-in default list)",
      )
    })

    it("removes an excluded file from the annotated diff, context reads, and changed paths", async () => {
      const stubs = makeOrchestrateDeps({
        config: {
          diffExcludePaths: {
            defaultPatterns: [],
            diffExcludePathPatterns: ["assets/**"],
          },
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      const keptFiles = fixtureFiles.filter((file) => (file.to ?? file.from) !== "assets/logo.png")
      const expectedExcludedNote = [
        "1 changed file(s) excluded from review (content not shown):",
        "- assets/logo.png (+0/-0, diff_exclude_paths input)",
      ].join("\n")
      const reviewContext = first(stubs.generateFindingsCalls)
      expect(reviewContext.annotatedDiff).toBe(
        `${annotateDiff(keptFiles)}\n\n${expectedExcludedNote}`,
      )
      expect(first(stubs.readChangedFilesCalls).changedPaths).toEqual([
        "src/greeter.ts",
        "src/added-file.ts",
        "src/new-name.ts",
        "src/old-name.ts",
        "src/no-trailing-newline.ts",
      ])
    })

    it("adds a context note naming diff-excluded files and their source", async () => {
      const stubs = makeOrchestrateDeps({
        config: {
          diffExcludePaths: {
            defaultPatterns: [],
            diffExcludePathPatterns: ["assets/**"],
          },
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
            "1 changed file(s) excluded from review: `assets/logo.png` (diff_exclude_paths input)",
          ],
        }),
      ])
    })

    it("drops a diff-excluded priority doc from the priority-doc read", async () => {
      const stubs = makeOrchestrateDeps({
        config: {
          priorityDocs: ["assets/logo.png", "docs/guide.md"],
          diffExcludePaths: {
            defaultPatterns: [],
            diffExcludePathPatterns: ["assets/**"],
          },
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(first(stubs.readPriorityDocsCalls).priorityDocs).toEqual(["docs/guide.md"])
    })

    it("passes diff-excluded paths to the related-file and doc scans as exclusions", async () => {
      const stubs = makeOrchestrateDeps({
        config: {
          diffExcludePaths: {
            defaultPatterns: [],
            diffExcludePathPatterns: ["assets/**"],
          },
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(first(stubs.findRelatedFilesCalls).excludePaths).toEqual([
        "assets/logo.png",
        "AGENTS.md",
      ])
      expect(first(stubs.findRelatedDocsCalls).excludePaths).toEqual(["assets/logo.png"])
    })

    it("normalizes a doubled-slash excluded diff path before matching priority docs and scan exclusions", async () => {
      // Orchestrate compares excluded paths to priority docs as received, so
      // this fails if partitioning ever stops normalizing them
      const unnormalizedPathDiff = `diff --git a/assets//guide.md b/assets//guide.md
index 1111111..2222222 100644
--- a/assets//guide.md
+++ b/assets//guide.md
@@ -1 +1 @@
-old guide
+new guide
diff --git a/src/app.ts b/src/app.ts
index 3333333..4444444 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old line
+new line
`
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchDiff: async () => ({ kind: "ok" as const, diff: unnormalizedPathDiff }),
        },
        config: {
          priorityDocs: ["assets/guide.md", "docs/guide.md"],
          diffExcludePaths: {
            defaultPatterns: [],
            diffExcludePathPatterns: ["assets/**"],
          },
        },
      })

      await orchestrate(stubs.deps, createTestLogger())

      expect(first(stubs.readPriorityDocsCalls).priorityDocs).toEqual(["docs/guide.md"])
      expect(first(stubs.findRelatedFilesCalls).excludePaths).toEqual(["assets/guide.md"])
    })

    it("passes the budget check when the oversized files are all excluded", async () => {
      // Budget 220 (half = 110) fails against the full fixture diff (341
      // tokens); with every src/ file excluded only the binary asset header
      // and the excluded-files trailer remain (101 tokens), which fit
      const stubs = makeOrchestrateDeps({
        config: {
          contextBudgetTokens: 220,
          diffExcludePaths: {
            defaultPatterns: [],
            diffExcludePathPatterns: ["src/**"],
          },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      // Guard for bar 2: the unfiltered fixture diff must exceed the half
      // budget, or this test would pass without the exclusion doing anything
      expect(sampleDiffTokens).toBeGreaterThan(110)
      expect(result.skippedReason).toBe("")
      expect(stubs.generateFindingsCalls).toHaveLength(1)
    })

    it("drops a finding naming an excluded file via the unknown-file filter", async () => {
      const excludedFileFinding = makeFinding({
        file: "assets/logo.png",
        line: 1,
      })
      const stubs = makeOrchestrateDeps({
        config: {
          diffExcludePaths: {
            defaultPatterns: [],
            diffExcludePathPatterns: ["assets/**"],
          },
        },
        fixtureResult: {
          review: { ...fixtureReviewResponse, findings: [excludedFileFinding] },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(0)
      expect(stubs.postFindingsReviewCalls).toHaveLength(0)
      expect(logsWithMessage(logger, "dropping finding: file not in prompt context")).toEqual([
        {
          level: "warn",
          message: "dropping finding: file not in prompt context",
          data: {
            phase: "combined",
            file: "assets/logo.png",
            line: 1,
            category: excludedFileFinding.category,
          },
        },
      ])
    })

    it("excludes files the repo marks linguist-generated", async () => {
      const stubs = makeOrchestrateDeps({
        contextReader: {
          readGitAttributes: async () => "assets/* linguist-generated=true\n",
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      const keptFiles = fixtureFiles.filter((file) => (file.to ?? file.from) !== "assets/logo.png")
      const expectedExcludedNote = [
        "1 changed file(s) excluded from review (content not shown):",
        "- assets/logo.png (+0/-0, linguist-generated attribute)",
      ].join("\n")
      expect(first(stubs.generateFindingsCalls).annotatedDiff).toBe(
        `${annotateDiff(keptFiles)}\n\n${expectedExcludedNote}`,
      )
    })

    it("does not read gitattributes when respect_linguist_generated is off", async () => {
      const readGitAttributesCalls: unknown[] = []
      const stubs = makeOrchestrateDeps({
        config: { respectLinguistGenerated: false },
        contextReader: {
          readGitAttributes: async () => {
            readGitAttributesCalls.push({})
            return "assets/* linguist-generated=true\n"
          },
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(readGitAttributesCalls).toHaveLength(0)
      expect(first(stubs.generateFindingsCalls).annotatedDiff).toBe(annotateDiff(fixtureFiles))
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
        phases: [{ phase: "combined", status: "completed" }],
        reviewSummaryMarkdown: expectedReviewSummary(),
        costSummaryMarkdown: expectedCostSummary,
        conventionsNote: null,
      })

      const expectedReview = expectedFindingsReview(expectedSelection.selected)

      expect(stubs.submitReviewCalls).toHaveLength(0)
      expect(stubs.postFindingsReviewCalls).toEqual([expectedReview])
      expect(logsWithMessage(logger, "findings review posted")).toEqual([
        {
          level: "info",
          message: "findings review posted",
          data: {
            reviewUrl: "https://github.com/test/review/1",
            inlineCount: expectedReview.comments.length,
            locations: expectedReview.comments.map((comment) => `${comment.path}:${comment.line}`),
          },
        },
      ])
      expect(stubs.postIssueCommentCalls).toEqual(
        expectedMapped.standaloneFindings.map((finding) => ({
          prNumber: fixturePrContext.prNumber,
          body: renderBeyondDiffFinding(finding),
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

    it("passes the configured conventions file path to generateFindings", async () => {
      const stubs = makeOrchestrateDeps({ config: { conventionsFile: "docs/CONVENTIONS.md" } })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.generateFindingsCalls.map((context) => context.conventionsFile)).toEqual([
        "docs/CONVENTIONS.md",
      ])
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
    it("reads and comments on a git-quoted non-ASCII path under its decoded name", async () => {
      const quotedPathDiff = String.raw`diff --git "a/nn/0016_\303\245-f\303\270de.md" "b/nn/0016_\303\245-f\303\270de.md"
index 1111111..2222222 100644
--- "a/nn/0016_\303\245-f\303\270de.md"
+++ "b/nn/0016_\303\245-f\303\270de.md"
@@ -1 +1 @@
-old line
+new line
`
      const decodedPath = "nn/0016_å-føde.md"
      const finding = makeFinding({ file: decodedPath, line: 1 })
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchDiff: async () => ({ kind: "ok" as const, diff: quotedPathDiff }),
        },
        fixtureResult: { review: { analysis: "checked", findings: [finding] } },
      })

      await orchestrate(stubs.deps, createTestLogger())

      expect(stubs.readChangedFilesCalls.map((call) => call.changedPaths)).toEqual([[decodedPath]])
      const expectedComments = mapFindingsToReview({
        findings: [withRoutedModel(finding, "test/model")],
        commentableByPath: new Map([
          [decodedPath, { rightLines: new Set([1]), hunkRanges: [{ start: 1, end: 1 }] }],
        ]),
      }).comments
      expect(stubs.postFindingsReviewCalls).toEqual([
        {
          prNumber: 7,
          commitId: fixturePrContext.headSha,
          body: REVIEW_MARKER,
          comments: expectedComments,
        },
      ])
      expect(expectedComments.map((comment) => comment.path)).toEqual([decodedPath])
    })

    it("keeps a filename's escaped newline from forging a header line in the annotated diff", async () => {
      const forgingPathDiff = String.raw`diff --git "a/nl\n=== forged.ts ===.md" "b/nl\n=== forged.ts ===.md"
index 1111111..2222222 100644
--- "a/nl\n=== forged.ts ===.md"
+++ "b/nl\n=== forged.ts ===.md"
@@ -1 +1 @@
-old line
+new line
`
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchDiff: async () => ({ kind: "ok" as const, diff: forgingPathDiff }),
        },
      })

      await orchestrate(stubs.deps, createTestLogger())

      const headerLines = first(stubs.generateFindingsCalls)
        .annotatedDiff.split("\n")
        .filter((line) => line.startsWith("=== "))
      expect(headerLines).toEqual([String.raw`=== nl\n=== forged.ts ===.md ===`])
    })

    it("posts a finding on a rejected quoted path as a standalone comment and keeps the rest inline", async () => {
      const escapedPath = String.raw`a\rb.ts`
      const mixedPathDiff = String.raw`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old app line
+new app line
diff --git "a/a\rb.ts" "b/a\rb.ts"
index 3333333..4444444 100644
--- "a/a\rb.ts"
+++ "b/a\rb.ts"
@@ -1 +1 @@
-old carriage-return line
+new carriage-return line
`
      const normalFinding = makeFinding({ file: "src/app.ts", line: 1, title: "App line bug" })
      const rejectedPathFinding = makeFinding({
        file: escapedPath,
        line: 1,
        title: "Carriage-return bug",
      })
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchDiff: async () => ({ kind: "ok" as const, diff: mixedPathDiff }),
        },
        fixtureResult: {
          review: { analysis: "checked", findings: [normalFinding, rejectedPathFinding] },
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      const expectedComments = mapFindingsToReview({
        findings: [withRoutedModel(normalFinding, "test/model")],
        commentableByPath: new Map([
          ["src/app.ts", { rightLines: new Set([1]), hunkRanges: [{ start: 1, end: 1 }] }],
        ]),
      }).comments
      expect(stubs.postFindingsReviewCalls).toEqual([
        {
          prNumber: 7,
          commitId: fixturePrContext.headSha,
          body: REVIEW_MARKER,
          comments: expectedComments,
        },
      ])
      expect(expectedComments.map((comment) => comment.path)).toEqual(["src/app.ts"])
      expect(stubs.postIssueCommentCalls).toEqual([
        {
          prNumber: 7,
          body: renderRejectedPathFinding(withRoutedModel(rejectedPathFinding, "test/model")),
        },
      ])
      expect(
        logsWithMessage(
          logger,
          "file left out of inline comments because its diff path was rejected",
        ),
      ).toEqual([
        {
          level: "debug",
          message: "file left out of inline comments because its diff path was rejected",
          data: { path: escapedPath },
        },
      ])
    })

    it("keeps a priority doc in the rendered prompt when changed files use the rest of the budget", async () => {
      const priorityDocContent = "# Review reference\nCheck API behavior."
      const priorityDocTokens = estimateTokens(priorityDocContent)
      const priorityDoc: PromptFile = {
        path: "docs/reference.md",
        content: priorityDocContent,
        includedAs: "full",
        reason: "priority documentation",
      }
      const readChangedFilesCalls: ReadChangedFilesParams[] = []
      const readPriorityDocsCalls: ReadPriorityDocsParams[] = []
      const stubs = makeOrchestrateDeps({
        config: { priorityDocs: [priorityDoc.path] },
        contextReader: {
          readChangedFiles: async (params) => {
            readChangedFilesCalls.push(params)
            return {
              files: [
                {
                  path: fixtureChangedFile.path,
                  content: "x".repeat(params.budgetTokens * 4),
                  includedAs: "full",
                },
              ],
              remainingTokens: 0,
            }
          },
          readPriorityDocs: async (params) => {
            readPriorityDocsCalls.push(params)
            if (
              params.excludePaths.includes(priorityDoc.path) ||
              params.budgetTokens < priorityDocTokens
            ) {
              return { files: [], remainingTokens: params.budgetTokens }
            }
            return {
              files: [priorityDoc],
              remainingTokens: params.budgetTokens - priorityDocTokens,
            }
          },
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      const reviewContext = first(stubs.generateFindingsCalls)
      const prompt = buildUserPrompt({
        ...reviewContext,
        delimiterNonce: "testnonce123",
      })
      expect(reviewContext.relatedDocs).toEqual([priorityDoc])
      expect(prompt.split(priorityDocContent)).toHaveLength(2)
      expect(first(readPriorityDocsCalls).budgetTokens).toBe(8_000)
      expect(first(readChangedFilesCalls).budgetTokens).toBe(
        baseConfig.contextBudgetTokens - sampleDiffTokens - priorityDocTokens,
      )
    })

    it("returns an unused early doc floor to changed files", async () => {
      const stubs = makeOrchestrateDeps({
        config: { priorityDocs: ["MISSING.md"] },
      })

      await orchestrate(stubs.deps, createTestLogger())

      expect(stubs.readPriorityDocsCalls.map((call) => call.budgetTokens)).toEqual([8_000, 40_000])
      expect(first(stubs.readChangedFilesCalls).budgetTokens).toBe(
        baseConfig.contextBudgetTokens - sampleDiffTokens,
      )
    })

    it("gives unchanged priority docs first use of the floor when a listed doc changed", async () => {
      const changedDoc: PromptFile = {
        path: fixtureChangedFile.path,
        content: "c".repeat(16_000),
        includedAs: "full",
      }
      const unchangedDoc: PromptFile = {
        path: "docs/reference.md",
        content: "u".repeat(20_000),
        includedAs: "full",
        reason: "priority documentation",
      }
      const readPriorityDocsCalls: ReadPriorityDocsParams[] = []
      const stubs = makeOrchestrateDeps({
        config: { priorityDocs: [changedDoc.path, unchangedDoc.path] },
        contextReader: {
          readPriorityDocs: async (params) => {
            readPriorityDocsCalls.push(params)
            const firstPath = first(params.priorityDocs)
            const selectedDoc = firstPath === unchangedDoc.path ? unchangedDoc : changedDoc
            const selectedTokens = estimateTokens(selectedDoc.content)

            if (selectedTokens > params.budgetTokens) {
              return { files: [], remainingTokens: params.budgetTokens }
            }
            return {
              files: [selectedDoc],
              remainingTokens: params.budgetTokens - selectedTokens,
            }
          },
          readChangedFiles: async (params) => {
            const changedWasReadEarly = params.diffOnlyPaths.includes(changedDoc.path)
            return {
              files: [
                changedWasReadEarly
                  ? {
                      path: changedDoc.path,
                      content: "",
                      includedAs: "diff-only",
                    }
                  : changedDoc,
              ],
              remainingTokens: 4_000,
            }
          },
        },
      })

      await orchestrate(stubs.deps, createTestLogger())

      expect(first(readPriorityDocsCalls).priorityDocs).toEqual([
        unchangedDoc.path,
        changedDoc.path,
      ])
      const reviewContext = first(stubs.generateFindingsCalls)
      expect(reviewContext.changedFiles).toEqual([changedDoc])
      expect(reviewContext.relatedDocs).toEqual([unchangedDoc])
      const prompt = buildUserPrompt({
        ...reviewContext,
        delimiterNonce: "testnonce123",
      })
      expect(prompt.split(changedDoc.content)).toHaveLength(2)
      expect(prompt.split(unchangedDoc.content)).toHaveLength(2)
    })

    it("renders an early-read changed priority doc only once", async () => {
      const changedDoc: PromptFile = {
        path: fixtureChangedFile.path,
        content: "export const reviewed = true",
        includedAs: "full",
        reason: "priority documentation",
      }
      const readChangedFilesCalls: ReadChangedFilesParams[] = []
      const stubs = makeOrchestrateDeps({
        config: { priorityDocs: [changedDoc.path] },
        contextReader: {
          readPriorityDocs: async (params) => ({
            files: [changedDoc],
            remainingTokens: params.budgetTokens - estimateTokens(changedDoc.content),
          }),
          readChangedFiles: async (params) => {
            readChangedFilesCalls.push(params)
            const isDiffOnly = params.diffOnlyPaths.includes(changedDoc.path)
            return {
              files: [
                {
                  path: changedDoc.path,
                  content: isDiffOnly ? "" : changedDoc.content,
                  includedAs: isDiffOnly ? "diff-only" : "full",
                },
              ],
              remainingTokens: params.budgetTokens,
            }
          },
        },
      })

      await orchestrate(stubs.deps, createTestLogger())

      expect(first(readChangedFilesCalls).diffOnlyPaths).toEqual(["AGENTS.md", changedDoc.path])
      const reviewContext = first(stubs.generateFindingsCalls)
      expect(reviewContext.changedFiles).toEqual([
        { path: changedDoc.path, content: "", includedAs: "diff-only" },
      ])
      expect(reviewContext.relatedDocs).toEqual([changedDoc])
      const prompt = buildUserPrompt({
        ...reviewContext,
        delimiterNonce: "testnonce123",
      })
      expect(prompt.split(changedDoc.content)).toHaveLength(2)
    })

    it("does not reserve or read a priority doc already fully rendered as conventions", async () => {
      const stubs = makeOrchestrateDeps({
        config: { priorityDocs: ["AGENTS.md"] },
      })

      await orchestrate(stubs.deps, createTestLogger())

      expect(stubs.readPriorityDocsCalls).toEqual([])
      expect(first(stubs.findRelatedFilesCalls).budgetTokens).toBe(40_000)
      expect(first(stubs.generateFindingsCalls).relatedDocs).toEqual([])
    })

    it("matches a fully rendered conventions file to its priority doc across a ./ prefix", async () => {
      const stubs = makeOrchestrateDeps({
        config: { conventionsFile: "./AGENTS.md", priorityDocs: ["AGENTS.md"] },
      })

      await orchestrate(stubs.deps, createTestLogger())

      expect(stubs.readPriorityDocsCalls).toEqual([])
      expect(first(stubs.findRelatedFilesCalls).budgetTokens).toBe(40_000)
      expect(first(stubs.generateFindingsCalls).relatedDocs).toEqual([])
    })

    it("keeps an early priority doc out of the related-file scan", async () => {
      const priorityDoc: PromptFile = {
        path: "src/caller.ts",
        content: "import { greet } from './greeter.js'",
        includedAs: "full",
        reason: "priority documentation",
      }
      const relatedFileCalls: FindRelatedFilesParams[] = []
      const stubs = makeOrchestrateDeps({
        config: { priorityDocs: [priorityDoc.path] },
        contextReader: {
          readPriorityDocs: async (params) => ({
            files: [priorityDoc],
            remainingTokens: params.budgetTokens - estimateTokens(priorityDoc.content),
          }),
          findRelatedFiles: async (params) => {
            relatedFileCalls.push(params)
            return {
              files: params.excludePaths.includes(priorityDoc.path) ? [] : [priorityDoc],
              excludedByCapPaths: [],
            }
          },
        },
      })

      await orchestrate(stubs.deps, createTestLogger())

      expect(relatedFileCalls.map((call) => call.excludePaths)).toEqual([
        [priorityDoc.path, "AGENTS.md"],
      ])
      const reviewContext = first(stubs.generateFindingsCalls)
      expect(reviewContext.relatedFiles).toEqual([])
      expect(reviewContext.relatedDocs).toEqual([priorityDoc])
      const prompt = buildUserPrompt({
        ...reviewContext,
        delimiterNonce: "testnonce123",
      })
      expect(prompt.split(priorityDoc.content)).toHaveLength(2)
    })

    it("restores configured doc order when a larger doc fits only in the late pass", async () => {
      const firstDoc: PromptFile = {
        path: "docs/first.md",
        content: "a".repeat(16_000),
        includedAs: "full",
        reason: "priority documentation",
      }
      const middleDoc: PromptFile = {
        path: "docs/middle.md",
        content: "b".repeat(20_000),
        includedAs: "full",
        reason: "priority documentation",
      }
      const lastDoc: PromptFile = {
        path: "docs/last.md",
        content: "c".repeat(8_000),
        includedAs: "full",
        reason: "priority documentation",
      }
      const readPriorityDocsCalls: ReadPriorityDocsParams[] = []
      const stubs = makeOrchestrateDeps({
        config: {
          priorityDocs: [firstDoc.path, middleDoc.path, lastDoc.path],
        },
        contextReader: {
          readChangedFiles: async () => ({
            files: [fixtureChangedFile],
            remainingTokens: 10_000,
          }),
          readPriorityDocs: async (params) => {
            readPriorityDocsCalls.push(params)
            if (readPriorityDocsCalls.length === 1) {
              return {
                files: [firstDoc, lastDoc],
                remainingTokens: params.budgetTokens - 6_000,
              }
            }
            return {
              files: [middleDoc],
              remainingTokens: params.budgetTokens - 5_000,
            }
          },
        },
      })

      await orchestrate(stubs.deps, createTestLogger())

      expect(readPriorityDocsCalls.map((call) => call.budgetTokens)).toEqual([8_000, 10_000])
      expect(first(stubs.findRelatedFilesCalls).budgetTokens).toBe(8_000)
      expect(first(stubs.generateFindingsCalls).relatedDocs).toEqual([firstDoc, middleDoc, lastDoc])
    })

    it("fails the check when an early priority-doc read reaches the review deadline", async () => {
      const operations: string[] = []
      // The first priority-doc read advances this test's controllable deadline.
      const deadline = { remainingMs: 1 }
      const stubs = makeOrchestrateDeps({
        config: { priorityDocs: ["README.md"] },
        remainingReviewMs: () => deadline.remainingMs,
        contextReader: {
          readPriorityDocs: async (params) => {
            operations.push("read priority docs")
            deadline.remainingMs = 0
            return { files: [], remainingTokens: params.budgetTokens }
          },
          readChangedFiles: async (params) => {
            operations.push("read changed files")
            return {
              files: params.changedPaths.map((path) => ({
                path,
                content: "",
                includedAs: "diff-only" as const,
              })),
              remainingTokens: params.budgetTokens,
            }
          },
        },
      })

      await expect(orchestrate(stubs.deps, createTestLogger())).rejects.toThrow(
        "every review phase failed: combined: [Error]: not attempted: review deadline exceeded",
      )

      expect(operations.slice(0, 2)).toEqual(["read priority docs", "read changed files"])
      expect(stubs.generateFindingsCalls).toEqual([])
      expect(stubs.postFindingsReviewCalls).toEqual([])
      expect(stubs.upsertSummaryCommentCalls).toEqual([])
      expect(stubs.updateCheckRunCalls).toEqual([
        {
          checkRunId: 555,
          conclusion: "failure",
          output: {
            title: "Error — review did not complete",
            summary:
              "[AllPhasesFailedError]: every review phase failed: combined: [Error]: not attempted: review deadline exceeded",
          },
        },
      ])
    })

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
      expect(call.budgetTokens).toBe(baseConfig.contextBudgetTokens - sampleDiffTokens)
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

    it("passes readChangedFiles each new path plus a rename's old path, and no deleted path", async () => {
      const stubs = makeOrchestrateDeps()
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      // The fixture diff deletes src/removed-file.ts, so that path is absent.
      // It renames src/old-name.ts to src/new-name.ts, so both paths appear
      expect(stubs.readChangedFilesCalls.map((call) => call.changedPaths)).toEqual([
        [
          "src/greeter.ts",
          "src/added-file.ts",
          "src/new-name.ts",
          "src/old-name.ts",
          "assets/logo.png",
          "src/no-trailing-newline.ts",
        ],
      ])
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
      expect(call.budgetTokens).toBe(expectedRemainingTokens - relatedFileTokens)
    })

    it("passes conventionsFile to findRelatedDocs for exclusion", async () => {
      const stubs = makeOrchestrateDeps({
        config: { traceRelatedFiles: true, conventionsFile: "CUSTOM.md" },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.findRelatedDocsCalls).toHaveLength(1)
      expect(first(stubs.findRelatedDocsCalls).conventionsFile).toBe("CUSTOM.md")
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
      expect(first(stubs.findRelatedDocsCalls).excludePaths).toEqual(["README.md", "CHANGELOG.md"])
    })

    it("clamps doc budget to zero when related files exhaust remaining tokens", async () => {
      const largeRelatedFileContent = "x".repeat(100)
      const largeRelatedFileTokens = estimateTokens(largeRelatedFileContent)
      const localPriorityDocsCalls: ReadPriorityDocsParams[] = []
      const stubs = makeOrchestrateDeps({
        config: { traceRelatedFiles: true, priorityDocs: ["README.md"] },
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

      expect(localPriorityDocsCalls).toHaveLength(2)
      // remainingTokens (10) < relatedFilesTokens (25) → Math.max(0, -15) = 0
      expect(localPriorityDocsCalls.map((call) => call.budgetTokens)).toEqual([8_000, 0])
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
      expect(first(localDocCalls).budgetTokens).toBe(expectedRemainingTokens)
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
          contextNotes: ["1 related doc(s) excluded by `max_related_docs` cap: `docs/overflow.md`"],
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

    it("omits a priority doc already in context as a changed file", async () => {
      // Reproduces vault-cortex PR #397: the doc budget is exhausted, so the
      // priority-doc read returns nothing — but README.md is already in full
      // context as a changed file and must not be reported as missing.
      const stubs = makeOrchestrateDeps({
        config: { priorityDocs: ["README.md", "MISSING.md"] },
        contextReader: {
          readChangedFiles: async () => ({
            files: [
              {
                path: "README.md",
                content: "# Readme",
                includedAs: "full" as const,
              },
            ],
            remainingTokens: 0,
          }),
          readPriorityDocs: async (params) => ({
            files: [],
            remainingTokens: params.budgetTokens,
          }),
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: expectedSelection.selected.length,
          totalCount: expectedSelection.selected.length,
          contextNotes: [
            "Priority docs already in context: `README.md`",
            "Priority docs not included: `MISSING.md` (missing, unreadable, or over budget)",
          ],
        }),
      ])
      // The job summary carries the same split so an operator reading the
      // check run sees why "Priority docs" is 0 without opening the PR.
      expect(result.reviewSummaryMarkdown).toBe(
        expectedReviewSummary({
          changedFilePaths: ["README.md"],
          priorityDocsInContextPaths: ["README.md"],
          priorityDocsAbsentPaths: ["MISSING.md"],
          tokenBudgetRemainingForDocs: 0,
        }),
      )
    })

    it("does not exclude a diff-only changed file from the priority-doc read", async () => {
      // A diff-only changed file sent only diff hunks — its full text is not
      // in the prompt. maxScanBytes (per-file) and the priority-doc budget
      // (total remaining) are different caps, so the file may still fit here.
      // Excluding it would silently suppress a genuine absence.
      const stubs = makeOrchestrateDeps({
        config: { priorityDocs: ["README.md"] },
        contextReader: {
          readChangedFiles: async () => ({
            files: [
              {
                path: "README.md",
                content: "",
                includedAs: "diff-only" as const,
              },
            ],
            remainingTokens: 0,
          }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.readPriorityDocsCalls.map((call) => call.excludePaths)).toEqual([
        [],
        ["AGENTS.md"],
      ])
    })

    it("excludes changed files, related files, and conventions from the priority-doc read", async () => {
      const stubs = makeOrchestrateDeps({
        config: {
          traceRelatedFiles: true,
          conventionsFile: "AGENTS.md",
          priorityDocs: ["README.md"],
        },
        contextReader: {
          findRelatedFiles: async () => ({
            files: [
              {
                path: "src/caller.ts",
                content: "import { greet } from './greeter.js'",
                includedAs: "full" as const,
              },
            ],
            excludedByCapPaths: [],
          }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.readPriorityDocsCalls.map((call) => call.excludePaths)).toEqual([
        [],
        ["src/greeter.ts", "src/caller.ts", "AGENTS.md"],
      ])
    })

    it("renders a changed conventions file diff-only when its own section carries it whole", async () => {
      const stubs = makeOrchestrateDeps({
        config: { conventionsFile: "AGENTS.md" },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(first(stubs.readChangedFilesCalls).diffOnlyPaths).toEqual(["AGENTS.md"])
    })

    it("renders a changed conventions file diff-only when a raised budget fits the file", async () => {
      const stubs = makeOrchestrateDeps({
        config: {
          conventionsFile: "AGENTS.md",
          conventionsBudgetTokens: 16_000,
        },
        contextReader: {
          readConventions: async () => "c".repeat(32_001),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(first(stubs.readChangedFilesCalls).diffOnlyPaths).toEqual(["AGENTS.md"])
    })

    it("keeps a changed conventions file full when its own section is truncated", async () => {
      // Over the 8k-token conventions cap: the conventions section holds only
      // a truncated head, so the changed-files copy is the sole full text and
      // demoting it would lose the tail.
      const stubs = makeOrchestrateDeps({
        config: { conventionsFile: "AGENTS.md" },
        contextReader: {
          readConventions: async () => "c".repeat(32_001),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(first(stubs.readChangedFilesCalls).diffOnlyPaths).toEqual([])
    })

    it("omits the conventions file from the priority-doc exclusions when its section is truncated", async () => {
      // Over the 8k-token cap: the conventions section carries only a
      // truncated head, so its full text was never sent. Excluding it from the
      // priority-doc read would drop the tail silently — the priority-doc
      // channel is the one that can still supply it.
      const stubs = makeOrchestrateDeps({
        config: { conventionsFile: "AGENTS.md", priorityDocs: ["AGENTS.md"] },
        contextReader: {
          readConventions: async () => "c".repeat(32_001),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.readPriorityDocsCalls.map((call) => call.excludePaths)).toEqual([
        [],
        ["src/greeter.ts"],
      ])
    })

    it("keeps a conventions file its own section carries whole out of the related-file scan", async () => {
      // A JS/TS conventions file that imports a changed file is a related-file
      // candidate. Its section already sends the whole text, so a related-file
      // block would send it a second time.
      const conventionsImporter: PromptFile = {
        path: "conventions.ts",
        content: "import { greet } from './src/greeter.js'",
        includedAs: "full",
        reason: "imports src/greeter.ts",
      }
      const relatedFileCalls: FindRelatedFilesParams[] = []
      const stubs = makeOrchestrateDeps({
        config: { conventionsFile: conventionsImporter.path },
        contextReader: {
          readConventions: async () => conventionsImporter.content,
          findRelatedFiles: async (params) => {
            relatedFileCalls.push(params)
            return {
              files: params.excludePaths.includes(conventionsImporter.path)
                ? []
                : [conventionsImporter],
              excludedByCapPaths: [],
            }
          },
        },
      })

      await orchestrate(stubs.deps, createTestLogger())

      expect(relatedFileCalls.map((call) => call.excludePaths)).toEqual([
        [conventionsImporter.path],
      ])
      expect(first(stubs.generateFindingsCalls).relatedFiles).toEqual([])
    })

    it("leaves a truncated conventions file eligible for the related-file scan", async () => {
      // Over the 8k-token cap the section holds only a head, so a related-file
      // block is the one channel that can still send the whole text.
      const stubs = makeOrchestrateDeps({
        config: { conventionsFile: "conventions.ts" },
        contextReader: {
          readConventions: async () => "c".repeat(32_001),
        },
      })

      await orchestrate(stubs.deps, createTestLogger())

      expect(stubs.findRelatedFilesCalls.map((call) => call.excludePaths)).toEqual([[]])
    })

    it("excludes an over-cap conventions file from priority docs when it is changed in the PR", async () => {
      // Over the 8k-token cap + changed + in priority_docs: the changed-files
      // channel keeps the full copy (conventions section truncates), and the
      // priority-doc channel skips via the changed-files path in
      // priorityDocsInContext — one full copy, no double-render. The
      // conventions contribution to priorityDocsInContext is absent (over-cap),
      // but the changed-files contribution supplies it.
      const stubs = makeOrchestrateDeps({
        config: { conventionsFile: "AGENTS.md", priorityDocs: ["AGENTS.md"] },
        contextReader: {
          readConventions: async () => "c".repeat(32_001),
          readChangedFiles: async () => ({
            files: [
              fixtureChangedFile,
              {
                path: "AGENTS.md",
                content: "c".repeat(32_001),
                includedAs: "full" as const,
              },
            ],
            remainingTokens: 10_000,
          }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.readPriorityDocsCalls.map((call) => call.excludePaths)).toEqual([[]])
      expect(first(stubs.generateFindingsCalls).changedFiles).toEqual([
        fixtureChangedFile,
        {
          path: "AGENTS.md",
          content: "c".repeat(32_001),
          includedAs: "full",
        },
      ])
      expect(first(stubs.generateFindingsCalls).relatedDocs).toEqual([])
    })

    it("suppresses the truncated conventions section when priority docs read the full file", async () => {
      // Over-cap conventions + listed in priority_docs + not excluded from
      // readPriorityDocs (because conventionsAlreadyRenderedInFull is false).
      // Priority docs read it in full → the truncated conventions section is
      // suppressed to avoid 8K tokens of redundant content.
      const overCapConventions = "c".repeat(32_001)
      const stubs = makeOrchestrateDeps({
        config: { conventionsFile: "AGENTS.md", priorityDocs: ["AGENTS.md"] },
        contextReader: {
          readConventions: async () => overCapConventions,
          readPriorityDocs: async () => ({
            files: [
              {
                path: "AGENTS.md",
                content: overCapConventions,
                includedAs: "full" as const,
              },
            ],
            remainingTokens: 0,
          }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      const reviewContext = first(stubs.generateFindingsCalls)
      expect(reviewContext.conventions).toBe(
        "(conventions file included in full as priority documentation below — ground convention findings in that copy)",
      )
    })

    it("keeps the conventions section when priority docs do not read the file", async () => {
      // Over-cap conventions + NOT in priority_docs → priority docs don't read
      // it, so the truncated conventions section is the only copy. Keep it.
      const overCapConventions = "c".repeat(32_001)
      const stubs = makeOrchestrateDeps({
        config: { conventionsFile: "AGENTS.md", priorityDocs: ["README.md"] },
        contextReader: {
          readConventions: async () => overCapConventions,
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      const reviewContext = first(stubs.generateFindingsCalls)
      expect(reviewContext.conventions).toBe(overCapConventions)
    })

    describe("truncation reporting", () => {
      // The default 8000-token cap is 32,000 characters; one more truncates
      const overCapConventions = "c".repeat(32_001)
      const truncationWarning = "conventions file truncated with no full copy in context"
      const noCopyNote =
        "Conventions file `AGENTS.md` was truncated to its first 32000 of 32001 characters, and no full copy reached the model — raise `conventions_budget_tokens` or list the file in `priority_docs`."
      const listedNoCopyNote =
        "Conventions file `AGENTS.md` was truncated to its first 32000 of 32001 characters, and no full copy reached the model — raise `conventions_budget_tokens`; the file is listed in `priority_docs` but did not fit or was excluded."
      const crossingNote =
        "Conventions file `AGENTS.md` exceeds `conventions_budget_tokens` (32001 characters against a 32000-character cap) — this PR carried the full text, but later PRs that change neither it nor a file it imports will see only the first 32000 characters."
      const conventionsLine = (reviewSummaryMarkdown: string | null): string | undefined => {
        return reviewSummaryMarkdown?.split("\n")[4]
      }
      const expectedCheckSummary = (note: string | null): string => {
        const noteSection = note ? `\n\n${note}` : ""
        return `Reviewed with \`test/model\` — ${expectedSelection.selected.length} findings posted.${noteSection}\n\n${expectedCostSummary}`
      }

      it("warns and reports on every surface when no channel carried the full file", async () => {
        const stubs = makeOrchestrateDeps({
          config: { conventionsFile: "AGENTS.md", priorityDocs: [] },
          contextReader: { readConventions: async () => overCapConventions },
        })
        const logger = createTestLogger()

        const result = await orchestrate(stubs.deps, logger)

        expect(first(stubs.generateFindingsCalls).conventions).toBe(overCapConventions)
        expect(logsWithMessage(logger, truncationWarning)).toEqual([
          {
            level: "warn",
            message: truncationWarning,
            data: {
              conventionsFile: "AGENTS.md",
              conventionsCharacters: 32_001,
              conventionsCharacterCap: 32_000,
            },
          },
        ])
        expect(stubs.upsertSummaryCommentCalls).toEqual([
          expectedStatus({
            isFirstRun: true,
            postedCount: expectedSelection.selected.length,
            totalCount: expectedSelection.selected.length,
            conventionsNote: noCopyNote,
          }),
        ])
        expect(conventionsLine(result.reviewSummaryMarkdown)).toBe(
          "**Conventions:** AGENTS.md (truncated to 32000 of 32001 characters; no full copy reached the model)",
        )
        expect(result.conventionsNote).toBe(noCopyNote)
        expect(first(stubs.updateCheckRunCalls).output).toEqual({
          title: `${expectedSelection.selected.length} findings`,
          summary: expectedCheckSummary(noCopyNote),
        })
      })

      it("stays quiet when an early priority-doc read carried the full file", async () => {
        const stubs = makeOrchestrateDeps({
          config: { conventionsFile: "AGENTS.md", priorityDocs: ["AGENTS.md"] },
          contextReader: {
            readConventions: async () => overCapConventions,
            readPriorityDocs: async (params) => ({
              files: [
                { path: "AGENTS.md", content: overCapConventions, includedAs: "full" as const },
              ],
              remainingTokens: params.budgetTokens - 8001,
            }),
          },
        })
        const logger = createTestLogger()

        const result = await orchestrate(stubs.deps, logger)

        expect(first(stubs.generateFindingsCalls).conventions).toBe(
          "(conventions file included in full as priority documentation below — ground convention findings in that copy)",
        )
        expect(logsWithMessage(logger, truncationWarning)).toEqual([])
        expect(stubs.upsertSummaryCommentCalls).toEqual([
          expectedStatus({
            isFirstRun: true,
            postedCount: expectedSelection.selected.length,
            totalCount: expectedSelection.selected.length,
          }),
        ])
        expect(conventionsLine(result.reviewSummaryMarkdown)).toBe(
          "**Conventions:** AGENTS.md (sent in full as a priority doc; its 32001 characters exceed the 32000-character section cap)",
        )
        expect(result.conventionsNote).toBeNull()
        expect(first(stubs.updateCheckRunCalls).output).toEqual({
          title: `${expectedSelection.selected.length} findings`,
          summary: expectedCheckSummary(null),
        })
      })

      it("warns without suggesting priority_docs when the listed file was not read", async () => {
        const stubs = makeOrchestrateDeps({
          config: { conventionsFile: "AGENTS.md", priorityDocs: ["./AGENTS.md"] },
          contextReader: { readConventions: async () => overCapConventions },
        })
        const logger = createTestLogger()

        const result = await orchestrate(stubs.deps, logger)

        expect(first(stubs.generateFindingsCalls).conventions).toBe(overCapConventions)
        expect(logsWithMessage(logger, truncationWarning)).toEqual([
          {
            level: "warn",
            message: truncationWarning,
            data: {
              conventionsFile: "AGENTS.md",
              conventionsCharacters: 32_001,
              conventionsCharacterCap: 32_000,
            },
          },
        ])
        expect(stubs.upsertSummaryCommentCalls).toEqual([
          expectedStatus({
            isFirstRun: true,
            postedCount: expectedSelection.selected.length,
            totalCount: expectedSelection.selected.length,
            contextNotes: [
              "Priority docs not included: `./AGENTS.md` (missing, unreadable, or over budget)",
            ],
            conventionsNote: listedNoCopyNote,
          }),
        ])
        expect(result.conventionsNote).toBe(listedNoCopyNote)
      })

      it("warns ahead without a log warning when this PR's changed file carried the full text", async () => {
        const stubs = makeOrchestrateDeps({
          config: { conventionsFile: "AGENTS.md", priorityDocs: [] },
          contextReader: {
            readConventions: async () => overCapConventions,
            readChangedFiles: async () => ({
              files: [
                fixtureChangedFile,
                { path: "AGENTS.md", content: overCapConventions, includedAs: "full" as const },
              ],
              remainingTokens: 10_000,
            }),
          },
        })
        const logger = createTestLogger()

        const result = await orchestrate(stubs.deps, logger)

        expect(first(stubs.generateFindingsCalls).conventions).toBe(overCapConventions)
        expect(logsWithMessage(logger, truncationWarning)).toEqual([])
        expect(stubs.upsertSummaryCommentCalls).toEqual([
          expectedStatus({
            isFirstRun: true,
            postedCount: expectedSelection.selected.length,
            totalCount: expectedSelection.selected.length,
            conventionsNote: crossingNote,
          }),
        ])
        expect(conventionsLine(result.reviewSummaryMarkdown)).toBe(
          "**Conventions:** AGENTS.md (truncated to 32000 of 32001 characters; full copy in changed files)",
        )
        expect(result.conventionsNote).toBe(crossingNote)
        expect(first(stubs.updateCheckRunCalls).output).toEqual({
          title: `${expectedSelection.selected.length} findings`,
          summary: expectedCheckSummary(crossingNote),
        })
      })

      it("warns ahead when a related-file copy carried the full text", async () => {
        const stubs = makeOrchestrateDeps({
          config: { conventionsFile: "AGENTS.md", priorityDocs: [] },
          contextReader: {
            readConventions: async () => overCapConventions,
            findRelatedFiles: async () => ({
              files: [
                { path: "AGENTS.md", content: overCapConventions, includedAs: "full" as const },
              ],
              excludedByCapPaths: [],
            }),
          },
        })
        const logger = createTestLogger()

        const result = await orchestrate(stubs.deps, logger)

        expect(logsWithMessage(logger, truncationWarning)).toEqual([])
        expect(conventionsLine(result.reviewSummaryMarkdown)).toBe(
          "**Conventions:** AGENTS.md (truncated to 32000 of 32001 characters; full copy in related files)",
        )
        expect(result.conventionsNote).toBe(crossingNote)
        expect(stubs.upsertSummaryCommentCalls).toEqual([
          expectedStatus({
            isFirstRun: true,
            postedCount: expectedSelection.selected.length,
            totalCount: expectedSelection.selected.length,
            conventionsNote: crossingNote,
          }),
        ])
        expect(first(stubs.updateCheckRunCalls).output).toEqual({
          title: `${expectedSelection.selected.length} findings`,
          summary: expectedCheckSummary(crossingNote),
        })
      })

      it("warns ahead when the PR adds the conventions file", async () => {
        const addedConventionsDiff = `${sampleDiff}diff --git a/AGENTS.md b/AGENTS.md\nnew file mode 100644\nindex 0000000..4444444\n--- /dev/null\n+++ b/AGENTS.md\n@@ -0,0 +1 @@\n+# Conventions\n`
        const stubs = makeOrchestrateDeps({
          config: { conventionsFile: "./AGENTS.md", priorityDocs: [] },
          githubClient: {
            fetchDiff: async () => ({ kind: "ok" as const, diff: addedConventionsDiff }),
          },
          contextReader: { readConventions: async () => overCapConventions },
        })
        const logger = createTestLogger()

        const result = await orchestrate(stubs.deps, logger)

        expect(logsWithMessage(logger, truncationWarning)).toEqual([])
        expect(conventionsLine(result.reviewSummaryMarkdown)).toBe(
          "**Conventions:** ./AGENTS.md (truncated to 32000 of 32001 characters; full copy in the diff of the added file)",
        )
        const addedFileNote =
          "Conventions file `./AGENTS.md` exceeds `conventions_budget_tokens` (32001 characters against a 32000-character cap) — this PR carried the full text, but later PRs that change neither it nor a file it imports will see only the first 32000 characters."
        expect(result.conventionsNote).toBe(addedFileNote)
        expect(stubs.upsertSummaryCommentCalls).toEqual([
          expectedStatus({
            isFirstRun: true,
            postedCount: expectedSelection.selected.length,
            totalCount: expectedSelection.selected.length,
            conventionsNote: addedFileNote,
          }),
        ])
        expect(first(stubs.updateCheckRunCalls).output).toEqual({
          title: `${expectedSelection.selected.length} findings`,
          summary: expectedCheckSummary(addedFileNote),
        })
      })

      it("does not treat an added binary conventions file's diff as a full copy", async () => {
        const binaryConventionsDiff = `${sampleDiff}diff --git a/AGENTS.md b/AGENTS.md\nnew file mode 100644\nindex 0000000..4444444\nBinary files /dev/null and b/AGENTS.md differ\n`
        const stubs = makeOrchestrateDeps({
          config: { conventionsFile: "AGENTS.md", priorityDocs: [] },
          githubClient: {
            fetchDiff: async () => ({ kind: "ok" as const, diff: binaryConventionsDiff }),
          },
          contextReader: { readConventions: async () => overCapConventions },
        })
        const logger = createTestLogger()

        const result = await orchestrate(stubs.deps, logger)

        expect(logsWithMessage(logger, truncationWarning)).toEqual([
          {
            level: "warn",
            message: truncationWarning,
            data: {
              conventionsFile: "AGENTS.md",
              conventionsCharacters: 32_001,
              conventionsCharacterCap: 32_000,
            },
          },
        ])
        expect(result.conventionsNote).toBe(noCopyNote)
      })

      it("does not treat a modified conventions file's diff as a full copy", async () => {
        const modifiedConventionsDiff = `${sampleDiff}diff --git a/AGENTS.md b/AGENTS.md\nindex 1111111..4444444 100644\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-# Old conventions\n+# Conventions\n`
        const stubs = makeOrchestrateDeps({
          config: { conventionsFile: "AGENTS.md", priorityDocs: [] },
          githubClient: {
            fetchDiff: async () => ({ kind: "ok" as const, diff: modifiedConventionsDiff }),
          },
          contextReader: { readConventions: async () => overCapConventions },
        })
        const logger = createTestLogger()

        const result = await orchestrate(stubs.deps, logger)

        expect(logsWithMessage(logger, truncationWarning)).toEqual([
          {
            level: "warn",
            message: truncationWarning,
            data: {
              conventionsFile: "AGENTS.md",
              conventionsCharacters: 32_001,
              conventionsCharacterCap: 32_000,
            },
          },
        ])
        expect(result.conventionsNote).toBe(noCopyNote)
      })

      it("carries the note into the check summary when the review posts no findings", async () => {
        const stubs = makeOrchestrateDeps({
          config: { conventionsFile: "AGENTS.md", priorityDocs: [] },
          contextReader: { readConventions: async () => overCapConventions },
          fixtureResult: { review: { analysis: "clean", findings: [] } },
        })
        const logger = createTestLogger()

        await orchestrate(stubs.deps, logger)

        expect(first(stubs.updateCheckRunCalls).output).toEqual({
          title: "No findings above threshold",
          summary: `Reviewed with \`test/model\` — no findings above threshold.\n\n${noCopyNote}\n\n${expectedCostSummary}`,
        })
      })

      it("logs the suppression with the conventions character counts", async () => {
        const stubs = makeOrchestrateDeps({
          config: { conventionsFile: "AGENTS.md", priorityDocs: ["AGENTS.md"] },
          contextReader: {
            readConventions: async () => overCapConventions,
            readPriorityDocs: async (params) => ({
              files: [
                { path: "AGENTS.md", content: overCapConventions, includedAs: "full" as const },
              ],
              remainingTokens: params.budgetTokens - 8001,
            }),
          },
        })
        const logger = createTestLogger()

        await orchestrate(stubs.deps, logger)

        const suppressionMessage =
          "conventions file read in full by priority-doc channel — suppressing truncated conventions section to avoid duplication"
        expect(logsWithMessage(logger, suppressionMessage)).toEqual([
          {
            level: "info",
            message: suppressionMessage,
            data: {
              conventionsFile: "AGENTS.md",
              conventionsCharacters: 32_001,
              conventionsCharacterCap: 32_000,
            },
          },
        ])
      })
    })

    describe("context log conventions entry", () => {
      const loggedConventionsEntries = (logger: ReturnType<typeof createTestLogger>): unknown[] => {
        return logsWithMessage(logger, "context sent to model").map(
          (entry) => entry.data.conventionsFile,
        )
      }

      it("names the configured file when the conventions section is sent", async () => {
        const stubs = makeOrchestrateDeps({ config: { conventionsFile: "AGENTS.md" } })
        const logger = createTestLogger()

        await orchestrate(stubs.deps, logger)

        expect(loggedConventionsEntries(logger)).toEqual(["AGENTS.md"])
      })

      it("marks the file as suppressed when priority docs carried the full copy", async () => {
        const overCapConventions = "c".repeat(32_001)
        const stubs = makeOrchestrateDeps({
          config: { conventionsFile: "AGENTS.md", priorityDocs: ["AGENTS.md"] },
          contextReader: {
            readConventions: async () => overCapConventions,
            readPriorityDocs: async (params) => ({
              files: [
                { path: "AGENTS.md", content: overCapConventions, includedAs: "full" as const },
              ],
              remainingTokens: params.budgetTokens - 8001,
            }),
          },
        })
        const logger = createTestLogger()

        await orchestrate(stubs.deps, logger)

        expect(loggedConventionsEntries(logger)).toEqual([
          "AGENTS.md (suppressed — full copy in priority docs)",
        ])
      })

      it("reports not found when the conventions file is missing", async () => {
        const stubs = makeOrchestrateDeps({
          config: { conventionsFile: "AGENTS.md" },
          contextReader: { readConventions: async () => null },
        })
        const logger = createTestLogger()

        await orchestrate(stubs.deps, logger)

        expect(loggedConventionsEntries(logger)).toEqual(["not found"])
      })
    })

    it("omits the conventions file from the priority-doc exclusions when it is not found", async () => {
      const stubs = makeOrchestrateDeps({
        config: { conventionsFile: "AGENTS.md", priorityDocs: ["README.md"] },
        contextReader: {
          readConventions: async () => null,
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.readPriorityDocsCalls.map((call) => call.excludePaths)).toEqual([
        [],
        ["src/greeter.ts"],
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

      expect(stubs.readPriorityDocsCalls).toHaveLength(2)
      expect(first(stubs.readPriorityDocsCalls).priorityDocs).toEqual(["README.md"])
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

    it("reserves a budget floor for priority docs by capping related-files budget", async () => {
      const stubs = makeOrchestrateDeps({
        config: {
          priorityDocs: ["README.md"],
          contextBudgetTokens: 80_000,
          traceRelatedFiles: true,
        },
        contextReader: {
          readChangedFiles: async () => ({
            files: [fixtureChangedFile],
            remainingTokens: 20_000,
          }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      // 10% of 80_000 = 8_000 floor; related files get 20_000 - 8_000 = 12_000
      expect(first(stubs.findRelatedFilesCalls).budgetTokens).toBe(12_000)
    })

    it("does not reserve a budget floor when no priority docs are configured", async () => {
      const stubs = makeOrchestrateDeps({
        config: {
          priorityDocs: [],
          contextBudgetTokens: 80_000,
          traceRelatedFiles: true,
        },
        contextReader: {
          readChangedFiles: async () => ({
            files: [fixtureChangedFile],
            remainingTokens: 20_000,
          }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      // No floor — related files get the full remaining budget
      expect(first(stubs.findRelatedFilesCalls).budgetTokens).toBe(20_000)
    })

    it("clamps the budget floor to remaining tokens when the diff is large", async () => {
      const stubs = makeOrchestrateDeps({
        config: {
          priorityDocs: ["README.md"],
          contextBudgetTokens: 80_000,
          traceRelatedFiles: true,
        },
        contextReader: {
          readChangedFiles: async () => ({
            files: [fixtureChangedFile],
            remainingTokens: 3_000,
          }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      // 10% of 80_000 = 8_000 floor, but only 3_000 remaining → floor
      // clamps to 3_000, related files get 0
      expect(first(stubs.findRelatedFilesCalls).budgetTokens).toBe(0)
    })

    it("skips the budget floor when all priority docs are already in context as changed files", async () => {
      const stubs = makeOrchestrateDeps({
        config: {
          priorityDocs: ["README.md"],
          contextBudgetTokens: 80_000,
          traceRelatedFiles: true,
        },
        contextReader: {
          readChangedFiles: async () => ({
            files: [
              fixtureChangedFile,
              {
                path: "README.md",
                content: "# Readme",
                includedAs: "full" as const,
              },
            ],
            remainingTokens: 20_000,
          }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      // README.md is already in context — floor is 0, related files get full budget
      expect(first(stubs.findRelatedFilesCalls).budgetTokens).toBe(20_000)
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

    it("keeps each routed model when GitHub re-routes a mixed-model inline review", async () => {
      const fallbackFinding = makeFinding({
        line: 2,
        category: "subtle_bugs",
        severity: "high",
        title: "Fallback finding",
      })
      const stubs = makeOrchestrateDeps({
        config: { phases: "parallel" },
        generateFindings: async (reviewContext) => {
          stubs.generateFindingsCalls.push(reviewContext)
          if (reviewContext.phase.id === "subtle-bugs") {
            return {
              review: { analysis: "checked", findings: [fallbackFinding] },
              modelUsed: "fallback/model",
              attempts: [fixtureAttempt],
            }
          }
          if (reviewContext.phase.id === "correctness-security") {
            return {
              review: fixtureReviewResponse,
              modelUsed: "test/model",
              attempts: [fixtureAttempt],
            }
          }
          return {
            review: { analysis: "checked", findings: [] },
            modelUsed: "test/model",
            attempts: [fixtureAttempt],
          }
        },
        githubClient: {
          postFindingsReview: async () => ({ kind: "rejected" as const }),
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.reviewUrl).toBe("")
      expect(result.findingsCount).toBe(expectedSelection.selected.length + 1)
      expect(result.modelUsed).toBe("test/model, fallback/model")
      const postedFindings = [
        withRoutedModel(fallbackFinding, "fallback/model"),
        ...findingsWithRoutedModel(expectedSelection.selected, "test/model"),
      ]
      expect(stubs.postIssueCommentCalls).toEqual(
        postedFindings.map((finding) => ({
          prNumber: 7,
          body: renderReroutedFinding(finding),
        })),
      )
    })

    it("keeps the beyond-diff note only on beyond-diff findings when GitHub rejects the inline review", async () => {
      const beyondDiffFinding = makeFinding({ file: "src/untouched.ts", line: 400 })
      const inDiffFinding = makeFinding()
      const stubs = makeOrchestrateDeps({
        fixtureResult: {
          review: { analysis: "checked", findings: [beyondDiffFinding, inDiffFinding] },
        },
        contextReader: {
          findRelatedFiles: async () => ({
            files: [
              {
                path: "src/untouched.ts",
                content: "import { greet } from './greeter.js'",
                includedAs: "full",
                reason: "imports src/greeter.ts",
              },
            ],
            excludedByCapPaths: [],
          }),
        },
        githubClient: {
          postFindingsReview: async () => ({ kind: "rejected" as const }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.postIssueCommentCalls).toEqual([
        {
          prNumber: 7,
          body: renderBeyondDiffFinding(withRoutedModel(beyondDiffFinding, "test/model")),
        },
        {
          prNumber: 7,
          body: renderReroutedFinding(withRoutedModel(inDiffFinding, "test/model")),
        },
      ])
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
      expect(result.findingsCount).toBe(expectedMapped.standaloneFindings.length)
      // Unposted findings are NOT re-routed — their missing anchors make the
      // next run re-report them, and the status comment says so instead of
      // claiming they were posted.
      expect(stubs.postIssueCommentCalls).toEqual(
        expectedMapped.standaloneFindings.map((finding) => ({
          prNumber: 7,
          body: renderBeyondDiffFinding(finding),
        })),
      )
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: expectedMapped.standaloneFindings.length,
          unpostedCount:
            expectedSelection.selected.length - expectedMapped.standaloneFindings.length,
          totalCount: expectedMapped.standaloneFindings.length,
        }),
      ])
      expect(
        logsWithMessage(
          logger,
          "failed to post findings review — findings will re-report next run",
        ),
      ).toEqual([
        {
          level: "warn",
          message: "failed to post findings review — findings will re-report next run",
          data: { error: "[Error]: boom" },
        },
      ])
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
        contextReader: {
          findRelatedFiles: async () => ({
            files: [
              {
                path: "src/untouched.ts",
                content: "import { greet } from './greeter.js'",
                includedAs: "full",
                reason: "imports src/greeter.ts",
              },
            ],
            excludedByCapPaths: [],
          }),
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
      expect(
        logsWithMessage(
          logger,
          "failed to post finding as an issue comment — it will re-report next run",
        ),
      ).toEqual([
        {
          level: "warn",
          message: "failed to post finding as an issue comment — it will re-report next run",
          data: {
            error: "[Error]: boom",
            file: "src/untouched.ts",
            line: 400,
          },
        },
      ])
      expect(logsWithMessage(logger, "findings posted as issue comments")).toEqual([])
    })

    it("logs the count of findings posted as issue comments, leaving out a failed post", async () => {
      const failedFinding = makeFinding({
        file: "src/untouched.ts",
        line: 400,
        title: "Unchecked greet result",
      })
      const postedFinding = makeFinding({
        file: "src/untouched.ts",
        line: 420,
        title: "Caller ignores the empty-key throw",
      })
      const failedBody = renderBeyondDiffFinding(withRoutedModel(failedFinding, "test/model"))
      const stubs = makeOrchestrateDeps({
        fixtureResult: {
          review: { analysis: "checked", findings: [failedFinding, postedFinding] },
        },
        contextReader: {
          findRelatedFiles: async () => ({
            files: [
              {
                path: "src/untouched.ts",
                content: "import { greet } from './greeter.js'",
                includedAs: "full",
                reason: "imports src/greeter.ts",
              },
            ],
            excludedByCapPaths: [],
          }),
        },
        githubClient: {
          postIssueComment: async ({ body }) => {
            if (body === failedBody) throw new Error("boom")
            return { url: "https://github.com/test/comment/2" }
          },
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      // The failed post's warning proves both findings reached the posting loop
      expect(
        logsWithMessage(
          logger,
          "failed to post finding as an issue comment — it will re-report next run",
        ),
      ).toEqual([
        {
          level: "warn",
          message: "failed to post finding as an issue comment — it will re-report next run",
          data: { error: "[Error]: boom", file: "src/untouched.ts", line: 400 },
        },
      ])
      expect(logsWithMessage(logger, "findings posted as issue comments")).toEqual([
        {
          level: "info",
          message: "findings posted as issue comments",
          data: { count: 1, locations: ["src/untouched.ts:420"] },
        },
      ])
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
        failure_scenario: 'register(" ", "value") succeeds and the entry is orphaned.',
      })
      const mixedResponse: ReviewResponse = {
        analysis: "checked",
        findings: [nonFinding, realFinding],
      }

      const { findings: mixedFiltered } = filterNonFindings(mixedResponse.findings)
      const mixedSelection = selectFindings({
        findings: mixedFiltered,
        severityThreshold: "low",
        maxFindings: undefined,
      })
      const mixedMapped = mapFindingsToReview({
        findings: findingsWithRoutedModel(mixedSelection.selected, "test/model"),
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
        phases: [{ phase: "combined", status: "completed" }],
        reviewSummaryMarkdown: expectedReviewSummary({
          totalFromModel: 2,
          droppedAsNonFinding: 1,
          posted: 1,
        }),
        costSummaryMarkdown: expectedCostSummary,
        conventionsNote: null,
      })

      expect(stubs.postFindingsReviewCalls).toEqual([
        {
          prNumber: 7,
          commitId: fixturePrContext.headSha,
          body: REVIEW_MARKER,
          comments: mixedMapped.comments,
        },
      ])

      expect(logsWithMessage(logger, "non-finding filter applied to model output")).toEqual([
        {
          level: "info",
          message: "non-finding filter applied to model output",
          data: {
            totalFromModel: 2,
            kept: 1,
            droppedAsNonFinding: 1,
            droppedAsUnknownFile: 0,
            duplicatesAcrossPhases: 0,
          },
        },
      ])
    })

    it("posts a beyond-diff finding on a related file as a standalone comment", async () => {
      const relatedFileFinding = makeFinding({
        file: "src/caller.ts",
        line: 400,
      })
      const relatedFile: PromptFile = {
        path: "src/caller.ts",
        content: "import { greet } from './greeter.js'",
        includedAs: "full",
        reason: "imports src/greeter.ts",
      }
      const stubs = makeOrchestrateDeps({
        fixtureResult: {
          review: { analysis: "checked", findings: [relatedFileFinding] },
        },
        contextReader: {
          findRelatedFiles: async () => ({
            files: [relatedFile],
            excludedByCapPaths: [],
          }),
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      // Only a standalone comment posts here, so there is no review URL
      expect(result).toEqual({
        findingsCount: 1,
        reviewUrl: "",
        modelUsed: "test/model",
        skippedReason: "",
        phases: [{ phase: "combined", status: "completed" }],
        reviewSummaryMarkdown: expectedReviewSummary({
          relatedFilePaths: ["src/caller.ts"],
          tokenBudgetRemainingForDocs: 40_000 - estimateTokens(relatedFile.content),
          totalFromModel: 1,
          posted: 1,
        }),
        costSummaryMarkdown: expectedCostSummary,
        conventionsNote: null,
      })
      expect(stubs.postIssueCommentCalls).toEqual([
        {
          prNumber: 7,
          body: renderBeyondDiffFinding(withRoutedModel(relatedFileFinding, "test/model")),
        },
      ])
    })

    it("drops a finding whose file the model was not given before posting", async () => {
      const unknownFileFinding = makeFinding({
        file: "deploy/railway/README.md and the same issues...",
        line: 493,
        category: "subtle_bugs",
        suggestion: "not emitted",
      })
      const realFinding = makeFinding({ line: 145 })
      const realMapped = mapFindingsToReview({
        findings: [withRoutedModel(realFinding, "test/model")],
        commentableByPath: fixtureCommentableByPath,
      })
      const stubs = makeOrchestrateDeps({
        fixtureResult: {
          review: {
            analysis: "checked",
            findings: [unknownFileFinding, realFinding],
          },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result).toEqual({
        findingsCount: 1,
        reviewUrl: "https://github.com/test/review/1",
        modelUsed: "test/model",
        skippedReason: "",
        phases: [{ phase: "combined", status: "completed" }],
        reviewSummaryMarkdown: expectedReviewSummary({
          totalFromModel: 2,
          droppedAsUnknownFile: 1,
          posted: 1,
        }),
        costSummaryMarkdown: expectedCostSummary,
        conventionsNote: null,
      })
      expect(stubs.postIssueCommentCalls).toEqual([])
      expect(stubs.postFindingsReviewCalls).toEqual([
        {
          prNumber: 7,
          commitId: fixturePrContext.headSha,
          body: REVIEW_MARKER,
          comments: realMapped.comments,
        },
      ])
      expect(logsWithMessage(logger, "dropping finding: file not in prompt context")).toEqual([
        {
          level: "warn",
          message: "dropping finding: file not in prompt context",
          data: {
            phase: "combined",
            file: "deploy/railway/README.md and the same issues...",
            line: 493,
            category: "subtle_bugs",
          },
        },
      ])
      expect(logsWithMessage(logger, "non-finding filter applied to model output")).toEqual([
        {
          level: "info",
          message: "non-finding filter applied to model output",
          data: {
            totalFromModel: 2,
            kept: 1,
            droppedAsNonFinding: 0,
            droppedAsUnknownFile: 1,
            duplicatesAcrossPhases: 0,
          },
        },
      ])
    })

    it("treats rename-from and deleted diff paths as known files", async () => {
      const renamedFromFinding = makeFinding({
        file: "src/old-name.ts",
        line: 1,
      })
      const deletedFileFinding = makeFinding({
        file: "src/removed-file.ts",
        line: 1,
      })
      const stubs = makeOrchestrateDeps({
        fixtureResult: {
          review: {
            analysis: "checked",
            findings: [renamedFromFinding, deletedFileFinding],
          },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(2)
      expect(stubs.postIssueCommentCalls).toEqual([
        {
          prNumber: 7,
          body: renderBeyondDiffFinding(withRoutedModel(renamedFromFinding, "test/model")),
        },
        {
          prNumber: 7,
          body: renderBeyondDiffFinding(withRoutedModel(deletedFileFinding, "test/model")),
        },
      ])
    })

    it("treats the conventions file as known only when it was found", async () => {
      const conventionsFinding = makeFinding({ file: "AGENTS.md", line: 1 })
      const foundStubs = makeOrchestrateDeps({
        fixtureResult: {
          review: { analysis: "checked", findings: [conventionsFinding] },
        },
      })
      const missingStubs = makeOrchestrateDeps({
        fixtureResult: {
          review: { analysis: "checked", findings: [conventionsFinding] },
        },
        contextReader: { readConventions: async () => null },
      })

      const foundResult = await orchestrate(foundStubs.deps, createTestLogger())
      const missingLogger = createTestLogger()
      const missingResult = await orchestrate(missingStubs.deps, missingLogger)

      expect(foundResult.findingsCount).toBe(1)
      expect(foundStubs.postIssueCommentCalls).toEqual([
        {
          prNumber: 7,
          body: renderBeyondDiffFinding(withRoutedModel(conventionsFinding, "test/model")),
        },
      ])
      expect(missingResult.findingsCount).toBe(0)
      expect(missingStubs.postIssueCommentCalls).toEqual([])
      expect(
        logsWithMessage(missingLogger, "dropping finding: file not in prompt context"),
      ).toEqual([
        {
          level: "warn",
          message: "dropping finding: file not in prompt context",
          data: {
            phase: "combined",
            file: "AGENTS.md",
            line: 1,
            category: "correctness",
          },
        },
      ])
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
      expect(stubs.postFindingsReviewCalls).toEqual([expectedFindingsReview(findings.slice(1))])
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: findings.length - 1,
          totalCount: findings.length,
        }),
      ])
    })

    it("keeps the surviving routed model after cross-run deduplication", async () => {
      const duplicateFinding = makeFinding({ line: 145 })
      const survivingFinding = makeFinding({
        line: 2,
        category: "subtle_bugs",
        title: "New fallback finding",
      })
      const stubs = makeOrchestrateDeps({
        config: { phases: "parallel" },
        generateFindings: async (reviewContext) => {
          stubs.generateFindingsCalls.push(reviewContext)
          if (reviewContext.phase.id === "subtle-bugs") {
            return {
              review: { analysis: "checked", findings: [survivingFinding] },
              modelUsed: "fallback/model",
              attempts: [fixtureAttempt],
            }
          }
          if (reviewContext.phase.id === "correctness-security") {
            return {
              review: { analysis: "checked", findings: [duplicateFinding] },
              modelUsed: "test/model",
              attempts: [fixtureAttempt],
            }
          }
          return {
            review: { analysis: "checked", findings: [] },
            modelUsed: "test/model",
            attempts: [fixtureAttempt],
          }
        },
        githubClient: {
          fetchBotReviewComments: async () => [
            existingComment(
              `prior finding\n\n<!-- umm-actually:${computeAnchorKey(duplicateFinding)} -->`,
            ),
          ],
        },
      })

      const result = await orchestrate(stubs.deps, createTestLogger())

      expect(result.modelUsed).toBe("test/model, fallback/model")
      expect(stubs.postFindingsReviewCalls).toEqual([
        {
          prNumber: 7,
          commitId: fixturePrContext.headSha,
          body: REVIEW_MARKER,
          comments: mapFindingsToReview({
            findings: [withRoutedModel(survivingFinding, "fallback/model")],
            commentableByPath: fixtureCommentableByPath,
          }).comments,
        },
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
          fetchBotIssueComments: async () => [issueFinding(computeAnchorKey(duplicateFinding))],
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(findings.length - 1)
      expect(stubs.postFindingsReviewCalls).toEqual([expectedFindingsReview(findings.slice(1))])
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
            existingComment(`some comment\n\n<!-- umm-actually:${driftedAnchor} -->`),
          ],
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(findings.length - 1)
      expect(stubs.postFindingsReviewCalls).toEqual([expectedFindingsReview(findings.slice(1))])
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
            existingComment(`some comment\n\n<!-- umm-actually:${staleAnchor} -->`, {
              line: movedFinding.line,
              originalLine: movedFinding.line - 50,
            }),
          ],
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(findings.length - 1)
      expect(stubs.postFindingsReviewCalls).toEqual([expectedFindingsReview(findings.slice(1))])
    })

    it("dedups via content tier when title matches but category differs", async () => {
      const findings = fixtureReviewResponse.findings
      const targetFinding = findings[0]

      if (!targetFinding) {
        throw new Error("expected at least one fixture finding")
      }
      const shiftedAnchor = computeAnchorKey({
        ...targetFinding,
        category: "subtle_bugs",
        line: targetFinding.line + 10,
      })

      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchBotReviewComments: async () => [
            existingComment(
              `**${targetFinding.title}**\nHigh severity · subtle_bugs · high confidence\n\nSome description.\n\n<!-- umm-actually:${shiftedAnchor} -->`,
            ),
          ],
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(findings.length - 1)
      expect(logsWithMessage(logger, "content-tier dedup suppressed finding")).toEqual([
        {
          level: "info",
          message: "content-tier dedup suppressed finding",
          data: {
            file: targetFinding.file,
            line: targetFinding.line,
            category: targetFinding.category,
            title: targetFinding.title,
          },
        },
      ])
      expect(logsWithMessage(logger, "cross-run dedup against prior bot comments")).toEqual([
        {
          level: "info",
          message: "cross-run dedup against prior bot comments",
          data: {
            statusCommentFound: false,
            existingAnchorCount: 1,
            priorBotCommentCount: 1,
            findingsAfterFilter: findings.length,
            findingsSurvivedDedup: findings.length - 1,
            droppedByPositional: 0,
            droppedByContent: 1,
            droppedByTitle: 0,
          },
        },
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
      expect(
        logsWithMessage(logger, "failed to fetch inline comments — treating their findings as new"),
      ).toEqual([
        {
          level: "warn",
          message: "failed to fetch inline comments — treating their findings as new",
          data: { error: "[Error]: network error" },
        },
      ])
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
      expect(
        logsWithMessage(logger, "failed to fetch issue comments — treating as a first run"),
      ).toEqual([
        {
          level: "warn",
          message: "failed to fetch issue comments — treating as a first run",
          data: { error: "[Error]: network error" },
        },
      ])
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
      expect(logsWithMessage(logger, "failed to upsert status comment")).toEqual([
        {
          level: "warn",
          message: "failed to upsert status comment",
          data: { error: "[Error]: API rate limit" },
        },
      ])
    })

    const priorBotCommentsFrom = (stubs: RecordingStubs): string[] => {
      const context = stubs.generateFindingsCalls[0]

      if (!context) {
        throw new Error("expected at least one generateFindings call")
      }
      return context.priorBotComments
    }

    it("passes prior bot comment bodies (anchor-stripped) to generateFindings", async () => {
      const commentBody =
        "**[high/correctness]** Fix null check\n\nDescription.\n\n<!-- umm-actually:src/greeter.ts:correctness:99 -->"
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchBotReviewComments: async () => [existingComment(commentBody, { line: 99 })],
          fetchBotIssueComments: async () => [
            statusComment,
            issueFinding("src/other.ts:security:50"),
          ],
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(priorBotCommentsFrom(stubs)).toEqual([
        "**[high/correctness]** Fix null check\n\nDescription.",
        "finding text",
      ])
    })

    it("excludes the status comment from prior bot comments", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchBotIssueComments: async () => [statusComment],
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(priorBotCommentsFrom(stubs)).toEqual([])
    })

    it("caps prior bot comments at 30", async () => {
      const comments = Array.from({ length: 40 }, (_, index) =>
        existingComment(
          `finding ${index}\n\n<!-- umm-actually:src/a.ts:correctness:${index + 1} -->`,
          { line: index + 1 },
        ),
      )
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchBotReviewComments: async () => comments,
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(priorBotCommentsFrom(stubs)).toEqual(
        Array.from({ length: 30 }, (_, index) => `finding ${index + 10}`),
      )
    })

    it("passes empty prior bot comments on a first run", async () => {
      const stubs = makeOrchestrateDeps()
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(priorBotCommentsFrom(stubs)).toEqual([])
    })
  })

  describe("check run lifecycle", () => {
    it("creates the check run with the head SHA and completes it success with the findings count", async () => {
      const stubs = makeOrchestrateDeps()
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.createCheckRunCalls).toEqual([
        { headSha: fixturePrContext.headSha, name: "umm-actually" },
      ])
      expect(stubs.updateCheckRunCalls).toEqual([
        {
          checkRunId: 555,
          conclusion: "success",
          output: {
            title: `${expectedSelection.selected.length} findings`,
            summary: `Reviewed with \`test/model\` — ${expectedSelection.selected.length} findings posted.\n\n${expectedCostSummary}`,
          },
        },
      ])
    })

    it("titles the check with the singular form for exactly one finding", async () => {
      const stubs = makeOrchestrateDeps({ config: { maxFindings: 1 } })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.updateCheckRunCalls).toEqual([
        {
          checkRunId: 555,
          conclusion: "success",
          output: {
            title: "1 finding",
            summary: `Reviewed with \`test/model\` — 1 finding posted.\n\n${expectedCostSummary}`,
          },
        },
      ])
    })

    it("completes success when the review posts no findings", async () => {
      const stubs = makeOrchestrateDeps({
        fixtureResult: {
          review: { analysis: "clean", findings: [] },
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.updateCheckRunCalls).toEqual([
        {
          checkRunId: 555,
          conclusion: "success",
          output: {
            title: "No findings above threshold",
            summary: `Reviewed with \`test/model\` — no findings above threshold.\n\n${expectedCostSummary}`,
          },
        },
      ])
    })

    it("omits the cost section when cost_summary is disabled", async () => {
      const stubs = makeOrchestrateDeps({
        config: { costSummary: false },
        fixtureResult: {
          review: { analysis: "clean", findings: [] },
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.updateCheckRunCalls).toEqual([
        {
          checkRunId: 555,
          conclusion: "success",
          output: {
            title: "No findings above threshold",
            summary: "Reviewed with `test/model` — no findings above threshold.",
          },
        },
      ])
    })

    it("completes neutral with the skip reason on skip paths", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          fetchDiff: async () => ({ kind: "too_large" as const }),
        },
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.updateCheckRunCalls).toEqual([
        {
          checkRunId: 555,
          conclusion: "neutral",
          output: {
            title: "Skipped — diff exceeds GitHub's diff API limits",
            summary: "Review skipped: diff exceeds GitHub's diff API limits",
          },
        },
      ])
    })

    it("creates no check run for non-PR events", async () => {
      const stubs = makeOrchestrateDeps({
        eventName: "push",
        payload: {},
      })
      const logger = createTestLogger()

      await orchestrate(stubs.deps, logger)

      expect(stubs.createCheckRunCalls).toEqual([])
      expect(stubs.updateCheckRunCalls).toEqual([])
    })

    it("creates no check run when input validation fails", async () => {
      const stubs = makeOrchestrateDeps({
        config: { severityThreshold: "invalid" },
      })
      const logger = createTestLogger()

      await expect(orchestrate(stubs.deps, logger)).rejects.toThrow("severity")
      expect(stubs.createCheckRunCalls).toEqual([])
    })

    it("completes failure and rethrows when the pipeline errors", async () => {
      const stubs = makeOrchestrateDeps({
        generateFindings: async () => {
          throw new Error("model exploded")
        },
      })
      const logger = createTestLogger()

      await expect(orchestrate(stubs.deps, logger)).rejects.toThrow("model exploded")
      expect(stubs.updateCheckRunCalls).toEqual([
        {
          checkRunId: 555,
          conclusion: "failure",
          output: {
            title: "Error — review did not complete",
            summary:
              "[AllPhasesFailedError]: every review phase failed: combined: [Error]: model exploded",
          },
        },
      ])
    })

    it("registers a cancellation cleanup that completes the check as cancelled", async () => {
      const stubs = makeOrchestrateDeps()
      const registeredCleanups: (() => Promise<void>)[] = []
      const logger = createTestLogger()

      await orchestrate(
        {
          ...stubs.deps,
          registerCancellationCleanup: (cleanup) => {
            registeredCleanups.push(cleanup)
            return () => undefined
          },
        },
        logger,
      )
      // Invoked after the run completes to verify the registered function
      // itself — not to simulate mid-pipeline cancellation timing
      await registeredCleanups[0]?.()

      expect(registeredCleanups).toHaveLength(1)
      expect(stubs.updateCheckRunCalls).toEqual([
        {
          checkRunId: 555,
          conclusion: "success",
          output: {
            title: `${expectedSelection.selected.length} findings`,
            summary: `Reviewed with \`test/model\` — ${expectedSelection.selected.length} findings posted.\n\n${expectedCostSummary}`,
          },
        },
        {
          checkRunId: 555,
          conclusion: "cancelled",
          output: {
            title: "Cancelled — review did not finish",
            summary:
              "The workflow run was cancelled before the review completed — a job timeout, or a newer run superseding this one.",
          },
        },
      ])
    })

    it("unregisters the cancellation cleanup only after the normal completion settles", async () => {
      const stubs = makeOrchestrateDeps()
      const updateCallCountsAtUnregister: number[] = []
      const unregister = vi.fn(() => {
        updateCallCountsAtUnregister.push(stubs.updateCheckRunCalls.length)
      })
      const logger = createTestLogger()

      await orchestrate(
        {
          ...stubs.deps,
          registerCancellationCleanup: () => unregister,
        },
        logger,
      )

      // One unregister call, made after the completing update was already
      // recorded — a signal during the update must still find the cleanup
      expect(updateCallCountsAtUnregister).toEqual([1])
    })

    it("unregisters the cancellation cleanup only after the failure completion settles", async () => {
      const stubs = makeOrchestrateDeps({
        generateFindings: async () => {
          throw new Error("model exploded")
        },
      })
      const updateCallCountsAtUnregister: number[] = []
      const unregister = vi.fn(() => {
        updateCallCountsAtUnregister.push(stubs.updateCheckRunCalls.length)
      })
      const logger = createTestLogger()

      await expect(
        orchestrate(
          {
            ...stubs.deps,
            registerCancellationCleanup: () => unregister,
          },
          logger,
        ),
      ).rejects.toThrow("model exploded")

      expect(updateCallCountsAtUnregister).toEqual([1])
    })

    it("registers no cancellation cleanup when the check run could not be created", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          createCheckRun: async () => {
            throw new Error("HTTP 403")
          },
        },
      })
      const registerCancellationCleanup = vi.fn(() => () => undefined)
      const logger = createTestLogger()

      await orchestrate({ ...stubs.deps, registerCancellationCleanup }, logger)

      expect(registerCancellationCleanup).not.toHaveBeenCalled()
    })

    it("continues the review without a check run when creation fails", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          createCheckRun: async () => {
            throw new Error("HTTP 403")
          },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(expectedSelection.selected.length)
      expect(stubs.postFindingsReviewCalls).toEqual([
        expectedFindingsReview(expectedSelection.selected),
      ])
      expect(stubs.updateCheckRunCalls).toEqual([])
      expect(
        logsWithMessage(logger, "failed to create check run — review continues without one"),
      ).toEqual([
        {
          level: "warn",
          message: "failed to create check run — review continues without one",
          data: { error: "[Error]: HTTP 403" },
        },
      ])
    })

    it("returns the review result even when completing the check run fails", async () => {
      const stubs = makeOrchestrateDeps({
        githubClient: {
          updateCheckRun: async () => {
            throw new Error("HTTP 500")
          },
        },
      })
      const logger = createTestLogger()

      const result = await orchestrate(stubs.deps, logger)

      expect(result.findingsCount).toBe(expectedSelection.selected.length)
      expect(
        logsWithMessage(logger, "failed to complete check run — it will linger in progress"),
      ).toEqual([
        {
          level: "warn",
          message: "failed to complete check run — it will linger in progress",
          data: { checkRunId: 555, error: "[Error]: HTTP 500" },
        },
      ])
    })
  })
})

describe("staged phases", () => {
  const splitPhaseIds = ["correctness-security", "conventions-tests", "subtle-bugs"]
  const completedSplitPhases = splitPhaseIds.map((phase) => ({
    phase,
    status: "completed" as const,
  }))
  const splitAttempts = splitPhaseIds.map((phase) => ({
    ...fixtureAttempt,
    phase,
  }))

  it("runs parallel as one stage: every split phase is called with no prior findings and identical findings collapse across phases", async () => {
    const stubs = makeOrchestrateDeps({ config: { phases: "parallel" } })
    const logger = createTestLogger()

    const result = await orchestrate(stubs.deps, logger)

    expect(stubs.generateFindingsCalls.map((call) => [call.phase, call.priorFindings])).toEqual([
      [CORRECTNESS_SECURITY_PHASE, []],
      [CONVENTIONS_TESTS_PHASE, []],
      [SUBTLE_BUGS_PHASE, []],
    ])
    // Every phase returned the same fixture findings: the first phase's copy
    // survives, the other two phases' copies are cross-phase duplicates
    expect(result).toEqual({
      findingsCount: expectedSelection.selected.length,
      reviewUrl: "https://github.com/test/review/1",
      modelUsed: "test/model",
      skippedReason: "",
      phases: completedSplitPhases,
      reviewSummaryMarkdown: expectedReviewSummary({
        phasesCompleted: splitPhaseIds,
        totalFromModel: fixtureReviewResponse.findings.length * 3,
        duplicatesAcrossPhases: fixtureReviewResponse.findings.length * 2,
      }),
      costSummaryMarkdown: renderCostSummary({
        attempts: splitAttempts,
        modelUsed: "test/model",
      }),
      conventionsNote: null,
    })
    expect(stubs.postFindingsReviewCalls).toEqual([
      expectedFindingsReview(expectedSelection.selected),
    ])
  })

  it("runs sequential as three stages, passing every earlier phase's raw findings forward", async () => {
    const correctnessFinding = makeFinding({ line: 145, title: "From cs" })
    const conventionsFinding = makeFinding({
      line: 3,
      category: "conventions",
      title: "From ct",
    })
    const findingsByPhase: Record<string, Finding[]> = {
      "correctness-security": [correctnessFinding],
      "conventions-tests": [conventionsFinding],
      "subtle-bugs": [],
    }
    const stubs = makeOrchestrateDeps({
      config: { phases: "sequential" },
      generateFindings: async (reviewContext) => {
        stubs.generateFindingsCalls.push(reviewContext)
        return {
          review: {
            analysis: "",
            findings: findingsByPhase[reviewContext.phase.id] ?? [],
          },
          modelUsed: "test/model",
          attempts: [fixtureAttempt],
        }
      },
    })
    const logger = createTestLogger()

    await orchestrate(stubs.deps, logger)

    expect(stubs.generateFindingsCalls.map((call) => [call.phase.id, call.priorFindings])).toEqual([
      ["correctness-security", []],
      ["conventions-tests", [correctnessFinding]],
      ["subtle-bugs", [correctnessFinding, conventionsFinding]],
    ])
  })

  it("publishes full coverage without a deadline warning when only accepted-response cost lookup expires", async () => {
    vi.useFakeTimers()
    try {
      const deadline = Date.now() + 1000
      const remainingReviewMs = () => deadline - Date.now()
      const costResponse = Promise.withResolvers<unknown>()
      const getGeneration = vi.fn(() => costResponse.promise)
      const send = vi.fn(async () => ({
        id: "accepted-before-deadline",
        model: "test/model",
        choices: [{ message: { content: JSON.stringify(fixtureReviewResponse) } }],
        usage: { promptTokens: 10, completionTokens: 20 },
      }))
      const client = createOpenRouterClient({
        sdk: { chat: { send }, generations: { getGeneration } },
        requestTimeoutMs: 900_000,
        remainingReviewMs,
      })
      const stubs = makeOrchestrateDeps({
        remainingReviewMs,
        generateFindings: createPromptedGenerateFindings(
          {
            openrouterClient: client,
            model: "test/model",
            fallbackModel: "fallback/model",
          },
          createTestLogger(),
        ),
      })
      const pending = orchestrate(stubs.deps, createTestLogger())
      await vi.advanceTimersByTimeAsync(1000)
      const result = await pending
      const expectedCost = renderCostSummary({
        attempts: [
          {
            phase: "combined",
            model: "test/model",
            outcome: "accepted",
            promptTokens: 10,
            completionTokens: 20,
            costUsd: null,
            errorSummary: null,
          },
        ],
        modelUsed: "test/model",
      })
      expect(remainingReviewMs()).toBe(0)
      expect(send).toHaveBeenCalledTimes(1)
      expect(getGeneration).toHaveBeenCalledExactlyOnceWith(
        { id: "accepted-before-deadline" },
        { retries: { strategy: "none" }, signal: expect.any(AbortSignal) },
      )
      expect(result).toEqual({
        findingsCount: expectedSelection.selected.length,
        reviewUrl: "https://github.com/test/review/1",
        modelUsed: "test/model",
        skippedReason: "",
        phases: [{ phase: "combined", status: "completed" }],
        reviewSummaryMarkdown: expectedReviewSummary(),
        costSummaryMarkdown: expectedCost,
        conventionsNote: null,
      })
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        expectedStatus({
          isFirstRun: true,
          postedCount: expectedSelection.selected.length,
          totalCount: expectedSelection.selected.length,
        }),
      ])
      expect(stubs.postFindingsReviewCalls).toEqual([
        expectedFindingsReview(expectedSelection.selected),
      ])
      expect(stubs.updateCheckRunCalls).toEqual([
        {
          checkRunId: 555,
          conclusion: "success",
          output: {
            title: `${expectedSelection.selected.length} findings`,
            summary: `Reviewed with \`test/model\` — ${expectedSelection.selected.length} findings posted.\n\n${expectedCost}`,
          },
        },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("publishes completed parallel phases once when a provider ignores the review deadline abort", async () => {
    vi.useFakeTimers()
    try {
      const deadline = Date.now() + 1000
      const remainingReviewMs = () => deadline - Date.now()
      const lateResponse = Promise.withResolvers<unknown>()
      const response = {
        id: "completed",
        model: "test/model",
        choices: [{ message: { content: JSON.stringify(fixtureReviewResponse) } }],
        usage: { promptTokens: 10, completionTokens: 20, cost: 0.01 },
      }
      const send = vi
        .fn()
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(response)
        .mockImplementation(() => lateResponse.promise)
      const client = createOpenRouterClient({
        sdk: { chat: { send }, generations: { getGeneration: vi.fn() } },
        requestTimeoutMs: 900_000,
        remainingReviewMs,
      })
      const stubs = makeOrchestrateDeps({
        config: { phases: "parallel" },
        remainingReviewMs,
        generateFindings: createPromptedGenerateFindings(
          {
            openrouterClient: client,
            model: "test/model",
            fallbackModel: "fallback/model",
          },
          createTestLogger(),
        ),
      })
      const pending = orchestrate(stubs.deps, createTestLogger())
      await vi.advanceTimersByTimeAsync(1000)
      const result = await pending
      expect(send).toHaveBeenCalledTimes(3)
      expect(result.phases).toEqual([
        { phase: "correctness-security", status: "completed" },
        { phase: "conventions-tests", status: "completed" },
        {
          phase: "subtle-bugs",
          status: "failed",
          reason: "[ReviewRequestError]: review deadline exceeded",
        },
      ])
      expect(stubs.postFindingsReviewCalls).toEqual([
        expectedFindingsReview(expectedSelection.selected),
      ])
      expect(result.reviewSummaryMarkdown).toEqual(
        expectedReviewSummary({
          phasesCompleted: ["correctness-security", "conventions-tests"],
          phasesIncomplete: ["subtle-bugs"],
          reviewDeadlineExceeded: true,
          totalFromModel: fixtureReviewResponse.findings.length * 2,
          duplicatesAcrossPhases: fixtureReviewResponse.findings.length,
        }),
      )
      expect(stubs.upsertSummaryCommentCalls).toEqual([
        {
          ...expectedStatus({
            isFirstRun: true,
            postedCount: expectedSelection.selected.length,
            totalCount: expectedSelection.selected.length,
            incompletePhases: ["subtle-bugs"],
          }),
          body: buildStatusComment({
            sha: fixturePrContext.headSha,
            isFirstRun: true,
            postedCount: expectedSelection.selected.length,
            unpostedCount: 0,
            totalCount: expectedSelection.selected.length,
            droppedByCap: [],
            model: "test/model",
            contextNotes: [],
            incompletePhases: ["subtle-bugs"],
            reviewDeadlineExceeded: true,
          }),
        },
      ])
      const published = structuredClone({
        checks: stubs.updateCheckRunCalls,
        statuses: stubs.upsertSummaryCommentCalls,
        reviews: stubs.postFindingsReviewCalls,
        result,
      })
      lateResponse.resolve(response)
      await vi.runAllTimersAsync()
      expect({
        checks: stubs.updateCheckRunCalls,
        statuses: stubs.upsertSummaryCommentCalls,
        reviews: stubs.postFindingsReviewCalls,
        result,
      }).toEqual(published)
    } finally {
      vi.useRealTimers()
    }
  })

  it("tags each parallel phase's client log lines with that phase", async () => {
    const response = {
      id: "completed",
      model: "test/model",
      choices: [{ message: { content: JSON.stringify(fixtureReviewResponse) } }],
      usage: { promptTokens: 10, completionTokens: 20, cost: 0.01 },
    }

    // correctness-security is dispatched first, so a logger shared across the
    // concurrent calls would already carry a later phase when its failure logs.
    // The failure is keyed on that phase's prompt text, not on call order
    const correctnessSecurityPassScope = "this pass covers correctness & security"
    const failedPrompts = new Set<string>()
    const send = vi.fn(async ({ chatRequest }: { chatRequest: ChatRequestSubset }) => {
      const systemPrompt = first(chatRequest.messages).content
      const isFirstCorrectnessSecurityRequest =
        systemPrompt.includes(correctnessSecurityPassScope) && !failedPrompts.has(systemPrompt)

      if (isFirstCorrectnessSecurityRequest) {
        failedPrompts.add(systemPrompt)
        throw Object.assign(new Error("HTTP 500"), { statusCode: 500 })
      }
      return response
    })
    const client = createOpenRouterClient({
      sdk: { chat: { send }, generations: { getGeneration: vi.fn() } },
      requestTimeoutMs: 900_000,
      remainingReviewMs: () => Infinity,
      retryDelayMs: 0,
    })
    const generateLogger = createTestLogger()
    const stubs = makeOrchestrateDeps({
      config: { phases: "parallel" },
      generateFindings: createPromptedGenerateFindings(
        { openrouterClient: client, model: "test/model", fallbackModel: null },
        generateLogger,
      ),
    })

    const result = await orchestrate(stubs.deps, createTestLogger())

    // Completion order depends on scheduling; which phase each line names is
    // what this test checks, so the accepted lines are compared by phase
    const acceptedByPhase = logsWithMessage(generateLogger, "review response accepted").toSorted(
      (left, right) => String(left.data.phase).localeCompare(String(right.data.phase)),
    )
    const acceptedEntry = (phase: string, totalAttemptCount: number) => ({
      level: "info",
      message: "review response accepted",
      data: {
        phase,
        model: "test/model",
        routedModel: "test/model",
        generationId: "completed",
        totalAttemptCount,
      },
    })

    expect(result.phases).toEqual([
      { phase: "correctness-security", status: "completed" },
      { phase: "conventions-tests", status: "completed" },
      { phase: "subtle-bugs", status: "completed" },
    ])
    expect(send).toHaveBeenCalledTimes(4)
    expect(logsWithMessage(generateLogger, "review attempt failed")).toEqual([
      {
        level: "warn",
        message: "review attempt failed",
        data: {
          phase: "correctness-security",
          model: "test/model",
          modelAttemptNumber: 1,
          outcome: "api_error",
          errorSummary: "HTTP 500: HTTP 500",
        },
      },
    ])
    expect(acceptedByPhase).toEqual([
      acceptedEntry("conventions-tests", 1),
      acceptedEntry("correctness-security", 2),
      acceptedEntry("subtle-bugs", 1),
    ])
  })

  it("posts the surviving phases' findings when one phase fails, naming the gap on the status comment and the check run", async () => {
    const timeoutAttempt: ModelAttempt = {
      model: "test/model",
      outcome: "timeout",
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      errorSummary: "no response within 900s",
    }
    const stubs = makeOrchestrateDeps({
      config: { phases: "parallel" },
      generateFindings: async (reviewContext) => {
        stubs.generateFindingsCalls.push(reviewContext)
        if (reviewContext.phase.id === "subtle-bugs") {
          throw new ReviewRequestError({
            message: "review request failed after 1 attempt(s)",
            attempts: [timeoutAttempt],
            keyRejected: false,
          })
        }
        return {
          review: fixtureReviewResponse,
          modelUsed: "test/model",
          attempts: [fixtureAttempt],
        }
      },
    })
    const logger = createTestLogger()

    const result = await orchestrate(stubs.deps, logger)

    const expectedCost = renderCostSummary({
      attempts: [
        { ...fixtureAttempt, phase: "correctness-security" },
        { ...fixtureAttempt, phase: "conventions-tests" },
        { ...timeoutAttempt, phase: "subtle-bugs" },
      ],
      modelUsed: "test/model",
    })
    expect(result).toEqual({
      findingsCount: expectedSelection.selected.length,
      reviewUrl: "https://github.com/test/review/1",
      modelUsed: "test/model",
      skippedReason: "",
      phases: [
        { phase: "correctness-security", status: "completed" },
        { phase: "conventions-tests", status: "completed" },
        {
          phase: "subtle-bugs",
          status: "failed",
          reason: "[ReviewRequestError]: review request failed after 1 attempt(s)",
        },
      ],
      reviewSummaryMarkdown: expectedReviewSummary({
        phasesCompleted: ["correctness-security", "conventions-tests"],
        phasesIncomplete: ["subtle-bugs"],
        totalFromModel: fixtureReviewResponse.findings.length * 2,
        duplicatesAcrossPhases: fixtureReviewResponse.findings.length,
      }),
      costSummaryMarkdown: expectedCost,
      conventionsNote: null,
    })
    expect(stubs.postFindingsReviewCalls).toEqual([
      expectedFindingsReview(expectedSelection.selected),
    ])
    expect(stubs.upsertSummaryCommentCalls).toEqual([
      expectedStatus({
        isFirstRun: true,
        postedCount: expectedSelection.selected.length,
        totalCount: expectedSelection.selected.length,
        incompletePhases: ["subtle-bugs"],
      }),
    ])
    expect(stubs.updateCheckRunCalls).toEqual([
      {
        checkRunId: 555,
        conclusion: "success",
        output: {
          title: `${expectedSelection.selected.length} findings (1 of 3 phases incomplete)`,
          summary: `Reviewed with \`test/model\` — ${expectedSelection.selected.length} findings posted.\n\nIncomplete phases: \`subtle-bugs\` ([ReviewRequestError]: review request failed after 1 attempt(s))\n\n${expectedCost}`,
        },
      },
    ])
  })

  it("fails the run with every phase's error when no phase completes", async () => {
    const stubs = makeOrchestrateDeps({
      config: { phases: "parallel" },
      generateFindings: async (reviewContext) => {
        throw new Error(`${reviewContext.phase.id} exploded`)
      },
    })
    const logger = createTestLogger()

    const expectedMessage =
      "every review phase failed: correctness-security: [Error]: correctness-security exploded; conventions-tests: [Error]: conventions-tests exploded; subtle-bugs: [Error]: subtle-bugs exploded"
    await expect(orchestrate(stubs.deps, logger)).rejects.toThrow(expectedMessage)
    expect(stubs.postFindingsReviewCalls).toEqual([])
    expect(stubs.updateCheckRunCalls).toEqual([
      {
        checkRunId: 555,
        conclusion: "failure",
        output: {
          title: "Error — review did not complete",
          summary: `[AllPhasesFailedError]: ${expectedMessage}`,
        },
      },
    ])
  })

  it("continues a sequential run when an early phase fails non-fatally", async () => {
    const stubs = makeOrchestrateDeps({
      config: { phases: "sequential" },
      generateFindings: async (reviewContext) => {
        stubs.generateFindingsCalls.push(reviewContext)
        if (reviewContext.phase.id === "correctness-security") {
          throw new Error("model returned invalid JSON")
        }
        return {
          review: fixtureReviewResponse,
          modelUsed: "test/model",
          attempts: [fixtureAttempt],
        }
      },
    })
    const logger = createTestLogger()

    const result = await orchestrate(stubs.deps, logger)

    expect(stubs.generateFindingsCalls.map((call) => call.phase.id)).toEqual([
      "correctness-security",
      "conventions-tests",
      "subtle-bugs",
    ])
    expect(result.findingsCount).toBeGreaterThan(0)
    expect(
      result.phases.map((phaseStatus) => ({
        phase: phaseStatus.phase,
        status: phaseStatus.status,
      })),
    ).toEqual([
      { phase: "correctness-security", status: "failed" },
      { phase: "conventions-tests", status: "completed" },
      { phase: "subtle-bugs", status: "completed" },
    ])
  })

  it("stops a sequential run after an auth/credit abort and reports the skipped phases", async () => {
    const billedAttempt: ModelAttempt = {
      model: "test/model",
      outcome: "api_error",
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      errorSummary: "HTTP 402: HTTP 402",
    }
    const stubs = makeOrchestrateDeps({
      config: { phases: "sequential" },
      generateFindings: async (reviewContext) => {
        stubs.generateFindingsCalls.push(reviewContext)
        throw new ReviewRequestError({
          message: "OpenRouter auth/credit error — aborting without fallback",
          attempts: [billedAttempt],
          keyRejected: true,
        })
      },
    })
    const logger = createTestLogger()

    const notAttempted = "[Error]: not attempted: an earlier phase aborted on an auth/credit error"
    const expectedMessage = `every review phase failed: correctness-security: [ReviewRequestError]: OpenRouter auth/credit error — aborting without fallback; conventions-tests: ${notAttempted}; subtle-bugs: ${notAttempted}`
    await expect(orchestrate(stubs.deps, logger)).rejects.toThrow(expectedMessage)
    expect(stubs.generateFindingsCalls.map((call) => call.phase.id)).toEqual([
      "correctness-security",
    ])
    expect(stubs.updateCheckRunCalls).toEqual([
      {
        checkRunId: 555,
        conclusion: "failure",
        output: {
          title: "Error — review did not complete",
          summary: `[AllPhasesFailedError]: ${expectedMessage}\n\n${renderCostSummary({
            attempts: [{ ...billedAttempt, phase: "correctness-security" }],
            modelUsed: "test/model",
          })}`,
        },
      },
    ])
  })

  it("carries the billed attempts into the failure summary when every phase fails", async () => {
    const timeoutAttempt: ModelAttempt = {
      model: "test/model",
      outcome: "timeout",
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      errorSummary: "no response within 900s",
    }
    const stubs = makeOrchestrateDeps({
      generateFindings: async () => {
        throw new ReviewRequestError({
          message: "review request failed after 1 attempt(s)",
          attempts: [timeoutAttempt],
          keyRejected: false,
        })
      },
    })
    const logger = createTestLogger()

    await expect(orchestrate(stubs.deps, logger)).rejects.toThrow(
      "every review phase failed: combined: [ReviewRequestError]: review request failed after 1 attempt(s)",
    )
    expect(stubs.updateCheckRunCalls).toEqual([
      {
        checkRunId: 555,
        conclusion: "failure",
        output: {
          title: "Error — review did not complete",
          summary: `[AllPhasesFailedError]: every review phase failed: combined: [ReviewRequestError]: review request failed after 1 attempt(s)\n\n${renderCostSummary(
            {
              attempts: [{ ...timeoutAttempt, phase: "combined" }],
              modelUsed: "test/model",
            },
          )}`,
        },
      },
    ])
  })

  it("leaves the cost table out of the failure summary when cost_summary is off", async () => {
    const timeoutAttempt: ModelAttempt = {
      model: "test/model",
      outcome: "timeout",
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      errorSummary: "no response within 900s",
    }
    const stubs = makeOrchestrateDeps({
      config: { costSummary: false },
      generateFindings: async () => {
        throw new ReviewRequestError({
          message: "review request failed after 1 attempt(s)",
          attempts: [timeoutAttempt],
          keyRejected: false,
        })
      },
    })
    const logger = createTestLogger()

    await expect(orchestrate(stubs.deps, logger)).rejects.toThrow(
      "every review phase failed: combined: [ReviewRequestError]: review request failed after 1 attempt(s)",
    )
    expect(stubs.updateCheckRunCalls).toEqual([
      {
        checkRunId: 555,
        conclusion: "failure",
        output: {
          title: "Error — review did not complete",
          summary:
            "[AllPhasesFailedError]: every review phase failed: combined: [ReviewRequestError]: review request failed after 1 attempt(s)",
        },
      },
    ])
  })

  it("lists each attempted model once in the failure summary", async () => {
    const primaryTimeout: ModelAttempt = {
      model: "test/model",
      outcome: "timeout",
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      errorSummary: "no response within 900s",
    }
    const fallbackTimeout: ModelAttempt = { ...primaryTimeout, model: "fallback/model" }
    const attempts = [primaryTimeout, primaryTimeout, fallbackTimeout]
    const stubs = makeOrchestrateDeps({
      generateFindings: async () => {
        throw new ReviewRequestError({
          message: "review request failed after 3 attempt(s)",
          attempts,
          keyRejected: false,
        })
      },
    })
    const logger = createTestLogger()

    await expect(orchestrate(stubs.deps, logger)).rejects.toThrow(
      "every review phase failed: combined: [ReviewRequestError]: review request failed after 3 attempt(s)",
    )
    expect(stubs.updateCheckRunCalls).toEqual([
      {
        checkRunId: 555,
        conclusion: "failure",
        output: {
          title: "Error — review did not complete",
          summary: `[AllPhasesFailedError]: every review phase failed: combined: [ReviewRequestError]: review request failed after 3 attempt(s)\n\n${renderCostSummary(
            {
              attempts: attempts.map((attempt) => ({ ...attempt, phase: "combined" })),
              modelUsed: "test/model, fallback/model",
            },
          )}`,
        },
      },
    ])
  })

  it("attributes a cross-phase winner to its routed model while reporting all run models", async () => {
    const fixtureLowFinding = fixtureReviewResponse.findings.find((finding) => finding.line === 3)

    if (!fixtureLowFinding) {
      throw new Error("fixture finding on line 3 is missing")
    }
    const fallbackFinding = makeFinding({
      line: 145,
      category: "subtle_bugs",
      severity: "high",
      title: "Fallback phase winner",
    })
    const stubs = makeOrchestrateDeps({
      config: { phases: "parallel" },
      generateFindings: async (reviewContext) => {
        stubs.generateFindingsCalls.push(reviewContext)
        const isFallbackPhase = reviewContext.phase.id === "subtle-bugs"
        return {
          review: isFallbackPhase
            ? { analysis: "checked", findings: [fallbackFinding] }
            : fixtureReviewResponse,
          modelUsed: isFallbackPhase ? "fallback/model" : "test/model",
          attempts: [fixtureAttempt],
        }
      },
    })
    const logger = createTestLogger()

    const result = await orchestrate(stubs.deps, logger)

    expect(result.modelUsed).toBe("test/model, fallback/model")
    const mapped = mapFindingsToReview({
      findings: [
        withRoutedModel(fallbackFinding, "fallback/model"),
        withRoutedModel(fixtureLowFinding, "test/model"),
      ],
      commentableByPath: fixtureCommentableByPath,
    })
    expect(stubs.postFindingsReviewCalls).toEqual([
      {
        prNumber: 7,
        commitId: fixturePrContext.headSha,
        body: REVIEW_MARKER,
        comments: mapped.comments,
      },
    ])
  })

  it("reports zero findings with the incomplete suffix when surviving phases find nothing", async () => {
    const stubs = makeOrchestrateDeps({
      config: { phases: "parallel" },
      generateFindings: async (reviewContext) => {
        stubs.generateFindingsCalls.push(reviewContext)
        if (reviewContext.phase.id === "subtle-bugs") {
          throw new Error("model exploded")
        }
        return {
          review: { analysis: "", findings: [] },
          modelUsed: "test/model",
          attempts: [fixtureAttempt],
        }
      },
    })
    const logger = createTestLogger()

    const result = await orchestrate(stubs.deps, logger)

    const expectedCost = renderCostSummary({
      attempts: [
        { ...fixtureAttempt, phase: "correctness-security" },
        { ...fixtureAttempt, phase: "conventions-tests" },
      ],
      modelUsed: "test/model",
    })
    expect(result).toEqual({
      findingsCount: 0,
      reviewUrl: "",
      modelUsed: "test/model",
      skippedReason: "",
      phases: [
        { phase: "correctness-security", status: "completed" },
        { phase: "conventions-tests", status: "completed" },
        {
          phase: "subtle-bugs",
          status: "failed",
          reason: "[Error]: model exploded",
        },
      ],
      reviewSummaryMarkdown: expectedReviewSummary({
        phasesCompleted: ["correctness-security", "conventions-tests"],
        phasesIncomplete: ["subtle-bugs"],
        totalFromModel: 0,
        duplicatesAcrossPhases: 0,
        posted: 0,
      }),
      costSummaryMarkdown: expectedCost,
      conventionsNote: null,
    })
    expect(stubs.updateCheckRunCalls).toEqual([
      {
        checkRunId: 555,
        conclusion: "success",
        output: {
          title: "No findings above threshold (1 of 3 phases incomplete)",
          summary: `Reviewed with \`test/model\` — no findings above threshold.\n\nIncomplete phases: \`subtle-bugs\` ([Error]: model exploded)\n\n${expectedCost}`,
        },
      },
    ])
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
    const phase = COMBINED_PHASE

    await generate({
      prContext: fixturePrContext,
      phase,
      conventions: "test conventions",
      conventionsFile: "AGENTS.md",
      conventionsBudgetTokens: 8_000,
      changedFiles: [fixtureChangedFile],
      relatedFiles: [],
      relatedDocs: [],
      annotatedDiff: annotateDiff(files),
      priorFindings: [],
      priorBotComments: [],
    })

    // The prompts carry a random delimiter nonce, so each call is mapped to
    // the ladder models under test
    expect(
      requestReviewCalls.map(({ model, fallbackModel }) => ({ model, fallbackModel })),
    ).toEqual([{ model: "test/primary", fallbackModel: "test/fallback" }])
  })

  it("passes requestReview a logger tagged with the review phase", async () => {
    const stubClient: OpenRouterClient = {
      requestReview: async (_params, logger) => {
        logger.info("stub client line")
        return { review: { analysis: "", findings: [] }, modelUsed: "m", attempts: [] }
      },
    }
    const logger = createTestLogger()
    const generate = createPromptedGenerateFindings(
      { openrouterClient: stubClient, model: "m", fallbackModel: null },
      logger,
    )
    const reviewContext: Omit<ReviewContext, "phase"> = {
      prContext: fixturePrContext,
      conventions: null,
      conventionsFile: "AGENTS.md",
      conventionsBudgetTokens: 8_000,
      changedFiles: [],
      relatedFiles: [],
      relatedDocs: [],
      annotatedDiff: annotateDiff(parseDiff(sampleDiff)),
      priorFindings: [],
      priorBotComments: [],
    }

    await generate({ ...reviewContext, phase: COMBINED_PHASE })
    await generate({ ...reviewContext, phase: SUBTLE_BUGS_PHASE })

    expect(logsWithMessage(logger, "stub client line")).toEqual([
      { level: "info", message: "stub client line", data: { phase: "combined" } },
      { level: "info", message: "stub client line", data: { phase: "subtle-bugs" } },
    ])
  })

  it("logs the review request with its phase and ladder models", async () => {
    const stubClient: OpenRouterClient = {
      requestReview: async () => {
        return { review: { analysis: "", findings: [] }, modelUsed: "test/primary", attempts: [] }
      },
    }
    const logger = createTestLogger()
    const generate = createPromptedGenerateFindings(
      { openrouterClient: stubClient, model: "test/primary", fallbackModel: "test/fallback" },
      logger,
    )

    await generate({
      prContext: fixturePrContext,
      phase: SUBTLE_BUGS_PHASE,
      conventions: null,
      conventionsFile: "AGENTS.md",
      conventionsBudgetTokens: 8_000,
      changedFiles: [],
      relatedFiles: [],
      relatedDocs: [],
      annotatedDiff: annotateDiff(parseDiff(sampleDiff)),
      priorFindings: [],
      priorBotComments: [],
    })

    expect(logsWithMessage(logger, "requesting review")).toEqual([
      {
        level: "info",
        message: "requesting review",
        data: {
          phase: "subtle-bugs",
          model: "test/primary",
          fallbackModel: "test/fallback",
        },
      },
    ])
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
    const phase = COMBINED_PHASE
    const annotated = annotateDiff(files)

    await generate({
      prContext: fixturePrContext,
      phase,
      conventions: null,
      conventionsFile: "AGENTS.md",
      conventionsBudgetTokens: 8_000,
      changedFiles: [],
      relatedFiles: [],
      relatedDocs: [],
      annotatedDiff: annotated,
      priorFindings: [],
      priorBotComments: [],
    })

    const call = first(requestReviewCalls)
    expect(call.userPrompt).toContain(
      `note="line numbers shown are new-file line numbers">\n${annotated}\n</diff-`,
    )
  })

  it("labels the user prompt's conventions section with the review context's conventions file", async () => {
    const userPrompts: string[] = []
    const stubClient: OpenRouterClient = {
      requestReview: async (params) => {
        userPrompts.push(params.userPrompt)
        return { review: { analysis: "", findings: [] }, modelUsed: "m", attempts: [] }
      },
    }

    const generate = createPromptedGenerateFindings(
      { openrouterClient: stubClient, model: "m", fallbackModel: null },
      createTestLogger(),
    )

    const { annotateDiff } = await import("../diff/annotate-diff.js")

    await generate({
      prContext: fixturePrContext,
      phase: COMBINED_PHASE,
      conventions: "test conventions",
      conventionsFile: "docs/CONVENTIONS.md",
      conventionsBudgetTokens: 8_000,
      changedFiles: [],
      relatedFiles: [],
      relatedDocs: [],
      annotatedDiff: annotateDiff(parseDiff(sampleDiff)),
      priorFindings: [],
      priorBotComments: [],
    })

    // The nonce is random per call; the backreference pins both tags to the same one
    expect(userPrompts).toEqual([
      expect.stringMatching(
        /<conventions-([a-f0-9]{12}) path="docs\/CONVENTIONS\.md">\ntest conventions\n<\/conventions-\1 path="docs\/CONVENTIONS\.md">/,
      ),
    ])
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
    const phase = COMBINED_PHASE
    const annotated = annotateDiff(files)

    const context: ReviewContext = {
      prContext: fixturePrContext,
      phase,
      conventions: null,
      conventionsFile: "AGENTS.md",
      conventionsBudgetTokens: 8_000,
      changedFiles: [],
      relatedFiles: [],
      relatedDocs: [],
      annotatedDiff: annotated,
      priorFindings: [],
      priorBotComments: [],
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
