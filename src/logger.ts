import { env } from "node:process"
import { DateTime } from "luxon"

type LogLevel = "debug" | "info" | "warn" | "error"

export type Logger = {
  debug: (message: string, data?: Record<string, unknown>) => void
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
  /** Function-valued props are resolved at emit time, per log line — use
   *  `() => value` for context not yet available when the child is created. */
  child: (props: Record<string, unknown>) => Logger
}

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const isLogLevel = (value: string): value is LogLevel =>
  Object.hasOwn(LEVELS, value)

const envLevel = (env.LOG_LEVEL ?? "info").toLowerCase()
const threshold = isLogLevel(envLevel) ? LEVELS[envLevel] : LEVELS.info

/** Extracts "filename.ts:line" from the call stack — the frame that called the log method. */
const getCallerSource = (): string => {
  const original = Error.prepareStackTrace
  // Mutable — captured by the prepareStackTrace callback, which V8 calls during .stack access
  let capturedStack: NodeJS.CallSite[] | undefined
  Error.prepareStackTrace = (_err, callSites) => {
    capturedStack = callSites
    return callSites
  }
  void new Error().stack
  Error.prepareStackTrace = original

  if (!capturedStack) return "unknown"
  // V8 stack: [0] getCallerSource → [1] emit → [2] debug/info/warn/error → [3] actual caller
  const frame = capturedStack[3]
  if (!frame) return "unknown"
  const file = frame.getFileName()?.split("/").pop() ?? "unknown"
  return `${file}:${frame.getLineNumber()}`
}

/** Resolves function-valued child props at emit time — lets a child logger
 *  carry context that doesn't exist yet at child creation. */
const resolveLazyProps = (
  props: Record<string, unknown>,
): Record<string, unknown> => {
  const resolvedEntries = Object.entries(props).map(
    ([key, value]): [string, unknown] => [
      key,
      typeof value === "function" ? value() : value,
    ],
  )
  return Object.fromEntries(resolvedEntries)
}

export const createLogger = (
  name: string,
  options?: {
    props?: Record<string, unknown>
  },
): Logger => {
  const baseProps = options?.props ?? {}

  const emit = (
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
  ): void => {
    if (LEVELS[level] < threshold) return

    // Capture source location for info/warn/error (skip debug to avoid overhead)
    const source = level !== "debug" ? getCallerSource() : undefined

    const mergedData = { ...resolveLazyProps(baseProps), ...data }
    const line =
      JSON.stringify({
        timestamp: DateTime.now().toISO(),
        level,
        name,
        message,
        ...(source ? { source } : {}),
        ...mergedData,
      }) + "\n"

    if (level === "error") process.stderr.write(line)
    else process.stdout.write(line)
  }

  return {
    debug: (message, data) => emit("debug", message, data),
    info: (message, data) => emit("info", message, data),
    warn: (message, data) => emit("warn", message, data),
    error: (message, data) => emit("error", message, data),
    child: (props) =>
      createLogger(name, {
        props: { ...baseProps, ...props },
      }),
  }
}

export const logger = createLogger("umm-actually")
