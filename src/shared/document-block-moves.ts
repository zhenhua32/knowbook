import type { DocumentDetail } from './contracts'

export interface MoveDocumentBlocksInput {
  fromDocumentId: string
  toDocumentId: string
  blockIds: string[]
  expectedFromUpdatedAt: string
  expectedToUpdatedAt: string
  beforeBlockId?: string
  parentBlockId?: string | null
}
export interface RestoreDocumentBlockMoveInput {
  operationId: string
  /** Includes reference documents rewritten by the original move. */
  expectedUpdatedAtByDocument: Record<string, string>
}
export interface DocumentBlockMoveHistoryEntry {
  operationId: string
  state: 'applied' | 'undone'
  beforeBlocks: import('./contracts').DocumentBlockDraft[]
  afterBlocks: import('./contracts').DocumentBlockDraft[]
  expectedUpdatedAtByDocument: Record<string, string>
}
export interface DocumentBlockMoveResult {
  operationId: string
  state: 'applied' | 'undone'
  source: DocumentDetail
  target: DocumentDetail
  movedBlockIds: string[]
  affectedDocumentIds: string[]
  expectedUpdatedAtByDocument: Record<string, string>
}
