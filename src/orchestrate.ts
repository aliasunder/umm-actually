import parseDiff from "parse-diff"
import type { ActionConfig } from "./config.js"
import {
  computeCommentableLines,
  newFilePath,
} from "./diff/commentable-lines.js"
import { annotateDiff } from "./diff/annotate-diff.js"
import type { Logger } from "./logger.js"
import type {
  CheckRunConclusion,
  CheckRunOutput,
  GithubClient,
} from "./github/client.js"
import { resolvePullRequestEvent, type PrContext } from "./github/event.js"
import type {
  OpenRouterClient,
  StructuredReviewResult,
} from "./openrouter/client.js"
import { renderCostSummary } from "./openrouter/cost-summary.js"
import type { ContextReader } from "./context/workspace.js"
import {
  buildStatusComment,
  coalesceAnchors,
  extractAnchors,
  isDuplicateFinding,
  mapFindingsToReview,
  renderStandaloneFinding,
  REVIEW_MARKER,
  STATUS_ANCHOR,
  type AnchorEntry,
  type ReviewComment,
} from "./review/comment-mapping.js"
import { buildContextNotes } from "./review/context-notes.js"
import {
  resolveSeverityThreshold,
  type Finding,
  type FindingSeverity,
} from "./review/finding.js"
import { resolvePhases, type ReviewPhase } from "./review/phases.js"
import {
  buildSystemPrompt,
  buildUserPrompt,
  conventionsRenderInFull,
  estimateTokens,
  generateDelimiterNonce,
  type PromptFile,
} from "./review/prompt.js"
import { filterNonFindings } from "./review/filter-non-findings.js"
import { renderReviewSummary } from "./review/review-summary.js"
import { selectFindings } from "./review/select-findings.js"

export type ReviewContext = {
  prContext: PrContext
  phase: ReviewPhase
  conventions: string | null
  changedFiles: PromptFile[]
  relatedFiles: PromptFile[]
  relatedDocs: PromptFile[]
  annotatedDiff: string
  priorFindings: Finding[]
  priorBotComments: string[]
}

export type GenerateFindings = (
  reviewContext: ReviewContext,
) => Promise<StructuredReviewResult>

