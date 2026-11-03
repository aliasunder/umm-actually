# AGENTS.md

<!-- distilled from vault Reference/code-standards-* on 2026-11-03; refresh (merges, keeps hand edits): run the sync-code-standards skill -->

Project conventions for AI-assisted development on umm-actually.

## What this project is

A Docker-based GitHub Action that reviews pull requests with an LLM via
OpenRouter and posts one consolidated PR review with inline findings. The
review is diff-anchored but not diff-bounded: changed code is traced into
its callers, and pre-existing bugs in traced code are valid findings.

## Structure

```text
.claude/                   # committed Claude Code session hooks (the rest of .claude/ is gitignored)
  settings.json            # SessionStart + PostToolUse(EnterWorktree) → install-deps.sh
  hooks/
    install-deps.sh        # loads nvm, runs npm ci when a fresh clone or worktree has no node_modules
action.yml                 # action metadata — inputs/outputs, runs.using: docker
Dockerfile                 # multi-stage: build (tsc) → slim runtime
fixtures/                  # test fixtures (event payloads, sample diff, LLM responses)
src/
  main.ts                  # entrypoint — collects/validates inputs, wires clients into orchestrate, sets outputs, closes the check run on cancellation signals, exits explicitly
  config.ts                # action inputs → validated ActionConfig
  logger.ts                # structured JSON logger — levels, child contexts, lazy props
  github/                  # GitHub I/O: event payload → PrContext, octokit wrappers (diff fetch, review posting)
  openrouter/              # OpenRouter I/O: @openrouter/sdk wrapper, per-attempt and shared review deadlines, retry and fallback ladder (HTTP errors, timeouts, invalid structured output), cost summary
  diff/                    # pure transforms over parse-diff output: git-quoted path decoding, annotation, commentable lines, diff-level exclusion (patterns, gitattributes linguist rules, wildcard safety cap)
  context/                 # workspace I/O: conventions file, root .gitattributes, changed files, import-trace scan, doc-mention scan, priority docs
  review/                  # pure review logic: finding schema, phases + stage dispatch, prompt, non-finding filter, unknown-file filter, cross-phase merge, path normalization, selection, comment mapping, markdown code spans, title similarity, context notes, summary
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

- Prefer functional code over OOP and arrow functions over `function`
  declarations; leaf helpers sit above their callers so a file reads top to
  bottom.
- Stateful modules use the factory/closure pattern, and a cohesive service
  surface is one object of operations (`githubClient.submitReview(…)`).
  Parsers and config readers export named functions. Each module keeps one
  export style.
- Use `type` over `interface`, TypeScript strict mode, and the `node:`
  prefix for built-ins. Relative imports use explicit `.js` extensions. Every
  `.ts` file under `src/` compiles in `npm run build`; a file that cannot
  meet project strictness gets its own small tsconfig wired into the build,
  never an exemption.
- Exports declare explicit return types. Never use `any`, `as` or `!`
  (`as const` exempt); narrow with runtime guards or schema validation.
  Prefer truthy/falsy checks (`if (value)`) over explicit `!== undefined`
  comparisons unless `null`, `0`, `""` or `false` must stay distinct from
  `undefined`. When later code needs the narrowed type, a `.filter()`
  callback compares its parameter to `undefined` or `null`, because TS ≥5.5
  narrows from that comparison and `filter(Boolean)` does not. Use
  `Boolean(x)` over `!!x`. Optional chaining and nullish coalescing flatten
  guards (`value?.prop ?? fallback` over guard-then-access).
- Model states in the type system. A result with modes is a discriminated
  union with `never` exhaustiveness, not optional fields documented as
  "present only in mode X". Each fact has one discriminant, so a new case
  becomes a member of that union, never a second result shape with a
  converter. Branch on a union of outcomes with an exhaustive `switch` naming
  every member, never an `if` plus a ternary whose fallback catches the rest
  unnamed. A param read only for truthiness becomes a `boolean` named for
  the action it controls, never a value-or-`""` sentinel. Prefer type-only
  imports over structural duplication, and never clone an interface.
- Code is immutable by default; avoid `let`. A `reduce` must return a new
  accumulator each step. When mutation is genuinely needed, add a comment
  justifying it. Prefer the non-mutating array methods
  (`toSorted`, `toSpliced`, `with`, `at(-1)`, `findLast`). A helper never
  mutates its inputs; it returns the new value and types collection params as
  readonly views (`ReadonlyArray`, `ReadonlySet`). Readability outranks
  functional style in any refactor.
- Use explicit names over abbreviations everywhere. A placeholder (`row`,
  `item`) fails whenever a domain noun exists, and a pipeline intermediate
  keeps its domain prefix (`statusInput → statusValues`). Value-returning
  functions name what they return (`getX`, not `ensureX`); side-effect
  functions say what they do; every name carries the noun it acts on, and a
  converter goes input noun → output noun. Never end a name with `Of`
  (`findPhaseResult`, not `phaseResultOf`); rename an existing one only when
  a change already touches it. Every term in a name must make sense to a
  reader who never saw the change's planning. Booleans are named for the
  affirmative state, and a boolean that gates a step is named for that step
  (`needsPriorityDocFloor`).
  A generic destructured key keeps its source
  (`const { kept: reviewableFiles } = partitionExcludedFiles(…)`). Modules
  and folders are named for what the code does and everything it owns.
- Wire names stay at the boundary. Action inputs are `snake_case` and
  `ActionConfig` is `camelCase`; map once in `main.ts`/`config.ts`. An input
  is named for the user's mental model of the switch, not for the
  implementation's flag.
- When a function has a primary and a secondary path (first run vs re-run),
  return early from the simpler one so the rest flows without nested
  `if/else`. Extract multi-clause conditionals into named booleans.
- Never write a chained ternary (a second `?` inside a ternary) or assign a
  `let` through if/else branches; use one `if … return` per branch in a
  small helper, or one named const per decision step. Use `while (condition)`
  over `for (;;)` + `break` when the exit condition fits the loop head.
- Blank lines separate logical steps inside a function. Put one before each
  guard, each step and each commented declaration, so no comment sits
  directly under the previous statement. ESLint enforces the
  declaration-before-`if` case; the rest is on the author.
- A function whose returned expression spans lines gets a block body `{}`;
  expression bodies are for one-liners. A multi-clause boolean spanning
  lines gets `{ return (...) }`; guard chains get explicit early returns,
  never a chained `||`/ternary expression body.
- Use named params for functions with more than two args, adjacent
  same-typed args, or one literal whose purpose is unclear at the call site.
  When a param only labels a log or report, keep the check a pure predicate
  and let the caller report. Use named records over positional tuples;
  index-aligned parallel arrays become one record per item; destructure an
  object accessed twice or more; name a cryptic sub-expression. When every
  call site passes `() => alreadyComputed`, accept the plain value instead
  of a thunk.
- Functions in the pure leaves and I/O clients take `(params, logger)`, and
  the logger is required. Such a function never truncates its output or
  returns data that exists only for logging; presentation limits belong to
  the consumer, and the function logs at the site.
- `process.env` is never read via raw property access. Action inputs
  (`INPUT_*`) go through `@actions/core` `getInput`/`getBooleanInput`, and
  the event name and payload come from `@actions/github` `context`; never
  hand-read `GITHUB_EVENT_NAME` or `GITHUB_EVENT_PATH`. Remaining ambient
  environment (`GITHUB_WORKSPACE`, …) goes through the `env-var` package
  (`envVar.from(env).get("NAME").required().asString()`), with the env
  record injectable.
- A new default-on input gets an explicit sentinel off value (`none`), never
  an empty string. A new list input extends its shipped default list, and a
  leading `none` replaces it. In `diff_exclude_paths`, `evals/**` adds to
  the defaults and `none, evals/**` replaces them. `priority_docs` is the
  documented exception, where any value replaces the default.
- Decide each comment at write time, and write one (`/** */`) only when it
  is earned:
  1. When the name, params and return type explain the function, write no
     comment.
  2. When something is non-obvious, write a one-line JSDoc stating the
     constraint the signature doesn't convey.
  3. When a JSDoc restates the function name, delete it.
  4. When a comment explains what instead of why, rewrite it as the
     constraint.
  5. When a comment needs more than 2 lines, pick the format the reader
     absorbs quickest (bullets, numbered steps), never multi-paragraph prose.
- Inline comments go directly above the relevant line; keep implementation
  details out of the docstring. Regex constants get doc comments. A guard's
  comment states the scenario, the mechanism, and what breaks without it; a
  mechanism-only label or an undefined term fails. A borrowed standard term
  gets a one-line gloss and a link to its authoritative source.
- Comments carry durable rationale only, never transition history, decision
  narrative or name-choice provenance; a genuine risk of retracing an
  abandoned error is rationale, not history. Every chosen number in workflow
  or action YAML (caps, timeouts) gets its why directly above it. Comment
  prose uses short complete sentences. No sentence opens with a label and a
  colon (`Note:`), and none lacks a verb.
- Use named constants over bare magic literals, with the one-line why at
  the definition. Scope constants to where they're used.
- A boolean param that picks between two behaviors means the function does
  two things; split it into two single-responsibility functions and let the
  caller own the gating.
- Decomposition must earn its seams, and DRY targets shared decisions, not
  repeated text. Extract when code holds one decision that must change in
  several places together, or to name a decision worth naming. A
  one-expression wrapper over an SDK or Zod call stays inline even with
  several call sites (`z.boolean().default(true)` at each input, not a
  `booleanOrDefault(true)` helper). A parameter a function only forwards
  means the seam is wrong — compile configuration once into a
  factory/closure and pass the resulting collaborator, never thread config
  through layers that don't read it. One concern stays in one module; a
  module boundary needs an independent consumer, so files that only import
  each other belong in one module. A shared helper needs two gates before it
  moves into a shared folder such as `utils/`: zero domain knowledge, and
  either a decision several callers share or a standalone primitive
  describable without naming a caller.
- When config switches multiply (phase groups, exclusion sources), list them
  in a declarative registry and combine one predicate per switch with AND,
  never per-flag branching. A new switch adds one predicate.
- Extract multi-step `.map()`/`.reduce()` callbacks into named functions
  when they nest chains or build intermediates. Conditional spreads and
  `.filter(Boolean)` are both fine — pick whichever reads clearer; don't
  convert mechanically. Name non-trivial `.filter()` predicates.
- Each try/catch encloses one operation with one failure meaning. Broad
  catch-alls are banned; a bare `try/finally` for resource scoping is fine.
  Use `async/await` over `.catch()` chains. Every catch logs or re-throws.
- Throw on an unreachable null instead of a `?? ""` sentinel.
- At the input boundary an invalid value is rejected and a machine-derived
  value is auto-corrected and reported; a user-authored value is never
  auto-corrected.
- Required inputs are enforced at every entry point — fail fast at
  boot/load. Making an already-expected value mandatory is a bug fix, not a
  breaking change. Breaking means a documented, supported input or output
  stops working; accidental behaviour can change.
- The declared contract and the runtime say the same thing. `action.yml` and
  the README never advertise a default or a rejection that `config.ts`
  doesn't perform. A stricter contract is a runtime change first, then the
  docs.
- A guard that cannot engage fails closed: a conventions or config file
  that is present but unparseable is refused with a logged reason, never
  skipped silently; a missing one takes the defaults. A reader whose failure
  only degrades what is read or how it is formatted, such as the root
  `.gitattributes` reader, falls back with a `warn`.
- A misleading error that invites destructive recovery is a bug — detect the
  real condition and refuse honestly at minimum.
- For an external limit that varies per endpoint (a model's context
  window), parse the real limit from the rejection and retry to fit. A
  documented, uniform limit can be a constant.
- LLM-facing contracts (prompt sections, the finding schema) omit an
  optional field whose absence is unambiguous. Keep the field when `0`/`[]`
  is a legitimate value or it names where an item came from. Each result
  field has one meaning, and data from a second source gets its own field.
- Reach for platform built-ins (`URL.parse`, `node:path`) before
  hand-rolled parsing; with none, exact-value comparison beats string
  surgery. Parse genuinely varying structured strings with a declarative,
  doc-commented regex (named groups), not index arithmetic.
- An internal cap on text (`conventionsCharacterCap`) cuts on whole code
  points, never leaving half a surrogate pair.
- Tests are the outermost layer, so only tests import from a `__tests__/`
  folder. Lint-enforce mechanically checkable conventions. Prefer curated
  exceptions over blanket bans, and never adopt a rule that fights an
  established idiom.
- Vet a new dependency's maintainers, release history and downloads before
  adopting it; at negligible adoption with a small core, prefer a local
  implementation. Pin dependency overrides to exact versions, and pin a dev
  tool used locally and in CI to one version — never a package manager's
  current version or an npm wrapper fetching an unverified binary.
- Prefer simple over clever, and before settling, ask whether fewer moving
  parts do the job. A dead-code claim is proven by enumerating every
  trigger, not by log silence.

## Test conventions

- Tests read as a behavioral spec: one focused `it()` per behavior, named so
  a failure identifies the regression without reading the body, and the name
  matches what is actually asserted.
- Create one `const` per test via factory helpers; use `beforeEach` only
  when per-test creation is genuinely impractical.
- Prefer exact assertions over loose matchers. When fixtures and stubs
  produce deterministic results, assert the entire return value or call
  params, not individual fields. For a large deterministic string (a prompt,
  rendered output), assert the full section or constant in one `toContain`,
  never several phrase fragments. The per-rule drift guards in
  `phases.test.ts` are an exception.
- Under the two-bar rule, a test must (1) fail when the behavior breaks and
  (2) pass only because the intended behavior occurred. Five traps break
  bar 2: **silent no-op** (assert the trigger happened, not just that state
  was retained), **wrong-error** (`rejects.toThrow()` with no argument
  matches ANY error — assert the specific message), **early-return** (assert
  a side effect only the intended path produces), **wrong-item** (assert the
  specific expected item, not just "something came back"), **coincidental
  equality** (when production and test read the same source, both being
  `undefined` passes — set a predictable value and assert it exactly;
  `expect.any(String)` still matches `""`).
- Deterministic error messages get exact assertions, ordered results get a
  positional `toEqual`, and objects are matched whole, not with
  `objectContaining`. A string passed to `toThrow` matches any message that
  contains it; pass `new Error(message)`, which Vitest compares whole. A
  looser neighboring test is never the standard: write the new test to this
  bar, fix loose siblings in a test file the PR already edits as a separate
  test-only commit, and note loose tests in files the PR does not touch as
  follow-up work.
- A drift-catching test owns its expected value. Define the expected prompt
  text or default in the test file and never import the production
  constant. Extract a shared test-file constant only when several tests need
  the same expected value.
- Assert stub interactions with `toHaveBeenCalledTimes(1)` +
  `toHaveBeenCalledWith(exactArgs)`, not `mock.calls[i][j]` readback. Derive
  an expected value (a resolved path, a URL) in the test with the same
  platform call production makes, never by reading it back out of the call
  log.
- Register cleanup at creation (`onTestFinished`, `afterEach`), because
  cleanup at the end of a test body is skipped when an assertion throws. Use
  Vitest helpers (`vi.mocked`, `vi.restoreAllMocks`) over module-level `let`
  plumbing.
- `it.each` is only for identical assertion shapes, with labeled case
  objects and `$label` in the title (a bare `%i` placeholder is fine when the
  primitive itself names the case). Structurally different checks get
  separate `it()` blocks.
- Cover error paths and boundaries (zero, one, empty), not just the happy
  path. For every guard, ask what unrelated change could silently undo it,
  and write the test that catches that erosion. Coverage percentage is not a
  goal; a behavior without a failing-test story is the gap that matters.
- Test helpers and stubs earn their place by removing real duplication, not
  anticipated reuse. A stub must not allow a condition production can't
  produce, and must keep the dimension under test (order, timing, size)
  varied, with decoys where ranking or selection is the behavior.
- For retry and deadline logic, prefer a controllable seam (an injected
  timeout, stubbed client outcomes such as fail-once-then-succeed) over fake
  timers; the policy itself (attempt count, backoff) is usually testable
  pure. When timing is the contract, assert outcomes after advancing the
  clock, never the tick-by-tick schedule.
- Production code never carries test-serving structure (extra branches or
  cache keys that exist only to isolate tests); tests own isolation through
  factories and `vi.resetModules`. One module-scope `env-var` read with a
  default (an endpoint URL that a live test overrides) is allowed outside
  `main.ts` when no other seam makes that test possible; anything more is
  test-serving structure. Production type rules apply in tests: no `!`
  (guard or restructure instead), while `?.` array access and
  `?? fallback` are legitimate narrowing, and callback params are spelled
  out (`entry`, not `e`).
- When the risky path touches an external system, a real integration with
  blast-radius controls (a write path disabled, throwaway identifiers) beats
  a structural check against a stand-in.
- Test a workflow shell snippet under `bash -e` before committing — Actions
  runs `run:` steps with errexit, so use `if/then/fi` over `[ test ] && cmd`.
- When unsure a test can fail for the right reason, mutate the production
  code and watch it fail — for that specific reason.
- Never decompose a result into `toHaveLength(1)` plus index-based checks;
  assert one `toEqual` on the mapped result.
- Filter tests seed data both inside AND outside the filter — exclusion
  is half the behavior.
- Stub SDK clients are plain objects injected through factories — no HTTP
  mocking libraries.
- Every test file maps to a real source module. Never create a second test
  file for one module only to mock it differently;
  `vi.mock(path, { spy: true })` keeps the real implementation while one
  test overrides an export and restores it.
- Fixtures live in `fixtures/` and are shared across test files.

## Logging & observability

- Use `logger.ts`, never `console.log`; logger params are required. The
  logger stamps info, warn and error entries with the caller's file and line
  (`source`), so never add a hand-maintained module tag.
- Thread the caller's logger into domain functions so deep events inherit
  request context.
- Levels are **error** (failed, needs attention), **warn** (degraded but
  handled — state the fallback taken), **info** (state changes an operator
  cares about), and **debug** (diagnostic detail, off by default). Per-item
  loops log debug; their summary logs info.
- Never log PII, credentials, tokens, or secrets — log identifiers, not
  identity payloads. Redact via destructuring, not `delete` on copies.
- Every catch logs the error AND enough context (path, operation) to
  diagnose from the log alone. Errors log as one self-contained
  `[ErrorName]: message` string; property names are spelled out (`message`,
  not `msg`). The catch does the logging; a helper that builds text for the
  PR or the job summary only returns that text and takes no logger.
- Code that posts to GitHub logs its decision trail: the inputs it
  considered, what it posted (findings, anchors), and a stated reason
  whenever it skips.
- Internal functions describe what went wrong in their own domain, using the
  module's own names — never name API surfaces or prescribe caller-level
  remediation. Input names (`max_related_files`) belong at the config
  boundary. Self-correction data (the list of valid values) is welcome in a
  message.
- Prevent a failure rather than document its remedy: make an input
  impossible to get wrong, or accept it, so no README troubleshooting entry
  is needed. Code whose only effect is a clearer message for a rare,
  non-default misconfiguration earns no place when it prevents no failure.
- Full detail stays in the run log; text posted to the PR never carries
  internal paths, stack traces or implementation state.
- Reject explicitly instead of normalizing silently when the normalized
  value would post or write the wrong thing. User-supplied identifiers that
  arrive in mixed case (URLs, extensions, headers) are compared
  case-insensitively, normalized once at the boundary. That case-folding is
  not auto-correction.

## Docs

- Docs update in the same PR that alters behavior, including the README, the
  `action.yml` inputs and the AGENTS.md structure tree.
- Adding a concept (env var, input, file, feature) means sweeping every
  doc that lists its peers, and verifying each candidate before deciding it
  needs the change.
- Decide the format at write time. Information gets structured format
  (table for lookups, bullets for parallel items, numbered steps for
  sequences); narrative goes in the PR description, not committed files. A
  prose paragraph over three sentences usually needs one of those formats.
  Match sibling sections in length. Write one idea per sentence and one
  action per step; a new requirement bolted onto an existing step becomes
  its own step.
- Setting references (the README input table, `action.yml` descriptions,
  workflow comments) state the knob, its effect, and its limits. Put the
  valid values and the default on their own labelled lines (`Valid values:`
  / `Default:`), never mid-sentence. Give the literal value that replaces a
  default list (`none, evals/**`). Never describe a setting by the order of
  steps the code runs. Cut a sentence a neighboring row already carries.
- Factual claims match the implementation. Mechanism words ("retries",
  "caches", "falls back") appear only when the code implements that
  mechanism, and conditional capabilities are stated conditionally.
  Credential copy states the positive inventory — what the action reads and
  what it keeps, anchored to the service that issued each credential
  (GitHub, OpenRouter) — never bare negatives.
- Describe what a feature does, not why someone would use it. Use plain
  words, gloss a jargon term once, and name the concrete referent where the
  reader is (the input's name, not "the setting above"). A procedure opens
  with the reader's motive ("To review only changed files, set…"), while a
  feature description still states the mechanism.
- State a capability affirmatively, with no implicit contrasts or empty
  intensifiers; when a contrast informs, use the additive form ("traces
  callers as well as the diff"). Policing language ("use at your own risk")
  enters a public doc only after the problem it guards against has occurred.
- A correction states the current design directly, with no parenthetical
  about what the old text got wrong. Before cutting "redundant" reviewed
  copy, check why it exists; a behavior change replaces only the clause it
  made stale.
- After editing a section, re-read the whole document, not just the diff,
  and walk it once as each reader the doc serves: a first-time installer, a
  maintainer tuning inputs. Structural self-references ("shown below", "the
  table above") must resolve against the current document. A clarity pass
  keeps vivid, literally true lines in the README's value-proposition copy.
- A feature section that describes intrusive default-on behavior, such as
  the `cost_summary` report, states its opt-out inline, not only in the
  inputs table.
- Marketplace and listing copy reuses the README's claims.
- No internal references in any public artifact — issue/PR numbers,
  task-board IDs, incident dates, deployment names, and investigation
  chronology never enter committed files, PR descriptions, or comments. The
  sync stamp at the top of this file is exempt.

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
