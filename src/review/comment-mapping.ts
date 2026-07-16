import type { CommentableFile } from "../diff/commentable-lines.js"
import type { Finding } from "./finding.js"

/** Wire shape for POST /pulls/{n}/reviews comments[] entries. */
export type ReviewComment = {
  path: string
  line: number
  side: "RIGHT"
  start_line?: number
  start_side?: "RIGHT"
  body: string
}

export type MappedReview = {
  comments: ReviewComment[]
  bodyFindings: Finding[]
}

/**
 * How far outside a hunk a finding's line may fall and still snap to it.
 * 3 lines absorbs the common LLM anchoring drift (off-by-one from fence
 * lines or hunk headers) without capturing findings that genuinely belong
 * to distant, unchanged code — those go to the review body instead.
 */
const SNAP_DISTANCE = 3

/** Matches `<!-- umm-actually:KEY -->` -- the hidden HTML anchor in each inline finding. Group 1 is the dedup key. */
const ANCHOR_PATTERN = /<!-- umm-actually:(.+?) -->/

/**
 * Findings within this many lines of an existing anchor in the same
 * file+category are treated as duplicates. This only needs to absorb LLM
 * re-anchoring drift for the same conceptual issue — code motion between
 * pushes is handled by preferring the comment's live position (which GitHub
 * keeps updated) over the line embedded at post time. Kept small because a
 * too-wide window silently suppresses genuinely new findings, while a
 * too-narrow one merely produces a visible duplicate.
 */
const LINE_PROXIMITY = 5

export type AnchorEntry = { file: string; category: string; line: number }

/** What extractAnchors needs from an existing inline comment: the body
 *  (carrying the anchor key) plus GitHub's two positions — `line` is the
 *  current spot on the latest diff (null once outdated), `originalLine` is
 *  where the comment sat when posted. */
export type AnchorSource = {
  body: string
  line: number | null
  originalLine: number | null
}

/** Deterministic dedup key for a finding — file + category + line. */
export const computeAnchorKey = (
  finding: Pick<Finding, "file" | "category" | "line">,
): string => `${finding.file}:${finding.category}:${finding.line}`

/** Splits a `file:category:line` key from the right: the file segment may
 *  itself contain colons, categories never do, and the line must be a
 *  positive integer — old-format keys (title-hash) fail that last
 *  requirement and are rejected. */
const ANCHOR_KEY_PATTERN = /^(?<file>.+):(?<category>[^:]+):(?<line>[1-9]\d*)$/

/** Parses one `file:category:line` anchor key out of a comment body.
 *  Returns null for bodies without an anchor and for old-format keys. */
const parseAnchorKey = (body: string): AnchorEntry | null => {
  const key = ANCHOR_PATTERN.exec(body)?.[1]
  if (!key) return null
  const segments = ANCHOR_KEY_PATTERN.exec(key)?.groups
  if (!segments?.file || !segments.category || !segments.line) return null
  return {
    file: segments.file,
    category: segments.category,
    line: Number(segments.line),
  }
}

/**
 * Parses anchor entries from existing inline comments. The anchor key
 * provides file and category; for position, the comment's live line is
 * preferred over the line embedded at post time, so dedup follows code
 * motion across pushes. Falls back to `originalLine`, then the anchor's
 * own line, when the comment has gone outdated.
 */
export const extractAnchors = (comments: AnchorSource[]): AnchorEntry[] => {
  return comments.flatMap((comment) => {
    const anchor = parseAnchorKey(comment.body)
    if (anchor === null) return []
    const line = comment.line ?? comment.originalLine ?? anchor.line
    return [{ ...anchor, line }]
  })
}

/** True when a finding is within LINE_PROXIMITY of an existing anchor. */
export const isDuplicateFinding = (
  finding: Pick<Finding, "file" | "category" | "line">,
  anchors: AnchorEntry[],
): boolean => {
  return anchors.some((anchor) => {
    return (
      anchor.file === finding.file &&
      anchor.category === finding.category &&
      Math.abs(anchor.line - finding.line) <= LINE_PROXIMITY
    )
  })
}

