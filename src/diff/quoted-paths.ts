import { isUtf8 } from "node:buffer"
import type { File } from "parse-diff"
import type { Logger } from "../logger.js"

export type QuotedPathDecoding =
  { kind: "unquoted" } | { kind: "decoded"; path: string } | { kind: "rejected"; reason: string }

/**
 * One token of a path in git's C-style quoting, matching what git's
 * unquote_c_style accepts.
 * - literal: a run of characters with no backslash.
 * - octal: three octal digits for one byte. Git writes the first digit as 0-3.
 * - The unnamed last branch takes any other backslash and the character after
 *   it. A backslash at the end of the path matches alone. The s flag lets that
 *   character be a newline. CHARACTER_ESCAPE_BYTES decides whether a
 *   two-character match is a valid escape.
 *
 * Every character starts one of the three branches, so matchAll consumes the
 * whole path and skips nothing.
 */
const QUOTED_PATH_TOKEN = /(?<literal>[^\\]+)|\\(?<octal>[0-3][0-7]{2})|\\.?/gs

/** Git's single-character escapes and the byte each stands for. Each key is
 *  the escape as written in the path, backslash included. */
const CHARACTER_ESCAPE_BYTES = new Map([
  ["\\a", 0x07],
  ["\\b", 0x08],
  ["\\t", 0x09],
  ["\\n", 0x0a],
  ["\\v", 0x0b],
  ["\\f", 0x0c],
  ["\\r", 0x0d],
  ['\\"', 0x22],
  ["\\\\", 0x5c],
])

/** A control character (C0, DEL, C1) or a Unicode line or paragraph separator. */
const CONTROL_OR_SEPARATOR_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u

/** The bytes one token stands for, or null for an escape git never writes. */
const getTokenBytes = (match: RegExpExecArray): Buffer | null => {
  const literal = match.groups?.literal
  const octal = match.groups?.octal

  if (literal) return Buffer.from(literal, "utf8")
  if (octal) return Buffer.of(Number.parseInt(octal, 8))

  // parse-diff's `---` and `+++` parsing strips a trailing `\"` as the closing
  // quote, so a path ending in an escaped backslash arrives with only its first
  // backslash. A lone backslash can only match at the end of the path, and it
  // stands for that escaped backslash.
  if (match[0] === "\\") return Buffer.of(0x5c)

  const escapeByte = CHARACTER_ESCAPE_BYTES.get(match[0])

  // 0x00 is a valid byte, so only a missing key marks an unrecognized escape
  if (escapeByte === undefined) return null
  return Buffer.of(escapeByte)
}

/** Decodes a path parse-diff returned with git's quotes removed but its
 *  escapes kept. Escaped bytes decode as UTF-8. */
export const decodeQuotedPath = (path: string): QuotedPathDecoding => {
  // Git quotes any path containing a backslash, whatever core.quotePath says,
  // and every character it quotes becomes an escape that starts with one. So
  // a backslash is present exactly when the path was quoted. GitHub's diff
  // also quotes every control and non-ASCII character, so an unquoted path
  // holds none of the characters the check below rejects.
  if (!path.includes("\\")) return { kind: "unquoted" }

  const byteChunks = Array.from(path.matchAll(QUOTED_PATH_TOKEN), getTokenBytes)

  if (!byteChunks.every((chunk) => chunk !== null)) {
    return { kind: "rejected", reason: "unrecognized escape" }
  }

  const bytes = Buffer.concat(byteChunks)

  if (!isUtf8(bytes)) return { kind: "rejected", reason: "escaped bytes are not valid UTF-8" }

  const decodedPath = bytes.toString("utf8")
  const unsafeCharacter = CONTROL_OR_SEPARATOR_CHARACTER.exec(decodedPath)?.[0]

  // The path is PR-author-controlled and is rendered raw in markdown and in
  // the "=== path ===" line annotateDiff writes above each file's hunks. A
  // decoded newline would let a filename forge such a line, while the escaped
  // form breaks no line.
  if (unsafeCharacter) {
    const codePointHex = unsafeCharacter.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")
    return {
      kind: "rejected",
      reason: `decoded path contains control or separator character U+${codePointHex}`,
    }
  }

  return { kind: "decoded", path: decodedPath }
}

/**
 * Decodes the quoted from and to paths of parsed diff files. GitHub's diff
 * quotes every non-ASCII path and any path with a quote, a backslash, or a
 * control character. parse-diff keeps the escapes, so without this step the
 * workspace read, diff exclusion, and inline comments all see a path that
 * does not exist.
 */
export const decodeQuotedFilePaths = (files: ReadonlyArray<File>, logger: Logger): File[] => {
  const decodePath = (rawPath: string): string => {
    const decoding = decodeQuotedPath(rawPath)

    if (decoding.kind === "unquoted") return rawPath

    // A guessed decoding would name a file that does not exist, and the escaped
    // form breaks no line, so the path stays as GitHub's diff shows it. The
    // checkout has no file at that path, so the file is reviewed from its diff alone.
    if (decoding.kind === "rejected") {
      logger.warn("quoted diff path rejected — kept as received", {
        path: rawPath,
        reason: decoding.reason,
      })
      return rawPath
    }

    logger.debug("decoded quoted diff path", { quotedPath: rawPath, path: decoding.path })
    return decoding.path
  }

  return files.map((file) => ({
    ...file,
    ...(file.from && { from: decodePath(file.from) }),
    ...(file.to && { to: decodePath(file.to) }),
  }))
}
