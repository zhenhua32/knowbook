export interface WorkspaceSummary {
  databasePath: string
  backupRoot: string
  documents: number
  blocks: number
  links: number
  lastBackupAt: string | null
}

export interface RecentDocument {
  id: string
  title: string
  path: string
  updatedAt: string
  blockCount: number
}

export interface DocumentIndexEntry {
  id: string
  title: string
  path: string
  parentId: string | null
  updatedAt: string
}

export interface DocumentCatalogEntry extends DocumentIndexEntry {
  summary: string
  parentTitle: string | null
  blockCount: number
  linkCount: number
  childCount: number
  fieldValues: Record<string, DocumentDatabaseFieldValue>
}

export type DocumentDatabaseColumnType = 'text' | 'select' | 'multi-select' | 'date' | 'checkbox'

export type DocumentDatabaseFieldValue = string | string[] | boolean | null

export interface DocumentDatabaseColumn {
  id: string
  name: string
  type: DocumentDatabaseColumnType
  options: string[]
  sortOrder: number
}

export interface DocumentDatabase {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

export type DatabaseSavedViewSortMode = 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc'

export type DatabaseSavedViewLayoutMode = 'cards' | 'table'

export interface DatabaseSavedView {
  id: string
  databaseId: string
  name: string
  filterQuery: string
  filterScope: string
  sortMode: DatabaseSavedViewSortMode
  viewMode: DatabaseSavedViewLayoutMode
  createdAt: string
  updatedAt: string
}

export interface DatabaseEntity {
  id: string
  databaseId: string
  documentId: string | null  // 可选关联到文档
  createdAt: string
  updatedAt: string
  fieldValues: Record<string, DocumentDatabaseFieldValue>
}

export interface CreateDatabaseInput {
  name: string
  description?: string
}

export interface UpdateDatabaseMetadataInput {
  databaseId: string
  name: string
  description: string
}

export interface CreateDatabaseSavedViewInput {
  databaseId: string
  name: string
  filterQuery?: string
  filterScope?: string
  sortMode?: DatabaseSavedViewSortMode
  viewMode?: DatabaseSavedViewLayoutMode
}

export interface UpdateDatabaseSavedViewInput {
  viewId: string
  name?: string
  filterQuery?: string
  filterScope?: string
  sortMode?: DatabaseSavedViewSortMode
  viewMode?: DatabaseSavedViewLayoutMode
}

export interface CreateDocumentDatabaseColumnInput {
  databaseId?: string
  name: string
  type: DocumentDatabaseColumnType
  options?: string[]
}

export interface RenameDocumentDatabaseColumnInput {
  columnId: string
  name: string
}

export interface MoveDocumentDatabaseColumnInput {
  columnId: string
  direction: 'left' | 'right'
}

export interface UpdateDocumentDatabaseColumnOptionsInput {
  columnId: string
  options: string[]
}

export interface UpdateDocumentDatabaseValueInput {
  documentId: string
  columnId: string
  value: DocumentDatabaseFieldValue
}

export interface CreateDatabaseEntityInput {
  databaseId: string
  documentId?: string
  fieldValues?: Record<string, DocumentDatabaseFieldValue>
}

export interface UpdateDatabaseEntityInput {
  entityId: string
  fieldValues?: Record<string, DocumentDatabaseFieldValue>
  documentId?: string | null
}

export interface UpdateDatabaseEntitiesInput {
  updates: UpdateDatabaseEntityInput[]
}

export interface DeleteDatabaseEntityInput {
  entityId: string
}

export interface DeleteDatabaseEntitiesInput {
  entityIds: string[]
}

export interface GetDatabaseEntitiesInput {
  databaseId: string
}

export interface DocumentTreeNode {
  id: string
  title: string
  path: string
  updatedAt: string
  children: DocumentTreeNode[]
}

export interface DocumentBlock {
  id: string
  type: string
  content: string
  checked: boolean
  depth: number
  parentBlockId: string | null
  sortOrder: number
  tags?: string[]
  language?: string
  highlight?: string
}

export interface DocumentBlockDraft {
  id?: string
  type: string
  content: string
  checked: boolean
  depth: number
  parentBlockId?: string | null
  tags?: string[]
  language?: string
  highlight?: string
}

export interface LinkedDocument {
  id: string
  title: string
  path: string
  label: string
  contextSnippet?: string
}

export interface BlockReferenceResult {
  block: DocumentBlock
  documentId: string
  documentPath: string
  documentTitle: string
}

export interface DocumentSuggestion {
  id: string
  title: string
  path: string
}

export interface GlobalSearchResult {
  documentId: string
  documentTitle: string
  documentPath: string
  matchType: 'title' | 'block'
  snippet: string
  blockId?: string
  blockType?: string
}

export interface DocumentChild {
  id: string
  title: string
  path: string
}

export interface DocumentDetail {
  id: string
  title: string
  path: string
  summary: string
  updatedAt: string
  blocks: DocumentBlock[]
  children: DocumentChild[]
  outgoingLinks: LinkedDocument[]
  backlinks: LinkedDocument[]
}

export interface AiConfig {
  enabled: boolean
  baseUrl: string
  model: string
  autoSummaryOnSave: boolean
  relatedNotesEnabled: boolean
  hasApiKey: boolean
}

export interface SemanticSearchResult {
  documentId: string
  title: string
  path: string
  summary: string
  snippet: string
  score: number
}

export type WorkspaceEventType =
  | 'document.created'
  | 'document.updated'
  | 'document.summary.generated'
  | 'document.moved'
  | 'document.deleted'
  | 'ai.config.updated'
  | 'plugin.loaded'
  | 'plugin.reloaded'
  | 'plugin.installed'
  | 'plugin.updated'
  | 'plugin.removed'
  | 'plugin.action.executed'
  | 'plugin.action.failed'

export interface WorkspaceEventRecord {
  id: string
  type: WorkspaceEventType
  title: string
  description: string
  documentId: string | null
  createdAt: string
}

export type PluginSource = 'workspace' | 'user-data'

export type PluginStatus = 'loading' | 'running' | 'disabled' | 'error'

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  entry?: string
  enabledByDefault?: boolean
  engines?: {
    knowbook?: string
  }
}

