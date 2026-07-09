import { describe, expect, it, onTestFinished, vi } from "vitest"
import { createLogger } from "../logger.js"

type WrittenLine = Record<string, unknown>

const captureStdout = (): { lines: () => WrittenLine[] } => {
  const writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true)
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

const captureStderr = (): { lines: () => WrittenLine[] } => {
  const writeSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true)
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
    const testLogger = createLogger("test-app")

    testLogger.debug("noisy")

    expect(stdout.lines()).toHaveLength(0)
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
