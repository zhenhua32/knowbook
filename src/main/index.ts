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
  BackupRestorePreview,
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
  DeleteDatabaseEntitiesInput,
  DocumentDatabase,
  DocumentCatalogEntry,
  DocumentDatabaseColumn,
  DocumentDetail,
  DocumentSuggestion,
  GlobalSearchResult,
  HomeData,
  InstallPluginResult,
  MoveDocumentDatabaseColumnInput,
  PreviewDocumentBlockAiEditInput,
  PreviewDocumentBlockAiEditResult,
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
  UpdateDatabaseMetadataInput,
  UpdateDatabaseEntityInput,
  UpdateDatabaseEntitiesInput,
  UpdateDocumentDatabaseColumnOptionsInput,
  UpdateDocumentDatabaseValueInput,
  UpdateDocumentInput,
  UpdateDocumentResult,
  WebClipBridgeStatus
} from '@shared/contracts'
import { scoreKeywordSearchCandidate } from '@shared/semantic-search'
import { buildDocumentSummarySource } from '@shared/ai-summary'
import {
  getDocumentSummarySourceVersion,
  normalizeDocumentBlockAiEditResponse,
  normalizeGeneratedDocumentSummary,
  requestAiChatCompletion,
  resolveDocumentBlockAiEditInstruction,
  shouldGenerateDocumentSummary
} from './ai-service'
import { MarkdownBackupService } from './backup/exporter'
import { runBackupExportInWorker } from './backup/worker-client'
import { MarkdownRestoreService } from './backup/importer'
import { DEFAULT_DOCUMENT_SUMMARY, KnowbookStore } from './database/store'
import { createWorkspaceEventRecord, WorkspaceEventBus } from './event-bus'
import { PluginHost } from './plugin-host'
import { ElectronPluginRuntime } from './plugin-runtime-client'
import { AppUpdateManager } from './update-manager'
import { WebClipBridgeService } from './web-clip-bridge'
import { WebClipperService } from './web-clipper'
import { CoalescedNotifier } from './coalesced-notifier'

const { app, BrowserWindow, clipboard, dialog, ipcMain: electronIpcMain, safeStorage, shell, protocol } = electron
type ElectronBrowserWindow = InstanceType<typeof BrowserWindow>

const BACKUP_INTERVAL_MS = 5 * 60 * 1000
const WORKSPACE_MUTATED_CHANNEL = 'knowbook:workspace-mutated'
const KNOWBOOK_ASSET_PREVIEW_SCHEME = 'knowbook-asset'
const WEB_CLIP_BRIDGE_ENABLED_KEY = 'webclip.bridge.enabled'
const WEB_CLIP_BRIDGE_PORT_KEY = 'webclip.bridge.port'
const WEB_CLIP_BRIDGE_TOKEN_KEY = 'webclip.bridge.token'
const DEFAULT_WEB_CLIP_BRIDGE_PORT = 3210
const WORKSPACE_MUTATION_NOTIFY_DELAY_MS = 25
const RENDERER_SETTING_KEYS = new Set(['pinned_documents', 'ui.language'])
const SAFE_STORAGE_KEY_PREFIX = 'safe-storage:v1:'

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

app.on('render-process-gone', (_event, _webContents, details) => {
  console.error('Renderer process exited unexpectedly.', details)
})

app.on('child-process-gone', (_event, details) => {
  console.error('Electron child process exited unexpectedly.', details)
})

let mainWindow: ElectronBrowserWindow | null = null
let backupTimer: NodeJS.Timeout | null = null
let shutdownComplete = false
let shutdownPromise: Promise<void> | null = null
const summaryGenerationRequests = new Map<string, {
  apiKey: string
  baseUrl: string
  controller: AbortController
  model: string
  promise: Promise<string | null>
  sourceVersion: string
}>()

const ipcMain: Pick<typeof electronIpcMain, 'handle'> = {
  handle(channel, listener) {
    electronIpcMain.handle(channel, (event, ...args) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new Error('IPC request rejected: untrusted renderer sender.')
      }
      return listener(event, ...args)
    })
  }
}

const workspaceMutationNotifier = new CoalescedNotifier(() => {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(WORKSPACE_MUTATED_CHANNEL)
    }
  })
}, WORKSPACE_MUTATION_NOTIFY_DELAY_MS)

