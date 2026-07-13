import { randomBytes } from "node:crypto"
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
export const CHARS_PER_TOKEN = 4
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

const OUTPUT_DISCIPLINE = `OUTPUT DISCIPLINE — field constraints:
- "title": imperative fix statement, under 80 characters (e.g. "Trim keys
  before inserting into the registry"). Do not start with "Issue:" or
  "Bug:".
- "description": 1–3 sentences stating the defect and its impact. No code
  tracing, no call-chain walk-through, no quoting of source lines. Put
  traces and evidence in "analysis", not here.
- "failure_scenario": a concrete input or state that triggers the problem
  and what goes wrong. A failure_scenario starting with "N/A", "None",
  "Not applicable", or "Placeholder" means there is no real finding — do
  not emit the finding at all.

HARD PROHIBITION — do not report a finding whose conclusion is "no bug",
"this is correct", "working as designed", "correct behavior", or any
equivalent. If your analysis concludes the code is correct, record that
conclusion in "analysis" and move on — do not emit a finding for it.`

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
    OUTPUT_DISCIPLINE,
    ANCHORING_CONTRACT,
  ].join("\n\n")

const truncateToTokenCap = (text: string, tokenCap: number): string => {
  const characterCap = tokenCap * CHARS_PER_TOKEN
  if (text.length <= characterCap) return text
  // toWellFormed: a cut mid-surrogate-pair would leave a lone surrogate,
  // which some HTTP stacks and providers reject in the request body
  return `${text.slice(0, characterCap).toWellFormed()}\n\n[conventions truncated at ~${tokenCap} tokens]`
}

/**
 * Per-run random suffix for untrusted-content wrapper tags
 * (`<file-a1b2c3d4e5f6 …>`). PR content can contain a literal closing tag,
 * but it cannot predict this run's suffix — so it cannot forge a delimiter
 * and place instruction-shaped text outside the untrusted wrapper.
 * Generated once per run by the caller and passed to buildUserPrompt.
 */
export const generateDelimiterNonce = (): string =>
  randomBytes(6).toString("hex")

/** A double quote would terminate the surrounding attribute — nothing else is
 *  structural inside a quoted attribute value. */
const escapeAttributeValue = (value: string): string =>
  value.replaceAll('"', "&quot;")

const renderFileBlock = (file: PromptFile, delimiterNonce: string): string => {
  const fileTag = `file-${delimiterNonce}`
  const pathAttribute = escapeAttributeValue(file.path)
  if (file.includedAs === "diff-only") {
    return `<${fileTag} path="${pathAttribute}" note="full content omitted: too large — see diff">\n</${fileTag}>`
  }
  const reasonAttribute =
    file.reason === undefined
      ? ""
      : ` reason="${escapeAttributeValue(file.reason)}"`
  return `<${fileTag} path="${pathAttribute}"${reasonAttribute}>\n${file.content}\n</${fileTag}>`
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
  relatedDocs,
  annotatedDiff,
  priorFindings,
  delimiterNonce,
}: {
  prContext: PrContext
  conventions: string | null
  changedFiles: PromptFile[]
  relatedFiles: PromptFile[]
  relatedDocs: PromptFile[]
  annotatedDiff: string
  priorFindings: Finding[]
  /** Per-run random tag suffix — see generateDelimiterNonce. */
  delimiterNonce: string
}): string => {
  const metadataTag = `pr_metadata-${delimiterNonce}`
  const conventionsTag = `conventions-${delimiterNonce}`
  const diffTag = `diff-${delimiterNonce}`
  const priorFindingsTag = `prior_findings-${delimiterNonce}`

  // Title, description, and branch names are PR-author-controlled — wrapped
  // like every other untrusted section so they can't sit in instruction position
  const metadataSection = [
    `<${metadataTag}>`,
    `PR title: ${prContext.title}`,
    `Branch: ${prContext.headRef} → ${prContext.baseRef}`,
    `PR description:\n${prContext.body ?? "(none)"}`,
    `</${metadataTag}>`,
  ].join("\n")

  const conventionsSection =
    conventions === null
      ? `<${conventionsTag}>\n(no conventions file found in this repository)\n</${conventionsTag}>`
      : `<${conventionsTag}>\n${truncateToTokenCap(conventions, CONVENTIONS_TOKEN_CAP)}\n</${conventionsTag}>`

  const changedFilesSection = changedFiles
    .map((changedFile) => renderFileBlock(changedFile, delimiterNonce))
    .join("\n\n")
  const relatedFilesSection = relatedFiles
    .map((relatedFile) => renderFileBlock(relatedFile, delimiterNonce))
    .join("\n\n")

  const relatedDocsSection =
    relatedDocs.length === 0
      ? ""
      : [
          "Documentation files that reference changed code (flag any claims that have become stale):",
          ...relatedDocs.map((doc) => renderFileBlock(doc, delimiterNonce)),
        ].join("\n\n")

  const priorFindingsSection =
    priorFindings.length === 0
      ? ""
      : `<${priorFindingsTag} note="already reported by earlier phases — do not re-report">\n${JSON.stringify(priorFindings, null, 2)}\n</${priorFindingsTag}>`

  const sections = [
    metadataSection,
    conventionsSection,
    changedFilesSection,
    relatedFilesSection,
    relatedDocsSection,
    `<${diffTag} note="line numbers shown are new-file line numbers">\n${annotatedDiff}\n</${diffTag}>`,
    priorFindingsSection,
  ]

  return sections.filter((section) => section !== "").join("\n\n")
}

/** Order-of-magnitude token estimate for budget decisions. */
export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / CHARS_PER_TOKEN)
