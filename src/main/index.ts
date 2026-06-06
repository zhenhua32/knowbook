import { mkdirSync, readFileSync, writeFileSync, createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import electron from 'electron'
import type { OpenDialogOptions } from 'electron'
import { fileURLToPath } from 'node:url'
import type {
  AskAiInput,
  AskAiResult,
  BackupResult,
  BackupRestoreResult,
  ClipWebPageInput,
  ClipWebPageResult,
  ImportWebClipPayloadInput,
  CreateDatabaseInput,
  CreateDatabaseEntityInput,
  CreateDatabaseSavedViewInput,
  CreateDocumentDatabaseColumnInput,
  DatabaseEntity,
  DatabaseSavedView,
  DeleteDatabaseEntityInput,
  DocumentDatabase,
  DocumentCatalogEntry,
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
  UpdatePluginSettingInput,
  UpdateAiConfigInput,
  UpdateWebClipBridgeSettingsInput,
  UpdateDatabaseSavedViewInput,
  UpdateDatabaseEntityInput,
  UpdateDocumentDatabaseColumnOptionsInput,
  UpdateDocumentDatabaseValueInput,
  UpdateDocumentInput,
  WebClipBridgeStatus
} from '@shared/contracts'
import { scoreKeywordSearchCandidate } from '@shared/semantic-search'
import { MarkdownBackupService } from './backup/exporter'
import { MarkdownRestoreService } from './backup/importer'
import { DEFAULT_DOCUMENT_SUMMARY, KnowbookStore } from './database/store'
import { createWorkspaceEventRecord, WorkspaceEventBus } from './event-bus'
import { PluginHost } from './plugin-host'
import { AppUpdateManager } from './update-manager'
import { WebClipBridgeService } from './web-clip-bridge'
import { WebClipperService } from './web-clipper'

const { app, BrowserWindow, clipboard, dialog, ipcMain, shell, protocol } = electron
type ElectronBrowserWindow = InstanceType<typeof BrowserWindow>

const BACKUP_INTERVAL_MS = 5 * 60 * 1000
const WORKSPACE_MUTATED_CHANNEL = 'knowbook:workspace-mutated'
const KNOWBOOK_ASSET_PREVIEW_SCHEME = 'knowbook-asset'
const WEB_CLIP_BRIDGE_ENABLED_KEY = 'webclip.bridge.enabled'
const WEB_CLIP_BRIDGE_PORT_KEY = 'webclip.bridge.port'
const WEB_CLIP_BRIDGE_TOKEN_KEY = 'webclip.bridge.token'
const DEFAULT_WEB_CLIP_BRIDGE_PORT = 3210

protocol.registerSchemesAsPrivileged([
  {
    scheme: KNOWBOOK_ASSET_PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

let mainWindow: ElectronBrowserWindow | null = null
let backupTimer: NodeJS.Timeout | null = null

const userDataRoot = app.getPath('userData')
const databasePath = join(userDataRoot, 'storage', 'knowbook.db')
const backupRoot = join(userDataRoot, 'backups', 'markdown')
const webClipAssetRoot = join(userDataRoot, 'storage', 'assets')
const store = new KnowbookStore(databasePath)
const backupService = new MarkdownBackupService(store, backupRoot)
const restoreService = new MarkdownRestoreService(store)
const workspaceEventBus = new WorkspaceEventBus()
const webClipper = new WebClipperService(store, webClipAssetRoot)
const webClipBridge = new WebClipBridgeService({
  onImport: async (payload: ImportWebClipPayloadInput) => {
    const result = await webClipper.importWebClipPayload(payload)
    await emitClipMutationEvents(result)
    notifyWorkspaceMutation()
    return result
  }
})
const pluginHost = new PluginHost(store, [
  { path: join(process.cwd(), 'plugins'), source: 'workspace' },
  { path: join(userDataRoot, 'plugins'), source: 'user-data' }
])
const appUpdateManager = new AppUpdateManager()

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

  ipcMain.handle('knowbook:get-app-update-state', () => {
    return appUpdateManager.getState()
  })

  ipcMain.handle('knowbook:check-for-app-updates', async () => {
    return appUpdateManager.checkForUpdates()
  })

  ipcMain.handle('knowbook:install-app-update', () => {
    appUpdateManager.installUpdate()
  })

  ipcMain.handle('knowbook:get-document-detail', (_event, documentId: string) => {
    const document: DocumentDetail | null = store.getDocumentDetail(documentId)
    return document
  })

  ipcMain.handle('knowbook:clip-web-page', async (_event, input: ClipWebPageInput) => {
    const result: ClipWebPageResult = await webClipper.clipWebPage(input)
    await emitClipMutationEvents(result)
    return result
  })

  ipcMain.handle('knowbook:get-web-clip-bridge-status', () => {
    return webClipBridge.getStatus()
  })

  ipcMain.handle('knowbook:update-web-clip-bridge-settings', async (_event, input: UpdateWebClipBridgeSettingsInput) => {
    return updateWebClipBridgeSettings(input)
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

  ipcMain.handle('knowbook:get-document-database-columns', (_event, databaseId: string | null = null) => {
    const columns: DocumentDatabaseColumn[] = store.getDocumentDatabaseColumns(databaseId ?? undefined)
    return columns
  })

  ipcMain.handle('knowbook:get-document-catalog', (_event, databaseId: string | null = null) => {
    const entries: DocumentCatalogEntry[] = store.getDocumentCatalog(databaseId ?? undefined)
    return entries
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

  ipcMain.handle('knowbook:create-document-database', (_event, input: CreateDatabaseInput) => {
    const database: DocumentDatabase = store.createDatabase(input)
    return database
  })

  ipcMain.handle('knowbook:get-databases', () => {
    const databases: DocumentDatabase[] = store.getDatabases()
    return databases
  })

  ipcMain.handle('knowbook:delete-database', (_event, databaseId: string) => {
    store.deleteDatabase(databaseId)
  })

  ipcMain.handle('knowbook:get-database-saved-views', (_event, databaseId: string) => {
    const views: DatabaseSavedView[] = store.getDatabaseSavedViews(databaseId)
    return views
  })

  ipcMain.handle('knowbook:create-database-saved-view', (_event, input: CreateDatabaseSavedViewInput) => {
    const view: DatabaseSavedView = store.createDatabaseSavedView(input)
    return view
  })

  ipcMain.handle('knowbook:update-database-saved-view', (_event, input: UpdateDatabaseSavedViewInput) => {
    const view: DatabaseSavedView = store.updateDatabaseSavedView(input)
    return view
  })

  ipcMain.handle('knowbook:delete-database-saved-view', (_event, viewId: string) => {
    store.deleteDatabaseSavedView(viewId)
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
    store.updateAiConfig(input)
    const nextModel = input.model.trim() || 'gpt-4.1-mini'

    await workspaceEventBus.emit({
      type: 'ai.config.updated',
      createdAt: new Date().toISOString(),
      model: nextModel,
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

  ipcMain.handle('knowbook:update-plugin-setting', async (_event, input: UpdatePluginSettingInput) => {
    await pluginHost.updatePluginSetting(input.pluginId, input.settingId, input.value)
  })

  ipcMain.handle('knowbook:run-plugin-document-action', async (_event, input: RunPluginDocumentActionInput) => {
    const result: RunPluginDocumentActionResult = await pluginHost.runDocumentAction(input)
    return result
  })

  ipcMain.handle('knowbook:trigger-backup', () => {
    const result: BackupResult = backupService.exportAll()
    return result
  })

  ipcMain.handle('knowbook:restore-backup-from-folder', async (event): Promise<BackupRestoreResult | null> => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined
    const openDialogOptions: OpenDialogOptions = {
      title: '选择备份目录',
      buttonLabel: '恢复备份',
      properties: ['openDirectory']
    }
    const result = targetWindow
      ? await dialog.showOpenDialog(targetWindow, openDialogOptions)
      : await dialog.showOpenDialog(openDialogOptions)

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return restoreService.restoreFromDirectory(result.filePaths[0])
  })

  ipcMain.handle('knowbook:write-clipboard-text', (_event, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('knowbook:open-external-url', async (_event, url: string) => {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
      throw new Error('Unsupported external URL protocol.')
    }

    await shell.openExternal(parsed.toString())
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

async function emitClipMutationEvents(result: ClipWebPageResult): Promise<void> {
  if (!result.created) {
    return
  }

  const document = store.getDocumentSnapshot(result.documentId)
  if (!document) {
    return
  }

  await workspaceEventBus.emit({
    type: 'document.created',
    createdAt: new Date().toISOString(),
    documentId: document.id,
    documentTitle: document.title,
    path: document.path,
    parentId: document.parentId
  })
  await workspaceEventBus.emit({
    type: 'document.updated',
    createdAt: new Date().toISOString(),
    documentId: document.id,
    documentTitle: document.title,
    path: document.path,
    affectedDocumentIds: [document.id],
    pathChanged: false
  })
}

function notifyWorkspaceMutation(): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(WORKSPACE_MUTATED_CHANNEL)
  })
}

function getStoredWebClipBridgeConfig(): { enabled: boolean; port: number; token: string } {
  const enabled = store.getSettingPublic(WEB_CLIP_BRIDGE_ENABLED_KEY) === 'true'
  const storedPort = Number.parseInt(store.getSettingPublic(WEB_CLIP_BRIDGE_PORT_KEY) ?? `${DEFAULT_WEB_CLIP_BRIDGE_PORT}`, 10)
  const existingToken = store.getSettingPublic(WEB_CLIP_BRIDGE_TOKEN_KEY)
  const token = existingToken ?? randomUUID().replace(/-/g, '')

  if (!existingToken) {
    store.saveSetting(WEB_CLIP_BRIDGE_TOKEN_KEY, token)
  }

  return {
    enabled,
    port: Number.isFinite(storedPort) && storedPort > 0 ? storedPort : DEFAULT_WEB_CLIP_BRIDGE_PORT,
    token
  }
}

async function updateWebClipBridgeSettings(input: UpdateWebClipBridgeSettingsInput): Promise<WebClipBridgeStatus> {
  const current = getStoredWebClipBridgeConfig()
  const nextPort = Number.isFinite(input.port) && input.port > 0 ? Math.trunc(input.port) : DEFAULT_WEB_CLIP_BRIDGE_PORT
  const nextToken = input.regenerateToken ? randomUUID().replace(/-/g, '') : current.token

  store.saveSetting(WEB_CLIP_BRIDGE_ENABLED_KEY, input.enabled ? 'true' : 'false')
  store.saveSetting(WEB_CLIP_BRIDGE_PORT_KEY, `${nextPort}`)
  store.saveSetting(WEB_CLIP_BRIDGE_TOKEN_KEY, nextToken)

  return webClipBridge.applyConfig({
    enabled: input.enabled,
    port: nextPort,
    token: nextToken
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
    })
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

  if (!home.aiConfig.autoSummaryOnSave) {
    throw new Error('Auto summary is disabled. Enable summary automation in AI settings first.')
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
    summaryGenerated: false
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

  return result
}

async function searchSemanticNotes(input: SearchSemanticNotesInput): Promise<SemanticSearchResult[]> {
  const notes = await buildSemanticContextNotes(input)
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

async function buildSemanticContextNotes(
  input: SearchSemanticNotesInput
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

  const normalizedLimit = Math.min(Math.max(input.limit ?? 4, 1), 8)

  const scored = candidates
    .map((candidate) => {
      const text = (candidate.title + ' ' + candidate.summary + ' ' + candidate.content + ' ' + candidate.snippet).toLowerCase()
      const score = scoreKeywordSearchCandidate(query, text)
      return { ...candidate, score }
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)

  const topMatches = scored.slice(0, normalizedLimit)
  return topMatches.map((candidate) => ({
    documentId: candidate.documentId,
    title: candidate.title,
    path: candidate.path,
    summary: candidate.summary,
    snippet: candidate.snippet,
    score: candidate.score,
    content: candidate.content,
    contentHash: candidate.contentHash
  }))
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

function registerAssetPreviewProtocol(): void {
  protocol.handle(KNOWBOOK_ASSET_PREVIEW_SCHEME, (request) => {
    try {
      const requestUrl = new URL(request.url)
      const source = requestUrl.searchParams.get('source')
      if (!source) {
        return new Response('Missing asset source.', { status: 400 })
      }

      const sourceUrl = new URL(source)
      if (sourceUrl.protocol !== 'file:') {
        return new Response('Unsupported asset source.', { status: 400 })
      }

      const assetPath = resolve(fileURLToPath(sourceUrl))
      const allowedRoot = resolve(webClipAssetRoot)
      const normalizedAssetPath = process.platform === 'win32' ? assetPath.toLowerCase() : assetPath
      const normalizedAllowedRoot = process.platform === 'win32' ? allowedRoot.toLowerCase() : allowedRoot
      const allowedPrefix = `${normalizedAllowedRoot}${sep}`

      if (normalizedAssetPath !== normalizedAllowedRoot && !normalizedAssetPath.startsWith(allowedPrefix)) {
        return new Response('Asset path is outside the managed web clip asset root.', { status: 403 })
      }

      const stream = createReadStream(assetPath)
      const body = Readable.toWeb(stream) as ReadableStream
      return new Response(body, {
        status: 200,
        headers: {
          'cache-control': 'public, max-age=31536000, immutable',
          'content-type': getAssetContentType(assetPath)
        }
      })
    } catch (error) {
      console.warn('Failed to resolve local web clip asset preview.', error)
      return new Response('Asset preview failed.', { status: 404 })
    }
  })
}

function getAssetContentType(filePath: string): string {
  const extension = extname(filePath).toLowerCase()

  switch (extension) {
    case '.gif':
      return 'image/gif'
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.svg':
      return 'image/svg+xml'
    case '.webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}

app.whenReady().then(async () => {
  registerAssetPreviewProtocol()
  await pluginHost.loadAll()
  appUpdateManager.initialize()
  registerWorkspaceEventHandlers()
  registerIpcHandlers()
  await webClipBridge.applyConfig(getStoredWebClipBridgeConfig())
  createWindow()
  startBackupSchedule()
  appUpdateManager.scheduleStartupCheck()

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
  void webClipBridge.destroy()
  void pluginHost.destroy()
  store.destroy()
})