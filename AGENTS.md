# AGENTS.md

<!-- distilled from vault Reference/code-standards-* on 2026-08-24; refresh: run the sync-code-standards skill -->

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
  main.ts                  # entrypoint — collects/validates inputs, wires clients into orchestrate, sets outputs, exits explicitly
  config.ts                # action inputs → validated ActionConfig
  logger.ts                # structured JSON logger — levels, child contexts, lazy props
  github/                  # GitHub I/O: event payload → PrContext, octokit wrappers (diff fetch, review posting)
  openrouter/              # OpenRouter I/O: @openrouter/sdk wrapper, per-attempt deadline, structured-output retry ladder, cost summary
  diff/                    # pure transforms over parse-diff output + diff-level exclusion (patterns, gitattributes linguist rules, wildcard safety cap)
  context/                 # workspace I/O: conventions file, root .gitattributes, changed files, import-trace scan, doc-mention scan, priority docs
  review/                  # pure review logic: finding schema, phases + stage dispatch, prompt, non-finding filter, unknown-file filter, cross-phase merge, path normalization, selection, comment mapping, title similarity, context notes, summary
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
- Comment decision at write time (use `/** */`; only when earned):
  (1) Can a reader understand this from name + params + return type? → no
  comment — this is most functions. (2) Something non-obvious? → one-line
  JSDoc stating the constraint the signature doesn't convey. (3) Does the
  JSDoc restate the function name? → delete it. (4) More than 2 lines? →
  pick the format the reader absorbs quickest (bullets, numbered steps),
  never multi-paragraph prose. Inline comments go directly above the
  relevant line — don't stuff implementation details into the docstring.
  Regex constants get doc comments.
- Scope constants to where they're used — module level overstates
  visibility when only one function needs the value.
- A boolean mode param means the function does two things — split into
  two single-responsibility functions; the caller owns the gating.
- Type-only imports over structural duplication — don't clone interfaces
  for "module purity"; type imports are erased at compile time.
- Extract multi-step `.map()`/`.reduce()` callbacks into named functions
  when they nest chains or build intermediates. Conditional spreads and
  `.filter(Boolean)` are both fine — pick whichever reads clearer; don't
  convert mechanically. Name non-trivial `.filter()` predicates.
- Per-operation try/catch — each catch encloses one operation with one
  failure meaning. Broad catch-alls are banned. Every catch logs or
  re-throws; a swallowed error is worse than an uncaught one.
- Required inputs enforced at every entry point — fail fast at boot/load.
  Making an already-expected value mandatory is a bug fix, not a breaking
  change.
- Parse structured strings with a declarative regex (named groups), not
  index arithmetic.
- `Boolean(x)` over `!!x`. TS ≥5.5 infers `.filter()` predicates from
  bare comparisons — omit explicit type-guard annotations on `.filter()`
  with a bare null/undefined check.
- Relative imports use explicit `.js` extensions (ESM runtime requirement).

## Test conventions

- Tests read as a behavioral spec: one focused `it()` per behavior, named so
  a failure identifies the regression without reading the body.
- `const` per test via factory helpers; `beforeEach` only when per-test
  creation is genuinely impractical.
- Exact assertions over loose matchers; assert whole values over substrings
  when output is deterministic. When fixtures and stubs produce deterministic
  results, assert the entire return value or call params — not just individual
  fields. For large deterministic strings (prompts, rendered output), assert
  the full section or constant in one `toContain` — not multiple fragments
  that each check a phrase. Asserting fragments is the cheap option;
  asserting the whole value catches drift in formatting, structure, and
  attribution that field-level checks miss.
- Two-bar rule: a test must (1) fail when the behavior breaks and (2) pass
  only because the intended behavior occurred. Four traps against bar 2:
  **silent no-op** (assert the trigger happened, not just that state was
  retained), **wrong-error** (`rejects.toThrow()` with no argument matches
  ANY error — assert the specific message), **early-return** (assert a
  side effect only the intended path produces), **wrong-item** (assert the
  specific expected item, not just "something came back").
- When unsure a test can fail for the right reason, mutate the production
  code and watch it fail — for that specific reason.
- Never decompose: `toHaveLength(1)` + index-based checks is weaker than
  one `toEqual` on the mapped result — the decomposed form misses extra
  items, ordering, and unexpected properties.
- Filter tests seed data both inside AND outside the filter — exclusion
  is half the behavior.