if (process.env['KNOWBOOK_DISABLE_HARDWARE_ACCELERATION'] === '1') {
  app.disableHardwareAcceleration()
}

const userDataOverride = process.env['KNOWBOOK_USER_DATA_DIR']?.trim()
if (userDataOverride) {
  app.setPath('userData', resolve(userDataOverride))
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

const userDataRoot = app.getPath('userData')
const databasePath = join(userDataRoot, 'storage', 'knowbook.db')
const backupRoot = join(userDataRoot, 'backups', 'markdown')
const restoreSafetyBackupRoot = join(userDataRoot, 'backups', 'restore-safety')
const webClipAssetRoot = join(userDataRoot, 'storage', 'assets')
let store: KnowbookStore
let backupService: MarkdownBackupService
let restoreService: MarkdownRestoreService
let workspaceEventBus: WorkspaceEventBus
let webClipper: WebClipperService
let webClipBridge: WebClipBridgeService
let pluginHost: PluginHost
let appUpdateManager: AppUpdateManager
let servicesInitialized = false

function initializeServices(): void {
  store = new KnowbookStore(databasePath)
  backupService = new MarkdownBackupService(store, backupRoot, webClipAssetRoot, runBackupExportInWorker)
  restoreService = new MarkdownRestoreService(store, webClipAssetRoot)
  workspaceEventBus = new WorkspaceEventBus()
  webClipper = new WebClipperService(store, webClipAssetRoot, {
    allowPrivateNetwork: process.env['KNOWBOOK_ALLOW_PRIVATE_WEB_CLIP'] === '1'
  })
  webClipBridge = new WebClipBridgeService({
    onImport: async (payload: ImportWebClipPayloadInput) => {
      const result = await webClipper.importWebClipPayload(payload)
      await emitClipMutationEvents(result)
      notifyWorkspaceMutation()
      return result
    }
  })
  pluginHost = new PluginHost(store, [
    { path: join(process.cwd(), 'plugins'), source: 'workspace' },
    { path: join(userDataRoot, 'plugins'), source: 'user-data' }
  ], app.getVersion(), () => notifyWorkspaceMutation(), {
    runtimeFactory: (pluginId) => new ElectronPluginRuntime(pluginId),
    onStateChanged: () => notifyWorkspaceMutation()
  })
  appUpdateManager = new AppUpdateManager()
  servicesInitialized = true
}

function protectAiApiKey(apiKey: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    return apiKey
  }

  return `${SAFE_STORAGE_KEY_PREFIX}${safeStorage.encryptString(apiKey).toString('base64')}`
}

function getDecryptedAiApiKey(): string | null {
  const storedApiKey = store.getAiApiKey()
  if (!storedApiKey) {
    return null
  }

  if (!storedApiKey.startsWith(SAFE_STORAGE_KEY_PREFIX)) {
    if (safeStorage.isEncryptionAvailable()) {
      store.saveSetting('ai.apiKey', protectAiApiKey(storedApiKey))
    }
    return storedApiKey
  }

  try {
    return safeStorage.decryptString(Buffer.from(storedApiKey.slice(SAFE_STORAGE_KEY_PREFIX.length), 'base64'))
  } catch (error) {
    console.error('Failed to decrypt the stored AI API key.', error)
    return null
  }
}

function formatRestorePreviewDetail(preview: BackupRestorePreview): string {
  return [
    `文档：${preview.restored} 个（新建 ${preview.created}，更新 ${preview.updated}，删除 ${preview.deleted}）`,
    `独立数据库：${preview.standaloneDatabases} 个（新建 ${preview.standaloneDatabasesCreated}，更新 ${preview.standaloneDatabasesUpdated}，删除 ${preview.standaloneDatabasesDeleted}）`,
    `路径冲突：${preview.conflictsResolved} 个；父级占位：${preview.placeholdersCreated} 个`,
    '',
    '继续后会先创建数据库安全副本，再应用恢复内容。'
  ].join('\n')
}

async function createRestoreSafetyBackup(): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const destinationPath = join(restoreSafetyBackupRoot, `knowbook-before-restore-${timestamp}-${randomUUID()}.db`)
  await store.backupDatabase(destinationPath)
  return destinationPath
}

type SemanticContextNote = SemanticSearchResult & {
  content: string
  contentHash: string
}

