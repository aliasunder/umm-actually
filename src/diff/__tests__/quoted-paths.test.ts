import parseDiff, { type File } from "parse-diff"
import { describe, expect, it } from "vitest"
import { createTestLogger } from "../../__tests__/test-logger.js"
import { decodeQuotedFilePaths, decodeQuotedPath } from "../quoted-paths.js"

const makeFile = (overrides: Partial<File> = {}): File => ({
  chunks: [],
  additions: 1,
  deletions: 1,
  from: "src/app.ts",
  to: "src/app.ts",
  ...overrides,
})

describe("decodeQuotedPath", () => {
  it.each([
    {
      label: "two-byte UTF-8 octal escapes",
      path: String.raw`nn/0016_\303\245-f\303\270de.md`,
      expected: "nn/0016_å-føde.md",
    },
    {
      label: "three-byte UTF-8 octal escapes",
      path: String.raw`docs/\341\213\265.md`,
      expected: "docs/ድ.md",
    },
    {
      label: "escaped double quotes",
      path: String.raw`say \"hi\".md`,
      expected: 'say "hi".md',
    },
    {
      label: "an escaped backslash",
      path: String.raw`back\\slash.md`,
      expected: "back\\slash.md",
    },
    {
      label: "a single-character control escape",
      path: String.raw`tab\there.md`,
      expected: "tab\there.md",
    },
    {
      label: "raw non-ASCII text beside an escape",
      path: String.raw`å\\b.md`,
      expected: "å\\b.md",
    },
  ])("decodes $label", ({ path, expected }) => {
    expect(decodeQuotedPath(path)).toEqual({ kind: "decoded", path: expected })
  })

  it.each([
    { label: "a plain path", path: "src/app.ts" },
    { label: "a path with spaces", path: "docs/plain space.md" },
    { label: "the /dev/null placeholder", path: "/dev/null" },
  ])("reports $label as unquoted", ({ path }) => {
    expect(decodeQuotedPath(path)).toEqual({ kind: "unquoted" })
  })

  it.each([
    {
      // parse-diff drops the escaped backslash of a quoted path that ends in one
      label: "a lone trailing backslash",
      path: "ends-with\\",
      reason: "unrecognized escape",
    },
    {
      label: "an unknown escape character",
      path: String.raw`bad\x.md`,
      reason: "unrecognized escape",
    },
    {
      label: "an octal escape above one byte",
      path: String.raw`bad\400.md`,
      reason: "unrecognized escape",
    },
    {
      label: "an octal escape with too few digits",
      path: String.raw`bad\30.md`,
      reason: "unrecognized escape",
    },
    {
      label: "escaped bytes that are not UTF-8",
      path: String.raw`caf\351.md`,
      reason: "escaped bytes are not valid UTF-8",
    },
  ])("rejects $label as malformed", ({ path, reason }) => {
    expect(decodeQuotedPath(path)).toEqual({ kind: "malformed", reason })
  })
})

describe("decodeQuotedFilePaths", () => {
  it("decodes both paths of a quoted rename parsed by parse-diff", () => {
    const renameDiff = String.raw`diff --git "a/docs/\341\213\265.md" "b/docs/\341\213\265-new.md"
similarity index 100%
rename from "docs/\341\213\265.md"
rename to "docs/\341\213\265-new.md"`

    const decoded = decodeQuotedFilePaths(parseDiff(renameDiff), createTestLogger())

    expect(decoded).toEqual([
      { chunks: [], additions: 0, deletions: 0, from: "docs/ድ.md", to: "docs/ድ-new.md" },
    ])
  })

  it("decodes an added file and keeps its /dev/null old path", () => {
    const file = makeFile({ new: true, from: "/dev/null", to: String.raw`\303\245.md` })

    expect(decodeQuotedFilePaths([file], createTestLogger())).toEqual([
      { ...file, from: "/dev/null", to: "å.md" },
    ])
  })

  it("decodes a deleted file and keeps its /dev/null new path", () => {
    const file = makeFile({ deleted: true, from: String.raw`\303\245.md`, to: "/dev/null" })

    expect(decodeQuotedFilePaths([file], createTestLogger())).toEqual([
      { ...file, from: "å.md", to: "/dev/null" },
    ])
  })

  it("leaves an absent old path absent", () => {
    const file: File = { chunks: [], additions: 0, deletions: 0, to: String.raw`\303\245.png` }

    expect(decodeQuotedFilePaths([file], createTestLogger())).toStrictEqual([
      { chunks: [], additions: 0, deletions: 0, to: "å.png" },
    ])
  })

  it("returns unquoted files unchanged without logging", () => {
    const file = makeFile()
    const logger = createTestLogger()

    expect(decodeQuotedFilePaths([file], logger)).toEqual([file])
    expect(logger.messages).toEqual([])
  })

  it("logs each decoded path at debug", () => {
    const logger = createTestLogger()

    decodeQuotedFilePaths(
      [makeFile({ from: String.raw`\303\245.md`, to: String.raw`\303\270.md` })],
      logger,
    )

    expect(logger.messages).toEqual([
      {
        level: "debug",
        message: "decoded quoted diff path",
        data: { quotedPath: String.raw`\303\245.md`, path: "å.md" },
      },
      {
        level: "debug",
        message: "decoded quoted diff path",
        data: { quotedPath: String.raw`\303\270.md`, path: "ø.md" },
      },
    ])
  })

  it("keeps a malformed path as received and warns", () => {
    const file = makeFile({ from: String.raw`caf\351.md`, to: String.raw`caf\351.md` })
    const logger = createTestLogger()

    expect(decodeQuotedFilePaths([file], logger)).toEqual([file])
    expect(logger.messages).toEqual([
      {
        level: "warn",
        message: "malformed quoted diff path — kept as received",
        data: { path: String.raw`caf\351.md`, reason: "escaped bytes are not valid UTF-8" },
      },
      {
        level: "warn",
        message: "malformed quoted diff path — kept as received",
        data: { path: String.raw`caf\351.md`, reason: "escaped bytes are not valid UTF-8" },
      },
    ])
  })
})