- Stub SDK clients are plain objects injected through factories — no HTTP
  mocking libraries.
- Every test file maps to a real source module — don't spawn a standalone
  test file to mock differently.
- Fixtures live in `fixtures/` and are shared across test files.

## Logging & observability

- Use `logger.ts`, never `console.log` — logger params are required, not
  optional.
- Thread the caller's logger into domain functions so deep events inherit
  request context.
- Levels: **error** (failed, needs attention), **warn** (degraded but
  handled), **info** (state changes an operator cares about), **debug**
  (diagnostic detail, off by default). Per-item loops log debug; their
  summary logs info.
- Never log PII, credentials, tokens, or secrets — log identifiers, not
  identity payloads. Redact via destructuring, not `delete` on copies.
- Every catch logs the error AND enough context (path, operation) to
  diagnose from the log alone.
- Internal functions describe what went wrong in their own domain — never
  name API surfaces or prescribe caller-level remediation.

## Docs

- Docs update in the same change that alters behavior — README, action.yml
  inputs, and the AGENTS.md structure tree all update in the same PR that
  changes the feature surface.
- Adding a concept (env var, input, file, feature) means sweeping every
  doc that lists its peers.
- Write-time format decision: information gets structured format (table
  for lookups, bullets for parallel items, numbered steps for sequences);
  narrative goes in the PR description, not committed files. More than 3
  sentences of prose → wrong format. Match sibling sections in length.
- No internal references in any public artifact — issue/PR numbers,
  task-board IDs, incident dates, deployment names, and investigation
  chronology never enter committed files, PR descriptions, or comments.

## Review instruction authoring

The bot's system-prompt instructions live in `src/review/phases.ts`
(dimension constants, the per-phase pass-scope line, reporting rules, and
the phase groups each `phases` mode dispatches) and `src/review/prompt.ts`
(identity/scope, proof-of-work, severity rubric, output discipline).

**Phase/stage mechanics:** a phase is one model call carrying a set of
review dimensions. A stage groups the phases that run concurrently; stages
run in order, and each later stage sees the earlier stages' findings.
`combined` = 1 stage, 1 phase; `parallel` = 1 stage, 3 phases;
`sequential` = 3 stages, 3 phases (1 each). The dispatch stack is
`runStages` → `runStage` → `runPhase` in `src/review/run-stages.ts`;
cross-phase finding collapse lives in `src/review/merge-phase-findings.ts`.

When writing or updating a review instruction, follow this formula — each
element is here because its absence measurably cost findings in live runs:

- **Trigger, not preference.** Action + condition + boundary: "when you see
  X → derive/trace Y → flag if Z. Boundary: keep quiet when W." Preference
  statements ("prefer exact assertions") get skipped; procedural triggers
  fire. The boundary is what separates a finding from noise — never ship a
  trigger without one.
- **Name literal scan targets.** Spell out the exact tokens the model
  should pattern-match in a diff (`toBeTruthy`, `.catch(() => {})`,
  `${VAR:-}`). A rule whose tokens never appear in the instruction text
  relies on concept-matching, which misses.
- **Wrong/Right micro-examples on high-yield rules.** A few-line pair
  steers the model harder than a paragraph of prose. Budget them — the
  system prompt loads on every review call.
- **Proof-of-work coupling for skippable checklists.** A check the model
  can silently skip needs a required enumeration in the "analysis" field
  (quote each doc sentence checked; name each changed it() and its
  derivable exact value). Skipping must be visible in the output, not just
  discouraged.
- **Single-call constraint.** Every check must be resolvable by reasoning
  over the prompt-provided files — no instruction may assume tools, test
  runs, grep, or repository access beyond the prompt context.
- **Drift-guard the load-bearing rules.** Each rule that matters gets a
  targeted fragment assertion in `src/review/__tests__/phases.test.ts`
  (test-owned strings, whitespace-normalized) so accidental removal fails
  the suite.
- **Validate live with a planted finding.** Before trusting a new check,
  plant a violation it should catch on a PR (self-review builds from the
  branch, so the PR's own instructions review it), verify the catch, then
  revert the plant.

## CI conventions

- Pin third-party actions to full commit SHAs with a version comment.
- Top-level `permissions: contents: read`; jobs escalate individually.
- Secrets scoped to steps, never job-level env.
- `persist-credentials: false` on checkout unless a push is required.
