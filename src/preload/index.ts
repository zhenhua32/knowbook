import { contextBridge, ipcRenderer } from 'electron'
import type {
  AskAiInput,
  AskAiResult,
  BackupResult,
  CreateDocumentDatabaseColumnInput,
  CreateDocumentResult,
  DocumentDatabaseColumn,
  DocumentDetail,
  DocumentSuggestion,
  ElectronApi,
  GlobalSearchResult,
  HomeData,
  MoveDocumentDatabaseColumnInput,
  RenameDocumentDatabaseColumnInput,
  RunDocumentAiAutomationsResult,
  SearchSemanticNotesInput,
  SemanticSearchResult,
  UpdateDocumentDatabaseColumnOptionsInput,
  UpdateAiConfigInput,
  UpdateDocumentDatabaseValueInput,
  UpdateDocumentInput
} from '@shared/contracts'

const api: ElectronApi = {
  getHomeData: () => ipcRenderer.invoke('knowbook:get-home-data') as Promise<HomeData>,
  getDocumentDetail: (documentId: string) => ipcRenderer.invoke('knowbook:get-document-detail', documentId) as Promise<DocumentDetail | null>,
  getDocumentSuggestions: (query: string, excludeDocumentId?: string | null) => ipcRenderer.invoke('knowbook:get-document-suggestions', query, excludeDocumentId ?? null) as Promise<DocumentSuggestion[]>,
  createDocument: (parentId: string | null) => ipcRenderer.invoke('knowbook:create-document', parentId) as Promise<CreateDocumentResult>,
  createDocumentDatabaseColumn: (input: CreateDocumentDatabaseColumnInput) => ipcRenderer.invoke('knowbook:create-document-database-column', input) as Promise<DocumentDatabaseColumn>,
  renameDocumentDatabaseColumn: (input: RenameDocumentDatabaseColumnInput) => ipcRenderer.invoke('knowbook:rename-document-database-column', input) as Promise<void>,
  moveDocumentDatabaseColumn: (input: MoveDocumentDatabaseColumnInput) => ipcRenderer.invoke('knowbook:move-document-database-column', input) as Promise<void>,
  updateDocumentDatabaseColumnOptions: (input: UpdateDocumentDatabaseColumnOptionsInput) => ipcRenderer.invoke('knowbook:update-document-database-column-options', input) as Promise<void>,
  deleteDocumentDatabaseColumn: (columnId: string) => ipcRenderer.invoke('knowbook:delete-document-database-column', columnId) as Promise<void>,
  updateDocumentDatabaseValue: (input: UpdateDocumentDatabaseValueInput) => ipcRenderer.invoke('knowbook:update-document-database-value', input) as Promise<void>,
  updateDocument: (documentId: string, input: UpdateDocumentInput) => ipcRenderer.invoke('knowbook:update-document', documentId, input) as Promise<void>,
  deleteDocument: (documentId: string) => ipcRenderer.invoke('knowbook:delete-document', documentId) as Promise<void>,
  moveDocument: (documentId: string, newParentId: string | null) => ipcRenderer.invoke('knowbook:move-document', documentId, newParentId) as Promise<void>,
  updateAiConfig: (input: UpdateAiConfigInput) => ipcRenderer.invoke('knowbook:update-ai-config', input) as Promise<void>,
  searchSemanticNotes: (input: SearchSemanticNotesInput) => ipcRenderer.invoke('knowbook:search-semantic-notes', input) as Promise<SemanticSearchResult[]>,
  askAiAboutDocument: (input: AskAiInput) => ipcRenderer.invoke('knowbook:ask-ai-about-document', input) as Promise<AskAiResult>,
  runDocumentAiAutomations: (documentId: string) => ipcRenderer.invoke('knowbook:run-document-ai-automations', documentId) as Promise<RunDocumentAiAutomationsResult>,
  triggerBackup: () => ipcRenderer.invoke('knowbook:trigger-backup') as Promise<BackupResult>,
  writeClipboardText: (text: string) => ipcRenderer.invoke('knowbook:write-clipboard-text', text) as Promise<void>,
  saveMarkdownFile: (defaultFileName: string, content: string) => ipcRenderer.invoke('knowbook:save-markdown-file', defaultFileName, content) as Promise<string | null>,
  searchDocuments: (query: string) => ipcRenderer.invoke('knowbook:search-documents', query) as Promise<GlobalSearchResult[]>,
  getSetting: (key: string) => ipcRenderer.invoke('knowbook:get-setting', key) as Promise<string | null>,
  saveSetting: (key: string, value: string) => ipcRenderer.invoke('knowbook:save-setting', key, value) as Promise<void>
}

contextBridge.exposeInMainWorld('knowbook', api)