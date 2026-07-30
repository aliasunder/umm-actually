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
    checks: {
      create(params: {
        owner: string
        repo: string
        name: string
        head_sha: string
        status: "in_progress"
      }): Promise<{ data: unknown }>
      update(params: {
        owner: string
        repo: string
        check_run_id: number
        status: "completed"
        conclusion: CheckRunConclusion
        output: CheckRunOutput
      }): Promise<{ data: unknown }>
    }
  }
}

/** The check never gates merge: findings and skips conclude `neutral`,
 *  `failure` is reserved for the pipeline itself erroring. */
export type CheckRunConclusion = "success" | "neutral" | "failure"

export type CheckRunOutput = { title: string; summary: string }

export type DiffFetchResult =
  { kind: "ok"; diff: string } | { kind: "too_large" }

export type SubmitReviewResult = { url: string }

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

/** Outcome of posting the inline-findings review: `rejected` is GitHub's
 *  422 on the comment anchors — the caller falls back to issue comments. */
export type FindingsReviewResult =
  { kind: "ok"; url: string } | { kind: "rejected" }

export type GithubClient = {
  fetchPullRequest: (params: { prNumber: number }) => Promise<PrContext>
  fetchDiff: (params: { prNumber: number }) => Promise<DiffFetchResult>
  submitReview: (params: {
    prNumber: number
    commitId: string
    body: string
  }) => Promise<SubmitReviewResult>
  postFindingsReview: (params: {
    prNumber: number
    commitId: string
    body: string
    comments: ReviewComment[]
  }) => Promise<FindingsReviewResult>
  postIssueComment: (params: {
    prNumber: number
    body: string
  }) => Promise<{ url: string }>
  fetchBotReviewComments: (params: {
    prNumber: number
  }) => Promise<ExistingReviewComment[]>
  fetchBotIssueComments: (params: {
    prNumber: number
  }) => Promise<{ body: string }[]>
  upsertSummaryComment: (params: {
    prNumber: number
    body: string
    anchor: string
  }) => Promise<UpsertCommentResult>
  createCheckRun: (params: {
    headSha: string
    name: string
  }) => Promise<{ checkRunId: number }>
  updateCheckRun: (params: {
    checkRunId: number
    conclusion: CheckRunConclusion
    output: CheckRunOutput
  }) => Promise<void>
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

const checkRunResponseSchema = z.object({ id: z.int().positive() })

const issueCommentListSchema = z.array(
  z.object({
    id: z.int().positive(),
    body: z.string(),
    html_url: z.string(),
    user: z.object({ login: z.string() }).nullable(),
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

  /** Body-only review — the vehicle for skip notices. */
  const submitReview = async ({
    prNumber,
    commitId,
    body,
  }: {
    prNumber: number
    commitId: string
    body: string
  }): Promise<SubmitReviewResult> => {
    const response = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitId,
      event: "COMMENT",
      body,
    })
    return { url: parseReviewUrl(response.data) }
  }

  /** The inline-findings batch: one review carrying every anchorable
   *  finding, body kept to the caller's invisible marker so the timeline
   *  shows a bare "reviewed" event. GitHub answers 422 when an anchor is
   *  not part of the diff — e.g. a force-push racing the run — reported as
   *  `rejected` so the caller can re-route the findings to issue comments. */
  const postFindingsReview = async ({
    prNumber,
    commitId,
    body,
    comments,
  }: {
    prNumber: number
    commitId: string
    body: string
    comments: ReviewComment[]
  }): Promise<FindingsReviewResult> => {
    try {
      const response = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitId,
        event: "COMMENT",
        body,
        comments,
      })
      return { kind: "ok", url: parseReviewUrl(response.data) }
    } catch (submitError) {
      if (errorStatus(submitError) !== 422) throw submitError
      logger.warn("inline comment anchors rejected (422)", {
        prNumber,
        rejectedCommentCount: comments.length,
      })
      return { kind: "rejected" }
    }
  }

  const postIssueComment = async ({
    prNumber,
    body,
  }: {
    prNumber: number
    body: string
  }): Promise<{ url: string }> => {
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
    return { url: parsed.data.html_url }
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

  /** The bot's own issue comments on the PR — the status comment plus any
   *  beyond-diff finding comments. One listing serves both the run signal
   *  and the beyond-diff dedup anchors. Author-filtered for the same reason
   *  as fetchBotReviewComments: anyone can paste an anchor marker. */
  const fetchBotIssueComments = async ({
    prNumber,
  }: {
    prNumber: number
  }): Promise<{ body: string }[]> => {
    const botLogin = await resolveBotLogin()
    const allComments: { body: string }[] = []

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
      allComments.push(
        ...parsed.data
          .filter((comment) => comment.user?.login === botLogin)
          .map((comment) => ({ body: comment.body })),
      )
      if (parsed.data.length < PER_PAGE) break
      if (page === MAX_PAGES) {
        logger.warn("issue comments page cap reached", { prNumber })
      }
    }

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
    // Only the bot's own comment is an update target — a pasted anchor from
    // another author must not hijack the receipt (the edit would 403 anyway;
    // bots can't modify other users' comments). The anchor must open the
    // body: finding comments carry model-generated text that could quote the
    // marker mid-body, and matching one would overwrite the finding.
    const botLogin = await resolveBotLogin()
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

      const existingComment = parsed.data.find(
        (comment) =>
          comment.user?.login === botLogin && comment.body.startsWith(anchor),
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

  /** Opens the check run under the token's App identity, which is what puts
   *  the app avatar on the checks list instead of the generic Actions logo.
   *  Requires `checks: write` on the token — callers treat a rejection as
   *  a degradation, not a review failure. */
  const createCheckRun = async ({
    headSha,
    name,
  }: {
    headSha: string
    name: string
  }): Promise<{ checkRunId: number }> => {
    const response = await octokit.rest.checks.create({
      owner,
      repo,
      name,
      head_sha: headSha,
      status: "in_progress",
    })
    const parsed = checkRunResponseSchema.safeParse(response.data)
    if (!parsed.success) {
      throw new Error("unexpected check run response shape")
    }
    return { checkRunId: parsed.data.id }
  }

  /** Marks the check run as completed with a conclusion and details page. */
  const updateCheckRun = async ({
    checkRunId,
    conclusion,
    output,
  }: {
    checkRunId: number
    conclusion: CheckRunConclusion
    output: CheckRunOutput
  }): Promise<void> => {
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      status: "completed",
      conclusion,
      output,
    })
  }

  return {
    fetchPullRequest,
    fetchDiff,
    submitReview,
    postFindingsReview,
    postIssueComment,
    fetchBotReviewComments,
    fetchBotIssueComments,
    upsertSummaryComment,
    createCheckRun,
    updateCheckRun,
  }
}
