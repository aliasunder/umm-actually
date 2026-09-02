import type { Finding } from "./finding.js"
import { normalizeWorkspacePath } from "./workspace-path.js"

export type UnknownFileFilterResult = {
  findings: Finding[]
  /** Whole findings, not a count — the caller logs each drop. */
  droppedAsUnknownFile: Finding[]
}

/** Drops findings whose `file` names no file the model was given. A finding
 *  on a path the model never saw is ungrounded by construction; without this
 *  gate it would route to a beyond-diff comment. Exact membership after
 *  normalization — never basename or prefix matching. `file` is left as the
 *  model wrote it because cross-run dedup anchors key on it. */
export const filterUnknownFileFindings = ({
  findings,
  knownPaths,
}: {
  findings: Finding[]
  knownPaths: string[]
}): UnknownFileFilterResult => {
  const knownPathSet = new Set(knownPaths.map(normalizeWorkspacePath))
  const isKnownFile = (finding: Finding): boolean => {
    return knownPathSet.has(normalizeWorkspacePath(finding.file))
  }

  return {
    findings: findings.filter(isKnownFile),
    droppedAsUnknownFile: findings.filter((finding) => !isKnownFile(finding)),
  }
}
