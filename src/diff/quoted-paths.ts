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

/** A character that ends a line: LF, VT, FF, CR, NEL (U+0085), or a Unicode
 *  line or paragraph separator (U+2028, U+2029). */
const LINE_BREAK_CHARACTER = /[\n\v\f\r\u0085\u2028\u2029]/u

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

/**
 * A rejection naming the path's first line break, or null when it has none.
 * - The path is PR-author-controlled. It is rendered raw in markdown and in the
 *   "=== path ===" line annotateDiff writes above each file's hunks. A line
 *   break would let a filename forge such a line or split a markdown row.
 * - Other control characters, such as tab, NUL, ESC, and DEL, break no line,
 *   so they decode. The logger's JSON escapes every C0 character, and DEL
 *   prints as an invisible byte. Markdown and the prompt keep each one inside
 *   its line. A workspace read the filesystem refuses falls back to the diff.
 */
const getLineBreakRejection = (path: string): QuotedPathDecoding | null => {
  const lineBreak = LINE_BREAK_CHARACTER.exec(path)?.[0]

  if (!lineBreak) return null

  const codePointHex = lineBreak.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")
  return { kind: "rejected", reason: `path contains line-break character U+${codePointHex}` }
}

/** Decodes a path parse-diff returned with git's quotes removed but its
 *  escapes kept. Escaped bytes decode as UTF-8. */
export const decodeQuotedPath = (path: string): QuotedPathDecoding => {
  // Git quotes any path containing a backslash, whatever core.quotePath says,
  // and every character it quotes becomes an escape that starts with one. So
  // a backslash is present exactly when the path was quoted. GitHub's diff
  // quotes every line break too, but the check still runs on an unquoted path
  // so the guard does not depend on that quoting.
  if (!path.includes("\\")) return getLineBreakRejection(path) ?? { kind: "unquoted" }

  const byteChunks = Array.from(path.matchAll(QUOTED_PATH_TOKEN), getTokenBytes)

  if (!byteChunks.every((chunk) => chunk !== null)) {
    return { kind: "rejected", reason: "unrecognized escape" }
  }

  const bytes = Buffer.concat(byteChunks)

  if (!isUtf8(bytes)) return { kind: "rejected", reason: "escaped bytes are not valid UTF-8" }

  const decodedPath = bytes.toString("utf8")

  // The escaped form of a line break breaks no line, so a rejected path stays
  // escaped
  return getLineBreakRejection(decodedPath) ?? { kind: "decoded", path: decodedPath }
}

export type DecodedDiffFiles = {
  files: File[]
  /** Paths whose decoding was rejected. Each stays as the diff spelled it. A
   *  quoted one keeps its escapes and names no file in the checkout or on
   *  GitHub. */
  rejectedPaths: ReadonlySet<string>
}

/**
 * Decodes the quoted from and to paths of parsed diff files. GitHub's diff
 * quotes every non-ASCII path and any path with a quote, a backslash, or a
 * control character. parse-diff keeps the escapes, so without this step the
 * workspace read, diff exclusion, and inline comments all see a path that
 * does not exist.
 */
export const decodeQuotedFilePaths = (
  files: ReadonlyArray<File>,
  logger: Logger,
): DecodedDiffFiles => {
  const decodePath = (rawPath: string): QuotedPathDecoding => {
    const decoding = decodeQuotedPath(rawPath)

    // A guessed decoding would name a file that does not exist, and the escaped
    // form breaks no line, so the path stays as GitHub's diff shows it. The
    // checkout has no file at an escaped path, so the file is reviewed from its
    // diff alone. GitHub rejects a whole review when one inline comment names
    // such a path, so the caller keeps the file out of inline comments.
    if (decoding.kind === "rejected") {
      logger.warn("quoted diff path rejected — kept as received", {
        path: rawPath,
        reason: decoding.reason,
      })
    }

    if (decoding.kind === "decoded") {
      logger.debug("decoded quoted diff path", { quotedPath: rawPath, path: decoding.path })
    }

    return decoding
  }

  const rawPaths = files
    .flatMap((file) => [file.from, file.to])
    .filter((rawPath) => rawPath !== undefined)
  const decodingByRawPath = new Map(
    rawPaths.map((rawPath): [string, QuotedPathDecoding] => [rawPath, decodePath(rawPath)]),
  )

  /** The decoded path, or the path as received when it was unquoted or rejected. */
  const getResolvedPath = (rawPath: string): string => {
    const decoding = decodingByRawPath.get(rawPath)
    return decoding?.kind === "decoded" ? decoding.path : rawPath
  }

  const isRejectedPath = (rawPath: string): boolean => {
    return decodingByRawPath.get(rawPath)?.kind === "rejected"
  }

  return {
    files: files.map((file) => ({
      ...file,
      ...(file.from && { from: getResolvedPath(file.from) }),
      ...(file.to && { to: getResolvedPath(file.to) }),
    })),
    rejectedPaths: new Set(rawPaths.filter(isRejectedPath)),
  }
}
