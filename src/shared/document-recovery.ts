import type { UpdateDocumentInput } from './contracts'

export interface DocumentRecoveryEntry {
  id: string
  documentId: string
  title: string
  path: string
  createdAt: string
  reason: 'edit' | 'restore' | 'delete' | 'move'
}

export interface DocumentRecoveryPreview extends DocumentRecoveryEntry {
  content: UpdateDocumentInput
}

export interface BackupVersion {
  id: string
  createdAt: string
  documentCount: number | null
  current: boolean
  /** V3 discovery is separate from the not-yet-installed restore consumer. */
  format?: 'synced-v3'
  restorable?: false
}

export const DOCUMENT_HISTORY_LIMIT = 100
export const DOCUMENT_HISTORY_INTERVAL_MS = 5 * 60 * 1000
