import { posix } from "node:path"
import parseDiff from "parse-diff"
import type { ActionConfig } from "./config.js"
import { computeCommentableLines, newFilePath } from "./diff/commentable-lines.js"
import { annotateDiff } from "./diff/annotate-diff.js"
import {
  createExclusionMatcher,
  partitionExcludedFiles,
  renderExcludedFileLines,
  renderExcludedFilesNote,
  summarizeExclusionSources,
} from "./diff/exclusion.js"
import { describeError, type Logger } from "./logger.js"
import type { CheckRunConclusion, CheckRunOutput, GithubClient } from "./github/client.js"
import { resolvePullRequestEvent, type PrContext } from "./github/event.js"
import {
  ReviewRequestError,
  type OpenRouterClient,
  type StructuredReviewResult,
} from "./openrouter/client.js"
import { renderCostSummary, type PhaseAttempt } from "./openrouter/cost-summary.js"
import type { ContextReader } from "./context/workspace.js"
import {
  buildStatusComment,
  coalesceAnchors,
  extractAnchors,
  classifyDuplicate,
  mapFindingsToReview,
  renderStandaloneFinding,
  REVIEW_MARKER,
  STATUS_ANCHOR,
  type AnchorEntry,
  type ReviewComment,
} from "./review/comment-mapping.js"
import {
  buildContextNotes,
  buildConventionsNote,
  classifyConventionsCoverage,
  findAbsentPriorityDocs,
  findInContextPriorityDocs,
} from "./review/context-notes.js"
import {
  resolveSeverityThreshold,
  type AttributedFinding,
  type Finding,
  type FindingSeverity,
} from "./review/finding.js"
import { resolveStages, type ReviewPhase, type ReviewStage } from "./review/phases.js"
import {
  buildSystemPrompt,
  buildUserPrompt,
  conventionsRenderInFull,
  estimateTokens,
  generateDelimiterNonce,
  type PromptFile,
} from "./review/prompt.js"
import { filterNonFindings } from "./review/filter-non-findings.js"
import { filterUnknownFileFindings } from "./review/filter-unknown-file-findings.js"
import { mergePhaseFindings } from "./review/merge-phase-findings.js"
import { renderReviewSummary } from "./review/review-summary.js"
import {
  AllPhasesFailedError,
  runStages,
  type PhaseOutcome,
  type RunPhase,
} from "./review/run-stages.js"
import { selectFindings } from "./review/select-findings.js"

/** Priority docs use this share before full changed-file reads. */
const PRIORITY_DOCS_BUDGET_FLOOR_RATIO = 0.1

export type ReviewContext = {
  prContext: PrContext
  phase: ReviewPhase
  conventions: string | null
  conventionsFile: string
  conventionsBudgetTokens: number
  changedFiles: PromptFile[]
  relatedFiles: PromptFile[]
  relatedDocs: PromptFile[]
  annotatedDiff: string
  priorFindings: Finding[]
  priorBotComments: string[]
}

export type GenerateFindings = (reviewContext: ReviewContext) => Promise<StructuredReviewResult>

/** How each review phase ended; a failed phase's findings are absent from
 *  the run and its reason is the error text, not a remediation. */
export type PhaseStatus =
  { phase: string; status: "completed" } | { phase: string; status: "failed"; reason: string }

export type OrchestrateResult = {
  findingsCount: number
  reviewUrl: string
  /** Routed model slugs the completed phases used, comma-joined when they differ. */
  modelUsed: string
  skippedReason: string
  phases: PhaseStatus[]
  reviewSummaryMarkdown: string | null
  costSummaryMarkdown: string | null
  /** PR-facing line when the conventions file was truncated; null otherwise. */
  conventionsNote: string | null
}

export type OrchestrateDeps = {
  config: ActionConfig
  eventName: string
  payload: unknown
  githubClient: GithubClient
  contextReader: ContextReader
  generateFindings: GenerateFindings
  remainingReviewMs: () => number
  /** Hooks the check-run cancellation cleanup into the process's signal
   *  handling (main.ts wires it to SIGINT/SIGTERM); returns an unregister.
   *  Optional so the pipeline stays runnable without process wiring. */
  registerCancellationCleanup?: (cleanup: () => Promise<void>) => () => void
}

/** Bounds token cost of prior bot comments in the prompt (~200 tokens each). */
const PRIOR_COMMENT_CAP = 30

/** Strips the trailing dedup anchor from a comment body so the model
 *  doesn't see the dedup infrastructure in the prior-comments section. */
const stripAnchorComment = (body: string): string => {
  /** The hidden `<!-- umm-actually:… -->` anchor at the end of a comment,
   *  plus the newlines before it. */
  const TRAILING_ANCHOR_PATTERN = /\n*<!-- umm-actually:.+? -->\s*$/
  return body.replace(TRAILING_ANCHOR_PATTERN, "")
}

/** detail carries multi-line context (e.g. the excluded-file list) that
 *  belongs in the review body but not in the one-line check-run title. */
