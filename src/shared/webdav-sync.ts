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
}

export interface WebDavSyncStatus {
  config: WebDavSyncConfig
  hasPassword: boolean
  phase: 'idle' | 'testing' | 'syncing' | 'error'
  lastSyncAt: string | null
  message: string
  uploaded: number
  downloaded: number
  conflicts: WebDavSyncConflict[]
}

export interface ResolveWebDavSyncConflict {
  key: string
  choice: 'local' | 'remote' | 'both'
}

export const DEFAULT_WEBDAV_SYNC_CONFIG: WebDavSyncConfig = {
  enabled: false, url: '', username: '', directory: 'KnowBook', intervalMinutes: 5, allowInsecureHttp: false
}
