import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import type { OpenDialogOptions } from 'electron'
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
  InstallPluginResult,
  MoveDocumentDatabaseColumnInput,
  RenameDocumentDatabaseColumnInput,
  RunPluginDocumentActionInput,
  RunPluginDocumentActionResult,
  RunDocumentAiAutomationsResult,
  SearchSemanticNotesInput,
  SemanticSearchResult,
  SetPluginEnabledInput,
  UpdateDocumentDatabaseColumnOptionsInput,
  UpdateAiConfigInput,
  UpdateDocumentDatabaseValueInput,
  UpdateDocumentInput
} from '@shared/contracts'
import { MarkdownBackupService } from './backup/exporter'
import { DEFAULT_DOCUMENT_SUMMARY, KnowbookStore, type SemanticSearchCandidate } from './database/store'
import { createWorkspaceEventRecord, WorkspaceEventBus } from './event-bus'
import { PluginHost } from './plugin-host'

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
const pluginHost = new PluginHost(store, [
  { path: join(process.cwd(), 'plugins'), source: 'workspace' },
  { path: join(userDataRoot, 'plugins'), source: 'user-data' }
])

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

  workspaceEventBus.subscribe(async (event) => {
    await pluginHost.handleWorkspaceEvent(event)
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

  workspaceEventBus.subscribe(async (event) => {
    if (event.type !== 'document.updated') {
      return
    }

    const aiConfig = store.getAiConfigPublic()
    if (!aiConfig.enabled || !aiConfig.autoSummaryOnSave) {
      return
    }

    const apiKey = store.getAiApiKey()
    if (!apiKey) {
      return
    }

    const detail = store.getDocumentDetail(event.documentId)
    if (!detail || !shouldGenerateSummary(detail.summary, detail.blocks.map((block) => block.content))) {
      return
    }

    const generatedSummary = await generateDocumentSummary(detail, aiConfig, apiKey)
    if (!generatedSummary || generatedSummary === detail.summary.trim()) {
      return
    }

    store.updateDocumentSummary(detail.id, generatedSummary)
    await workspaceEventBus.emit({
      type: 'document.summary.generated',
      createdAt: new Date().toISOString(),
      documentId: detail.id,
      documentTitle: detail.title,
      path: detail.path,
      summary: generatedSummary
    })
  })

  workspaceEventBus.subscribe(async (event) => {
    if (event.type !== 'document.updated') {
      return
    }

    const aiConfig = store.getAiConfigPublic()
    if (!aiConfig.enabled || !aiConfig.autoTagOnSave) {
      return
    }

    const apiKey = store.getAiApiKey()
    if (!apiKey) {
      return
    }

    const detail = store.getDocumentDetail(event.documentId)
    if (!detail) {
      return
    }

    const tagUpdates = await generateMissingBlockTags(detail, aiConfig, apiKey)
    if (tagUpdates.length === 0) {
      return
    }

    store.updateDocumentBlockTags(detail.id, tagUpdates)
    await workspaceEventBus.emit({
      type: 'document.tags.generated',
      createdAt: new Date().toISOString(),
      documentId: detail.id,
      documentTitle: detail.title,
      path: detail.path,
      taggedBlocks: tagUpdates.length,
      tagsAdded: tagUpdates.reduce((count, update) => count + update.tags.length, 0)
    })
  })

  workspaceEventBus.subscribe(async (event) => {
    if (event.type !== 'document.updated') {
      return
    }

    const aiConfig = store.getAiConfigPublic()
    if (!aiConfig.enabled || !aiConfig.autoHighlightOnSave) {
      return
    }

    const apiKey = store.getAiApiKey()
    if (!apiKey) {
      return
    }

    const detail = store.getDocumentDetail(event.documentId)
    if (!detail) {
      return
    }

    const highlightUpdates = await generateMissingBlockHighlights(detail, aiConfig, apiKey)
    if (highlightUpdates.length === 0) {
      return
    }

    store.updateDocumentBlockHighlights(detail.id, highlightUpdates)
    await workspaceEventBus.emit({
      type: 'document.highlights.generated',
      createdAt: new Date().toISOString(),
      documentId: detail.id,
      documentTitle: detail.title,
      path: detail.path,
      highlightedBlocks: highlightUpdates.length
    })
  })
}

function registerIpcHandlers(): void {
  ipcMain.handle('knowbook:get-home-data', () => {
    const pluginData = pluginHost.getHomeDataSnapshot()
    const data: HomeData = {
      ...store.getHomeData(backupRoot),
      plugins: pluginData.plugins,
      pluginDashboardCards: pluginData.dashboardCards,
      pluginDocumentActions: pluginData.documentActions,
      pluginHost: pluginData.host
    }
    return data
  })

  ipcMain.handle('knowbook:get-document-detail', (_event, documentId: string) => {
    const document: DocumentDetail | null = store.getDocumentDetail(documentId)
    return document
  })

  ipcMain.handle('knowbook:get-block-reference', (_event, documentPath: string, blockId: string) => {
    const result = store.getBlockReference(documentPath, blockId)
    return result
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

  ipcMain.handle('knowbook:create-document-database', (_event, input: CreateDatabaseInput) => {
    const database: DocumentDatabase = store.createDatabase(input)
    return database
  })

  ipcMain.handle('knowbook:get-databases', () => {
    const databases: DocumentDatabase[] = store.getDatabases()
    return databases
  })

  ipcMain.handle('knowbook:create-database-entity', (_event, input: CreateDatabaseEntityInput) => {
    const entity: DatabaseEntity = store.createDatabaseEntity(input)
    return entity
  })

  ipcMain.handle('knowbook:update-database-entity', (_event, input: UpdateDatabaseEntityInput) => {
    store.updateDatabaseEntity(input)
  })

  ipcMain.handle('knowbook:delete-database-entity', (_event, entityId: string) => {
    store.deleteDatabaseEntity(entityId)
  })

  ipcMain.handle('knowbook:get-database-entities', (_event, databaseId: string) => {
    const entities: DatabaseEntity[] = store.getDatabaseEntities(databaseId)
    return entities
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

  ipcMain.handle('knowbook:run-document-ai-automations', async (_event, documentId: string) => {
    const result = await runDocumentAiAutomations(documentId)
    return result
  })

  ipcMain.handle('knowbook:set-plugin-enabled', async (_event, input: SetPluginEnabledInput) => {
    await pluginHost.setPluginEnabled(input.pluginId, input.enabled)
  })

  ipcMain.handle('knowbook:reload-plugins', async () => {
    await pluginHost.reloadAll()
    store.recordWorkspaceEvent({
      type: 'plugin.reloaded',
      title: 'Plugins reloaded',
      description: 'Rescanned plugin roots and refreshed active plugin contributions.'
    })
  })

  ipcMain.handle('knowbook:reload-plugin', async (_event, pluginId: string) => {
    await pluginHost.reloadPlugin(pluginId)
  })

  ipcMain.handle('knowbook:install-plugin-from-folder', async (event): Promise<InstallPluginResult | null> => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined
    const openDialogOptions: OpenDialogOptions = {
      title: '选择插件文件夹',
      buttonLabel: '安装插件',
      properties: ['openDirectory']
    }
    const result = targetWindow
      ? await dialog.showOpenDialog(targetWindow, openDialogOptions)
      : await dialog.showOpenDialog(openDialogOptions)

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const preview = pluginHost.previewInstallFromDirectory(result.filePaths[0])
    if (preview.existingPlugin?.source === 'workspace') {
      throw new Error(`Plugin id "${preview.manifest.id}" is already provided by the workspace plugin "${preview.existingPlugin.name}".`)
    }

    let replaceExisting = false
    if (preview.canReplace && preview.existingPlugin) {
      const replaceResult = targetWindow
        ? await dialog.showMessageBox(targetWindow, {
            type: 'question',
            title: 'Replace installed plugin?',
            message: `Replace plugin "${preview.existingPlugin.name}"?`,
            detail: `Installed version: ${preview.existingPlugin.version}\nNew version: ${preview.manifest.version}\n\nThis will replace the existing user-data plugin with the selected folder contents.`,
            buttons: ['Replace', 'Cancel'],
            defaultId: 0,
            cancelId: 1
          })
        : await dialog.showMessageBox({
            type: 'question',
            title: 'Replace installed plugin?',
            message: `Replace plugin "${preview.existingPlugin.name}"?`,
            detail: `Installed version: ${preview.existingPlugin.version}\nNew version: ${preview.manifest.version}\n\nThis will replace the existing user-data plugin with the selected folder contents.`,
            buttons: ['Replace', 'Cancel'],
            defaultId: 0,
            cancelId: 1
          })

      if (replaceResult.response !== 0) {
        return null
      }

      replaceExisting = true
    }

    return pluginHost.installPluginFromDirectory(result.filePaths[0], { replaceExisting })
  })

  ipcMain.handle('knowbook:remove-plugin', async (_event, pluginId: string) => {
    await pluginHost.removePlugin(pluginId)
  })

  ipcMain.handle('knowbook:run-plugin-document-action', async (_event, input: RunPluginDocumentActionInput) => {
    const result: RunPluginDocumentActionResult = await pluginHost.runDocumentAction(input)
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

async function runDocumentAiAutomations(documentId: string): Promise<RunDocumentAiAutomationsResult> {
  const home = store.getHomeData(backupRoot)
  if (!home.aiConfig.enabled) {
    throw new Error('AI is disabled. Enable AI in settings first.')
  }

  if (!home.aiConfig.autoSummaryOnSave && !home.aiConfig.autoTagOnSave && !home.aiConfig.autoHighlightOnSave) {
    throw new Error('No AI automations are enabled. Enable at least one automation in AI settings first.')
  }

  const apiKey = store.getAiApiKey()
  if (!apiKey) {
    throw new Error('Missing API key. Save an API key in AI settings.')
  }

  let detail = store.getDocumentDetail(documentId)
  if (!detail) {
    throw new Error('Document not found.')
  }

  const result: RunDocumentAiAutomationsResult = {
    summaryGenerated: false,
    taggedBlocks: 0,
    highlightedBlocks: 0
  }

  if (home.aiConfig.autoSummaryOnSave && shouldGenerateSummary(detail.summary, detail.blocks.map((block) => block.content))) {
    const generatedSummary = await generateDocumentSummary(detail, home.aiConfig, apiKey)
    if (generatedSummary && generatedSummary !== detail.summary.trim()) {
      store.updateDocumentSummary(detail.id, generatedSummary)
      detail = {
        ...detail,
        summary: generatedSummary
      }
      result.summaryGenerated = true
      await workspaceEventBus.emit({
        type: 'document.summary.generated',
        createdAt: new Date().toISOString(),
        documentId: detail.id,
        documentTitle: detail.title,
        path: detail.path,
        summary: generatedSummary
      })
    }
  }

  if (home.aiConfig.autoTagOnSave) {
    const tagUpdates = await generateMissingBlockTags(detail, home.aiConfig, apiKey)
    if (tagUpdates.length > 0) {
      store.updateDocumentBlockTags(detail.id, tagUpdates)
      const tagsById = new Map(tagUpdates.map((update) => [update.blockId, update.tags]))
      detail = {
        ...detail,
        blocks: detail.blocks.map((block) =>
          tagsById.has(block.id)
            ? {
                ...block,
                tags: tagsById.get(block.id)
              }
            : block
        )
      }
      result.taggedBlocks = tagUpdates.length
      await workspaceEventBus.emit({
        type: 'document.tags.generated',
        createdAt: new Date().toISOString(),
        documentId: detail.id,
        documentTitle: detail.title,
        path: detail.path,
        taggedBlocks: tagUpdates.length,
        tagsAdded: tagUpdates.reduce((count, update) => count + update.tags.length, 0)
      })
    }
  }

  if (home.aiConfig.autoHighlightOnSave) {
    const highlightUpdates = await generateMissingBlockHighlights(detail, home.aiConfig, apiKey)
    if (highlightUpdates.length > 0) {
      store.updateDocumentBlockHighlights(detail.id, highlightUpdates)
      result.highlightedBlocks = highlightUpdates.length
      await workspaceEventBus.emit({
        type: 'document.highlights.generated',
        createdAt: new Date().toISOString(),
        documentId: detail.id,
        documentTitle: detail.title,
        path: detail.path,
        highlightedBlocks: highlightUpdates.length
      })
    }
  }

  return result
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

async function generateDocumentSummary(
  detail: DocumentDetail,
  aiConfig: HomeData['aiConfig'],
  apiKey: string
): Promise<string | null> {
  const content = detail.blocks
    .map((block) => block.content.trim())
    .filter((blockContent) => blockContent.length > 0)
    .slice(0, 24)
    .join('\n')

  if (content.length < 40) {
    return null
  }

  const endpoint = `${aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: aiConfig.model,
      messages: [
        {
          role: 'system',
          content: 'You summarize notes for a knowledge management app. Produce one concise Chinese summary sentence with no markdown, no bullet points, and no surrounding quotes.'
        },
        {
          role: 'user',
          content: [
            `Document title: ${detail.title}`,
            `Document path: ${detail.path}`,
            'Document content:',
            content,
            '',
            'Return a compact summary in Chinese, ideally under 60 Chinese characters.'
          ].join('\n')
        }
      ],
      temperature: 0.2
    })
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`AI summary request failed (${response.status}): ${errorBody}`)
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const summary = payload.choices?.[0]?.message?.content?.trim() ?? ''
  const normalizedSummary = summary
    .replace(/[\r\n]+/g, ' ')
    .replace(/[“”"'`]/g, '')
    .replace(/^[-*\d.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)

  return normalizedSummary || null
}

function shouldGenerateSummary(summary: string, blockContents: string[]): boolean {
  const normalizedSummary = summary.trim()
  if (normalizedSummary && normalizedSummary !== DEFAULT_DOCUMENT_SUMMARY) {
    return false
  }

  const contentLength = blockContents
    .map((content) => content.trim())
    .filter((content) => content.length > 0)
    .join(' ')
    .trim()
    .length

  return contentLength >= 40
}

async function generateMissingBlockTags(
  detail: DocumentDetail,
  aiConfig: HomeData['aiConfig'],
  apiKey: string
): Promise<Array<{ blockId: string, tags: string[] }>> {
  const candidates = detail.blocks
    .filter((block) => (block.tags?.length ?? 0) === 0)
    .filter((block) => block.type !== 'divider')
    .map((block) => ({
      blockId: block.id,
      type: block.type,
      content: block.content.trim()
    }))
    .filter((block) => block.content.length >= 12)
    .slice(0, 12)

  if (candidates.length === 0) {
    return []
  }

  const endpoint = `${aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: aiConfig.model,
      messages: [
        {
          role: 'system',
          content: 'You assign concise topical tags to note blocks. Return strict JSON only with the shape {"blocks":[{"id":"block-id","tags":["tag1","tag2"]}]}. Reuse only the provided ids, assign 1-3 tags per block, avoid generic tags like note, text, or knowledge, and do not add explanations.'
        },
        {
          role: 'user',
          content: [
            `Document title: ${detail.title}`,
            `Document path: ${detail.path}`,
            `Document summary: ${detail.summary}`,
            '',
            'Blocks needing tags:',
            ...candidates.map((block) => `[${block.blockId}] (${block.type}) ${block.content}`),
            '',
            'Return JSON only.'
          ].join('\n')
        }
      ],
      temperature: 0.2
    })
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`AI tag request failed (${response.status}): ${errorBody}`)
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const rawContent = payload.choices?.[0]?.message?.content?.trim() ?? ''
  if (!rawContent) {
    return []
  }

  const cleanedJson = rawContent.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(cleanedJson)
  } catch {
    return []
  }

  const blocks = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && 'blocks' in parsed && Array.isArray((parsed as { blocks?: unknown }).blocks)
      ? (parsed as { blocks: unknown[] }).blocks
      : []

  const candidateIds = new Set(candidates.map((block) => block.blockId))
  const updates = new Map<string, string[]>()
  for (const entry of blocks) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const blockId = typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : ''
    if (!candidateIds.has(blockId)) {
      continue
    }

    const rawTags = Array.isArray((entry as { tags?: unknown }).tags) ? (entry as { tags: unknown[] }).tags : []
    const normalizedTags = rawTags
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.replace(/^#+/, '').replace(/\s+/g, ' ').trim())
      .filter((tag) => tag.length > 0 && tag.length <= 24)
      .slice(0, 3)

    if (normalizedTags.length > 0) {
      updates.set(blockId, [...new Set(normalizedTags)])
    }
  }

  return [...updates.entries()].map(([blockId, tags]) => ({ blockId, tags }))
}

async function generateMissingBlockHighlights(
  detail: DocumentDetail,
  aiConfig: HomeData['aiConfig'],
  apiKey: string
): Promise<Array<{ blockId: string, highlight: string }>> {
  const allowedColors = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'])
  const candidates = detail.blocks
    .filter((block) => !block.highlight)
    .filter((block) => block.type !== 'divider')
    .map((block) => ({
      blockId: block.id,
      type: block.type,
      content: block.content.trim(),
      tags: block.tags ?? []
    }))
    .filter((block) => block.content.length >= 18)
    .slice(0, 14)

  if (candidates.length === 0) {
    return []
  }

  const endpoint = `${aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: aiConfig.model,
      messages: [
        {
          role: 'system',
          content: 'You choose highlight colors for note blocks so a human can scan the most important content faster. Return strict JSON only with the shape {"blocks":[{"id":"block-id","highlight":"yellow"}]}. Use only the colors red, orange, yellow, green, blue, purple, gray. Return at most 6 blocks, skip unimportant blocks, reuse only the provided ids, and do not include explanations.'
        },
        {
          role: 'user',
          content: [
            `Document title: ${detail.title}`,
            `Document path: ${detail.path}`,
            `Document summary: ${detail.summary}`,
            '',
            'Candidate blocks with no highlight:',
            ...candidates.map((block) => `[${block.blockId}] (${block.type}) tags=${block.tags.join(', ') || 'none'} :: ${block.content}`),
            '',
            'Prefer highlights for key decisions, important references, warnings, action items, or high-signal ideas. Return JSON only.'
          ].join('\n')
        }
      ],
      temperature: 0.2
    })
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`AI highlight request failed (${response.status}): ${errorBody}`)
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const rawContent = payload.choices?.[0]?.message?.content?.trim() ?? ''
  if (!rawContent) {
    return []
  }

  const cleanedJson = rawContent.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(cleanedJson)
  } catch {
    return []
  }

  const blocks = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && 'blocks' in parsed && Array.isArray((parsed as { blocks?: unknown }).blocks)
      ? (parsed as { blocks: unknown[] }).blocks
      : []

  const candidateIds = new Set(candidates.map((block) => block.blockId))
  const updates = new Map<string, string>()
  for (const entry of blocks) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const blockId = typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : ''
    const highlight = typeof (entry as { highlight?: unknown }).highlight === 'string'
      ? (entry as { highlight: string }).highlight.trim().toLowerCase()
      : ''

    if (!candidateIds.has(blockId) || !allowedColors.has(highlight)) {
      continue
    }

    updates.set(blockId, highlight)
  }

  return [...updates.entries()].map(([blockId, highlight]) => ({ blockId, highlight }))
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

app.whenReady().then(async () => {
  await pluginHost.loadAll()
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
  void pluginHost.destroy()
  store.destroy()
})