# AGENTS.md

Project conventions for AI-assisted development on umm-actually.

## What this project is

A Docker-based GitHub Action that reviews pull requests with an LLM via
OpenRouter and posts one consolidated PR review with inline findings. The
review is diff-anchored but not diff-bounded: changed code is traced into
its callers, and pre-existing bugs in traced code are valid findings.

## Structure

```text
action.yml                 # action metadata — inputs/outputs, runs.using: docker
Dockerfile                 # multi-stage: build (tsc) → slim runtime
fixtures/                  # test fixtures (event payloads, sample diff, LLM responses)
src/
  main.ts                  # entrypoint — collects/validates inputs, wires clients into orchestrate, sets outputs
  config.ts                # action inputs → validated ActionConfig
  logger.ts                # structured JSON logger — levels, child contexts, lazy props
  github/                  # GitHub I/O: event payload → PrContext, octokit wrappers (diff fetch, review posting)
  openrouter/              # OpenRouter I/O: @openrouter/sdk wrapper, structured-output retry ladder, cost summary
  diff/                    # pure transforms over parse-diff output
  context/                 # workspace I/O: conventions file, changed files, import-trace scan, doc-mention scan
  review/                  # pure review logic: finding schema, phases, prompt, selection, comment mapping
  orchestrate.ts           # pipeline + createPromptedGenerateFindings — fully testable with stub clients
```

## Module layering

Pure leaves (`diff/`, `review/`) → I/O clients (`github/`, `openrouter/`,
`context/`) → composition (`orchestrate.ts`). Only `main.ts` touches real
`process.env` and constructs SDK clients. A pure module importing an I/O
module is a backwards dependency and a bug — enforced by a
`@typescript-eslint/no-restricted-imports` block in `eslint.config.ts`
(type-only imports are allowed; they're erased at compile time).

Use the official SDKs — don't hand-roll what `@actions/core`,
`@actions/github` (octokit), `@openrouter/sdk`, or `parse-diff` already do.
Before writing any parsing or validation helper, check the SDK's utility
surface first: `@actions/core` ships `getBooleanInput` (strict YAML 1.2
booleans), which replaced a hand-rolled boolean-string Zod transform here.
Values an SDK util already parses arrive in `RawInputs` pre-parsed from the
collection boundary (main.ts) — "validation lives in config.ts" is about
where _our_ rules live, not a reason to reimplement the platform's. Zod
validates the things that are genuinely ours: LLM structured output and
action config.

Types are colocated with the code that uses them — no standalone types
files. Prefer SDK-provided types over redefining shapes.

## Code style

- Functional over OOP. Arrow functions over `function` declarations.
- Factory/closure pattern for stateful modules; single namespace export for
  cohesive service surfaces (`githubClient.submitReview(…)`).
- `type` over `interface`. TypeScript strict mode. `node:` prefix for built-ins.
- Explicit return types on exports. No `any`. No `as` or `!` — use runtime
  guards or schema validation to narrow. Truthy/falsy checks over explicit
  `!== undefined` comparisons — use `if (value)` not `if (value !== undefined)`
  unless distinguishing `undefined` from other falsy values (`null`, `0`, `""`,
  `false`) actually matters for correctness.
- Immutable by default; avoid `let`. A `reduce` must return a new accumulator
  each step — never mutate-and-return. When mutation is genuinely needed,
  add a comment justifying it.
- Explicit names over abbreviations, everywhere — params, callbacks, locals.
- Early returns over nested `if/else`. When a function has a primary path and
  a secondary path (e.g. first-run vs re-run), return early from the simpler
  branch so the remaining code flows linearly without nesting. Extract
  multi-clause conditionals into named booleans. Name booleans for the
  affirmative state.
- Block bodies `{}` for any multiline function response — expression bodies
  only for one-liners. A multi-clause boolean spanning lines gets
  `{ return (...) }`; guard chains get explicit early returns, never a
  chained `||`/ternary expression body.
- Named params for functions with more than two args or adjacent same-typed
  args.
- Data-layer and I/O functions take `(params, logger)` — logger is required.
- `process.env` is never read via raw property access. Action inputs
  (`INPUT_*`) go through `@actions/core` `getInput`/`getBooleanInput`; the
  event name and payload come from `@actions/github` `context` (it reads
  `GITHUB_EVENT_NAME`/`GITHUB_EVENT_PATH` and parses the JSON — don't
  hand-read those); remaining ambient environment (`GITHUB_WORKSPACE`, …)
  goes through the `env-var` package
  (`envVar.from(env).get("NAME").required().asString()`), with the env
  record injectable for tests.
- Comments explain non-obvious domain context; never restate what a
  self-documenting name already says. Regex constants get doc comments.
- Relative imports use explicit `.js` extensions (ESM runtime requirement).

## Test conventions

- Tests read as a behavioral spec: one focused `it()` per behavior, named so
  a failure identifies the regression without reading the body.
- `const` per test via factory helpers; `beforeEach` only when per-test
  creation is genuinely impractical.
- Exact assertions over loose matchers; assert whole values over substrings
  when output is deterministic. When fixtures and stubs produce deterministic
  results, assert the entire return value or call params — not just individual
  fields. Asserting fragments is the cheap option; asserting the whole value
  catches drift in formatting, structure, and attribution that field-level
  checks miss.
- Two-bar rule: a test must (1) fail when the behavior breaks and (2) pass
  only because the intended behavior occurred. Guard against silent no-op,
  wrong-error, and early-return passes.
- Stub SDK clients are plain objects injected through factories — no HTTP
  mocking libraries.
- Fixtures live in `fixtures/` and are shared across test files.

## CI conventions

- Pin third-party actions to full commit SHAs with a version comment.
- Top-level `permissions: contents: read`; jobs escalate individually.
- Secrets scoped to steps, never job-level env.
- `persist-credentials: false` on checkout unless a push is required.
