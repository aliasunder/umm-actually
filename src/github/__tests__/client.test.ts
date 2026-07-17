import { readFileSync } from "node:fs"
import type { getOctokit } from "@actions/github"
import { describe, expect, expectTypeOf, it } from "vitest"
import { createTestLogger } from "../../__tests__/test-logger.js"
import type { ReviewComment } from "../../review/comment-mapping.js"
import { createGithubClient, type OctokitLike } from "../client.js"

const pullGetResponse: Record<string, unknown> = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/pull.get.json", import.meta.url),
    "utf8",
  ),
)

type StubResponse = { data: unknown } | { error: unknown }

/** Records every call; replays queued responses in order, throwing queued errors. */
type GraphqlResponse = { data: unknown } | { error: unknown }

const makeOctokitStub = ({
  getResponses = [],
  createReviewResponses = [],
  listReviewCommentsResponses = [],
  listCommentsResponses = [],
  createCommentResponses = [],
  updateCommentResponses = [],
  getByUsernameResponses = [],
  graphqlResponses = [],
}: {
  getResponses?: StubResponse[]
  createReviewResponses?: StubResponse[]
  listReviewCommentsResponses?: StubResponse[]
  listCommentsResponses?: StubResponse[]
  createCommentResponses?: StubResponse[]
  updateCommentResponses?: StubResponse[]
  getByUsernameResponses?: StubResponse[]
  graphqlResponses?: GraphqlResponse[]
} = {}) => {
  const getCalls: Record<string, unknown>[] = []
  const createReviewCalls: Record<string, unknown>[] = []
  const listReviewCommentsCalls: Record<string, unknown>[] = []
  const listCommentsCalls: Record<string, unknown>[] = []
  const createCommentCalls: Record<string, unknown>[] = []
  const updateCommentCalls: Record<string, unknown>[] = []
  const getByUsernameCalls: Record<string, unknown>[] = []
  const graphqlCalls: {
    query: string
    parameters?: Record<string, unknown>
  }[] = []

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
    graphql: <T = unknown>(
      query: string,
      parameters?: Record<string, unknown>,
    ): Promise<T> => {
      graphqlCalls.push({ query, ...(parameters ? { parameters } : {}) })
      const next = graphqlResponses[graphqlCalls.length - 1]
      if (next === undefined) {
        throw new Error(`stub: unexpected graphql call #${graphqlCalls.length}`)
      }
      if ("error" in next) return Promise.reject(next.error)
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub must satisfy the generic signature
      return Promise.resolve(next.data as T)
    },
    rest: {
      users: {
        getByUsername: async (params: Record<string, unknown>) => {
          getByUsernameCalls.push(params)
          return takeNext(
            getByUsernameResponses,
            getByUsernameCalls.length,
            "users.getByUsername",
          )
        },
      },
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
        listReviewComments: async (params) => {
          listReviewCommentsCalls.push(params)
          return takeNext(
            listReviewCommentsResponses,
            listReviewCommentsCalls.length,
            "pulls.listReviewComments",
          )
        },
      },
      issues: {
        listComments: async (params) => {
          listCommentsCalls.push(params)
          return takeNext(
            listCommentsResponses,
            listCommentsCalls.length,
            "issues.listComments",
          )
        },
        createComment: async (params) => {
          createCommentCalls.push(params)
          return takeNext(
            createCommentResponses,
            createCommentCalls.length,
            "issues.createComment",
          )
        },
        updateComment: async (params) => {
          updateCommentCalls.push(params)
          return takeNext(
            updateCommentResponses,
            updateCommentCalls.length,
            "issues.updateComment",
          )
        },
      },
    },
  }

  return {
    octokit,
    getCalls,
    createReviewCalls,
    listReviewCommentsCalls,
    listCommentsCalls,
    createCommentCalls,
    updateCommentCalls,
    getByUsernameCalls,
    graphqlCalls,
  }
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

