const IPC_ERROR_PREFIX = /^Error invoking remote method '([^'\r\n]+)':\s*/i
const NATIVE_ERROR_PREFIX = /^(?:Error|TypeError|RangeError|SyntaxError|AggregateError):\s*/
const EMPTY_NATIVE_ERROR = /^(?:Error|TypeError|RangeError|SyntaxError|AggregateError)$/

export function normalizeErrorMessage(message: string, fallback = ''): string {
  let normalized = message
  let hasIpcWrapper = false
  while (true) {
    const ipcPrefix = IPC_ERROR_PREFIX.exec(normalized)
    const validIpcPrefix = ipcPrefix && ipcPrefix[1].trim() ? ipcPrefix[0] : null
    const prefix = validIpcPrefix ?? NATIVE_ERROR_PREFIX.exec(normalized)?.[0]
    if (!prefix) break
    if (validIpcPrefix) hasIpcWrapper = true
    normalized = normalized.slice(prefix.length)
  }
  // Electron serializes an exception with no message as just its name.
  if (hasIpcWrapper && EMPTY_NATIVE_ERROR.test(normalized.trim())) return fallback
  // Plain messages retain their formatting. Empty wrappers have no reason to
  // display, but meaningful paths and multiline explanations remain untouched.
  return normalized.trim() ? normalized : fallback
}

export function getErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback
  }

  const normalized = normalizeErrorMessage(error.message.trim()).trim()

  return normalized || fallback
}
