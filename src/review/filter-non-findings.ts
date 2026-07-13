import type { Finding } from "./finding.js"

export type FilterResult = {
  findings: Finding[]
  droppedAsNonFinding: number
}

const NON_FINDING_PREFIX = /^(?:n\/?a|none|not applicable|placeholder)\b/i

const NON_FINDING_BODY =
  /\bno actual bug\b|\bthis is correct\b|\bworking as designed\b|\bby design\b|\bcorrect behavior\b|\bno bug found\b/i

const isNonFinding = (finding: Finding): boolean => {
  const scenario = finding.failure_scenario
  return NON_FINDING_PREFIX.test(scenario) || NON_FINDING_BODY.test(scenario)
}

export const filterNonFindings = (findings: Finding[]): FilterResult => {
  const realFindings = findings.filter((finding) => !isNonFinding(finding))
  return {
    findings: realFindings,
    droppedAsNonFinding: findings.length - realFindings.length,
  }
}
