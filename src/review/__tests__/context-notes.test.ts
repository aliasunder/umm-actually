import { describe, expect, it } from "vitest"
import {
  buildContextNotes,
  buildConventionsNote,
  classifyConventionsCoverage,
  type ContextNotesInput,
  type ConventionsCoverage,
} from "../context-notes.js"
import type { PromptFile } from "../prompt.js"

const makeInput = (overrides: Partial<ContextNotesInput> = {}): ContextNotesInput => ({
  priorityDocs: [],
  priorityDocsInContext: [],
  priorityDocsRead: [],
  relatedFilesExcludedPaths: [],
  docsExcludedPaths: [],
  diffExcludedFiles: [],
  ...overrides,
})

const makePriorityDoc = (path: string): PromptFile => ({
  path,
  content: "# Doc",
  includedAs: "full",
  reason: "priority documentation",
})

// Test-owned expected strings: importing the production templates would let
// both sides drift together and pass trivially on any wording change.
const inContextNote = (paths: string): string => `Priority docs already in context: ${paths}`

const notIncludedNote = (paths: string): string =>
  `Priority docs not included: ${paths} (missing, unreadable, or over budget)`

describe("buildContextNotes", () => {
  it("returns no notes when nothing was skipped or capped and no docs are in context", () => {
    const notes = buildContextNotes(
      makeInput({
        priorityDocs: ["README.md"],
        priorityDocsRead: [makePriorityDoc("README.md")],
      }),
    )

    expect(notes).toEqual([])
  })

  it("reports priority docs already in context from another channel", () => {
    const notes = buildContextNotes(
      makeInput({
        priorityDocs: ["README.md", "ARCHITECTURE.md"],
        priorityDocsInContext: ["README.md", "ARCHITECTURE.md"],
      }),
    )

    expect(notes).toEqual([inContextNote("`README.md`, `ARCHITECTURE.md`")])
  })

  it("reports a priority doc that is neither in context nor read", () => {
    const notes = buildContextNotes(
      makeInput({
        priorityDocs: ["README.md", "MISSING.md"],
        priorityDocsRead: [makePriorityDoc("README.md")],
      }),
    )

    expect(notes).toEqual([notIncludedNote("`MISSING.md`")])
  })

  it("reports both in-context and absent priority docs together", () => {
    const notes = buildContextNotes(
      makeInput({
        priorityDocs: ["README.md", "MISSING.md"],
        priorityDocsInContext: ["README.md"],
      }),
    )

    expect(notes).toEqual([inContextNote("`README.md`"), notIncludedNote("`MISSING.md`")])
  })

  it("omits a priority doc that readPriorityDocs returned from both notes", () => {
    const notes = buildContextNotes(
      makeInput({
        priorityDocs: ["ARCHITECTURE.md", "MISSING.md"],
        priorityDocsRead: [makePriorityDoc("ARCHITECTURE.md")],
      }),
    )

    expect(notes).toEqual([notIncludedNote("`MISSING.md`")])
  })

  it("normalizes a dot-prefixed configured path before comparing", () => {
    const notes = buildContextNotes(
      makeInput({
        priorityDocs: ["./README.md", "MISSING.md"],
        priorityDocsInContext: ["README.md"],
      }),
    )

    expect(notes).toEqual([inContextNote("`./README.md`"), notIncludedNote("`MISSING.md`")])
  })

  it("normalizes a dot-prefixed in-context path before comparing", () => {
    const notes = buildContextNotes(
      makeInput({
        priorityDocs: ["docs/api.md", "MISSING.md"],
        priorityDocsInContext: ["./docs/api.md"],
      }),
    )

    expect(notes).toEqual([inContextNote("`docs/api.md`"), notIncludedNote("`MISSING.md`")])
  })

  it("renders the configured spelling rather than the normalized path", () => {
    const notes = buildContextNotes(makeInput({ priorityDocs: ["./docs/../MISSING.md"] }))

    expect(notes).toEqual([notIncludedNote("`./docs/../MISSING.md`")])
  })

  it("lists a doc once when priority_docs names it under two spellings", () => {
    const notes = buildContextNotes(makeInput({ priorityDocs: ["./MISSING.md", "MISSING.md"] }))

    expect(notes).toEqual([notIncludedNote("`./MISSING.md`")])
  })

  it("dedupes in-context docs by normalized path", () => {
    const notes = buildContextNotes(
      makeInput({
        priorityDocs: ["./README.md", "README.md"],
        priorityDocsInContext: ["README.md"],
      }),
    )

    expect(notes).toEqual([inContextNote("`./README.md`")])
  })

  it("reports related files excluded by the cap", () => {
    const notes = buildContextNotes(
      makeInput({
        relatedFilesExcludedPaths: ["src/extra-a.ts", "src/extra-b.ts"],
      }),
    )

    expect(notes).toEqual([
      "2 related file(s) excluded by `max_related_files` cap: `src/extra-a.ts`, `src/extra-b.ts`",
    ])
  })

  it("reports related docs excluded by the cap", () => {
    const notes = buildContextNotes(makeInput({ docsExcludedPaths: ["docs/overflow.md"] }))

    expect(notes).toEqual([
      "1 related doc(s) excluded by `max_related_docs` cap: `docs/overflow.md`",
    ])
  })

  it("reports diff-excluded files with each file's exclusion source", () => {
    const notes = buildContextNotes(
      makeInput({
        diffExcludedFiles: [
          {
            path: "package-lock.json",
            additions: 1200,
            deletions: 800,
            source: "default_list",
          },
          {
            path: "evals/run.json",
            additions: 10,
            deletions: 0,
            source: "diff_exclude_paths",
          },
          {
            path: "gen/x.json",
            additions: 5,
            deletions: 5,
            source: "linguist_generated",
          },
        ],
      }),
    )

    expect(notes).toEqual([
      "3 changed file(s) excluded from review: `package-lock.json` (built-in default list), `evals/run.json` (diff_exclude_paths input), `gen/x.json` (linguist-generated attribute)",
    ])
  })

  it("orders in-context before not-included before related files before related docs before diff exclusions", () => {
    const notes = buildContextNotes(
      makeInput({
        priorityDocs: ["README.md", "MISSING.md"],
        priorityDocsInContext: ["README.md"],
        relatedFilesExcludedPaths: ["src/extra-a.ts"],
        docsExcludedPaths: ["docs/overflow.md"],
        diffExcludedFiles: [
          {
            path: "package-lock.json",
            additions: 1,
            deletions: 1,
            source: "default_list",
          },
        ],
      }),
    )

    expect(notes).toEqual([
      inContextNote("`README.md`"),
      notIncludedNote("`MISSING.md`"),
      "1 related file(s) excluded by `max_related_files` cap: `src/extra-a.ts`",
      "1 related doc(s) excluded by `max_related_docs` cap: `docs/overflow.md`",
      "1 changed file(s) excluded from review: `package-lock.json` (built-in default list)",
    ])
  })
})