describe("OctokitLike", () => {
  it("stays assignable from the real getOctokit() instance", () => {
    // Compile-time assertion: fails `tsc` (and this suite) if an
    // @actions/github upgrade drifts the real octokit's shape away from
    // the structural type our client accepts.
    expectTypeOf<ReturnType<typeof getOctokit>>().toExtend<OctokitLike>()
  })
})

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
      nodeId: "PR_kwDOMock7",
      title: "feat: trim names before greeting",
      body: "Trims whitespace from names and validates registry keys.",
      headSha: "abc123def456abc123def456abc123def456abc1",
      headRef: "feat/trim-names",
      baseRef: "main",
    })
  })

  it("preserves a null PR body", async () => {
    const stub = makeOctokitStub({
      getResponses: [{ data: { ...pullGetResponse, body: null } }],
    })
    const { client } = makeClient(stub)

    const prContext = await client.fetchPullRequest({ prNumber: 7 })

    expect(prContext.body).toBeNull()
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

  it("rethrows an error that carries no status property", async () => {
    const stub = makeOctokitStub({
      getResponses: [{ error: new Error("socket hang up") }],
    })
    const { client } = makeClient(stub)

    await expect(client.fetchDiff({ prNumber: 7 })).rejects.toThrow(
      "socket hang up",
    )
  })

  it("throws when the diff response is not a string", async () => {
    const stub = makeOctokitStub({ getResponses: [{ data: { diff: true } }] })
    const { client } = makeClient(stub)

    await expect(client.fetchDiff({ prNumber: 7 })).rejects.toThrow(
      "expected a unified diff string from the diff media type",
    )
  })
})

describe("requestBotReview", () => {
  it("discovers the bot identity via REST and requests review via GraphQL", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [
        { data: { viewer: { login: "umm-actually", __typename: "Bot" } } },
        { data: { requestReviews: { pullRequest: { id: "PR_kwDOMock7" } } } },
      ],
      getByUsernameResponses: [
        {
          data: {
            node_id: "BOT_kgDOEewBdQ",
            login: "umm-actually[bot]",
            type: "Bot",
          },
        },
      ],
    })
    const { client, logger } = makeClient(stub)

    await client.requestBotReview({ prNodeId: "PR_kwDOMock7" })

    expect(stub.graphqlCalls).toHaveLength(2)
    expect(stub.graphqlCalls[0]?.query).toBe(
      "query { viewer { login __typename } }",
    )
    expect(stub.getByUsernameCalls).toEqual([{ username: "umm-actually[bot]" }])
    expect(stub.graphqlCalls[1]?.parameters).toEqual({
      prId: "PR_kwDOMock7",
      botIds: ["BOT_kgDOEewBdQ"],
    })
    expect(logger.messages).toContainEqual({
      level: "info",
      message: "requested bot review",
      data: { login: "umm-actually[bot]" },
    })
  })

  it("does not double-suffix a viewer login that already carries [bot]", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [
        { data: { viewer: { login: "umm-actually[bot]", __typename: "Bot" } } },
        { data: { requestReviews: { pullRequest: { id: "PR_kwDOMock7" } } } },
      ],
      getByUsernameResponses: [
        {
          data: {
            node_id: "BOT_kgDOEewBdQ",
            login: "umm-actually[bot]",
            type: "Bot",
          },
        },
      ],
    })
    const { client } = makeClient(stub)

    await client.requestBotReview({ prNodeId: "PR_kwDOMock7" })

    expect(stub.getByUsernameCalls).toEqual([{ username: "umm-actually[bot]" }])
  })

  it("logs a warning when the bot user response is malformed", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [
        { data: { viewer: { login: "umm-actually", __typename: "Bot" } } },
      ],
      getByUsernameResponses: [{ data: { message: "Not Found" } }],
    })
    const { client, logger } = makeClient(stub)

    await client.requestBotReview({ prNodeId: "PR_kwDOMock7" })

    expect(stub.graphqlCalls).toHaveLength(1)
    expect(logger.messages).toContainEqual({
      level: "warn",
      message: "could not resolve bot user for review request",
      data: { botLogin: "umm-actually[bot]" },
    })
  })

  it("propagates errors from the viewer query", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [{ error: new Error("token expired") }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.requestBotReview({ prNodeId: "PR_kwDOMock7" }),
    ).rejects.toThrow("token expired")
  })

  it("propagates errors from the getByUsername REST call", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [
        { data: { viewer: { login: "umm-actually", __typename: "Bot" } } },
      ],
      getByUsernameResponses: [{ error: makeStatusError(404) }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.requestBotReview({ prNodeId: "PR_kwDOMock7" }),
    ).rejects.toThrow("HTTP 404")
  })

  it("propagates errors from the requestReviews mutation", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [
        { data: { viewer: { login: "umm-actually", __typename: "Bot" } } },
        { error: new Error("insufficient permissions") },
      ],
      getByUsernameResponses: [
        {
          data: {
            node_id: "BOT_kgDOEewBdQ",
            login: "umm-actually[bot]",
            type: "Bot",
          },
        },
      ],
    })
    const { client } = makeClient(stub)

    await expect(
      client.requestBotReview({ prNodeId: "PR_kwDOMock7" }),
    ).rejects.toThrow("insufficient permissions")
  })

  it("rejects a non-Bot user type", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [
        { data: { viewer: { login: "some-app", __typename: "Bot" } } },
      ],
      getByUsernameResponses: [
        {
          data: {
            node_id: "MDQ6VXNlcjEyMzQ=",
            login: "some-app[bot]",
            type: "User",
          },
        },
      ],
    })
    const { client, logger } = makeClient(stub)

    await client.requestBotReview({ prNodeId: "PR_kwDOMock7" })

    expect(stub.graphqlCalls).toHaveLength(1)
    expect(logger.messages).toContainEqual({
      level: "warn",
      message: "could not resolve bot user for review request",
      data: { botLogin: "some-app[bot]" },
    })
  })
})

