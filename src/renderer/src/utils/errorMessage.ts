const IPC_ERROR_PREFIX = /^Error invoking remote method '([^'\r\n]+)':\s*/i
const NATIVE_ERROR_PREFIX = /^(?:Error|TypeError|RangeError|SyntaxError|AggregateError):\s*/

export function normalizeErrorMessage(message: string, fallback = ''): string {
  let normalized = message
  while (true) {
    const ipcPrefix = IPC_ERROR_PREFIX.exec(normalized)
    const prefix = ipcPrefix && ipcPrefix[1].trim() ? ipcPrefix[0] : NATIVE_ERROR_PREFIX.exec(normalized)?.[0]
    if (!prefix) break
    normalized = normalized.slice(prefix.length)
  }
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
