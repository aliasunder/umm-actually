import * as core from "@actions/core"
import { parseConfig, type RawInputs } from "./config.js"

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
  maxFindings: core.getInput("max_findings"),
  severityThreshold: core.getInput("severity_threshold"),
  conventionsFile: core.getInput("conventions_file"),
  phases: core.getInput("phases"),
  contextBudgetTokens: core.getInput("context_budget_tokens"),
  traceRelatedFiles: core.getBooleanInput("trace_related_files"),
  costSummary: core.getBooleanInput("cost_summary"),
  prNumberOverride: core.getInput("pr_number"),
})

// Input collection and config validation are wired now so bad inputs fail
// loudly today; the V1 pipeline (orchestrate.ts + I/O clients) lands in the
// next PR and replaces the setFailed stub below.
try {
  parseConfig(collectRawInputs())
  core.setFailed(
    "umm-actually: review pipeline not yet implemented (scaffold only)",
  )
} catch (configError) {
  core.setFailed(
    configError instanceof Error ? configError.message : String(configError),
  )
}