export interface PluginDescriptor {
  id: string
  name: string
  version: string
  description: string
  author?: string
  source: PluginSource
  enabled: boolean
  status: PluginStatus
  error?: string
  settings: PluginSettingDescriptor[]
}

export interface PluginDashboardCard {
  pluginId: string
  id: string
  title: string
  body: string
}

export interface PluginDocumentAction {
  pluginId: string
  id: string
  label: string
  description?: string
}

export type PluginSettingType = 'text' | 'checkbox' | 'select'

export type PluginSettingValue = string | boolean

export interface PluginSettingOption {
  value: string
  label: string
}

export interface PluginSettingDescriptor {
  pluginId: string
  id: string
  label: string
  description?: string
  type: PluginSettingType
  value: PluginSettingValue
  defaultValue: PluginSettingValue
  options?: PluginSettingOption[]
}

export interface PluginHostInfo {
  roots: string[]
  writableRoot: string | null
}

export interface InstallPluginResult {
  plugin: PluginDescriptor
  operation: 'installed' | 'updated' | 'reloaded'
  previousVersion: string | null
}

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'
  | 'unsupported'

export interface AppUpdateState {
  status: AppUpdateStatus
  currentVersion: string
  availableVersion: string | null
  downloadedVersion: string | null
  releaseName: string | null
  releaseNotes: string | null
  checkedAt: string | null
  progressPercent: number | null
  message: string
  error: string | null
  updatesEnabled: boolean
  canInstall: boolean
}

export interface HomeData {
  summary: WorkspaceSummary
  recentDocuments: RecentDocument[]
  recentEvents: WorkspaceEventRecord[]
  documentCatalog: DocumentIndexEntry[]
  databaseColumns: DocumentDatabaseColumn[]
  aiConfig: AiConfig
  documentTree: DocumentTreeNode[]
  initialDocumentId: string | null
  plugins?: PluginDescriptor[]
  pluginDashboardCards?: PluginDashboardCard[]
  pluginDocumentActions?: PluginDocumentAction[]
  pluginHost?: PluginHostInfo
}

export type DetailedHomeData = Omit<HomeData, 'documentCatalog'> & {
  documentCatalog: DocumentCatalogEntry[]
}

export type HomeDataPayload = Omit<HomeData, 'documentTree'>

export type DocumentIndexTuple = [
  id: string,
  title: string,
  path: string,
  parentId: string | null,
  updatedAt: string
]

export type DocumentCatalogTuple = [
  id: string,
  title: string,
  path: string,
  summary: string,
  parentId: string | null,
  parentTitle: string | null,
  updatedAt: string,
  blockCount: number,
  linkCount: number,
  childCount: number,
  fieldValues: Record<string, DocumentDatabaseFieldValue> | null
]

export type HomeDataIpcPayload = Omit<HomeDataPayload, 'documentCatalog'> & {
  documentCatalog: DocumentIndexTuple[]
}

