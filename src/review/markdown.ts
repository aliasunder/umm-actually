import { escapeLineBreaks } from "../diff/quoted-paths.js"

/** Each run of consecutive backticks. */
const BACKTICK_RUN = /`+/g

/** A backtick or a space at the start or the end of the text. */
const EDGE_BACKTICK_OR_SPACE = /^[` ]|[` ]$/

/**
 * Wraps text in an inline code span that nothing inside the text can close.
 * File paths reach comments as written. Git never quotes a backtick, and a
 * workspace-scan path never passes the diff decoder's line-break check.
 * - Line breaks become octal escapes, since a blank line ends the span.
 * - The delimiter is one backtick longer than the longest backtick run in the
 *   text.
 * - Text that starts or ends with a backtick or a space gets one space on each
 *   side. CommonMark strips that pair, so the rendered text is unchanged.
 */
export const renderCodeSpan = (text: string): string => {
  const singleLineText = escapeLineBreaks(text)
  const backtickRunLengths = (singleLineText.match(BACKTICK_RUN) ?? []).map((run) => run.length)
  const delimiter = "`".repeat(Math.max(0, ...backtickRunLengths) + 1)
  const padding = EDGE_BACKTICK_OR_SPACE.test(singleLineText) ? " " : ""
  return `${delimiter}${padding}${singleLineText}${padding}${delimiter}`
}