const findingTag = (finding: Finding): string =>
  `**[${finding.severity}/${finding.category}]** ${finding.title}`

const suggestionBlock = (finding: Finding): string => {
  if (!finding.suggestion) return ""
  // CommonMark: a fence longer than any backtick run inside the content
  // cannot be closed early — sizes the fence to LLM-generated suggestions
  // that themselves contain fenced blocks
  const backtickRuns = finding.suggestion.match(/`+/g) ?? []
  const longestBacktickRun = backtickRuns.reduce(
    (longestRun, run) => Math.max(longestRun, run.length),
    0,
  )
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1))
  return `\n\n<details>\n<summary>Suggested fix</summary>\n\n${fence}diff\n${finding.suggestion}\n${fence}\n\n</details>`
}

const renderCommentBody = (
  finding: Finding,
  snappedFromLine?: number,
): string => {
  const snapNote = snappedFromLine
    ? `\n\n_Anchored near line ${snappedFromLine} (the reported line is not part of the diff)._`
    : ""
  const anchor = `\n\n<!-- umm-actually:${computeAnchorKey(finding)} -->`
  return `${findingTag(finding)} _(confidence: ${finding.confidence})_

${finding.description}

**Failure scenario:** ${finding.failure_scenario}${suggestionBlock(finding)}${snapNote}${anchor}`
}

const nearestCommentableLine = (
  targetLine: number,
  commentable: CommentableFile,
): number | undefined => {
  const withinSnapDistanceOfHunk = commentable.hunkRanges.some(
    (range) =>
      targetLine >= range.start - SNAP_DISTANCE &&
      targetLine <= range.end + SNAP_DISTANCE,
  )
  if (!withinSnapDistanceOfHunk) return undefined

  const candidateLines = [...commentable.rightLines]
  if (candidateLines.length === 0) return undefined
  const nearestLine = candidateLines.reduce((nearest, candidate) =>
    Math.abs(candidate - targetLine) < Math.abs(nearest - targetLine)
      ? candidate
      : nearest,
  )
  // Hunk proximity alone isn't enough: a nearby zero-newLines hunk (pure
  // deletion) has no rightLines, so the nearest candidate can come from a
  // distant hunk — bound the snap itself to SNAP_DISTANCE
  return Math.abs(nearestLine - targetLine) <= SNAP_DISTANCE
    ? nearestLine
    : undefined
}

/**
 * A multi-line comment is only valid when both ends are commentable and fall
 * inside the same hunk; otherwise degrade to a single-line comment at `line`.
 */
const multiLineEnd = (
  finding: Finding,
  commentable: CommentableFile,
): number | undefined => {
  // Local capture keeps the null-narrowing visible inside the .some() closure
  const endLine = finding.end_line
  if (endLine === null || endLine === finding.line) return undefined
  if (endLine < finding.line) return undefined
  if (!commentable.rightLines.has(endLine)) return undefined
  const sharedHunk = commentable.hunkRanges.some(
    (range) =>
      finding.line >= range.start &&
      finding.line <= range.end &&
      endLine >= range.start &&
      endLine <= range.end,
  )
  return sharedHunk ? endLine : undefined
}

/**
 * Routes one finding: inline comment when its line is verifiably anchorable
 * (exact or snapped), review-body finding otherwise.
 */
const classifyFinding = (
  finding: Finding,
  commentableByPath: Map<string, CommentableFile>,
): { comment?: ReviewComment; bodyFinding?: Finding } => {
  const commentable = commentableByPath.get(finding.file)
  if (!commentable) return { bodyFinding: finding }

  if (commentable.rightLines.has(finding.line)) {
    const endLine = multiLineEnd(finding, commentable)
    // GitHub's API: `line` is the LAST line of a multi-line range, `start_line` the first
    const comment: ReviewComment = !endLine
      ? {
          path: finding.file,
          line: finding.line,
          side: "RIGHT",
          body: renderCommentBody(finding),
        }
      : {
          path: finding.file,
          line: endLine,
          side: "RIGHT",
          start_line: finding.line,
          start_side: "RIGHT",
          body: renderCommentBody(finding),
        }
    return { comment }
  }

  const snappedLine = nearestCommentableLine(finding.line, commentable)
  if (snappedLine) {
    return {
      comment: {
        path: finding.file,
        line: snappedLine,
        side: "RIGHT",
        body: renderCommentBody(finding, finding.line),
      },
    }
  }

  return { bodyFinding: finding }
}

/**
 * Splits findings into inline review comments (anchored to commentable diff
 * lines) and body findings (traced regressions / pre-existing bugs outside
 * the diff — expected output, posted as individual issue comments). GitHub
 * rejects the whole review on one bad anchor, so anything not verifiably
 * anchorable is kept out of the inline batch.
 */
export const mapFindingsToReview = ({
  findings,
  commentableByPath,
}: {
  findings: Finding[]
  commentableByPath: Map<string, CommentableFile>
}): MappedReview => {
  const mapped = findings.map((finding) =>
    classifyFinding(finding, commentableByPath),
  )

  const comments = mapped.flatMap((entry) =>
    entry.comment ? [entry.comment] : [],
  )
  const bodyFindings = mapped.flatMap((entry) =>
    entry.bodyFinding ? [entry.bodyFinding] : [],
  )
  return { comments, bodyFindings }
}

/** Invisible body for the review that carries inline findings — the review
 *  exists purely as the batching vehicle (one notification, no timeline
 *  prose); all narration lives in the status comment. An HTML comment
 *  satisfies GitHub's body requirement while rendering as nothing. */
export const REVIEW_MARKER = "<!-- umm-actually-review -->"

/** Identifies the single updatable status comment. */
export const STATUS_ANCHOR = "<!-- umm-actually-status -->"

/** A beyond-diff finding posted as its own issue comment — a new comment is
 *  a visible event to PR watchers, unlike an in-place status update. Carries
 *  its dedup anchor like any inline comment. */
export const renderStandaloneFinding = (finding: Finding): string => {
  return `${findingTag(finding)} _(confidence: ${finding.confidence})_

\`${finding.file}:${finding.line}\` — beyond the diff's line ranges, in code the changes touch or depend on.

${finding.description}

**Failure scenario:** ${finding.failure_scenario}${suggestionBlock(finding)}

<!-- umm-actually:${computeAnchorKey(finding)} -->`
}

/** The single always-upserted status comment — the receipt that a run
 *  happened and the running cross-run state. Never carries finding text;
 *  findings are their own comments. Counts reflect what actually landed on
 *  the PR: findings whose posts failed are called out separately, since they
 *  carry no anchor and re-report on the next run. */
export const buildStatusComment = ({
  sha,
  isFirstRun,
  postedCount,
  unpostedCount,
  totalCount,
  droppedByCap,
  model,
}: {
  sha: string
  isFirstRun: boolean
  postedCount: number
  unpostedCount: number
  totalCount: number
  droppedByCap: Finding[]
  model: string
}): string => {
  const shaShort = sha.slice(0, 7)
  const verb = isFirstRun ? "reviewed" : "re-reviewed"
  const zeroLine = isFirstRun
    ? "No findings above threshold."
    : `No new findings (${totalCount} tracked finding(s) across all runs).`
  const findingsLine =
    postedCount > 0
      ? `${postedCount} new finding(s) posted (${totalCount} tracked finding(s) across all runs).`
      : unpostedCount > 0
        ? `No new findings posted (${totalCount} tracked finding(s) across all runs).`
        : zeroLine
  const unpostedNote =
    unpostedCount === 0
      ? ""
      : `_${unpostedCount} finding(s) could not be posted — they will re-report on the next run._`
  const capNote =
    droppedByCap.length === 0
      ? ""
      : `_${droppedByCap.length} lower-severity finding(s) omitted by the max_findings cap: ${droppedByCap.map((finding) => `\`${finding.file}:${finding.line}\``).join(", ")}_`
  const attribution = `---\n*umm-actually · ${model}*`
  return [
    STATUS_ANCHOR,
    `**umm-actually** ${verb} at \`${shaShort}\``,
    findingsLine,
    unpostedNote,
    capNote,
    attribution,
  ]
    .filter(Boolean)
    .join("\n\n")
}
