import { contextBridge, ipcRenderer } from 'electron'
import type { BackupResult, DocumentDetail, ElectronApi, HomeData } from '@shared/contracts'

const api: ElectronApi = {
  getHomeData: () => ipcRenderer.invoke('knowbook:get-home-data') as Promise<HomeData>,
  getDocumentDetail: (documentId: string) => ipcRenderer.invoke('knowbook:get-document-detail', documentId) as Promise<DocumentDetail | null>,
  triggerBackup: () => ipcRenderer.invoke('knowbook:trigger-backup') as Promise<BackupResult>
}

contextBridge.exposeInMainWorld('knowbook', api)