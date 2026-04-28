import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { BackupResult, DocumentDetail, HomeData, UpdateAiConfigInput, UpdateDocumentInput } from '@shared/contracts'
import { MarkdownBackupService } from './backup/exporter'
import { KnowbookStore } from './database/store'

const BACKUP_INTERVAL_MS = 5 * 60 * 1000

let mainWindow: BrowserWindow | null = null
let backupTimer: NodeJS.Timeout | null = null

const userDataRoot = app.getPath('userData')
const databasePath = join(userDataRoot, 'storage', 'knowbook.db')
const backupRoot = join(userDataRoot, 'backups', 'markdown')
const store = new KnowbookStore(databasePath)
const backupService = new MarkdownBackupService(store, backupRoot)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#f4f0e8',
    title: 'KnowBook',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('knowbook:get-home-data', () => {
    const data: HomeData = store.getHomeData(backupRoot)
    return data
  })

  ipcMain.handle('knowbook:get-document-detail', (_event, documentId: string) => {
    const document: DocumentDetail | null = store.getDocumentDetail(documentId)
    return document
  })

  ipcMain.handle('knowbook:create-document', (_event, parentId: string | null) => {
    const id = store.createDocument(parentId)
    return { id }
  })

  ipcMain.handle('knowbook:update-document', (_event, documentId: string, input: UpdateDocumentInput) => {
    store.updateDocument(documentId, input)
  })

  ipcMain.handle('knowbook:delete-document', (_event, documentId: string) => {
    store.deleteDocument(documentId)
  })

  ipcMain.handle('knowbook:move-document', (_event, documentId: string, newParentId: string | null) => {
    store.moveDocument(documentId, newParentId)
  })

  ipcMain.handle('knowbook:update-ai-config', (_event, input: UpdateAiConfigInput) => {
    store.updateAiConfig(input)
  })

  ipcMain.handle('knowbook:trigger-backup', () => {
    const result: BackupResult = backupService.exportAll()
    return result
  })
}

function startBackupSchedule(): void {
  void backupService.exportAll()
  backupTimer = setInterval(() => {
    backupService.exportAll()
  }, BACKUP_INTERVAL_MS)
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()
  startBackupSchedule()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  backupService.exportAll()
  if (backupTimer) {
    clearInterval(backupTimer)
    backupTimer = null
  }
  store.destroy()
})