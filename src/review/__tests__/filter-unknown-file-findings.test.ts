import { describe, expect, it } from "vitest"
import { filterUnknownFileFindings } from "../filter-unknown-file-findings.js"
import { buildUserPrompt } from "../prompt.js"
import { makeFinding } from "./make-finding.js"

/** The path attribute of the first file block, exactly as the model reads it. */
const FILE_BLOCK_PATH_ATTRIBUTE = /<file-abc123def456 path="(?<path>[^"]*)"/

const getFileBlockPathAttribute = (userPrompt: string): string => {
  const path = FILE_BLOCK_PATH_ATTRIBUTE.exec(userPrompt)?.groups?.path

  if (!path) throw new Error("the prompt has no file block path attribute")
  return path
}

describe("filterUnknownFileFindings", () => {
  it("keeps a finding whose file is a known path", () => {
    const finding = makeFinding()

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [finding], droppedAsUnknownFile: [], unescapedFileRewrites: [] })
  })

  it("drops a finding whose file is a known path with prose appended", () => {
    const finding = makeFinding({
      file: "deploy/railway/README.md and the same issues...",
      line: 493,
      suggestion: "not emitted",
    })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["deploy/railway/README.md"],
      }),
    ).toEqual({ findings: [], droppedAsUnknownFile: [finding], unescapedFileRewrites: [] })
  })

  it("drops a finding whose file matches no known path", () => {
    const finding = makeFinding({ file: "src/imagined.ts" })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [], droppedAsUnknownFile: [finding], unescapedFileRewrites: [] })
  })

  it("filters selectively in a mixed set, preserving order", () => {
    const first = makeFinding({ line: 10 })
    const unknown = makeFinding({ file: "src/imagined.ts", line: 20 })
    const third = makeFinding({ line: 30 })

    expect(
      filterUnknownFileFindings({
        findings: [first, unknown, third],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({
      findings: [first, third],
      droppedAsUnknownFile: [unknown],
      unescapedFileRewrites: [],
    })
  })

  it("matches a ./-prefixed finding file against the bare known path without rewriting it", () => {
    const finding = makeFinding({ file: "./src/greeter.ts" })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [finding], droppedAsUnknownFile: [], unescapedFileRewrites: [] })
    expect(finding.file).toBe("./src/greeter.ts")
  })

  it("matches a bare finding file against a ./-prefixed known path", () => {
    const finding = makeFinding()

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["./src/greeter.ts"],
      }),
    ).toEqual({ findings: [finding], droppedAsUnknownFile: [], unescapedFileRewrites: [] })
  })

  it("normalizes redundant segments before comparing", () => {
    const finding = makeFinding({ file: "src/../src//greeter.ts" })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [finding], droppedAsUnknownFile: [], unescapedFileRewrites: [] })
  })

  it("ignores surrounding whitespace in the finding file", () => {
    const finding = makeFinding({ file: " src/greeter.ts " })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [finding], droppedAsUnknownFile: [], unescapedFileRewrites: [] })
  })

  it("keeps a beyond-diff finding on a related file", () => {
    const finding = makeFinding({ file: "src/caller.ts", line: 400 })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts", "src/caller.ts"],
      }),
    ).toEqual({ findings: [finding], droppedAsUnknownFile: [], unescapedFileRewrites: [] })
  })

  it("keeps a finding whose file escapes a known path's quote as &quot;, under the decoded path", () => {
    const escapedFinding = makeFinding({ file: "docs/a&quot;b.md", line: 12 })
    const unrelatedFinding = makeFinding({ line: 30 })
    const resolvedFinding = { ...escapedFinding, file: 'docs/a"b.md' }

    expect(
      filterUnknownFileFindings({
        findings: [escapedFinding, unrelatedFinding],
        knownPaths: ["src/greeter.ts", 'docs/a"b.md'],
      }),
    ).toEqual({
      findings: [resolvedFinding, unrelatedFinding],
      droppedAsUnknownFile: [],
      unescapedFileRewrites: [{ writtenFile: "docs/a&quot;b.md", finding: resolvedFinding }],
    })
    expect(escapedFinding.file).toBe("docs/a&quot;b.md")
  })

  it("decodes only &quot; and keeps the rest of the written spelling", () => {
    const escapedFinding = makeFinding({ file: "./docs/a&quot;b.md" })
    const resolvedFinding = { ...escapedFinding, file: './docs/a"b.md' }

    expect(
      filterUnknownFileFindings({
        findings: [escapedFinding],
        knownPaths: ['docs/a"b.md'],
      }),
    ).toEqual({
      findings: [resolvedFinding],
      droppedAsUnknownFile: [],
      unescapedFileRewrites: [{ writtenFile: "./docs/a&quot;b.md", finding: resolvedFinding }],
    })
  })

  it("keeps a known path containing a literal &quot; as written when its decoded spelling is also known", () => {
    const finding = makeFinding({ file: "docs/a&quot;b.md" })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ['docs/a"b.md', "docs/a&quot;b.md"],
      }),
    ).toEqual({ findings: [finding], droppedAsUnknownFile: [], unescapedFileRewrites: [] })
  })

  it("drops a finding whose file matches no known path before or after decoding &quot;", () => {
    const finding = makeFinding({ file: "docs/c&quot;d.md" })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ['docs/a"b.md', "docs/cd.md"],
      }),
    ).toEqual({ findings: [], droppedAsUnknownFile: [finding], unescapedFileRewrites: [] })
  })

  it("keeps a finding whose file is copied from a rendered path attribute", () => {
    const relatedDoc = {
      path: 'docs/a"b.md',
      content: "# Quoted",
      includedAs: "full" as const,
      reason: "mentions src/greeter.ts",
    }
    const userPrompt = buildUserPrompt({
      prContext: {
        prNumber: 7,
        title: "fix: trim names",
        body: null,
        headSha: "abc123",
        headRef: "fix/trim-names",
        baseRef: "main",
      },
      conventions: null,
      conventionsFile: "AGENTS.md",
      conventionsBudgetTokens: 8_000,
      changedFiles: [],
      relatedFiles: [],
      relatedDocs: [relatedDoc],
      annotatedDiff: "",
      priorFindings: [],
      priorBotComments: [],
      delimiterNonce: "abc123def456",
    })
    const writtenFile = getFileBlockPathAttribute(userPrompt)
    const finding = makeFinding({ file: writtenFile, line: 1 })
    const resolvedFinding = { ...finding, file: 'docs/a"b.md' }

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: [relatedDoc.path],
      }),
    ).toEqual({
      findings: [resolvedFinding],
      droppedAsUnknownFile: [],
      unescapedFileRewrites: [{ writtenFile, finding: resolvedFinding }],
    })
  })

  it("does not match on basename alone", () => {
    const finding = makeFinding({ file: "greeter.ts" })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [], droppedAsUnknownFile: [finding], unescapedFileRewrites: [] })
  })

  it("does not match on a directory prefix", () => {
    const finding = makeFinding({ file: "src" })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [], droppedAsUnknownFile: [finding], unescapedFileRewrites: [] })
  })

  it("drops every finding when no paths are known", () => {
    const finding = makeFinding()

    expect(filterUnknownFileFindings({ findings: [finding], knownPaths: [] })).toEqual({
      findings: [],
      droppedAsUnknownFile: [finding],
      unescapedFileRewrites: [],
    })
  })

  it("returns empty arrays for no findings", () => {
    expect(
      filterUnknownFileFindings({
        findings: [],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [], droppedAsUnknownFile: [], unescapedFileRewrites: [] })
  })
})
