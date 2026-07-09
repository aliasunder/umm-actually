import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { createTestLogger } from "../../__tests__/test-logger.js"
import { resolvePullRequestEvent } from "../event.js"

const pullRequestPayload: unknown = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/pull_request.opened.json", import.meta.url),
    "utf8",
  ),
)
const issueCommentPayload: unknown = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/issue_comment.review.json", import.meta.url),
    "utf8",
  ),
)

describe("resolvePullRequestEvent", () => {
  it("resolves a pull_request event to a complete context", () => {
    const resolved = resolvePullRequestEvent(
      {
        eventName: "pull_request",
        payload: pullRequestPayload,
        prNumberOverride: undefined,
      },
      createTestLogger(),
    )

    expect(resolved).toEqual({
      kind: "complete",
      context: {
        prNumber: 7,
        title: "feat: trim names before greeting",
        body: "Trims whitespace from names and validates registry keys.",
        headSha: "abc123def456abc123def456abc123def456abc1",
        headRef: "feat/trim-names",
        baseRef: "main",
      },
    })
  })

  it("resolves an issue_comment event on a PR to needs_fetch with the PR number", () => {
    const resolved = resolvePullRequestEvent(
      {
        eventName: "issue_comment",
        payload: issueCommentPayload,
        prNumberOverride: undefined,
      },
      createTestLogger(),
    )

    expect(resolved).toEqual({ kind: "needs_fetch", prNumber: 7 })
  })

  it("rejects an issue_comment on a plain issue (no pull_request key)", () => {
    const plainIssuePayload = { issue: { number: 3 } }

    const resolved = resolvePullRequestEvent(
      {
        eventName: "issue_comment",
        payload: plainIssuePayload,
        prNumberOverride: undefined,
      },
      createTestLogger(),
    )

    expect(resolved).toEqual({
      kind: "not_a_pr",
      reason: "comment is on an issue, not a pull request",
    })
  })

  it("rejects an unsupported event name", () => {
    const resolved = resolvePullRequestEvent(
      { eventName: "push", payload: {}, prNumberOverride: undefined },
      createTestLogger(),
    )

    expect(resolved).toEqual({
      kind: "not_a_pr",
      reason: "unsupported event: push",
    })
  })

  it("rejects a malformed pull_request payload", () => {
    const malformedPayload = { pull_request: { number: "not-a-number" } }

    const resolved = resolvePullRequestEvent(
      {
        eventName: "pull_request",
        payload: malformedPayload,
        prNumberOverride: undefined,
      },
      createTestLogger(),
    )

    expect(resolved).toEqual({
      kind: "not_a_pr",
      reason: "malformed pull_request payload",
    })
  })

  it("prefers an explicit pr_number override over the event payload", () => {
    const resolved = resolvePullRequestEvent(
      {
        eventName: "pull_request",
        payload: pullRequestPayload,
        prNumberOverride: 99,
      },
      createTestLogger(),
    )

    expect(resolved).toEqual({ kind: "needs_fetch", prNumber: 99 })
  })
})
