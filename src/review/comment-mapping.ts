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

const findingTag = (finding: Finding): string =>
  `**[${finding.severity}/${finding.category}]** ${finding.title}`

const suggestionBlock = (finding: Finding): string =>
  finding.suggestion === null
    ? ""
    : `\n\n\`\`\`diff\n${finding.suggestion}\n\`\`\``

const renderCommentBody = (
  finding: Finding,
  snappedFromLine?: number,
): string => {
  const snapNote =
    snappedFromLine === undefined
      ? ""
      : `\n\n_Anchored near line ${snappedFromLine} (the reported line is not part of the diff)._`
  return `${findingTag(finding)} _(confidence: ${finding.confidence})_

${finding.description}

**Failure scenario:** ${finding.failure_scenario}${suggestionBlock(finding)}${snapNote}`
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
  return candidateLines.reduce((nearest, candidate) =>
    Math.abs(candidate - targetLine) < Math.abs(nearest - targetLine)
      ? candidate
      : nearest,
  )
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
  if (commentable === undefined) return { bodyFinding: finding }

  if (commentable.rightLines.has(finding.line)) {
    const endLine = multiLineEnd(finding, commentable)
    // GitHub's API: `line` is the LAST line of a multi-line range, `start_line` the first
    const comment: ReviewComment =
      endLine === undefined
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
  if (snappedLine !== undefined) {
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
 * the diff — expected output, rendered in the review body). GitHub rejects
 * the whole review on one bad anchor, so anything not verifiably anchorable
 * goes to the body.
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
    entry.comment === undefined ? [] : [entry.comment],
  )
  const bodyFindings = mapped.flatMap((entry) =>
    entry.bodyFinding === undefined ? [] : [entry.bodyFinding],
  )
  return { comments, bodyFindings }
}

const renderBodyFinding = (finding: Finding): string =>
  `- ${findingTag(finding)} — \`${finding.file}:${finding.line}\` _(confidence: ${finding.confidence})_
  ${finding.description}
  **Failure scenario:** ${finding.failure_scenario}`

/** The review's top-level body: beyond-diff findings, cap note, attribution. */
export const buildReviewBody = ({
  bodyFindings,
  droppedByCap,
  model,
}: {
  bodyFindings: Finding[]
  droppedByCap: Finding[]
  model: string
}): string => {
  const beyondDiffSection =
    bodyFindings.length === 0
      ? ""
      : `### Findings beyond the diff\n\nThese are in code the changes touch or depend on, outside the diff's line ranges:\n\n${bodyFindings.map(renderBodyFinding).join("\n\n")}`

  const capNote =
    droppedByCap.length === 0
      ? ""
      : `_${droppedByCap.length} lower-severity finding(s) omitted by the max_findings cap: ${droppedByCap.map((finding) => `\`${finding.file}:${finding.line}\``).join(", ")}_`

  const attribution = `---\n*umm-actually · ${model}*`

  return [beyondDiffSection, capNote, attribution]
    .filter((section) => section !== "")
    .join("\n\n")
}

/** Body for the confirmation review posted when nothing crossed the threshold. */
export const buildZeroFindingsBody = ({ model }: { model: string }): string =>
  `Reviewed — no findings above threshold.\n\n---\n*umm-actually · ${model}*`
