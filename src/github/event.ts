import { z } from "zod"
import type { Logger } from "../logger.js"

/** Everything the review pipeline needs to know about the PR under review. */
export type PrContext = {
  prNumber: number
  nodeId: string
  title: string
  body: string | null
  headSha: string
  headRef: string
  baseRef: string
}

/**
 * Event resolution outcome. "needs_fetch" means the event only identifies the
 * PR number (issue_comment payloads) — the caller fills the rest via the API.
 */
export type ResolvedEvent =
  | { kind: "complete"; context: PrContext }
  | { kind: "needs_fetch"; prNumber: number }
  | { kind: "not_a_pr"; reason: string }

const pullRequestEventSchema = z.object({
  pull_request: z.object({
    number: z.int().positive(),
    node_id: z.string(),
    title: z.string(),
    body: z.string().nullable(),
    head: z.object({ sha: z.string(), ref: z.string() }),
    base: z.object({ ref: z.string() }),
  }),
})

const issueCommentEventSchema = z.object({
  issue: z.object({
    number: z.int().positive(),
    // Present only when the issue is actually a pull request
    pull_request: z.looseObject({}).optional(),
  }),
})

export const resolvePullRequestEvent = (
  {
    eventName,
    payload,
    prNumberOverride,
  }: {
    eventName: string
    payload: unknown
    prNumberOverride: number | undefined
  },
  logger: Logger,
): ResolvedEvent => {
  if (prNumberOverride !== undefined) {
    logger.info(`using pr_number override: ${prNumberOverride}`)
    return { kind: "needs_fetch", prNumber: prNumberOverride }
  }

  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const parsed = pullRequestEventSchema.safeParse(payload)
    if (!parsed.success) {
      return { kind: "not_a_pr", reason: `malformed ${eventName} payload` }
    }
    const pullRequest = parsed.data.pull_request
    return {
      kind: "complete",
      context: {
        prNumber: pullRequest.number,
        nodeId: pullRequest.node_id,
        title: pullRequest.title,
        body: pullRequest.body,
        headSha: pullRequest.head.sha,
        headRef: pullRequest.head.ref,
        baseRef: pullRequest.base.ref,
      },
    }
  }

  if (eventName === "issue_comment") {
    const parsed = issueCommentEventSchema.safeParse(payload)
    if (!parsed.success) {
      return { kind: "not_a_pr", reason: "malformed issue_comment payload" }
    }
    if (parsed.data.issue.pull_request === undefined) {
      return {
        kind: "not_a_pr",
        reason: "comment is on an issue, not a pull request",
      }
    }
    return { kind: "needs_fetch", prNumber: parsed.data.issue.number }
  }

  return { kind: "not_a_pr", reason: `unsupported event: ${eventName}` }
}
