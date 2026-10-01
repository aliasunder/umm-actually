/** Each run of consecutive backticks. */
const BACKTICK_RUN = /`+/g

/** A backtick or a space at the start or the end of the text. */
const EDGE_BACKTICK_OR_SPACE = /^[` ]|[` ]$/

/**
 * Wraps text in an inline code span that a backtick inside the text cannot
 * close. File paths reach comments as written, and git never quotes a
 * backtick, so a single-backtick span would end early.
 * - The delimiter is one backtick longer than the longest backtick run in the
 *   text.
 * - Text that starts or ends with a backtick or a space gets one space on each
 *   side. CommonMark strips that pair, so the rendered text is unchanged.
 */
export const renderCodeSpan = (text: string): string => {
  const backtickRunLengths = (text.match(BACKTICK_RUN) ?? []).map((run) => run.length)
  const delimiter = "`".repeat(Math.max(0, ...backtickRunLengths) + 1)
  const padding = EDGE_BACKTICK_OR_SPACE.test(text) ? " " : ""
  return `${delimiter}${padding}${text}${padding}${delimiter}`
}
