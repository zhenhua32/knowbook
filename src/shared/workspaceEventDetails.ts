import type { WorkspaceEventDetails } from './contracts'

/** Historical and plugin events may have no structured host details. */
export function parseWorkspaceEventDetails(value: unknown): WorkspaceEventDetails | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  if (fields.schemaVersion !== 1) return undefined
  const details: WorkspaceEventDetails = { schemaVersion: 1 }
  for (const field of ['documentTitle', 'path', 'previousPath', 'model'] as const) {
    const content = fields[field]
    if (content !== undefined) {
      if (typeof content !== 'string') return undefined
      details[field] = content
    }
  }
  for (const field of ['pathChanged', 'aiEnabled'] as const) {
    const content = fields[field]
    if (content !== undefined) {
      if (typeof content !== 'boolean') return undefined
      details[field] = content
    }
  }
  if (fields.affectedDocumentCount !== undefined) {
    const count = fields.affectedDocumentCount
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined
    details.affectedDocumentCount = count
  }
  return details
}
