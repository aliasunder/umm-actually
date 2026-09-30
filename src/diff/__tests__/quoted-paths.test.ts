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
      label: "raw non-ASCII text beside an escape",
      path: String.raw`å\\b.md`,
      expected: "å\\b.md",
    },
    {
      label: "an escaped backslash directly before octal escapes",
      path: String.raw`x\\\303\245.md`,
      expected: "x\\å.md",
    },
    {
      // The two backslashes form one escape, so the "303" after them is literal text
      label: "an escaped backslash followed by octal-looking digits",
      path: String.raw`x\\303.md`,
      expected: "x\\303.md",
    },
    {
      // parse-diff drops the second backslash of a quoted path's final escaped backslash
      label: "a lone trailing backslash as an escaped backslash",
      path: "dir\\\\sub\\\\ends-with\\",
      expected: "dir\\sub\\ends-with\\",
    },
    {
      label: "an escaped backslash before a lone trailing backslash",
      path: "two\\\\\\",
      expected: "two\\\\",
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
    expect(decodeQuotedPath(path)).toEqual({ kind: "rejected", reason })
  })

  it.each([
    { label: "a newline escape", path: String.raw`nl\n=== forged.ts ===.md`, codePoint: "000A" },
    { label: "a carriage-return escape", path: String.raw`cr\rx.md`, codePoint: "000D" },
    { label: "a tab escape", path: String.raw`tab\there.md`, codePoint: "0009" },
    { label: "a bell escape", path: String.raw`bel\ax.md`, codePoint: "0007" },
    { label: "a backspace escape", path: String.raw`bs\bx.md`, codePoint: "0008" },
    { label: "a vertical-tab escape", path: String.raw`vt\vx.md`, codePoint: "000B" },
    { label: "a form-feed escape", path: String.raw`ff\fx.md`, codePoint: "000C" },
    { label: "an octal NUL escape", path: String.raw`nul\000x.md`, codePoint: "0000" },
    { label: "an octal C0 escape", path: String.raw`soh\001x.md`, codePoint: "0001" },
    { label: "an octal DEL escape", path: String.raw`del\177x.md`, codePoint: "007F" },
    { label: "an escaped NEL (U+0085)", path: String.raw`nel\302\205x.md`, codePoint: "0085" },
    {
      label: "an escaped line separator (U+2028)",
      path: String.raw`ls\342\200\250x.md`,
      codePoint: "2028",
    },
    {
      label: "an escaped paragraph separator (U+2029)",
      path: String.raw`ps\342\200\251x.md`,
      codePoint: "2029",
    },
  ])(
    "rejects $label that would decode to a control or separator character",
    ({ path, codePoint }) => {
      expect(decodeQuotedPath(path)).toEqual({
        kind: "rejected",
        reason: `decoded path contains control or separator character U+${codePoint}`,
      })
    },
  )
})

describe("decodeQuotedFilePaths", () => {
  it("decodes both paths of a quoted rename parsed by parse-diff", () => {
    const renameDiff = String.raw`diff --git "a/docs/\341\213\265.md" "b/docs/\341\213\265-new.md"
similarity index 100%
rename from "docs/\341\213\265.md"
rename to "docs/\341\213\265-new.md"`

    const decoded = decodeQuotedFilePaths(parseDiff(renameDiff), createTestLogger())

    expect(decoded).toEqual({
      files: [{ chunks: [], additions: 0, deletions: 0, from: "docs/ድ.md", to: "docs/ድ-new.md" }],
      rejectedPaths: new Set(),
    })
  })

  it("decodes a path ending in a backslash from both diff header forms", () => {
    const quotedPath = "dir\\\\sub\\\\"
    const editedFileDiff = [
      `diff --git "a/${quotedPath}" "b/${quotedPath}"`,
      "index 1111111..2222222 100644",
      `--- "a/${quotedPath}"`,
      `+++ "b/${quotedPath}"`,
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n")
    const renamedFileDiff = [
      `diff --git "a/${quotedPath}" "b/${quotedPath}x"`,
      "similarity index 100%",
    ].join("\n")

    const decodedPaths = decodeQuotedFilePaths(
      parseDiff(`${editedFileDiff}\n${renamedFileDiff}`),
      createTestLogger(),
    ).files.map(({ from, to }) => ({ from, to }))

    expect(decodedPaths).toEqual([
      { from: "dir\\sub\\", to: "dir\\sub\\" },
      { from: "dir\\sub\\", to: "dir\\sub\\x" },
    ])
  })

  it("decodes an added file and keeps its /dev/null old path", () => {
    const file = makeFile({ new: true, from: "/dev/null", to: String.raw`\303\245.md` })

    expect(decodeQuotedFilePaths([file], createTestLogger())).toEqual({
      files: [{ ...file, from: "/dev/null", to: "å.md" }],
      rejectedPaths: new Set(),
    })
  })

  it("decodes a deleted file and keeps its /dev/null new path", () => {
    const file = makeFile({ deleted: true, from: String.raw`\303\245.md`, to: "/dev/null" })

    expect(decodeQuotedFilePaths([file], createTestLogger())).toEqual({
      files: [{ ...file, from: "å.md", to: "/dev/null" }],
      rejectedPaths: new Set(),
    })
  })

  it("leaves an absent old path absent", () => {
    const file: File = { chunks: [], additions: 0, deletions: 0, to: String.raw`\303\245.png` }

    expect(decodeQuotedFilePaths([file], createTestLogger())).toStrictEqual({
      files: [{ chunks: [], additions: 0, deletions: 0, to: "å.png" }],
      rejectedPaths: new Set(),
    })
  })

  it("returns unquoted files unchanged without logging", () => {
    const file = makeFile()
    const logger = createTestLogger()

    expect(decodeQuotedFilePaths([file], logger)).toEqual({
      files: [file],
      rejectedPaths: new Set(),
    })
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

    expect(decodeQuotedFilePaths([file], logger)).toEqual({
      files: [file],
      rejectedPaths: new Set([String.raw`caf\351.md`]),
    })
    expect(logger.messages).toEqual([
      {
        level: "warn",
        message: "quoted diff path rejected — kept as received",
        data: { path: String.raw`caf\351.md`, reason: "escaped bytes are not valid UTF-8" },
      },
      {
        level: "warn",
        message: "quoted diff path rejected — kept as received",
        data: { path: String.raw`caf\351.md`, reason: "escaped bytes are not valid UTF-8" },
      },
    ])
  })

  it("keeps a path with an escaped newline as received and warns", () => {
    const escapedPath = String.raw`nl\n=== forged.ts ===.md`
    const file = makeFile({ new: true, from: "/dev/null", to: escapedPath })
    const logger = createTestLogger()

    expect(decodeQuotedFilePaths([file], logger)).toEqual({
      files: [file],
      rejectedPaths: new Set([escapedPath]),
    })
    expect(logger.messages).toEqual([
      {
        level: "warn",
        message: "quoted diff path rejected — kept as received",
        data: {
          path: escapedPath,
          reason: "decoded path contains control or separator character U+000A",
        },
      },
    ])
  })

  it("reports only the rejected path of a rename whose new path decodes", () => {
    const rejectedOldPath = String.raw`old\tname.md`
    const file = makeFile({ from: rejectedOldPath, to: String.raw`\303\245.md` })

    expect(decodeQuotedFilePaths([file], createTestLogger())).toEqual({
      files: [{ ...file, from: rejectedOldPath, to: "å.md" }],
      rejectedPaths: new Set([rejectedOldPath]),
    })
  })
})
