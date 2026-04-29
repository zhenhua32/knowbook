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
  updatedAt: string
  blockCount: number
  linkCount: number
  childCount: number
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
}

export interface DocumentBlockDraft {
  type: string
  content: string
  checked: boolean
  depth: number
}

export interface LinkedDocument {
  id: string
  title: string
  path: string
  label: string
}

export interface DocumentSuggestion {
  id: string
  title: string
  path: string
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
  updateDocument: (documentId: string, input: UpdateDocumentInput) => Promise<void>
  deleteDocument: (documentId: string) => Promise<void>
  moveDocument: (documentId: string, newParentId: string | null) => Promise<void>
  updateAiConfig: (input: UpdateAiConfigInput) => Promise<void>
  askAiAboutDocument: (input: AskAiInput) => Promise<AskAiResult>
  getDocumentSuggestions: (query: string, excludeDocumentId?: string | null) => Promise<DocumentSuggestion[]>
  triggerBackup: () => Promise<BackupResult>
}

declare global {
  interface Window {
    knowbook: ElectronApi
  }
}

export {}