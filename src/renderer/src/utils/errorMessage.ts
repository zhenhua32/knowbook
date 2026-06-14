export function getErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback
  }

  const normalized = error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .trim()

  return normalized || fallback
}