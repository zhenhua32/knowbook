import { contextBridge, ipcRenderer } from 'electron'
import type { BackupResult, CreateDocumentResult, DocumentDetail, ElectronApi, HomeData, UpdateDocumentInput } from '@shared/contracts'

const api: ElectronApi = {
  getHomeData: () => ipcRenderer.invoke('knowbook:get-home-data') as Promise<HomeData>,
  getDocumentDetail: (documentId: string) => ipcRenderer.invoke('knowbook:get-document-detail', documentId) as Promise<DocumentDetail | null>,
  createDocument: (parentId: string | null) => ipcRenderer.invoke('knowbook:create-document', parentId) as Promise<CreateDocumentResult>,
  updateDocument: (documentId: string, input: UpdateDocumentInput) => ipcRenderer.invoke('knowbook:update-document', documentId, input) as Promise<void>,
  triggerBackup: () => ipcRenderer.invoke('knowbook:trigger-backup') as Promise<BackupResult>
}

contextBridge.exposeInMainWorld('knowbook', api)