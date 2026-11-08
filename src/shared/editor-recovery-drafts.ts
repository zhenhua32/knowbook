export interface EditorRecoveryWorkspace {
  workspaceScope: string
  recoveryEpoch: string
}

export interface EditorRecoveryDraftInput {
  draftSessionId: string
  generation: number
  kind: 'document' | 'group' | 'source'
  targetId: string
  /** Exact serialized local editor state. Recovery never applies it to the workspace. */
  payload: string
}

export interface EditorRecoveryClose {
  requestId: string
  closeGeneration: number
}

export interface EditorRecoveryDraftWrite {
  workspace: EditorRecoveryWorkspace
  records: EditorRecoveryDraftInput[]
  close?: EditorRecoveryClose
}

export interface EditorRecoveryDraftIdentity {
  recordId: string
  generation: number
  hash: string
}

export interface EditorRecoveryDraftVersion extends EditorRecoveryDraftIdentity {
  draftSessionId: string
}

export interface EditorRecoveryDraftSummary extends EditorRecoveryDraftVersion {
  workspace: EditorRecoveryWorkspace
  kind: EditorRecoveryDraftInput['kind']
  targetId: string
  updatedAt: string
}

export interface EditorRecoveryDraft extends EditorRecoveryDraftSummary {
  payload: string
}

export interface EditorRecoveryReceipt {
  receiptId: string
  records: EditorRecoveryDraftVersion[]
  requestId?: string
  closeGeneration?: number
}

export const EDITOR_RECOVERY_CHANNELS = {
  workspace: 'knowbook:editor-recovery-workspace',
  write: 'knowbook:write-editor-recovery-drafts',
  list: 'knowbook:list-editor-recovery-drafts',
  read: 'knowbook:read-editor-recovery-draft',
  discard: 'knowbook:discard-editor-recovery-draft'
} as const
