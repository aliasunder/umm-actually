/**
 * Review phase definitions. V1 runs a single "combined" phase carrying all
 * four dimensions; V2 splits them into sequential phases that receive prior
 * findings. Each dimension is its own constant so V2 reuses the blocks
 * unchanged.
 *
 * Dimension content is written for a single-call reviewer: every check must
 * be resolvable by reasoning over the provided files — no assumption of
 * tools, test runs, or repository access beyond the prompt context.
 */
export type ReviewPhase = {
  id: string
  instructionSections: string[]
}

export const DIMENSION_CORRECTNESS_SECURITY = `DIMENSION 1 — CORRECTNESS & SECURITY.
Logic errors, incorrect conditions, off-by-one errors, null/undefined access,
race conditions, unhandled error paths, missing edge cases. Error paths get
the same scrutiny as the happy path.

Security: injection, path traversal, auth bypass, secrets committed anywhere
(including test fixtures). Performance: unbounded queries, N+1 patterns,
O(n^2) in hot paths, unnecessary allocations in loops.

Filesystem safety: paths from user or external input need realpath-style
containment — a lexical prefix check passes "../" sequences and symlinks that
escape the root. Code accepting symlinks must verify the resolved target is
within bounds, is the expected type (file vs directory), and exists. Checks
must hold at every entry point — a symlinked search root bypasses per-entry
validation. When a filter or eligibility check is broadened (isFile() →
isFile() || isSymbolicLink(), a new accepted content type, a widened query
scope), the new branch must preserve the guarantees the old filter implicitly
provided — or add explicit validation for the ones it loses.

Silent catches: .catch(() => {}) and catch (e) {} swallow errors — every
catch must log or re-throw, with enough context to diagnose from the log
alone.

Documentation accuracy: if the PR modifies user-facing docs, verify factual
claims (capabilities, architecture, data flow) match the actual
implementation — a doc claiming "no external communication" when the system
has outbound sync is a correctness bug. When unchanged documentation files
are provided as context (whether because they reference changed code or
because they are priority documentation), check every factual claim in those
docs against the current implementation — flag
stale descriptions, outdated architecture references, incorrect parameter
names, and capability claims that no longer hold.

Documentation coherence — check by simulating a reader, not by scanning
sentences; every sentence can be individually true while the document
contradicts itself:
- Multi-path: when a doc offers more than one way to reach the same goal
  (install methods, setup tools, runtimes, OS variants), walk EACH path
  through the whole document. Every operational section (update, restart,
  verify, troubleshoot) must serve every offered path or explicitly scope
  itself; a section must not reference a path the document never offers; and
  resource identifiers (volume/data names, service names, ports, generated
  paths) must be compatible across methods or the doc must state the methods
  are not interchangeable. Skip this walkthrough for single-path docs.
- Default shift: when the recommended method or default changes, framing goes
  stale silently even though individual commands survive — check intro prose,
  section ordering, and which method is the main body vs a collapsible aside.
- Moved files: when the PR moves or renames files, docs that reference the
  old paths (structure trees, module prose) now contradict the codebase.`

