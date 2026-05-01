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
  hasApiKey: boolean
}

export interface HomeData {
  summary: WorkspaceSummary
  recentDocuments: RecentDocument[]
  documentCatalog: DocumentCatalogEntry[]
  databaseColumns: DocumentDatabaseColumn[]
  aiConfig: AiConfig
  documentTree: DocumentTreeNode[]
  graph: {
    nodes: WorkspaceGraphNode[]
    edges: WorkspaceGraphEdge[]
  }
  initialDocumentId: string | null
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
  model: string
  apiKey?: string
}

export interface AskAiInput {
  documentId: string
  prompt: string
}

export interface AskAiResult {
  answer: string
}

export interface ElectronApi {
  getHomeData: () => Promise<HomeData>
  getDocumentDetail: (documentId: string) => Promise<DocumentDetail | null>
  createDocument: (parentId: string | null) => Promise<CreateDocumentResult>
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
  askAiAboutDocument: (input: AskAiInput) => Promise<AskAiResult>
  getDocumentSuggestions: (query: string, excludeDocumentId?: string | null) => Promise<DocumentSuggestion[]>
  searchDocuments: (query: string) => Promise<GlobalSearchResult[]>
  triggerBackup: () => Promise<BackupResult>
  writeClipboardText: (text: string) => Promise<void>
  saveMarkdownFile: (defaultFileName: string, content: string) => Promise<string | null>
  getSetting: (key: string) => Promise<string | null>
  saveSetting: (key: string, value: string) => Promise<void>
}

declare global {
  interface Window {
    knowbook: ElectronApi
  }
}

export {}