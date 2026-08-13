import type { Finding } from "./finding.js"

export type FilterResult = {
  findings: Finding[]
  droppedAsNonFinding: number
}

/** Matches field prefixes that signal "no real finding" — start-anchored, case-insensitive, word-bounded. */
const NON_FINDING_PREFIX = /^(?:n\/?a|not applicable|placeholder)\b/i

/** Confirmation phrases that signal "no real finding" when they START a
 *  field. The phrase must be followed by a separator or end-of-text so real
 *  scenarios survive — "No failure occurs until the third retry…" and "None
 *  of the guards catch this input" never match, while observed confirmations
 *  (always separator-delimited, e.g. "No failure — the code handles…") do. */
const CONFIRMATION_PREFIX =
  /^(?:none|not a finding|no failure|no concrete failure scenario|no bug|no (?:further )?action needed|no change needed)\s*(?:[—–:.-]|$)/i

/** Declarative confirmation titles — "…is correct" / "…is accurate" — end-anchored. */
const CONFIRMATION_TITLE_SUFFIX = /\bis\s+(?:correct|accurate)\s*\.?\s*$/i

/** Prior-finding resolution confirmations — "Prior bot finding addressed: …"
 *  — start-anchored with a required resolution verb, so real findings about
 *  prior-comment handling ("Prior bot comments cap drops newest…") survive. */
const CONFIRMATION_TITLE_PREFIX =
  /^prior (?:bot )?findings? (?:addressed|resolved|fixed)\b/i

/** Conclusions leaked to the end of a rambling failure_scenario
 *  ("…No bug here.", "…my analysis was wrong.") — self-referential verdicts
 *  that never legitimately end a failure description. */
const CONFIRMATION_SCENARIO_SUFFIX =
  /(?:\bno bug(?: here)?|\banalysis was wrong)\s*\.?\s*$/i

/** Start-of-field signal shared by title, failure_scenario, and suggestion:
 *  an explicit non-finding prefix or a separator-anchored confirmation phrase. */
const hasNonFindingSignal = (text: string): boolean => {
  return NON_FINDING_PREFIX.test(text) || CONFIRMATION_PREFIX.test(text)
}

/** Checks title, failure_scenario, and suggestion against start- and
 *  end-anchored patterns that signal the model reported a non-finding
 *  rather than a real defect. */
const isNonFinding = (finding: Finding): boolean => {
  const title = finding.title.trim()
  const failureScenario = finding.failure_scenario.trim()
  if (hasNonFindingSignal(title)) return true
  if (CONFIRMATION_TITLE_SUFFIX.test(title)) return true
  if (CONFIRMATION_TITLE_PREFIX.test(title)) return true
  if (hasNonFindingSignal(failureScenario)) return true
  if (CONFIRMATION_SCENARIO_SUFFIX.test(failureScenario)) return true
  if (finding.suggestion && hasNonFindingSignal(finding.suggestion.trim())) {
    return true
  }
  return false
}

/** Removes model-reported non-findings (N/A titles, confirmation phrases,
 *  etc.) before findings enter the selection pipeline. */
export const filterNonFindings = (findings: Finding[]): FilterResult => {
  const realFindings = findings.filter((finding) => !isNonFinding(finding))
  return {
    findings: realFindings,
    droppedAsNonFinding: findings.length - realFindings.length,
  }
}