describe("submitReview", () => {
  const reviewUrl =
    "https://github.com/aliasunder/fixture/pull/7#pullrequestreview-1"

  it("posts a body-only review and returns the review url", async () => {
    const stub = makeOctokitStub({
      createReviewResponses: [{ data: { html_url: reviewUrl } }],
    })
    const { client } = makeClient(stub)

    const result = await client.submitReview({
      prNumber: 7,
      commitId: "abc123",
      body: "skip notice",
    })

    // toStrictEqual: proves no comments key rides along
    expect(stub.createReviewCalls).toStrictEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        pull_number: 7,
        commit_id: "abc123",
        event: "COMMENT",
        body: "skip notice",
      },
    ])
    expect(result).toEqual({ url: reviewUrl, usedFallbackBody: false })
  })

  it("propagates errors without a retry", async () => {
    const stub = makeOctokitStub({
      createReviewResponses: [{ error: makeStatusError(403) }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.submitReview({
        prNumber: 7,
        commitId: "abc123",
        body: "skip notice",
      }),
    ).rejects.toThrow("HTTP 403")
    expect(stub.createReviewCalls).toHaveLength(1)
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
        body: "skip notice",
      }),
    ).rejects.toThrow("unexpected review response shape")
  })
})

describe("postFindingsReview", () => {
  const reviewUrl =
    "https://github.com/aliasunder/fixture/pull/7#pullrequestreview-1"
  const markerBody = "<!-- umm-actually-review -->"

  it("posts the marker body with comments and returns ok with the url", async () => {
    const stub = makeOctokitStub({
      createReviewResponses: [{ data: { html_url: reviewUrl } }],
    })
    const { client } = makeClient(stub)

    const result = await client.postFindingsReview({
      prNumber: 7,
      commitId: "abc123",
      body: markerBody,
      comments: [inlineComment],
    })

    expect(stub.createReviewCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        pull_number: 7,
        commit_id: "abc123",
        event: "COMMENT",
        body: markerBody,
        comments: [inlineComment],
      },
    ])
    expect(result).toEqual({ kind: "ok", url: reviewUrl })
  })

  it("reports rejected on a 422 without retrying", async () => {
    const stub = makeOctokitStub({
      createReviewResponses: [{ error: makeStatusError(422) }],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.postFindingsReview({
      prNumber: 7,
      commitId: "abc123",
      body: markerBody,
      comments: [inlineComment],
    })

    expect(result).toEqual({ kind: "rejected" })
    expect(stub.createReviewCalls).toHaveLength(1)
    expect(logger.messages).toContainEqual({
      level: "warn",
      message: "inline comment anchors rejected (422)",
      data: { prNumber: 7, rejectedCommentCount: 1 },
    })
  })

  it("propagates non-422 errors", async () => {
    const stub = makeOctokitStub({
      createReviewResponses: [{ error: makeStatusError(403) }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.postFindingsReview({
        prNumber: 7,
        commitId: "abc123",
        body: markerBody,
        comments: [inlineComment],
      }),
    ).rejects.toThrow("HTTP 403")
  })

  it("throws when the review response has no html_url", async () => {
    const stub = makeOctokitStub({
      createReviewResponses: [{ data: { id: 1 } }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.postFindingsReview({
        prNumber: 7,
        commitId: "abc123",
        body: markerBody,
        comments: [inlineComment],
      }),
    ).rejects.toThrow("unexpected review response shape")
  })
})

describe("postIssueComment", () => {
  const commentUrl =
    "https://github.com/aliasunder/fixture/pull/7#issuecomment-9"

  it("posts the body and returns the comment url", async () => {
    const stub = makeOctokitStub({
      createCommentResponses: [{ data: { html_url: commentUrl } }],
    })
    const { client } = makeClient(stub)

    const result = await client.postIssueComment({
      prNumber: 7,
      body: "beyond-diff finding",
    })

    expect(stub.createCommentCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        issue_number: 7,
        body: "beyond-diff finding",
      },
    ])
    expect(result).toEqual({ url: commentUrl })
  })

  it("throws on a malformed response", async () => {
    const stub = makeOctokitStub({
      createCommentResponses: [{ data: { id: 1 } }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.postIssueComment({ prNumber: 7, body: "finding" }),
    ).rejects.toThrow("unexpected issue comment response shape")
  })

  it("propagates errors", async () => {
    const stub = makeOctokitStub({
      createCommentResponses: [{ error: makeStatusError(403) }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.postIssueComment({ prNumber: 7, body: "finding" }),
    ).rejects.toThrow("HTTP 403")
  })
})

describe("fetchBotReviewComments", () => {
  const viewerResponse = {
    data: { viewer: { login: "umm-actually", __typename: "Bot" } },
  }
  const botUser = { user: { login: "umm-actually[bot]" } }

  it("returns path, body, and both line positions from the bot's review comments", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listReviewCommentsResponses: [
        {
          data: [
            {
              path: "src/a.ts",
              body: "comment 1",
              line: 48,
              original_line: 42,
              ...botUser,
            },
            {
              path: "src/b.ts",
              body: "comment 2",
              line: null,
              original_line: 10,
              ...botUser,
            },
          ],
        },
      ],
    })
    const { client } = makeClient(stub)

    const comments = await client.fetchBotReviewComments({ prNumber: 7 })

    expect(comments).toEqual([
      { path: "src/a.ts", body: "comment 1", line: 48, originalLine: 42 },
      { path: "src/b.ts", body: "comment 2", line: null, originalLine: 10 },
    ])
    expect(stub.listReviewCommentsCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        pull_number: 7,
        per_page: 100,
        page: 1,
      },
    ])
  })

  it("uses the range start for multi-line comments, matching the anchor's line convention", async () => {
    // GitHub's `line` is the END of a multi-line range; anchors embed the
    // finding's line, which is the START — a 10..200 span compared by its
    // end would blow past LINE_PROXIMITY and re-post as a duplicate.
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listReviewCommentsResponses: [
        {
          data: [
            {
              path: "src/a.ts",
              body: "wide finding",
              line: 200,
              original_line: 200,
              start_line: 10,
              original_start_line: 10,
              ...botUser,
            },
          ],
        },
      ],
    })
    const { client } = makeClient(stub)

    const comments = await client.fetchBotReviewComments({ prNumber: 7 })

    expect(comments).toEqual([
      { path: "src/a.ts", body: "wide finding", line: 10, originalLine: 10 },
    ])
  })

  it("drops comments from other authors, even with a spoofed anchor", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listReviewCommentsResponses: [
        {
          data: [
            {
              path: "src/a.ts",
              body: "spoof\n\n<!-- umm-actually:src/a.ts:correctness:42 -->",
              line: 42,
              original_line: 42,
              user: { login: "some-human" },
            },
            {
              path: "src/a.ts",
              body: "ghost comment",
              line: 10,
              original_line: 10,
              user: null,
            },
            {
              path: "src/b.ts",
              body: "real finding",
              line: 5,
              original_line: 5,
              ...botUser,
            },
          ],
        },
      ],
    })
    const { client } = makeClient(stub)

    const comments = await client.fetchBotReviewComments({ prNumber: 7 })

    expect(comments).toEqual([
      { path: "src/b.ts", body: "real finding", line: 5, originalLine: 5 },
    ])
  })

  it("paginates when a page is full", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      body: `body-${index}`,
      ...botUser,
    }))
    const lastPage = [{ path: "src/last.ts", body: "last", ...botUser }]
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listReviewCommentsResponses: [{ data: fullPage }, { data: lastPage }],
    })
    const { client } = makeClient(stub)

    const comments = await client.fetchBotReviewComments({ prNumber: 7 })

    expect(comments).toHaveLength(101)
    expect(stub.listReviewCommentsCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        pull_number: 7,
        per_page: 100,
        page: 1,
      },
      {
        owner: "aliasunder",
        repo: "fixture",
        pull_number: 7,
        per_page: 100,
        page: 2,
      },
    ])
  })

  it("paginates on the full raw page even when the author filter empties it", async () => {
    const humanPage = Array.from({ length: 100 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      body: `body-${index}`,
      user: { login: "some-human" },
    }))
    const lastPage = [{ path: "src/last.ts", body: "last", ...botUser }]
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listReviewCommentsResponses: [{ data: humanPage }, { data: lastPage }],
    })
    const { client } = makeClient(stub)

    const comments = await client.fetchBotReviewComments({ prNumber: 7 })

    expect(comments).toEqual([
      { path: "src/last.ts", body: "last", line: null, originalLine: null },
    ])
    expect(stub.listReviewCommentsCalls).toHaveLength(2)
  })

  it("stops at the page cap and logs a warning", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      body: `body-${index}`,
      ...botUser,
    }))
    const responses = Array.from({ length: 10 }, () => ({ data: fullPage }))
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listReviewCommentsResponses: responses,
    })
    const { client, logger } = makeClient(stub)

    const comments = await client.fetchBotReviewComments({ prNumber: 7 })

    expect(comments).toHaveLength(1000)
    expect(stub.listReviewCommentsCalls).toHaveLength(10)
    expect(stub.listReviewCommentsCalls[9]).toMatchObject({ page: 10 })
    expect(logger.messages).toContainEqual({
      level: "warn",
      message: "review comments page cap reached",
      data: { prNumber: 7, totalFetched: 1000 },
    })
  })

  it("maps absent line fields to null", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listReviewCommentsResponses: [
        {
          data: [{ path: "src/a.ts", body: "file-level comment", ...botUser }],
        },
      ],
    })
    const { client } = makeClient(stub)

    const comments = await client.fetchBotReviewComments({ prNumber: 7 })

    expect(comments).toEqual([
      {
        path: "src/a.ts",
        body: "file-level comment",
        line: null,
        originalLine: null,
      },
    ])
  })

  it("throws on a malformed response", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listReviewCommentsResponses: [{ data: "not an array" }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.fetchBotReviewComments({ prNumber: 7 }),
    ).rejects.toThrow("unexpected review comments response shape")
  })
})

