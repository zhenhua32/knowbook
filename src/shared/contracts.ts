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

export interface DocumentCatalogEntry {
  id: string
  title: string
  path: string
  summary: string
  parentId: string | null
  parentTitle: string | null
  updatedAt: string
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

export interface DeleteDatabaseEntityInput {
  entityId: string
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

export interface WorkspaceGraphNode {
  id: string
  title: string
  path: string
  depth: number
}

export interface WorkspaceGraphEdge {
  sourceId: string
  targetId: string
  kind: 'tree' | 'link'
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
  embeddingBaseUrl: string
  model: string
  embeddingModel: string
  autoSummaryOnSave: boolean
  hasApiKey: boolean
  hasEmbeddingApiKey: boolean
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

export type PluginStatus = 'running' | 'disabled' | 'error'

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

export interface HomeData {
  summary: WorkspaceSummary
  recentDocuments: RecentDocument[]
  recentEvents: WorkspaceEventRecord[]
  documentCatalog: DocumentCatalogEntry[]
  databaseColumns: DocumentDatabaseColumn[]
  aiConfig: AiConfig
  documentTree: DocumentTreeNode[]
  graph: {
    nodes: WorkspaceGraphNode[]
    edges: WorkspaceGraphEdge[]
  }
  initialDocumentId: string | null
  plugins?: PluginDescriptor[]
  pluginDashboardCards?: PluginDashboardCard[]
  pluginDocumentActions?: PluginDocumentAction[]
  pluginHost?: PluginHostInfo
}

export interface BackupResult {
  exported: number
  root: string
  at: string
}

export interface CreateDocumentResult {
  id: string
}

export interface UpdateDocumentInput {
  title: string
  summary: string
  blocks: DocumentBlockDraft[]
}

export interface CreateDocumentDatabaseColumnInput {
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

export interface UpdateAiConfigInput {
  enabled: boolean
  baseUrl: string
  embeddingBaseUrl?: string
  embeddingApiKey?: string
  model: string
  embeddingModel: string
  autoSummaryOnSave: boolean
  apiKey?: string
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
  getDocumentDetail: (documentId: string) => Promise<DocumentDetail | null>
  createDocument: (parentId: string | null) => Promise<CreateDocumentResult>
  getDocumentDatabaseColumns: (databaseId?: string | null) => Promise<DocumentDatabaseColumn[]>
  createDocumentDatabaseColumn: (input: CreateDocumentDatabaseColumnInput) => Promise<DocumentDatabaseColumn>
  renameDocumentDatabaseColumn: (input: RenameDocumentDatabaseColumnInput) => Promise<void>
  moveDocumentDatabaseColumn: (input: MoveDocumentDatabaseColumnInput) => Promise<void>
  updateDocumentDatabaseColumnOptions: (input: UpdateDocumentDatabaseColumnOptionsInput) => Promise<void>
  deleteDocumentDatabaseColumn: (columnId: string) => Promise<void>
  updateDocumentDatabaseValue: (input: UpdateDocumentDatabaseValueInput) => Promise<void>
  updateDocument: (documentId: string, input: UpdateDocumentInput) => Promise<void>
  deleteDocument: (documentId: string) => Promise<void>
  moveDocument: (documentId: string, newParentId: string | null) => Promise<void>
  updateAiConfig: (input: UpdateAiConfigInput) => Promise<void>
  searchSemanticNotes: (input: SearchSemanticNotesInput) => Promise<SemanticSearchResult[]>
  askAiAboutDocument: (input: AskAiInput) => Promise<AskAiResult>
  runDocumentAiAutomations: (documentId: string) => Promise<RunDocumentAiAutomationsResult>
  setPluginEnabled: (input: SetPluginEnabledInput) => Promise<void>
  reloadPlugins: () => Promise<void>
  reloadPlugin: (pluginId: string) => Promise<void>
  installPluginFromFolder: () => Promise<InstallPluginResult | null>
  removePlugin: (pluginId: string) => Promise<void>
  updatePluginSetting: (input: UpdatePluginSettingInput) => Promise<void>
  runPluginDocumentAction: (input: RunPluginDocumentActionInput) => Promise<RunPluginDocumentActionResult>
  triggerBackup: () => Promise<BackupResult>
  writeClipboardText: (text: string) => Promise<void>
  saveMarkdownFile: (defaultFileName: string, content: string) => Promise<string | null>
  getSetting: (key: string) => Promise<string | null>
  saveSetting: (key: string, value: string) => Promise<void>
  createDocumentDatabase: (input: CreateDatabaseInput) => Promise<DocumentDatabase>
  getDatabases: () => Promise<DocumentDatabase[]>
  createDatabaseEntity: (input: CreateDatabaseEntityInput) => Promise<DatabaseEntity>
  updateDatabaseEntity: (input: UpdateDatabaseEntityInput) => Promise<void>
  deleteDatabaseEntity: (entityId: string) => Promise<void>
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