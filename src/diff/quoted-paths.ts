import { isUtf8 } from "node:buffer"
import type { File } from "parse-diff"
import type { Logger } from "../logger.js"

export type QuotedPathDecoding =
  { kind: "unquoted" } | { kind: "decoded"; path: string } | { kind: "malformed"; reason: string }

/**
 * One token of a path in git's C-style quoting, matching what git's
 * unquote_c_style accepts.
 * - literal: a run of characters with no backslash.
 * - octal: three octal digits for one byte. Git writes the first digit as 0-3.
 * - The unnamed last branch takes any other backslash and the character after
 *   it. CHARACTER_ESCAPE_BYTES decides whether that pair is a valid escape.
 */
const QUOTED_PATH_TOKEN = /(?<literal>[^\\]+)|\\(?<octal>[0-3][0-7]{2})|\\.?/gs

/** Git's single-character escapes and the byte each stands for. */
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

/** The bytes one token stands for, or null for an escape git never writes. */
const getTokenBytes = (match: RegExpExecArray): Buffer | null => {
  const literal = match.groups?.literal
  const octal = match.groups?.octal

  if (literal) return Buffer.from(literal, "utf8")
  if (octal) return Buffer.of(Number.parseInt(octal, 8))

  const escapeByte = CHARACTER_ESCAPE_BYTES.get(match[0])

  if (!escapeByte) return null
  return Buffer.of(escapeByte)
}

/** Decodes a path parse-diff returned with git's quotes removed but its
 *  escapes kept. Escaped bytes decode as UTF-8. */
export const decodeQuotedPath = (path: string): QuotedPathDecoding => {
  // Git quotes any path containing a backslash, whatever core.quotePath says,
  // and every character it quotes becomes an escape that starts with one. So
  // a backslash is present exactly when the path was quoted.
  if (!path.includes("\\")) return { kind: "unquoted" }

  const byteChunks = Array.from(path.matchAll(QUOTED_PATH_TOKEN), getTokenBytes)

  if (byteChunks.includes(null)) return { kind: "malformed", reason: "unrecognized escape" }

  const bytes = Buffer.concat(byteChunks.filter((chunk) => chunk !== null))

  if (!isUtf8(bytes)) return { kind: "malformed", reason: "escaped bytes are not valid UTF-8" }
  return { kind: "decoded", path: bytes.toString("utf8") }
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

    // A guessed decoding would name a file that does not exist. The path as
    // received is at least the one GitHub's diff shows.
    if (decoding.kind === "malformed") {
      logger.warn("malformed quoted diff path — kept as received", {
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
