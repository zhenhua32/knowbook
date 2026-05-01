import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import type {
  AskAiInput,
  AskAiResult,
  BackupResult,
  CreateDocumentDatabaseColumnInput,
  DocumentDatabaseColumn,
  DocumentDetail,
  DocumentSuggestion,
  GlobalSearchResult,
  HomeData,
  MoveDocumentDatabaseColumnInput,
  RenameDocumentDatabaseColumnInput,
  SearchSemanticNotesInput,
  SemanticSearchResult,
  UpdateDocumentDatabaseColumnOptionsInput,
  UpdateAiConfigInput,
  UpdateDocumentDatabaseValueInput,
  UpdateDocumentInput
} from '@shared/contracts'
import { MarkdownBackupService } from './backup/exporter'
import { KnowbookStore, type SemanticSearchCandidate } from './database/store'
import { createWorkspaceEventRecord, WorkspaceEventBus } from './event-bus'

const BACKUP_INTERVAL_MS = 5 * 60 * 1000

let mainWindow: BrowserWindow | null = null
let backupTimer: NodeJS.Timeout | null = null
let embeddingSyncQueue: Promise<void> = Promise.resolve()

const userDataRoot = app.getPath('userData')
const databasePath = join(userDataRoot, 'storage', 'knowbook.db')
const backupRoot = join(userDataRoot, 'backups', 'markdown')
const store = new KnowbookStore(databasePath)
const backupService = new MarkdownBackupService(store, backupRoot)
const workspaceEventBus = new WorkspaceEventBus()

type SemanticContextNote = SemanticSearchResult & {
  content: string
  contentHash: string
}

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

