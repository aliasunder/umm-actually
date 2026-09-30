import { describe, expect, it } from "vitest"
import { createTestLogger, logsWithMessage } from "../../__tests__/test-logger.js"
import type { StructuredReviewResult } from "../../openrouter/client.js"
import type { Finding } from "../finding.js"
import type { ReviewPhase } from "../phases.js"
import { AllPhasesFailedError, runStages as dispatchStages, type RunPhase } from "../run-stages.js"
import { makeFinding } from "./make-finding.js"

const runStages = (
  params: Omit<Parameters<typeof dispatchStages>[0], "remainingReviewMs"> & {
    remainingReviewMs?: () => number
  },
  logger: Parameters<typeof dispatchStages>[1],
) => {
  return dispatchStages({ remainingReviewMs: () => Infinity, ...params }, logger)
}

const makePhase = (id: string): ReviewPhase => {
  return { id, instructionSections: [`instructions for ${id}`] }
}

const makeResult = (overrides: Partial<StructuredReviewResult> = {}): StructuredReviewResult => {
  return {
    review: { analysis: "", findings: [] },
    modelUsed: "test/model",
    attempts: [],
    ...overrides,
  }
}

type RecordedCall = { phase: string; priorFindings: Finding[] }

/** A runPhase stub answering each phase id from a fixed table; records
 *  every call so dispatch order and prior findings can be asserted whole. */
const makeRunPhase = (
  responses: Record<string, () => Promise<StructuredReviewResult> | StructuredReviewResult>,
) => {
  const calls: RecordedCall[] = []
  const runPhase: RunPhase = async ({ phase, priorFindings }) => {
    calls.push({ phase: phase.id, priorFindings })
    const respond = responses[phase.id]

    if (!respond) throw new Error(`stub: no response for phase ${phase.id}`)
    return respond()
  }
  return { runPhase, calls }
}

const captureRejection = async (pending: Promise<unknown>): Promise<unknown> => {
  try {
    await pending
    return undefined
  } catch (error) {
    return error
  }
}

const phaseA = makePhase("a")
const phaseB = makePhase("b")
const phaseC = makePhase("c")