export interface PluginHomeData {
  plugins: PluginDescriptor[]
  pluginDashboardCards: PluginDashboardCard[]
  pluginDocumentActions: PluginDocumentAction[]
  pluginHost: PluginHostInfo
}

export type UpdateDocumentResult =
  | {
      requiresFullRefresh: true
      document: DocumentDetail
    }
  | {
      requiresFullRefresh: false
      document: DocumentDetail
      catalogEntry: DocumentCatalogEntry
      summary: WorkspaceSummary
      recentDocuments: RecentDocument[]
      recentEvents: WorkspaceEventRecord[]
    }

export interface BackupResult {
  exported: number
  root: string
  at: string
}

export interface BackupRestoreResult {
  restored: number
  created: number
  updated: number
  deleted: number
  conflictsResolved: number
  placeholdersCreated: number
  root: string
  at: string
  safetyBackupPath?: string
}

export interface BackupRestorePreview {
  root: string
  restored: number
  created: number
  updated: number
  deleted: number
  conflictsResolved: number
  placeholdersCreated: number
  standaloneDatabases: number
  standaloneDatabasesCreated: number
  standaloneDatabasesUpdated: number
  standaloneDatabasesDeleted: number
}

export interface CreateDocumentResult {
  id: string
}

export interface ClipWebPageInput {
  url: string
  parentId: string | null
}

export interface ImportWebClipPayloadInput {
  url: string
  parentId: string | null
  title?: string
  html?: string
  markdown?: string
  text?: string
  sourceSite?: string
  excerpt?: string
  author?: string | null
  publishedAt?: string | null
  coverImage?: string | null
}

export interface ClipWebPageResult {
  documentId: string
  title: string
  sourceUrl: string
  warnings: string[]
  created: boolean
  duplicateOfDocumentId: string | null
}

export interface WebClipBridgeStatus {
  enabled: boolean
  running: boolean
  port: number | null
  token: string
  endpoint: string | null
  lastError: string | null
}

export interface UpdateWebClipBridgeSettingsInput {
  enabled: boolean
  port: number
  regenerateToken?: boolean
}

export interface UpdateDocumentInput {
  title: string
  summary: string
  blocks: DocumentBlockDraft[]
}

export interface UpdateAiConfigInput {
  enabled: boolean
  baseUrl: string
  model: string
  autoSummaryOnSave: boolean
  relatedNotesEnabled: boolean
  apiKey?: string
  clearApiKey?: boolean
}

export interface SearchSemanticNotesInput {
  query: string
  limit?: number
  excludeDocumentId?: string | null
}

export interface AskAiInput {
  documentId: string
  prompt: string
}

export interface AskAiResult {
  answer: string
  references: SemanticSearchResult[]
}

export type DocumentBlockAiEditMode = 'summarize' | 'rewrite' | 'table' | 'custom'

export interface PreviewDocumentBlockAiEditInput {
  documentId: string
  documentTitle: string
  documentPath: string
  documentSummary: string
  selectedBlocks: DocumentBlockDraft[]
  mode: DocumentBlockAiEditMode
  instruction?: string
}

export interface PreviewDocumentBlockAiEditResult {
  documentId: string
  mode: DocumentBlockAiEditMode
  instruction: string
  replacementText: string
}

export interface RunDocumentAiAutomationsResult {
  summaryGenerated: boolean
}

export interface SetPluginEnabledInput {
  pluginId: string
  enabled: boolean
}

export interface RunPluginDocumentActionInput {
  pluginId: string
  actionId: string
  documentId: string
}

export interface RunPluginDocumentActionResult {
  message: string
  refreshDocument: boolean
}

export interface UpdatePluginSettingInput {
  pluginId: string
  settingId: string
  value: PluginSettingValue
}

