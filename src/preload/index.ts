import electron from 'electron'
import type {
  AppUpdateState,
  AskAiInput,
  AskAiResult,
  BackupResult,
  BackupRestoreResult,
  BlockReferenceResult,
  ClipWebPageInput,
  ClipWebPageResult,
  CreateDatabaseSavedViewInput,
  CreateDocumentDatabaseColumnInput,
  CreateDocumentResult,
  DatabaseSavedView,
  DocumentDatabase,
  DocumentCatalogEntry,
  DocumentCatalogPage,
  DocumentCatalogPageInput,
  DocumentCatalogPageIpcPayload,
  DocumentCatalogTuple,
  DocumentDatabaseColumn,
  DocumentDetail,
  DocumentSuggestion,
  CreateDatabaseInput,
  CreateDatabaseEntityInput,
  UpdateDatabaseEntityInput,
  UpdateDatabaseEntitiesInput,
  DeleteDatabaseEntityInput,
  DeleteDatabaseEntitiesInput,
  DatabaseEntity,
  ElectronApi,
  GlobalSearchResult,
  HomeData,
  HomeDataIpcPayload,
  PluginHomeData,
  PluginUiPreparationRequest,
  PluginUiPreparationResult,
  PluginUiRuntimeFailure,
  MarketplacePluginInstallResult,
  MarketplacePluginPackage,
  InstallPluginResult,
  MoveDocumentDatabaseColumnInput,
  PreviewDocumentBlockAiEditInput,
  PreviewDocumentBlockAiEditResult,
  RenameDocumentDatabaseColumnInput,
  RecoverPluginV2InstallationInput,
  ResolveSystemPluginInstallRequestInput,
  ReorderDatabaseSavedViewsInput,
  RunPluginDocumentActionInput,
  RunPluginDocumentActionResult,
  RunPluginUiActionInput,
  RunPluginUiActionResult,
  RunDocumentAiAutomationsResult,
  SearchSemanticNotesInput,
  SemanticSearchResult,
  SetPluginEnabledInput,
  SystemPluginInstallRequest,
  SystemPluginInstallRequestInput,
  UpdateWebClipBridgeSettingsInput,
  UpdateDatabaseSavedViewInput,
  UpdateDatabaseMetadataInput,
  UpdatePluginSettingInput,
  UpdateDocumentDatabaseColumnOptionsInput,
  UpdateAiConfigInput,
  UpdateDocumentDatabaseValueInput,
  UpdateDocumentInput,
  UpdateDocumentResult,
  WebClipBridgeStatus
} from '@shared/contracts'
import type {
  AssistantEvent,
  AssistantSessionChangedEvent,
  AssistantSessionId,
  AssistantSessionSummary,
  CreateAssistantSessionRequest,
  ResolveAssistantApprovalRequest,
  SendAssistantMessageRequest,
  SendAssistantMessageResult
} from '@shared/assistant-session'
import { decodeDocumentCatalogEntry, decodeDocumentIndexEntry } from '@shared/document-catalog-payload'
import { buildDocumentTreeFromCatalog } from '@shared/document-tree'

const { contextBridge, ipcRenderer } = electron
const WORKSPACE_MUTATED_CHANNEL = 'knowbook:workspace-mutated'
const PLUGINS_MUTATED_CHANNEL = 'knowbook:plugins-mutated'
const PLUGIN_UI_PREPARE_CHANNEL = 'knowbook:plugin-ui-prepare'
const ASSISTANT_SESSION_CHANGED_CHANNEL = 'knowbook:assistant-session-changed'

const pluginUiPreparationListeners = new Set<(request: PluginUiPreparationRequest) => void>()
const queuedPluginUiPreparations: PluginUiPreparationRequest[] = []

ipcRenderer.on(PLUGIN_UI_PREPARE_CHANNEL, (_event, request: PluginUiPreparationRequest) => {
  if (pluginUiPreparationListeners.size === 0) {
    queuedPluginUiPreparations.push(request)
    if (queuedPluginUiPreparations.length > 16) queuedPluginUiPreparations.shift()
    return
  }
  for (const listener of pluginUiPreparationListeners) listener(request)
})