function registerWorkspaceEventHandlers(): void {
  workspaceEventBus.subscribe((event) => {
    const record = createWorkspaceEventRecord(event)
    store.recordWorkspaceEvent(record)
  })

  workspaceEventBus.subscribe((event) => {
    switch (event.type) {
      case 'document.created':
        queueEmbeddingSyncForDocuments([event.documentId])
        break
      case 'document.updated':
      case 'document.moved':
      case 'document.deleted':
        queueEmbeddingSyncForDocuments(event.affectedDocumentIds)
        break
      case 'ai.config.updated':
        queueEmbeddingBackfill(event.embeddingModelChanged ? event.previousEmbeddingModel : null)
        break
    }
  })
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

  ipcMain.handle('knowbook:create-document', async (_event, parentId: string | null) => {
    const id = store.createDocument(parentId)
    const document = store.getDocumentSnapshot(id)
    if (document) {
      await workspaceEventBus.emit({
        type: 'document.created',
        createdAt: new Date().toISOString(),
        documentId: document.id,
        documentTitle: document.title,
        path: document.path,
        parentId: document.parentId
      })
    }
    return { id }
  })

  ipcMain.handle('knowbook:create-document-database-column', (_event, input: CreateDocumentDatabaseColumnInput) => {
    const column: DocumentDatabaseColumn = store.createDocumentDatabaseColumn(input)
    return column
  })

  ipcMain.handle('knowbook:rename-document-database-column', (_event, input: RenameDocumentDatabaseColumnInput) => {
    store.renameDocumentDatabaseColumn(input)
  })

  ipcMain.handle('knowbook:move-document-database-column', (_event, input: MoveDocumentDatabaseColumnInput) => {
    store.moveDocumentDatabaseColumn(input)
  })

  ipcMain.handle('knowbook:update-document-database-column-options', (_event, input: UpdateDocumentDatabaseColumnOptionsInput) => {
    store.updateDocumentDatabaseColumnOptions(input)
  })

  ipcMain.handle('knowbook:delete-document-database-column', (_event, columnId: string) => {
    store.deleteDocumentDatabaseColumn(columnId)
  })

  ipcMain.handle('knowbook:update-document-database-value', (_event, input: UpdateDocumentDatabaseValueInput) => {
    store.updateDocumentDatabaseValue(input)
  })

  ipcMain.handle('knowbook:update-document', async (_event, documentId: string, input: UpdateDocumentInput) => {
    const beforeDocument = store.getDocumentSnapshot(documentId)
    const affectedDocumentIds = store.updateDocument(documentId, input)
    const afterDocument = store.getDocumentSnapshot(documentId)

    if (beforeDocument && afterDocument) {
      await workspaceEventBus.emit({
        type: 'document.updated',
        createdAt: new Date().toISOString(),
        documentId: afterDocument.id,
        documentTitle: afterDocument.title,
        path: afterDocument.path,
        affectedDocumentIds,
        pathChanged: beforeDocument.path !== afterDocument.path
      })
    }
  })

  ipcMain.handle('knowbook:delete-document', async (_event, documentId: string) => {
    const document = store.getDocumentSnapshot(documentId)
    const affectedDocumentIds = store.deleteDocument(documentId)

    if (document) {
      await workspaceEventBus.emit({
        type: 'document.deleted',
        createdAt: new Date().toISOString(),
        documentId: document.id,
        documentTitle: document.title,
        oldPath: document.path,
        affectedDocumentIds
      })
    }
  })

  ipcMain.handle('knowbook:move-document', async (_event, documentId: string, newParentId: string | null) => {
    const beforeDocument = store.getDocumentSnapshot(documentId)
    const affectedDocumentIds = store.moveDocument(documentId, newParentId)
    const afterDocument = store.getDocumentSnapshot(documentId)

    if (beforeDocument && afterDocument) {
      await workspaceEventBus.emit({
        type: 'document.moved',
        createdAt: new Date().toISOString(),
        documentId: afterDocument.id,
        documentTitle: afterDocument.title,
        oldPath: beforeDocument.path,
        newPath: afterDocument.path,
        affectedDocumentIds
      })
    }
  })

  ipcMain.handle('knowbook:update-ai-config', async (_event, input: UpdateAiConfigInput) => {
    const previousConfig = store.getHomeData(backupRoot).aiConfig
    store.updateAiConfig(input)
    const nextEmbeddingModel = input.embeddingModel.trim() || 'text-embedding-3-small'
    const nextModel = input.model.trim() || 'gpt-4.1-mini'

    await workspaceEventBus.emit({
      type: 'ai.config.updated',
      createdAt: new Date().toISOString(),
      model: nextModel,
      embeddingModel: nextEmbeddingModel,
      previousEmbeddingModel: previousConfig.embeddingModel,
      embeddingModelChanged: previousConfig.embeddingModel !== nextEmbeddingModel,
      aiEnabled: input.enabled
    })
  })

  ipcMain.handle('knowbook:search-semantic-notes', async (_event, input: SearchSemanticNotesInput) => {
    return searchSemanticNotes(input)
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

  ipcMain.handle('knowbook:save-markdown-file', async (event, defaultFileName: string, content: string): Promise<string | null> => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined
    const saveDialogOptions = {
      title: '导出 Markdown',
      defaultPath: join(app.getPath('documents'), sanitizeMarkdownFileName(defaultFileName)),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      showsTagField: false,
      showOverwriteConfirmation: true
    }
    const result = targetWindow
      ? await dialog.showSaveDialog(targetWindow, saveDialogOptions)
      : await dialog.showSaveDialog(saveDialogOptions)

    if (result.canceled || !result.filePath) {
      return null
    }

    mkdirSync(dirname(result.filePath), { recursive: true })
    writeFileSync(result.filePath, content, 'utf8')
    return result.filePath
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

  let relatedNotes: SemanticContextNote[] = []
  try {
    relatedNotes = await buildSemanticContextNotes({
      query: input.prompt,
      excludeDocumentId: input.documentId,
      limit: 4
    }, home.aiConfig, apiKey)
  } catch (error) {
    console.warn('Semantic retrieval failed. Falling back to current document only.', error)
  }

  const prompt = store.buildAiPrompt(input, relatedNotes)
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

  return {
    answer,
    references: relatedNotes.map(({ content, contentHash, ...note }) => note)
  }
}

async function searchSemanticNotes(input: SearchSemanticNotesInput): Promise<SemanticSearchResult[]> {
  const home = store.getHomeData(backupRoot)
  if (!home.aiConfig.enabled) {
    throw new Error('AI is disabled. Enable AI in settings first.')
  }

  const apiKey = store.getAiApiKey()
  if (!apiKey) {
    throw new Error('Missing API key. Save an API key in AI settings.')
  }

  const notes = await buildSemanticContextNotes(input, home.aiConfig, apiKey)
  return notes.map(({ content, contentHash, ...note }) => note)
}

async function buildSemanticContextNotes(
  input: SearchSemanticNotesInput,
  aiConfig: HomeData['aiConfig'],
  apiKey: string
): Promise<SemanticContextNote[]> {
  const query = input.query.trim()
  if (!query) {
    return []
  }

  const candidates = store.getSemanticSearchCandidates({
    excludeDocumentId: input.excludeDocumentId ?? null
  })
  if (candidates.length === 0) {
    return []
  }

  await ensureDocumentEmbeddings(candidates, aiConfig, apiKey)
  const [queryEmbedding] = await createEmbeddings([query], aiConfig.baseUrl, apiKey, aiConfig.embeddingModel)
  if (!queryEmbedding) {
    return []
  }

  const normalizedLimit = Math.min(Math.max(input.limit ?? 4, 1), 8)
  const scored = candidates
    .map((candidate) => {
      const embedding = store.getCachedDocumentEmbedding(candidate.documentId, aiConfig.embeddingModel, candidate.contentHash)
      if (!embedding) {
        return null
      }

      return {
        ...candidate,
        score: cosineSimilarity(queryEmbedding, embedding)
      }
    })
    .filter((candidate): candidate is SemanticSearchCandidate & { score: number } => candidate !== null)
    .sort((left, right) => right.score - left.score)

  if (scored.length === 0) {
    return []
  }

  const topMatches = scored.slice(0, normalizedLimit)
  const filteredMatches = topMatches.filter((candidate) => candidate.score > 0.08)
  const finalMatches = filteredMatches.length > 0 ? filteredMatches : topMatches.slice(0, 1).filter((candidate) => candidate.score > 0)

  return finalMatches.map((candidate) => ({
    documentId: candidate.documentId,
    title: candidate.title,
    path: candidate.path,
    summary: candidate.summary,
    snippet: candidate.snippet,
    score: Number(candidate.score.toFixed(3)),
    content: candidate.content,
    contentHash: candidate.contentHash
  }))
}

async function ensureDocumentEmbeddings(
  candidates: SemanticSearchCandidate[],
  aiConfig: HomeData['aiConfig'],
  apiKey: string
): Promise<void> {
  const staleCandidates = candidates.filter((candidate) => {
    return !store.getCachedDocumentEmbedding(candidate.documentId, aiConfig.embeddingModel, candidate.contentHash)
  })

  if (staleCandidates.length === 0) {
    return
  }

  const chunks = chunkArray(staleCandidates, 20)
  for (const chunk of chunks) {
    const embeddings = await createEmbeddings(
      chunk.map((candidate) => candidate.content),
      aiConfig.baseUrl,
      apiKey,
      aiConfig.embeddingModel
    )

    embeddings.forEach((embedding, index) => {
      const candidate = chunk[index]
      if (!candidate) {
        return
      }
      store.saveDocumentEmbedding(candidate.documentId, aiConfig.embeddingModel, candidate.contentHash, embedding)
    })
  }
}

function queueEmbeddingSyncForDocuments(documentIds: string[]): void {
  const uniqueDocumentIds = [...new Set(documentIds.filter((documentId) => documentId.trim().length > 0))]
  if (uniqueDocumentIds.length === 0) {
    return
  }

  embeddingSyncQueue = embeddingSyncQueue
    .catch(() => undefined)
    .then(async () => {
      for (const documentId of uniqueDocumentIds) {
        try {
          await syncEmbeddingForDocument(documentId)
        } catch (error) {
          console.warn(`Failed to sync embedding for document ${documentId}.`, error)
        }
      }
    })
}

function queueEmbeddingBackfill(staleModel: string | null = null): void {
  embeddingSyncQueue = embeddingSyncQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        await backfillAllEmbeddings(staleModel)
      } catch (error) {
        console.warn('Failed to backfill embeddings after AI config change.', error)
      }
    })
}

