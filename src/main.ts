import * as core from "@actions/core"
import { context, getOctokit } from "@actions/github"
import { OpenRouter } from "@openrouter/sdk"
import envVar from "env-var"
import { parseConfig, type RawInputs } from "./config.js"
import { createContextReader } from "./context/workspace.js"
import { createGithubClient } from "./github/client.js"
import { createLogger } from "./logger.js"
import { createOpenRouterClient } from "./openrouter/client.js"
import { createPromptedGenerateFindings, orchestrate } from "./orchestrate.js"

const logger = createLogger("umm-actually")

process.on("unhandledRejection", (error) => {
  logger.warn("unhandled promise rejection (likely SDK internal)", {
    error:
      error instanceof Error
        ? `[${error.name}]: ${error.message}`
        : String(error),
  })
})

/**
 * Collects raw inputs at the SDK boundary. Strings come from getInput;
 * booleans come pre-parsed from getBooleanInput, which enforces the strict
 * YAML 1.2 core-schema list (true|True|TRUE / false|False|FALSE) and throws
 * on anything else. Defaults from action.yml are materialized by the runner.
 */
const collectRawInputs = (): RawInputs => ({
  githubToken: core.getInput("github_token", { required: true }),
  openrouterApiKey: core.getInput("openrouter_api_key", { required: true }),
  model: core.getInput("model"),
  fallbackModel: core.getInput("fallback_model"),
  requestTimeoutSeconds: core.getInput("request_timeout_seconds"),
  maxFindings: core.getInput("max_findings"),
  severityThreshold: core.getInput("severity_threshold"),
  conventionsFile: core.getInput("conventions_file"),
  phases: core.getInput("phases"),
  contextBudgetTokens: core.getInput("context_budget_tokens"),
  traceRelatedFiles: core.getBooleanInput("trace_related_files"),
  maxScanFiles: core.getInput("max_scan_files"),
  maxScanBytes: core.getInput("max_scan_bytes"),
  maxRelatedFiles: core.getInput("max_related_files"),
  maxRelatedDocs: core.getInput("max_related_docs"),
  priorityDocs: core.getInput("priority_docs"),
  excludePaths: core.getInput("exclude_paths"),
  costSummary: core.getBooleanInput("cost_summary"),
  prNumberOverride: core.getInput("pr_number"),
})

try {
  const config = parseConfig(collectRawInputs())
  core.setSecret(config.githubToken)
  core.setSecret(config.openrouterApiKey)

  const workspaceRoot = envVar
    .from(process.env)
    .get("GITHUB_WORKSPACE")
    .required()
    .asString()
  const octokit = getOctokit(config.githubToken)
  const { owner, repo } = context.repo

  const result = await orchestrate(
    {
      config,
      eventName: context.eventName,
      payload: context.payload,
      githubClient: createGithubClient({ octokit, owner, repo }, logger),
      contextReader: createContextReader(
        {
          workspaceRoot,
          maxScanFiles: config.maxScanFiles,
          maxScanBytes: config.maxScanBytes,
          relatedFilesMax: config.maxRelatedFiles,
          relatedDocsMax: config.maxRelatedDocs,
          excludePaths: config.excludePaths,
        },
        logger,
      ),
      generateFindings: createPromptedGenerateFindings(
        {
          openrouterClient: createOpenRouterClient(
            {
              sdk: new OpenRouter({ apiKey: config.openrouterApiKey }),
              requestTimeoutMs: config.requestTimeoutSeconds * 1000,
            },
            logger,
          ),
          model: config.model,
          fallbackModel:
            config.fallbackModel === "" ? null : config.fallbackModel,
        },
        logger,
      ),
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
