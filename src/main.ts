import * as core from "@actions/core"
import { context, getOctokit } from "@actions/github"
import { OpenRouter } from "@openrouter/sdk"
import envVar from "env-var"
import { parseConfig, type RawInputs } from "./config.js"
import { createContextReader } from "./context/workspace.js"
import { createGithubClient } from "./github/client.js"
import { createLogger, describeError } from "./logger.js"
import { createOpenRouterClient } from "./openrouter/client.js"
import { createPromptedGenerateFindings, orchestrate } from "./orchestrate.js"

const actionStartedAt = performance.now()
const logger = createLogger("umm-actually")

process.on("unhandledRejection", (error) => {
  logger.warn("unhandled promise rejection (likely SDK internal)", {
    error: describeError(error),
  })
})

// Cleanups to run when the job is cancelled. It holds at most one entry, the
// open check run's completion call, registered only while that run is open.
// Mutable on purpose — signal handlers can only reach shared state
const cancellationCleanups = new Set<() => Promise<void>>()

// First signal wins — Actions sends SIGINT and then SIGTERM seconds apart,
// and the second handler must not exit while the first's API call is in
// flight. Mutable because signal handlers can only share state
let cancellationExitStarted = false

// A cancelled job stops the container with SIGINT/SIGTERM and only a short
// grace window before SIGKILL, so each cleanup must be one quick API call.
// Node runs as PID 1 in the action container and PID 1 ignores unhandled
// signals — without these handlers a cancellation never reaches this process
const exitOnCancellationSignal = (signalName: NodeJS.Signals): void => {
  if (cancellationExitStarted) return
  cancellationExitStarted = true
  // Observed, not awaited — a signal handler cannot await. The one cleanup that
  // can be registered is completeCheckRunSafely, which catches its own errors
  void (async () => {
    const pendingCleanups = [...cancellationCleanups]
    cancellationCleanups.clear()

    // A signal can arrive before the check run exists, so the line states
    // whether there is one to close
    logger.warn("cancellation signal received — closing any open check run before exit", {
      signal: signalName,
      checkRunOpen: pendingCleanups.length > 0,
    })

    for (const pendingCleanup of pendingCleanups) {
      await pendingCleanup()
    }
    process.exit(1)
  })()
}
process.on("SIGINT", exitOnCancellationSignal)
process.on("SIGTERM", exitOnCancellationSignal)

/**
 * Collects raw inputs at the SDK boundary.
 * - Strings come from getInput.
 * - Booleans come pre-parsed from getBooleanInput, which accepts only the YAML
 *   1.2 core-schema values (true|True|TRUE / false|False|FALSE) and throws on
 *   anything else, an empty value included. So for an empty boolean input,
 *   collectRawInputs skips getBooleanInput and passes undefined.
 * - The runner fills in the action.yml default for an omitted input. For an
 *   explicitly empty one, parseConfig applies the same default, except for
 *   priority_docs, where empty disables priority docs.
 */
const collectRawInputs = (): RawInputs => ({
  githubToken: core.getInput("github_token", { required: true }),
  openrouterApiKey: core.getInput("openrouter_api_key", { required: true }),
  model: core.getInput("model"),
  fallbackModel: core.getInput("fallback_model"),
  requestTimeoutSeconds: core.getInput("request_timeout_seconds"),
  reviewTimeoutSeconds: core.getInput("review_timeout_seconds"),
  maxFindings: core.getInput("max_findings"),
  severityThreshold: core.getInput("severity_threshold"),
  conventionsFile: core.getInput("conventions_file"),
  conventionsBudgetTokens: core.getInput("conventions_budget_tokens"),
  phases: core.getInput("phases"),
  contextBudgetTokens: core.getInput("context_budget_tokens"),
  traceRelatedFiles: core.getInput("trace_related_files")
    ? core.getBooleanInput("trace_related_files")
    : undefined,
  maxScanFiles: core.getInput("max_scan_files"),
  maxScanBytes: core.getInput("max_scan_bytes"),
  maxRelatedFiles: core.getInput("max_related_files"),
  maxRelatedDocs: core.getInput("max_related_docs"),
  priorityDocs: core.getInput("priority_docs"),
  excludePaths: core.getInput("exclude_paths"),
  diffExcludePaths: core.getInput("diff_exclude_paths"),
  respectLinguistGenerated: core.getInput("respect_linguist_generated")
    ? core.getBooleanInput("respect_linguist_generated")
    : undefined,
  costSummary: core.getInput("cost_summary") ? core.getBooleanInput("cost_summary") : undefined,
  prNumberOverride: core.getInput("pr_number"),
})

try {
  const config = parseConfig(collectRawInputs())
  const reviewDeadline = actionStartedAt + config.reviewTimeoutSeconds * 1000
  const remainingReviewMs = (): number => {
    return Math.max(0, reviewDeadline - performance.now())
  }
  core.setSecret(config.githubToken)
  core.setSecret(config.openrouterApiKey)

  const workspaceRoot = envVar.from(process.env).get("GITHUB_WORKSPACE").required().asString()
  const octokit = getOctokit(config.githubToken)
  const { owner, repo } = context.repo

  const result = await orchestrate(
    {
      config,
      remainingReviewMs,
      eventName: context.eventName,
      payload: context.payload,
      githubClient: createGithubClient({ octokit, owner, repo }, logger),
      contextReader: createContextReader(
        {
          workspaceRoot,
          maxScanFiles: config.maxScanFiles,
          maxScanBytes: config.maxScanBytes,
          // workspace uses noun-first (relatedFilesMax); config uses limit-first (maxRelatedFiles)
          relatedFilesMax: config.maxRelatedFiles,
          relatedDocsMax: config.maxRelatedDocs,
          excludePaths: config.excludePaths,
          remainingReviewMs,
        },
        logger,
      ),
      generateFindings: createPromptedGenerateFindings(
        {
          // createOpenRouterClient takes no logger because each review phase
          // passes its own phase-tagged logger to requestReview
          openrouterClient: createOpenRouterClient({
            sdk: new OpenRouter({ apiKey: config.openrouterApiKey }),
            requestTimeoutMs: config.requestTimeoutSeconds * 1000,
            remainingReviewMs,
          }),
          model: config.model,
          fallbackModel: config.fallbackModel,
        },
        logger,
      ),
      registerCancellationCleanup: (cleanup) => {
        cancellationCleanups.add(cleanup)
        return () => {
          cancellationCleanups.delete(cleanup)
        }
      },
    },
    logger,
  )

  core.setOutput("findings_count", result.findingsCount)
  core.setOutput("review_url", result.reviewUrl)
  core.setOutput("model_used", result.modelUsed)
  core.setOutput("skipped_reason", result.skippedReason)
  if (result.reviewSummaryMarkdown) {
    core.summary.addRaw(result.reviewSummaryMarkdown).addRaw("\n\n")
  }
  if (config.costSummary && result.costSummaryMarkdown) {
    core.summary.addRaw(result.costSummaryMarkdown)
  }
  if (!core.summary.isEmptyBuffer()) {
    await core.summary.write()
  }
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error))
}

// A request abandoned at its deadline may still hold a socket open, which
// keeps the event loop alive and the job running after the review has
// posted. No argument: Node uses process.exitCode, which setFailed sets.
process.exit()