describe("runStages", () => {
  it("does not invoke any phase when the review deadline has already expired", async () => {
    const { runPhase, calls } = makeRunPhase({})
    const rejection = await captureRejection(
      runStages(
        { stages: [[phaseA], [phaseB]], runPhase, remainingReviewMs: () => 0 },
        createTestLogger(),
      ),
    )
    expect(calls).toEqual([])
    expect(rejection).toBeInstanceOf(AllPhasesFailedError)
    if (!(rejection instanceof AllPhasesFailedError)) throw new Error("expected phase failure")
    expect(rejection.outcomes).toEqual(
      [phaseA, phaseB].map((phase) => ({
        phase,
        status: "failed",
        error: new Error("not attempted: review deadline exceeded"),
        deadlineExceeded: true,
      })),
    )
  })

  it("keeps a completed stage and skips later stages when the review deadline expires", async () => {
    const budget = { remaining: 100 }
    const result = makeResult()
    const { runPhase, calls } = makeRunPhase({
      a: () => {
        budget.remaining = 0
        return result
      },
    })
    const outcomes = await runStages(
      {
        stages: [[phaseA], [phaseB], [phaseC]],
        runPhase,
        remainingReviewMs: () => budget.remaining,
      },
      createTestLogger(),
    )
    expect(calls).toEqual([{ phase: "a", priorFindings: [] }])
    expect(outcomes).toEqual([
      { phase: phaseA, status: "completed", result },
      ...[phaseB, phaseC].map((phase) => ({
        phase,
        status: "failed",
        error: new Error("not attempted: review deadline exceeded"),
        deadlineExceeded: true,
      })),
    ])
  })

  it("propagates deadlineExceeded from a phase error to the outcome", async () => {
    const resultA = makeResult()
    const deadlineError = Object.assign(new Error("review deadline exceeded"), {
      deadlineExceeded: true,
    })
    const { runPhase } = makeRunPhase({
      a: () => resultA,
      b: () => Promise.reject(deadlineError),
    })

    const outcomes = await runStages({ stages: [[phaseA, phaseB]], runPhase }, createTestLogger())

    expect(outcomes).toEqual([
      { phase: phaseA, status: "completed", result: resultA },
      {
        phase: phaseB,
        status: "failed",
        error: deadlineError,
        deadlineExceeded: true,
      },
    ])
  })

  it("dispatches a stage's phases together with empty prior findings and returns outcomes in phase order", async () => {
    const resultA = makeResult({ modelUsed: "model/a" })
    const resultB = makeResult({ modelUsed: "model/b" })
    const deferredA = Promise.withResolvers<StructuredReviewResult>()
    const { runPhase, calls } = makeRunPhase({
      a: () => deferredA.promise,
      b: () => resultB,
    })

    const pending = runStages({ stages: [[phaseA, phaseB]], runPhase }, createTestLogger())
    // Both phases were called before the first one settled
    expect(calls).toEqual([
      { phase: "a", priorFindings: [] },
      { phase: "b", priorFindings: [] },
    ])
    deferredA.resolve(resultA)

    expect(await pending).toEqual([
      { phase: phaseA, status: "completed", result: resultA },
      { phase: phaseB, status: "completed", result: resultB },
    ])
  })

  it("passes every earlier stage's raw findings to the next stage", async () => {
    const findingA = makeFinding({ title: "From a" })
    const findingB = makeFinding({ title: "From b", line: 20 })
    const { runPhase, calls } = makeRunPhase({
      a: () => makeResult({ review: { analysis: "", findings: [findingA] } }),
      b: () => makeResult({ review: { analysis: "", findings: [findingB] } }),
      c: () => makeResult(),
    })

    await runStages({ stages: [[phaseA], [phaseB], [phaseC]], runPhase }, createTestLogger())

    expect(calls).toEqual([
      { phase: "a", priorFindings: [] },
      { phase: "b", priorFindings: [findingA] },
      { phase: "c", priorFindings: [findingA, findingB] },
    ])
  })

  it("drops non-findings before threading them to the next stage", async () => {
    const realFinding = makeFinding({ title: "Real defect" })
    const nonFinding = makeFinding({
      line: 20,
      title: "N/A — the guard is correct",
    })
    const { runPhase, calls } = makeRunPhase({
      a: () => makeResult({ review: { analysis: "", findings: [realFinding, nonFinding] } }),
      b: () => makeResult(),
    })

    await runStages({ stages: [[phaseA], [phaseB]], runPhase }, createTestLogger())

    expect(calls).toEqual([
      { phase: "a", priorFindings: [] },
      { phase: "b", priorFindings: [realFinding] },
    ])
  })

  it("keeps a sibling's result when one phase in the stage fails", async () => {
    const resultA = makeResult()
    const failure = new Error("model exploded")
    const { runPhase } = makeRunPhase({
      a: () => resultA,
      b: () => Promise.reject(failure),
    })

    const outcomes = await runStages({ stages: [[phaseA, phaseB]], runPhase }, createTestLogger())

    expect(outcomes).toEqual([
      { phase: phaseA, status: "completed", result: resultA },
      { phase: phaseB, status: "failed", error: failure },
    ])
  })

  it("throws an error carrying the outcomes when the only phase fails", async () => {
    const failure = new Error("model exploded")
    const { runPhase } = makeRunPhase({ a: () => Promise.reject(failure) })

    const rejection = await captureRejection(
      runStages({ stages: [[phaseA]], runPhase }, createTestLogger()),
    )

    if (!(rejection instanceof AllPhasesFailedError)) {
      throw new Error("expected an AllPhasesFailedError")
    }
    expect(rejection.message).toBe("every review phase failed: a: [Error]: model exploded")
    expect(rejection.outcomes).toEqual([{ phase: phaseA, status: "failed", error: failure }])
  })

  it("names every failure in the message when nothing completed", async () => {
    const { runPhase } = makeRunPhase({
      a: () => Promise.reject(new Error("boom a")),
      b: () => Promise.reject(new Error("boom b")),
    })

    await expect(
      runStages({ stages: [[phaseA], [phaseB]], runPhase }, createTestLogger()),
    ).rejects.toThrow("every review phase failed: a: [Error]: boom a; b: [Error]: boom b")
  })

  it("skips later stages after an auth/credit abort and reports their phases as not attempted", async () => {
    const resultA = makeResult()
    const abort = Object.assign(new Error("HTTP 401"), { keyRejected: true })
    const { runPhase, calls } = makeRunPhase({
      a: () => resultA,
      b: () => Promise.reject(abort),
      c: () => makeResult(),
    })

    const outcomes = await runStages(
      { stages: [[phaseA, phaseB], [phaseC]], runPhase },
      createTestLogger(),
    )

    expect(calls.map((call) => call.phase)).toEqual(["a", "b"])
    expect(outcomes).toEqual([
      { phase: phaseA, status: "completed", result: resultA },
      { phase: phaseB, status: "failed", error: abort },
      {
        phase: phaseC,
        status: "failed",
        error: new Error("not attempted: an earlier phase aborted on an auth/credit error"),
      },
    ])
  })

  it("names the skipped phases in a warning after a key rejection", async () => {
    const logger = createTestLogger()
    const keyRejection = Object.assign(new Error("HTTP 402"), { keyRejected: true })
    const { runPhase } = makeRunPhase({
      a: () => Promise.reject(keyRejection),
    })

    await captureRejection(runStages({ stages: [[phaseA], [phaseB], [phaseC]], runPhase }, logger))

    expect(
      logsWithMessage(logger, "skipping remaining review stages after an auth/credit abort"),
    ).toEqual([
      {
        level: "warn",
        message: "skipping remaining review stages after an auth/credit abort",
        data: { skippedPhases: ["b", "c"] },
      },
    ])
  })

  it.each([
    { label: "an ordinary failure", failure: new Error("HTTP 500") },
    // The client sets keyRejected on every error it throws, so only its value
    // may decide the skip
    {
      label: "a failure with keyRejected: false",
      failure: Object.assign(new Error("HTTP 500"), { keyRejected: false }),
    },
  ])("does not skip later stages after $label", async ({ failure }) => {
    const resultC = makeResult()
    const { runPhase, calls } = makeRunPhase({
      a: () => Promise.reject(failure),
      c: () => resultC,
    })

    const outcomes = await runStages({ stages: [[phaseA], [phaseC]], runPhase }, createTestLogger())

    expect(calls.map((call) => call.phase)).toEqual(["a", "c"])
    expect(outcomes).toEqual([
      { phase: phaseA, status: "failed", error: failure },
      { phase: phaseC, status: "completed", result: resultC },
    ])
  })

  it.each([
    { label: "no stages", stages: [] },
    { label: "an empty stage", stages: [[phaseA], []] },
  ])("throws before any call for $label", async ({ stages }) => {
    const { runPhase, calls } = makeRunPhase({ a: () => makeResult() })

    await expect(runStages({ stages, runPhase }, createTestLogger())).rejects.toThrow(
      "no review phases to run",
    )
    expect(calls).toEqual([])
  })

  it("logs each phase's completion or failure under its id, with a completed phase's analysis at debug", async () => {
    const logger = createTestLogger()
    const findingA = makeFinding()
    const { runPhase } = makeRunPhase({
      a: () => {
        return makeResult({
          review: {
            analysis: 'Guard the empty name — src/greeter.ts: "return name.trim()"',
            findings: [findingA],
          },
          modelUsed: "model/a",
          attempts: [
            {
              model: "model/a",
              outcome: "accepted",
              promptTokens: 1,
              completionTokens: 1,
              costUsd: null,
              errorSummary: null,
            },
          ],
        })
      },
      b: () => Promise.reject(new Error("boom")),
    })

    await runStages({ stages: [[phaseA, phaseB]], runPhase }, logger)

    expect(logger.messages).toEqual([
      {
        level: "info",
        message: "review phase completed",
        data: {
          phase: "a",
          modelUsed: "model/a",
          totalAttemptCount: 1,
          findingsCount: 1,
        },
      },
      {
        level: "debug",
        message: "review phase analysis",
        data: {
          phase: "a",
          analysis: 'Guard the empty name — src/greeter.ts: "return name.trim()"',
        },
      },
      {
        level: "warn",
        message: "review phase failed",
        data: { phase: "b", error: "[Error]: boom" },
      },
    ])
  })
})
