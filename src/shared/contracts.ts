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

export interface DocumentTreeNode {
  id: string
  title: string
  path: string
  updatedAt: string
  children: DocumentTreeNode[]
}

export interface DocumentBlock {
  type: string
  content: string
  sortOrder: number
}

export interface DocumentBlockDraft {
  type: string
  content: string
}

export interface LinkedDocument {
  id: string
  title: string
  path: string
  label: string
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
}

export interface HomeData {
  summary: WorkspaceSummary
  recentDocuments: RecentDocument[]
  aiConfig: AiConfig
  documentTree: DocumentTreeNode[]
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
}

export interface ElectronApi {
  getHomeData: () => Promise<HomeData>
  getDocumentDetail: (documentId: string) => Promise<DocumentDetail | null>
  createDocument: (parentId: string | null) => Promise<CreateDocumentResult>
  updateDocument: (documentId: string, input: UpdateDocumentInput) => Promise<void>
  deleteDocument: (documentId: string) => Promise<void>
  moveDocument: (documentId: string, newParentId: string | null) => Promise<void>
  updateAiConfig: (input: UpdateAiConfigInput) => Promise<void>
  triggerBackup: () => Promise<BackupResult>
}

declare global {
  interface Window {
    knowbook: ElectronApi
  }
}

export {}