const MAX_AI_API_KEY_CHARS = 4_096
const PRINTABLE_ASCII_WITHOUT_SPACE = /^[\x21-\x7e]+$/

/**
 * Authorization header values are ByteStrings in Electron/Undici. Validate
 * credentials before constructing Headers so malformed input is reported as a
 * settings problem instead of being misclassified as a network/TLS failure.
 */
export function normalizeAiApiKey(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error('AI API Key is missing. Enter the raw provider key in Settings > AI.')
  }
  if (/^Bearer\s/i.test(normalized)) {
    throw new Error('AI API Key must be the raw provider key without the "Bearer " prefix.')
  }
  if (
    normalized.length > MAX_AI_API_KEY_CHARS
    || !PRINTABLE_ASCII_WITHOUT_SPACE.test(normalized)
  ) {
    throw new Error(
      'AI API Key contains unsupported non-ASCII or whitespace characters. '
      + 'Re-enter the raw provider key in Settings > AI.'
    )
  }
  return normalized
}

export function buildAiAuthorizationHeader(apiKey: string): string {
  return `Bearer ${normalizeAiApiKey(apiKey)}`
}