export interface ElectronApi {
  getHomeData: () => Promise<HomeData>
  getPluginHomeData: () => Promise<PluginHomeData>
  onWorkspaceMutated: (listener: () => void) => () => void
  onPluginsMutated: (listener: () => void) => () => void
  getAppUpdateState: () => Promise<AppUpdateState>
  checkForAppUpdates: () => Promise<AppUpdateState>
  installAppUpdate: () => Promise<void>
  getDocumentDetail: (documentId: string) => Promise<DocumentDetail | null>
  clipWebPage: (input: ClipWebPageInput) => Promise<ClipWebPageResult>
  getWebClipBridgeStatus: () => Promise<WebClipBridgeStatus>
  updateWebClipBridgeSettings: (input: UpdateWebClipBridgeSettingsInput) => Promise<WebClipBridgeStatus>
  createDocument: (parentId: string | null) => Promise<CreateDocumentResult>
  getDocumentCatalog: (databaseId?: string | null) => Promise<DocumentCatalogEntry[]>
  getDocumentDatabaseColumns: (databaseId?: string | null) => Promise<DocumentDatabaseColumn[]>
  createDocumentDatabaseColumn: (input: CreateDocumentDatabaseColumnInput) => Promise<DocumentDatabaseColumn>
  renameDocumentDatabaseColumn: (input: RenameDocumentDatabaseColumnInput) => Promise<void>
  moveDocumentDatabaseColumn: (input: MoveDocumentDatabaseColumnInput) => Promise<void>
  updateDocumentDatabaseColumnOptions: (input: UpdateDocumentDatabaseColumnOptionsInput) => Promise<void>
  deleteDocumentDatabaseColumn: (columnId: string) => Promise<void>
  updateDocumentDatabaseValue: (input: UpdateDocumentDatabaseValueInput) => Promise<void>
  updateDocument: (documentId: string, input: UpdateDocumentInput) => Promise<UpdateDocumentResult>
  deleteDocument: (documentId: string) => Promise<void>
  moveDocument: (documentId: string, newParentId: string | null) => Promise<void>
  updateAiConfig: (input: UpdateAiConfigInput) => Promise<void>
  searchSemanticNotes: (input: SearchSemanticNotesInput) => Promise<SemanticSearchResult[]>
  askAiAboutDocument: (input: AskAiInput) => Promise<AskAiResult>
  previewDocumentBlockAiEdit: (input: PreviewDocumentBlockAiEditInput) => Promise<PreviewDocumentBlockAiEditResult>
  runDocumentAiAutomations: (documentId: string) => Promise<RunDocumentAiAutomationsResult>
  setPluginEnabled: (input: SetPluginEnabledInput) => Promise<void>
  reloadPlugins: () => Promise<void>
  reloadPlugin: (pluginId: string) => Promise<void>
  installPluginFromFolder: () => Promise<InstallPluginResult | null>
  removePlugin: (pluginId: string) => Promise<void>
  updatePluginSetting: (input: UpdatePluginSettingInput) => Promise<void>
  runPluginDocumentAction: (input: RunPluginDocumentActionInput) => Promise<RunPluginDocumentActionResult>
  triggerBackup: () => Promise<BackupResult>
  restoreBackupFromFolder: () => Promise<BackupRestoreResult | null>
  writeClipboardText: (text: string) => Promise<void>
  openExternalUrl: (url: string) => Promise<void>
  saveMarkdownFile: (defaultFileName: string, content: string) => Promise<string | null>
  getSetting: (key: string) => Promise<string | null>
  saveSetting: (key: string, value: string) => Promise<void>
  createDocumentDatabase: (input: CreateDatabaseInput) => Promise<DocumentDatabase>
  updateDatabaseMetadata: (input: UpdateDatabaseMetadataInput) => Promise<DocumentDatabase>
  getDatabases: () => Promise<DocumentDatabase[]>
  deleteDatabase: (databaseId: string) => Promise<void>
  getDatabaseSavedViews: (databaseId: string) => Promise<DatabaseSavedView[]>
  createDatabaseSavedView: (input: CreateDatabaseSavedViewInput) => Promise<DatabaseSavedView>
  updateDatabaseSavedView: (input: UpdateDatabaseSavedViewInput) => Promise<DatabaseSavedView>
  deleteDatabaseSavedView: (viewId: string) => Promise<void>
  createDatabaseEntity: (input: CreateDatabaseEntityInput) => Promise<DatabaseEntity>
  updateDatabaseEntity: (input: UpdateDatabaseEntityInput) => Promise<void>
  updateDatabaseEntities: (input: UpdateDatabaseEntitiesInput) => Promise<void>
  deleteDatabaseEntity: (entityId: string) => Promise<void>
  deleteDatabaseEntities: (input: DeleteDatabaseEntitiesInput) => Promise<void>
  getDatabaseEntities: (databaseId: string) => Promise<DatabaseEntity[]>
  searchDocuments: (query: string) => Promise<GlobalSearchResult[]>
  getBlockReference: (documentPath: string, blockId: string) => Promise<BlockReferenceResult | null>
  getDocumentSuggestions: (query: string, excludeDocumentId?: string | null) => Promise<DocumentSuggestion[]>
}

declare global {
  interface Window {
    knowbook: ElectronApi
  }
}

export {}