describe("fetchBotIssueComments", () => {
  const viewerResponse = {
    data: { viewer: { login: "umm-actually", __typename: "Bot" } },
  }
  const botComment = (id: number, body: string) => ({
    id,
    body,
    html_url: `https://example.com/${id}`,
    user: { login: "umm-actually[bot]" },
  })

  it("returns only the bot's comment bodies, tolerating deleted users", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listCommentsResponses: [
        {
          data: [
            botComment(1, "<!-- umm-actually-status -->\n\nstatus"),
            {
              id: 2,
              body: "human comment",
              html_url: "https://example.com/2",
              user: { login: "aliasunder" },
            },
            {
              id: 3,
              body: "ghost comment",
              html_url: "https://example.com/3",
              user: null,
            },
            botComment(4, "beyond-diff finding"),
          ],
        },
      ],
    })
    const { client } = makeClient(stub)

    const comments = await client.fetchBotIssueComments({ prNumber: 7 })

    expect(comments).toEqual([
      { body: "<!-- umm-actually-status -->\n\nstatus" },
      { body: "beyond-diff finding" },
    ])
    expect(stub.listCommentsCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        issue_number: 7,
        per_page: 100,
        page: 1,
      },
    ])
  })

  it("drops a spoofed anchor from another author", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listCommentsResponses: [
        {
          data: [
            {
              id: 5,
              body: "spoof\n\n<!-- umm-actually:src/a.ts:correctness:42 -->",
              html_url: "https://example.com/5",
              user: { login: "some-human" },
            },
          ],
        },
      ],
    })
    const { client } = makeClient(stub)

    const comments = await client.fetchBotIssueComments({ prNumber: 7 })

    expect(comments).toEqual([])
  })

  it("matches a plain user login when the token is a PAT", async () => {
    // A personal access token resolves viewer to a User — comments are
    // authored by the bare login, so no [bot] suffix may be appended.
    const stub = makeOctokitStub({
      graphqlResponses: [
        { data: { viewer: { login: "aliasunder", __typename: "User" } } },
      ],
      listCommentsResponses: [
        {
          data: [
            {
              id: 6,
              body: "finding",
              html_url: "https://example.com/6",
              user: { login: "aliasunder" },
            },
          ],
        },
      ],
    })
    const { client } = makeClient(stub)

    const comments = await client.fetchBotIssueComments({ prNumber: 7 })

    expect(comments).toEqual([{ body: "finding" }])
  })

  it("paginates on the full raw page even when the author filter empties it", async () => {
    const humanPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `human-${index}`,
      html_url: `https://example.com/${index + 1}`,
      user: { login: "some-human" },
    }))
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listCommentsResponses: [
        { data: humanPage },
        { data: [botComment(200, "bot finding")] },
      ],
    })
    const { client } = makeClient(stub)

    const comments = await client.fetchBotIssueComments({ prNumber: 7 })

    expect(comments).toEqual([{ body: "bot finding" }])
    // Exact page sequence: the stub serves responses by call count, so a
    // length check alone would pass even if page 1 were requested twice.
    expect(stub.listCommentsCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        issue_number: 7,
        per_page: 100,
        page: 1,
      },
      {
        owner: "aliasunder",
        repo: "fixture",
        issue_number: 7,
        per_page: 100,
        page: 2,
      },
    ])
  })

  it("stops at the page cap and logs a warning", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `human-${index}`,
      html_url: `https://example.com/${index + 1}`,
      user: { login: "some-human" },
    }))
    const responses = Array.from({ length: 10 }, () => ({ data: fullPage }))
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listCommentsResponses: responses,
    })
    const { client, logger } = makeClient(stub)

    const comments = await client.fetchBotIssueComments({ prNumber: 7 })

    expect(comments).toEqual([])
    // Pages 1 through 10 exactly — not the same page requested ten times.
    expect(stub.listCommentsCalls).toEqual(
      Array.from({ length: 10 }, (_, index) => ({
        owner: "aliasunder",
        repo: "fixture",
        issue_number: 7,
        per_page: 100,
        page: index + 1,
      })),
    )
    expect(logger.messages).toContainEqual({
      level: "warn",
      message: "issue comments page cap reached",
      data: { prNumber: 7 },
    })
  })

  it("throws on a malformed response", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listCommentsResponses: [{ data: "not an array" }],
    })
    const { client } = makeClient(stub)

    await expect(client.fetchBotIssueComments({ prNumber: 7 })).rejects.toThrow(
      "unexpected issue comments response shape",
    )
  })

  it("propagates errors from the viewer query", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [{ error: new Error("token expired") }],
    })
    const { client } = makeClient(stub)

    await expect(client.fetchBotIssueComments({ prNumber: 7 })).rejects.toThrow(
      "token expired",
    )
  })
})

