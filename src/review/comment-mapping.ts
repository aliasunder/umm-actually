import type { CommentableFile } from "../diff/commentable-lines.js"
import type { Finding } from "./finding.js"
import { normalizeTitle, titleSimilarity } from "./title-similarity.js"

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

/** Matches `<!-- umm-actually:KEY -->` only at the end of a body — the
 *  genuine anchor is always the last thing the bot appends. An
 *  anchor-shaped string earlier in the body (e.g. model text quoting one)
 *  must not win the extraction, or it would suppress future findings at
 *  whatever location it names. Group 1 is the dedup key. */
const ANCHOR_PATTERN = /<!-- umm-actually:(.+?) -->\s*$/

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

/** Jaccard similarity floor for the content-based dedup tier. 0.5 requires
 *  at least half of the combined content-word vocabulary to overlap — high
 *  enough that differently-worded findings on the same topic survive, low
 *  enough that rephrased duplicates are caught. */
const CONTENT_SIMILARITY_THRESHOLD = 0.5

/** Line-distance ceiling for content-based dedup. Wider than LINE_PROXIMITY
 *  because title similarity already gates relevance — the radius only needs
 *  to absorb code motion between pushes, not conceptual proximity. */
const CONTENT_LINE_PROXIMITY = 50

/** Extracts the bold title from the first line of a rendered finding comment. */
const TITLE_PATTERN = /^\*\*(.+?)\*\*/m

export type AnchorEntry = {
  file: string
  category: string
  line: number
  title?: string
}

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
    const titleMatch = TITLE_PATTERN.exec(comment.body)?.[1]
    return [{ ...anchor, line, ...(titleMatch && { title: titleMatch }) }]
  })
}

const isPositionalDuplicate = ({
  finding,
  anchor,
}: {
  finding: AnchorEntry
  anchor: AnchorEntry
}): boolean => {
  return (
    anchor.file === finding.file &&
    anchor.category === finding.category &&
    Math.abs(anchor.line - finding.line) <= LINE_PROXIMITY
  )
}

/** Fails open to positional-only when either side lacks a title. */
const isContentDuplicate = ({
  finding,
  anchor,
}: {
  finding: AnchorEntry
  anchor: AnchorEntry
}): boolean => {
  if (!finding.title || !anchor.title) return false
  if (anchor.file !== finding.file) return false
  if (Math.abs(anchor.line - finding.line) > CONTENT_LINE_PROXIMITY)
    return false
  return (
    titleSimilarity({
      leftTokens: normalizeTitle(finding.title),
      rightTokens: normalizeTitle(anchor.title),
    }) >= CONTENT_SIMILARITY_THRESHOLD
  )
}

export type DuplicateTier = "positional" | "content"

/** Returns which dedup tier matched, or null if the finding is new. */
export const classifyDuplicate = (
  finding: AnchorEntry,
  anchors: AnchorEntry[],
): DuplicateTier | null => {
  for (const anchor of anchors) {
    if (isPositionalDuplicate({ finding, anchor })) return "positional"
  }
  for (const anchor of anchors) {
    if (isContentDuplicate({ finding, anchor })) return "content"
  }
  return null
}

export const isDuplicateFinding = (
  finding: AnchorEntry,
  anchors: AnchorEntry[],
): boolean => classifyDuplicate(finding, anchors) !== null

/** Collapses positionally overlapping anchors for the tracked-findings
 *  count. Uses positional dedup only — content similarity must not
 *  collapse genuinely distinct prior findings that happen to share
 *  title vocabulary. */
export const coalesceAnchors = (anchors: AnchorEntry[]): AnchorEntry[] => {
  return anchors.reduce<AnchorEntry[]>((kept, anchor) => {
    const positionalMatch = kept.some((existing) => {
      return isPositionalDuplicate({ finding: anchor, anchor: existing })
    })
    if (positionalMatch) return kept
    return [...kept, anchor]
  }, [])
}

/** Trailing byline on every bot comment — names the model so a reader can
 *  tell which model produced which comment when a PR accumulates runs
 *  across model or fallback changes. */
const attributionLine = (model: string): string =>
  `---\n*umm-actually · ${model}*`

/** Title-first header: bold title, then one plain-language metadata line.
 *  Every axis names itself ("Medium severity", "high confidence") because
 *  consumer repos have no decoder — the schema and rubric live in this
 *  repo, not where the finding is read. */
