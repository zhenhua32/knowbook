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
  protocol5RestoreRejoin?: true
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
}

export interface WebDavProtocol5ConflictPreview {
  previewId: string
  previewHash: string
  components: Array<{
    componentId: string
    choices: ResolveWebDavProtocol5Conflict['choice'][]
    records: Array<{ key: string; baseHash: string | null; localHash: string | null; remoteHash: string | null;
      parts: WebDavSyncMergePart[]; unresolvedPartIds: string[] }>
    copies?: { documentPaths: string[]; groupCount: number }
  }>
}

interface WebDavProtocol5PreviewSelection {
  previewId: string
  previewHash: string
  componentId: string
}

export type ResolveWebDavProtocol5Conflict = WebDavProtocol5PreviewSelection & (
  | { choice: 'local' | 'remote' | 'both' }
  | { choice: 'merge'; records: Array<{ key: string; parts: Array<{ id: string; value: WebDavSyncMergeChoice }> }> }
)

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

export type ResolveWebDavProtocol5Deletion = WebDavProtocol5PreviewSelection & { choice: WebDavProtocol5DeletionChoice }

export const DEFAULT_WEBDAV_SYNC_CONFIG: WebDavSyncConfig = {
  enabled: false, url: '', username: '', directory: 'KnowBook', intervalMinutes: 5, allowInsecureHttp: false
}
