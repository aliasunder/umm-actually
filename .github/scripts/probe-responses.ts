// Temporary probe for the Agent SDK migration. It captures the raw Responses
// API payloads (accepted, context overflow, bad key) that become the client's
// fixtures, printing each HTTP body between markers from the SDK's response
// hooks. It runs once from the probe workflow on the migration branch under
// bun (which resolves the src import), then both files are removed.
import { OpenRouter } from "@openrouter/agent"
import envVar from "env-var"
import { reviewResponseJsonSchema } from "../../src/review/finding.js"

const apiKey = envVar.from(process.env).get("OPENROUTER_KEY").required().asString()

/** Every primary and fallback slug a consumer runs (repo variables read 2026-11-11). */
const consumerSlugs = [
  "deepseek/deepseek-v4.1-flash:online",
  "z-ai/glm-5.3-flash:online",
  "deepseek/deepseek-v4.1-flash-1017:online",
  "deepseek/deepseek-v4-flash-1017:online",
  "deepseek/deepseek-v4-flash-0731:online",
  "minimax/minimax-m3:online",
  "deepseek/deepseek-v4-flash-1017",
  "z-ai/glm-5.3-flash",
]

/** The ceiling the client sends on every attempt except a fitted retry. */
const PRODUCTION_MAX_OUTPUT_TOKENS = 128_000

/** The overflow target has an 8,192-token window and endpoints that cap output
 *  at 7,372 tokens, so a 2K prompt plus a 7,000 ceiling overflows the window
 *  while staying under the output cap (public endpoints API, 2026-11-11). */
const OVERFLOW_MODEL = "sao10k/l3-lunaris-8b"
const OVERFLOW_MAX_OUTPUT_TOKENS = 7_000

const REQUEST_TIMEOUT_MS = 120_000

/** Prints one captured payload between markers the session greps for. */
const printCapture = (label: string, payload: string): void => {
  console.log(`<<<PROBE ${label}>>>`)
  console.log(payload)
  console.log(`<<<END ${label}>>>`)
}

/** Reads a cloned HTTP body without disturbing the SDK's own read. */
const captureBody = async (label: string, response: Response): Promise<void> => {
  const text = await response.clone().text()
  printCapture(`${label} status=${response.status}`, text)
}

const makeClient = (key: string, label: string): OpenRouter => {
  return new OpenRouter({
    apiKey: key,
    hooks: [
      {
        afterSuccess: async (_context: unknown, response: Response): Promise<Response> => {
          await captureBody(`${label} raw`, response)
          return response
        },
        afterError: async (
          _context: unknown,
          response: Response | null,
          error: unknown,
        ): Promise<{ response: Response | null; error: unknown }> => {
          if (response) await captureBody(`${label} raw-error`, response)
          return { response, error }
        },
      },
    ],
  })
}

const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return JSON.stringify({ thrown: String(error) })
  const statusCode = "statusCode" in error ? error.statusCode : undefined
  const body =
    "body" in error && typeof error.body === "string" ? error.body.slice(0, 4000) : undefined
  return JSON.stringify({
    name: error.name,
    constructor: error.constructor.name,
    statusCode,
    message: error.message,
    body,
  })
}

const reviewInstructions =
  "You are a code reviewer. Reply with JSON that matches the schema: an analysis string and a findings array."
const reviewInput =
  'Review this one-line change and report no findings: `export const greeting = "hello"`.'

const runAccepted = async (model: string): Promise<void> => {
  const client = makeClient(apiKey, `accepted ${model}`)
  try {
    const result = client.callModel(
      {
        model,
        instructions: reviewInstructions,
        input: reviewInput,
        maxOutputTokens: PRODUCTION_MAX_OUTPUT_TOKENS,
        text: {
          format: {
            type: "json_schema",
            name: "review_response",
            strict: true,
            schema: reviewResponseJsonSchema,
          },
        },
      },
      { retries: { strategy: "none" }, timeoutMs: REQUEST_TIMEOUT_MS },
    )
    const response = await result.getResponse()
    printCapture(`accepted ${model} parsed`, JSON.stringify(response))
    printCapture(`accepted ${model} text`, await result.getText())
  } catch (error) {
    printCapture(`accepted ${model} threw`, describeError(error))
  }
}

const runOverflow = async (): Promise<void> => {
  const client = makeClient(apiKey, "overflow")
  const filler = "The quick brown fox jumps over the lazy dog. ".repeat(400)
  try {
    const result = client.callModel(
      {
        model: OVERFLOW_MODEL,
        instructions: reviewInstructions,
        input: `${filler}\n${reviewInput}`,
        maxOutputTokens: OVERFLOW_MAX_OUTPUT_TOKENS,
        // Endpoints with an 8K window compress the prompt by default, which
        // would hide the overflow; the probe needs the rejection itself
        plugins: [{ id: "context-compression", enabled: false }],
        text: {
          format: {
            type: "json_schema",
            name: "review_response",
            strict: true,
            schema: reviewResponseJsonSchema,
          },
        },
      },
      { retries: { strategy: "none" }, timeoutMs: REQUEST_TIMEOUT_MS },
    )
    const response = await result.getResponse()
    printCapture("overflow returned", JSON.stringify(response))
  } catch (error) {
    printCapture("overflow threw", describeError(error))
  }
}

const runBadKey = async (): Promise<void> => {
  const client = makeClient("sk-or-v1-invalid-probe-key", "bad-key")
  try {
    const result = client.callModel(
      {
        model: "deepseek/deepseek-v4.1-flash",
        instructions: reviewInstructions,
        input: reviewInput,
        maxOutputTokens: PRODUCTION_MAX_OUTPUT_TOKENS,
        text: {
          format: {
            type: "json_schema",
            name: "review_response",
            strict: true,
            schema: reviewResponseJsonSchema,
          },
        },
      },
      { retries: { strategy: "none" }, timeoutMs: REQUEST_TIMEOUT_MS },
    )
    const response = await result.getResponse()
    printCapture("bad-key returned", JSON.stringify(response))
  } catch (error) {
    printCapture("bad-key threw", describeError(error))
  }
}

for (const slug of consumerSlugs) {
  await runAccepted(slug)
}
await runOverflow()
await runBadKey()
