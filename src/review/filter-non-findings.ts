import type { Finding } from "./finding.js"

export type FilterResult = {
  findings: Finding[]
  droppedAsNonFinding: number
}

/** Matches failure_scenario prefixes that signal "no real finding" — start-anchored, case-insensitive, word-bounded. */
const NON_FINDING_PREFIX = /^(?:n\/?a|not applicable|placeholder)\b/i

const isNonFinding = (finding: Finding): boolean =>
  NON_FINDING_PREFIX.test(finding.failure_scenario)

export const filterNonFindings = (findings: Finding[]): FilterResult => {
  const realFindings = findings.filter((finding) => !isNonFinding(finding))
  return {
    findings: realFindings,
    droppedAsNonFinding: findings.length - realFindings.length,
  }
}
