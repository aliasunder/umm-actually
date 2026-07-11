import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { createTestLogger } from "../../__tests__/test-logger.js"
import type { ReviewComment } from "../../review/comment-mapping.js"
import { createGithubClient, type OctokitLike } from "../client.js"

const pullGetResponse: unknown = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/pull.get.json", import.meta.url),
    "utf8",
  ),
)

type StubResponse = { data: unknown } | { error: unknown }

/** Records every call; replays queued responses in order, throwing queued errors. */
const makeOctokitStub = ({
  getResponses = [],
  createReviewResponses = [],
}: {
  getResponses?: StubResponse[]
  createReviewResponses?: StubResponse[]
} = {}) => {
  const getCalls: Record<string, unknown>[] = []
  const createReviewCalls: Record<string, unknown>[] = []

  const takeNext = (
    queue: StubResponse[],
    callCount: number,
    operation: string,
  ): { data: unknown } => {
    const next = queue[callCount - 1]
    if (next === undefined) {
      throw new Error(`stub: unexpected ${operation} call #${callCount}`)
    }
    if ("error" in next) throw next.error
    return next
  }

  const octokit: OctokitLike = {
    rest: {
      pulls: {
        get: async (params) => {
          getCalls.push(params)
          return takeNext(getResponses, getCalls.length, "pulls.get")
        },
        createReview: async (params) => {
          createReviewCalls.push(params)
          return takeNext(
            createReviewResponses,
            createReviewCalls.length,
            "pulls.createReview",
          )
        },
      },
    },
  }

  return { octokit, getCalls, createReviewCalls }
}

const makeClient = (stub: { octokit: OctokitLike }) => {
  const logger = createTestLogger()
  const client = createGithubClient(
    { octokit: stub.octokit, owner: "aliasunder", repo: "fixture" },
    logger,
  )
  return { client, logger }
}

const makeStatusError = (status: number): Error =>
  Object.assign(new Error(`HTTP ${status}`), { status })

const inlineComment: ReviewComment = {
  path: "src/greeter.ts",
  line: 145,
  side: "RIGHT",
  body: "Whitespace-only keys pass the empty-key guard",
}

describe("fetchPullRequest", () => {
  it("maps the pulls.get response onto a PrContext", async () => {
    const stub = makeOctokitStub({ getResponses: [{ data: pullGetResponse }] })
    const { client } = makeClient(stub)

    const prContext = await client.fetchPullRequest({ prNumber: 7 })

    expect(stub.getCalls).toEqual([
      { owner: "aliasunder", repo: "fixture", pull_number: 7 },
    ])
    expect(prContext).toEqual({
      prNumber: 7,
      title: "feat: trim names before greeting",
      body: "Trims whitespace from names and validates registry keys.",
      headSha: "abc123def456abc123def456abc123def456abc1",
      headRef: "feat/trim-names",
      baseRef: "main",
    })
  })

  it("throws on a response missing the pull request fields", async () => {
    const stub = makeOctokitStub({
      getResponses: [{ data: { message: "Not Found" } }],
    })
    const { client } = makeClient(stub)

    await expect(client.fetchPullRequest({ prNumber: 7 })).rejects.toThrow(
      "unexpected pull request response shape",
    )
  })
})

