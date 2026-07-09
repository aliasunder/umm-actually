import * as core from "@actions/core"

export type Logger = {
  debug: (message: string) => void
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

/**
 * Thin Logger over @actions/core so every module depends on this shape,
 * not on the toolkit directly — tests inject a plain stub object.
 */
export const createLogger = (): Logger => ({
  debug: (message: string): void => core.debug(message),
  info: (message: string): void => core.info(message),
  warn: (message: string): void => core.warning(message),
  error: (message: string): void => core.error(message),
})
