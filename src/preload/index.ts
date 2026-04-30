import { contextBridge, ipcRenderer } from 'electron'
import type {
  AskAiInput,
  AskAiResult,
  BackupResult,
  CreateDocumentResult,
  DocumentDetail,
  DocumentSuggestion,
  ElectronApi,
  GlobalSearchResult,
  HomeData,
  UpdateAiConfigInput,
  UpdateDocumentInput
} from '@shared/contracts'

const api: ElectronApi = {
  getHomeData: () => ipcRenderer.invoke('knowbook:get-home-data') as Promise<HomeData>,
  getDocumentDetail: (documentId: string) => ipcRenderer.invoke('knowbook:get-document-detail', documentId) as Promise<DocumentDetail | null>,
  getDocumentSuggestions: (query: string, excludeDocumentId?: string | null) => ipcRenderer.invoke('knowbook:get-document-suggestions', query, excludeDocumentId ?? null) as Promise<DocumentSuggestion[]>,
  createDocument: (parentId: string | null) => ipcRenderer.invoke('knowbook:create-document', parentId) as Promise<CreateDocumentResult>,
  updateDocument: (documentId: string, input: UpdateDocumentInput) => ipcRenderer.invoke('knowbook:update-document', documentId, input) as Promise<void>,
  deleteDocument: (documentId: string) => ipcRenderer.invoke('knowbook:delete-document', documentId) as Promise<void>,
  moveDocument: (documentId: string, newParentId: string | null) => ipcRenderer.invoke('knowbook:move-document', documentId, newParentId) as Promise<void>,
  updateAiConfig: (input: UpdateAiConfigInput) => ipcRenderer.invoke('knowbook:update-ai-config', input) as Promise<void>,
  askAiAboutDocument: (input: AskAiInput) => ipcRenderer.invoke('knowbook:ask-ai-about-document', input) as Promise<AskAiResult>,
  triggerBackup: () => ipcRenderer.invoke('knowbook:trigger-backup') as Promise<BackupResult>,
  writeClipboardText: (text: string) => ipcRenderer.invoke('knowbook:write-clipboard-text', text) as Promise<void>,
  searchDocuments: (query: string) => ipcRenderer.invoke('knowbook:search-documents', query) as Promise<GlobalSearchResult[]>
}

contextBridge.exposeInMainWorld('knowbook', api)