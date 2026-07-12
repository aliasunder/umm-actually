import parseDiff from "parse-diff"
import type { ActionConfig } from "./config.js"
import {
  computeCommentableLines,
  newFilePath,
  type CommentableFile,
} from "./diff/commentable-lines.js"
import { annotateDiff } from "./diff/annotate-diff.js"
import type { Logger } from "./logger.js"
import type { GithubClient } from "./github/client.js"
import { resolvePullRequestEvent, type PrContext } from "./github/event.js"
import type {
  OpenRouterClient,
  StructuredReviewResult,
} from "./openrouter/client.js"
import { renderCostSummary } from "./openrouter/cost-summary.js"
import type { ContextReader } from "./context/workspace.js"
import {
  buildReviewBody,
  buildZeroFindingsBody,
  mapFindingsToReview,
  type ReviewComment,
} from "./review/comment-mapping.js"
import { resolveSeverityThreshold, type Finding } from "./review/finding.js"
import { resolvePhases, type ReviewPhase } from "./review/phases.js"
import {
  buildSystemPrompt,
  buildUserPrompt,
  estimateTokens,
  generateDelimiterNonce,
  type PromptFile,
} from "./review/prompt.js"
import { selectFindings } from "./review/select-findings.js"

export type ReviewContext = {
  prContext: PrContext
  phase: ReviewPhase
  conventions: string | null
  changedFiles: PromptFile[]
  relatedFiles: PromptFile[]
  annotatedDiff: string
  priorFindings: Finding[]
}

export type GenerateFindings = (
  reviewContext: ReviewContext,
) => Promise<StructuredReviewResult>

export type OrchestrateResult = {
  findingsCount: number
  reviewUrl: string
  modelUsed: string
  skippedReason: string
  costSummaryMarkdown: string | null
}

export type OrchestrateDeps = {
  config: ActionConfig
  eventName: string
  payload: unknown
  githubClient: GithubClient
  contextReader: ContextReader
  generateFindings: GenerateFindings
}

const buildSkipBody = (reason: string): string =>
  `**umm-actually** — review skipped\n\n${reason}\n\n---\n*umm-actually*`

type ReviewPayload = {
  body: string
  comments: ReviewComment[]
  fallbackBody: string
}

/** Separates findings into inline comments and body-only findings, then
 *  builds a fallback body that includes all findings in case GitHub rejects
 *  the inline anchors. */
const buildReviewPayload = ({
  findings,
  commentableByPath,
  droppedByCap,
  modelUsed,
}: {
  findings: Finding[]
  commentableByPath: Map<string, CommentableFile>
  droppedByCap: Finding[]
  modelUsed: string
}): ReviewPayload => {
  const { comments, bodyFindings } = mapFindingsToReview({
    findings,
    commentableByPath,
  })
  const body = buildReviewBody({
    bodyFindings,
    droppedByCap,
    model: modelUsed,
  })
  const fallbackBody = buildReviewBody({
    bodyFindings: findings,
    droppedByCap,
    model: modelUsed,
    bodyFindingsHeading: "Findings",
    bodyFindingsDescription:
      "Inline comments were unavailable; all findings are listed here:",
  })
  return { body, comments, fallbackBody }
}

const SKIPPED_RESULT_BASE: Omit<
  OrchestrateResult,
  "reviewUrl" | "skippedReason"
> = {
  findingsCount: 0,
  modelUsed: "",
  costSummaryMarkdown: null,
}

/** Runs the full review pipeline — event resolution through review posting —
 *  with all I/O injected through deps so the pipeline is fully testable. */