const buildSkipBody = ({
  reason,
  detail,
}: {
  reason: string
  detail?: string | undefined
}): string => {
  const detailSection = detail ? `\n\n${detail}` : ""
  return `**umm-actually** — review skipped\n\n${reason}${detailSection}\n\n---\n*umm-actually*`
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
    logger.warn("failed to fetch inline comments — treating their findings as new", {
      error: describeError(fetchError),
    })
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

    // startsWith, not includes: a finding comment's model-generated text
    // could quote the marker mid-body and misclassify the run as a re-run.
    const isStatusComment = (comment: { body: string }): boolean => {
      return comment.body.startsWith(STATUS_ANCHOR)
    }
    const findingComments = comments.filter((comment) => !isStatusComment(comment))

    return {
      statusCommentExists: comments.some(isStatusComment),
      // Issue comments carry no line position — extractAnchors falls back
      // to the line embedded in the anchor key
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
  rerouted: AttributedFinding[]
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
    inlineFindings: AttributedFinding[]
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

    // githubClient already warns about the 422 with the rejected comment count
    if (result.kind === "rejected") {
      return { url: "", rerouted: inlineFindings, postedCount: 0 }
    }
    logger.info("findings review posted", {
      reviewUrl: result.url,
      inlineCount: comments.length,
    })
    return { url: result.url, rerouted: [], postedCount: comments.length }
  } catch (postError) {
    logger.warn("failed to post findings review — findings will re-report next run", {
      error: describeError(postError),
    })
    return { url: "", rerouted: [], postedCount: 0 }
  }
}

const SKIPPED_RESULT_BASE: Omit<OrchestrateResult, "reviewUrl" | "skippedReason"> = {
  findingsCount: 0,
  modelUsed: "",
  phases: [],
  reviewSummaryMarkdown: null,
  costSummaryMarkdown: null,
  conventionsNote: null,
}

type CheckRunHandle = { checkRunId: number } | null

/** A token without `checks: write` (the permission is optional for consumers)
 *  degrades to an unbranded run and never fails the review. */
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
 *  The conclusion grades the run, not the code:
 *  - `success` for a completed review, with or without findings (the count
 *    lives in the title). A review that lost some phases still ran and
 *    posted, so it stays `success` and the title carries the gap.
 *  - `neutral` for a skip — no review happened.
 *  - `failure` only when the pipeline itself errors.
 *
 *  Only the `success` summaries carry the conventions-truncation note; a
 *  skip never builds a prompt, so it has no note. */
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

  const incompletePhases = result.phases.filter((phase) => phase.status === "failed")
  const incompleteSuffix =
    incompletePhases.length === 0
      ? ""
      : ` (${incompletePhases.length} of ${result.phases.length} phases incomplete)`
  const incompleteSection =
    incompletePhases.length === 0
      ? ""
      : `\n\nIncomplete phases: ${incompletePhases
          .map((phase) => `\`${phase.phase}\` (${phase.reason})`)
          .join(", ")}`
  const conventionsSection = result.conventionsNote ? `\n\n${result.conventionsNote}` : ""

  if (result.findingsCount === 0) {
    return {
      conclusion: "success",
      output: {
        title: `No findings above threshold${incompleteSuffix}`,
        summary: `Reviewed with \`${result.modelUsed}\` — no findings above threshold.${incompleteSection}${conventionsSection}${costSection}`,
      },
    }
  }
  const findingsLabel =
    result.findingsCount === 1 ? "1 finding" : `${result.findingsCount} findings`
  return {
    conclusion: "success",
    output: {
      title: `${findingsLabel}${incompleteSuffix}`,
      summary: `Reviewed with \`${result.modelUsed}\` — ${findingsLabel} posted.${incompleteSection}${conventionsSection}${costSection}`,
    },
  }
}

type CompletedPhase = Extract<PhaseOutcome, { status: "completed" }>

const describePhaseOutcome = (outcome: PhaseOutcome): PhaseStatus => {
  if (outcome.status === "completed") {
    return { phase: outcome.phase.id, status: "completed" }
  }
  return {
    phase: outcome.phase.id,
    status: "failed",
    reason: describeError(outcome.error),
  }
}

/** A failed phase's billed attempts ride on the client's error; any other
 *  failure reached no provider and billed nothing. */
const phaseAttempts = (outcome: PhaseOutcome): PhaseAttempt[] => {
  const tag = (attempts: StructuredReviewResult["attempts"]) => {
    return attempts.map((attempt) => ({ ...attempt, phase: outcome.phase.id }))
  }

  if (outcome.status === "completed") return tag(outcome.result.attempts)
  if (outcome.error instanceof ReviewRequestError) return tag(outcome.error.attempts)
  return []
}

type FilteredPhaseFindings = {
  findings: AttributedFinding[]
  droppedAsNonFinding: number
  droppedAsUnknownFile: number
}

/** Drops non-findings and findings on files the model never saw. */
const filterPhaseFindings = (
  { outcome, knownPaths }: { outcome: CompletedPhase; knownPaths: string[] },
  logger: Logger,
): FilteredPhaseFindings => {
  const { findings: nonFindingFiltered, droppedAsNonFinding } = filterNonFindings(
    outcome.result.review.findings,
  )
  const { findings, droppedAsUnknownFile } = filterUnknownFileFindings({
    findings: nonFindingFiltered,
    knownPaths,
  })

  // Each drop warns on its own because it is a model-quality event, not loop
  // chatter. The title is omitted because it may be garbage.
  for (const finding of droppedAsUnknownFile) {
    logger.warn("dropping finding: file not in prompt context", {
      phase: outcome.phase.id,
      file: finding.file,
      line: finding.line,
      category: finding.category,
    })
  }
  return {
    findings: findings.map((finding) => ({
      ...finding,
      modelUsed: outcome.result.modelUsed,
    })),
    droppedAsNonFinding,
    droppedAsUnknownFile: droppedAsUnknownFile.length,
  }
}

