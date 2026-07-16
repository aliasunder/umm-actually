import { z } from "zod"
import type { Logger } from "../logger.js"
import type { ReviewComment } from "../review/comment-mapping.js"
import type { PrContext } from "./event.js"

/**
 * Minimal structural type for injection — the real getOctokit() instance is
 * structurally compatible (compiler-enforced by an expectTypeOf test in
 * client.test.ts); test stubs are plain objects. `data: unknown` is
 * deliberate: it forces Zod parsing and makes the diff media type (which
 * returns a string, not JSON) legal without a cast. Method syntax keeps the
 * real octokit assignable under strictFunctionTypes.
 */
export type OctokitLike = {
  graphql<T = unknown>(
    query: string,
    parameters?: Record<string, unknown>,
  ): Promise<T>
  rest: {
    users: {
      getByUsername(params: { username: string }): Promise<{ data: unknown }>
    }
    pulls: {
      get(params: {
        owner: string
        repo: string
        pull_number: number
        mediaType?: { format: string }
      }): Promise<{ data: unknown }>
      createReview(params: {
        owner: string
        repo: string
        pull_number: number
        commit_id: string
        event: "COMMENT"
        body: string
        comments?: ReviewComment[]
      }): Promise<{ data: unknown }>
      listReviewComments(params: {
        owner: string
        repo: string
        pull_number: number
        per_page?: number
        page?: number
      }): Promise<{ data: unknown }>
      listReviews(params: {
        owner: string
        repo: string
        pull_number: number
        per_page?: number
        page?: number
      }): Promise<{ data: unknown }>
    }
    issues: {
      listComments(params: {
        owner: string
        repo: string
        issue_number: number
        per_page?: number
        page?: number
      }): Promise<{ data: unknown }>
      createComment(params: {
        owner: string
        repo: string
        issue_number: number
        body: string
      }): Promise<{ data: unknown }>
      updateComment(params: {
        owner: string
        repo: string
        comment_id: number
        body: string
      }): Promise<{ data: unknown }>
    }
  }
}
export type DiffFetchResult =
  { kind: "ok"; diff: string } | { kind: "too_large" }

export type SubmitReviewResult = { url: string; usedFallbackBody: boolean }

export type UpsertCommentResult = { url: string; created: boolean }

/** An existing inline review comment, with both positions GitHub tracks:
 *  `line` is the current spot on the latest diff (null once the comment goes
 *  outdated); `originalLine` is where it sat when posted. For multi-line
 *  comments both carry the START of the range — anchors embed the finding's
 *  `line`, which is the range start, so dedup must compare like with like
 *  (GitHub's own `line` field is the range END). */
export type ExistingReviewComment = {
  path: string
  body: string
  line: number | null
  originalLine: number | null
}

export type GithubClient = {
  fetchPullRequest: (params: { prNumber: number }) => Promise<PrContext>
  fetchDiff: (params: { prNumber: number }) => Promise<DiffFetchResult>
  requestBotReview: (params: { prNodeId: string }) => Promise<void>
  submitReview: (params: {
    prNumber: number
    commitId: string
    body: string
    comments: ReviewComment[]
    /** Precomputed by the caller (pure code); posted body-only if GitHub
     *  rejects the inline anchors. */
    fallbackBody: string
  }) => Promise<SubmitReviewResult>
  fetchBotReviewComments: (params: {
    prNumber: number
  }) => Promise<ExistingReviewComment[]>
  hasPriorBotReview: (params: { prNumber: number }) => Promise<boolean>
  upsertSummaryComment: (params: {
    prNumber: number
    body: string
    anchor: string
  }) => Promise<UpsertCommentResult>
}

/** The pullRequestEventSchema fields minus the event wrapper — what the REST
 *  pulls.get response must provide to build a PrContext. */
const prResponseSchema = z.object({
  number: z.int().positive(),
  node_id: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ ref: z.string() }),
})

const urlResponseSchema = z.object({ html_url: z.string() })

const reviewCommentListSchema = z.array(
  z.object({
    path: z.string(),
    body: z.string(),
    line: z.int().positive().nullish(),
    original_line: z.int().positive().nullish(),
    start_line: z.int().positive().nullish(),
    original_start_line: z.int().positive().nullish(),
    user: z.object({ login: z.string() }).nullable(),
  }),
)

const reviewListSchema = z.array(
  z.object({ user: z.object({ login: z.string() }).nullable() }),
)

const issueCommentListSchema = z.array(
  z.object({
    id: z.int().positive(),
    body: z.string(),
    html_url: z.string(),
  }),
)

