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
- Reports as its **own branded check run** in the PR checks list — the App's avatar, the outcome as the check title (findings count, clean pass, or skip reason), and a details page carrying the summary and per-run cost
- Surfaces the review context in the workflow job summary — files seen, priority-doc coverage, and token budget breakdown

## Setup

umm-actually runs as a Docker-based action. It needs a GitHub token (for fetching the diff and posting the review) and an OpenRouter API key.

For the best experience, use a [GitHub App](https://docs.github.com/en/apps/creating-github-apps) installation token so reviews are attributed to a bot identity rather than a personal account.

Granting the App **Checks: Read & write** additionally puts the review in the PR checks list as a branded check run (the App's avatar instead of the generic Actions logo). The permission is optional — without `checks: write` on the token, the review runs unbranded and everything else works the same. The usage example below requests no permission narrowing on the token step, so the token picks up the Checks scope automatically once the App grants it; a workflow that does narrow permissions must list `permission-checks: write` explicitly (and only once the App has the grant — requesting an ungranted permission fails the token step).

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
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        id: app-token
        with:
          client-id: ${{ secrets.UMM_CLIENT_ID }}
          private-key: ${{ secrets.UMM_PRIVATE_KEY }}

      - uses: aliasunder/umm-actually@v0
        with:
          github_token: ${{ steps.app-token.outputs.token }}
          openrouter_api_key: ${{ secrets.OPENROUTER_KEY }}
```

The `@umm review` comment trigger lets you re-request a review on any PR by commenting. The `issue_comment` event fires for PR comments — the `if` condition filters to PRs only.

## Inputs

| Input                     | Default                       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github_token`            | _(required)_                  | Token for fetching the diff and posting the review. A GitHub App installation token keeps the bot identity.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `openrouter_api_key`      | _(required)_                  | OpenRouter API key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `model`                   | `anthropic/claude-sonnet-4-6` | OpenRouter model slug exactly as listed on openrouter.ai/models                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `fallback_model`          | `""`                          | Model to retry with if the primary model fails the structured-output ladder                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `request_timeout_seconds` | `900`                         | Per-attempt deadline for a single model request, in seconds. When it elapses the attempt is recorded as `timeout` and the retry/fallback ladder advances whether or not the provider connection closes; the HTTP call is aborted best-effort. A request the provider keeps serving past the deadline is still billed, and its cost-summary row shows no cost                                                                                                                                                      |
| `max_findings`            | `""` _(uncapped)_             | Cap on posted findings, highest severity first. Empty = all validated findings post.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `severity_threshold`      | `low`                         | Minimum severity to post: `low` \| `medium` \| `high` \| `critical`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `conventions_file`        | `AGENTS.md`                   | Repo-relative path to the conventions file included in the prompt (truncated at ~8000 tokens). When the file also changed in the PR, deduplication ensures its full text appears exactly once across context channels                                                                                                                                                                                                                                                                                             |
| `phases`                  | `combined`                    | How the review dimensions are dispatched: `combined` (one model call carrying every dimension), `parallel` (three focused calls at once — faster, roughly 3x the prompt tokens), or `sequential` (the same three calls in order, each seeing the earlier findings). Findings two phases report on the same lines collapse to one, keeping the higher severity. Empty = `combined`, so workflows can wire an unset repo variable directly                                                                          |
| `context_budget_tokens`   | `80000`                       | Approximate token budget for prompt context (file contents + diff — conventions have a separate cap)                                                                                                                                                                                                                                                                                                                                                                                                              |
| `trace_related_files`     | `true`                        | Enable heuristic context scanning — import-tracing for caller regressions and mention-matching for doc staleness detection. Does not affect `priority_docs`                                                                                                                                                                                                                                                                                                                                                       |
| `priority_docs`           | `README.md`                   | Comma-separated repo-relative paths included in review context with a reserved 10% budget floor, independent of `trace_related_files`. Docs already present in full from other context channels are not re-read; a diff-only changed file is still read here so its full text reaches the model. Subject to the shared doc token budget (the floor prevents starvation by related files but does not guarantee inclusion when the budget is exhausted by the diff and changed files themselves). Empty = disabled |
| `max_scan_files`          | `5000`                        | Maximum files to walk during workspace scan for related file and doc detection                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `max_scan_bytes`          | `262144`                      | Maximum byte size of a single file to include in the workspace scan                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `max_related_files`       | `8`                           | Maximum import-traced related files to include in review context                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `max_related_docs`        | `4`                           | Maximum mention-matched documentation files to include in review context (excludes priority docs)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `exclude_paths`           | `""`                          | Comma-separated folder prefixes excluded from the workspace scan. Files under these paths are invisible to import-tracing and doc-mention matching. Changed files in the PR diff and `priority_docs` are never excluded. Example: `evals, fixtures, __snapshots__`                                                                                                                                                                                                                                                |
| `cost_summary`            | `true`                        | Write a per-run cost report (model, prompt/completion tokens, USD) to the workflow step summary                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pr_number`               | `""`                          | PR number override — required only when the triggering event does not identify a PR directly                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Outputs

| Output           | Description                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `findings_count` | Number of new findings posted (after the non-finding and unknown-file filters, threshold, cap, and cross-run dedup) |
| `review_url`     | URL of the submitted review; empty when no review was posted                                                        |
| `model_used`     | Model(s) that produced the accepted responses, comma-separated when phases were routed to different models          |
| `skipped_reason` | Non-empty when the review was skipped (e.g. diff too large)                                                         |

## How it works

1. Resolves the PR from the triggering event (supports `pull_request`, `pull_request_target`, and `issue_comment` events); once the PR context is known, opens a check run under the token's identity (best-effort — skipped when the token lacks `checks: write`)
2. Fetches the unified diff via the GitHub API — PRs that exceed the API's diff size limit are skipped
3. Reads the conventions file and changed source files (token-budgeted), traces imports to find related code files, and scans doc files (`.md`, `.json`) for mentions of changed paths
4. Builds a structured prompt with randomized delimiter nonces (prompt injection defense); on re-runs, prior bot comment bodies are included so the model can self-suppress conceptual duplicates. Sends one request per review phase to OpenRouter — `combined` is a single request, `parallel` runs three focused requests at once, `sequential` runs them in order with each phase seeing the earlier findings (see the `phases` input)
5. Validates each response against a strict Zod schema, retrying with a fallback model if the primary fails. A phase that fails after its retry ladder is named on the status comment and the check run while the other phases' findings still post; the run fails only when no phase completes
6. Drops non-findings (see [Non-finding filter](#non-finding-filter)) and findings on files the model was never given (see [Unknown-file filter](#unknown-file-filter)), collapses findings that two phases reported on the same lines, then on re-runs deduplicates against previously posted inline comments (by hidden HTML anchor)
7. Filters remaining findings by severity threshold, deduplicates overlapping findings within the run, and caps if configured
8. Maps findings to inline PR review comments anchored to diff lines, with a snap-to-nearest-hunk fallback
9. Posts one review with inline comments (invisible body); beyond-diff findings post as standalone PR comments; every run upserts a status comment with cross-run totals
10. Completes the check run with the outcome — the conclusion grades the run, not the code: `success` for any completed review (with or without findings — the count is in the check title, and a review that lost a phase says so there too), `neutral` for a skip, `failure` only when the pipeline itself errors

## Non-finding filter

Models sometimes report "findings" that conclude the code is fine — titled `N/A — …` or `…is correct`, with suggestions like "No action needed". The system prompt prohibits these, but models don't always comply, so every finding also passes a deterministic filter before severity threshold, cross-run dedup, and cap. A finding is dropped when:

- its **title**, **failure_scenario**, or **suggestion** starts with a non-finding signal — `N/A`, `not applicable`, `placeholder`, or a separator-delimited confirmation phrase (`none — …`, `not a finding — …`, `no failure — …`, `no concrete failure scenario — …`, `no bug — …`, `no (further) action needed — …`, `no change needed — …`)
- its **title** ends with a declarative confirmation — `…is correct` or `…is accurate` — or starts with a prior-finding resolution confirmation — `Prior (bot) finding(s) addressed/resolved/fixed …`
- its **failure_scenario** ends with a leaked conclusion — `…no bug` / `…no bug here` or `…analysis was wrong`

The patterns are deliberately anchored to the start or end of a field, so real findings survive: a scenario like "No failure occurs until the third retry…" or "None of the guards catch this input" never matches. Dropped counts are logged per run (`non-finding filter applied to model output`).

## Unknown-file filter

A finding's `file` must name a file the model was given: a diff header (including renamed-from and deleted paths), a changed, related, or priority-doc file block, or the conventions file. A finding on any other path is ungrounded — the model saw nothing there — and is dropped before threshold, dedup, and cap. Paths are normalized before comparison (`./src/x.ts` and `src/x.ts` match), but only whole paths match: a bare filename or a directory prefix does not. Each drop is logged as a warning (`dropping finding: file not in prompt context`) with the file, line, and category; the per-run count appears in the job summary.

## Status

umm-actually is in early development — the core review pipeline works but there's more to build. Here's what's shipped and what's in progress:

**Shipped (V1)**

- Inline findings anchored to diff lines
- Phased review — the `phases` input runs every dimension in one model call (`combined`, the default) or splits them into three focused calls, at once (`parallel`) or in order (`sequential`); findings two phases report on the same lines collapse to one
- Structured output with retry ladder and fallback model, per phase
- Import-tracing: changed code is traced into callers via reverse-import scan
- Doc-mention scan: unchanged docs (`.md`, `.json`) that reference changed code reach the prompt for staleness detection
- Token-budgeted context (changed files + related files + related docs + conventions)
- Prompt injection defense (randomized delimiter nonces)
- Skip-path handling with posted reasons (oversized diff, empty diff, API limits)
- Cost transparency (per-attempt phase/model/token/USD report in workflow summary, failed attempts included)
- Every posted comment — inline findings, beyond-diff findings, and the status comment — ends with an `umm-actually · <model>` byline naming the model(s) the run used, so runs under different models or fallbacks stay distinguishable on the PR
- `@umm review` comment trigger for on-demand re-reviews
- Cross-run finding dedup — re-runs detect previously posted inline findings via hidden HTML anchors and post only new ones; prior bot comment bodies also feed into the prompt for conceptual dedup (the model self-suppresses even when positional anchors differ). An updatable summary comment tracks totals
- Non-finding filter — deterministic drop of findings that amount to "no bug here" (`N/A` prefixes, "no action needed" suggestions, "…is correct" titles) before threshold and cap
- Unknown-file filter — findings on a path the model was never given are dropped before posting instead of surfacing as beyond-diff comments
- Branded check run — the review reports as its own check via the Checks API, with the App avatar and the outcome on the check's details page

**Planned**

- V1.5: `read_file` verification tool — the model can read additional files before finalizing findings
- V2: bounded agentic exploration — multi-step investigation with tool use behind a `generateFindings` seam

## License

[MIT](./LICENSE)