/** Renders the check-run summary when the pipeline throws. Appends
 *  a cost table when every phase failed — the operator still pays. */
const describePipelineFailure = ({
  pipelineError,
  includeCostSummary,
}: {
  pipelineError: unknown
  includeCostSummary: boolean
}): string => {
  const description = describeError(pipelineError)

  if (!includeCostSummary || !(pipelineError instanceof AllPhasesFailedError)) {
    return description
  }

  const attempts = pipelineError.outcomes.flatMap(phaseAttempts)

  if (attempts.length === 0) return description

  const modelUsed = [...new Set(attempts.map((attempt) => attempt.model))].join(", ")

  return `${description}\n\n${renderCostSummary({ attempts, modelUsed })}`
}

/** The conventions entry of the "context sent to model" log. */
const describeConventionsContext = ({
  conventionsFile,
  conventionsFound,
  conventionsReadInFullByPriorityDocs,
}: {
  conventionsFile: string
  conventionsFound: boolean
  conventionsReadInFullByPriorityDocs: boolean
}): string => {
  if (!conventionsFound) return "not found"

  if (conventionsReadInFullByPriorityDocs) {
    return `${conventionsFile} (suppressed — full copy in priority docs)`
  }

  return conventionsFile
}

const sumBy = <Item>(items: Item[], valueOf: (item: Item) => number): number => {
  return items.reduce((sum, item) => sum + valueOf(item), 0)
}

const incompletePhaseIds = (phases: PhaseStatus[]): string[] => {
  return phases.filter((phase) => phase.status === "failed").map((phase) => phase.phase)
}

/** Runs everything after PR-context resolution, from the diff fetch through
 *  the status comment. orchestrate brackets it with the check-run lifecycle. */
