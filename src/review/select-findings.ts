import type { Finding, FindingSeverity } from "./finding.js"
import { severityRank } from "./finding.js"

export type SelectionResult = {
  selected: Finding[]
  droppedBelowThreshold: number
  droppedByCap: Finding[]
}

// The model can emit an inverted range (end_line before line); order the ends
// so an inverted range can't slip past the overlap check and post a duplicate.
// comment-mapping independently degrades the same case to a single-line comment.
const lineRange = (finding: Finding): { start: number; end: number } => {
  const endLine = finding.end_line ?? finding.line
  return {
    start: Math.min(finding.line, endLine),
    end: Math.max(finding.line, endLine),
  }
}

const rangesOverlap = (first: Finding, second: Finding): boolean => {
  const firstRange = lineRange(first)
  const secondRange = lineRange(second)
  return (
    firstRange.start <= secondRange.end && secondRange.start <= firstRange.end
  )
}

const isDuplicate = (candidate: Finding, kept: Finding): boolean =>
  candidate.file === kept.file &&
  candidate.category === kept.category &&
  rangesOverlap(candidate, kept)

/**
 * Threshold-filter, dedupe, sort, and (only when a cap was provided) cap.
 * Dedupe keeps the higher-severity finding when two findings of the same
 * category overlap in the same file — in V2 this is also where cross-phase
 * duplicates collapse.
 */
export const selectFindings = ({
  findings,
  severityThreshold,
  maxFindings,
}: {
  findings: Finding[]
  severityThreshold: FindingSeverity
  maxFindings: number | undefined
}): SelectionResult => {
  const aboveThreshold = findings.filter(
    (finding) =>
      severityRank[finding.severity] >= severityRank[severityThreshold],
  )
  const droppedBelowThreshold = findings.length - aboveThreshold.length

  // Process by severity (desc) so the kept finding in any duplicate pair is
  // always the more severe one.
  const bySeverity = [...aboveThreshold].sort(
    (first, second) =>
      severityRank[second.severity] - severityRank[first.severity],
  )
  const deduplicated = bySeverity.reduce<Finding[]>((kept, candidate) => {
    const duplicateOfKept = kept.some((existing) =>
      isDuplicate(candidate, existing),
    )
    return duplicateOfKept ? kept : [...kept, candidate]
  }, [])

  const sorted = [...deduplicated].sort((first, second) => {
    const severityDifference =
      severityRank[second.severity] - severityRank[first.severity]
    if (severityDifference !== 0) return severityDifference
    if (first.file !== second.file) return first.file.localeCompare(second.file)
    return first.line - second.line
  })

  if (maxFindings === undefined || sorted.length <= maxFindings) {
    return { selected: sorted, droppedBelowThreshold, droppedByCap: [] }
  }
  return {
    selected: sorted.slice(0, maxFindings),
    droppedBelowThreshold,
    droppedByCap: sorted.slice(maxFindings),
  }
}
