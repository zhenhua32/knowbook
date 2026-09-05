import { mkdirSync, readFileSync, writeFileSync, createReadStream } from 'node:fs'
import { rm as removePath } from 'node:fs/promises'
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
  DocumentCatalogPageInput,
  DocumentCatalogPageIpcPayload,
  DocumentCatalogTuple,
  DocumentDatabaseColumn,
  DocumentDetail,
  DocumentSuggestion,
  GlobalSearchResult,
  GetPluginV2DetailsInput,
  HomeData,
  HomeDataIpcPayload,
  PluginHomeData,
  PluginV2Details,
  MarketplacePluginInstallResult,
  MarketplacePluginPackage,
  InstallPluginResult,
  MoveDocumentDatabaseColumnInput,
  PreviewDocumentBlockAiEditInput,
  PreviewDocumentBlockAiEditResult,
  RenameDocumentDatabaseColumnInput,
  RecoverPluginV2InstallationInput,
  ResolveSystemPluginInstallRequestInput,
  ResolveSystemPluginOsPersistenceInput,
  ReorderDatabaseSavedViewsInput,
  RunPluginDocumentActionInput,
  RunPluginDocumentActionResult,
  RunPluginUiActionInput,
  RunPluginUiActionResult,
  RunDocumentAiAutomationsResult,
  SearchSemanticNotesInput,
  SemanticSearchResult,
  SetPluginEnabledInput,
  SetPluginV2EnabledInput,
  SetSystemPluginEnabledInput,
  RollbackSystemPluginInput,
  RemovePluginV2Input,
  SystemPluginInstallRequest,
  SystemPluginInstallRequestInput,
  SystemPluginFramePolicyInput,
  RemoveSystemPluginFramePolicyInput,
  SystemPluginMutationInput,
  SystemPluginSummary,
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
import type {
  AssistantSessionChangedEvent,
  AssistantSessionId,
  CreateAssistantSessionRequest,
  ResolveAssistantApprovalRequest,
  SendAssistantMessageRequest
} from '@shared/assistant-session'
import type {
  PluginUiContribution,
  PluginUiDocumentContribution,
  PluginUiDocumentPreparation,
  PluginUiPreparationRequest,
  PluginUiPreparationResult,
  PluginUiRuntimeFailure
} from '@shared/plugin-ui'
import { encodeDocumentCatalogEntry, encodeDocumentIndexEntry } from '@shared/document-catalog-payload'
import { scoreKeywordSearchCandidate } from '@shared/semantic-search'
import { buildDocumentSummarySource } from '@shared/ai-summary'
import { samePluginFrameIdentity } from '@shared/plugin-frame-protocol'
import {
  getDocumentSummarySourceVersion,
  normalizeDocumentBlockAiEditResponse,
  normalizeGeneratedDocumentSummary,
  requestAiChatCompletion,
  resolveDocumentBlockAiEditInstruction,
  shouldGenerateDocumentSummary
} from './ai-service'
import { normalizeAiApiKey } from './ai-auth'
import { MarkdownBackupService } from './backup/exporter'
import { runBackupExportInWorker } from './backup/worker-client'
import { MarkdownRestoreService } from './backup/importer'
import { parseRestoreMarkdownInWorker } from './backup/restore-worker-client'
import { DEFAULT_DOCUMENT_SUMMARY, KnowbookStore } from './database/store'
import { createWorkspaceEventRecord, WorkspaceEventBus } from './event-bus'
import { PluginHost } from './plugin-host'
import { ElectronPluginRuntime } from './plugin-runtime-client'
import { PluginPlatformV2Service } from './plugin-platform/platform-service'
import { QuickJsWasiPluginRuntimeFactory } from './plugin-platform/quickjs-runtime-client'
import { PLUGIN_IFRAME_CSP } from './plugin-platform/ui-materializer'
import { AssistantAgentService } from './assistant/agent-service'
import { AppUpdateManager } from './update-manager'
import { WebClipBridgeService } from './web-clip-bridge'
import { WebClipperService } from './web-clipper'
import { WebClipExtractionWorkerRunner } from './web-clip-extract-worker-client'
import { CoalescedNotifier } from './coalesced-notifier'
import { isSameOriginNavigation } from './window-navigation'
import {
  createKnowbookFullTrustServices,
  createKnowbookFullTrustServiceRpcMethods,
  createFullTrustOsPersistenceAdapter,
  createSystemPluginPackagePreparer,
  getSystemPluginRuntimeRoot,
  SystemPluginManager,
  type FullTrustPluginContextFactoryBindings,
  type SystemPluginManagerSummary
} from './system-plugin'
import { normalizeSystemPluginV3Manifest } from './system-plugin-artifact'
import { extractSystemPluginArchive } from './system-plugin-archive'
import {
  createEphemeralCredentialStorage,
  isSecureStorageUsable,
  protectCredential,
  revealCredential,
  type SecureStringStorage
} from './credential-storage'

const { app, BrowserWindow, clipboard, dialog, ipcMain: electronIpcMain, safeStorage, shell, protocol } = electron
type ElectronBrowserWindow = InstanceType<typeof BrowserWindow>

const BACKUP_INTERVAL_MS = 5 * 60 * 1000
const WORKSPACE_MUTATED_CHANNEL = 'knowbook:workspace-mutated'
const PLUGINS_MUTATED_CHANNEL = 'knowbook:plugins-mutated'
const PLUGIN_UI_PREPARE_CHANNEL = 'knowbook:plugin-ui-prepare'
const ASSISTANT_SESSION_CHANGED_CHANNEL = 'knowbook:assistant-session-changed'
const KNOWBOOK_ASSET_PREVIEW_SCHEME = 'knowbook-asset'
const KNOWBOOK_PLUGIN_UI_SCHEME = 'knowbook-plugin-ui'
const PLUGIN_UI_E2E_PROBE_TOKEN = '00000000-0000-4000-8000-000000000001'
const WEB_CLIP_BRIDGE_ENABLED_KEY = 'webclip.bridge.enabled'
const PACKAGED_RUNTIME_SMOKE_RESULT_PATH = process.env['KNOWBOOK_PACKAGED_PLUGIN_RUNTIME_SMOKE_RESULT']?.trim()
const PLUGIN_UI_PREPARATION_TIMEOUT_MS = 10_000

type PendingPluginUiPreparation = {
  identity: PluginUiDocumentPreparation['identity']
  documentTokens: string[]
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const pendingPluginUiPreparations = new Map<string, PendingPluginUiPreparation>()
type PluginUiDocumentRegistration = {
  token: string
  srcdoc: string
  activeKey?: string
  owner?: import('@shared/plugin-platform').PluginActiveOwner
  preparationRequestId?: string
}
const pluginUiDocuments = new Map<string, PluginUiDocumentRegistration>()
const activePluginUiDocumentTokens = new Map<string, string>()
const fullTrustFramePolicies = new Map<string, SystemPluginFramePolicyInput>()
const fullTrustPopupWindows = new Map<number, {
  frameName: string
  window: ElectronBrowserWindow
}>()

function recordPackagedRuntimeSmoke(status: 'started' | 'passed' | 'failed', error?: unknown): void {
  if (!PACKAGED_RUNTIME_SMOKE_RESULT_PATH) return
  try {
    writeFileSync(PACKAGED_RUNTIME_SMOKE_RESULT_PATH, JSON.stringify({
      status,
      ...(error === undefined ? {} : {
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      })
    }), 'utf8')
  } catch {
    // The result file is diagnostic-only; stdout/exit code remain authoritative.
  }
}

if (process.env['KNOWBOOK_PACKAGED_PLUGIN_RUNTIME_SMOKE'] === '1') {
  recordPackagedRuntimeSmoke('started')
}
const WEB_CLIP_BRIDGE_PORT_KEY = 'webclip.bridge.port'
const WEB_CLIP_BRIDGE_TOKEN_KEY = 'webclip.bridge.token'
const SYSTEM_PLUGIN_SAFE_MODE_NEXT_BOOT_KEY = 'system-plugin.safe-mode-next-boot'
const LOCAL_WORKSPACE_ID = 'local-workspace'
const DEFAULT_WEB_CLIP_BRIDGE_PORT = 3210
const WORKSPACE_MUTATION_NOTIFY_DELAY_MS = 25
const RENDERER_SETTING_KEYS = new Set(['appearance.theme', 'pinned_documents', 'ui.language'])

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
  },
  {
    scheme: KNOWBOOK_PLUGIN_UI_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      stream: true
    }
  }
])

app.on('render-process-gone', (_event, _webContents, details) => {
  console.error('Renderer process exited unexpectedly.', details)
})

app.on('child-process-gone', (_event, details) => {
  console.error('Electron child process exited unexpectedly.', details)
})

process.on('unhandledRejection', (reason) => {
  console.warn('Unhandled promise rejection in the main process.', reason)
})

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in the main process.', error)
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

