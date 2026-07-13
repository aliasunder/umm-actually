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
  rest: {
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

export type GithubClient = {
  fetchPullRequest: (params: { prNumber: number }) => Promise<PrContext>
  fetchDiff: (params: { prNumber: number }) => Promise<DiffFetchResult>
  submitReview: (params: {
    prNumber: number
    commitId: string
    body: string
    comments: ReviewComment[]
    /** Precomputed by the caller (pure code); posted body-only if GitHub
     *  rejects the inline anchors. */
    fallbackBody: string
  }) => Promise<SubmitReviewResult>
  fetchReviewComments: (params: {
    prNumber: number
  }) => Promise<{ path: string; body: string }[]>
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
  title: z.string(),
  body: z.string().nullable(),
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ ref: z.string() }),
})

const reviewUrlSchema = z.object({ html_url: z.string() })

const reviewCommentListSchema = z.array(
  z.object({ path: z.string(), body: z.string() }),
)

const issueCommentListSchema = z.array(
  z.object({
    id: z.int().positive(),
    body: z.string(),
    html_url: z.string(),
  }),
)

const issueCommentResponseSchema = z.object({ html_url: z.string() })

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
    const parsed = reviewUrlSchema.safeParse(data)
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

  const fetchReviewComments = async ({
    prNumber,
  }: {
    prNumber: number
  }): Promise<{ path: string; body: string }[]> => {
    const allComments: { path: string; body: string }[] = []

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
      allComments.push(...parsed.data)
      if (parsed.data.length < PER_PAGE) break
      if (page === MAX_PAGES) {
        logger.warn("review comments page cap reached", {
          prNumber,
          totalFetched: allComments.length,
        })
      }
    }

    logger.info("fetched review comments", {
      prNumber,
      count: allComments.length,
    })
    return allComments
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
    let existingComment: { id: number; html_url: string } | undefined
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
      existingComment = parsed.data.find((comment) =>
        comment.body.includes(anchor),
      )
      if (existingComment) break
      if (parsed.data.length < PER_PAGE) break
      if (page === MAX_PAGES) {
        logger.warn("issue comments page cap reached", {
          prNumber,
          totalFetched,
        })
      }
    }

    if (existingComment) {
      const response = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingComment.id,
        body,
      })
      const parsed = issueCommentResponseSchema.safeParse(response.data)
      if (!parsed.success) {
        throw new Error("unexpected issue comment response shape")
      }
      logger.info("updated summary comment", { prNumber })
      return { url: parsed.data.html_url, created: false }
    }

    const response = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    })
    const parsed = issueCommentResponseSchema.safeParse(response.data)
    if (!parsed.success) {
      throw new Error("unexpected issue comment response shape")
    }
    logger.info("created summary comment", { prNumber })
    return { url: parsed.data.html_url, created: true }
  }

  return {
    fetchPullRequest,
    fetchDiff,
    submitReview,
    fetchReviewComments,
    upsertSummaryComment,
  }
}