export const DIMENSION_CODE_QUALITY = `DIMENSION 2 — CODE QUALITY & CONVENTIONS.
Ground repo-specific convention findings in the conventions file — it wins on
conflict, and do not invent project conventions it doesn't state. The general
triggers below apply even where the conventions file is silent. Each trigger
has a boundary; the boundary is what separates a finding from noise.

Naming: values named for what they ARE (searchText, not needle); functions
named for what they DO, specifically; callback params explicit (entry, not
e); booleans named for the affirmative state. Side-effect prefixes (ensure*, check*, init*, setup*) on functions whose
return value callers consume misstates the point — name for the return
(getPdfEngine, resolveConfig). Boundary: keep the prefix when every call
site in the provided files ignores the return (a true ensure-invariant).

Structure triggers:
- Nested if/else where one branch is simpler → early return from the simpler
  branch so the main path reads linearly.
- A "let" never reassigned, or a reduce that mutates its accumulator →
  immutable form. Boundary: a const-declared Set/array mutated via
  .add()/.push() in an honest loop is fine; never demand a rewrite of
  working, readable code into a more "functional" shape for its own sake —
  readability is the deciding gate.
- A .map()/.reduce() callback that builds multiple intermediates, nests
  chains, or holds ternaries inside \${} interpolation → extract a named
  function; the parent reads as items.map(formatItem).join("\\n").
- More than two positional args, or adjacent same-typed args that could
  transpose silently → named-params object.
- !== undefined / !== null guards where 0, "", and false are not legitimate
  values for the type → truthy/falsy check. Boundary: keep the explicit
  comparison when falsy values are meaningful for correctness.
- A guard immediately followed by property access on the guarded value →
  optional chaining (value?.prop ?? fallback).
- A callback param () => T where every call site would pass an
  already-computed, side-effect-free value → accept T directly.
- A for-loop whose body only pushes a straight transform into a collection
  declared just above → .map() / .filter().map(). Boundary: keep the loop
  when it has early exits, accumulation beyond append (dedup-by-key), or
  side effects beyond the collection being built.
- for (let i = ...) where i only serves arr[i] access → for...of. Boundary:
  keep the index when it appears in the output, the loop skips indices, or
  three or more adjacent elements are compared.
- A boolean mode parameter → the function does two things; split it and let
  the caller own the gating.

Error messages: internal and data-layer functions describe failures in their
own domain — never naming API surfaces (tool names, routes, CLI flags) or
prescribing caller-level remediation; remediation guidance lives at the API
boundary, and messages use the module's own naming convention, not the wire
format's.

Comments earn their place with non-obvious domain context; never restate a
self-documenting name; a long explanatory comment is a signal to simplify
the code instead. Regex constants get doc comments saying what they match.

Simplicity: simple over clever; working is the floor, not the bar. Each line
should read on its own without the reader simulating the code. Built-ins
over manual string surgery: split/slice/index arithmetic on URLs, paths,
query strings, headers, or dates — check for a stdlib parser (URL.parse,
URLSearchParams, path.*) and flag the manual version.
  Wrong: req.originalUrl.split("?")[0] ?? req.originalUrl
  Right: URL.parse(req.originalUrl, "http://localhost")?.pathname ?? req.originalUrl
Boundary: don't flag genuinely lexical operations or formats with no
stdlib parser.

Docs and comment concision — name the unnecessary content and the drift:
- Doc-comment padding restates the signature — drifts when it changes.
- Rationale duplication: narrative already in PR description, commit
  message, or another doc — copies drift independently.
- Repeated chain or caveat at every mention — N copies drift.
- Wrong-level rationale: incidental mechanics instead of the conceptual
  reason — future editor preserves the wrong constraint.
- Config-template narration instead of behavior and value shape.
- Filler lead-ins ("What this looks like in practice:") — delete.
Boundary: never merge two distinct claims into one; when unsure whether
a clause is load-bearing, keep it and flag uncertainty.`

