import type { Finding, FindingSeverity } from "./finding.js"
import { SEVERITY_RANK } from "./finding.js"

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

const isDuplicate = (candidate: Finding, kept: Finding): boolean => {
  return (
    candidate.file === kept.file &&
    candidate.category === kept.category &&
    rangesOverlap(candidate, kept)
  )
}

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
      SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[severityThreshold],
  )
  const droppedBelowThreshold = findings.length - aboveThreshold.length

  // Sort with the full comparator before deduping — dedupe preserves order,
  // so the kept finding in any duplicate pair is always the more severe one
  // (ties broken deterministically by file, then line) and the result needs
  // no second sort.
  const sorted = [...aboveThreshold].sort((first, second) => {
    const severityDifference =
      SEVERITY_RANK[second.severity] - SEVERITY_RANK[first.severity]
    if (severityDifference !== 0) return severityDifference
    if (first.file !== second.file) return first.file.localeCompare(second.file)
    return first.line - second.line
  })
  const deduplicated = sorted.reduce<Finding[]>((kept, candidate) => {
    const duplicateOfKept = kept.some((existing) =>
      isDuplicate(candidate, existing),
    )
    return duplicateOfKept ? kept : [...kept, candidate]
  }, [])

  if (maxFindings === undefined || deduplicated.length <= maxFindings) {
    return { selected: deduplicated, droppedBelowThreshold, droppedByCap: [] }
  }
  return {
    selected: deduplicated.slice(0, maxFindings),
    droppedBelowThreshold,
    droppedByCap: deduplicated.slice(maxFindings),
  }
}
