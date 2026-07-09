import type { PrContext } from "../github/event.js"
import type { Finding } from "./finding.js"
import type { ReviewPhase } from "./phases.js"

/** A file's content prepared for the prompt, with how/why it was included. */
export type PromptFile = {
  path: string
  content: string
  includedAs: "full" | "diff-only"
  reason?: string
}

/** ~4 chars per token — the standard rough heuristic; we only need order-of-magnitude. */
const CHARS_PER_TOKEN = 4
const CONVENTIONS_TOKEN_CAP = 8_000

const IDENTITY_AND_SCOPE = `You are umm-actually, a code review bot. You review the changes in a pull
request. You are skeptical: code being in the diff is not evidence it is correct.

SCOPE — the diff is your entry point, not your boundary. Trace every changed
function into its file and the provided related files. Check that callers of
changed code still hold their assumptions. Pre-existing bugs in code the diff
touches or depends on are valid findings — mark them by starting the
description with "Pre-existing:".

NOISE SUPPRESSION — no praise, no summaries of what the PR does, no style
opinions that are not grounded in the conventions file or one of the review
dimensions. When in doubt about a borderline nitpick, omit it — but never omit
a traced regression or a concrete bug.`

const PROOF_OF_WORK = `Before reporting findings, fill the "analysis" field: for each changed file,
one line stating what you checked per dimension and which callers or related
files you traced. When verifying documentation or description claims, quote
the sentence you checked. Findings emitted without corresponding analysis are
not trustworthy.`

const SEVERITY_RUBRIC = `Severity rubric:
- critical: exploitable security issue, data loss, or corruption
- high: incorrect behavior on realistic input
- medium: convention violation with a concrete failure mode, or a test that
  passes for the wrong reason
- low: convention or readability issue grounded in the conventions file

Confidence reflects how certain you are the finding is real (high = verified
against the code shown; low = plausible but depends on unseen code).

Every finding must include failure_scenario: the concrete input or state that
triggers the problem and what goes wrong. If you cannot state a concrete
failure scenario, do not report the finding.`

const ANCHORING_CONTRACT = `Line anchoring: "line" and "end_line" use the new-file line numbers printed in
the annotated diff. For inline placement, reference only numbers that appear
there, and keep end_line in the same hunk as line. Findings in code outside
the diff (traced regressions, pre-existing bugs) are still valuable — report
them with their real file and line; they are rendered in the review body
instead of inline.`

export const buildSystemPrompt = ({ phase }: { phase: ReviewPhase }): string =>
  [
    IDENTITY_AND_SCOPE,
    ...phase.instructionSections,
    PROOF_OF_WORK,
    SEVERITY_RUBRIC,
    ANCHORING_CONTRACT,
  ].join("\n\n")

const truncateToTokenCap = (text: string, tokenCap: number): string => {
  const characterCap = tokenCap * CHARS_PER_TOKEN
  if (text.length <= characterCap) return text
  return `${text.slice(0, characterCap)}\n\n[conventions truncated at ~${tokenCap} tokens]`
}

const renderFileBlock = (file: PromptFile): string => {
  if (file.includedAs === "diff-only") {
    return `<file path="${file.path}" note="full content omitted: too large — see diff">\n</file>`
  }
  const reasonAttribute =
    file.reason === undefined ? "" : ` reason="${file.reason}"`
  return `<file path="${file.path}"${reasonAttribute}>\n${file.content}\n</file>`
}

/**
 * Assembles the user message. Section order is stable → volatile so prefix
 * caching can help on providers that support it: metadata, conventions, file
 * contents, related files, then the diff. The diff is never truncated here —
 * oversized PRs are skipped upstream rather than reviewed badly.
 */
export const buildUserPrompt = ({
  prContext,
  conventions,
  changedFiles,
  relatedFiles,
  annotatedDiff,
  priorFindings,
}: {
  prContext: PrContext
  conventions: string | null
  changedFiles: PromptFile[]
  relatedFiles: PromptFile[]
  annotatedDiff: string
  priorFindings: Finding[]
}): string => {
  const metadataSection = [
    `PR title: ${prContext.title}`,
    `Branch: ${prContext.headRef} → ${prContext.baseRef}`,
    `PR description:\n${prContext.body ?? "(none)"}`,
  ].join("\n")

  const conventionsSection =
    conventions === null
      ? "<conventions>\n(no conventions file found in this repository)\n</conventions>"
      : `<conventions>\n${truncateToTokenCap(conventions, CONVENTIONS_TOKEN_CAP)}\n</conventions>`

  const changedFilesSection = changedFiles.map(renderFileBlock).join("\n\n")
  const relatedFilesSection = relatedFiles.map(renderFileBlock).join("\n\n")

  const priorFindingsSection =
    priorFindings.length === 0
      ? ""
      : `<prior_findings note="already reported by earlier phases — do not re-report">\n${JSON.stringify(priorFindings, null, 2)}\n</prior_findings>`

  const sections = [
    metadataSection,
    conventionsSection,
    changedFilesSection,
    relatedFilesSection,
    `<diff note="line numbers shown are new-file line numbers">\n${annotatedDiff}\n</diff>`,
    priorFindingsSection,
  ]

  return sections.filter((section) => section !== "").join("\n\n")
}

/** Order-of-magnitude token estimate for budget decisions. */
export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / CHARS_PER_TOKEN)
