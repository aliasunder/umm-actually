# Changelog

## [0.3.14] — 2026-09-02

### Bug Fixes

- Make the per-attempt request deadline authoritative (#75)
- Drop findings whose file the model was never given (#74)
- **release:** Pass previous release as --notes-start-tag (#71)

### CI / Infrastructure

- **release:** Adopt CHANGELOG.md pattern with generated release notes (#72)

### Maintenance

- **deps:** Bump @openrouter/sdk in the production group (#68)
- **deps-dev:** Bump the development group with 3 updates (#69)

## [0.3.13] — 2026-08-27

### Features

- Surface priority-doc skips and token budget in job summary (#70)

## [0.3.12] — 2026-08-27

### Features

- Add priority doc visibility note and budget floor (#67)

### Maintenance

- Add CLAUDE.md as symlink to AGENTS.md (#65)
- Sync code standards from vault (#64)

## [0.3.11] — 2026-08-20

### Features

- Append model attribution to every posted finding comment (#63)

### Maintenance

- **deps:** Bump @openrouter/sdk in the production group (#61)
- **deps:** Bump docker/setup-buildx-action from 4.2.0 to 4.3.0 (#60)
- **deps-dev:** Bump typescript-eslint in the development group (#62)

## [0.3.10] — 2026-08-19

### Features

- Add `exclude_paths` input to prune folders from workspace scan (#59)

## [0.3.9] — 2026-08-18

### Bug Fixes

- Replace SDK AbortSignal.timeout with application-level AbortController (#58)
- Drop false maxScanBytes justification in priorityDocsInContext comment (#57)

## [0.3.8] — 2026-08-18

### Features

- Refresh review instructions from upstream skill updates (#55)

## [0.3.7] — 2026-08-18

### Bug Fixes

- Disable SDK-internal retry so request_timeout_seconds bounds the attempt (#54)
- Never render a file's full text twice in the review prompt (#53)

## [0.3.6] — 2026-08-15

### Bug Fixes

- Add per-attempt request timeout so a hung provider call fails into the retry ladder (#52)

## [0.3.5] — 2026-08-13

### Bug Fixes

- Filter prior-finding resolution confirmations from review output (#51)

### Maintenance

- **deps:** Bump node from `6f7b03f` to `3638d9a` (#48)
- **deps:** Bump @openrouter/sdk in the production group (#49)
- **deps-dev:** Bump the development group with 4 updates (#50)

## [0.3.4] — 2026-08-08

### Maintenance

- **deps:** Bump undici from 6.27.0 to 6.28.0 (#47)
- **deps:** Bump @openrouter/sdk in the production group (#45)
- **deps-dev:** Bump the development group with 2 updates (#46)

## [0.3.3] — 2026-08-04

### Bug Fixes

- Set maxCompletionTokens to prevent truncated structured output (#44)

## [0.3.2] — 2026-08-03

### Bug Fixes

- Log oversized files skipped during workspace scan (#43)

## [0.3.1] — 2026-08-03

### Features

- **review:** Self-describing finding headers (#42)

## [0.3.0] — 2026-07-30

### Features

- Branded check run via Checks API (#41)

### Maintenance

- **deps:** Bump @openrouter/sdk in the production group (#38)
- **deps-dev:** Bump the development group with 3 updates (#39)
- **deps:** Bump actions/checkout from 7.0.0 to 7.0.1 (#37)
- **deps:** Bump docker/login-action from 4.4.0 to 4.6.0 (#36)

## [0.2.0] — 2026-07-27

### Features

- Manual release workflow — one-click version bump and tag (#32)
- Expand review dimension instructions with systematic checks and reporting rules (#31)
- Feed prior bot comments to model for conceptual dedup (#27)
- Extend non-finding filter to title + suggestion fields (#24)
- Doc-staleness context — mention-based reverse-reference scan (#10)
- Quiet re-runs — cross-run dedup, one status comment, no per-run review blocks (#12)
- Request bot as PR reviewer via GraphQL botIds (#11)
- Cross-run finding dedup + updatable summary on re-run (#8)
- Filter non-findings and constrain comment verbosity (#9)
- V1 orchestration pipeline, workflows, and README (#7)
- V1 I/O clients — github, openrouter, workspace context (#3)
- Scaffold V1 — configs, action metadata, pure review core (#1)

### Bug Fixes

- **release:** Correct private-key secret name — RELEASE_APP_PRIVATE_KEY (#35)
- Include changed lockfiles as diff-only — lockfiles starve the context budget (#33)
- Migrate app-id to client-id + add pipeline observability logs (#26)

### Refactoring

- Remove requestBotReview — GitHub silently drops bot reviewer requests (#23)

### Documentation

- **AGENTS:** Distill cross-project code standards from vault (#25)

### CI / Infrastructure

- Skip self-review on dependabot PRs (#21)

### Maintenance

- **deps-dev:** Bump postcss from 8.5.16 to 8.5.23 (#34)
- **deps:** Bump @openrouter/sdk in the production group (#29)
- **deps:** Bump actions/checkout from 7.0.0 to 7.0.1 (#28)
- **deps-dev:** Bump the development group with 3 updates (#30)
- **deps:** Bump docker/setup-buildx-action from 3.12.0 to 4.2.0 (#17)
- **deps:** Bump docker/login-action from 3.7.0 to 4.4.0 (#16)
- **deps:** Bump docker/metadata-action from 5.10.0 to 6.2.0 (#14)
- **deps:** Bump docker/build-push-action from 6.19.2 to 7.3.0 (#13)
- **deps:** Bump actions/setup-node from 6.4.0 to 7.0.0 (#18)
- **deps:** Bump node from `cb4e8f7` to `6f7b03f` (#15)
- **deps-dev:** Bump typescript-eslint in the development group (#20)
- **deps:** Bump @openrouter/sdk in the production group (#19)
- **deps-dev:** Bump the development group with 2 updates (#6)
- **deps:** Bump @openrouter/sdk in the production group (#5)
- Expand dependabot config — npm, github-actions, docker major ignore (#4)
- Remove misleading parseJsonOrNull comment
- Initial commit — license, readme, gitignore