export const DIMENSION_TEST_QUALITY = `DIMENSION 3 — TEST QUALITY & COVERAGE.
For test files, audit each it() individually:
- Behavioral spec: one focused behavior per it(); a failing name identifies
  what regressed without reading the body and matches what is actually
  asserted (a test asserting one result is not named "returns multiple").
- Two-bar rule: a test must (1) fail when the behavior breaks and (2) pass
  only because the intended behavior occurred. Four traps against bar 2:
  silent no-op (asserting "state preserved" passes even when the operation
  never ran — demand an assertion that the trigger happened), wrong-error
  (rejects.toThrow() with no argument matches ANY error — demand the
  specific message), early-return (a returned 0/empty/false can come from
  the guard under test OR from bailing out earlier — demand a side effect
  unique to the intended path), wrong-item (seeding several items then
  asserting only that "something came back" — demand the specific expected
  item by path, id, or content).
- Loose-matcher trigger: when a new or changed test uses toBeTruthy,
  toBeDefined, toBeNull, toBeGreaterThanOrEqual(0), toBeGreaterThan(0),
  expect.anything(), expect.stringMatching, expect.any(,
  expect.objectContaining, or toHaveLength plus index-picked property
  checks, derive what the exact expected value would be from the code under
  test — if it is derivable, flag it: the test must assert the exact value.
  objectContaining boundary: keep when omitted fields are nondeterministic
  (timestamps, IDs), not test-owned (third-party params), or asserted
  separately.
  Wrong (passes even when the resolved value is not the intended one):
    expect(phases).toHaveLength(1)
    expect(phases[0]?.id).toBeTruthy()
  Right (locks the value — any drift fails):
    expect(phases).toEqual([expectedCombinedPhase])
- Assert the whole value: multiple expect() calls picking properties off the
  same result are weaker than one toEqual on the full shape — decomposition
  misses extra items, ordering, and structural drift. Boundary:
  decomposition is fine when properties differ in determinism or need
  different matchers; even then prefer toMatchObject over property picks.
- No substring matching on deterministic output: when every input to a
  string is test-controlled (fixture data, mock return, hardcoded literal),
  assert the exact value — toContain/toMatch silently tolerate drift.
  Boundary: fragments are fine over genuinely non-deterministic segments
  (timestamps, IDs, system paths) or when the rest is covered elsewhere.
- Ordered collections get positional assertions: Promise.allSettled,
  Array.map, and Object.entries preserve order — arrayContaining proves
  "some element matched", not "the right one did".
- Hygiene: const per test via factory helpers over let + beforeEach; no "!"
  non-null assertions (guard or restructure instead); cleanup registered at
  resource creation (afterEach/onTestFinished), never trailing after
  assertions where a failure skips it.
- Do NOT flag these as violations: "?." array access and "?? fallback" are
  legitimate narrowing, not loose matching; a "continue" guarding loop index
  bounds is type narrowing, not a silent no-op.

For production files, find coverage gaps — classify each change:
- new exported function → needs tests unless it is a trivial delegation
- new branch, early return, or error path → needs a test exercising it
- changed behavior → existing tests must reflect the new contract
- bug fix → needs a regression test that fails if the fix is reverted
- refactor-only → no new tests IF existing tests still cover the behavior
Report each gap with the specific untested scenario. In changed test files,
flag coverage regressions: removed it() blocks, weakened assertions (toBe →
toBeDefined, exact match → toContain), and skipped or commented-out tests.
Filter and exclusion tests must seed data both inside AND outside the filter
— exclusion is half the behavior.`

export const DIMENSION_SUBTLE_BUGS = `DIMENSION 4 — SUBTLE BUG PATTERNS.
Apply these checks systematically to every changed file:
(a) Description-vs-implementation — the highest-yield check. Quote each
sentence of every description, doc comment, and step or job name in changed
files, extract its factual claims ("sorted by X", "creates X if missing",
"requires Z", "returns empty array, not an error"), and trace each claim to
the code path. Flag claims not implemented, implemented differently, or
truncated/garbled text. When a description names another function or tool,
verify the reference: the named sibling must actually do what the reference
claims, in the claimed direction (naming the wrong sibling is the most
common miss), and a prescribed multi-step workflow must chain end-to-end —
each step producing what the next expects. A capability gated behind a flag,
env var, or optional dependency must be stated conditionally or describe the
degraded mode. Mechanism language must be earned: "caches", "batches",
"switches automatically", "queues" only when the code implements that
mechanism, not merely the outcome — a per-call fallback is not a state
transition. Structural self-references in docs ("shown below", "the section
above") must resolve against the current document after restructuring.
(b) SQL correctness — description-query alignment ("sorted by modification
date" needs ORDER BY mtime), COUNT(*) vs COUNT(DISTINCT) where JOINs
multiply rows, LIMIT without ORDER BY when the contract implies stable
order, WHERE completeness against every documented filter, injection via
string interpolation.
(c) Type safety and coercion — !x where 0, "", or false are legitimate
values; loose == comparisons; as/! assertions that bypass the compiler;
using a union outside its narrowed block; TypedArray.buffer passed to
Buffer.from() or DataView without byteOffset/byteLength (the one-arg form
silently reads the whole backing buffer when the array is a subarray view).
(d) Boundary and off-by-one — empty inputs; zero and one; inclusive vs
exclusive ranges in slice, substring, and LIMIT/OFFSET; a truncation
indicator ("N+") must fetch limit + 1 to detect overflow.
(e) Behavioral asymmetry — sibling code paths handling the same input
variant differently; merge points combining parallel sources (cache + DB,
two search modes) must apply filters and limits equivalently to each source
BEFORE merging; overly broad transforms (trim() where leading whitespace
encodes structure and trimEnd() was meant); the same parameter defaulting
differently across functions with no documented reason; config defaults
diverging across layers (compose files, .env examples, generated templates,
the config parser) — note "\${VAR:-}" yields an empty string, which bypasses
code-level defaults that only apply when the var is absent.
(f) Input validation and error paths — unexpected parameter combinations
that silently fall through where an error or early return is needed;
case-sensitive comparisons on identifiers that arrive in mixed case (URLs,
extensions, headers); error messages leaking internal paths or
implementation state to clients.
(g) Platform, encoding, and time — line handling that assumes \\n on
possibly-CRLF content; timezone-naive or mixed UTC/local date logic;
length/slice on multi-byte characters; TOCTOU gaps between stat/readdir and
acting on the file; background work consuming a startup snapshot while the
live path can mutate or delete the entries it will process.
(h) Shared helpers not used — when new code reaches for a bare primitive
(Promise.all fan-out, hand-rolled string or error formatting) and a provided
related file already exports a bounded or shared helper for the same job,
flag the miss.`

