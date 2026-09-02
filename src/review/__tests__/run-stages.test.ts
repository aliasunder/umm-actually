import { describe, expect, it } from "vitest"
import { createTestLogger } from "../../__tests__/test-logger.js"
import type { StructuredReviewResult } from "../../openrouter/client.js"
import type { Finding } from "../finding.js"
import type { ReviewPhase } from "../phases.js"
import { runStages, type RunPhase } from "../run-stages.js"
import { makeFinding } from "./make-finding.js"

const makePhase = (id: string): ReviewPhase => ({
  id,
  instructionSections: [`instructions for ${id}`],
})

const makeResult = (
  overrides: Partial<StructuredReviewResult> = {},
): StructuredReviewResult => ({
  review: { analysis: "", findings: [] },
  modelUsed: "test/model",
  attempts: [],
  ...overrides,
})

type RecordedCall = { phase: string; priorFindings: Finding[] }

/** A runPhase stub answering each phase id from a fixed table; records
 *  every call so dispatch order and prior findings can be asserted whole. */
const makeRunPhase = (
  responses: Record<
    string,
    () => Promise<StructuredReviewResult> | StructuredReviewResult
  >,
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

const captureRejection = async (
  pending: Promise<unknown>,
): Promise<unknown> => {
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
  it("dispatches a stage's phases together with empty prior findings and returns outcomes in phase order", async () => {
    const resultA = makeResult({ modelUsed: "model/a" })
    const resultB = makeResult({ modelUsed: "model/b" })
    const deferredA = Promise.withResolvers<StructuredReviewResult>()
    const { runPhase, calls } = makeRunPhase({
      a: () => deferredA.promise,
      b: () => resultB,
    })

    const pending = runStages(
      { stages: [[phaseA, phaseB]], runPhase },
      createTestLogger(),
    )
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

    await runStages(
      { stages: [[phaseA], [phaseB], [phaseC]], runPhase },
      createTestLogger(),
    )

    expect(calls).toEqual([
      { phase: "a", priorFindings: [] },
      { phase: "b", priorFindings: [findingA] },
      { phase: "c", priorFindings: [findingA, findingB] },
    ])
  })

  it("keeps a sibling's result when one phase in the stage fails", async () => {
    const resultA = makeResult()
    const failure = new Error("model exploded")
    const { runPhase } = makeRunPhase({
      a: () => resultA,
      b: () => Promise.reject(failure),
    })

    const outcomes = await runStages(
      { stages: [[phaseA, phaseB]], runPhase },
      createTestLogger(),
    )

    expect(outcomes).toEqual([
      { phase: phaseA, status: "completed", result: resultA },
      { phase: phaseB, status: "failed", error: failure },
    ])
  })

  it("rethrows the only failure unchanged when nothing completed", async () => {
    const failure = new Error("model exploded")
    const { runPhase } = makeRunPhase({ a: () => Promise.reject(failure) })

    const rejection = await captureRejection(
      runStages({ stages: [[phaseA]], runPhase }, createTestLogger()),
    )

    expect(rejection).toBe(failure)
  })

  it("aggregates every failure into one message when nothing completed", async () => {
    const { runPhase } = makeRunPhase({
      a: () => Promise.reject(new Error("boom a")),
      b: () => Promise.reject(new Error("boom b")),
    })

    await expect(
      runStages({ stages: [[phaseA], [phaseB]], runPhase }, createTestLogger()),
    ).rejects.toThrow(
      "all 2 review phases failed: a: [Error]: boom a; b: [Error]: boom b",
    )
  })

  it("skips later stages after an auth/credit abort and reports their phases as not attempted", async () => {
    const resultA = makeResult()
    const abort = Object.assign(new Error("HTTP 401"), { aborted: true })
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
        error: new Error(
          "not attempted: an earlier phase aborted on an auth/credit error",
        ),
      },
    ])
  })

  it("does not skip later stages after an ordinary failure", async () => {
    const resultC = makeResult()
    const { runPhase, calls } = makeRunPhase({
      a: () => Promise.reject(new Error("HTTP 500")),
      c: () => resultC,
    })

    const outcomes = await runStages(
      { stages: [[phaseA], [phaseC]], runPhase },
      createTestLogger(),
    )

    expect(calls.map((call) => call.phase)).toEqual(["a", "c"])
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "failed",
      "completed",
    ])
  })

  it.each([
    { label: "no stages", stages: [] },
    { label: "an empty stage", stages: [[phaseA], []] },
  ])("throws before any call for $label", async ({ stages }) => {
    const { runPhase, calls } = makeRunPhase({ a: () => makeResult() })

    await expect(
      runStages({ stages, runPhase }, createTestLogger()),
    ).rejects.toThrow("no review phases to run")
    expect(calls).toEqual([])
  })

  it("logs each phase's completion or failure under its id", async () => {
    const logger = createTestLogger()
    const findingA = makeFinding()
    const { runPhase } = makeRunPhase({
      a: () =>
        makeResult({
          review: { analysis: "", findings: [findingA] },
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
        }),
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
          attemptCount: 1,
          findingsCount: 1,
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