describe("bot login memoization", () => {
  it("resolves the viewer query only once across requestBotReview and fetchBotIssueComments", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [
        { data: { viewer: { login: "umm-actually", __typename: "Bot" } } },
        { data: { requestReviews: { pullRequest: { id: "PR_kwDOMock7" } } } },
      ],
      getByUsernameResponses: [
        {
          data: {
            node_id: "BOT_kgDOEewBdQ",
            login: "umm-actually[bot]",
            type: "Bot",
          },
        },
      ],
      listCommentsResponses: [{ data: [] }],
    })
    const { client } = makeClient(stub)

    await client.requestBotReview({ prNodeId: "PR_kwDOMock7" })
    const comments = await client.fetchBotIssueComments({ prNumber: 7 })

    expect(comments).toEqual([])
    // Only two GraphQL calls: the viewer query (memoized) and the mutation.
    // A third call would mean the viewer query ran twice.
    expect(stub.graphqlCalls).toHaveLength(2)
    expect(stub.graphqlCalls[0]).toEqual({
      query: "query { viewer { login __typename } }",
    })
    // fetchBotIssueComments must have actually listed comments — a
    // short-circuited empty result would leave this empty too.
    expect(stub.listCommentsCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        issue_number: 7,
        per_page: 100,
        page: 1,
      },
    ])
  })
})