// A 10-token budget caps the conventions section at 40 characters
const CONVENTIONS_BUDGET_TOKENS = 10
const conventionsAtCap = "c".repeat(40)
const conventionsOverCap = "c".repeat(41)

const makeFullFile = (path: string): PromptFile => ({ path, content: "body", includedAs: "full" })

const makeCoverageInput = (
  overrides: Partial<Parameters<typeof classifyConventionsCoverage>[0]> = {},
): Parameters<typeof classifyConventionsCoverage>[0] => ({
  conventions: conventionsOverCap,
  conventionsFile: "AGENTS.md",
  conventionsBudgetTokens: CONVENTIONS_BUDGET_TOKENS,
  priorityDocFiles: [],
  changedFiles: [],
  relatedFiles: [],
  conventionsAddedInDiff: false,
  ...overrides,
})

const truncatedCoverage = (
  fullCopyChannel: Extract<ConventionsCoverage, { status: "truncated" }>["fullCopyChannel"],
): ConventionsCoverage => ({
  status: "truncated",
  fullCopyChannel,
  characterCap: 40,
  totalCharacters: 41,
})

describe("classifyConventionsCoverage", () => {
  it("reports a missing conventions file as not found", () => {
    expect(classifyConventionsCoverage(makeCoverageInput({ conventions: null }))).toEqual({
      status: "not-found",
    })
  })

  it("reports a file exactly at the cap as full", () => {
    expect(
      classifyConventionsCoverage(makeCoverageInput({ conventions: conventionsAtCap })),
    ).toEqual({ status: "full", characterCap: 40, totalCharacters: 40 })
  })

  it("reports a file one character over the cap with no other copy as truncated with no channel", () => {
    expect(classifyConventionsCoverage(makeCoverageInput())).toEqual(truncatedCoverage(null))
  })

  it("names priority docs when they carried the full file", () => {
    const coverage = classifyConventionsCoverage(
      makeCoverageInput({
        priorityDocFiles: [makeFullFile("README.md"), makeFullFile("AGENTS.md")],
      }),
    )

    expect(coverage).toEqual(truncatedCoverage("priority-docs"))
  })

  it("names changed files when the changed-file copy is full", () => {
    const coverage = classifyConventionsCoverage(
      makeCoverageInput({ changedFiles: [makeFullFile("src/a.ts"), makeFullFile("AGENTS.md")] }),
    )

    expect(coverage).toEqual(truncatedCoverage("changed-files"))
  })

  it("does not count a changed-file copy that was included diff-only", () => {
    const coverage = classifyConventionsCoverage(
      makeCoverageInput({
        changedFiles: [{ path: "AGENTS.md", content: "", includedAs: "diff-only" }],
      }),
    )

    expect(coverage).toEqual(truncatedCoverage(null))
  })

  it("names related files when a related-file copy is full", () => {
    const coverage = classifyConventionsCoverage(
      makeCoverageInput({
        conventionsFile: "conventions.ts",
        relatedFiles: [makeFullFile("src/b.ts"), makeFullFile("conventions.ts")],
      }),
    )

    expect(coverage).toEqual(truncatedCoverage("related-files"))
  })

  it("names the added-file diff when the PR adds the conventions file", () => {
    const coverage = classifyConventionsCoverage(
      makeCoverageInput({ conventionsAddedInDiff: true }),
    )

    expect(coverage).toEqual(truncatedCoverage("added-in-diff"))
  })

  it("matches a dot-prefixed priority-doc path against the configured path", () => {
    const coverage = classifyConventionsCoverage(
      makeCoverageInput({ priorityDocFiles: [makeFullFile("./AGENTS.md")] }),
    )

    expect(coverage).toEqual(truncatedCoverage("priority-docs"))
  })

  it("prefers priority docs when changed files also carried the full file", () => {
    const coverage = classifyConventionsCoverage(
      makeCoverageInput({
        changedFiles: [makeFullFile("AGENTS.md")],
        priorityDocFiles: [makeFullFile("AGENTS.md")],
      }),
    )

    expect(coverage).toEqual(truncatedCoverage("priority-docs"))
  })

  it("ignores full copies of other files", () => {
    const coverage = classifyConventionsCoverage(
      makeCoverageInput({
        priorityDocFiles: [makeFullFile("README.md")],
        changedFiles: [makeFullFile("docs/AGENTS.md")],
        relatedFiles: [makeFullFile("src/b.ts")],
      }),
    )

    expect(coverage).toEqual(truncatedCoverage(null))
  })
})

