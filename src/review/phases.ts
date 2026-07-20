/**
 * Review phase definitions. V1 runs a single "combined" phase carrying all
 * four dimensions; V2 splits them into sequential phases that receive prior
 * findings. Each dimension is its own constant so V2 reuses the blocks
 * unchanged.
 */
export type ReviewPhase = {
  id: string
  instructionSections: string[]
}

export const DIMENSION_CORRECTNESS_SECURITY = `DIMENSION 1 — CORRECTNESS & SECURITY.
Look for: logic errors, incorrect conditions, off-by-one errors, null/undefined
access, race conditions, unhandled error paths, missing edge cases, security
vulnerabilities (injection, path traversal, auth bypass), and performance issues
(unbounded queries, missing indices, O(n^2) in hot paths). Symlink safety: verify
targets are within expected bounds and of expected type. Silent catches: .catch(() =>
{}) and catch (e) {} swallow errors — every catch must log or re-throw. If the PR
modifies user-facing docs, verify factual claims (capabilities, architecture, data
flow) match the actual implementation — a doc claiming "no external communication"
when the system has outbound sync is a correctness bug. When unchanged
documentation files are provided as context (whether because they reference
changed code or because they are priority documentation), check every factual
claim in those docs against the current implementation — flag
stale descriptions, outdated architecture references, incorrect parameter names,
and capability claims that no longer hold.`

export const DIMENSION_CODE_QUALITY = `DIMENSION 2 — CODE QUALITY & CONVENTIONS.
Review against the conventions file: naming conventions (explicit names over
abbreviations, descriptive function names), structure (early returns over nested
if/else, immutable by default, no disguised mutation in reduce), module layering
(dependency direction, export style), comment conventions (comments above complex
logic, regex doc comments), and simplicity (simple code over clever code, no
premature abstractions). Functions with >2 args or adjacent same-typed args (swap
hazard) should use named-params objects. When a .map()/.flatMap() callback spans many
lines or contains nested pipelines, extract to a named function. For convention
issues, ground them in the conventions file's rules rather than inventing conventions
the project doesn't have.`

export const DIMENSION_TEST_QUALITY = `DIMENSION 3 — TEST QUALITY & COVERAGE.
For test files: check that each it() tests what its name claims, assertions are
exact (toHaveLength(2) not toBeGreaterThanOrEqual(1)), tests include both positive
and negative cases, tests would fail if the behavior broke (not pass by coincidence),
and const-per-test is preferred over let+beforeEach. Watch for tests that pass for
the wrong reason: silent no-op (asserts state preserved but never proves operation
ran), wrong-error pass (rejects.toThrow() with no argument matches ANY error),
early-return pass (result could come from a guard instead of the intended path).
Flag coverage regressions: removed it() blocks, weakened assertions (toBe changed
to toBeDefined), or .skip'd tests. For production files: check if new functions,
branches, or error paths have corresponding tests. Flag missing coverage with the
specific untested scenario.`

export const DIMENSION_SUBTLE_BUGS = `DIMENSION 4 — SUBTLE BUG PATTERNS.
Apply these checks systematically:
(a) Description-vs-implementation mismatch — quote each sentence of a description
before checking it against the code. Verify cross-references name the right sibling
and describe what it actually does. If a feature is gated behind a flag or env var,
the description must qualify the claim or describe degraded behavior.
(b) SQL correctness — missing quotes around LIKE patterns, wrong JOIN type, missing
WHERE clauses, injection via string interpolation.
(c) Type safety — JSON.parse without runtime validation, type assertions (as/!)
that bypass the compiler.
(d) Boundary and off-by-one — fencepost errors in slicing, pagination, or loop
bounds; empty-input handling. Truncation indicators: if showing "N+" for overflow,
must fetch limit + 1 to detect truncation.
(e) Behavioral asymmetry — create/update/delete paths that handle the same field
differently.
(f) Input validation gaps — user inputs that reach the data layer unchecked; path
traversal (../) in file paths.
(g) Platform/encoding — path separator assumptions, Unicode normalization,
locale-dependent string operations, timezone-naive date handling.
(h) Config default divergence — defaults must agree across every layer that states
them (compose files, .env examples, templates, config parsers). A value added in one
layer but missing from a sibling means some users never see it.
(i) Shared helpers not used — before accepting a stdlib call, check the project's
utility modules for an existing helper that already encodes the pattern.`

export const CI_WORKFLOW_CHECKS = `For CI/workflow files (.yml), also check: action pinning (full commit SHA, not
mutable tags), permissions least privilege, multi-trigger event guards, secrets
scoped to step-level not job-level env, persist-credentials: false on
actions/checkout, untrusted input (PR titles/bodies, comments, branch names)
interpolated into run: commands instead of passed via quoted env vars, and
concurrency blocks on deploy workflows.`

const combinedPhase: ReviewPhase = {
  id: "combined",
  instructionSections: [
    DIMENSION_CORRECTNESS_SECURITY,
    DIMENSION_CODE_QUALITY,
    DIMENSION_TEST_QUALITY,
    DIMENSION_SUBTLE_BUGS,
    CI_WORKFLOW_CHECKS,
  ],
}

export const resolvePhases = (phasesInput: string): ReviewPhase[] => {
  if (phasesInput === "combined") return [combinedPhase]
  throw new Error(
    `unknown phases value "${phasesInput}" — V1 supports only "combined"`,
  )
}