function createWindow(): ElectronBrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#f3f5f9',
    title: 'KnowBook',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openManagedExternalUrl(url).catch((error) => {
      console.warn('Blocked or failed to open external URL.', error)
    })
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    void openManagedExternalUrl(url).catch((error) => {
      console.warn('Blocked or failed to navigate renderer to an external URL.', error)
    })
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

function registerWorkspaceEventHandlers(): void {
  workspaceEventBus.subscribe((event) => {
    const record = createWorkspaceEventRecord(event)
    store.recordWorkspaceEvent(record)
  })

  workspaceEventBus.subscribe((event) => {
    setImmediate(() => {
      void pluginHost.handleWorkspaceEvent(event).catch((error) => {
        console.warn('Plugin workspace event handling failed.', error)
      })
    })
  })

  workspaceEventBus.subscribe((event) => {
    if (event.type !== 'document.updated') {
      return
    }

    setImmediate(() => {
      void (async () => {
        const aiConfig = store.getAiConfigPublic()
        if (!aiConfig.enabled || !aiConfig.autoSummaryOnSave) {
          return
        }

        const apiKey = getDecryptedAiApiKey()
        if (!apiKey) {
          return
        }

        const detail = store.getDocumentDetail(event.documentId)
        if (!detail || !shouldGenerateDocumentSummary(
          detail.summary,
          detail.blocks.map((block) => block.content),
          DEFAULT_DOCUMENT_SUMMARY
        )) {
          cancelDocumentSummaryGeneration(event.documentId)
          return
        }

        const generatedSummary = await generateDocumentSummaryDeduplicated(detail, aiConfig, apiKey)
        if (!generatedSummary || generatedSummary === detail.summary.trim()) {
          return
        }

        const latestAiConfig = store.getAiConfigPublic()
        if (!latestAiConfig.enabled || !latestAiConfig.autoSummaryOnSave) {
          return
        }

        const updatedDetail = commitGeneratedSummaryIfCurrent(detail, generatedSummary)
        if (!updatedDetail) {
          return
        }

        await workspaceEventBus.emit({
          type: 'document.summary.generated',
          createdAt: new Date().toISOString(),
          documentId: updatedDetail.id,
          documentTitle: updatedDetail.title,
          path: updatedDetail.path,
          summary: generatedSummary
        })
        notifyWorkspaceMutation()
      })().catch((error) => {
        console.warn(`Automatic summary failed for document ${event.documentId}.`, error)
      })
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

  ipcMain.handle('knowbook:update-database-metadata', (_event, input: UpdateDatabaseMetadataInput) => {
    store.updateDatabaseMetadata(input)
    const updatedDatabase = store.getDatabases().find((database) => database.id === input.databaseId)
    if (!updatedDatabase) {
      throw new Error('Database not found after metadata update.')
    }
    return updatedDatabase
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

  ipcMain.handle('knowbook:update-database-entities', (_event, input: UpdateDatabaseEntitiesInput) => {
    store.updateDatabaseEntities(input)
  })

  ipcMain.handle('knowbook:delete-database-entity', (_event, entityId: string) => {
    store.deleteDatabaseEntity(entityId)
  })

  ipcMain.handle('knowbook:delete-database-entities', (_event, input: DeleteDatabaseEntitiesInput) => {
    store.deleteDatabaseEntities(input)
  })

  ipcMain.handle('knowbook:get-database-entities', (_event, databaseId: string) => {
    const entities: DatabaseEntity[] = store.getDatabaseEntities(databaseId)
    return entities
  })

  ipcMain.handle('knowbook:update-document', async (
    _event,
    documentId: string,
    input: UpdateDocumentInput
  ): Promise<UpdateDocumentResult> => {
    const beforeDocument = store.getDocumentSnapshot(documentId)
    const affectedDocumentIds = store.updateDocument(documentId, input)
    const afterDocument = store.getDocumentSnapshot(documentId)
    const pathChanged = beforeDocument?.path !== afterDocument?.path

    if (beforeDocument && afterDocument) {
      await workspaceEventBus.emit({
        type: 'document.updated',
        createdAt: new Date().toISOString(),
        documentId: afterDocument.id,
        documentTitle: afterDocument.title,
        path: afterDocument.path,
        affectedDocumentIds,
        pathChanged
      })
    }

    if (pathChanged) {
      const document = store.getDocumentDetail(documentId)
      if (!document) {
        throw new Error('Document not found')
      }
      return {
        requiresFullRefresh: true,
        document
      }
    }

    return store.getIncrementalDocumentUpdate(documentId, backupRoot)
  })

  ipcMain.handle('knowbook:delete-document', async (_event, documentId: string) => {
    const document = store.getDocumentSnapshot(documentId)
    cancelDocumentSummaryGeneration(documentId)
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
    store.updateAiConfig({
      ...input,
      apiKey: typeof input.apiKey === 'string' && input.apiKey.trim()
        ? protectAiApiKey(input.apiKey.trim())
        : input.apiKey
    })
    if (!input.enabled || !input.autoSummaryOnSave) {
      cancelAllDocumentSummaryGeneration()
    }
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

  ipcMain.handle('knowbook:preview-document-block-ai-edit', async (_event, input: PreviewDocumentBlockAiEditInput) => {
    const result = await previewDocumentBlockAiEdit(input)
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

    const preview = await pluginHost.previewInstallFromDirectory(result.filePaths[0])
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

  ipcMain.handle('knowbook:trigger-backup', async () => {
    const result: BackupResult = await backupService.exportAll()
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

    const restoreRoot = result.filePaths[0]
    const preview = await restoreService.previewFromDirectory(restoreRoot)
    const deletionCount = preview.deleted + preview.standaloneDatabasesDeleted
    const confirmationOptions = {
      type: 'warning' as const,
      title: '确认恢复备份',
      message: deletionCount > 0
        ? `此恢复将删除 ${deletionCount} 项当前数据，是否继续？`
        : '已完成恢复预检，是否继续？',
      detail: formatRestorePreviewDetail(preview),
      buttons: ['继续恢复', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    }
    const confirmation = targetWindow
      ? await dialog.showMessageBox(targetWindow, confirmationOptions)
      : await dialog.showMessageBox(confirmationOptions)

    if (confirmation.response !== 0) {
      return null
    }

    const safetyBackupPath = await createRestoreSafetyBackup()
    return {
      ...await restoreService.restoreFromDirectory(restoreRoot),
      safetyBackupPath
    }
  })

  ipcMain.handle('knowbook:write-clipboard-text', (_event, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('knowbook:open-external-url', async (_event, url: string) => {
    await openManagedExternalUrl(url)
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
    if (!RENDERER_SETTING_KEYS.has(key)) {
      throw new Error('Setting is not available to the renderer.')
    }
    return store.getSettingPublic(key)
  })

  ipcMain.handle('knowbook:save-setting', (_event, key: string, value: string): void => {
    if (!RENDERER_SETTING_KEYS.has(key)) {
      throw new Error('Setting is not available to the renderer.')
    }
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
  workspaceMutationNotifier.notify()
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
    port: Number.isInteger(storedPort) && storedPort > 0 && storedPort <= 65_535
      ? storedPort
      : DEFAULT_WEB_CLIP_BRIDGE_PORT,
    token
  }
}

async function updateWebClipBridgeSettings(input: UpdateWebClipBridgeSettingsInput): Promise<WebClipBridgeStatus> {
  const current = getStoredWebClipBridgeConfig()
  const nextPort = Number.isInteger(input.port) && input.port > 0 && input.port <= 65_535
    ? input.port
    : DEFAULT_WEB_CLIP_BRIDGE_PORT
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

  const apiKey = getDecryptedAiApiKey()
  if (!apiKey) {
    throw new Error('Missing API key. Save an API key in AI settings.')
  }

   let relatedNotes: SemanticContextNote[] = []
   if (home.aiConfig.relatedNotesEnabled) {
     try {
       relatedNotes = await buildSemanticContextNotes({
         query: input.prompt,
         excludeDocumentId: input.documentId,
         limit: 4
       })
     } catch (error) {
       console.warn('Semantic retrieval failed. Falling back to current document only.', error)
     }
   }

  const prompt = store.buildAiPrompt(input, relatedNotes)
  const answer = await requestAiChatCompletion({
    apiKey,
    baseUrl: home.aiConfig.baseUrl,
    emptyResponseMessage: 'AI returned an empty response.',
    failureLabel: 'AI request',
    model: home.aiConfig.model,
    systemPrompt: 'You are an assistant helping users organize and improve their notes.',
    temperature: 0.3,
    userPrompt: prompt
  })

  return {
    answer,
    references: relatedNotes.map(({ content, contentHash, ...note }) => note)
  }
}

async function previewDocumentBlockAiEdit(
  input: PreviewDocumentBlockAiEditInput
): Promise<PreviewDocumentBlockAiEditResult> {
  const home = store.getHomeData(backupRoot)
  if (!home.aiConfig.enabled) {
    throw new Error('AI is disabled. Enable AI in settings first.')
  }

  const apiKey = getDecryptedAiApiKey()
  if (!apiKey) {
    throw new Error('Missing API key. Save an API key in AI settings.')
  }

  const resolvedInstruction = resolveDocumentBlockAiEditInstruction(input)
  const prompt = store.buildDocumentBlockAiEditPrompt(input, resolvedInstruction)
  const replacementText = await requestAiChatCompletion({
    apiKey,
    baseUrl: home.aiConfig.baseUrl,
    emptyResponseMessage: 'AI returned an empty block edit response.',
    failureLabel: 'AI block edit request',
    model: home.aiConfig.model,
    systemPrompt: 'You transform selected note content. Return only the edited replacement content, with no meta commentary.',
    temperature: input.mode === 'table' ? 0.2 : 0.3,
    userPrompt: prompt
  })

  return {
    documentId: input.documentId,
    mode: input.mode,
    instruction: resolvedInstruction,
    replacementText: normalizeDocumentBlockAiEditResponse(input.mode, replacementText)
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

  const apiKey = getDecryptedAiApiKey()
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

  if (home.aiConfig.autoSummaryOnSave && shouldGenerateDocumentSummary(
    detail.summary,
    detail.blocks.map((block) => block.content),
    DEFAULT_DOCUMENT_SUMMARY
  )) {
    const generatedSummary = await generateDocumentSummaryDeduplicated(detail, home.aiConfig, apiKey)
    if (generatedSummary && generatedSummary !== detail.summary.trim()) {
      const latestAiConfig = store.getAiConfigPublic()
      const updatedDetail = latestAiConfig.enabled && latestAiConfig.autoSummaryOnSave
        ? commitGeneratedSummaryIfCurrent(detail, generatedSummary)
        : null
      if (updatedDetail) {
        detail = updatedDetail
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
  apiKey: string,
  signal?: AbortSignal
): Promise<string | null> {
  const content = buildDocumentSummarySource(detail.blocks.map((block) => block.content))

  if (content.length < 40) {
    return null
  }

  const summary = await requestAiChatCompletion({
    apiKey,
    baseUrl: aiConfig.baseUrl,
    emptyResponseMessage: 'AI returned an empty summary response.',
    failureLabel: 'AI summary request',
    model: aiConfig.model,
    systemPrompt: 'You summarize notes for a knowledge management app. Produce one concise summary sentence in the same primary language as the document, with no markdown, no bullet points, and no surrounding quotes.',
    temperature: 0.2,
    userPrompt: [
      `Document title: ${detail.title}`,
      `Document path: ${detail.path}`,
      'Document content:',
      content,
      '',
      'Return only a compact one-sentence summary in the document language.'
    ].join('\n'),
    signal
  })
  return normalizeGeneratedDocumentSummary(summary)
}

async function generateDocumentSummaryDeduplicated(
  detail: DocumentDetail,
  aiConfig: HomeData['aiConfig'],
  apiKey: string
): Promise<string | null> {
  const sourceVersion = getDocumentSummarySourceVersion(detail)
  const existing = summaryGenerationRequests.get(detail.id)
  if (existing
    && existing.sourceVersion === sourceVersion
    && existing.baseUrl === aiConfig.baseUrl
    && existing.model === aiConfig.model
    && existing.apiKey === apiKey) {
    return existing.promise
  }

  existing?.controller.abort()
  const controller = new AbortController()
  const promise = generateDocumentSummary(detail, aiConfig, apiKey, controller.signal)
    .catch((error) => {
      if (controller.signal.aborted) {
        return null
      }
      throw error
    })
    .finally(() => {
      if (summaryGenerationRequests.get(detail.id)?.promise === promise) {
        summaryGenerationRequests.delete(detail.id)
      }
    })

  summaryGenerationRequests.set(detail.id, {
    apiKey,
    baseUrl: aiConfig.baseUrl,
    controller,
    model: aiConfig.model,
    promise,
    sourceVersion
  })
  return promise
}

function cancelDocumentSummaryGeneration(documentId: string): void {
  summaryGenerationRequests.get(documentId)?.controller.abort()
  summaryGenerationRequests.delete(documentId)
}

function cancelAllDocumentSummaryGeneration(): void {
  for (const request of summaryGenerationRequests.values()) {
    request.controller.abort()
  }
  summaryGenerationRequests.clear()
}

function commitGeneratedSummaryIfCurrent(
  sourceDetail: DocumentDetail,
  generatedSummary: string
): DocumentDetail | null {
  const sourceVersion = getDocumentSummarySourceVersion(sourceDetail)
  return store.runInTransaction(() => {
    const latestDetail = store.getDocumentDetail(sourceDetail.id)
    if (!latestDetail || getDocumentSummarySourceVersion(latestDetail) !== sourceVersion) {
      return null
    }

    store.updateDocumentSummary(sourceDetail.id, generatedSummary)
    return store.getDocumentDetail(sourceDetail.id)
  })
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

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = resolve(candidatePath)
  const root = resolve(rootPath)
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
}

async function openManagedExternalUrl(url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    await shell.openExternal(parsed.toString())
    return
  }

  if (parsed.protocol === 'file:') {
    const filePath = fileURLToPath(parsed)
    if (!isPathInsideRoot(filePath, webClipAssetRoot)) {
      throw new Error('Local file is outside the managed web clip asset root.')
    }

    const errorMessage = await shell.openPath(filePath)
    if (errorMessage) {
      throw new Error(errorMessage)
    }
    return
  }

  throw new Error('Unsupported external URL protocol.')
}

function startBackupSchedule(): void {
  runScheduledBackup()
  backupTimer = setInterval(() => {
    runScheduledBackup()
  }, BACKUP_INTERVAL_MS)
}

async function runScheduledBackup(): Promise<void> {
  try {
    await backupService.exportAll()
  } catch (error) {
    console.warn('Scheduled workspace backup failed.', error)
  }
}

async function shutdownServices(): Promise<void> {
  if (!servicesInitialized) {
    return
  }

  if (backupTimer) {
    clearInterval(backupTimer)
    backupTimer = null
  }
  workspaceMutationNotifier.dispose()
  cancelAllDocumentSummaryGeneration()

  try {
    await backupService.waitForIdle()
  } catch (error) {
    console.warn('Pending workspace backup failed during shutdown.', error)
  }

  try {
    await backupService.exportAll()
  } catch (error) {
    console.warn('Final workspace backup failed during shutdown.', error)
  }

  const results = await Promise.allSettled([
    webClipBridge.destroy(),
    pluginHost.destroy()
  ])
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('Service cleanup failed during shutdown.', result.reason)
    }
  }

  store.destroy()
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
      if (!isPathInsideRoot(assetPath, webClipAssetRoot)) {
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

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) {
      return
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    initializeServices()
    registerAssetPreviewProtocol()
    appUpdateManager.initialize()
    registerWorkspaceEventHandlers()
    registerIpcHandlers()
    pluginHost.discoverAll()
    const startupWindow = createWindow()
    let pluginStartupStarted = false
    let pluginStartupFallback: NodeJS.Timeout | null = null
    const startPluginStartup = () => {
      if (pluginStartupStarted) {
        return
      }
      pluginStartupStarted = true
      if (pluginStartupFallback) {
        clearTimeout(pluginStartupFallback)
        pluginStartupFallback = null
      }
      setImmediate(() => {
        void pluginHost.activateAll().catch((error) => {
          console.error('Background plugin startup failed.', error)
        })
      })
    }
    startupWindow.webContents.once('did-finish-load', startPluginStartup)
    startupWindow.webContents.once('did-fail-load', startPluginStartup)
    startupWindow.once('closed', startPluginStartup)
    pluginStartupFallback = setTimeout(startPluginStartup, 5_000)
    pluginStartupFallback.unref()
    startBackupSchedule()
    appUpdateManager.scheduleStartupCheck()
    void webClipBridge.applyConfig(getStoredWebClipBridgeConfig()).catch((error) => {
      console.error('Web clip bridge startup failed.', error)
    })

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

  app.on('before-quit', (event) => {
    if (shutdownComplete) {
      return
    }

    event.preventDefault()
    if (!shutdownPromise) {
      shutdownPromise = shutdownServices()
        .catch((error) => {
          console.error('Unexpected shutdown failure.', error)
        })
        .finally(() => {
          shutdownComplete = true
          app.quit()
        })
    }
  })
}