const findingHeader = (finding: Finding): string => {
  const severityLabel = `${finding.severity.charAt(0).toUpperCase()}${finding.severity.slice(1)} severity`
  const categoryLabel = finding.category.replaceAll("_", " ")
  return `**${finding.title}**\n${severityLabel} · ${categoryLabel} · ${finding.confidence} confidence`
}

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
  model: string,
  snappedFromLine?: number,
): string => {
  const snapNote = snappedFromLine
    ? `\n\n_Anchored near line ${snappedFromLine} (the reported line is not part of the diff)._`
    : ""
  const anchor = `\n\n<!-- umm-actually:${computeAnchorKey(finding)} -->`
  return `${findingHeader(finding)}

${finding.description}

**Failure scenario:** ${finding.failure_scenario}${suggestionBlock(finding)}${snapNote}

${attributionLine(model)}${anchor}`
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
  model: string,
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
          body: renderCommentBody(finding, model),
        }
      : {
          path: finding.file,
          line: endLine,
          side: "RIGHT",
          start_line: finding.line,
          start_side: "RIGHT",
          body: renderCommentBody(finding, model),
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
        body: renderCommentBody(finding, model, finding.line),
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
  model,
}: {
  findings: Finding[]
  commentableByPath: Map<string, CommentableFile>
  model: string
}): MappedReview => {
  const mapped = findings.map((finding) =>
    classifyFinding(finding, commentableByPath, model),
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
export const renderStandaloneFinding = (
  finding: Finding,
  model: string,
): string => {
  return `${findingHeader(finding)}

\`${finding.file}:${finding.line}\` — beyond the diff's line ranges, in code the changes touch or depend on.

${finding.description}

**Failure scenario:** ${finding.failure_scenario}${suggestionBlock(finding)}

${attributionLine(model)}

<!-- umm-actually:${computeAnchorKey(finding)} -->`
}

const buildFindingsLine = ({
  isFirstRun,
  postedCount,
  unpostedCount,
  totalCount,
}: {
  isFirstRun: boolean
  postedCount: number
  unpostedCount: number
  totalCount: number
}): string => {
  if (postedCount > 0) {
    return `${postedCount} new finding(s) posted (${totalCount} tracked finding(s) across all runs).`
  }
  if (unpostedCount > 0) {
    return `No new findings posted (${totalCount} tracked finding(s) across all runs).`
  }
  return isFirstRun
    ? "No findings above threshold."
    : `No new findings (${totalCount} tracked finding(s) across all runs).`
}

const buildIncompleteNote = (incompletePhases: string[]): string => {
  if (incompletePhases.length === 0) return ""
  // The error text stays in the check run: it embeds model slugs and
  // provider response bodies that do not belong on the PR timeline.
  if (incompletePhases.length === 1) {
    return `_Review phase \`${incompletePhases[0]}\` did not complete; its findings are missing from this run. See the check run for details._`
  }
  return `_Review phases ${incompletePhases.map((phaseId) => `\`${phaseId}\``).join(", ")} did not complete; their findings are missing from this run. See the check run for details._`
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
  contextNotes = [],
  incompletePhases = [],
}: {
  sha: string
  isFirstRun: boolean
  postedCount: number
  unpostedCount: number
  totalCount: number
  droppedByCap: Finding[]
  model: string
  contextNotes?: string[]
  /** Ids of review phases that ended without an accepted response. */
  incompletePhases?: string[]
}): string => {
  const shaShort = sha.slice(0, 7)
  const verb = isFirstRun ? "reviewed" : "re-reviewed"
  const findingsLine = buildFindingsLine({
    isFirstRun,
    postedCount,
    unpostedCount,
    totalCount,
  })
  const unpostedNote =
    unpostedCount === 0
      ? ""
      : `_${unpostedCount} finding(s) could not be posted — they will re-report on the next run._`
  const capNote =
    droppedByCap.length === 0
      ? ""
      : `_${droppedByCap.length} lower-severity finding(s) omitted by the max_findings cap: ${droppedByCap.map((finding) => `\`${finding.file}:${finding.line}\``).join(", ")}_`
  const incompleteNote = buildIncompleteNote(incompletePhases)
  const contextSection =
    contextNotes.length === 0
      ? ""
      : `<details>\n<summary>Context notes</summary>\n\n${contextNotes.map((note) => `- ${note}`).join("\n")}\n\n</details>`
  const attribution = attributionLine(model)
  return [
    STATUS_ANCHOR,
    `**umm-actually** ${verb} at \`${shaShort}\``,
    findingsLine,
    unpostedNote,
    capNote,
    incompleteNote,
    contextSection,
    attribution,
  ]
    .filter(Boolean)
    .join("\n\n")
}