const runReviewPipeline = async (
  {
    deps,
    prContext,
    severityThreshold,
    stages,
  }: {
    deps: OrchestrateDeps
    prContext: PrContext
    severityThreshold: FindingSeverity
    stages: ReviewStage[]
  },
  logger: Logger,
): Promise<OrchestrateResult> => {
  const { config, githubClient, contextReader, generateFindings } = deps

  const postSkipReview = async ({
    reason,
    detail,
  }: {
    reason: string
    detail?: string | undefined
  }): Promise<OrchestrateResult> => {
    const body = buildSkipBody({ reason, detail })
    const { url } = await githubClient.submitReview({
      prNumber: prContext.prNumber,
      commitId: prContext.headSha,
      body,
    })
    logger.info("posted skip review", { reason, reviewUrl: url })
    return { ...SKIPPED_RESULT_BASE, reviewUrl: url, skippedReason: reason }
  }

  const diffResult = await githubClient.fetchDiff({
    prNumber: prContext.prNumber,
  })

  if (diffResult.kind === "too_large") {
    return postSkipReview({ reason: "diff exceeds GitHub's diff API limits" })
  }

  const files = parseDiff(diffResult.diff)

  if (files.length === 0) {
    return postSkipReview({ reason: "empty diff" })
  }

  // Generated files leave the review before the budget check, so one
  // oversized artifact cannot starve the reviewable rest of the PR
  const gitAttributesContent = config.respectLinguistGenerated
    ? await contextReader.readGitAttributes()
    : null
  const exclusionMatcher = createExclusionMatcher(
    { ...config.diffExcludePaths, gitAttributesContent },
    logger,
  )
  const { kept: reviewableFiles, excluded: excludedDiffFiles } = partitionExcludedFiles({
    files,
    matcher: exclusionMatcher,
  })

  if (excludedDiffFiles.length > 0) {
    logger.info("changed files excluded from the review diff", {
      excludedCount: excludedDiffFiles.length,
      excludedPaths: excludedDiffFiles.map((file) => `${file.path} (${file.source})`).join(", "),
    })
  }
  if (reviewableFiles.length === 0) {
    // Reason names the layers that actually excluded (an operator on default
    // inputs never set diff_exclude_paths); the body names every file.
    return postSkipReview({
      reason: `all ${excludedDiffFiles.length} changed file(s) excluded from review (${summarizeExclusionSources(excludedDiffFiles)})`,
      detail: renderExcludedFileLines(excludedDiffFiles).join("\n"),
    })
  }

  // The excluded-files trailer sits inside the annotated diff string, so its
  // few tokens count against the diff budget
  const excludedFilesNote = renderExcludedFilesNote(excludedDiffFiles)
  const annotatedDiff = excludedFilesNote
    ? `${annotateDiff(reviewableFiles)}\n\n${excludedFilesNote}`
    : annotateDiff(reviewableFiles)
  const diffTokens = estimateTokens(annotatedDiff)
  // The diff gets half the budget; the other half is for context files.
  const budgetHalf = Math.floor(config.contextBudgetTokens / 2)

  if (diffTokens > budgetHalf) {
    return postSkipReview({
      reason: `diff too large for context budget (${diffTokens} tokens, limit ${budgetHalf} of ${config.contextBudgetTokens})`,
    })
  }

  const commentableByPath = computeCommentableLines(reviewableFiles)

  // Diff-excluded files must stay out of every context channel: the trailer
  // told the model their content is not shown, so neither the related-file
  // and doc scans nor the priority-doc read may pull that content back in.
  const diffExcludedPaths = excludedDiffFiles.map((file) => file.path)
  const diffExcludedPathSet = new Set(
    diffExcludedPaths.map((excludedPath) => posix.normalize(excludedPath)),
  )
  const reviewablePriorityDocs = config.priorityDocs.filter(
    (docPath) => !diffExcludedPathSet.has(posix.normalize(docPath)),
  )

  // A rename contributes its old path too, so the import scanner finds
  // callers that still reference the pre-rename path
  const changedPaths = reviewableFiles
    .flatMap((file) => {
      const toPath = newFilePath(file)
      const fromPath = file.from

      // parse-diff: from can be undefined for a binary file and is "/dev/null"
      // for an added file (binary or not) — neither is a pre-rename path worth tracing
      if (toPath === null || !fromPath || fromPath === "/dev/null" || fromPath === file.to) {
        return [toPath]
      }
      return [toPath, fromPath]
    })
    .filter((path) => path !== null)

  const conventions = await contextReader.readConventions({
    conventionsFile: config.conventionsFile,
  })

  // The conventions file has its own prompt section. When that section carries
  // the whole file, a changed conventions file would be rendered twice — so the
  // changed-files channel carries it diff-only. When the section is truncated
  // instead, the changed-files copy is the only full one and stays full.
  const conventionsAlreadyRenderedInFull =
    conventions !== null && conventionsRenderInFull(conventions, config.conventionsBudgetTokens)

  // The conventions path when its section carries the whole file, else empty.
  // Each channel below spreads it into the paths it must not send again.
  const conventionsFullCopyPaths = conventionsAlreadyRenderedInFull ? [config.conventionsFile] : []

  const fileBudgetTokens = config.contextBudgetTokens - diffTokens

  // The floor is a share of the whole context budget, but never more than the
  // budget the diff leaves over.
  const priorityDocFloorLimit = Math.min(
    Math.floor(config.contextBudgetTokens * PRIORITY_DOCS_BUDGET_FLOOR_RATIO),
    fileBudgetTokens,
  )

  // A conventions file whose section already carries it whole needs no second
  // full copy from the priority-doc channel.
  const priorityDocsNeedingFullCopy = reviewablePriorityDocs.filter((docPath) => {
    return !(
      conventionsAlreadyRenderedInFull &&
      posix.normalize(docPath) === posix.normalize(config.conventionsFile)
    )
  })

  // Unchanged docs have no changed-file channel, so give them first claim
  // on the floor while keeping configured order within each group.
  const changedPathSet = new Set(changedPaths.map((changedPath) => posix.normalize(changedPath)))
  const earlyPriorityDocsInReadOrder = [
    ...priorityDocsNeedingFullCopy.filter(
      (docPath) => !changedPathSet.has(posix.normalize(docPath)),
    ),
    ...priorityDocsNeedingFullCopy.filter((docPath) => {
      return changedPathSet.has(posix.normalize(docPath))
    }),
  ]

  // Priority-doc budget, in read order:
  // 1. Early read: docs spend up to the floor limit before changed files read.
  // 2. Changed files get the file budget minus what the early read spent.
  // 3. If a doc is still missing, the unspent floor is held back from related files.
  // 4. Late read: missing docs retry with whatever changed and related files left.
  //
  // Zero when no doc needs the early read or the diff left no floor — either
  // way the read is skipped and spends nothing.
  const earlyPriorityDocBudget = earlyPriorityDocsInReadOrder.length > 0 ? priorityDocFloorLimit : 0
  const earlyPriorityDocsResult =
    earlyPriorityDocBudget > 0
      ? await contextReader.readPriorityDocs({
          priorityDocs: earlyPriorityDocsInReadOrder,
          budgetTokens: earlyPriorityDocBudget,
          excludePaths: [],
        })
      : { files: [], remainingTokens: earlyPriorityDocBudget }
  const earlyPriorityDocFiles = earlyPriorityDocsResult.files
  const earlyPriorityDocTokens = earlyPriorityDocBudget - earlyPriorityDocsResult.remainingTokens

  // A changed doc already read in full above is sent diff-only here, so its
  // full text reaches the prompt once.
  const { files: changedFiles, remainingTokens } = await contextReader.readChangedFiles({
    changedPaths,
    budgetTokens: fileBudgetTokens - earlyPriorityDocTokens,
    diffOnlyPaths: [...conventionsFullCopyPaths, ...earlyPriorityDocFiles.map((file) => file.path)],
  })

  // Keep only the unspent part of the floor for docs still missing after
  // changed-file reads, so related files cannot consume it.
  const preFloorInContext = new Set([
    ...earlyPriorityDocFiles.map((file) => posix.normalize(file.path)),
    ...changedFiles
      .filter((file) => file.includedAs === "full")
      .map((file) => posix.normalize(file.path)),
    ...conventionsFullCopyPaths.map((conventionsPath) => posix.normalize(conventionsPath)),
  ])
  const needsPriorityDocFloor =
    reviewablePriorityDocs.length > 0 &&
    reviewablePriorityDocs.some((docPath) => !preFloorInContext.has(posix.normalize(docPath)))
  const remainingPriorityDocFloor = needsPriorityDocFloor
    ? Math.min(priorityDocFloorLimit - earlyPriorityDocTokens, remainingTokens)
    : 0
  const priorityDocFloor = earlyPriorityDocTokens + remainingPriorityDocFloor
  const relatedFilesBudgetTokens = remainingTokens - remainingPriorityDocFloor

  const relatedFilesResult = config.traceRelatedFiles
    ? await contextReader.findRelatedFiles({
        changedPaths,
        budgetTokens: relatedFilesBudgetTokens,
        excludePaths: [...diffExcludedPaths, ...earlyPriorityDocFiles.map((file) => file.path)],
      })
    : { files: [], excludedByCapPaths: [] }

  const relatedFiles = relatedFilesResult.files
  const relatedFilesTokens = sumBy(relatedFiles, (file) => estimateTokens(file.content))
  const docBudgetTokens = Math.max(0, remainingTokens - relatedFilesTokens)

  // Every path whose full text a higher-priority channel already sent.
  // Diff-only changed files are excluded — only diff hunks reached the
  // prompt, so the priority-doc channel should still attempt a full read.
  // The conventions file counts only when its section carries the whole
  // file — when that section truncates, its full text has NOT been sent.
  const priorityDocsInContext = [
    ...changedFiles.filter((file) => file.includedAs === "full").map((file) => file.path),
    ...relatedFiles.map((file) => file.path),
    ...conventionsFullCopyPaths,
  ]

  // The late read retries any doc the early read couldn't fit, using whatever
  // budget changed and related files left.
  const latePriorityDocsResult = needsPriorityDocFloor
    ? await contextReader.readPriorityDocs({
        priorityDocs: reviewablePriorityDocs,
        budgetTokens: docBudgetTokens,
        excludePaths: [...earlyPriorityDocFiles.map((file) => file.path), ...priorityDocsInContext],
      })
    : { files: [], remainingTokens: docBudgetTokens }

  // The two reads return docs in read order (unchanged docs first), so sort
  // the merged list back into the order the priority_docs input lists them.
  const priorityDocPathsInOrder = reviewablePriorityDocs.map((docPath) => {
    return posix.normalize(docPath)
  })
  const priorityDocFiles = [...earlyPriorityDocFiles, ...latePriorityDocsResult.files].toSorted(
    (leftFile, rightFile) => {
      return (
        priorityDocPathsInOrder.indexOf(posix.normalize(leftFile.path)) -
        priorityDocPathsInOrder.indexOf(posix.normalize(rightFile.path))
      )
    },
  )
  const docRemainingTokens = latePriorityDocsResult.remainingTokens

  // A new conventions file's diff hunks carry every line of it. A binary file's
  // diff has no hunks, so it carries nothing.
  const conventionsAddedInDiff = reviewableFiles.some((file) => {
    const toPath = newFilePath(file)
    return (
      Boolean(file.new) &&
      file.chunks.length > 0 &&
      toPath !== null &&
      posix.normalize(toPath) === posix.normalize(config.conventionsFile)
    )
  })

  // Runs after the reads because, when the conventions section truncates, the
  // classifier looks for a full copy among the files read above. Its `full`
  // status is the same fits-in-section check as conventionsAlreadyRenderedInFull.
  const conventionsCoverage = classifyConventionsCoverage({
    conventions,
    conventionsFile: config.conventionsFile,
    conventionsBudgetTokens: config.conventionsBudgetTokens,
    priorityDocFiles,
    changedFiles,
    relatedFiles,
    conventionsAddedInDiff,
  })
  const conventionsNote = buildConventionsNote({
    conventionsCoverage,
    conventionsFile: config.conventionsFile,
    // The raw input, not reviewablePriorityDocs: a listing the diff exclusion
    // dropped still means the operator listed the file, so the note must not
    // advise listing it
    listedInPriorityDocs: config.priorityDocs.some((docPath) => {
      return posix.normalize(docPath) === posix.normalize(config.conventionsFile)
    }),
  })

  // Logged before any model call so the warning survives a run that fails later
  if (conventionsCoverage.status === "truncated" && !conventionsCoverage.fullCopyChannel) {
    logger.warn("conventions file truncated with no full copy in context", {
      conventionsFile: config.conventionsFile,
      conventionsCharacters: conventionsCoverage.totalCharacters,
      conventionsCharacterCap: conventionsCoverage.characterCap,
    })
  }

  // When the conventions section truncated but priority docs read the full
  // file, suppress the truncated head — the full copy in the priority-docs
  // section is strictly better, and rendering both spends the whole
  // conventions budget on a duplicate.
  const conventionsReadInFullByPriorityDocs =
    conventionsCoverage.status === "truncated" &&
    conventionsCoverage.fullCopyChannel === "priority-docs"

  if (conventionsReadInFullByPriorityDocs) {
    logger.info(
      "conventions file read in full by priority-doc channel — suppressing truncated conventions section to avoid duplication",
      {
        conventionsFile: config.conventionsFile,
        conventionsCharacters: conventionsCoverage.totalCharacters,
        conventionsCharacterCap: conventionsCoverage.characterCap,
      },
    )
  }

  // The placeholder still renders under the conventions file's path. The
  // priority-doc block holding the full text carries a path that normalizes to
  // it, so a finding quoting the file stays attributed to it.
  const conventionsForPrompt = conventionsReadInFullByPriorityDocs
    ? "(conventions file included in full as priority documentation below — ground convention findings in that copy)"
    : conventions

  const mentionMatchedDocsResult = config.traceRelatedFiles
    ? await contextReader.findRelatedDocs({
        changedPaths,
        budgetTokens: docRemainingTokens,
        conventionsFile: config.conventionsFile,
        // Every configured priority doc, read or not: the priority-doc channel
        // owns those paths, so mention-matching never sends a second copy or
        // retries a doc that channel left out
        excludePaths: [...config.priorityDocs, ...diffExcludedPaths],
      })
    : { files: [], excludedByCapPaths: [] }

  const relatedDocs = [...priorityDocFiles, ...mentionMatchedDocsResult.files]

  // Every path the model can see: diff headers (deleted files render a
  // header but have no new path, so they are added here), file blocks, and
  // the conventions section when the file was found.
  const deletedPaths = reviewableFiles.flatMap((file) => {
    return file.deleted && file.from ? [file.from] : []
  })
  const promptFilePaths = [
    ...changedPaths,
    ...deletedPaths,
    ...changedFiles.map((file) => file.path),
    ...relatedFiles.map((file) => file.path),
    ...relatedDocs.map((file) => file.path),
    ...(conventions !== null ? [config.conventionsFile] : []),
  ]

  logger.info("context sent to model", {
    conventionsFile: describeConventionsContext({
      conventionsFile: config.conventionsFile,
      conventionsFound: conventions !== null,
      conventionsReadInFullByPriorityDocs,
    }),
    changedFilesCount: changedFiles.length,
    changedFilePaths: changedFiles.map((file) => file.path).join(", "),
    relatedFilesCount: relatedFiles.length,
    relatedFilePaths: relatedFiles.map((file) => file.path).join(", ") || "none",
    relatedFilesExcludedCount: relatedFilesResult.excludedByCapPaths.length,
    relatedFilesExcludedPaths: relatedFilesResult.excludedByCapPaths.join(", ") || "none",
    priorityDocsReadCount: priorityDocFiles.length,
    priorityDocPaths: priorityDocFiles.map((file) => file.path).join(", ") || "none",
    mentionMatchedDocsCount: mentionMatchedDocsResult.files.length,
    mentionMatchedDocPaths:
      mentionMatchedDocsResult.files.map((file) => file.path).join(", ") || "none",
    docsExcludedCount: mentionMatchedDocsResult.excludedByCapPaths.length,
    docsExcludedPaths: mentionMatchedDocsResult.excludedByCapPaths.join(", ") || "none",
    tokenBudgetTotal: config.contextBudgetTokens,
    tokenBudgetUsedByDiff: diffTokens,
    tokenBudgetPriorityDocFloor: priorityDocFloor,
    tokenBudgetRemainingForDocs: docRemainingTokens,
  })

  const priorityDocsInContextPaths = findInContextPriorityDocs({
    priorityDocs: reviewablePriorityDocs,
    priorityDocsInContext,
  })
  const priorityDocsAbsentPaths = findAbsentPriorityDocs({
    priorityDocs: reviewablePriorityDocs,
    priorityDocsInContext,
    priorityDocsRead: priorityDocFiles,
  })

  const contextNotes = buildContextNotes({
    priorityDocs: reviewablePriorityDocs,
    priorityDocsInContext,
    priorityDocsRead: priorityDocFiles,
    relatedFilesExcludedPaths: relatedFilesResult.excludedByCapPaths,
    docsExcludedPaths: mentionMatchedDocsResult.excludedByCapPaths,
    diffExcludedFiles: excludedDiffFiles,
  })

  // Prior bot comments go into the prompt, so the model sees what is already
  // posted and skips conceptual duplicates. Positional dedup uses them too
  const inlineState = await fetchInlineCommentState(
    { githubClient, prNumber: prContext.prNumber },
    logger,
  )
  const issueState = await fetchIssueCommentState(
    { githubClient, prNumber: prContext.prNumber },
    logger,
  )
  const priorBotComments = [...inlineState.commentBodies, ...issueState.findingBodies]
    .map(stripAnchorComment)
    .slice(-PRIOR_COMMENT_CAP)

  // Each phase makes one model call, and the stages run in order
  const runPhase: RunPhase = ({ phase, priorFindings }) => {
    return generateFindings({
      prContext,
      phase,
      conventions: conventionsForPrompt,
      conventionsFile: config.conventionsFile,
      conventionsBudgetTokens: config.conventionsBudgetTokens,
      changedFiles,
      relatedFiles,
      relatedDocs,
      annotatedDiff,
      priorFindings,
      priorBotComments,
    })
  }
  const phaseOutcomes = await runStages(
    { stages, runPhase, remainingReviewMs: deps.remainingReviewMs },
    logger,
  )
  const completedPhases = phaseOutcomes.filter((outcome) => outcome.status === "completed")
  const phases = phaseOutcomes.map(describePhaseOutcome)
  /** Cost lookup expiry alone does not lose review coverage. */
  const coverageLostToReviewDeadline = phaseOutcomes.some(
    (outcome) => outcome.status === "failed" && outcome.deadlineExceeded,
  )
  const modelUsed = [...new Set(completedPhases.map((outcome) => outcome.result.modelUsed))].join(
    ", ",
  )
  const attempts = phaseOutcomes.flatMap(phaseAttempts)
  logger.info("review phases finished", {
    completed: completedPhases.map((outcome) => outcome.phase.id),
    incomplete: incompletePhaseIds(phases),
  })

  // Each phase drops non-findings and findings on files the model never saw,
  // then cross-phase duplicates collapse. All of it runs before selection so
  // cap slots aren't wasted
  const filteredPhases = completedPhases.map((outcome) => {
    return filterPhaseFindings({ outcome, knownPaths: promptFilePaths }, logger)
  })
  const totalFromModel = sumBy(completedPhases, (outcome) => outcome.result.review.findings.length)
  const droppedAsNonFinding = sumBy(filteredPhases, (filtered) => filtered.droppedAsNonFinding)
  const droppedAsUnknownFile = sumBy(filteredPhases, (filtered) => filtered.droppedAsUnknownFile)
  const { findings: realFindings, duplicatesAcrossPhases } = mergePhaseFindings(
    filteredPhases.map((filtered) => filtered.findings),
  )
  logger.info("non-finding filter applied to model output", {
    totalFromModel,
    kept: realFindings.length,
    droppedAsNonFinding,
    droppedAsUnknownFile,
    duplicatesAcrossPhases,
  })

  // Cross-run dedup runs on every run, and a first run is the case where no bot
  // comments exist yet. It compares against the bot's inline comments (live
  // positions) and its beyond-diff issue comments (anchor lines), before the
  // cap so duplicates don't consume slots.
  const existingAnchors = [...inlineState.anchors, ...issueState.anchors]
  const newFindings: AttributedFinding[] = []
  const dedupCounts = { positional: 0, content: 0, title: 0 }
  for (const finding of realFindings) {
    const tier = classifyDuplicate(finding, existingAnchors)

    if (tier) {
      dedupCounts[tier]++
      // Positional is the common case and would be noisy — log only the
      // higher tiers, which need the title evidence for diagnosis.
      if (tier === "content" || tier === "title") {
        logger.info(`${tier}-tier dedup suppressed finding`, {
          file: finding.file,
          line: finding.line,
          category: finding.category,
          title: finding.title,
        })
      }
    } else {
      newFindings.push(finding)
    }
  }

  logger.info("cross-run dedup against prior bot comments", {
    statusCommentFound: issueState.statusCommentExists,
    existingAnchorCount: existingAnchors.length,
    priorBotCommentCount: priorBotComments.length,
    findingsAfterFilter: realFindings.length,
    findingsSurvivedDedup: newFindings.length,
    droppedByPositional: dedupCounts.positional,
    droppedByContent: dedupCounts.content,
    droppedByTitle: dedupCounts.title,
  })

  const { selected, droppedBelowThreshold, droppedAsOverlapping, droppedByCap } = selectFindings({
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

  // Findings post in two ways, and all narration lives in the status comment.
  // - Anchorable findings batch into one review with an invisible marker body,
  //   which makes one notification and a bare "reviewed" timeline event.
  // - The rest post as individual issue comments, so every new finding is a
  //   visible event.
  // Unposted findings carry no anchor and re-report next run.
  const costSummaryMarkdown = renderCostSummary({ attempts, modelUsed })
  const { comments, standaloneFindings: unanchoredFindings } = mapFindingsToReview({
    findings: selected,
    commentableByPath,
  })

  // mapFindingsToReview returns the same finding objects it was given, so an
  // identity check separates the anchored findings from the unanchored ones
  const inlineFindings = selected.filter((finding) => !unanchoredFindings.includes(finding))

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

  const standaloneFindings = [...unanchoredFindings, ...inlineOutcome.rerouted]
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
      logger.warn("failed to post beyond-diff finding — it will re-report next run", {
        error: describeError(postError),
        file: finding.file,
        line: finding.line,
      })
    }
  }
  if (postedStandalone > 0) {
    logger.info("beyond-diff findings posted", { count: postedStandalone })
  }

  // The status comment is the always-updated run receipt. Counts report
  // what actually landed; unposted findings self-heal next run and the
  // comment says so rather than claiming they were posted.
  const postedCount = inlineOutcome.postedCount + postedStandalone
  const statusBody = buildStatusComment({
    sha: prContext.headSha,
    isFirstRun: !issueState.statusCommentExists,
    postedCount,
    unpostedCount: selected.length - postedCount,
    // Anchors are coalesced because fail-open reposts can leave two anchors for
    // one finding, and the tracked count reports findings, not comment anchors.
    totalCount: coalesceAnchors(existingAnchors).length + postedCount,
    droppedByCap,
    model: modelUsed,
    contextNotes,
    ...(conventionsNote && { conventionsNote }),
    incompletePhases: incompletePhaseIds(phases),
    reviewDeadlineExceeded: coverageLostToReviewDeadline,
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
    conventionsFile: config.conventionsFile,
    conventionsCoverage,
    phasesCompleted: completedPhases.map((outcome) => outcome.phase.id),
    phasesIncomplete: incompletePhaseIds(phases),
    reviewDeadlineExceeded: coverageLostToReviewDeadline,
    changedFilePaths: changedFiles.map((file) => file.path),
    relatedFilePaths: relatedFiles.map((file) => file.path),
    relatedFilesExcludedPaths: relatedFilesResult.excludedByCapPaths,
    priorityDocPaths: priorityDocFiles.map((file) => file.path),
    priorityDocsInContextPaths,
    priorityDocsAbsentPaths,
    mentionMatchedDocPaths: mentionMatchedDocsResult.files.map((file) => file.path),
    docsExcludedPaths: mentionMatchedDocsResult.excludedByCapPaths,
    tokenBudgetTotal: config.contextBudgetTokens,
    tokenBudgetUsedByDiff: diffTokens,
    tokenBudgetPriorityDocFloor: priorityDocFloor,
    tokenBudgetRemainingForDocs: docRemainingTokens,
    totalFromModel,
    droppedAsNonFinding,
    droppedAsUnknownFile,
    duplicatesAcrossPhases,
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
    phases,
    reviewSummaryMarkdown,
    costSummaryMarkdown,
    conventionsNote,
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

  // Invalid settings throw here, before any network call
  const severityThreshold = resolveSeverityThreshold(config.severityThreshold)
  const stages = resolveStages(config.phases)

  logger.info("review settings from action inputs", {
    model: config.model,
    fallbackModel: config.fallbackModel,
    phases: config.phases,
    reviewTimeoutSeconds: config.reviewTimeoutSeconds,
    severityThreshold: config.severityThreshold,
    maxFindings: config.maxFindings ?? "uncapped",
    traceRelatedFiles: config.traceRelatedFiles,
    maxRelatedFiles: config.maxRelatedFiles,
    maxRelatedDocs: config.maxRelatedDocs,
    maxScanFiles: config.maxScanFiles,
    maxScanBytes: config.maxScanBytes,
    priorityDocs: config.priorityDocs,
    excludePaths: config.excludePaths.length > 0 ? config.excludePaths : "none",
    diffExcludePaths: config.diffExcludePaths,
    respectLinguistGenerated: config.respectLinguistGenerated,
    contextBudgetTokens: config.contextBudgetTokens,
    conventionsFile: config.conventionsFile,
    costSummary: config.costSummary,
  })

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

  const prContext: PrContext =
    resolvedEvent.kind === "complete"
      ? resolvedEvent.context
      : await githubClient.fetchPullRequest({
          prNumber: resolvedEvent.prNumber,
        })

  // The branded check run opens once the head SHA is known
  const checkRun = await createCheckRunSafely({ githubClient, headSha: prContext.headSha }, logger)

  // A cancelled job stops the container before the completions below run,
  // which would leave the check in progress forever — the registered
  // cleanup closes it as `cancelled` inside the runner's stop-grace window.
  // Registered only when a check run exists (creation can fail) and the
  // caller wired signal handling (the dep is optional)
  const unregisterCancellationCleanup =
    checkRun && deps.registerCancellationCleanup
      ? deps.registerCancellationCleanup(() => {
          return completeCheckRunSafely(
            {
              githubClient,
              checkRun,
              conclusion: "cancelled",
              output: {
                title: "Cancelled — review did not finish",
                summary:
                  "The workflow run was cancelled before the review completed — a job timeout, or a newer run superseding this one.",
              },
            },
            logger,
          )
        })
      : null

  try {
    const result = await runReviewPipeline({ deps, prContext, severityThreshold, stages }, logger)
    const completion = resolveCheckRunCompletion({
      result,
      costSummaryMarkdown: config.costSummary ? result.costSummaryMarkdown : null,
    })
    await completeCheckRunSafely({ githubClient, checkRun, ...completion }, logger)
    // Unregistered only after the terminal update settles — a signal during
    // the request must still find the cleanup registered, or the check could
    // stay in progress forever
    unregisterCancellationCleanup?.()
    return result
  } catch (pipelineError) {
    await completeCheckRunSafely(
      {
        githubClient,
        checkRun,
        conclusion: "failure",
        output: {
          title: "Error — review did not complete",
          summary: describePipelineFailure({
            pipelineError,
            includeCostSummary: config.costSummary,
          }),
        },
      },
      logger,
    )
    // Same ordering as the success path: unregister only after the terminal
    // update settles
    unregisterCancellationCleanup?.()
    throw pipelineError
  }
}

/** Builds one review phase's prompt and sends it to OpenRouter with no tool
 *  calls. The stage dispatcher calls the returned function once per phase. */
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
  return async (reviewContext) => {
    const delimiterNonce = generateDelimiterNonce()
    const systemPrompt = buildSystemPrompt({ phase: reviewContext.phase })
    const userPrompt = buildUserPrompt({
      ...reviewContext,
      delimiterNonce,
    })

    // Parallel phases call the same model at once, so the phase prop is what
    // tells their log lines apart
    const phaseLogger = logger.child({ phase: reviewContext.phase.id })

    phaseLogger.info("requesting review", { model, fallbackModel })

    return openrouterClient.requestReview(
      { systemPrompt, userPrompt, model, fallbackModel },
      phaseLogger,
    )
  }
}