export type OrchestrateResult = {
  findingsCount: number
  reviewUrl: string
  modelUsed: string
  skippedReason: string
  reviewSummaryMarkdown: string | null
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

/** Bounds token cost of prior bot comments in the prompt (~200 tokens each). */
const PRIOR_COMMENT_CAP = 30

/** Strips the trailing dedup anchor from a comment body so the model
 *  doesn't see the dedup infrastructure in the prior-comments section. */
const stripAnchorComment = (body: string): string =>
  body.replace(/\n*<!-- umm-actually:.+? -->\s*$/, "")

const buildSkipBody = (reason: string): string =>
  `**umm-actually** — review skipped\n\n${reason}\n\n---\n*umm-actually*`

const describeError = (error: unknown): string => {
  return error instanceof Error
    ? `[${error.name}]: ${error.message}`
    : String(error)
}

type InlineCommentState = {
  anchors: AnchorEntry[]
  commentBodies: string[]
}

/** Anchors and raw bodies from the bot's inline review comments. Empty on
 *  fetch failure — findings then post as new; duplicates beat losing them. */
const fetchInlineCommentState = async (
  { githubClient, prNumber }: { githubClient: GithubClient; prNumber: number },
  logger: Logger,
): Promise<InlineCommentState> => {
  try {
    const existingComments = await githubClient.fetchBotReviewComments({
      prNumber,
    })
    return {
      anchors: extractAnchors(existingComments),
      commentBodies: existingComments.map((comment) => comment.body),
    }
  } catch (fetchError) {
    logger.warn(
      "failed to fetch inline comments — treating their findings as new",
      { error: describeError(fetchError) },
    )
    return { anchors: [], commentBodies: [] }
  }
}

type IssueCommentState = {
  statusCommentExists: boolean
  anchors: AnchorEntry[]
  findingBodies: string[]
}

/** The bot's issue comments carry the rest of the cross-run state: the
 *  status comment's presence (the first-run signal) and dedup anchors from
 *  beyond-diff finding comments (anchor-line positions — issue comments
 *  aren't line-tracked). Fails open to a first run. */
const fetchIssueCommentState = async (
  { githubClient, prNumber }: { githubClient: GithubClient; prNumber: number },
  logger: Logger,
): Promise<IssueCommentState> => {
  try {
    const comments = await githubClient.fetchBotIssueComments({ prNumber })
    const findingComments = comments.filter(
      (comment) => !comment.body.startsWith(STATUS_ANCHOR),
    )
    return {
      // startsWith, not includes: a finding comment's model-generated text
      // could quote the marker mid-body and misclassify the run as a re-run.
      statusCommentExists: comments.length > findingComments.length,
      anchors: extractAnchors(
        findingComments.map((comment) => ({
          body: comment.body,
          line: null,
          originalLine: null,
        })),
      ),
      findingBodies: findingComments.map((comment) => comment.body),
    }
  } catch (fetchError) {
    logger.warn("failed to fetch issue comments — treating as a first run", {
      error: describeError(fetchError),
    })
    return { statusCommentExists: false, anchors: [], findingBodies: [] }
  }
}

type InlinePostOutcome = {
  url: string
  /** Findings whose anchors GitHub rejected — re-routed to issue comments. */
  rerouted: Finding[]
  /** Inline comments that actually landed — zero when the post failed. */
  postedCount: number
}

/** Posts the anchorable findings as one review with an invisible marker
 *  body — the batching vehicle, not a narrative surface. A 422 re-routes
 *  the findings to issue comments; any other failure leaves them unposted,
 *  where the missing anchors make the next run re-report them. */
const postInlineFindings = async (
  {
    githubClient,
    prNumber,
    commitId,
    comments,
    inlineFindings,
  }: {
    githubClient: GithubClient
    prNumber: number
    commitId: string
    comments: ReviewComment[]
    inlineFindings: Finding[]
  },
  logger: Logger,
): Promise<InlinePostOutcome> => {
  if (comments.length === 0) return { url: "", rerouted: [], postedCount: 0 }
  try {
    const result = await githubClient.postFindingsReview({
      prNumber,
      commitId,
      body: REVIEW_MARKER,
      comments,
    })
    if (result.kind === "rejected") {
      return { url: "", rerouted: inlineFindings, postedCount: 0 }
    }
    logger.info("findings review posted", {
      reviewUrl: result.url,
      inlineCount: comments.length,
    })
    return { url: result.url, rerouted: [], postedCount: comments.length }
  } catch (postError) {
    logger.warn(
      "failed to post findings review — findings will re-report next run",
      { error: describeError(postError) },
    )
    return { url: "", rerouted: [], postedCount: 0 }
  }
}

const SKIPPED_RESULT_BASE: Omit<
  OrchestrateResult,
  "reviewUrl" | "skippedReason"
> = {
  findingsCount: 0,
  modelUsed: "",
  reviewSummaryMarkdown: null,
  costSummaryMarkdown: null,
}

type CheckRunHandle = { checkRunId: number } | null

/** Best-effort: a token without `checks: write` (the permission is optional
 *  for consumers) must degrade to an unbranded run, never fail the review. */
const createCheckRunSafely = async (
  { githubClient, headSha }: { githubClient: GithubClient; headSha: string },
  logger: Logger,
): Promise<CheckRunHandle> => {
  const CHECK_RUN_NAME = "umm-actually"
  try {
    const checkRun = await githubClient.createCheckRun({
      headSha,
      name: CHECK_RUN_NAME,
    })
    logger.info("check run created", { checkRunId: checkRun.checkRunId })
    return checkRun
  } catch (createError) {
    logger.warn("failed to create check run — review continues without one", {
      error: describeError(createError),
    })
    return null
  }
}

/** No-op without a handle; an update failure only costs the check its
 *  conclusion (it lingers in progress), so it never masks the review
 *  outcome or the pipeline error being propagated. */
const completeCheckRunSafely = async (
  {
    githubClient,
    checkRun,
    conclusion,
    output,
  }: {
    githubClient: GithubClient
    checkRun: CheckRunHandle
    conclusion: CheckRunConclusion
    output: CheckRunOutput
  },
  logger: Logger,
): Promise<void> => {
  if (!checkRun) return
  try {
    await githubClient.updateCheckRun({
      checkRunId: checkRun.checkRunId,
      conclusion,
      output,
    })
    logger.info("check run completed", {
      checkRunId: checkRun.checkRunId,
      conclusion,
    })
  } catch (updateError) {
    logger.warn("failed to complete check run — it will linger in progress", {
      checkRunId: checkRun.checkRunId,
      error: describeError(updateError),
    })
  }
}

/** Maps the pipeline outcome to the check's conclusion and details page.
 *  The conclusion grades the run, not the code: a completed review is
 *  `success` whether or not it posted findings (the count lives in the
 *  title), a skip is `neutral` (no review happened), and `failure` is
 *  reserved for the pipeline itself erroring. */
const resolveCheckRunCompletion = ({
  result,
  costSummaryMarkdown,
}: {
  result: OrchestrateResult
  costSummaryMarkdown: string | null
}): { conclusion: CheckRunConclusion; output: CheckRunOutput } => {
  const costSection = costSummaryMarkdown ? `\n\n${costSummaryMarkdown}` : ""
  if (result.skippedReason) {
    return {
      conclusion: "neutral",
      output: {
        title: `Skipped — ${result.skippedReason}`,
        summary: `Review skipped: ${result.skippedReason}${costSection}`,
      },
    }
  }
  if (result.findingsCount === 0) {
    return {
      conclusion: "success",
      output: {
        title: "No findings above threshold",
        summary: `Reviewed with \`${result.modelUsed}\` — no findings above threshold.${costSection}`,
      },
    }
  }
  const findingsLabel =
    result.findingsCount === 1
      ? "1 finding"
      : `${result.findingsCount} findings`
  return {
    conclusion: "success",
    output: {
      title: findingsLabel,
      summary: `Reviewed with \`${result.modelUsed}\` — ${findingsLabel} posted.${costSection}`,
    },
  }
}

/** Steps 4–14: diff fetch through status comment — everything downstream of
 *  PR-context resolution, extracted so orchestrate can bracket it with the
 *  check-run lifecycle. */
const runReviewPipeline = async (
  {
    deps,
    prContext,
    severityThreshold,
    phases,
  }: {
    deps: OrchestrateDeps
    prContext: PrContext
    severityThreshold: FindingSeverity
    phases: ReviewPhase[]
  },
  logger: Logger,
): Promise<OrchestrateResult> => {
  const { config, githubClient, contextReader, generateFindings } = deps

  const postSkipReview = async (reason: string): Promise<OrchestrateResult> => {
    const body = buildSkipBody(reason)
    const { url } = await githubClient.submitReview({
      prNumber: prContext.prNumber,
      commitId: prContext.headSha,
      body,
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
      `diff too large for context budget (${diffTokens} tokens, limit ${budgetHalf} of ${config.contextBudgetTokens})`,
    )
  }

  // Step 7: commentable lines
  const commentableByPath = computeCommentableLines(files)

  // Step 8: extract changed paths (includes old path for renames so the
  // import scanner finds callers that still reference the pre-rename path)
  const changedPaths = files
    .flatMap((file) => {
      const toPath = newFilePath(file)
      const isRename =
        toPath !== null &&
        file.from !== undefined &&
        file.from !== "/dev/null" &&
        file.from !== file.to
      return isRename ? [toPath, file.from] : [toPath]
    })
    .filter((path): path is string => path !== null)

  // Step 9: context reads
  const conventions = await contextReader.readConventions({
    conventionsFile: config.conventionsFile,
  })

  // The conventions file has its own prompt section. When that section carries
  // the whole file, a changed conventions file would be rendered twice — so the
  // changed-files channel carries it diff-only. When the section is truncated
  // instead, the changed-files copy is the only full one and stays full.
  const conventionsAlreadyRenderedInFull =
    conventions !== null && conventionsRenderInFull(conventions)

  const fileBudgetTokens = config.contextBudgetTokens - diffTokens
  const { files: changedFiles, remainingTokens } =
    await contextReader.readChangedFiles({
      changedPaths,
      budgetTokens: fileBudgetTokens,
      diffOnlyPaths: conventionsAlreadyRenderedInFull
        ? [config.conventionsFile]
        : [],
    })

  const relatedFilesResult = config.traceRelatedFiles
    ? await contextReader.findRelatedFiles({
        changedPaths,
        budgetTokens: remainingTokens,
      })
    : { files: [], excludedByCapPaths: [] }

  const relatedFiles = relatedFilesResult.files
  const relatedFilesTokens = relatedFiles.reduce(
    (sum, file) => sum + estimateTokens(file.content),
    0,
  )
  const docBudgetTokens = Math.max(0, remainingTokens - relatedFilesTokens)

  // Every path a higher-priority channel already claimed in full. A priority
  // doc found here is in the prompt already; re-reading it would render its
  // full text a second time and spend the budget twice. The conventions file
  // counts only when its section carries the whole file — when that section
  // truncates, its full text has NOT been sent, and the priority-doc channel
  // is the one that can still supply it.
  const priorityDocsInContext = [
    ...changedFiles.map((file) => file.path),
    ...relatedFiles.map((file) => file.path),
    ...(conventionsAlreadyRenderedInFull ? [config.conventionsFile] : []),
  ]

  const { files: priorityDocFiles, remainingTokens: docRemainingTokens } =
    await contextReader.readPriorityDocs({
      priorityDocs: config.priorityDocs,
      budgetTokens: docBudgetTokens,
      excludePaths: priorityDocsInContext,
    })

  const mentionMatchedDocsResult = config.traceRelatedFiles
    ? await contextReader.findRelatedDocs({
        changedPaths,
        budgetTokens: docRemainingTokens,
        conventionsFile: config.conventionsFile,
        excludePaths: config.priorityDocs,
      })
    : { files: [], excludedByCapPaths: [] }

  const relatedDocs = [...priorityDocFiles, ...mentionMatchedDocsResult.files]

  logger.info("context sent to model", {
    conventionsFile: conventions ? config.conventionsFile : "not found",
    changedFilesCount: changedFiles.length,
    changedFilePaths: changedFiles.map((file) => file.path).join(", "),
    relatedFilesCount: relatedFiles.length,
    relatedFilePaths:
      relatedFiles.map((file) => file.path).join(", ") || "none",
    relatedFilesExcludedCount: relatedFilesResult.excludedByCapPaths.length,
    relatedFilesExcludedPaths:
      relatedFilesResult.excludedByCapPaths.join(", ") || "none",
    priorityDocsReadCount: priorityDocFiles.length,
    priorityDocPaths:
      priorityDocFiles.map((file) => file.path).join(", ") || "none",
    mentionMatchedDocsCount: mentionMatchedDocsResult.files.length,
    mentionMatchedDocPaths:
      mentionMatchedDocsResult.files.map((file) => file.path).join(", ") ||
      "none",
    docsExcludedCount: mentionMatchedDocsResult.excludedByCapPaths.length,
    docsExcludedPaths:
      mentionMatchedDocsResult.excludedByCapPaths.join(", ") || "none",
    tokenBudgetTotal: config.contextBudgetTokens,
    tokenBudgetUsedByDiff: diffTokens,
    tokenBudgetRemainingForDocs: docRemainingTokens,
  })

  const contextNotes = buildContextNotes({
    priorityDocs: config.priorityDocs,
    priorityDocsInContext,
    priorityDocsRead: priorityDocFiles,
    relatedFilesExcludedPaths: relatedFilesResult.excludedByCapPaths,
    docsExcludedPaths: mentionMatchedDocsResult.excludedByCapPaths,
  })

  // Step 9.5: fetch prior bot comments — needed both for the prompt (the
  // model sees what's already posted and self-suppresses conceptual dupes)
  // and for positional dedup after generation.
  const inlineState = await fetchInlineCommentState(
    { githubClient, prNumber: prContext.prNumber },
    logger,
  )
  const issueState = await fetchIssueCommentState(
    { githubClient, prNumber: prContext.prNumber },
    logger,
  )
  const priorBotComments = [
    ...inlineState.commentBodies,
    ...issueState.findingBodies,
  ]
    .map(stripAnchorComment)
    .slice(-PRIOR_COMMENT_CAP)

  // Step 10–11: generate findings (V1: single combined phase)
  const phase = phases[0]
  if (!phase) {
    throw new Error("resolvePhases returned no phases")
  }
  const structuredResult = await generateFindings({
    prContext,
    phase,
    conventions,
    changedFiles,
    relatedFiles,
    relatedDocs,
    annotatedDiff,
    priorFindings: [],
    priorBotComments,
  })

  const { modelUsed, attempts } = structuredResult

  // Step 12: filter non-findings before selection so cap slots aren't wasted
  const { findings: realFindings, droppedAsNonFinding } = filterNonFindings(
    structuredResult.review.findings,
  )
  logger.info("non-finding filter applied to model output", {
    totalFromModel: structuredResult.review.findings.length,
    kept: realFindings.length,
    droppedAsNonFinding,
  })

  // Step 12.5: cross-run dedup — every run walks the same path; a first run
  // is just the case where no bot comments exist yet. Sources: the bot's
  // inline comments (live positions) and its beyond-diff issue comments
  // (anchor lines). Runs before the cap so duplicates don't consume slots.
  const existingAnchors = [...inlineState.anchors, ...issueState.anchors]
  const newFindings = realFindings.filter(
    (finding) => !isDuplicateFinding(finding, existingAnchors),
  )

  logger.info("cross-run dedup against prior bot comments", {
    statusCommentFound: issueState.statusCommentExists,
    existingAnchorCount: existingAnchors.length,
    priorBotCommentCount: priorBotComments.length,
    findingsAfterFilter: realFindings.length,
    findingsSurvivedDedup: newFindings.length,
  })

  const {
    selected,
    droppedBelowThreshold,
    droppedAsOverlapping,
    droppedByCap,
  } = selectFindings({
    findings: newFindings,
    severityThreshold,
    maxFindings: config.maxFindings,
  })

  logger.info("findings selected for posting", {
    selected: selected.length,
    droppedBelowThreshold,
    droppedAsOverlapping,
    droppedByCap: droppedByCap.length,
  })

  // Step 13: post findings — anchorable ones batch into a single review
  // (invisible marker body: one notification, a bare "reviewed" timeline
  // event, no prose); the rest post as individual issue comments so every
  // new finding is a visible event. All narration lives in the status
  // comment. Unposted findings carry no anchor and re-report next run.
  const costSummaryMarkdown = renderCostSummary({ attempts, modelUsed })
  const { comments, bodyFindings } = mapFindingsToReview({
    findings: selected,
    commentableByPath,
  })
  const inlineFindings = selected.filter(
    (finding) => !bodyFindings.includes(finding),
  )

  const inlineOutcome = await postInlineFindings(
    {
      githubClient,
      prNumber: prContext.prNumber,
      commitId: prContext.headSha,
      comments,
      inlineFindings,
    },
    logger,
  )

  const standaloneFindings = [...bodyFindings, ...inlineOutcome.rerouted]
  // Sequential posting with per-comment fallback is inherently stateful —
  // each failure drops only its own finding from the posted tally.
  let postedStandalone = 0
  for (const finding of standaloneFindings) {
    try {
      await githubClient.postIssueComment({
        prNumber: prContext.prNumber,
        body: renderStandaloneFinding(finding),
      })
      postedStandalone += 1
    } catch (postError) {
      logger.warn(
        "failed to post beyond-diff finding — it will re-report next run",
        {
          error: describeError(postError),
          file: finding.file,
          line: finding.line,
        },
      )
    }
  }
  if (postedStandalone > 0) {
    logger.info("beyond-diff findings posted", { count: postedStandalone })
  }

  // Step 14: status comment — the always-updated run receipt. Counts report
  // what actually landed; unposted findings self-heal next run and the
  // comment says so rather than claiming they were posted.
  const postedCount = inlineOutcome.postedCount + postedStandalone
  const statusBody = buildStatusComment({
    sha: prContext.headSha,
    isFirstRun: !issueState.statusCommentExists,
    postedCount,
    unpostedCount: selected.length - postedCount,
    // Coalesced: fail-open reposts can leave two anchors for one finding,
    // and the tracked count reports findings, not comment anchors.
    totalCount: coalesceAnchors(existingAnchors).length + postedCount,
    droppedByCap,
    model: modelUsed,
    contextNotes,
  })
  try {
    await githubClient.upsertSummaryComment({
      prNumber: prContext.prNumber,
      body: statusBody,
      anchor: STATUS_ANCHOR,
    })
  } catch (statusError) {
    logger.warn("failed to upsert status comment", {
      error: describeError(statusError),
    })
  }

  const reviewSummaryMarkdown = renderReviewSummary({
    prContext,
    conventionsFile: conventions ? config.conventionsFile : null,
    changedFilePaths: changedFiles.map((file) => file.path),
    relatedFilePaths: relatedFiles.map((file) => file.path),
    relatedFilesExcludedPaths: relatedFilesResult.excludedByCapPaths,
    priorityDocPaths: priorityDocFiles.map((file) => file.path),
    mentionMatchedDocPaths: mentionMatchedDocsResult.files.map(
      (file) => file.path,
    ),
    docsExcludedPaths: mentionMatchedDocsResult.excludedByCapPaths,
    totalFromModel: structuredResult.review.findings.length,
    droppedAsNonFinding,
    duplicatesRemoved: realFindings.length - newFindings.length,
    droppedBelowThreshold,
    droppedAsOverlapping,
    droppedByCap: droppedByCap.length,
    posted: postedCount,
  })

  return {
    findingsCount: postedCount,
    reviewUrl: inlineOutcome.url,
    modelUsed,
    skippedReason: "",
    reviewSummaryMarkdown,
    costSummaryMarkdown,
  }
}

/** Runs the full review pipeline — event resolution through review posting —
 *  with all I/O injected through deps so the pipeline is fully testable.
 *  Brackets the pipeline with the branded check run: created once the head
 *  SHA is known, completed with the outcome (or `failure` on a thrown
 *  pipeline error, which still propagates). */
export const orchestrate = async (
  deps: OrchestrateDeps,
  logger: Logger,
): Promise<OrchestrateResult> => {
  const { config, githubClient } = deps

  // Step 1: fail-fast validation — throws before any network call
  const severityThreshold = resolveSeverityThreshold(config.severityThreshold)
  const phases = resolvePhases(config.phases)

  logger.info("review settings from action inputs", {
    model: config.model,
    fallbackModel: config.fallbackModel || null,
    severityThreshold: config.severityThreshold,
    maxFindings: config.maxFindings ?? "uncapped",
    traceRelatedFiles: config.traceRelatedFiles,
    maxRelatedFiles: config.maxRelatedFiles,
    maxRelatedDocs: config.maxRelatedDocs,
    maxScanFiles: config.maxScanFiles,
    maxScanBytes: config.maxScanBytes,
    priorityDocs: config.priorityDocs,
    contextBudgetTokens: config.contextBudgetTokens,
    conventionsFile: config.conventionsFile,
    costSummary: config.costSummary,
  })

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

  // Step 3.5: open the branded check run now that the head SHA is known
  const checkRun = await createCheckRunSafely(
    { githubClient, headSha: prContext.headSha },
    logger,
  )

  try {
    const result = await runReviewPipeline(
      { deps, prContext, severityThreshold, phases },
      logger,
    )
    const completion = resolveCheckRunCompletion({
      result,
      costSummaryMarkdown: config.costSummary
        ? result.costSummaryMarkdown
        : null,
    })
    await completeCheckRunSafely(
      { githubClient, checkRun, ...completion },
      logger,
    )
    return result
  } catch (pipelineError) {
    await completeCheckRunSafely(
      {
        githubClient,
        checkRun,
        conclusion: "failure",
        output: {
          title: "Error — review did not complete",
          summary: describeError(pipelineError),
        },
      },
      logger,
    )
    throw pipelineError
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
