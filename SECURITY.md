# Security Policy

## Scope

This is a GitHub Action that sends pull request content to an LLM via
[OpenRouter](https://openrouter.ai) and posts the model's findings as a PR
review. The attack surface this repository owns:

- **The action's TypeScript** — event payload parsing, diff parsing, prompt
  assembly, LLM response validation, and review submission
- **Credential handling** — `github_token` and `openrouter_api_key` arrive as
  action inputs (environment variables inside the container); they are never
  logged, persisted, or included in prompts
- **The Docker image** — base image and build stages
- **CI/CD workflows** — GitHub Actions that test and build the image

## Data flow — know what leaves GitHub

By design, the action sends the PR diff, changed-file contents, related-file
contents, and the repo's conventions file to the model you configure via
OpenRouter. Do not run it on repositories whose code must not be shared with a
third-party model provider. Review [OpenRouter's privacy policy](https://openrouter.ai/privacy)
and your chosen provider's data retention terms.

## Untrusted input

PR content (diffs, file contents, titles, descriptions) is untrusted input to
the LLM — prompt injection by a malicious PR is part of the threat model. The
action's blast radius is deliberately narrow: its only write operation is
submitting a PR review (comments), it executes no code from the PR, and the
recommended token is a GitHub App installation token scoped to
`pull-requests: write` + `contents: read`. A successful injection can produce
misleading review comments, not repository changes.

## Reporting a vulnerability

Please report security issues through
[GitHub's private vulnerability reporting](https://github.com/aliasunder/umm-actually/security/advisories/new)
rather than opening a public issue.

Please include:

- A description of the vulnerability
- Steps to reproduce or a proof of concept
- The potential impact

You should receive an acknowledgment within **48 hours**, and I'll coordinate a
fix before any public disclosure.

## Supported versions

Only the latest released version is actively maintained. Please upgrade before
reporting.

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |
| Older   | No        |
