import type { Finding } from "./finding.js"
import { SEVERITY_RANK } from "./finding.js"
import { rangesOverlap } from "./select-findings.js"

export type MergedPhaseFindings = {
  findings: Finding[]
  duplicatesAcrossPhases: number
}

type PhasedFinding = { finding: Finding; phaseIndex: number }

/** Category is ignored on purpose: two phases reporting overlapping lines of
 *  one file are almost always one defect under two labels. Findings from the
 *  same phase never compare — the model deduplicates within its own call, and
 *  a one-phase run must pass through unchanged. */
const isCrossPhaseDuplicate = (
  candidate: PhasedFinding,
  kept: PhasedFinding,
): boolean => {
  return (
    candidate.phaseIndex !== kept.phaseIndex &&
    candidate.finding.file === kept.finding.file &&
    rangesOverlap(candidate.finding, kept.finding)
  )
}

const outranks = (candidate: Finding, kept: Finding): boolean =>
  SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[kept.severity]

/**
 * Collapses findings that different phases reported on overlapping lines of
 * the same file, keeping the higher severity; on a tie the earlier phase
 * wins. Input is in phase order (stage order, then phase order within a
 * stage); output preserves it, with a replacement taking the position of the
 * first finding it outranked. A candidate may overlap several kept findings
 * (a range spanning two earlier single-line findings): it must outrank all
 * of them to be kept, and then every one of them goes.
 */
export const mergePhaseFindings = (
  findingsByPhase: Finding[][],
): MergedPhaseFindings => {
  const phased = findingsByPhase.flatMap((phaseFindings, phaseIndex) => {
    return phaseFindings.map((finding) => ({ finding, phaseIndex }))
  })

  const kept = phased.reduce<PhasedFinding[]>((keptSoFar, candidate) => {
    const overlapping = keptSoFar.filter((entry) =>
      isCrossPhaseDuplicate(candidate, entry),
    )
    if (overlapping.length === 0) return [...keptSoFar, candidate]
    const outranksAll = overlapping.every((entry) =>
      outranks(candidate.finding, entry.finding),
    )
    if (!outranksAll) return keptSoFar
    return keptSoFar.flatMap((entry) => {
      if (entry === overlapping[0]) return [candidate]
      return overlapping.includes(entry) ? [] : [entry]
    })
  }, [])

  return {
    findings: kept.map((entry) => entry.finding),
    duplicatesAcrossPhases: phased.length - kept.length,
  }
}
