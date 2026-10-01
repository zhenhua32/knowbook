export interface WebDavSyncConfig {
  enabled: boolean
  url: string
  username: string
  directory: string
  intervalMinutes: number
  allowInsecureHttp: boolean
}

export interface SaveWebDavSyncConfig extends WebDavSyncConfig {
  /** Omit to retain the saved password; empty string clears it. */
  password?: string
}

export interface WebDavSyncConflict {
  key: string
  title: string
  localPreview: string
  remotePreview: string
  canKeepBoth: boolean
  localHash: string
  remoteHash: string
  localDeleted: boolean
  remoteDeleted: boolean
  reason: 'overlap' | 'no-base' | 'delete-edit' | 'database'
  canMerge: boolean
  mergeFields: Array<Pick<WebDavSyncMergePart, 'id' | 'field' | 'blockId'>>
  resolution: WebDavSyncResolutionChoice | null
}

export type WebDavSyncResolutionChoice = 'local' | 'remote' | 'both' | 'merge'

export interface WebDavSyncMergePart {
  id: string
  field: 'title' | 'summary' | 'parentId' | 'sortOrder' | 'blocks' | 'block-content' | 'block-property'
  blockId?: string
  property?: string
  basePreview: string
  localPreview: string
  remotePreview: string
  canEditText: boolean
}

export type WebDavSyncMergeChoice = { choice: 'local' | 'remote' } | { choice: 'custom'; text: string }

export interface WebDavSyncConflictVersion {
  key: string
  localHash: string
  remoteHash: string
}

export interface WebDavSyncConflictDetails extends WebDavSyncConflictVersion {
  localPreview: string
  remotePreview: string
  basePreview: string | null
  savedChoices?: Record<string, WebDavSyncMergeChoice>
  merge: {
    document: import('./contracts').UpdateDocumentInput
    conflicts: WebDavSyncMergePart[]
    unresolvedIds: string[]
  } | null
}

export interface WebDavSyncConflictDetailsInput extends WebDavSyncConflictVersion {
  mergeChoices?: Record<string, WebDavSyncMergeChoice>
}

export interface WebDavSyncProgress {
  stage: 'checking' | 'preparing' | 'comparing' | 'uploading' | 'downloading' | 'publishing' | 'applying'
  /** Counts describe the current stage, not a predicted percentage of the whole sync. */
  completed: number
  total: number | null
  attachmentsCompleted: number
  attachmentsTotal: number
  currentItem: string | null
  currentAttachment: string | null
  startedAt: string
  requestsCompleted: number
  waitingUntil: string | null
}

export interface WebDavSyncStatus {
  config: WebDavSyncConfig
  hasPassword: boolean
  phase: 'idle' | 'testing' | 'syncing' | 'error'
  lastSyncAt: string | null
  message: string
  uploaded: number
  downloaded: number
  merged: number
  progress: WebDavSyncProgress | null
  conflicts: WebDavSyncConflict[]
}

export interface ResolveWebDavSyncConflict extends WebDavSyncConflictVersion {
  choice: WebDavSyncResolutionChoice | 'clear'
  mergeChoices?: Record<string, WebDavSyncMergeChoice>
}

export const DEFAULT_WEBDAV_SYNC_CONFIG: WebDavSyncConfig = {
  enabled: false, url: '', username: '', directory: 'KnowBook', intervalMinutes: 5, allowInsecureHttp: false
}
