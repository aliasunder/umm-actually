import type { Logger } from "../logger.js"

export type TestLogger = Logger & {
  messages: { level: "debug" | "info" | "warn" | "error"; message: string }[]
}

/** Logger stub that records every call for assertion. */
export const createTestLogger = (): TestLogger => {
  const messages: TestLogger["messages"] = []
  return {
    messages,
    debug: (message: string): void => {
      messages.push({ level: "debug", message })
    },
    info: (message: string): void => {
      messages.push({ level: "info", message })
    },
    warn: (message: string): void => {
      messages.push({ level: "warn", message })
    },
    error: (message: string): void => {
      messages.push({ level: "error", message })
    },
  }
}
