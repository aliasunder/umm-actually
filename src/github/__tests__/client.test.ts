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
  listReviewsResponses = [],
  listCommentsResponses = [],
  createCommentResponses = [],
  updateCommentResponses = [],
  getByUsernameResponses = [],
  graphqlResponses = [],
}: {
  getResponses?: StubResponse[]
  createReviewResponses?: StubResponse[]
  listReviewCommentsResponses?: StubResponse[]
  listReviewsResponses?: StubResponse[]
  listCommentsResponses?: StubResponse[]
  createCommentResponses?: StubResponse[]
  updateCommentResponses?: StubResponse[]
  getByUsernameResponses?: StubResponse[]
  graphqlResponses?: GraphqlResponse[]
} = {}) => {
  const getCalls: Record<string, unknown>[] = []
  const createReviewCalls: Record<string, unknown>[] = []
  const listReviewCommentsCalls: Record<string, unknown>[] = []
  const listReviewsCalls: Record<string, unknown>[] = []
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
        listReviews: async (params) => {
          listReviewsCalls.push(params)
          return takeNext(
            listReviewsResponses,
            listReviewsCalls.length,
            "pulls.listReviews",
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
    listReviewsCalls,
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
        { data: { viewer: { login: "umm-actually" } } },
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
    expect(stub.graphqlCalls[0]?.query).toBe("query { viewer { login } }")
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
        { data: { viewer: { login: "umm-actually[bot]" } } },
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
      graphqlResponses: [{ data: { viewer: { login: "umm-actually" } } }],
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
      graphqlResponses: [{ data: { viewer: { login: "umm-actually" } } }],
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
        { data: { viewer: { login: "umm-actually" } } },
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
      graphqlResponses: [{ data: { viewer: { login: "some-app" } } }],
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

    // toStrictEqual: toEqual ignores undefined-valued keys, so it cannot
    // tell `comments` absent apart from `comments: undefined`
    expect(stub.createReviewCalls).toStrictEqual([
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

    // Whole-array assert: proves the first call carried the inline comments,
    // the retry dropped them (strictly — no `comments: undefined` residue),
    // and no third attempt followed
    expect(stub.createReviewCalls).toStrictEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        pull_number: 7,
        commit_id: "abc123",
        event: "COMMENT",
        body: "review body",
        comments: [inlineComment],
      },
      {
        owner: "aliasunder",
        repo: "fixture",
        pull_number: 7,
        commit_id: "abc123",
        event: "COMMENT",
        body: "fallback body",
      },
    ])
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

describe("fetchBotReviewComments", () => {
  const viewerResponse = { data: { viewer: { login: "umm-actually" } } }
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

describe("hasPriorBotReview", () => {
  const viewerResponse = { data: { viewer: { login: "umm-actually" } } }

  it("returns true when the bot has a review on the PR", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listReviewsResponses: [
        {
          data: [
            { user: { login: "aliasunder" } },
            { user: { login: "umm-actually[bot]" } },
          ],
        },
      ],
    })
    const { client, logger } = makeClient(stub)

    const result = await client.hasPriorBotReview({ prNumber: 7 })

    expect(result).toBe(true)
    expect(stub.graphqlCalls).toEqual([{ query: "query { viewer { login } }" }])
    expect(stub.listReviewsCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        pull_number: 7,
        per_page: 100,
        page: 1,
      },
    ])
    expect(logger.messages).toContainEqual({
      level: "info",
      message: "found prior bot review",
      data: { prNumber: 7, botLogin: "umm-actually[bot]" },
    })
  })

  it("returns false when no review is by the bot, tolerating deleted-user reviews", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listReviewsResponses: [
        {
          data: [
            { user: { login: "aliasunder" } },
            { user: null },
            { user: { login: "sourcery-ai[bot]" } },
          ],
        },
      ],
    })
    const { client } = makeClient(stub)

    const result = await client.hasPriorBotReview({ prNumber: 7 })

    expect(result).toBe(false)
    expect(stub.listReviewsCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        pull_number: 7,
        per_page: 100,
        page: 1,
      },
    ])
  })

  it("matches when the viewer login already carries the [bot] suffix", async () => {
    // App installation tokens resolve viewer to the bot user itself — the
    // login must not be suffixed a second time.
    const stub = makeOctokitStub({
      graphqlResponses: [{ data: { viewer: { login: "umm-actually[bot]" } } }],
      listReviewsResponses: [
        { data: [{ user: { login: "umm-actually[bot]" } }] },
      ],
    })
    const { client } = makeClient(stub)

    const result = await client.hasPriorBotReview({ prNumber: 7 })

    expect(result).toBe(true)
  })

  it("paginates past a full page of non-bot reviews", async () => {
    const fullPage = Array.from({ length: 100 }, () => ({
      user: { login: "aliasunder" },
    }))
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listReviewsResponses: [
        { data: fullPage },
        { data: [{ user: { login: "umm-actually[bot]" } }] },
      ],
    })
    const { client } = makeClient(stub)

    const result = await client.hasPriorBotReview({ prNumber: 7 })

    expect(result).toBe(true)
    expect(stub.listReviewsCalls).toEqual([
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

  it("stops at the page cap and logs a warning", async () => {
    const fullPage = Array.from({ length: 100 }, () => ({
      user: { login: "aliasunder" },
    }))
    const responses = Array.from({ length: 10 }, () => ({ data: fullPage }))
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listReviewsResponses: responses,
    })
    const { client, logger } = makeClient(stub)

    const result = await client.hasPriorBotReview({ prNumber: 7 })

    expect(result).toBe(false)
    expect(stub.listReviewsCalls).toHaveLength(10)
    expect(logger.messages).toContainEqual({
      level: "warn",
      message: "reviews page cap reached",
      data: { prNumber: 7 },
    })
  })

  it("throws on a malformed response", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [viewerResponse],
      listReviewsResponses: [{ data: "not an array" }],
    })
    const { client } = makeClient(stub)

    await expect(client.hasPriorBotReview({ prNumber: 7 })).rejects.toThrow(
      "unexpected reviews response shape",
    )
  })

  it("propagates errors from the viewer query", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [{ error: new Error("token expired") }],
    })
    const { client } = makeClient(stub)

    await expect(client.hasPriorBotReview({ prNumber: 7 })).rejects.toThrow(
      "token expired",
    )
  })
})