const useEphemeralE2eCredentialStorage = !app.isPackaged
  && process.env['KNOWBOOK_E2E_EPHEMERAL_CREDENTIAL_STORAGE'] === '1'
const aiCredentialStorage: SecureStringStorage = useEphemeralE2eCredentialStorage
  ? createEphemeralCredentialStorage(randomUUID)
  : {
      isEncryptionAvailable: () => isSecureStorageUsable(
        safeStorage.isEncryptionAvailable(),
        process.platform,
        process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined
      ),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value)
    }

const workspaceMutationNotifier = new CoalescedNotifier(() => {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(WORKSPACE_MUTATED_CHANNEL)
    }
  })
}, WORKSPACE_MUTATION_NOTIFY_DELAY_MS)

const pluginMutationNotifier = new CoalescedNotifier(() => {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(PLUGINS_MUTATED_CHANNEL)
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
const earlyWebClipExtractionWorker = hasSingleInstanceLock
  ? new WebClipExtractionWorkerRunner()
  : null

const userDataRoot = app.getPath('userData')
const databasePath = join(userDataRoot, 'storage', 'knowbook.db')
const backupRoot = join(userDataRoot, 'backups', 'markdown')
const restoreSafetyBackupRoot = join(userDataRoot, 'backups', 'restore-safety')
const webClipAssetRoot = join(userDataRoot, 'storage', 'assets')
const systemPluginRoot = join(userDataRoot, 'system-plugins')
const systemPluginStagingRoot = join(systemPluginRoot, 'staging')
const systemPluginArtifactRoot = join(systemPluginRoot, 'artifacts')
const systemPluginRuntimeRoot = join(systemPluginRoot, 'runtime')
const systemPluginDataRoot = join(systemPluginRoot, 'data')
const systemPluginLogRoot = join(systemPluginRoot, 'logs')
const systemPluginBackupRoot = join(userDataRoot, 'backups', 'system-plugins')
let store: KnowbookStore
let backupService: MarkdownBackupService
let restoreService: MarkdownRestoreService
let workspaceEventBus: WorkspaceEventBus
let webClipper: WebClipperService
let webClipExtractionWorker: WebClipExtractionWorkerRunner
let webClipBridge: WebClipBridgeService
let pluginHost: PluginHost
let pluginPlatformV2: PluginPlatformV2Service
let systemPluginManager: SystemPluginManager<ReturnType<typeof createKnowbookFullTrustServices>>
let assistantAgent: AssistantAgentService
let appUpdateManager: AppUpdateManager
let servicesInitialized = false
let restoreWorkflowInProgress = false

function preparePluginUi(input: PluginUiDocumentPreparation): Promise<void> {
  const window = mainWindow
  if (!window || window.webContents.isDestroyed()) {
    return Promise.reject(new Error('Plugin iframe UI cannot be prepared without an active renderer.'))
  }
  const requestId = randomUUID()
  const documentTokens: string[] = []
  const frames = input.frames.map((frame) => {
    const registration = registerPluginUiDocument(frame.srcdoc, { preparationRequestId: requestId })
    documentTokens.push(registration.token)
    return {
      slot: frame.slot,
      contributionId: frame.contributionId,
      title: frame.title,
      height: frame.height,
      src: pluginUiDocumentUrl(registration.token)
    }
  })
  return new Promise<void>((resolve_, reject) => {
    const timeout = setTimeout(() => {
      pendingPluginUiPreparations.delete(requestId)
      removePluginUiDocuments(documentTokens)
      reject(new Error('Plugin iframe UI ready handshake timed out.'))
    }, PLUGIN_UI_PREPARATION_TIMEOUT_MS)
    pendingPluginUiPreparations.set(requestId, {
      identity: input.identity,
      documentTokens,
      resolve: resolve_,
      reject,
      timeout
    })
    window.webContents.send(PLUGIN_UI_PREPARE_CHANNEL, {
      identity: input.identity,
      frames,
      requestId
    } satisfies PluginUiPreparationRequest)
  })
}

function completePluginUiPreparation(result: PluginUiPreparationResult): void {
  if (!result || typeof result !== 'object') {
    throw new Error('Plugin UI preparation result is invalid.')
  }
  const requestId = typeof result.requestId === 'string' ? result.requestId.trim() : ''
  const pending = requestId ? pendingPluginUiPreparations.get(requestId) : undefined
  if (!pending) {
    throw new Error('Plugin UI preparation request is stale or unknown.')
  }
  if (!samePluginFrameIdentity(result.identity, pending.identity)) {
    throw new Error('Plugin UI preparation identity does not match its request.')
  }
  if (result.status !== 'ready' && result.status !== 'failed') {
    throw new Error('Plugin UI preparation status is invalid.')
  }
  pendingPluginUiPreparations.delete(requestId)
  clearTimeout(pending.timeout)
  removePluginUiDocuments(pending.documentTokens)
  if (result.status === 'ready') {
    pending.resolve()
  } else {
    pending.reject(new Error(
      typeof result.error === 'string' && result.error.trim()
        ? `Plugin iframe UI failed readiness: ${result.error.trim().slice(0, 2_000)}`
        : 'Plugin iframe UI failed readiness.'
    ))
  }
}

function rejectPendingPluginUiPreparations(reason: string): void {
  for (const [requestId, pending] of pendingPluginUiPreparations) {
    pendingPluginUiPreparations.delete(requestId)
    clearTimeout(pending.timeout)
    removePluginUiDocuments(pending.documentTokens)
    pending.reject(new Error(reason))
  }
}

function exposePluginUiContributions(
  contributions: PluginUiDocumentContribution[]
): PluginUiContribution[] {
  prunePluginUiDocuments()
  return contributions.map((contribution) => {
    if (contribution.value.kind !== 'iframe') {
      return {
        owner: contribution.owner,
        slot: contribution.slot,
        id: contribution.id,
        order: contribution.order,
        value: contribution.value
      }
    }
    const activeKey = [
      contribution.owner.pluginId,
      contribution.owner.revisionId,
      contribution.owner.runId,
      String(contribution.owner.epoch),
      contribution.slot,
      contribution.id
    ].join('\0')
    const existingToken = activePluginUiDocumentTokens.get(activeKey)
    const existing = existingToken ? pluginUiDocuments.get(existingToken) : undefined
    const registration = existing?.srcdoc === contribution.value.srcdoc
      ? existing
      : registerPluginUiDocument(contribution.value.srcdoc, {
          activeKey,
          owner: contribution.owner
        })
    return {
      owner: contribution.owner,
      slot: contribution.slot,
      id: contribution.id,
      order: contribution.order,
      value: {
        kind: 'iframe',
        title: contribution.value.title,
        height: contribution.value.height,
        src: pluginUiDocumentUrl(registration.token)
      }
    }
  })
}

function registerPluginUiDocument(
  srcdoc: string,
  binding: Pick<PluginUiDocumentRegistration, 'activeKey' | 'owner' | 'preparationRequestId'>
): PluginUiDocumentRegistration {
  if (binding.activeKey) {
    const previousToken = activePluginUiDocumentTokens.get(binding.activeKey)
    if (previousToken) removePluginUiDocuments([previousToken])
  }
  const token = randomUUID()
  const registration: PluginUiDocumentRegistration = {
    token,
    srcdoc,
    ...(binding.activeKey ? { activeKey: binding.activeKey } : {}),
    ...(binding.owner ? { owner: binding.owner } : {}),
    ...(binding.preparationRequestId ? { preparationRequestId: binding.preparationRequestId } : {})
  }
  pluginUiDocuments.set(token, registration)
  if (binding.activeKey) activePluginUiDocumentTokens.set(binding.activeKey, token)
  return registration
}

function removePluginUiDocuments(tokens: readonly string[]): void {
  for (const token of tokens) {
    const registration = pluginUiDocuments.get(token)
    if (!registration) continue
    pluginUiDocuments.delete(token)
    if (
      registration.activeKey
      && activePluginUiDocumentTokens.get(registration.activeKey) === token
    ) activePluginUiDocumentTokens.delete(registration.activeKey)
  }
}

function prunePluginUiDocuments(): void {
  const stale: string[] = []
  for (const registration of pluginUiDocuments.values()) {
    if (registration.owner && !pluginPlatformV2.kernel.isCurrent(registration.owner)) {
      stale.push(registration.token)
    }
  }
  removePluginUiDocuments(stale)
}

function pluginUiDocumentUrl(token: string): string {
  return `${KNOWBOOK_PLUGIN_UI_SCHEME}://frame/${token}`
}

function getPluginUiDocumentRegistration(url: string): PluginUiDocumentRegistration | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${KNOWBOOK_PLUGIN_UI_SCHEME}:` || parsed.hostname !== 'frame') return null
    const token = parsed.pathname.replace(/^\//, '')
    if (!/^[a-f0-9-]{36}$/i.test(token)) return null
    const registration = pluginUiDocuments.get(token)
    if (!registration) return null
    if (registration.owner && !pluginPlatformV2.kernel.isCurrent(registration.owner)) {
      removePluginUiDocuments([token])
      return null
    }
    if (
      registration.preparationRequestId
      && !pendingPluginUiPreparations.has(registration.preparationRequestId)
    ) {
      removePluginUiDocuments([token])
      return null
    }
    return registration
  } catch {
    return null
  }
}

function initializeServices(): void {
  store = new KnowbookStore(databasePath)
  try {
    getDecryptedAiApiKey()
  } catch (error) {
    console.warn(
      'The stored AI API key could not be verified or migrated.',
      error instanceof Error ? error.message : 'Unknown credential storage error.'
    )
  }
  backupService = new MarkdownBackupService(store, backupRoot, webClipAssetRoot, runBackupExportInWorker)
  restoreService = new MarkdownRestoreService(
    store,
    webClipAssetRoot,
    {},
    parseRestoreMarkdownInWorker
  )
  workspaceEventBus = new WorkspaceEventBus()
  pluginPlatformV2 = new PluginPlatformV2Service(
    store,
    join(userDataRoot, 'storage', 'plugin-revisions-v2'),
    {
      workspaceId: LOCAL_WORKSPACE_ID,
      runtimeFactory: new QuickJsWasiPluginRuntimeFactory(),
      preparePluginUi,
      onDocumentCreated: async (document, owner) => {
        await workspaceEventBus.emit({
          type: 'document.created',
          createdAt: new Date().toISOString(),
          documentId: document.id,
          documentTitle: document.title,
          path: document.path,
          parentId: store.getDocumentSnapshot(document.id)?.parentId ?? null,
          originPluginId: owner.pluginId,
          correlationId: owner.runId
        })
        notifyWorkspaceMutation()
      },
      onDocumentUpdated: async (document, owner) => {
        await workspaceEventBus.emit({
          type: 'document.updated',
          createdAt: new Date().toISOString(),
          documentId: document.id,
          documentTitle: document.title,
          path: document.path,
          affectedDocumentIds: [document.id],
          pathChanged: false,
          originPluginId: owner.pluginId,
          correlationId: owner.runId
        })
        notifyWorkspaceMutation()
      },
      runDocumentSummaryAutomation: async (documentId) => {
        const config = store.getAiConfigPublic()
        if (!config.enabled || !config.autoSummaryOnSave || !getDecryptedAiApiKey()) {
          return { summaryGenerated: false }
        }
        const result = await runDocumentAiAutomations(documentId)
        return { summaryGenerated: result.summaryGenerated }
      },
      notify: (notification) => {
        if (mainWindow && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('knowbook:plugin-notification', notification)
        }
      },
      setAppearanceTheme: (theme) => {
        store.setAppearanceTheme(theme)
        notifyWorkspaceMutation()
      }
    }
  )
  const createFullTrustPluginServices = (
    bindings: Pick<FullTrustPluginContextFactoryBindings, 'plugin' | 'registerDisposable'>
  ) => {
    const pluginRunCorrelationId = randomUUID()
    return createKnowbookFullTrustServices({
      store,
      sqlite: store.getUnsafeDatabaseHandle(),
      workspaceEventBus,
      workspaceEventContext: {
        originPluginId: bindings.plugin.id,
        correlationId: pluginRunCorrelationId
      },
      electron,
      getMainWindow: () => mainWindow,
      getAiCredentials: () => {
        const config = store.getAiConfigPublic()
        return {
          enabled: config.enabled,
          apiKey: getDecryptedAiApiKey(),
          baseUrl: config.baseUrl,
          model: config.model
        }
      },
      notifyWorkspaceMutation,
      cancelDocumentSummaryGeneration,
      registerDisposable: bindings.registerDisposable,
      requestOsPersistence: () => systemPluginManager.requestOsPersistence(
        bindings.plugin.id,
        'plugin'
      ),
      renderer: {
        activate: async (input) => {
          await activateFullTrustRenderer(input)
          await commitFullTrustRenderer(input.pluginId, input.revisionHash)
        },
        deactivate: deactivateFullTrustRenderer
      },
      paths: {
        userData: app.getPath('userData'),
        appData: app.getPath('appData'),
        documents: app.getPath('documents'),
        downloads: app.getPath('downloads'),
        temp: app.getPath('temp')
      }
    })
  }
  systemPluginManager = new SystemPluginManager({
    repository: store.pluginPlatform,
    stagingRoot: systemPluginStagingRoot,
    artifactRoot: systemPluginArtifactRoot,
    dataRoot: systemPluginDataRoot,
    backupRoot: systemPluginBackupRoot,
    runtimeRoot: systemPluginRuntimeRoot,
    logRoot: systemPluginLogRoot,
    osPersistenceAdapter: createFullTrustOsPersistenceAdapter({
      platform: process.platform,
      electronApp: app
    }),
    serviceEnvironment: () => {
      const ai = store.getAiConfigPublic()
      return {
        KNOWBOOK_USER_DATA: userDataRoot,
        KNOWBOOK_DATABASE_PATH: databasePath,
        KNOWBOOK_APP_PATH: app.getAppPath(),
        KNOWBOOK_AI_ENABLED: ai.enabled ? '1' : '0',
        KNOWBOOK_AI_API_KEY: getDecryptedAiApiKey() ?? '',
        KNOWBOOK_AI_BASE_URL: ai.baseUrl,
        KNOWBOOK_AI_MODEL: ai.model
      }
    },
    backupDatabase: (destinationPath) => store.backupDatabase(destinationPath),
    preparePublishedPackage: createSystemPluginPackagePreparer({
      repository: store.pluginPlatform,
      runtimeRoot: systemPluginRuntimeRoot,
      logRoot: systemPluginLogRoot
    }),
    activateRenderer: activateFullTrustRenderer,
    commitRenderer: commitFullTrustRenderer,
    deactivateRenderer: deactivateFullTrustRenderer,
    createServices: createFullTrustPluginServices,
    createServiceRpcMethods: ({ plugin }) => createKnowbookFullTrustServiceRpcMethods(
      createFullTrustPluginServices({
        plugin,
        registerDisposable: () => undefined
      })
    )
  })
  assistantAgent = new AssistantAgentService(
    store.assistantSessions,
    pluginPlatformV2,
    {
      workspaceId: LOCAL_WORKSPACE_ID,
      getAiConfig: () => {
        const config = store.getAiConfigPublic()
        return {
          enabled: config.enabled,
          apiKey: getDecryptedAiApiKey(),
          baseUrl: config.baseUrl,
          model: config.model
        }
      },
      onChanged: (change: AssistantSessionChangedEvent) => {
        BrowserWindow.getAllWindows().forEach((window) => {
          if (!window.webContents.isDestroyed()) {
            window.webContents.send(ASSISTANT_SESSION_CHANGED_CHANNEL, change)
          }
        })
        pluginMutationNotifier.notify()
      }
    }
  )
  webClipExtractionWorker = earlyWebClipExtractionWorker ?? new WebClipExtractionWorkerRunner()
  webClipper = new WebClipperService(store, webClipAssetRoot, {
    allowPrivateNetwork: process.env['KNOWBOOK_ALLOW_PRIVATE_WEB_CLIP'] === '1',
    extractWebClip: webClipExtractionWorker.run
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
    onStateChanged: () => pluginMutationNotifier.notify()
  })
  appUpdateManager = new AppUpdateManager()
  servicesInitialized = true
}

function protectAiApiKey(apiKey: string): string {
  return protectCredential(apiKey, aiCredentialStorage)
}

function getDecryptedAiApiKey(): string | null {
  const storedApiKey = store.getAiApiKey()
  if (!storedApiKey) {
    return null
  }

  const revealed = revealCredential(storedApiKey, aiCredentialStorage)
  if (revealed.protectedValueToPersist) {
    store.saveSetting('ai.apiKey', revealed.protectedValueToPersist)
  }
  return revealed.value
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

async function activateFullTrustRenderer(input: {
  pluginId: string
  version: string
  revisionHash: string
  source: string
}): Promise<void> {
  const window = mainWindow
  if (!window || window.webContents.isDestroyed()) {
    throw new Error('Full Trust renderer activation requires an active KnowBook window.')
  }
  const payload = JSON.stringify(input)
  const script = `
    (async () => {
      const input = ${payload};
      const registry = window.knowbookFullTrust;
      if (!registry || typeof registry.activatePlugin !== 'function') {
        throw new Error('Full Trust renderer registry is unavailable.');
      }
      await registry.activatePlugin({
        id: input.pluginId,
        version: input.version,
        revisionHash: input.revisionHash
      }, async (api) => {
        let exported;
        if (/^\\s*(?:import|export)\\s/m.test(input.source)) {
          const url = URL.createObjectURL(new Blob([input.source], { type: 'text/javascript' }));
          try {
            exported = await import(url);
          } finally {
            URL.revokeObjectURL(url);
          }
        } else {
          const module = { exports: {} };
          const evaluate = new Function(
            'module',
            'exports',
            'React',
            'ReactDOM',
            'ReactDOMClient',
            'window',
            'document',
            input.source + '\\n//# sourceURL=knowbook-full-trust://' + encodeURIComponent(input.pluginId) + '/renderer.js'
          );
          const returned = evaluate(
            module,
            module.exports,
            api.React,
            api.ReactDOM,
            api.ReactDOMClient,
            window,
            document
          );
          exported = returned === undefined ? module.exports : returned;
        }
        const initializer = exported?.default ?? exported?.activate ?? exported;
        if (typeof initializer !== 'function') {
          throw new Error('Full Trust renderer entry must export an initializer function.');
        }
        return await initializer(api);
      });
    })()
  `
  await window.webContents.executeJavaScript(script, true)
}

async function commitFullTrustRenderer(pluginId: string, revisionHash: string): Promise<void> {
  const window = mainWindow
  if (!window || window.webContents.isDestroyed()) {
    throw new Error('Full Trust renderer commit requires an active KnowBook window.')
  }
  const encodedPluginId = JSON.stringify(pluginId)
  const encodedRevisionHash = JSON.stringify(revisionHash)
  await window.webContents.executeJavaScript(
    `(() => {
      const registry = window.knowbookFullTrust;
      if (!registry || typeof registry.commitPlugin !== 'function') {
        throw new Error('Full Trust renderer registry commit API is unavailable.');
      }
      return registry.commitPlugin(${encodedPluginId}, ${encodedRevisionHash});
    })()`,
    true
  )
}

async function deactivateFullTrustRenderer(pluginId: string): Promise<void> {
  try {
    const window = mainWindow
    if (!window || window.webContents.isDestroyed()) return
    const encodedPluginId = JSON.stringify(pluginId)
    await window.webContents.executeJavaScript(
      `window.knowbookFullTrust?.deactivatePlugin(${encodedPluginId})`,
      true
    )
  } finally {
    removeSystemPluginFramePolicies(pluginId)
  }
}

async function deactivateAllFullTrustRenderers(): Promise<void> {
  try {
    const window = mainWindow
    if (!window || window.webContents.isDestroyed()) return
    await window.webContents.executeJavaScript(
      'window.knowbookFullTrust?.deactivateAll()',
      true
    )
  } finally {
    const pluginIds = new Set(
      [...fullTrustFramePolicies.values()].map((policy) => policy.pluginId)
    )
    for (const pluginId of pluginIds) removeSystemPluginFramePolicies(pluginId)
  }
}

async function synchronizeFullTrustRendererPlugins(): Promise<void> {
  if (!servicesInitialized) return
  for (const summary of systemPluginManager.list()) {
    const packageRecord = summary.currentPackage
    if (
      summary.installation.status !== 'active'
      || !packageRecord
      || summary.runtime?.status !== 'active'
      || summary.runtime.packageId !== packageRecord.id
    ) continue
    const manifest = normalizeSystemPluginV3Manifest(packageRecord.manifestSnapshot)
    if (!manifest.entries.renderer) continue
    const runtimeRoot = getSystemPluginRuntimeRoot(packageRecord)
    const entryPath = resolve(runtimeRoot, manifest.entries.renderer)
    if (!isPathInsideRoot(entryPath, runtimeRoot)) {
      console.error(`Blocked Full Trust renderer entry outside package root: ${manifest.id}`)
      await systemPluginManager.disable(manifest.id).catch(() => undefined)
      continue
    }
    try {
      await activateFullTrustRenderer({
        pluginId: manifest.id,
        version: manifest.version,
        revisionHash: `sha256:${packageRecord.contentHash}`,
        source: readFileSync(entryPath, 'utf8')
      })
      await commitFullTrustRenderer(manifest.id, `sha256:${packageRecord.contentHash}`)
    } catch (error) {
      console.error(`Full Trust renderer activation failed for ${manifest.id}.`, error)
      await systemPluginManager.disable(manifest.id).catch(() => undefined)
    }
  }
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
      preload: join(app.getAppPath(), 'out', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    const policyEntry = [...fullTrustFramePolicies.entries()].find(([, candidate]) => (
      candidate.popupName === details.frameName
    ))
    const policy = policyEntry?.[1]
    if (
      policyEntry
      && policy
      && policy.allowPopups
      && isActiveSystemPluginRevision(policy.pluginId, policy.revisionHash)
      && isAllowedFullTrustFrameUrl(details.url, policy.allowedOrigins)
    ) {
      const [frameName] = policyEntry
      const popup = new BrowserWindow({
        width: 960,
        height: 720,
        parent: mainWindow ?? undefined,
        webPreferences: {
          contextIsolation: false,
          sandbox: false,
          nodeIntegration: true
        }
      })
      const webContentsId = popup.webContents.id
      fullTrustPopupWindows.set(webContentsId, { frameName, window: popup })
      popup.once('closed', () => fullTrustPopupWindows.delete(webContentsId))
      popup.webContents.on('will-navigate', (event, url) => {
        const livePolicy = fullTrustFramePolicies.get(frameName)
        if (
          !livePolicy
          || !isActiveSystemPluginRevision(livePolicy.pluginId, livePolicy.revisionHash)
          || !isAllowedFullTrustFrameUrl(url, livePolicy.allowedOrigins)
        ) event.preventDefault()
      })
      popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      void popup.loadURL(details.url).catch((error) => {
        console.error(`Full Trust popup failed to load for ${policy.pluginId}.`, error)
        if (!popup.isDestroyed()) popup.close()
      })
    }
    // v2 and ordinary renderer frames remain blocked. Full Trust popups require
    // an exact, live policy token registered by an active v3 plugin. The host
    // creates a separate privileged BrowserWindow because Electron prevents a
    // sandboxed opener from elevating a native child window's preferences.
    return { action: 'deny' }
  })

  const fullTrustDownloadHandler = (
    event: Electron.Event,
    item: Electron.DownloadItem
  ): void => {
    const url = item.getURL()
    const allowed = [...fullTrustFramePolicies.values()].some((policy) => (
      policy.allowDownloads
      && isActiveSystemPluginRevision(policy.pluginId, policy.revisionHash)
      && isAllowedFullTrustFrameUrl(url, policy.allowedOrigins)
    ))
    if (!allowed) event.preventDefault()
  }
  const pluginSession = mainWindow.webContents.session
  pluginSession.setPermissionRequestHandler((webContents, _permission, callback, details) => {
    callback(Boolean(findFullTrustPermissionPolicy(
      webContents,
      details.requestingUrl,
      details.isMainFrame
    )))
  })
  pluginSession.setPermissionCheckHandler((webContents, _permission, requestingOrigin, details) => (
    Boolean(findFullTrustPermissionPolicy(
      webContents,
      details.requestingUrl ?? details.securityOrigin ?? requestingOrigin,
      details.isMainFrame
    ))
  ))
  pluginSession.setDevicePermissionHandler((details) => (
    [...fullTrustFramePolicies.values()].some((policy) => (
      policy.allowPermissions
      && isActiveSystemPluginRevision(policy.pluginId, policy.revisionHash)
      && isAllowedFullTrustFrameUrl(details.origin, policy.allowedOrigins)
    ))
  ))
  pluginSession.on('will-download', fullTrustDownloadHandler)
  mainWindow.once('closed', () => {
    pluginSession.removeListener('will-download', fullTrustDownloadHandler)
    pluginSession.setPermissionRequestHandler(null)
    pluginSession.setPermissionCheckHandler(null)
    pluginSession.setDevicePermissionHandler(null)
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isSameOriginNavigation(mainWindow?.webContents.getURL(), url)) {
      return
    }

    event.preventDefault()
    void openManagedExternalUrl(url).catch((error) => {
      console.warn('Blocked or failed to navigate renderer to an external URL.', error)
    })
  })

  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) {
      const policy = event.frame?.name ? fullTrustFramePolicies.get(event.frame.name) : null
      if (
        policy
        && policy.allowNavigation
        && isActiveSystemPluginRevision(policy.pluginId, policy.revisionHash)
        && isAllowedFullTrustFrameUrl(event.url, policy.allowedOrigins)
      ) return
      // Only exact, live documents issued by the main-process registry may be
      // loaded in a subframe. Self-navigation to network/file/data/blob URLs is
      // rejected before Chromium issues the request.
      if (!getPluginUiDocumentRegistration(event.url)) event.preventDefault()
    }
  })

  mainWindow.on('closed', () => {
    rejectPendingPluginUiPreparations('Plugin iframe UI preparation was cancelled because the renderer closed.')
    mainWindow = null
    for (const popup of fullTrustPopupWindows.values()) {
      if (!popup.window.isDestroyed()) popup.window.close()
    }
    fullTrustPopupWindows.clear()
    fullTrustFramePolicies.clear()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    void synchronizeFullTrustRendererPlugins().catch((error) => {
      console.error('Full Trust renderer synchronization failed.', error)
    })
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']).catch((error) => {
      console.warn('Failed to load the renderer dev server URL.', error)
    })
  } else {
    void mainWindow.loadFile(join(app.getAppPath(), 'out', 'renderer', 'index.html')).catch((error) => {
      console.error('Failed to load the packaged renderer entry.', error)
    })
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
    setImmediate(() => {
      void pluginPlatformV2.handleWorkspaceEvent(event).catch((error) => {
        console.warn('Plugin Platform v2 workspace event handling failed.', error)
      })
    })
  })
}

function getPluginHomeData(): PluginHomeData {
  const pluginData = pluginHost.getHomeDataSnapshot()
  const v2DashboardCards = pluginPlatformV2
    .listExperienceContributions<Record<string, import('@shared/plugin-platform').PluginJsonValue>>('dashboard.card')
    .flatMap((contribution) => {
      try {
        const value = parseV2DashboardCard(contribution.value)
        return [{
          pluginId: contribution.owner.pluginId,
          id: contribution.id,
          title: value.title,
          body: value.body
        }]
      } catch (error) {
        console.warn(`Ignoring invalid v2 dashboard contribution from ${contribution.owner.pluginId}.`, error)
        return []
      }
    })
  const v2DocumentActions = pluginPlatformV2
    .listExperienceContributions<Record<string, import('@shared/plugin-platform').PluginJsonValue>>('document.action')
    .flatMap((contribution) => {
      try {
        const value = parseV2DocumentAction(contribution.value)
        return [{
          pluginId: contribution.owner.pluginId,
          id: contribution.id,
          label: value.label,
          ...(value.description ? { description: value.description } : {})
        }]
      } catch (error) {
        console.warn(`Ignoring invalid v2 document action from ${contribution.owner.pluginId}.`, error)
        return []
      }
    })
  return {
    plugins: pluginData.plugins,
    pluginDashboardCards: [...pluginData.dashboardCards, ...v2DashboardCards],
    pluginDocumentActions: [...pluginData.documentActions, ...v2DocumentActions],
    pluginUiContributions: exposePluginUiContributions(pluginPlatformV2.listUiContributions()),
    pluginV2Installations: store.pluginPlatform
      .listWorkspaceInstallations(LOCAL_WORKSPACE_ID)
      .map((installation) => {
        const definition = store.pluginPlatform.getDefinition(installation.pluginId)
        if (!definition) throw new Error(`Plugin definition "${installation.pluginId}" is missing.`)
        const revision = installation.currentRevisionId
          ? store.pluginPlatform.getRevision(installation.currentRevisionId)
          : null
        return {
          pluginId: installation.pluginId,
          name: definition.name,
          version: revision?.manifest.version ?? '—',
          description: revision?.manifest.description ?? '',
          author: revision?.manifest.author ?? null,
          source: definition.source,
          scope: 'workspace' as const,
          enabled: installation.enabled,
          currentRevisionId: installation.currentRevisionId,
          activeRunId: installation.activeRunId,
          revisionCount: store.pluginPlatform.listRevisions(installation.pluginId).length,
          updatedAt: installation.updatedAt,
          lastError: installation.lastError,
          quarantined: installation.quarantined,
          violationCount: installation.violationCount,
          quarantineReason: installation.quarantineReason,
          quarantinedAt: installation.quarantinedAt
        }
      }),
    systemPluginInstallRequests: store.pluginPlatform.listSystemPluginInstallRequests(),
    systemPlugins: getSystemPluginSummaries(),
    pluginHost: pluginData.host
  }
}

function getSystemPluginSummaries(): SystemPluginSummary[] {
  return systemPluginManager.list().map(toSystemPluginSummary)
}

function toSystemPluginSummary(summary: SystemPluginManagerSummary): SystemPluginSummary {
  const packageRecord = summary.pendingPackage ?? summary.currentPackage
  const manifest = packageRecord
    ? normalizeSystemPluginV3Manifest(packageRecord.manifestSnapshot)
    : null
  return {
    pluginId: summary.pluginId,
    name: manifest?.name ?? summary.pluginId,
    description: manifest?.description ?? '',
    publisher: manifest?.publisher ?? '—',
    enabled: summary.installation.enabled,
    safeModeDisabled: summary.installation.safeModeDisabled,
    status: summary.installation.status,
    currentVersion: summary.currentPackage?.version ?? null,
    currentArtifactSha256: summary.currentPackage?.contentHash ?? null,
    pendingVersion: summary.pendingPackage?.version ?? null,
    pendingArtifactSha256: summary.pendingPackage?.contentHash ?? null,
    riskDeclarations: manifest?.riskDeclarations ?? [],
    lastError: summary.installation.lastError,
    restartRequired: summary.installation.status === 'pending-restart'
      || summary.installation.status === 'uninstall-pending',
    updatedAt: summary.installation.updatedAt,
    runtimeStatus: summary.runtime?.status ?? null,
    backupPath: summary.installation.backupPath,
    availablePackages: store.pluginPlatform.listSystemPluginPackages(summary.pluginId, 1_000)
      .map((packageRecord) => ({
        packageId: packageRecord.id,
        version: packageRecord.version,
        artifactSha256: packageRecord.contentHash,
        status: packageRecord.status,
        createdAt: packageRecord.createdAt
      })),
    dependencyJobs: packageRecord
      ? store.pluginPlatform.listSystemPluginDependencyJobs(packageRecord.id, 100)
      : [],
    lastRun: summary.lastRun,
    recentRuns: summary.recentRuns,
    osPersistence: summary.osPersistence,
    dataPath: join(systemPluginDataRoot, summary.pluginId),
    logPath: join(systemPluginLogRoot, summary.pluginId)
  }
}

function isActiveSystemPluginRevision(pluginId: string, revisionHash: string): boolean {
  const summary = systemPluginManager.get(pluginId)
  const packageRecord = summary?.currentPackage
  return Boolean(
    summary
    && packageRecord
    && summary.installation.enabled
    && summary.installation.status === 'active'
    && summary.runtime?.status === 'active'
    && summary.runtime.packageId === packageRecord.id
    && revisionHash === `sha256:${packageRecord.contentHash}`
  )
}

function canRegisterSystemPluginRevision(pluginId: string, revisionHash: string): boolean {
  return systemPluginManager.isActivatingRevision(pluginId, revisionHash)
    || isActiveSystemPluginRevision(pluginId, revisionHash)
}

function normalizeSystemPluginFramePolicy(input: SystemPluginFramePolicyInput): SystemPluginFramePolicyInput {
  if (!canRegisterSystemPluginRevision(input.pluginId, input.revisionHash)) {
    throw new Error('Full Trust frame policies require the exact staging or active System Plugin v3 revision.')
  }
  const escapedPluginId = input.pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`^knowbook-full-trust-frame:${escapedPluginId}:[a-f0-9-]{36}$`, 'i').test(input.frameName)) {
    throw new Error('Full Trust frame policy name is invalid.')
  }
  if (!new RegExp(`^knowbook-full-trust-popup:${escapedPluginId}:[a-f0-9-]{36}$`, 'i').test(input.popupName)) {
    throw new Error('Full Trust popup policy name is invalid.')
  }
  if (!Array.isArray(input.allowedOrigins) || input.allowedOrigins.length < 1 || input.allowedOrigins.length > 100) {
    throw new Error('Full Trust frame policy requires 1 to 100 allowed origins.')
  }
  const allowedOrigins = input.allowedOrigins.map((value) => {
    if (value === '*' || value === 'javascript:') {
      throw new Error('Full Trust frame origins must be explicit and cannot use javascript: URLs.')
    }
    if (/^(?:about|blob|data|file|knowbook-plugin-ui):$/i.test(value)) return value.toLowerCase()
    const parsed = new URL(value)
    if (!parsed.origin || parsed.origin === 'null') {
      throw new Error(`Full Trust frame origin "${value}" must be an absolute origin or protocol token.`)
    }
    return parsed.origin
  })
  return {
    pluginId: input.pluginId,
    revisionHash: input.revisionHash,
    frameName: input.frameName,
    popupName: input.popupName,
    allowedOrigins: [...new Set(allowedOrigins)],
    allowPopups: input.allowPopups === true,
    allowNavigation: input.allowNavigation === true,
    allowDownloads: input.allowDownloads === true,
    allowPermissions: input.allowPermissions === true
  }
}

function isAllowedFullTrustFrameUrl(url: string, allowedOrigins: string[]): boolean {
  try {
    const parsed = new URL(url)
    const origin = parsed.origin && parsed.origin !== 'null' ? parsed.origin : parsed.protocol
    return allowedOrigins.includes(origin)
  } catch {
    return false
  }
}

function removeSystemPluginFramePolicies(pluginId: string): void {
  const removedFrameNames = new Set<string>()
  for (const [frameName, policy] of fullTrustFramePolicies) {
    if (policy.pluginId !== pluginId) continue
    removedFrameNames.add(frameName)
    fullTrustFramePolicies.delete(frameName)
  }
  for (const [webContentsId, popup] of fullTrustPopupWindows) {
    if (!removedFrameNames.has(popup.frameName)) continue
    fullTrustPopupWindows.delete(webContentsId)
    if (!popup.window.isDestroyed()) popup.window.close()
  }
}

function removeSystemPluginFramePolicy(frameName: string): void {
  fullTrustFramePolicies.delete(frameName)
  for (const [webContentsId, popup] of fullTrustPopupWindows) {
    if (popup.frameName !== frameName) continue
    fullTrustPopupWindows.delete(webContentsId)
    if (!popup.window.isDestroyed()) popup.window.close()
  }
}

function findFullTrustPermissionPolicy(
  webContents: Electron.WebContents | null,
  requestingUrl: string,
  isMainFrame: boolean
): SystemPluginFramePolicyInput | null {
  if (!webContents || !isAllowedPermissionUrl(requestingUrl)) return null
  if (mainWindow && webContents.id === mainWindow.webContents.id) {
    if (isMainFrame) return null
    return [...fullTrustFramePolicies.values()].find((policy) => (
      policy.allowPermissions
      && isActiveSystemPluginRevision(policy.pluginId, policy.revisionHash)
      && isAllowedFullTrustFrameUrl(requestingUrl, policy.allowedOrigins)
    )) ?? null
  }
  const popup = fullTrustPopupWindows.get(webContents.id)
  const policy = popup ? fullTrustFramePolicies.get(popup.frameName) : null
  return policy
    && policy.allowPermissions
    && isActiveSystemPluginRevision(policy.pluginId, policy.revisionHash)
    && isAllowedFullTrustFrameUrl(requestingUrl, policy.allowedOrigins)
    ? policy
    : null
}

function isAllowedPermissionUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol !== 'javascript:'
  } catch {
    return false
  }
}

function parseV2DashboardCard(value: Record<string, unknown>): { title: string; body: string } {
  return {
    title: requireV2ContributionText(value.title, 'v2 dashboard card title', 500),
    body: requireV2ContributionText(value.body, 'v2 dashboard card body', 10_000)
  }
}

function parseV2DocumentAction(value: Record<string, unknown>): {
  label: string
  description: string | null
  handlerId: string
} {
  const description = value.description === undefined
    ? null
    : requireV2ContributionText(value.description, 'v2 document action description', 2_000)
  const handlerId = requireV2ContributionText(value.handlerId, 'v2 document action handler id', 200)
  if (!/^[a-z0-9][a-z0-9._:/-]*$/i.test(handlerId)) {
    throw new Error('v2 document action handler id is invalid.')
  }
  return {
    label: requireV2ContributionText(value.label, 'v2 document action label', 500),
    description,
    handlerId
  }
}

function requireV2ContributionText(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

async function runV2DocumentAction(input: RunPluginDocumentActionInput): Promise<RunPluginDocumentActionResult | null> {
  const contribution = pluginPlatformV2
    .listExperienceContributions<Record<string, import('@shared/plugin-platform').PluginJsonValue>>('document.action')
    .find((candidate) => candidate.owner.pluginId === input.pluginId && candidate.id === input.actionId)
  if (!contribution) {
    return null
  }
  const action = parseV2DocumentAction(contribution.value)
  const rawResult = await pluginPlatformV2.invokeHandler(
    contribution.owner,
    action.handlerId,
    { documentId: input.documentId }
  )
  if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
    throw new Error('v2 document action returned an invalid result.')
  }
  const result = rawResult as Record<string, unknown>
  if (typeof result.refreshDocument !== 'boolean') {
    throw new Error('v2 document action refreshDocument must be a boolean.')
  }
  return {
    message: requireV2ContributionText(result.message, 'v2 document action message', 2_000),
    refreshDocument: result.refreshDocument
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('knowbook:get-home-data', () => {
    const homeData = store.getHomeDataPayload(backupRoot)
    const data: HomeDataIpcPayload = {
      ...homeData,
      documentCatalog: homeData.documentCatalog.map(encodeDocumentIndexEntry),
      ...getPluginHomeData()
    }
    return data
  })

  ipcMain.handle('knowbook:get-plugin-home-data', () => getPluginHomeData())

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
    return entries.map(encodeDocumentCatalogEntry) satisfies DocumentCatalogTuple[]
  })

  ipcMain.handle('knowbook:get-document-catalog-page', (_event, input: DocumentCatalogPageInput) => {
    const page = store.getDocumentCatalogPage(input)
    return {
      ...page,
      entries: page.entries.map(encodeDocumentCatalogEntry)
    } satisfies DocumentCatalogPageIpcPayload
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

  ipcMain.handle('knowbook:reorder-database-saved-views', (_event, input: ReorderDatabaseSavedViewsInput) => {
    return store.reorderDatabaseSavedViews(input)
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
    const protectedApiKey = !input.clearApiKey && typeof input.apiKey === 'string' && input.apiKey.trim()
      ? protectAiApiKey(normalizeAiApiKey(input.apiKey))
      : undefined
    store.updateAiConfig({
      ...input,
      apiKey: protectedApiKey
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

  ipcMain.handle('knowbook:list-assistant-sessions', () => assistantAgent.listSessions())

  ipcMain.handle('knowbook:create-assistant-session', (_event, input: CreateAssistantSessionRequest = {}) => {
    return assistantAgent.createSession(input)
  })

  ipcMain.handle('knowbook:get-assistant-session-events', (_event, sessionId: AssistantSessionId, afterSeq = 0, limit = 500) => {
    return assistantAgent.listEvents(sessionId, afterSeq, limit)
  })

  ipcMain.handle('knowbook:send-assistant-message', (_event, input: SendAssistantMessageRequest) => {
    return assistantAgent.sendMessage(input)
  })

  ipcMain.handle('knowbook:resolve-assistant-approval', (_event, input: ResolveAssistantApprovalRequest) => {
    return assistantAgent.resolveApproval(input)
  })

  ipcMain.handle('knowbook:cancel-assistant-turn', (_event, sessionId: AssistantSessionId) => {
    return assistantAgent.cancelTurn(sessionId)
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
    const result: RunPluginDocumentActionResult = await runV2DocumentAction(input)
      ?? await pluginHost.runDocumentAction(input)
    return result
  })

  ipcMain.handle('knowbook:run-plugin-ui-action', async (_event, input: RunPluginUiActionInput) => {
    const result: RunPluginUiActionResult = await pluginPlatformV2.runUiAction(input)
    return result
  })

  ipcMain.handle('knowbook:get-plugin-v2-details', (
    _event,
    input: GetPluginV2DetailsInput
  ): PluginV2Details => pluginPlatformV2.getWorkspacePluginDetails(input.pluginId))

  ipcMain.handle('knowbook:report-plugin-ui-preparation', (_event, result: PluginUiPreparationResult) => {
    completePluginUiPreparation(result)
  })

  ipcMain.handle('knowbook:report-plugin-ui-runtime-failure', async (_event, failure: PluginUiRuntimeFailure) => {
    await pluginPlatformV2.reportUiRuntimeFailure(failure)
    pluginMutationNotifier.notify()
  })

  ipcMain.handle('knowbook:recover-plugin-v2-installation', (_event, input: RecoverPluginV2InstallationInput) => {
    pluginPlatformV2.recoverWorkspaceInstallation(input.pluginId)
    pluginMutationNotifier.notify()
  })

  ipcMain.handle('knowbook:set-plugin-v2-enabled', async (_event, input: SetPluginV2EnabledInput) => {
    try {
      await pluginPlatformV2.setWorkspacePluginEnabled(input.pluginId, input.enabled)
    } finally {
      pluginMutationNotifier.notify()
    }
  })

  ipcMain.handle('knowbook:remove-plugin-v2', async (_event, input: RemovePluginV2Input) => {
    await pluginPlatformV2.removeWorkspacePlugin(input.pluginId)
    pluginMutationNotifier.notify()
  })

  ipcMain.handle('knowbook:install-marketplace-plugin-package', async (
    _event,
    input: MarketplacePluginPackage
  ): Promise<MarketplacePluginInstallResult> => {
    const result = await pluginPlatformV2.installMarketplacePackage(input)
    pluginMutationNotifier.notify()
    return result
  })

  ipcMain.handle('knowbook:request-system-plugin-install', (
    _event,
    input: SystemPluginInstallRequestInput
  ): SystemPluginInstallRequest => store.pluginPlatform.createSystemPluginInstallRequest(input))

  ipcMain.handle('knowbook:choose-and-prepare-system-plugin-install', async (event): Promise<SystemPluginInstallRequest | null> => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined
    const sourceChoiceOptions = {
      type: 'warning' as const,
      title: '安装 Full Trust 系统插件',
      message: '选择插件来源',
      detail: '目录和 ZIP 都会先复制到 staging、校验并计算精确 SHA-256；确认前不会执行任何插件代码。',
      buttons: ['选择目录', '选择 ZIP', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    }
    const sourceChoice = targetWindow
      ? await dialog.showMessageBox(targetWindow, sourceChoiceOptions)
      : await dialog.showMessageBox(sourceChoiceOptions)
    if (sourceChoice.response === 2) return null
    const options: OpenDialogOptions = {
      title: sourceChoice.response === 0
        ? '选择 Full Trust 系统插件目录'
        : '选择 Full Trust 系统插件 ZIP',
      buttonLabel: '检查插件',
      properties: sourceChoice.response === 0 ? ['openDirectory'] : ['openFile'],
      ...(sourceChoice.response === 1
        ? { filters: [{ name: 'ZIP archive', extensions: ['zip'] }] }
        : {})
    }
    const result = targetWindow
      ? await dialog.showOpenDialog(targetWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    let extracted: Awaited<ReturnType<typeof extractSystemPluginArchive>> | null = null
    try {
      const sourceDirectory = sourceChoice.response === 1
        ? (extracted = await extractSystemPluginArchive({
            archivePath: result.filePaths[0],
            extractionRoot: join(systemPluginStagingRoot, 'archive-imports')
          })).artifactDirectory
        : result.filePaths[0]
      const request = await systemPluginManager.prepareInstallFromDirectory({
        sourceDirectory,
        reason: '用户从插件中心选择本地 Full Trust artifact。',
        requestedBy: 'user'
      })
      pluginMutationNotifier.notify()
      return request
    } finally {
      if (extracted) {
        await removePath(extracted.extractionDirectory, { recursive: true, force: true })
          .catch(() => undefined)
      }
    }
  })

  ipcMain.handle('knowbook:list-system-plugin-install-requests', (): SystemPluginInstallRequest[] => (
    store.pluginPlatform.listSystemPluginInstallRequests()
  ))

  ipcMain.handle('knowbook:resolve-system-plugin-install-request', async (
    _event,
    input: ResolveSystemPluginInstallRequestInput
  ): Promise<SystemPluginInstallRequest> => {
    const resolution = await systemPluginManager.resolveInstallRequest({ ...input, actor: 'user' })
    pluginMutationNotifier.notify()
    return resolution.request
  })

  ipcMain.handle('knowbook:list-system-plugins', (): SystemPluginSummary[] => getSystemPluginSummaries())

  ipcMain.handle('knowbook:set-system-plugin-enabled', async (
    _event,
    input: SetSystemPluginEnabledInput
  ): Promise<SystemPluginSummary> => {
    const summary = input.enabled
      ? await systemPluginManager.enable(input.pluginId)
      : await systemPluginManager.disable(input.pluginId)
    if (!input.enabled) {
      removeSystemPluginFramePolicies(input.pluginId)
    }
    pluginMutationNotifier.notify()
    return toSystemPluginSummary(summary)
  })

  ipcMain.handle('knowbook:uninstall-system-plugin', async (
    _event,
    input: SystemPluginMutationInput
  ): Promise<SystemPluginSummary> => {
    removeSystemPluginFramePolicies(input.pluginId)
    const summary = await systemPluginManager.requestUninstall(input.pluginId)
    pluginMutationNotifier.notify()
    return toSystemPluginSummary(summary)
  })

  ipcMain.handle('knowbook:recover-system-plugin', async (
    _event,
    input: SystemPluginMutationInput
  ): Promise<SystemPluginSummary> => {
    const summary = await systemPluginManager.recover(input.pluginId)
    pluginMutationNotifier.notify()
    return toSystemPluginSummary(summary)
  })

  ipcMain.handle('knowbook:rollback-system-plugin', async (
    _event,
    input: RollbackSystemPluginInput
  ): Promise<SystemPluginSummary> => {
    const summary = await systemPluginManager.rollback(input.pluginId, input.packageId)
    pluginMutationNotifier.notify()
    return toSystemPluginSummary(summary)
  })

  ipcMain.handle('knowbook:start-system-plugin-service', async (
    _event,
    input: SystemPluginMutationInput
  ): Promise<SystemPluginSummary> => {
    const summary = await systemPluginManager.startService(input.pluginId)
    pluginMutationNotifier.notify()
    return toSystemPluginSummary(summary)
  })

  ipcMain.handle('knowbook:stop-system-plugin-service', async (
    _event,
    input: SystemPluginMutationInput
  ): Promise<SystemPluginSummary> => {
    const summary = await systemPluginManager.stopService(input.pluginId)
    pluginMutationNotifier.notify()
    return toSystemPluginSummary(summary)
  })

  ipcMain.handle('knowbook:request-system-plugin-os-persistence', (
    _event,
    input: SystemPluginMutationInput
  ) => {
    const record = systemPluginManager.requestOsPersistence(input.pluginId, 'user')
    pluginMutationNotifier.notify()
    return record
  })

  ipcMain.handle('knowbook:resolve-system-plugin-os-persistence', async (
    _event,
    input: ResolveSystemPluginOsPersistenceInput
  ) => {
    const record = await systemPluginManager.resolveOsPersistence({
      ...input,
      actor: 'user'
    })
    pluginMutationNotifier.notify()
    return record
  })

  ipcMain.handle('knowbook:remove-system-plugin-os-persistence', async (
    _event,
    input: SystemPluginMutationInput
  ): Promise<SystemPluginSummary> => {
    await systemPluginManager.removeOsPersistence(input.pluginId, 'user')
    pluginMutationNotifier.notify()
    const summary = systemPluginManager.get(input.pluginId)
    if (!summary) throw new Error('System plugin is not installed.')
    return toSystemPluginSummary(summary)
  })

  ipcMain.handle('knowbook:open-system-plugin-data-directory', async (
    _event,
    input: SystemPluginMutationInput
  ): Promise<void> => {
    const summary = systemPluginManager.get(input.pluginId)
    if (!summary) throw new Error('System plugin is not installed.')
    const directory = join(systemPluginDataRoot, summary.pluginId)
    mkdirSync(directory, { recursive: true })
    const errorMessage = await shell.openPath(directory)
    if (errorMessage) throw new Error(errorMessage)
  })

  ipcMain.handle('knowbook:open-system-plugin-log-directory', async (
    _event,
    input: SystemPluginMutationInput
  ): Promise<void> => {
    const summary = systemPluginManager.get(input.pluginId)
    if (!summary) throw new Error('System plugin is not installed.')
    const directory = join(systemPluginLogRoot, summary.pluginId)
    mkdirSync(directory, { recursive: true })
    const errorMessage = await shell.openPath(directory)
    if (errorMessage) throw new Error(errorMessage)
  })

  ipcMain.handle('knowbook:restart-in-system-plugin-safe-mode', (): void => {
    store.saveSetting(SYSTEM_PLUGIN_SAFE_MODE_NEXT_BOOT_KEY, '1')
    app.relaunch()
    app.quit()
  })

  ipcMain.handle('knowbook:register-system-plugin-frame-policy', (
    _event,
    input: SystemPluginFramePolicyInput
  ): void => {
    const policy = normalizeSystemPluginFramePolicy(input)
    const existing = fullTrustFramePolicies.get(policy.frameName)
    if (existing && (
      existing.pluginId !== policy.pluginId
      || existing.revisionHash !== policy.revisionHash
    )) {
      throw new Error('Full Trust frame policy token is already owned by another plugin revision.')
    }
    fullTrustFramePolicies.set(policy.frameName, policy)
  })

  ipcMain.handle('knowbook:remove-system-plugin-frame-policy', (
    _event,
    input: RemoveSystemPluginFramePolicyInput
  ): void => {
    const existing = fullTrustFramePolicies.get(input.frameName)
    if (!existing) return
    if (existing.pluginId !== input.pluginId || existing.revisionHash !== input.revisionHash) {
      throw new Error('Full Trust frame policy belongs to another plugin revision.')
    }
    removeSystemPluginFramePolicy(input.frameName)
  })

  ipcMain.handle('knowbook:trigger-backup', async () => {
    const result: BackupResult = await backupService.exportAll(true)
    return result
  })

  ipcMain.handle('knowbook:restore-backup-from-folder', async (event): Promise<BackupRestoreResult | null> => {
    if (restoreWorkflowInProgress) {
      throw new Error('A restore workflow is already in progress.')
    }

    restoreWorkflowInProgress = true
    try {
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
    } finally {
      restoreWorkflowInProgress = false
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

function protectWebClipBridgeToken(token: string): string {
  return protectCredential(token, aiCredentialStorage)
}

function persistWebClipBridgeToken(storedValue: string): void {
  store.saveSetting(WEB_CLIP_BRIDGE_TOKEN_KEY, storedValue)
}

function createWebClipBridgeToken(): string {
  const token = randomUUID().replace(/-/g, '')
  try {
    persistWebClipBridgeToken(protectWebClipBridgeToken(token))
  } catch (error) {
    console.warn(
      'The web clip bridge token could not be encrypted; storing it in plain text instead.',
      error instanceof Error ? error.message : 'Unknown credential storage error.'
    )
    persistWebClipBridgeToken(token)
  }
  return token
}

function getStoredWebClipBridgeToken(): string {
  const storedToken = store.getSettingPublic(WEB_CLIP_BRIDGE_TOKEN_KEY)
  if (!storedToken) {
    return createWebClipBridgeToken()
  }

  try {
    const revealed = revealCredential(storedToken, aiCredentialStorage)
    if (revealed.protectedValueToPersist) {
      persistWebClipBridgeToken(revealed.protectedValueToPersist)
    }
    return revealed.value
  } catch (error) {
    console.warn(
      'The stored web clip bridge token could not be decrypted; regenerating it.',
      error instanceof Error ? error.message : 'Unknown credential storage error.'
    )
    return createWebClipBridgeToken()
  }
}

function getStoredWebClipBridgeConfig(): { enabled: boolean; port: number; token: string } {
  const enabled = store.getSettingPublic(WEB_CLIP_BRIDGE_ENABLED_KEY) === 'true'
  const storedPort = Number.parseInt(store.getSettingPublic(WEB_CLIP_BRIDGE_PORT_KEY) ?? `${DEFAULT_WEB_CLIP_BRIDGE_PORT}`, 10)

  return {
    enabled,
    port: Number.isInteger(storedPort) && storedPort > 0 && storedPort <= 65_535
      ? storedPort
      : DEFAULT_WEB_CLIP_BRIDGE_PORT,
    token: getStoredWebClipBridgeToken()
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
  try {
    persistWebClipBridgeToken(protectWebClipBridgeToken(nextToken))
  } catch (error) {
    console.warn(
      'The web clip bridge token could not be encrypted; storing it in plain text instead.',
      error instanceof Error ? error.message : 'Unknown credential storage error.'
    )
    persistWebClipBridgeToken(nextToken)
  }

  return webClipBridge.applyConfig({
    enabled: input.enabled,
    port: nextPort,
    token: nextToken
  })
}

async function askAiAboutDocument(input: AskAiInput): Promise<AskAiResult> {
  const aiConfig = store.getAiConfigPublic()
  if (!aiConfig.enabled) {
    throw new Error('AI is disabled. Enable AI in settings first.')
  }

  const apiKey = getDecryptedAiApiKey()
  if (!apiKey) {
    throw new Error('Missing API key. Save an API key in AI settings.')
  }

   let relatedNotes: SemanticContextNote[] = []
   if (aiConfig.relatedNotesEnabled) {
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
    baseUrl: aiConfig.baseUrl,
    emptyResponseMessage: 'AI returned an empty response.',
    failureLabel: 'AI request',
    model: aiConfig.model,
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
  const aiConfig = store.getAiConfigPublic()
  if (!aiConfig.enabled) {
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
    baseUrl: aiConfig.baseUrl,
    emptyResponseMessage: 'AI returned an empty block edit response.',
    failureLabel: 'AI block edit request',
    model: aiConfig.model,
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
  const aiConfig = store.getAiConfigPublic()
  if (!aiConfig.enabled) {
    throw new Error('AI is disabled. Enable AI in settings first.')
  }

  if (!aiConfig.autoSummaryOnSave) {
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

  const shouldGenerateSummary = aiConfig.autoSummaryOnSave && shouldGenerateDocumentSummary(
    detail.summary,
    detail.blocks.map((block) => block.content),
    DEFAULT_DOCUMENT_SUMMARY
  )
  if (shouldGenerateSummary) {
    const generatedSummary = await generateDocumentSummaryDeduplicated(detail, aiConfig, apiKey)
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
        notifyWorkspaceMutation()
      }
    }
  } else {
    cancelDocumentSummaryGeneration(documentId)
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
    query,
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
    await earlyWebClipExtractionWorker?.destroy()
    return
  }

  if (backupTimer) {
    clearInterval(backupTimer)
    backupTimer = null
  }
  workspaceMutationNotifier.dispose()
  pluginMutationNotifier.dispose()
  cancelAllDocumentSummaryGeneration()

  try {
    const restoreCompleted = await Promise.race([
      restoreService.waitForIdle(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))
    ])
    if (!restoreCompleted) {
      console.warn('Pending markdown restore did not finish before shutdown timeout.')
    }
  } catch (error) {
    console.warn('Failed to await pending markdown restore during shutdown.', error)
  }

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

  try {
    await assistantAgent.destroy()
  } catch (error) {
    console.warn('Assistant cleanup failed during shutdown.', error)
  }

  try {
    await systemPluginManager.destroy()
  } catch (error) {
    console.warn('Full Trust system plugin cleanup failed during shutdown.', error)
  }

  try {
    await deactivateAllFullTrustRenderers()
  } catch (error) {
    console.warn('Full Trust renderer cleanup failed during shutdown.', error)
  }

  const results = await Promise.allSettled([
    webClipBridge.destroy(),
    webClipExtractionWorker.destroy(),
    pluginHost.destroy(),
    pluginPlatformV2.destroy()
  ])
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('Service cleanup failed during shutdown.', result.reason)
    }
  }

  rejectPendingPluginUiPreparations('Plugin iframe UI preparation was cancelled during shutdown.')
  pluginUiDocuments.clear()
  activePluginUiDocumentTokens.clear()
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
          'content-type': getAssetContentType(assetPath),
          'x-content-type-options': 'nosniff'
        }
      })
    } catch (error) {
      console.warn('Failed to resolve local web clip asset preview.', error)
      return new Response('Asset preview failed.', { status: 404 })
    }
  })
}

function registerPluginUiProtocol(): void {
  protocol.handle(KNOWBOOK_PLUGIN_UI_SCHEME, (request) => {
    const registration = getPluginUiDocumentRegistration(request.url)
    if (!registration) {
      return new Response('Plugin UI document is stale or unavailable.', {
        status: 410,
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      })
    }
    return new Response(registration.srcdoc, {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-security-policy': PLUGIN_IFRAME_CSP,
        'content-type': 'text/html; charset=utf-8',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff'
      }
    })
  })
  registerPluginUiE2EProbe()
}

function registerPluginUiE2EProbe(): void {
  if (
    app.isPackaged
    || process.env['KNOWBOOK_E2E_EPHEMERAL_CREDENTIAL_STORAGE'] !== '1'
    || process.env['KNOWBOOK_E2E_PLUGIN_UI_PROBE'] !== '1'
  ) return
  const target = process.env['KNOWBOOK_E2E_PLUGIN_UI_TARGET']?.trim() ?? ''
  try {
    const parsed = new URL(target)
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') return
  } catch {
    return
  }
  pluginUiDocuments.set(PLUGIN_UI_E2E_PROBE_TOKEN, {
    token: PLUGIN_UI_E2E_PROBE_TOKEN,
    srcdoc: `<!doctype html><script>parent.postMessage('plugin-frame-loaded','*');setTimeout(()=>{location.href=${JSON.stringify(target)};open(${JSON.stringify(`${target}?popup=1`)})},50)<\/script>`
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
    registerPluginUiProtocol()
    appUpdateManager.initialize()
    registerWorkspaceEventHandlers()
    registerIpcHandlers()
    pluginHost.discoverAll()
    if (process.env['KNOWBOOK_PACKAGED_PLUGIN_RUNTIME_SMOKE'] === '1') {
      void pluginPlatformV2.activateBuiltinPlugins().then(() => {
        recordPackagedRuntimeSmoke('passed')
        console.log('KnowBook packaged Plugin Platform runtime smoke passed.')
      }).catch((error) => {
        process.exitCode = 1
        recordPackagedRuntimeSmoke('failed', error)
        console.error('KnowBook packaged Plugin Platform runtime smoke failed.', error)
      }).finally(async () => {
        // The probe still owns a live QuickJS utility process after activation.
        // Dispose every service before asking Electron to tear down its Node
        // environment; an abrupt app.exit() can race the utility-process module
        // loader and turn an otherwise successful probe into a native V8 crash.
        try {
          await shutdownServices()
        } catch (error) {
          process.exitCode = 1
          recordPackagedRuntimeSmoke('failed', error)
          console.error('KnowBook packaged runtime smoke cleanup failed.', error)
        }
        shutdownComplete = true
        app.quit()
      })
      return
    }
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
        const safeModeNextBoot = store.getSettingPublic(SYSTEM_PLUGIN_SAFE_MODE_NEXT_BOOT_KEY) === '1'
        if (safeModeNextBoot) store.deleteSetting(SYSTEM_PLUGIN_SAFE_MODE_NEXT_BOOT_KEY)
        void Promise.allSettled([
          pluginHost.activateAll(),
          pluginPlatformV2.activateBuiltinPlugins(),
          systemPluginManager.startup({
            safeMode: safeModeNextBoot || process.env['KNOWBOOK_SYSTEM_PLUGIN_SAFE_MODE'] === '1'
          })
        ]).then((results) => {
          for (const result of results) {
            if (result.status === 'rejected') {
              console.error('Background plugin startup failed.', result.reason)
            }
          }
        }).catch((error) => {
          console.error('Plugin startup coordination failed.', error)
        }).finally(() => {
          pluginMutationNotifier.notify()
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