const api: ElectronApi = {
  getHomeData: async () => {
    const data = await ipcRenderer.invoke('knowbook:get-home-data') as HomeDataIpcPayload
    const documentCatalog = data.documentCatalog.map(decodeDocumentIndexEntry)
    return {
      ...data,
      documentCatalog,
      documentTree: buildDocumentTreeFromCatalog(documentCatalog)
    } satisfies HomeData
  },
  getPluginHomeData: () => ipcRenderer.invoke('knowbook:get-plugin-home-data') as Promise<PluginHomeData>,
  onWorkspaceMutated: (listener) => {
    const wrapped = () => listener()
    ipcRenderer.on(WORKSPACE_MUTATED_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(WORKSPACE_MUTATED_CHANNEL, wrapped)
    }
  },
  onPluginsMutated: (listener) => {
    const wrapped = () => listener()
    ipcRenderer.on(PLUGINS_MUTATED_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(PLUGINS_MUTATED_CHANNEL, wrapped)
    }
  },
  onPluginUiPreparation: (listener) => {
    pluginUiPreparationListeners.add(listener)
    for (const request of queuedPluginUiPreparations.splice(0)) listener(request)
    return () => {
      pluginUiPreparationListeners.delete(listener)
    }
  },
  reportPluginUiPreparation: (result: PluginUiPreparationResult) => ipcRenderer.invoke('knowbook:report-plugin-ui-preparation', result) as Promise<void>,
  reportPluginUiRuntimeFailure: (failure: PluginUiRuntimeFailure) => ipcRenderer.invoke('knowbook:report-plugin-ui-runtime-failure', failure) as Promise<void>,
  getAppUpdateState: () => ipcRenderer.invoke('knowbook:get-app-update-state') as Promise<AppUpdateState>,
  checkForAppUpdates: () => ipcRenderer.invoke('knowbook:check-for-app-updates') as Promise<AppUpdateState>,
  installAppUpdate: () => ipcRenderer.invoke('knowbook:install-app-update') as Promise<void>,
  getDocumentDetail: (documentId: string) => ipcRenderer.invoke('knowbook:get-document-detail', documentId) as Promise<DocumentDetail | null>,
  clipWebPage: (input: ClipWebPageInput) => ipcRenderer.invoke('knowbook:clip-web-page', input) as Promise<ClipWebPageResult>,
  getWebClipBridgeStatus: () => ipcRenderer.invoke('knowbook:get-web-clip-bridge-status') as Promise<WebClipBridgeStatus>,
  updateWebClipBridgeSettings: (input: UpdateWebClipBridgeSettingsInput) => ipcRenderer.invoke('knowbook:update-web-clip-bridge-settings', input) as Promise<WebClipBridgeStatus>,
  getDocumentSuggestions: (query: string, excludeDocumentId?: string | null) => ipcRenderer.invoke('knowbook:get-document-suggestions', query, excludeDocumentId ?? null) as Promise<DocumentSuggestion[]>,
  getBlockReference: (documentPath: string, blockId: string) => ipcRenderer.invoke('knowbook:get-block-reference', documentPath, blockId) as Promise<BlockReferenceResult | null>,
  createDocument: (parentId: string | null) => ipcRenderer.invoke('knowbook:create-document', parentId) as Promise<CreateDocumentResult>,
  getDocumentCatalog: async (databaseId?: string | null) => {
    const tuples = await ipcRenderer.invoke('knowbook:get-document-catalog', databaseId ?? null) as DocumentCatalogTuple[]
    return tuples.map(decodeDocumentCatalogEntry)
  },
  getDocumentCatalogPage: async (input: DocumentCatalogPageInput) => {
    const page = await ipcRenderer.invoke('knowbook:get-document-catalog-page', input) as DocumentCatalogPageIpcPayload
    return {
      ...page,
      entries: page.entries.map(decodeDocumentCatalogEntry)
    } satisfies DocumentCatalogPage
  },
  getDocumentDatabaseColumns: (databaseId?: string | null) => ipcRenderer.invoke('knowbook:get-document-database-columns', databaseId ?? null) as Promise<DocumentDatabaseColumn[]>,
  createDocumentDatabaseColumn: (input: CreateDocumentDatabaseColumnInput) => ipcRenderer.invoke('knowbook:create-document-database-column', input) as Promise<DocumentDatabaseColumn>,
  renameDocumentDatabaseColumn: (input: RenameDocumentDatabaseColumnInput) => ipcRenderer.invoke('knowbook:rename-document-database-column', input) as Promise<void>,
  moveDocumentDatabaseColumn: (input: MoveDocumentDatabaseColumnInput) => ipcRenderer.invoke('knowbook:move-document-database-column', input) as Promise<void>,
  updateDocumentDatabaseColumnOptions: (input: UpdateDocumentDatabaseColumnOptionsInput) => ipcRenderer.invoke('knowbook:update-document-database-column-options', input) as Promise<void>,
  deleteDocumentDatabaseColumn: (columnId: string) => ipcRenderer.invoke('knowbook:delete-document-database-column', columnId) as Promise<void>,
  updateDocumentDatabaseValue: (input: UpdateDocumentDatabaseValueInput) => ipcRenderer.invoke('knowbook:update-document-database-value', input) as Promise<void>,
  updateDocument: (documentId: string, input: UpdateDocumentInput) => ipcRenderer.invoke('knowbook:update-document', documentId, input) as Promise<UpdateDocumentResult>,
  deleteDocument: (documentId: string) => ipcRenderer.invoke('knowbook:delete-document', documentId) as Promise<void>,
  moveDocument: (documentId: string, newParentId: string | null) => ipcRenderer.invoke('knowbook:move-document', documentId, newParentId) as Promise<void>,
  updateAiConfig: (input: UpdateAiConfigInput) => ipcRenderer.invoke('knowbook:update-ai-config', input) as Promise<void>,
  listAssistantSessions: () => ipcRenderer.invoke('knowbook:list-assistant-sessions') as Promise<AssistantSessionSummary[]>,
  createAssistantSession: (input: CreateAssistantSessionRequest = {}) => ipcRenderer.invoke('knowbook:create-assistant-session', input) as Promise<AssistantSessionSummary>,
  getAssistantSessionEvents: (sessionId: AssistantSessionId, afterSeq = 0, limit = 500) => ipcRenderer.invoke('knowbook:get-assistant-session-events', sessionId, afterSeq, limit) as Promise<AssistantEvent[]>,
  sendAssistantMessage: (input: SendAssistantMessageRequest) => ipcRenderer.invoke('knowbook:send-assistant-message', input) as Promise<SendAssistantMessageResult>,
  resolveAssistantApproval: (input: ResolveAssistantApprovalRequest) => ipcRenderer.invoke('knowbook:resolve-assistant-approval', input) as Promise<SendAssistantMessageResult>,
  cancelAssistantTurn: (sessionId: AssistantSessionId) => ipcRenderer.invoke('knowbook:cancel-assistant-turn', sessionId) as Promise<void>,
  onAssistantSessionChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, change: AssistantSessionChangedEvent) => listener(change)
    ipcRenderer.on(ASSISTANT_SESSION_CHANGED_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(ASSISTANT_SESSION_CHANGED_CHANNEL, wrapped)
    }
  },
  searchSemanticNotes: (input: SearchSemanticNotesInput) => ipcRenderer.invoke('knowbook:search-semantic-notes', input) as Promise<SemanticSearchResult[]>,
  askAiAboutDocument: (input: AskAiInput) => ipcRenderer.invoke('knowbook:ask-ai-about-document', input) as Promise<AskAiResult>,
  previewDocumentBlockAiEdit: (input: PreviewDocumentBlockAiEditInput) => ipcRenderer.invoke('knowbook:preview-document-block-ai-edit', input) as Promise<PreviewDocumentBlockAiEditResult>,
  runDocumentAiAutomations: (documentId: string) => ipcRenderer.invoke('knowbook:run-document-ai-automations', documentId) as Promise<RunDocumentAiAutomationsResult>,
  setPluginEnabled: (input: SetPluginEnabledInput) => ipcRenderer.invoke('knowbook:set-plugin-enabled', input) as Promise<void>,
  reloadPlugins: () => ipcRenderer.invoke('knowbook:reload-plugins') as Promise<void>,
  reloadPlugin: (pluginId: string) => ipcRenderer.invoke('knowbook:reload-plugin', pluginId) as Promise<void>,
  installPluginFromFolder: () => ipcRenderer.invoke('knowbook:install-plugin-from-folder') as Promise<InstallPluginResult | null>,
  removePlugin: (pluginId: string) => ipcRenderer.invoke('knowbook:remove-plugin', pluginId) as Promise<void>,
  updatePluginSetting: (input: UpdatePluginSettingInput) => ipcRenderer.invoke('knowbook:update-plugin-setting', input) as Promise<void>,
  runPluginDocumentAction: (input: RunPluginDocumentActionInput) => ipcRenderer.invoke('knowbook:run-plugin-document-action', input) as Promise<RunPluginDocumentActionResult>,
  runPluginUiAction: (input: RunPluginUiActionInput) => ipcRenderer.invoke('knowbook:run-plugin-ui-action', input) as Promise<RunPluginUiActionResult>,
  recoverPluginV2Installation: (input: RecoverPluginV2InstallationInput) => ipcRenderer.invoke('knowbook:recover-plugin-v2-installation', input) as Promise<void>,
  installMarketplacePluginPackage: (input: MarketplacePluginPackage) => ipcRenderer.invoke('knowbook:install-marketplace-plugin-package', input) as Promise<MarketplacePluginInstallResult>,
  requestSystemPluginInstall: (input: SystemPluginInstallRequestInput) => ipcRenderer.invoke('knowbook:request-system-plugin-install', input) as Promise<SystemPluginInstallRequest>,
  listSystemPluginInstallRequests: () => ipcRenderer.invoke('knowbook:list-system-plugin-install-requests') as Promise<SystemPluginInstallRequest[]>,
  resolveSystemPluginInstallRequest: (input: ResolveSystemPluginInstallRequestInput) => ipcRenderer.invoke('knowbook:resolve-system-plugin-install-request', input) as Promise<SystemPluginInstallRequest>,
  triggerBackup: () => ipcRenderer.invoke('knowbook:trigger-backup') as Promise<BackupResult>,
  restoreBackupFromFolder: () => ipcRenderer.invoke('knowbook:restore-backup-from-folder') as Promise<BackupRestoreResult | null>,
  writeClipboardText: (text: string) => ipcRenderer.invoke('knowbook:write-clipboard-text', text) as Promise<void>,
  openExternalUrl: (url: string) => ipcRenderer.invoke('knowbook:open-external-url', url) as Promise<void>,
  saveMarkdownFile: (defaultFileName: string, content: string) => ipcRenderer.invoke('knowbook:save-markdown-file', defaultFileName, content) as Promise<string | null>,
  getSetting: (key: string) => ipcRenderer.invoke('knowbook:get-setting', key) as Promise<string | null>,
  saveSetting: (key: string, value: string) => ipcRenderer.invoke('knowbook:save-setting', key, value) as Promise<void>,
  searchDocuments: (query: string) => ipcRenderer.invoke('knowbook:search-documents', query) as Promise<GlobalSearchResult[]>,
  createDocumentDatabase: (input: CreateDatabaseInput) => ipcRenderer.invoke('knowbook:create-document-database', input) as Promise<DocumentDatabase>,
  updateDatabaseMetadata: (input: UpdateDatabaseMetadataInput) => ipcRenderer.invoke('knowbook:update-database-metadata', input) as Promise<DocumentDatabase>,
  getDatabases: () => ipcRenderer.invoke('knowbook:get-databases') as Promise<DocumentDatabase[]>,
  deleteDatabase: (databaseId: string) => ipcRenderer.invoke('knowbook:delete-database', databaseId) as Promise<void>,
  getDatabaseSavedViews: (databaseId: string) => ipcRenderer.invoke('knowbook:get-database-saved-views', databaseId) as Promise<DatabaseSavedView[]>,
  createDatabaseSavedView: (input: CreateDatabaseSavedViewInput) => ipcRenderer.invoke('knowbook:create-database-saved-view', input) as Promise<DatabaseSavedView>,
  updateDatabaseSavedView: (input: UpdateDatabaseSavedViewInput) => ipcRenderer.invoke('knowbook:update-database-saved-view', input) as Promise<DatabaseSavedView>,
  reorderDatabaseSavedViews: (input: ReorderDatabaseSavedViewsInput) => ipcRenderer.invoke('knowbook:reorder-database-saved-views', input) as Promise<DatabaseSavedView[]>,
  deleteDatabaseSavedView: (viewId: string) => ipcRenderer.invoke('knowbook:delete-database-saved-view', viewId) as Promise<void>,
  createDatabaseEntity: (input: CreateDatabaseEntityInput) => ipcRenderer.invoke('knowbook:create-database-entity', input) as Promise<DatabaseEntity>,
  updateDatabaseEntity: (input: UpdateDatabaseEntityInput) => ipcRenderer.invoke('knowbook:update-database-entity', input) as Promise<void>,
  updateDatabaseEntities: (input: UpdateDatabaseEntitiesInput) => ipcRenderer.invoke('knowbook:update-database-entities', input) as Promise<void>,
  deleteDatabaseEntity: (entityId: string) => ipcRenderer.invoke('knowbook:delete-database-entity', entityId) as Promise<void>,
  deleteDatabaseEntities: (input: DeleteDatabaseEntitiesInput) => ipcRenderer.invoke('knowbook:delete-database-entities', input) as Promise<void>,
  getDatabaseEntities: (databaseId: string) => ipcRenderer.invoke('knowbook:get-database-entities', databaseId) as Promise<DatabaseEntity[]>
}

contextBridge.exposeInMainWorld('knowbook', api)
