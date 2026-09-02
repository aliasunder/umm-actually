import { describe, expect, it, onTestFinished, vi } from "vitest"
import { createLogger, describeError } from "../logger.js"

type WrittenLine = Record<string, unknown>

const captureStream = (
  stream: typeof process.stdout | typeof process.stderr,
): { lines: () => WrittenLine[] } => {
  const writeSpy = vi.spyOn(stream, "write").mockImplementation(() => true)
  onTestFinished(() => writeSpy.mockRestore())
  return {
    lines: () =>
      writeSpy.mock.calls.map((call): WrittenLine => {
        const written = call[0]
        if (typeof written !== "string")
          throw new Error("expected string write")
        return JSON.parse(written)
      }),
  }
}

const captureStdout = (): { lines: () => WrittenLine[] } =>
  captureStream(process.stdout)

const captureStderr = (): { lines: () => WrittenLine[] } =>
  captureStream(process.stderr)

describe("createLogger", () => {
  it("writes a structured JSON line with timestamp, level, name, message, and data", () => {
    const stdout = captureStdout()
    const testLogger = createLogger("test-app")

    testLogger.info("read note", { path: "Notes/plan.md" })

    const lines = stdout.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: "info",
      name: "test-app",
      message: "read note",
      path: "Notes/plan.md",
    })
    expect(typeof lines[0]?.timestamp).toBe("string")
  })

  it("routes error level to stderr, not stdout", () => {
    const stdout = captureStdout()
    const stderr = captureStderr()
    const testLogger = createLogger("test-app")

    testLogger.error("boom")

    expect(stdout.lines()).toHaveLength(0)
    expect(stderr.lines()).toHaveLength(1)
    expect(stderr.lines()[0]).toMatchObject({ level: "error", message: "boom" })
  })

  it("suppresses debug below the default info threshold", () => {
    const stdout = captureStdout()
    // Empty env record: the default must come from the logger, not ambient LOG_LEVEL
    const testLogger = createLogger("test-app", { env: {} })

    testLogger.debug("noisy")
    testLogger.info("kept")

    const lines = stdout.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: "info", message: "kept" })
  })

  it("routes warn to stdout at the default threshold", () => {
    const stdout = captureStdout()
    const stderr = captureStderr()
    const testLogger = createLogger("test-app", { env: {} })

    testLogger.warn("heads up")

    expect(stderr.lines()).toHaveLength(0)
    expect(stdout.lines()).toHaveLength(1)
    expect(stdout.lines()[0]).toMatchObject({
      level: "warn",
      message: "heads up",
    })
  })

  it("omits the source field on debug lines", () => {
    const stdout = captureStdout()
    const testLogger = createLogger("test-app", { env: { LOG_LEVEL: "debug" } })

    testLogger.debug("verbose trace")

    expect(stdout.lines()).toHaveLength(1)
    expect(stdout.lines()[0]?.source).toBeUndefined()
  })

  it("reads LOG_LEVEL case-insensitively", () => {
    const stdout = captureStdout()
    const testLogger = createLogger("test-app", { env: { LOG_LEVEL: "DEBUG" } })

    testLogger.debug("verbose trace")

    expect(stdout.lines()).toHaveLength(1)
    expect(stdout.lines()[0]).toMatchObject({
      level: "debug",
      message: "verbose trace",
    })
  })

  it("emits debug when the injected env sets LOG_LEVEL=debug", () => {
    const stdout = captureStdout()
    const testLogger = createLogger("test-app", { env: { LOG_LEVEL: "debug" } })

    testLogger.debug("verbose trace")

    expect(stdout.lines()).toHaveLength(1)
    expect(stdout.lines()[0]).toMatchObject({
      level: "debug",
      message: "verbose trace",
    })
  })

  it("falls back to the info threshold when LOG_LEVEL is unrecognized", () => {
    const stdout = captureStdout()
    const testLogger = createLogger("test-app", {
      env: { LOG_LEVEL: "verbose" },
    })

    testLogger.debug("noisy")
    testLogger.info("kept")

    expect(stdout.lines()).toHaveLength(1)
    expect(stdout.lines()[0]).toMatchObject({ level: "info", message: "kept" })
  })

  it("child loggers inherit the injected env record", () => {
    const stdout = captureStdout()
    const childLogger = createLogger("test-app", {
      env: { LOG_LEVEL: "debug" },
    }).child({ requestId: "7" })

    childLogger.debug("child trace")

    expect(stdout.lines()).toHaveLength(1)
    expect(stdout.lines()[0]).toMatchObject({
      level: "debug",
      requestId: "7",
    })
  })

  it("degrades to core fields when the data cannot be serialized", () => {
    const stdout = captureStdout()
    const testLogger = createLogger("test-app")
    // Mutable on purpose — a circular reference requires self-assignment
    const circular: Record<string, unknown> = {}
    circular.self = circular

    testLogger.info("kept message", { circular })

    const lines = stdout.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: "info",
      name: "test-app",
      message: "kept message",
    })
    expect(lines[0]?.circular).toBeUndefined()
    expect(typeof lines[0]?.serialization_error).toBe("string")
  })

  it("captures the caller's source location as filename:line", () => {
    const stdout = captureStdout()
    const testLogger = createLogger("test-app")

    testLogger.info("locate me")

    expect(stdout.lines()[0]?.source).toMatch(/^logger\.test\.ts:\d+$/)
  })

  it("merges child props into every line, with per-call data winning on key collision", () => {
    const stdout = captureStdout()
    const childLogger = createLogger("test-app").child({
      requestId: "7",
      tool: "vault_read_note",
    })

    childLogger.info("tool call", { tool: "override" })

    expect(stdout.lines()[0]).toMatchObject({
      requestId: "7",
      tool: "override",
    })
  })

  it("merges nested child props, later children winning", () => {
    const stdout = captureStdout()
    const grandchildLogger = createLogger("test-app")
      .child({ sessionId: "abc", clientIp: "203.0.113.42" })
      .child({ requestId: "9", clientIp: "198.51.100.7" })

    grandchildLogger.info("nested")

    expect(stdout.lines()[0]).toMatchObject({
      sessionId: "abc",
      clientIp: "198.51.100.7",
      requestId: "9",
    })
  })

  it("records a placeholder instead of crashing when a lazy prop throws", () => {
    const stdout = captureStdout()
    const childLogger = createLogger("test-app").child({
      requestId: () => {
        throw new Error("context not ready")
      },
    })

    childLogger.info("still emits")

    const lines = stdout.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      message: "still emits",
      requestId: "[lazy prop failed: Error: context not ready]",
    })
  })

  it("resolves function-valued per-call data the same way as child props", () => {
    const stdout = captureStdout()
    const testLogger = createLogger("test-app")

    testLogger.info("msg", { lazy: () => "resolved value" })

    expect(stdout.lines()[0]).toMatchObject({ lazy: "resolved value" })
  })

  it("resolves function-valued child props at emit time, not child creation", () => {
    const stdout = captureStdout()
    // Mutable on purpose — the lazy prop must observe the post-creation value
    let sessionId: string | undefined = undefined
    const childLogger = createLogger("test-app").child({
      sessionId: () => sessionId,
    })

    childLogger.info("before")
    sessionId = "generated-later"
    childLogger.info("after")

    const lines = stdout.lines()
    expect(lines[0]?.sessionId).toBeUndefined()
    expect(lines[1]?.sessionId).toBe("generated-later")
  })
})

describe("describeError", () => {
  it("formats an Error as [Name]: message", () => {
    const error = new TypeError("value is not a function")

    expect(describeError(error)).toBe("[TypeError]: value is not a function")
  })

  it("stringifies a non-Error value", () => {
    expect(describeError("plain string")).toBe("plain string")
    expect(describeError(42)).toBe("42")
    expect(describeError(null)).toBe("null")
  })
})