/** Octokit request errors carry a numeric `status` — duck-typed so stubs and
 *  future octokit versions need no instanceof on octokit internals. */
const errorStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  if (!("status" in error) || typeof error.status !== "number") return undefined
  return error.status
}

export const createGithubClient = (
  {
    octokit,
    owner,
    repo,
  }: { octokit: OctokitLike; owner: string; repo: string },
  logger: Logger,
): GithubClient => {
  const MAX_PAGES = 10
  const PER_PAGE = 100

  const parseReviewUrl = (data: unknown): string => {
    const parsed = urlResponseSchema.safeParse(data)
    if (!parsed.success) throw new Error("unexpected review response shape")
    return parsed.data.html_url
  }

  const fetchPullRequest = async ({
    prNumber,
  }: {
    prNumber: number
  }): Promise<PrContext> => {
    const response = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    })
    const parsed = prResponseSchema.safeParse(response.data)
    if (!parsed.success) {
      throw new Error("unexpected pull request response shape")
    }
    const pullRequest = parsed.data
    return {
      prNumber: pullRequest.number,
      nodeId: pullRequest.node_id,
      title: pullRequest.title,
      body: pullRequest.body,
      headSha: pullRequest.head.sha,
      headRef: pullRequest.head.ref,
      baseRef: pullRequest.base.ref,
    }
  }

  const fetchDiff = async ({
    prNumber,
  }: {
    prNumber: number
  }): Promise<DiffFetchResult> => {
    try {
      const response = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
        mediaType: { format: "diff" },
      })
      if (typeof response.data !== "string") {
        throw new Error(
          "expected a unified diff string from the diff media type",
        )
      }
      return { kind: "ok", diff: response.data }
    } catch (fetchError) {
      // GitHub answers 406 when the diff exceeds its API limits (>300 files or >20k lines)
      if (errorStatus(fetchError) === 406) {
        logger.warn("diff exceeds GitHub's diff API limits", { prNumber })
        return { kind: "too_large" }
      }
      throw fetchError
    }
  }

  const botNodeIdSchema = z.object({
    node_id: z.string().min(1),
    login: z.string().min(1),
    type: z.literal("Bot"),
  })

  /** The token identity's login — the author of everything this client
   *  posts. Memoized: the login never changes within a run, and every method
   *  comparing or resolving authorship needs it. App installation tokens
   *  resolve `viewer` to a Bot whose login usually already carries the
   *  `[bot]` suffix — append it only when absent, or the lookup targets a
   *  nonexistent `<slug>[bot][bot]` user. User tokens (PATs) post as the
   *  user, so their login gets no suffix at all. */
  let botLoginCache: string | undefined
  const resolveBotLogin = async (): Promise<string> => {
    if (botLoginCache) return botLoginCache
    const viewer = await octokit.graphql<{
      viewer: { login: string; __typename: string }
    }>("query { viewer { login __typename } }")
    const { login, __typename } = viewer.viewer
    botLoginCache =
      __typename === "Bot" && !login.endsWith("[bot]") ? `${login}[bot]` : login
    return botLoginCache
  }

  const requestBotReview = async ({
    prNodeId,
  }: {
    prNodeId: string
  }): Promise<void> => {
    const botLogin = await resolveBotLogin()

    const response = await octokit.rest.users.getByUsername({
      username: botLogin,
    })
    const parsed = botNodeIdSchema.safeParse(response.data)
    if (!parsed.success) {
      logger.warn("could not resolve bot user for review request", { botLogin })
      return
    }

    await octokit.graphql(
      `mutation($prId: ID!, $botIds: [ID!]!) {
        requestReviews(input: { pullRequestId: $prId, botIds: $botIds }) {
          pullRequest { id }
        }
      }`,
      { prId: prNodeId, botIds: [parsed.data.node_id] },
    )
    logger.info("requested bot review", { login: parsed.data.login })
  }

  const submitReview = async ({
    prNumber,
    commitId,
    body,
    comments,
    fallbackBody,
  }: {
    prNumber: number
    commitId: string
    body: string
    comments: ReviewComment[]
    fallbackBody: string
  }): Promise<SubmitReviewResult> => {
    try {
      const response = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitId,
        event: "COMMENT",
        body,
        ...(comments.length > 0 ? { comments } : {}),
      })
      return { url: parseReviewUrl(response.data), usedFallbackBody: false }
    } catch (submitError) {
      // GitHub answers 422 when an inline anchor is not part of the diff —
      // e.g. a force-push racing the run. Only that case gets the body-only
      // retry; a 422 on a zero-comment review is a different bug and rethrows.
      const inlineAnchorsRejected =
        comments.length > 0 && errorStatus(submitError) === 422
      if (!inlineAnchorsRejected) throw submitError

      logger.warn(
        "inline comments rejected (422) — posting body-only fallback",
        {
          prNumber,
          rejectedCommentCount: comments.length,
        },
      )
      const response = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitId,
        event: "COMMENT",
        body: fallbackBody,
      })
      return { url: parseReviewUrl(response.data), usedFallbackBody: true }
    }
  }

  /** Only the bot's own comments count: anchors drive dedup, and anyone can
   *  paste an `<!-- umm-actually:... -->` marker into a comment — without the
   *  author filter that would silently suppress a real future finding. */
  const fetchBotReviewComments = async ({
    prNumber,
  }: {
    prNumber: number
  }): Promise<ExistingReviewComment[]> => {
    const botLogin = await resolveBotLogin()
    const allComments: ExistingReviewComment[] = []

    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber,
        per_page: PER_PAGE,
        page,
      })
      const parsed = reviewCommentListSchema.safeParse(response.data)
      if (!parsed.success) {
        throw new Error("unexpected review comments response shape")
      }
      allComments.push(
        ...parsed.data
          .filter((comment) => comment.user?.login === botLogin)
          .map((comment) => ({
            path: comment.path,
            body: comment.body,
            line: comment.start_line ?? comment.line ?? null,
            originalLine:
              comment.original_start_line ?? comment.original_line ?? null,
          })),
      )
      if (parsed.data.length < PER_PAGE) break
      if (page === MAX_PAGES) {
        logger.warn("review comments page cap reached", {
          prNumber,
          totalFetched: allComments.length,
        })
      }
    }

    logger.info("fetched bot review comments", {
      prNumber,
      count: allComments.length,
    })
    return allComments
  }

  /** Whether this bot has already posted any review on the PR — the re-run
   *  signal. Inline anchors can't serve here: zero-findings and body-only
   *  first runs leave none. */
  const hasPriorBotReview = async ({
    prNumber,
  }: {
    prNumber: number
  }): Promise<boolean> => {
    const botLogin = await resolveBotLogin()

    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: prNumber,
        per_page: PER_PAGE,
        page,
      })
      const parsed = reviewListSchema.safeParse(response.data)
      if (!parsed.success) {
        throw new Error("unexpected reviews response shape")
      }
      if (parsed.data.some((review) => review.user?.login === botLogin)) {
        logger.info("found prior bot review", { prNumber, botLogin })
        return true
      }
      if (parsed.data.length < PER_PAGE) break
      if (page === MAX_PAGES) {
        logger.warn("reviews page cap reached", { prNumber })
      }
    }

    return false
  }

  const upsertSummaryComment = async ({
    prNumber,
    body,
    anchor,
  }: {
    prNumber: number
    body: string
    anchor: string
  }): Promise<UpsertCommentResult> => {
    let totalFetched = 0

    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: PER_PAGE,
        page,
      })
      const parsed = issueCommentListSchema.safeParse(response.data)
      if (!parsed.success) {
        throw new Error("unexpected issue comments response shape")
      }
      totalFetched += parsed.data.length

      const existingComment = parsed.data.find((comment) =>
        comment.body.includes(anchor),
      )
      if (existingComment) {
        const updateResponse = await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existingComment.id,
          body,
        })
        const updateParsed = urlResponseSchema.safeParse(updateResponse.data)
        if (!updateParsed.success) {
          throw new Error("unexpected issue comment response shape")
        }
        logger.info("updated summary comment", { prNumber })
        return { url: updateParsed.data.html_url, created: false }
      }

      if (parsed.data.length < PER_PAGE) break
      if (page === MAX_PAGES) {
        logger.warn("issue comments page cap reached", {
          prNumber,
          totalFetched,
        })
      }
    }

    const response = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    })
    const parsed = urlResponseSchema.safeParse(response.data)
    if (!parsed.success) {
      throw new Error("unexpected issue comment response shape")
    }
    logger.info("created summary comment", { prNumber })
    return { url: parsed.data.html_url, created: true }
  }

  return {
    fetchPullRequest,
    fetchDiff,
    requestBotReview,
    submitReview,
    fetchBotReviewComments,
    hasPriorBotReview,
    upsertSummaryComment,
  }
}