async function syncEmbeddingForDocument(documentId: string): Promise<void> {
  const home = store.getHomeData(backupRoot)
  if (!home.aiConfig.enabled) {
    return
  }

  const apiKey = store.getAiApiKey()
  if (!apiKey) {
    return
  }

  const candidate = store.getSemanticSearchCandidates().find((item) => item.documentId === documentId)
  if (!candidate) {
    store.deleteDocumentEmbeddings(documentId)
    return
  }

  if (store.getCachedDocumentEmbedding(candidate.documentId, home.aiConfig.embeddingModel, candidate.contentHash)) {
    return
  }

  const [embedding] = await createEmbeddings(
    [candidate.content],
    home.aiConfig.baseUrl,
    apiKey,
    home.aiConfig.embeddingModel
  )

  if (!embedding) {
    return
  }

  store.saveDocumentEmbedding(candidate.documentId, home.aiConfig.embeddingModel, candidate.contentHash, embedding)
}

async function backfillAllEmbeddings(staleModel: string | null = null): Promise<void> {
  const home = store.getHomeData(backupRoot)
  if (!home.aiConfig.enabled) {
    return
  }

  const apiKey = store.getAiApiKey()
  if (!apiKey) {
    return
  }

  if (staleModel && staleModel !== home.aiConfig.embeddingModel) {
    store.deleteEmbeddingsByModel(staleModel)
  }

  const candidates = store.getSemanticSearchCandidates()
  if (candidates.length === 0) {
    return
  }

  await ensureDocumentEmbeddings(candidates, home.aiConfig, apiKey)
}

async function createEmbeddings(
  inputs: string[],
  baseUrl: string,
  apiKey: string,
  embeddingModel: string
): Promise<number[][]> {
  if (inputs.length === 0) {
    return []
  }

  const endpoint = `${baseUrl.replace(/\/$/, '')}/embeddings`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: inputs
    })
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Embedding request failed (${response.status}): ${errorBody}`)
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>
  }
  const embeddings = payload.data?.map((item) => item.embedding ?? []) ?? []
  if (embeddings.length !== inputs.length || embeddings.some((embedding) => embedding.length === 0)) {
    throw new Error('Embedding response was incomplete.')
  }

  return embeddings
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0
  }

  let dotProduct = 0
  let leftNorm = 0
  let rightNorm = 0

  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0
  }

  return dotProduct / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function sanitizeMarkdownFileName(fileName: string): string {
  const normalized = fileName
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')

  if (!normalized) {
    return 'document.md'
  }

  return normalized.toLowerCase().endsWith('.md') ? normalized : `${normalized}.md`
}

function startBackupSchedule(): void {
  void backupService.exportAll()
  backupTimer = setInterval(() => {
    backupService.exportAll()
  }, BACKUP_INTERVAL_MS)
}

app.whenReady().then(() => {
  registerWorkspaceEventHandlers()
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