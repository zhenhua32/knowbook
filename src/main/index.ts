import { join } from 'node:path'
import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import type {
  AskAiInput,
  AskAiResult,
  BackupResult,
  DocumentDetail,
  DocumentSuggestion,
  GlobalSearchResult,
  HomeData,
  UpdateAiConfigInput,
  UpdateDocumentInput
} from '@shared/contracts'
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

  ipcMain.handle('knowbook:get-document-suggestions', (_event, query: string, excludeDocumentId: string | null = null) => {
    const suggestions: DocumentSuggestion[] = store.getDocumentSuggestions(query, excludeDocumentId)
    return suggestions
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

  ipcMain.handle('knowbook:ask-ai-about-document', async (_event, input: AskAiInput) => {
    const result = await askAiAboutDocument(input)
    return result
  })

  ipcMain.handle('knowbook:trigger-backup', () => {
    const result: BackupResult = backupService.exportAll()
    return result
  })

  ipcMain.handle('knowbook:write-clipboard-text', (_event, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('knowbook:search-documents', (_event, query: string): GlobalSearchResult[] => {
    return store.searchDocuments(query)
  })

  ipcMain.handle('knowbook:get-setting', (_event, key: string): string | null => {
    return store.getSettingPublic(key)
  })

  ipcMain.handle('knowbook:save-setting', (_event, key: string, value: string): void => {
    store.saveSetting(key, value)
  })
}

async function askAiAboutDocument(input: AskAiInput): Promise<AskAiResult> {
  const home = store.getHomeData(backupRoot)
  if (!home.aiConfig.enabled) {
    throw new Error('AI is disabled. Enable AI in settings first.')
  }

  const apiKey = store.getAiApiKey()
  if (!apiKey) {
    throw new Error('Missing API key. Save an API key in AI settings.')
  }

  const prompt = store.buildAiPrompt(input)
  const endpoint = `${home.aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: home.aiConfig.model,
      messages: [
        {
          role: 'system',
          content: 'You are an assistant helping users organize and improve their notes.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3
    })
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`AI request failed (${response.status}): ${errorBody}`)
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const answer = payload.choices?.[0]?.message?.content?.trim()

  if (!answer) {
    throw new Error('AI returned an empty response.')
  }

  return { answer }
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