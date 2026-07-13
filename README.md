# umm-actually

LLM-powered pull request review as a GitHub Action. One consolidated review per PR with inline findings, powered by any model on [OpenRouter](https://openrouter.ai).

## What it does

- Reviews the PR diff **and traces changed code into its callers** — regressions and pre-existing bugs in affected code are findings, not noise
- Reads your repo's conventions file (`AGENTS.md` by default) and reviews against it
- Posts exactly **one** PR review with inline comments anchored to diff lines — no duplicate comments, no unrequested-reviewer badges
- Structured output end to end: every finding carries a category, severity, confidence, and a concrete failure scenario
- Model-agnostic via OpenRouter — pick your model, see your per-call costs
- Findings that can't be anchored to the diff (e.g. callers outside the changed files) render in the review body under "Findings beyond the diff"
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

| Input                   | Default                       | Description                                                                                                 |
| ----------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `github_token`          | _(required)_                  | Token for fetching the diff and posting the review. A GitHub App installation token keeps the bot identity. |
| `openrouter_api_key`    | _(required)_                  | OpenRouter API key                                                                                          |
| `model`                 | `anthropic/claude-sonnet-4-6` | OpenRouter model slug exactly as listed on openrouter.ai/models                                             |
| `fallback_model`        | `""`                          | Model to retry with if the primary model fails the structured-output ladder                                 |
| `max_findings`          | `""` _(uncapped)_             | Cap on posted findings, highest severity first. Empty = all validated findings post.                        |
| `severity_threshold`    | `low`                         | Minimum severity to post: `low` \| `medium` \| `high` \| `critical`                                         |
| `conventions_file`      | `AGENTS.md`                   | Repo-relative path to the conventions file included in the prompt                                           |
| `phases`                | `combined`                    | Review phases to run. V1 supports: `combined`                                                               |
| `context_budget_tokens` | `80000`                       | Approximate token budget for prompt context (file contents + diff — conventions have a separate cap)        |
| `trace_related_files`   | `true`                        | Include files that reference changed files in the prompt so the model can trace regressions into callers    |
| `cost_summary`          | `true`                        | Write a per-run cost report (model, prompt/completion tokens, USD) to the workflow step summary             |
| `pr_number`             | `""`                          | PR number override — required only when the triggering event does not identify a PR directly                |

## Outputs

| Output           | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| `findings_count` | Number of findings posted (after threshold and cap)          |
| `review_url`     | URL of the submitted review; empty when no review was posted |
| `model_used`     | Model that produced the accepted response                    |
| `skipped_reason` | Non-empty when the review was skipped (e.g. diff too large)  |

## How it works

1. Resolves the PR from the triggering event (supports `pull_request`, `pull_request_target`, and `issue_comment` events)
2. Fetches the unified diff via the GitHub API — PRs that exceed the API's diff size limit are skipped
3. Reads the conventions file and changed source files (token-budgeted), traces imports to find related code files, and scans doc files (`.md`, `.json`) for mentions of changed paths
4. Builds a structured prompt with randomized delimiter nonces (prompt injection defense) and sends it to OpenRouter
5. Validates the response against a strict Zod schema, retrying with a fallback model if the primary fails
6. Filters findings by severity threshold, deduplicates overlapping findings, and caps if configured
7. Maps findings to inline PR review comments anchored to diff lines, with a snap-to-nearest-hunk fallback
8. Posts one consolidated review — findings that can't be inlined render in the review body

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

**In progress**

- **Review dedup on re-runs** — currently each push posts a new review; working on deduplicating findings across runs and updating a single summary comment instead of creating new ones
- **Branded check run** — using the Checks API so the CI check shows the umm-actually avatar instead of the generic GitHub Actions logo

**Planned**

- V1.5: `read_file` verification tool — the model can read additional files before finalizing findings
- V2: bounded agentic exploration — multi-step investigation with tool use behind a `generateFindings` seam

## License

[MIT](./LICENSE)
