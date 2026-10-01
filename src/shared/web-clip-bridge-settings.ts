export function isWebClipBridgePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
}

export function parseWebClipBridgePortDraft(value: string): number | null {
  const normalized = value.trim()
  if (!/^[0-9]+$/.test(normalized)) return null
  const port = Number(normalized)
  return isWebClipBridgePort(port) ? port : null
}
