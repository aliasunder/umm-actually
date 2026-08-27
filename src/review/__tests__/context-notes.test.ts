import { describe, expect, it } from "vitest"
import { buildContextNotes, type ContextNotesInput } from "../context-notes.js"
import type { PromptFile } from "../prompt.js"

const makeInput = (
  overrides: Partial<ContextNotesInput> = {},
): ContextNotesInput => ({
  priorityDocs: [],
  priorityDocsInContext: [],
  priorityDocsRead: [],
  relatedFilesExcludedPaths: [],
  docsExcludedPaths: [],
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
const inContextNote = (paths: string): string =>
  `Priority docs already in context: ${paths}`

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

    expect(notes).toEqual([
      inContextNote("`README.md`"),
      notIncludedNote("`MISSING.md`"),
    ])
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

    expect(notes).toEqual([
      inContextNote("`./README.md`"),
      notIncludedNote("`MISSING.md`"),
    ])
  })

  it("normalizes a dot-prefixed in-context path before comparing", () => {
    const notes = buildContextNotes(
      makeInput({
        priorityDocs: ["docs/api.md", "MISSING.md"],
        priorityDocsInContext: ["./docs/api.md"],
      }),
    )

    expect(notes).toEqual([
      inContextNote("`docs/api.md`"),
      notIncludedNote("`MISSING.md`"),
    ])
  })

  it("renders the configured spelling rather than the normalized path", () => {
    const notes = buildContextNotes(
      makeInput({ priorityDocs: ["./docs/../MISSING.md"] }),
    )

    expect(notes).toEqual([notIncludedNote("`./docs/../MISSING.md`")])
  })

  it("lists a doc once when priority_docs names it under two spellings", () => {
    const notes = buildContextNotes(
      makeInput({ priorityDocs: ["./MISSING.md", "MISSING.md"] }),
    )

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
    const notes = buildContextNotes(
      makeInput({ docsExcludedPaths: ["docs/overflow.md"] }),
    )

    expect(notes).toEqual([
      "1 related doc(s) excluded by `max_related_docs` cap: `docs/overflow.md`",
    ])
  })

  it("orders in-context before not-included before related files before related docs", () => {
    const notes = buildContextNotes(
      makeInput({
        priorityDocs: ["README.md", "MISSING.md"],
        priorityDocsInContext: ["README.md"],
        relatedFilesExcludedPaths: ["src/extra-a.ts"],
        docsExcludedPaths: ["docs/overflow.md"],
      }),
    )

    expect(notes).toEqual([
      inContextNote("`README.md`"),
      notIncludedNote("`MISSING.md`"),
      "1 related file(s) excluded by `max_related_files` cap: `src/extra-a.ts`",
      "1 related doc(s) excluded by `max_related_docs` cap: `docs/overflow.md`",
    ])
  })
})
