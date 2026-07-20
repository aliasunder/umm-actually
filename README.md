# umm-actually

LLM-powered pull request review as a GitHub Action. One consolidated review per PR with inline findings, powered by any model on [OpenRouter](https://openrouter.ai).

## What it does

- Reviews the PR diff **and traces changed code into its callers** — regressions and pre-existing bugs in affected code are findings, not noise
- Reads your repo's conventions file (`AGENTS.md` by default) and reviews against it
- Posts exactly **one** PR review with inline comments anchored to diff lines — no duplicate comments, no unrequested-reviewer badges
- Structured output end to end: every finding carries a category, severity, confidence, and a concrete failure scenario
- **Drops non-findings before they post** — findings that conclude "no bug here" (an `N/A — …` title, a "no action needed" suggestion, a "…is correct" title) are filtered deterministically
- Model-agnostic via OpenRouter — pick your model, see your per-call costs
- Findings that can't be anchored to the diff (e.g. callers outside the changed files) are posted as standalone comments on the PR
- PRs with oversized diffs are skipped gracefully with a body-only review stating the reason

## Setup

umm-actually runs as a Docker-based action. It needs a GitHub token (for fetching the diff and posting the review) and an OpenRouter API key.

For the best experience, use a [GitHub App](https://docs.github.com/en/apps/creating-github-apps) installation token so reviews are attributed to a bot identity rather than a personal account.

## Usage

```yaml
name: Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read

concurrency:
  group: review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    if: >-
      github.event_name == 'pull_request' ||
      (
        github.event_name == 'issue_comment' &&
        github.event.issue.pull_request &&
        contains(github.event.comment.body, '@umm review')
      )
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - uses: actions/create-github-app-token@v2
        id: app-token
        with:
          app-id: ${{ secrets.UMM_APP_ID }}
          private-key: ${{ secrets.UMM_PRIVATE_KEY }}

      - uses: aliasunder/umm-actually@v0
        with:
          github_token: ${{ steps.app-token.outputs.token }}
          openrouter_api_key: ${{ secrets.OPENROUTER_KEY }}
```

The `@umm review` comment trigger lets you re-request a review on any PR by commenting. The `issue_comment` event fires for PR comments — the `if` condition filters to PRs only.

## Inputs

| Input                   | Default                       | Description                                                                                                                                                                                               |
| ----------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github_token`          | _(required)_                  | Token for fetching the diff and posting the review. A GitHub App installation token keeps the bot identity.                                                                                               |
| `openrouter_api_key`    | _(required)_                  | OpenRouter API key                                                                                                                                                                                        |
| `model`                 | `anthropic/claude-sonnet-4-6` | OpenRouter model slug exactly as listed on openrouter.ai/models                                                                                                                                           |
| `fallback_model`        | `""`                          | Model to retry with if the primary model fails the structured-output ladder                                                                                                                               |
| `max_findings`          | `""` _(uncapped)_             | Cap on posted findings, highest severity first. Empty = all validated findings post.                                                                                                                      |
| `severity_threshold`    | `low`                         | Minimum severity to post: `low` \| `medium` \| `high` \| `critical`                                                                                                                                       |
| `conventions_file`      | `AGENTS.md`                   | Repo-relative path to the conventions file included in the prompt                                                                                                                                         |
| `phases`                | `combined`                    | Review phases to run. V1 supports: `combined`                                                                                                                                                             |
| `context_budget_tokens` | `80000`                       | Approximate token budget for prompt context (file contents + diff — conventions have a separate cap)                                                                                                      |
| `trace_related_files`   | `true`                        | Enable heuristic context scanning — import-tracing for caller regressions and mention-matching for doc staleness detection. Does not affect `priority_docs`                                               |
| `priority_docs`         | `README.md`                   | Comma-separated repo-relative paths always included in review context, independent of `trace_related_files`. Shares the doc token budget with mention-matched docs when both are active. Empty = disabled |
| `max_scan_files`        | `5000`                        | Maximum files to walk during workspace scan for related file and doc detection                                                                                                                            |
| `max_scan_bytes`        | `262144`                      | Maximum byte size of a single file to include in the workspace scan                                                                                                                                       |
| `max_related_files`     | `8`                           | Maximum import-traced related files to include in review context                                                                                                                                          |
| `max_related_docs`      | `4`                           | Maximum mention-matched documentation files to include in review context (excludes priority docs)                                                                                                         |
| `cost_summary`          | `true`                        | Write a per-run cost report (model, prompt/completion tokens, USD) to the workflow step summary                                                                                                           |
| `pr_number`             | `""`                          | PR number override — required only when the triggering event does not identify a PR directly                                                                                                              |

## Outputs

| Output           | Description                                                               |
| ---------------- | ------------------------------------------------------------------------- |
| `findings_count` | Number of new findings posted (after threshold, cap, and cross-run dedup) |
| `review_url`     | URL of the submitted review; empty when no review was posted              |
| `model_used`     | Model that produced the accepted response                                 |
| `skipped_reason` | Non-empty when the review was skipped (e.g. diff too large)               |

## How it works

1. Resolves the PR from the triggering event (supports `pull_request`, `pull_request_target`, and `issue_comment` events)
2. Fetches the unified diff via the GitHub API — PRs that exceed the API's diff size limit are skipped
3. Reads the conventions file and changed source files (token-budgeted), traces imports to find related code files, and scans doc files (`.md`, `.json`) for mentions of changed paths
4. Builds a structured prompt with randomized delimiter nonces (prompt injection defense) and sends it to OpenRouter
5. Validates the response against a strict Zod schema, retrying with a fallback model if the primary fails
6. Drops non-findings (see [Non-finding filter](#non-finding-filter)), filters by severity threshold, deduplicates overlapping findings, and caps if configured
7. On re-runs, compares findings against previously posted inline comments (by hidden HTML anchor) and filters out duplicates
8. Maps findings to inline PR review comments anchored to diff lines, with a snap-to-nearest-hunk fallback
9. Posts one review with inline comments (invisible body); beyond-diff findings post as standalone PR comments; every run upserts a status comment with cross-run totals

## Non-finding filter

Models sometimes report "findings" that conclude the code is fine — titled `N/A — …` or `…is correct`, with suggestions like "No action needed". The system prompt prohibits these, but models don't always comply, so every finding also passes a deterministic filter before severity threshold, cross-run dedup, and cap. A finding is dropped when:

- its **title**, **failure_scenario**, or **suggestion** starts with a non-finding signal — `N/A`, `not applicable`, `placeholder`, or a separator-delimited confirmation phrase (`none — …`, `no failure — …`, `no concrete failure scenario — …`, `no bug — …`, `no action needed — …`, `no change needed — …`)
- its **title** ends with a declarative confirmation — `…is correct` or `…is accurate`
- its **failure_scenario** ends with a leaked conclusion — `…no bug here` or `…analysis was wrong`

The patterns are deliberately anchored to the start or end of a field, so real findings survive: a scenario like "No failure occurs until the third retry…" or "None of the guards catch this input" never matches. Dropped counts are logged per run (`filtered non-findings`).

## Status

umm-actually is in early development — the core review pipeline works but there's more to build. Here's what's shipped and what's in progress:

**Shipped (V1)**

- Single-pass review with inline findings anchored to diff lines
- Structured output with retry ladder and fallback model
- Import-tracing: changed code is traced into callers via reverse-import scan
- Doc-mention scan: unchanged docs (`.md`, `.json`) that reference changed code reach the prompt for staleness detection
- Token-budgeted context (changed files + related files + related docs + conventions)
- Prompt injection defense (randomized delimiter nonces)
- Skip-path handling with posted reasons (oversized diff, empty diff, API limits)
- Cost transparency (per-run model/token/USD report in workflow summary)
- `@umm review` comment trigger for on-demand re-reviews
- Cross-run finding dedup — re-runs detect previously posted inline findings via hidden HTML anchors and post only new ones, with an updatable summary comment tracking totals
- Non-finding filter — deterministic drop of findings that amount to "no bug here" (`N/A` prefixes, "no action needed" suggestions, "…is correct" titles) before threshold and cap

**In progress**

- **Branded check run** — using the Checks API so the CI check shows the umm-actually avatar instead of the generic GitHub Actions logo

**Planned**

- V1.5: `read_file` verification tool — the model can read additional files before finalizing findings
- V2: bounded agentic exploration — multi-step investigation with tool use behind a `generateFindings` seam

## License

[MIT](./LICENSE)