describe("fetchDiff", () => {
  it("requests the diff media type and returns the diff string", async () => {
    const diff = "diff --git a/src/greeter.ts b/src/greeter.ts\n"
    const stub = makeOctokitStub({ getResponses: [{ data: diff }] })
    const { client } = makeClient(stub)

    const result = await client.fetchDiff({ prNumber: 7 })

    expect(stub.getCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        pull_number: 7,
        mediaType: { format: "diff" },
      },
    ])
    expect(result).toEqual({ kind: "ok", diff })
  })

  it("maps a 406 to too_large", async () => {
    const stub = makeOctokitStub({
      getResponses: [{ error: makeStatusError(406) }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.fetchDiff({ prNumber: 7 })

    expect(result).toEqual({ kind: "too_large" })
    expect(logger.messages).toContainEqual({
      level: "warn",
      message: "diff exceeds GitHub's diff API limits",
      data: { prNumber: 7 },
    })
  })

  it("rethrows a non-406 error", async () => {
    const stub = makeOctokitStub({
      getResponses: [{ error: makeStatusError(500) }],
    })
    const { client } = makeClient(stub)

    await expect(client.fetchDiff({ prNumber: 7 })).rejects.toThrow("HTTP 500")
  })

  it("throws when the diff response is not a string", async () => {
    const stub = makeOctokitStub({ getResponses: [{ data: { diff: true } }] })
    const { client } = makeClient(stub)

    await expect(client.fetchDiff({ prNumber: 7 })).rejects.toThrow(
      "expected a unified diff string from the diff media type",
    )
  })
})

describe("submitReview", () => {
  const reviewUrl =
    "https://github.com/aliasunder/fixture/pull/7#pullrequestreview-1"

  it("posts body and comments and returns the review url", async () => {
    const stub = makeOctokitStub({
      createReviewResponses: [{ data: { html_url: reviewUrl } }],
    })
    const { client } = makeClient(stub)

    const result = await client.submitReview({
      prNumber: 7,
      commitId: "abc123",
      body: "review body",
      comments: [inlineComment],
      fallbackBody: "fallback body",
    })

    expect(stub.createReviewCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        pull_number: 7,
        commit_id: "abc123",
        event: "COMMENT",
        body: "review body",
        comments: [inlineComment],
      },
    ])
    expect(result).toEqual({ url: reviewUrl, usedFallbackBody: false })
  })

  it("omits the comments key entirely on a zero-comment review", async () => {
    const stub = makeOctokitStub({
      createReviewResponses: [{ data: { html_url: reviewUrl } }],
    })
    const { client } = makeClient(stub)

    await client.submitReview({
      prNumber: 7,
      commitId: "abc123",
      body: "zero findings",
      comments: [],
      fallbackBody: "fallback body",
    })

    expect(stub.createReviewCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        pull_number: 7,
        commit_id: "abc123",
        event: "COMMENT",
        body: "zero findings",
      },
    ])
  })

  it("falls back to a body-only review when inline comments are rejected with 422", async () => {
    const stub = makeOctokitStub({
      createReviewResponses: [
        { error: makeStatusError(422) },
        { data: { html_url: reviewUrl } },
      ],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.submitReview({
      prNumber: 7,
      commitId: "abc123",
      body: "review body",
      comments: [inlineComment],
      fallbackBody: "fallback body",
    })

    expect(stub.createReviewCalls[1]).toEqual({
      owner: "aliasunder",
      repo: "fixture",
      pull_number: 7,
      commit_id: "abc123",
      event: "COMMENT",
      body: "fallback body",
    })
    expect(result).toEqual({ url: reviewUrl, usedFallbackBody: true })
    expect(logger.messages).toContainEqual({
      level: "warn",
      message: "inline comments rejected (422) — posting body-only fallback",
      data: { prNumber: 7, rejectedCommentCount: 1 },
    })
  })

  it("rethrows a 422 on a zero-comment review without a second attempt", async () => {
    const stub = makeOctokitStub({
      createReviewResponses: [{ error: makeStatusError(422) }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.submitReview({
        prNumber: 7,
        commitId: "abc123",
        body: "zero findings",
        comments: [],
        fallbackBody: "fallback body",
      }),
    ).rejects.toThrow("HTTP 422")
    expect(stub.createReviewCalls).toHaveLength(1)
  })

  it("rethrows a non-422 error without a second attempt", async () => {
    const stub = makeOctokitStub({
      createReviewResponses: [{ error: makeStatusError(403) }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.submitReview({
        prNumber: 7,
        commitId: "abc123",
        body: "review body",
        comments: [inlineComment],
        fallbackBody: "fallback body",
      }),
    ).rejects.toThrow("HTTP 403")
    expect(stub.createReviewCalls).toHaveLength(1)
  })

  it("rethrows a 422 on the fallback attempt without a third attempt", async () => {
    const stub = makeOctokitStub({
      createReviewResponses: [
        { error: makeStatusError(422) },
        { error: makeStatusError(422) },
      ],
    })
    const { client } = makeClient(stub)

    await expect(
      client.submitReview({
        prNumber: 7,
        commitId: "abc123",
        body: "review body",
        comments: [inlineComment],
        fallbackBody: "fallback body",
      }),
    ).rejects.toThrow("HTTP 422")
    expect(stub.createReviewCalls).toHaveLength(2)
  })

  it("throws when the review response has no html_url", async () => {
    const stub = makeOctokitStub({
      createReviewResponses: [{ data: { id: 1 } }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.submitReview({
        prNumber: 7,
        commitId: "abc123",
        body: "review body",
        comments: [inlineComment],
        fallbackBody: "fallback body",
      }),
    ).rejects.toThrow("unexpected review response shape")
  })
})
