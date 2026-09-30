import type { Finding } from "./finding.js"
import { unescapeAttributeValue } from "./prompt.js"
import { normalizeWorkspacePath } from "./workspace-path.js"

/** A kept finding whose `file` was rewritten from its escaped spelling. */
export type UnescapedFileRewrite = {
  /** `file` exactly as the model wrote it, `&quot;` included. */
  writtenFile: string
  finding: Finding
}

export type UnknownFileFilterResult = {
  findings: Finding[]
  /** Whole findings, not a count — the caller logs each drop. */
  droppedAsUnknownFile: Finding[]
  /** Each rewritten finding is also in `findings`. The caller logs each rewrite. */
  unescapedFileRewrites: UnescapedFileRewrite[]
}

type FileResolution =
  | { kind: "known"; finding: Finding }
  | { kind: "unescaped"; finding: Finding; writtenFile: string }
  | { kind: "unknown"; finding: Finding }

/**
 * Drops findings whose `file` names no file the model was given. A finding on
 * a path the model never saw is ungrounded by construction; without this gate
 * it would route to a beyond-diff comment.
 * - Membership is exact after normalization, never by basename or prefix.
 * - A `file` that matches as written is kept unchanged, even when it contains
 *   `&quot;`, because cross-run dedup anchors key on it.
 * - A `file` that matches only after each `&quot;` becomes `"` is kept with
 *   that decoded spelling. Path attributes in the prompt escape `"` as
 *   `&quot;`, and the model copies the attribute verbatim.
 */
export const filterUnknownFileFindings = ({
  findings,
  knownPaths,
}: {
  findings: Finding[]
  knownPaths: string[]
}): UnknownFileFilterResult => {
  const knownPathSet = new Set(knownPaths.map(normalizeWorkspacePath))
  const isKnownPath = (filePath: string): boolean => {
    return knownPathSet.has(normalizeWorkspacePath(filePath))
  }

  // The written spelling is checked first, so a known path that literally
  // contains "&quot;" is never rewritten
  const resolveFile = (finding: Finding): FileResolution => {
    if (isKnownPath(finding.file)) return { kind: "known", finding }

    const unescapedFile = unescapeAttributeValue(finding.file)

    if (isKnownPath(unescapedFile)) {
      return {
        kind: "unescaped",
        finding: { ...finding, file: unescapedFile },
        writtenFile: finding.file,
      }
    }
    return { kind: "unknown", finding }
  }

  const resolutions = findings.map(resolveFile)

  return {
    findings: resolutions
      .filter((resolution) => resolution.kind !== "unknown")
      .map((resolution) => resolution.finding),
    droppedAsUnknownFile: resolutions
      .filter((resolution) => resolution.kind === "unknown")
      .map((resolution) => resolution.finding),
    unescapedFileRewrites: resolutions
      .filter((resolution) => resolution.kind === "unescaped")
      .map(({ finding, writtenFile }) => ({ writtenFile, finding })),
  }
}
