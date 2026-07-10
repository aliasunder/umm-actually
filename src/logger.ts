import { env as processEnv } from "node:process"
import envVar from "env-var"
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

/** An unrecognized LOG_LEVEL degrades to "info" rather than throwing — a
 *  typo in workflow env must not break the action. */
const resolveThreshold = (
  envRecord: Record<string, string | undefined>,
): number => {
  const configuredLevel = envVar
    .from(envRecord)
    .get("LOG_LEVEL")
    .default("info")
    .asString()
    .toLowerCase()
  return isLogLevel(configuredLevel) ? LEVELS[configuredLevel] : LEVELS.info
}

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

/** The logger must never crash the caller — JSON.stringify throws on
 *  circular references (common in octokit RequestError data) and BigInt,
 *  so degrade to the core fields and record why. */
const serializeLine = (record: Record<string, unknown>): string => {
  try {
    return JSON.stringify(record)
  } catch (serializationError) {
    return JSON.stringify({
      timestamp: record.timestamp,
      level: record.level,
      name: record.name,
      message: record.message,
      serialization_error: String(serializationError),
    })
  }
}

/** Lazy props exist for context not yet available at child creation — the
 *  exact situation where a getter can throw. The logger must never crash the
 *  caller, so record the failure instead of propagating it. */
const resolveLazyValue = (value: unknown): unknown => {
  if (typeof value !== "function") return value
  try {
    return value()
  } catch (lazyPropError) {
    return `[lazy prop failed: ${String(lazyPropError)}]`
  }
}

/** Resolves function-valued props at emit time — lets a child logger
 *  carry context that doesn't exist yet at child creation. */
const resolveLazyProps = (
  props: Record<string, unknown>,
): Record<string, unknown> => {
  const resolvedEntries = Object.entries(props).map(
    ([key, value]): [string, unknown] => [key, resolveLazyValue(value)],
  )
  return Object.fromEntries(resolvedEntries)
}

export const createLogger = (
  name: string,
  options?: {
    props?: Record<string, unknown>
    /** Injectable for tests; defaults to process.env. */
    env?: Record<string, string | undefined>
  },
): Logger => {
  const baseProps = options?.props ?? {}
  const threshold = resolveThreshold(options?.env ?? processEnv)

  const emit = (
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
  ): void => {
    if (LEVELS[level] < threshold) return

    // Capture source location for info/warn/error (skip debug to avoid overhead)
    const source = level !== "debug" ? getCallerSource() : undefined

    // Resolve base props and per-call data through the same path — a lazy
    // function in data would otherwise be silently dropped by JSON.stringify
    const mergedData = resolveLazyProps({ ...baseProps, ...data })
    const line =
      serializeLine({
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
        ...(options?.env === undefined ? {} : { env: options.env }),
      }),
  }
}

export const logger = createLogger("umm-actually")
