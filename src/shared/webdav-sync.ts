export interface WebDavSyncConfig {
  enabled: boolean
  url: string
  username: string
  directory: string
  intervalMinutes: number
  allowInsecureHttp: boolean
}

export interface SaveWebDavSyncConfig extends WebDavSyncConfig {
  /** An explicit, local per-target choice. It never enters a wire manifest. */
  protocol5?: boolean
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
  protocol5?: true
  protocol5Preview?: WebDavProtocol5ConflictPreview
  protocol5DeletionPreview?: WebDavProtocol5DeletionPreview
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

export interface WebDavProtocol5ConflictPreview {
  previewId: string
  previewHash: string
  components: Array<{
    componentId: string
    choices: Array<'local' | 'remote'>
    records: Array<{ key: string; baseHash: string | null; localHash: string | null; remoteHash: string | null; parts: WebDavSyncMergePart[] }>
  }>
}

export interface ResolveWebDavProtocol5Conflict {
  previewId: string
  previewHash: string
  componentId: string
  choice: 'local' | 'remote'
}

export type WebDavProtocol5DeletionChoice = 'keep-live' | 'keep-delete'
export type WebDavProtocol5DeletionSide =
  | { kind: 'missing'; hash: null }
  | { kind: 'unavailable'; hash: string }
  | { kind: 'deleted'; hash: string; deletedAt?: string }
  | { kind: 'live'; hash: string; title?: string; text: string; truncated: boolean }

export interface WebDavProtocol5DeletionPreview {
  previewId: string
  previewHash: string
  components: Array<{
    componentId: string
    choices: WebDavProtocol5DeletionChoice[]
    keepLiveReason: string | null
    keepDeleteReason: string | null
    completeText: boolean
    records: Array<{ key: string; base: WebDavProtocol5DeletionSide; local: WebDavProtocol5DeletionSide; remote: WebDavProtocol5DeletionSide }>
  }>
}

export type ResolveWebDavProtocol5Deletion = Omit<ResolveWebDavProtocol5Conflict, 'choice'>
  & { choice: WebDavProtocol5DeletionChoice }

export interface ResolveWebDavSyncConflict extends WebDavSyncConflictVersion {
  choice: WebDavSyncResolutionChoice | 'clear'
  mergeChoices?: Record<string, WebDavSyncMergeChoice>
}

export const DEFAULT_WEBDAV_SYNC_CONFIG: WebDavSyncConfig = {
  enabled: false, url: '', username: '', directory: 'KnowBook', intervalMinutes: 5, allowInsecureHttp: false
}
