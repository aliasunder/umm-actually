import { describe, expect, it } from "vitest"
import type { ModelAttempt } from "../client.js"
import { renderCostSummary } from "../cost-summary.js"

const acceptedAttempt: ModelAttempt = {
  model: "openai/gpt-5-mini",
  outcome: "accepted",
  promptTokens: 12000,
  completionTokens: 800,
  costUsd: 0.0421,
  errorSummary: null,
}

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
        "| attempt | model | outcome | prompt tokens | completion tokens | cost |",
        "| --- | --- | --- | --- | --- | --- |",
        "",
        "Total cost: n/a",
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
        "| attempt | model | outcome | prompt tokens | completion tokens | cost |",
        "| --- | --- | --- | --- | --- | --- |",
        "| 1 | openai/gpt-5-mini | accepted | 12000 | 800 | $0.042100 |",
        "",
        "Total cost: $0.042100",
      ].join("\n"),
    )
  })

  it("renders n/a cells and flags a partially priced total", () => {
    const failedAttempt: ModelAttempt = {
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
        "| attempt | model | outcome | prompt tokens | completion tokens | cost |",
        "| --- | --- | --- | --- | --- | --- |",
        "| 1 | openai/gpt-5-mini | api_error | n/a | n/a | n/a |",
        "| 2 | openai/gpt-5-mini | accepted | 12000 | 800 | $0.042100 |",
        "",
        "Total cost: $0.042100 (some attempts unpriced)",
      ].join("\n"),
    )
  })

  it("sums costs across attempts when every attempt is priced", () => {
    const fallbackAttempt: ModelAttempt = {
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
        "| attempt | model | outcome | prompt tokens | completion tokens | cost |",
        "| --- | --- | --- | --- | --- | --- |",
        "| 1 | openai/gpt-5-mini | schema_mismatch | 12000 | 800 | $0.042100 |",
        "| 2 | anthropic/claude-haiku-4.5 | accepted | 11000 | 600 | $0.010000 |",
        "",
        "Total cost: $0.052100",
      ].join("\n"),
    )
  })

  it("renders an n/a total when no attempt carries a cost", () => {
    const unpricedAttempt: ModelAttempt = {
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
        "| attempt | model | outcome | prompt tokens | completion tokens | cost |",
        "| --- | --- | --- | --- | --- | --- |",
        "| 1 | openai/gpt-5-mini | accepted | 12000 | 800 | n/a |",
        "",
        "Total cost: n/a",
      ].join("\n"),
    )
  })
})