describe("bot login memoization", () => {
  it("resolves the viewer query only once across requestBotReview and hasPriorBotReview", async () => {
    const stub = makeOctokitStub({
      graphqlResponses: [
        { data: { viewer: { login: "umm-actually" } } },
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
      listReviewsResponses: [{ data: [{ user: { login: "aliasunder" } }] }],
    })
    const { client } = makeClient(stub)

    await client.requestBotReview({ prNodeId: "PR_kwDOMock7" })
    const result = await client.hasPriorBotReview({ prNumber: 7 })

    expect(result).toBe(false)
    // Only two GraphQL calls: the viewer query (memoized) and the mutation.
    // A third call would mean the viewer query ran twice.
    expect(stub.graphqlCalls).toHaveLength(2)
    expect(stub.graphqlCalls[0]).toEqual({
      query: "query { viewer { login } }",
    })
    // hasPriorBotReview must have actually listed reviews — a short-circuited
    // false would leave this empty and still satisfy the assertions above.
    expect(stub.listReviewsCalls).toEqual([
      {
        owner: "aliasunder",
        repo: "fixture",
        pull_number: 7,
        per_page: 100,
        page: 1,
      },
    ])
  })
})

describe("upsertSummaryComment", () => {
  const commentUrl =
    "https://github.com/aliasunder/fixture/pull/7#issuecomment-1"
  const anchor = "<!-- umm-actually-rerun -->"
  const body = `${anchor}\n\n**umm-actually** re-reviewed`

  it("creates a new comment when no matching anchor exists", async () => {
    const stub = makeOctokitStub({
      listCommentsResponses: [
        {
          data: [
            { id: 99, body: "human comment", html_url: "https://example.com" },
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

  it("updates an existing comment when the anchor is found", async () => {
    const stub = makeOctokitStub({
      listCommentsResponses: [
        {
          data: [
            {
              id: 42,
              body: `${anchor}\n\nold summary`,
              html_url: commentUrl,
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
    }))
    const stub = makeOctokitStub({
      listCommentsResponses: [
        { data: fullPage },
        {
          data: [
            {
              id: 200,
              body: `${anchor}\n\nold summary`,
              html_url: commentUrl,
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
    expect(stub.listCommentsCalls).toHaveLength(2)
    expect(stub.updateCommentCalls).toEqual([
      { owner: "aliasunder", repo: "fixture", comment_id: 200, body },
    ])
  })

  it("throws on a malformed issue comments response", async () => {
    const stub = makeOctokitStub({
      listCommentsResponses: [{ data: "not an array" }],
    })
    const { client } = makeClient(stub)

    await expect(
      client.upsertSummaryComment({ prNumber: 7, body, anchor }),
    ).rejects.toThrow("unexpected issue comments response shape")
  })

  it("throws when the create response has no html_url", async () => {
    const stub = makeOctokitStub({
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
      listCommentsResponses: [
        {
          data: [
            {
              id: 42,
              body: `${anchor}\n\nold summary`,
              html_url: commentUrl,
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

  it("creates when the issue comments list is empty", async () => {
    const stub = makeOctokitStub({
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
