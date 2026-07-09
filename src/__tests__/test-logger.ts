import type { Logger } from "../logger.js"

export type CapturedLog = {
  level: "debug" | "info" | "warn" | "error"
  message: string
  data: Record<string, unknown>
}

export type TestLogger = Logger & {
  messages: CapturedLog[]
}

/** Mirrors production lazy-prop semantics: function-valued props resolve at emit. */
const resolveProps = (
  props: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(props).map(([key, value]) => [
      key,
      typeof value === "function" ? value() : value,
    ]),
  )

/** Logger stub that records every call (child props included) for assertion. */
export const createTestLogger = (): TestLogger => {
  const messages: CapturedLog[] = []

  const make = (baseProps: Record<string, unknown>): TestLogger => {
    const record = (
      level: CapturedLog["level"],
      message: string,
      data?: Record<string, unknown>,
    ): void => {
      messages.push({
        level,
        message,
        data: { ...resolveProps(baseProps), ...data },
      })
    }

    return {
      messages,
      debug: (message, data) => record("debug", message, data),
      info: (message, data) => record("info", message, data),
      warn: (message, data) => record("warn", message, data),
      error: (message, data) => record("error", message, data),
      child: (props) => make({ ...baseProps, ...props }),
    }
  }

  return make({})
}
