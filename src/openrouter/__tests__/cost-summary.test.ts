import { describe, expect, it } from "vitest"
import { renderCostSummary, type PhaseAttempt } from "../cost-summary.js"

const acceptedAttempt: PhaseAttempt = {
  phase: "combined",
  model: "openai/gpt-5-mini",
  outcome: "accepted",
  promptTokens: 12000,
  completionTokens: 800,
  costUsd: 0.0421,
  errorSummary: null,
}

const tableHeader = [
  "| attempt | phase | model | outcome | prompt tokens | completion tokens | cost |",
  "| --- | --- | --- | --- | --- | --- | --- |",
]

describe("renderCostSummary", () => {
  it("renders a well-formed empty table for zero attempts", () => {
    const summary = renderCostSummary({
      attempts: [],
      modelUsed: "openai/gpt-5-mini",
    })

    expect(summary).toBe(
      [
        "### umm-actually cost summary",
        "",
        "Model used: openai/gpt-5-mini",
        "",
        ...tableHeader,
        "",
        "Total cost: n/a",
      ].join("\n"),
    )
  })

  it("renders a timeout attempt row verbatim with n/a cells", () => {
    const timeoutAttempt: PhaseAttempt = {
      phase: "combined",
      model: "openai/gpt-5-mini",
      outcome: "timeout",
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      errorSummary: "no response within 600s",
    }
    const summary = renderCostSummary({
      attempts: [timeoutAttempt, acceptedAttempt],
      modelUsed: "openai/gpt-5-mini",
    })

    expect(summary).toBe(
      [
        "### umm-actually cost summary",
        "",
        "Model used: openai/gpt-5-mini",
        "",
        ...tableHeader,
        "| 1 | combined | openai/gpt-5-mini | timeout | n/a | n/a | n/a |",
        "| 2 | combined | openai/gpt-5-mini | accepted | 12000 | 800 | $0.042100 |",
        "",
        "Total cost: $0.042100 (some attempts unpriced)",
      ].join("\n"),
    )
  })

  it("renders a single accepted attempt with its total", () => {
    const summary = renderCostSummary({
      attempts: [acceptedAttempt],
      modelUsed: "openai/gpt-5-mini",
    })

    expect(summary).toBe(
      [
        "### umm-actually cost summary",
        "",
        "Model used: openai/gpt-5-mini",
        "",
        ...tableHeader,
        "| 1 | combined | openai/gpt-5-mini | accepted | 12000 | 800 | $0.042100 |",
        "",
        "Total cost: $0.042100",
      ].join("\n"),
    )
  })

  it("renders n/a cells and flags a partially priced total", () => {
    const failedAttempt: PhaseAttempt = {
      phase: "combined",
      model: "openai/gpt-5-mini",
      outcome: "api_error",
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      errorSummary: "HTTP 500: boom",
    }

    const summary = renderCostSummary({
      attempts: [failedAttempt, acceptedAttempt],
      modelUsed: "openai/gpt-5-mini",
    })

    expect(summary).toBe(
      [
        "### umm-actually cost summary",
        "",
        "Model used: openai/gpt-5-mini",
        "",
        ...tableHeader,
        "| 1 | combined | openai/gpt-5-mini | api_error | n/a | n/a | n/a |",
        "| 2 | combined | openai/gpt-5-mini | accepted | 12000 | 800 | $0.042100 |",
        "",
        "Total cost: $0.042100 (some attempts unpriced)",
      ].join("\n"),
    )
  })

  it("sums costs across attempts when every attempt is priced", () => {
    const fallbackAttempt: PhaseAttempt = {
      phase: "combined",
      model: "anthropic/claude-haiku-4.5",
      outcome: "accepted",
      promptTokens: 11000,
      completionTokens: 600,
      costUsd: 0.01,
      errorSummary: null,
    }

    const summary = renderCostSummary({
      attempts: [
        { ...acceptedAttempt, outcome: "schema_mismatch" },
        fallbackAttempt,
      ],
      modelUsed: "anthropic/claude-haiku-4.5",
    })

    expect(summary).toBe(
      [
        "### umm-actually cost summary",
        "",
        "Model used: anthropic/claude-haiku-4.5",
        "",
        ...tableHeader,
        "| 1 | combined | openai/gpt-5-mini | schema_mismatch | 12000 | 800 | $0.042100 |",
        "| 2 | combined | anthropic/claude-haiku-4.5 | accepted | 11000 | 600 | $0.010000 |",
        "",
        "Total cost: $0.052100",
      ].join("\n"),
    )
  })

  it("renders attempts from several phases in the given order under a joined model line", () => {
    const summary = renderCostSummary({
      attempts: [
        { ...acceptedAttempt, phase: "correctness-security" },
        {
          ...acceptedAttempt,
          phase: "conventions-tests",
          model: "anthropic/claude-haiku-4.5",
          promptTokens: 11000,
          completionTokens: 600,
          costUsd: 0.01,
        },
        { ...acceptedAttempt, phase: "subtle-bugs" },
      ],
      modelUsed: "openai/gpt-5-mini, anthropic/claude-haiku-4.5",
    })

    expect(summary).toBe(
      [
        "### umm-actually cost summary",
        "",
        "Model used: openai/gpt-5-mini, anthropic/claude-haiku-4.5",
        "",
        ...tableHeader,
        "| 1 | correctness-security | openai/gpt-5-mini | accepted | 12000 | 800 | $0.042100 |",
        "| 2 | conventions-tests | anthropic/claude-haiku-4.5 | accepted | 11000 | 600 | $0.010000 |",
        "| 3 | subtle-bugs | openai/gpt-5-mini | accepted | 12000 | 800 | $0.042100 |",
        "",
        "Total cost: $0.094200",
      ].join("\n"),
    )
  })

  it("renders an n/a total when no attempt carries a cost", () => {
    const unpricedAttempt: PhaseAttempt = {
      ...acceptedAttempt,
      costUsd: null,
    }

    const summary = renderCostSummary({
      attempts: [unpricedAttempt],
      modelUsed: "openai/gpt-5-mini",
    })

    expect(summary).toBe(
      [
        "### umm-actually cost summary",
        "",
        "Model used: openai/gpt-5-mini",
        "",
        ...tableHeader,
        "| 1 | combined | openai/gpt-5-mini | accepted | 12000 | 800 | n/a |",
        "",
        "Total cost: n/a",
      ].join("\n"),
    )
  })
})