describe("upsertSummaryComment", () => {
  const commentUrl =
    "https://github.com/aliasunder/fixture/pull/7#issuecomment-1"
  const anchor = "<!-- umm-actually-status -->"
  const viewerResponse = {
    data: { viewer: { login: "umm-actually", __typename: "Bot" } },
  }
  const body = `${anchor}\n\n**umm-actually** re-reviewed`

  it("creates a new comment when no matching anchor exists", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listCommentsResponses: [
        {
          data: [
            {
              id: 99,
              body: "human comment",
              html_url: "https://example.com",
              user: { login: "aliasunder" },
            },
          ],
        },
      ],
      createCommentResponses: [{ data: { html_url: commentUrl } }],
    })
    const { client } = makeClient(stub)

    const result = await client.upsertSummaryComment({
      prNumber: 7,
      body,
      anchor,
    })

    expect(result).toEqual({ url: commentUrl, created: true })
    expect(stub.createCommentCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        issue_number: 7,
        body,
      },
    ])
    expect(stub.updateCommentCalls).toHaveLength(0)
  })

  it("does not update a finding comment quoting the anchor mid-body", async () => {
    // Finding bodies carry model-generated text; one quoting the status
    // marker must not become the upsert target and get overwritten.
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listCommentsResponses: [
        {
          data: [
            {
              id: 55,
              body: `finding text quoting ${anchor} mid-body`,
              html_url: "https://example.com/55",
              user: { login: "umm-actually[bot]" },
            },
          ],
        },
      ],
      createCommentResponses: [{ data: { html_url: commentUrl } }],
    })
    const { client } = makeClient(stub)

    const result = await client.upsertSummaryComment({
      prNumber: 7,
      body,
      anchor,
    })

    expect(result).toEqual({ url: commentUrl, created: true })
    expect(stub.updateCommentCalls).toHaveLength(0)
    expect(stub.createCommentCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        issue_number: 7,
        body,
      },
    ])
  })

  it("updates an existing comment when the anchor is found", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listCommentsResponses: [
        {
          data: [
            {
              id: 42,
              body: `${anchor}\n\nold summary`,
              html_url: commentUrl,
              user: { login: "umm-actually[bot]" },
            },
          ],
        },
      ],
      updateCommentResponses: [{ data: { html_url: commentUrl } }],
    })
    const { client } = makeClient(stub)

    const result = await client.upsertSummaryComment({
      prNumber: 7,
      body,
      anchor,
    })

    expect(result).toEqual({ url: commentUrl, created: false })
    expect(stub.updateCommentCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        comment_id: 42,
        body,
      },
    ])
    expect(stub.createCommentCalls).toHaveLength(0)
  })

  it("finds the anchor comment on a later page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `comment ${index}`,
      html_url: `https://example.com/${index}`,
      user: { login: "aliasunder" },
    }))
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listCommentsResponses: [
        { data: fullPage },
        {
          data: [
            {
              id: 200,
              body: `${anchor}\n\nold summary`,
              html_url: commentUrl,
              user: { login: "umm-actually[bot]" },
            },
          ],
        },
      ],
      updateCommentResponses: [{ data: { html_url: commentUrl } }],
    })
    const { client } = makeClient(stub)

    const result = await client.upsertSummaryComment({
      prNumber: 7,
      body,
      anchor,
    })

    expect(result).toEqual({ url: commentUrl, created: false })
    expect(stub.listCommentsCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        issue_number: 7,
        per_page: 100,
        page: 1,
      },
      {
        owner: "aliasunder",
        repo: "fixture",
        issue_number: 7,
        per_page: 100,
        page: 2,
      },
    ])
    expect(stub.updateCommentCalls).toEqual([
      { owner: "aliasunder", repo: "fixture", comment_id: 200, body },
    ])
  })

  it("throws on a malformed issue comments response", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listCommentsResponses: [{ data: "not an array" }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.upsertSummaryComment({ prNumber: 7, body, anchor }),
    ).rejects.toThrow("unexpected issue comments response shape")
  })

  it("throws when the create response has no html_url", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listCommentsResponses: [{ data: [] }],
      createCommentResponses: [{ data: { id: 1 } }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.upsertSummaryComment({ prNumber: 7, body, anchor }),
    ).rejects.toThrow("unexpected issue comment response shape")
  })

  it("throws when the update response has no html_url", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listCommentsResponses: [
        {
          data: [
            {
              id: 42,
              body: `${anchor}\n\nold summary`,
              html_url: commentUrl,
              user: { login: "umm-actually[bot]" },
            },
          ],
        },
      ],
      updateCommentResponses: [{ data: { id: 42 } }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.upsertSummaryComment({ prNumber: 7, body, anchor }),
    ).rejects.toThrow("unexpected issue comment response shape")
  })

  it("creates a new comment instead of updating a spoofed anchor from another author", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listCommentsResponses: [
        {
          data: [
            {
              id: 66,
              body: `${anchor}\n\nspoofed receipt`,
              html_url: "https://example.com/66",
              user: { login: "some-human" },
            },
          ],
        },
      ],
      createCommentResponses: [{ data: { html_url: commentUrl } }],
    })
    const { client } = makeClient(stub)

    const result = await client.upsertSummaryComment({
      prNumber: 7,
      body,
      anchor,
    })

    expect(result).toEqual({ url: commentUrl, created: true })
    expect(stub.updateCommentCalls).toHaveLength(0)
  })

  it("creates when the issue comments list is empty", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listCommentsResponses: [{ data: [] }],
      createCommentResponses: [{ data: { html_url: commentUrl } }],
    })
    const { client } = makeClient(stub)

    const result = await client.upsertSummaryComment({
      prNumber: 7,
      body,
      anchor,
    })

    expect(result).toEqual({ url: commentUrl, created: true })
  })
})