export const orchestrate = async (
  deps: OrchestrateDeps,
  logger: Logger,
): Promise<OrchestrateResult> => {
  const { config, githubClient, contextReader, generateFindings } = deps

  // Step 1: fail-fast validation — throws before any network call
  const severityThreshold = resolveSeverityThreshold(config.severityThreshold)
  const phases = resolvePhases(config.phases)

  // Step 2: event resolution
  const resolvedEvent = resolvePullRequestEvent(
    {
      eventName: deps.eventName,
      payload: deps.payload,
      prNumberOverride: config.prNumberOverride,
    },
    logger,
  )

  if (resolvedEvent.kind === "not_a_pr") {
    logger.info("not a PR event — skipping", { reason: resolvedEvent.reason })
    return {
      ...SKIPPED_RESULT_BASE,
      reviewUrl: "",
      skippedReason: resolvedEvent.reason,
    }
  }

  // Step 3: PR context
  const prContext: PrContext =
    resolvedEvent.kind === "complete"
      ? resolvedEvent.context
      : await githubClient.fetchPullRequest({
          prNumber: resolvedEvent.prNumber,
        })

  const postSkipReview = async (reason: string): Promise<OrchestrateResult> => {
    const body = buildSkipBody(reason)
    const { url } = await githubClient.submitReview({
      prNumber: prContext.prNumber,
      commitId: prContext.headSha,
      body,
      comments: [],
      fallbackBody: body,
    })
    logger.info("posted skip review", { reason, reviewUrl: url })
    return { ...SKIPPED_RESULT_BASE, reviewUrl: url, skippedReason: reason }
  }

  // Step 4: diff fetch
  const diffResult = await githubClient.fetchDiff({
    prNumber: prContext.prNumber,
  })
  if (diffResult.kind === "too_large") {
    return postSkipReview("diff exceeds GitHub's diff API limits")
  }

  // Step 5: parse diff
  const files = parseDiff(diffResult.diff)
  if (files.length === 0) {
    return postSkipReview("empty diff")
  }

  // Step 6: annotate + token check
  const annotatedDiff = annotateDiff(files)
  const diffTokens = estimateTokens(annotatedDiff)
  const budgetHalf = Math.floor(config.contextBudgetTokens / 2)
  if (diffTokens > budgetHalf) {
    return postSkipReview(
      `diff too large for context budget (${diffTokens} tokens, budget ${config.contextBudgetTokens})`,
    )
  }

  // Step 7: commentable lines
  const commentableByPath = computeCommentableLines(files)

  // Step 8: extract changed paths
  const changedPaths = files
    .map((file) => newFilePath(file))
    .filter((path): path is string => path !== null)

  // Step 9: context reads
  const conventions = await contextReader.readConventions({
    conventionsFile: config.conventionsFile,
  })

  const fileBudgetTokens = config.contextBudgetTokens - diffTokens
  const { files: changedFiles, remainingTokens } =
    await contextReader.readChangedFiles({
      changedPaths,
      budgetTokens: fileBudgetTokens,
    })

  const relatedFiles = config.traceRelatedFiles
    ? await contextReader.findRelatedFiles({
        changedPaths,
        budgetTokens: remainingTokens,
      })
    : []

  // Step 10–11: generate findings (V1: single combined phase)
  const phase = phases[0]
  if (phase === undefined) {
    throw new Error("resolvePhases returned no phases")
  }
  const structuredResult = await generateFindings({
    prContext,
    phase,
    conventions,
    changedFiles,
    relatedFiles,
    annotatedDiff,
    priorFindings: [],
  })

  const { modelUsed, attempts } = structuredResult

  // Step 12: select findings
  const { selected, droppedByCap } = selectFindings({
    findings: structuredResult.review.findings,
    severityThreshold,
    maxFindings: config.maxFindings,
  })

  // Step 13: post review
  const hasFindings = selected.length > 0

  const reviewPayload: ReviewPayload = hasFindings
    ? buildReviewPayload({
        findings: selected,
        commentableByPath,
        droppedByCap,
        modelUsed,
      })
    : {
        body: buildZeroFindingsBody({ model: modelUsed }),
        comments: [],
        fallbackBody: buildZeroFindingsBody({ model: modelUsed }),
      }

  const { url: reviewUrl } = await githubClient.submitReview({
    prNumber: prContext.prNumber,
    commitId: prContext.headSha,
    ...reviewPayload,
  })

  logger.info("review posted", {
    reviewUrl,
    findingsCount: selected.length,
    modelUsed,
  })

  // Step 14: cost summary
  const costSummaryMarkdown = renderCostSummary({ attempts, modelUsed })

  return {
    findingsCount: selected.length,
    reviewUrl,
    modelUsed,
    skippedReason: "",
    costSummaryMarkdown,
  }
}

/** V1 one-shot strategy — builds a prompt from the review context and sends
 *  it to OpenRouter. V1.5/V2 will swap in different strategies behind the
 *  same GenerateFindings interface. */
export const createPromptedGenerateFindings = (
  {
    openrouterClient,
    model,
    fallbackModel,
  }: {
    openrouterClient: OpenRouterClient
    model: string
    fallbackModel: string | null
  },
  logger: Logger,
): GenerateFindings => {
  const log = logger.child({ module: "generateFindings" })

  return async (reviewContext) => {
    const delimiterNonce = generateDelimiterNonce()
    const systemPrompt = buildSystemPrompt({ phase: reviewContext.phase })
    const userPrompt = buildUserPrompt({
      ...reviewContext,
      delimiterNonce,
    })

    log.info("requesting review", { model, fallbackModel })

    return openrouterClient.requestReview({
      systemPrompt,
      userPrompt,
      model,
      fallbackModel,
    })
  }
}
