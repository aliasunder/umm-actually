import { createHash } from "node:crypto"
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

/** Deterministic dedup key for a finding — file + category + 8-char title hash. */
export const computeAnchorKey = (
  finding: Pick<Finding, "file" | "category" | "title">,
): string => {
  const titleHash = createHash("sha256")
    .update(finding.title)
    .digest("hex")
    .slice(0, 8)
  return `${finding.file}:${finding.category}:${titleHash}`
}

/** Extracts dedup keys from existing inline comment bodies. */
export const extractAnchorKeys = (commentBodies: string[]): Set<string> => {
  const keys = new Set<string>()
  for (const body of commentBodies) {
    const match = ANCHOR_PATTERN.exec(body)
    if (match?.[1]) {
      keys.add(match[1])
    }
  }
  return keys
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
  const snapNote =
    snappedFromLine === undefined
      ? ""
      : `\n\n_Anchored near line ${snappedFromLine} (the reported line is not part of the diff)._`
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
  **Failure scenario:** ${finding.failure_scenario}${suggestionBlock(finding)}`

/** The review's top-level body: summary, body findings section, cap note, attribution. */
export const buildReviewBody = ({
  bodyFindings,
  droppedByCap,
  model,
  inlineCommentCount = 0,
  bodyFindingsHeading = "Findings beyond the diff",
  bodyFindingsDescription = "These are in code the changes touch or depend on, outside the diff's line ranges:",
  contextNotes = [],
}: {
  bodyFindings: Finding[]
  droppedByCap: Finding[]
  model: string
  inlineCommentCount?: number
  bodyFindingsHeading?: string
  bodyFindingsDescription?: string
  contextNotes?: string[]
}): string => {
  const summaryLine =
    inlineCommentCount > 0 && bodyFindings.length === 0
      ? `Reviewed — ${inlineCommentCount} finding(s) posted as inline comments.`
      : ""

  const beyondDiffSection =
    bodyFindings.length === 0
      ? ""
      : `### ${bodyFindingsHeading}\n\n${bodyFindingsDescription}\n\n${bodyFindings.map(renderBodyFinding).join("\n\n")}`

  const capNote =
    droppedByCap.length === 0
      ? ""
      : `_${droppedByCap.length} lower-severity finding(s) omitted by the max_findings cap: ${droppedByCap.map((finding) => `\`${finding.file}:${finding.line}\``).join(", ")}_`

  const contextSection =
    contextNotes.length === 0
      ? ""
      : `<details>\n<summary>Context notes</summary>\n\n${contextNotes.map((note) => `- ${note}`).join("\n")}\n\n</details>`

  const attribution = `---\n*umm-actually · ${model}*`

  return [summaryLine, beyondDiffSection, capNote, contextSection, attribution]
    .filter((section) => section !== "")
    .join("\n\n")
}

/** Body for the confirmation review posted when nothing crossed the threshold. */
export const buildZeroFindingsBody = ({
  model,
  contextNotes = [],
}: {
  model: string
  contextNotes?: string[]
}): string => {
  const contextSection =
    contextNotes.length === 0
      ? ""
      : `\n\n<details>\n<summary>Context notes</summary>\n\n${contextNotes.map((note) => `- ${note}`).join("\n")}\n\n</details>`

  return `Reviewed — no findings above threshold.${contextSection}\n\n---\n*umm-actually · ${model}*`
}

export const RERUN_ANCHOR = "<!-- umm-actually-rerun -->"

/** Body for the updatable issue comment posted on re-runs. */
export const buildRerunSummary = ({
  sha,
  newCount,
  totalCount,
  model,
}: {
  sha: string
  newCount: number
  totalCount: number
  model: string
}): string => {
  const shaShort = sha.slice(0, 7)
  const findingsLine =
    newCount > 0
      ? `${newCount} new finding(s) posted as inline comments (${totalCount} total across all reviews).`
      : `No new findings (${totalCount} finding(s) from prior reviews).`
  const attribution = `---\n*umm-actually · ${model}*`
  return [
    RERUN_ANCHOR,
    `**umm-actually** re-reviewed at \`${shaShort}\``,
    findingsLine,
    attribution,
  ].join("\n\n")
}
