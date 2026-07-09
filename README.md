# umm-actually

LLM-powered pull request review as a GitHub Action. One consolidated review per PR with inline findings, powered by any model on [OpenRouter](https://openrouter.ai).

> Full documentation, inputs reference, and setup guide land with the first release. This repo is under active initial development.

## What it does

- Reviews the PR diff **and traces changed code into its callers** — regressions and pre-existing bugs in affected code are findings, not noise
- Reads your repo's conventions file (`AGENTS.md` by default) and reviews against it
- Posts exactly **one** PR review with inline comments anchored to diff lines — no duplicate comments, no unrequested-reviewer badges
- Structured output end to end: every finding carries a category, severity, confidence, and a concrete failure scenario
- Model-agnostic via OpenRouter — pick your model, see your per-call costs

## License

[MIT](./LICENSE)