describe("buildConventionsNote", () => {
  const buildNote = (
    coverage: ConventionsCoverage,
    listedInPriorityDocs = false,
  ): string | null => {
    return buildConventionsNote({
      conventionsCoverage: coverage,
      conventionsFile: "AGENTS.md",
      listedInPriorityDocs,
    })
  }

  it("suggests both remedies when no full copy reached the model", () => {
    expect(buildNote(truncatedCoverage(null))).toBe(
      "Conventions file `AGENTS.md` was truncated to its first 40 of 41 characters, and no full copy reached the model — raise `conventions_budget_tokens` or list the file in `priority_docs`.",
    )
  })

  it("drops the priority_docs remedy when the file is already listed there", () => {
    expect(buildNote(truncatedCoverage(null), true)).toBe(
      "Conventions file `AGENTS.md` was truncated to its first 40 of 41 characters, and no full copy reached the model — raise `conventions_budget_tokens`; the file is listed in `priority_docs` but did not fit or was excluded.",
    )
  })

  it.each([
    { label: "changed files", fullCopyChannel: "changed-files" },
    { label: "the added-file diff", fullCopyChannel: "added-in-diff" },
    { label: "related files", fullCopyChannel: "related-files" },
  ] as const)("warns ahead when only $label carried the full text", ({ fullCopyChannel }) => {
    expect(buildNote(truncatedCoverage(fullCopyChannel))).toBe(
      "Conventions file `AGENTS.md` exceeds `conventions_budget_tokens` (41 characters against a 40-character cap) — this PR carried the full text, but later PRs that change neither it nor a file it imports will see only the first 40 characters.",
    )
  })

  it.each([
    { fullCopyChannel: "changed-files" },
    { fullCopyChannel: "added-in-diff" },
    { fullCopyChannel: "related-files" },
  ] as const)(
    "returns no note when $fullCopyChannel carried the full text and priority_docs lists the file",
    ({ fullCopyChannel }) => {
      expect(buildNote(truncatedCoverage(fullCopyChannel), true)).toBeNull()
    },
  )

  it.each([
    { label: "a full file", coverage: { status: "full", characterCap: 40, totalCharacters: 40 } },
    { label: "a missing file", coverage: { status: "not-found" } },
    { label: "a priority-doc copy", coverage: truncatedCoverage("priority-docs") },
  ] as const)("returns no note for $label", ({ coverage }) => {
    expect(buildNote(coverage)).toBeNull()
  })
})
