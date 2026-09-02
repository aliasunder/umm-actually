import { describe, expect, it } from "vitest"
import { filterUnknownFileFindings } from "../filter-unknown-file-findings.js"
import { makeFinding } from "./make-finding.js"

describe("filterUnknownFileFindings", () => {
  it("keeps a finding whose file is a known path", () => {
    const finding = makeFinding()

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [finding], droppedAsUnknownFile: [] })
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
    ).toEqual({ findings: [], droppedAsUnknownFile: [finding] })
  })

  it("drops a finding whose file matches no known path", () => {
    const finding = makeFinding({ file: "src/imagined.ts" })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [], droppedAsUnknownFile: [finding] })
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
    ).toEqual({ findings: [first, third], droppedAsUnknownFile: [unknown] })
  })

  it("matches a ./-prefixed finding file against the bare known path without rewriting it", () => {
    const finding = makeFinding({ file: "./src/greeter.ts" })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [finding], droppedAsUnknownFile: [] })
    expect(finding.file).toBe("./src/greeter.ts")
  })

  it("matches a bare finding file against a ./-prefixed known path", () => {
    const finding = makeFinding()

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["./src/greeter.ts"],
      }),
    ).toEqual({ findings: [finding], droppedAsUnknownFile: [] })
  })

  it("normalizes redundant segments before comparing", () => {
    const finding = makeFinding({ file: "src/../src//greeter.ts" })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [finding], droppedAsUnknownFile: [] })
  })

  it("ignores surrounding whitespace in the finding file", () => {
    const finding = makeFinding({ file: " src/greeter.ts " })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [finding], droppedAsUnknownFile: [] })
  })

  it("keeps a beyond-diff finding on a related file", () => {
    const finding = makeFinding({ file: "src/caller.ts", line: 400 })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts", "src/caller.ts"],
      }),
    ).toEqual({ findings: [finding], droppedAsUnknownFile: [] })
  })

  it("does not match on basename alone", () => {
    const finding = makeFinding({ file: "greeter.ts" })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [], droppedAsUnknownFile: [finding] })
  })

  it("does not match on a directory prefix", () => {
    const finding = makeFinding({ file: "src" })

    expect(
      filterUnknownFileFindings({
        findings: [finding],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [], droppedAsUnknownFile: [finding] })
  })

  it("drops every finding when no paths are known", () => {
    const finding = makeFinding()

    expect(
      filterUnknownFileFindings({ findings: [finding], knownPaths: [] }),
    ).toEqual({ findings: [], droppedAsUnknownFile: [finding] })
  })

  it("returns empty arrays for no findings", () => {
    expect(
      filterUnknownFileFindings({
        findings: [],
        knownPaths: ["src/greeter.ts"],
      }),
    ).toEqual({ findings: [], droppedAsUnknownFile: [] })
  })
})