export const CI_WORKFLOW_CHECKS = `For CI/workflow files (.yml), also check:
- Action pinning: every uses: line carries a full commit SHA with a version
  comment, not a mutable tag — and flag inconsistency when some lines are
  pinned while siblings float.
- Permissions least privilege measured against what the steps actually use:
  when every step authenticates via an App token, the default GITHUB_TOKEN
  needs at most read.
- Multi-trigger event guards: with more than one event in on:, each job or
  step that only makes sense for one trigger needs an if: on
  github.event_name.
- Secrets scoped to step-level env, never job-level.
- persist-credentials: false on checkout unless the job pushes.
- Untrusted input (PR titles/bodies, comments, branch names) passed via
  quoted env vars, never interpolated into run: commands.
- concurrency blocks on deploy workflows.
- if: conditions reference only context visible at evaluation time —
  step-level env is not; GitHub evaluates if: before the step runs.
- Step and job names match what the step actually does — an always-skipped
  "Configure X" step is a description-vs-implementation bug.
- run: shell logic survives bash -e — a failing "[ test ] && cmd"
  short-circuit aborts the job; use if/then/fi.`

export const REPORTING_RULES = `REPORTING RULES — these override intuition:
- No silent skipping: every issue found during analysis is reported,
  including pre-existing ones (prefix the description "Pre-existing:") —
  "not introduced by this PR" is categorization, not a reason to omit. A bug
  found and silently dismissed is worse than one missed.
- Pre-existing analog gaps are findings: when the PR correctly implements a
  pattern and an analogous existing feature visibly lacks that same pattern
  in the provided files, report the gap — the PR's own implementation is the
  fix template.
- No environment-specific dismissals: never dismiss a resource, performance,
  or scaling concern by assuming one deployment's specs — judge against the
  worst reasonable use case for the project's audience.
- Same-pattern sweep: when a trigger fires on changed code, scan the rest
  of that file and the provided related files for other instances of the
  same pattern, including pre-existing ones. Boundary: sweep the specific
  pattern that fired, not all dimensions.`

const combinedPhase: ReviewPhase = {
  id: "combined",
  instructionSections: [
    DIMENSION_CORRECTNESS_SECURITY,
    DIMENSION_CODE_QUALITY,
    DIMENSION_TEST_QUALITY,
    DIMENSION_SUBTLE_BUGS,
    CI_WORKFLOW_CHECKS,
    REPORTING_RULES,
  ],
}

export const resolvePhases = (phasesInput: string): ReviewPhase[] => {
  if (phasesInput === "combined") return [combinedPhase]
  throw new Error(
    `unknown phases value "${phasesInput}" — V1 supports only "combined"`,
  )
}
