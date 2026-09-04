import type Database from 'better-sqlite3'
import type electron from 'electron'
import { spawn as spawnChildProcess, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type {
  AiConfig,
  CreateDatabaseEntityInput,
  CreateDatabaseInput,
  CreateDatabaseSavedViewInput,
  CreateDocumentDatabaseColumnInput,
  DatabaseEntity,
  DatabaseSavedView,
  DeleteDatabaseEntitiesInput,
  DocumentCatalogEntry,
  DocumentDatabase,
  DocumentDatabaseColumn,
  DocumentDetail,
  MoveDocumentDatabaseColumnInput,
  RenameDocumentDatabaseColumnInput,
  ReorderDatabaseSavedViewsInput,
  UpdateDatabaseEntitiesInput,
  UpdateDatabaseEntityInput,
  UpdateDatabaseMetadataInput,
  UpdateDatabaseSavedViewInput,
  UpdateDocumentDatabaseColumnOptionsInput,
  UpdateDocumentDatabaseValueInput,
  UpdateDocumentInput
} from '@shared/contracts'
import type { SystemPluginOsPersistenceRecord } from '@shared/system-plugin-state'
import type { KnowbookStore } from '../database/store'
import type { WorkspaceEvent, WorkspaceEventBus } from '../event-bus'
import { buildAiAuthorizationHeader } from '../ai-auth'
import { buildAiChatCompletionsEndpoint } from '../ai-service'
import type {
  SystemPluginServiceRpcJson,
  SystemPluginServiceRpcMethodMap
} from './service-rpc'

type ElectronModule = typeof electron
type SqliteDatabase = Database.Database

export interface FullTrustAiCredentials {
  enabled: boolean
  apiKey: string | null
  baseUrl: string
  model: string
}

export interface FullTrustAiRequestInput {
  pathOrUrl?: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
  signal?: AbortSignal
}

export interface FullTrustAiCompletionInput {
  messages: unknown[]
  model?: string
  temperature?: number
  tools?: unknown[]
  toolChoice?: unknown
  responseFormat?: unknown
  extra?: Record<string, unknown>
  signal?: AbortSignal
}

export interface FullTrustDocumentCreateInput {
  parentId?: string | null
  title?: string
  summary?: string
  blocks?: UpdateDocumentInput['blocks']
}

export interface FullTrustRendererController {
  activate?(input: {
    pluginId: string
    version: string
    revisionHash: string
    source: string
  }): Promise<void>
  deactivate?(pluginId: string): Promise<void>
  registerFramePolicy?(policy: FullTrustFramePolicy): () => void
}

export interface FullTrustFramePolicy {
  pluginId: string
  frameId: string
  allowedOrigins: string[]
  allowPopups?: boolean
  allowNavigation?: boolean
  allowDownloads?: boolean
}

export interface KnowbookFullTrustServiceOptions {
  store: KnowbookStore
  sqlite: SqliteDatabase
  workspaceEventBus: WorkspaceEventBus
  electron: ElectronModule
  getMainWindow: () => Electron.BrowserWindow | null
  getAiCredentials: () => FullTrustAiCredentials
  fetchImplementation?: typeof fetch
  notifyWorkspaceMutation: () => void
  cancelDocumentSummaryGeneration?: (documentId: string) => void
  registerDisposable?: (disposable: () => void | Promise<void>, label?: string) => void
  requestOsPersistence?: () => SystemPluginOsPersistenceRecord
  renderer?: FullTrustRendererController
  /** Defaults to the live Node.js process environment. Primarily injectable for tests. */
  environment?: NodeJS.ProcessEnv
  paths: {
    userData: string
    appData: string
    documents: string
    downloads: string
    temp: string
  }
}

export interface KnowbookFullTrustServices {
  paths: KnowbookFullTrustServiceOptions['paths']
  store: KnowbookStore
  sqlite: SqliteDatabase
  documents: ReturnType<typeof createDocumentsApi>
  databases: ReturnType<typeof createDatabasesApi>
  ai: ReturnType<typeof createAiApi>
  settings: ReturnType<typeof createSettingsApi>
  secrets: ReturnType<typeof createSecretsApi>
  events: {
    subscribe: WorkspaceEventBus['subscribe']
    emit(event: WorkspaceEvent): Promise<void>
  }
  desktop: {
    electron: ElectronModule
    clipboard: Electron.Clipboard
    shell: Electron.Shell
    getMainWindow(): Electron.BrowserWindow | null
    createWindow(options?: Electron.BrowserWindowConstructorOptions): Electron.BrowserWindow
    createMenu(
      template: Array<Electron.MenuItemConstructorOptions | Electron.MenuItem>
    ): Electron.Menu
    createTray(image: Electron.NativeImage | string): Electron.Tray
  }
  background: {
    spawn(command: string, args?: string[], options?: FullTrustBackgroundSpawnOptions): ChildProcess
    daemon(command: string, args?: string[], options?: Omit<FullTrustBackgroundSpawnOptions, 'persistAfterQuit'>): ChildProcess
  }
  osPersistence: {
    /** Creates a review request; only the host UI can confirm registration. */
    request(): SystemPluginOsPersistenceRecord
  }
  renderer: FullTrustRendererController
  notifyWorkspaceMutation(): void
}

export function createKnowbookFullTrustServices(
  options: KnowbookFullTrustServiceOptions
): KnowbookFullTrustServices {
  const notify = (): void => options.notifyWorkspaceMutation()
  const environment = options.environment ?? process.env
  return {
    paths: Object.freeze({ ...options.paths }),
    store: options.store,
    sqlite: options.sqlite,
    documents: createDocumentsApi(options, notify),
    databases: createDatabasesApi(options.store, notify),
    ai: createAiApi(options.getAiCredentials, options.fetchImplementation ?? fetch),
    settings: createSettingsApi(options, notify),
    secrets: createSecretsApi(options.getAiCredentials, environment),
    events: {
      subscribe: options.workspaceEventBus.subscribe.bind(options.workspaceEventBus),
      emit: (event) => options.workspaceEventBus.emit(event)
    },
    desktop: createDesktopApi(options),
    background: createBackgroundApi(options.registerDisposable),
    osPersistence: {
      request() {
        if (!options.requestOsPersistence) {
          throw new Error('Full Trust OS persistence requests are unavailable in this runtime.')
        }
        return options.requestOsPersistence()
      }
    },
    renderer: options.renderer ?? {},
    notifyWorkspaceMutation: notify
  }
}

/**
 * Stable, JSON-only subset of the Main services made available to background
 * service entries. Direct Store/SQLite access remains available to Main entries;
 * service processes use these methods when they need domain events and renderer
 * invalidation to stay consistent.
 */
export function createKnowbookFullTrustServiceRpcMethods(
  services: KnowbookFullTrustServices
): SystemPluginServiceRpcMethodMap {
  return Object.freeze({
    'system.ping': (_params, context) => ({
      pluginId: context.pluginId,
      revisionHash: context.revisionHash,
      timestamp: new Date().toISOString()
    }),
    'paths.get': () => ({ ...services.paths }),

    'documents.list': (params) => {
      const input = requireRpcParams(params)
      return services.documents.list(optionalRpcString(input, 'databaseId'))
    },
    'documents.get': (params) => services.documents.get(
      requiredRpcString(requireRpcParams(params), 'documentId')
    ),
    'documents.create': (params) => services.documents.create(
      requireRpcParams(params) as unknown as FullTrustDocumentCreateInput
    ),
    'documents.update': (params) => {
      const input = requireRpcParams(params)
      return services.documents.update(
        requiredRpcString(input, 'documentId'),
        requiredRpcObject(input, 'input') as unknown as UpdateDocumentInput
      )
    },
    'documents.move': (params) => {
      const input = requireRpcParams(params)
      return services.documents.move(
        requiredRpcString(input, 'documentId'),
        nullableRpcString(input, 'newParentId')
      )
    },
    'documents.delete': (params) => services.documents.delete(
      requiredRpcString(requireRpcParams(params), 'documentId')
    ),

    'databases.list': () => services.databases.list(),
    'databases.create': (params) => services.databases.create(
      requireRpcParams(params) as unknown as CreateDatabaseInput
    ),
    'databases.update-metadata': (params) => services.databases.updateMetadata(
      requireRpcParams(params) as unknown as UpdateDatabaseMetadataInput
    ),
    'databases.delete': (params) => services.databases.delete(
      requiredRpcString(requireRpcParams(params), 'databaseId')
    ),
    'databases.list-columns': (params) => services.databases.listColumns(
      optionalRpcString(requireRpcParams(params), 'databaseId')
    ),
    'databases.create-column': (params) => services.databases.createColumn(
      requireRpcParams(params) as unknown as CreateDocumentDatabaseColumnInput
    ),
    'databases.rename-column': (params) => services.databases.renameColumn(
      requireRpcParams(params) as unknown as RenameDocumentDatabaseColumnInput
    ),
    'databases.move-column': (params) => services.databases.moveColumn(
      requireRpcParams(params) as unknown as MoveDocumentDatabaseColumnInput
    ),
    'databases.update-column-options': (params) => services.databases.updateColumnOptions(
      requireRpcParams(params) as unknown as UpdateDocumentDatabaseColumnOptionsInput
    ),
    'databases.delete-column': (params) => services.databases.deleteColumn(
      requiredRpcString(requireRpcParams(params), 'columnId')
    ),
    'databases.update-document-value': (params) => services.databases.updateDocumentValue(
      requireRpcParams(params) as unknown as UpdateDocumentDatabaseValueInput
    ),
    'databases.list-views': (params) => services.databases.listViews(
      requiredRpcString(requireRpcParams(params), 'databaseId')
    ),
    'databases.create-view': (params) => services.databases.createView(
      requireRpcParams(params) as unknown as CreateDatabaseSavedViewInput
    ),
    'databases.update-view': (params) => services.databases.updateView(
      requireRpcParams(params) as unknown as UpdateDatabaseSavedViewInput
    ),
    'databases.reorder-views': (params) => services.databases.reorderViews(
      requireRpcParams(params) as unknown as ReorderDatabaseSavedViewsInput
    ),
    'databases.delete-view': (params) => services.databases.deleteView(
      requiredRpcString(requireRpcParams(params), 'viewId')
    ),
    'databases.list-entities': (params) => services.databases.listEntities(
      requiredRpcString(requireRpcParams(params), 'databaseId')
    ),
    'databases.create-entity': (params) => services.databases.createEntity(
      requireRpcParams(params) as unknown as CreateDatabaseEntityInput
    ),
    'databases.update-entity': (params) => services.databases.updateEntity(
      requireRpcParams(params) as unknown as UpdateDatabaseEntityInput
    ),
    'databases.update-entities': (params) => services.databases.updateEntities(
      requireRpcParams(params) as unknown as UpdateDatabaseEntitiesInput
    ),
    'databases.delete-entity': (params) => services.databases.deleteEntity(
      requiredRpcString(requireRpcParams(params), 'entityId')
    ),
    'databases.delete-entities': (params) => services.databases.deleteEntities(
      requireRpcParams(params) as unknown as DeleteDatabaseEntitiesInput
    ),

    'settings.get': (params) => services.settings.get(
      requiredRpcString(requireRpcParams(params), 'key')
    ),
    'settings.list': (params) => services.settings.list(
      optionalRpcString(requireRpcParams(params), 'prefix') ?? ''
    ),
    'settings.set': (params) => {
      const input = requireRpcParams(params)
      services.settings.set(requiredRpcString(input, 'key'), requiredRpcString(input, 'value', true))
      return null
    },
    'settings.delete': (params) => {
      services.settings.delete(requiredRpcString(requireRpcParams(params), 'key'))
      return null
    },
    'settings.get-appearance-theme': () => services.settings.getAppearanceTheme(),
    'settings.set-appearance-theme': (params) => {
      const theme = requiredRpcString(requireRpcParams(params), 'theme')
      if (theme !== 'light' && theme !== 'dark') throw new Error('Appearance theme must be light or dark.')
      return services.settings.setAppearanceTheme(theme)
    },
    'settings.get-ai-config': (params) => {
      const includeSecret = optionalRpcBoolean(requireRpcParams(params), 'includeSecret') ?? false
      return includeSecret
        ? services.settings.getAiConfig(true)
        : services.settings.getAiConfig(false)
    },

    'secrets.get-ai-api-key': () => services.secrets.getAiApiKey(),
    'secrets.get-environment-variable': (params) => (
      services.secrets.getEnvironmentVariable(
        requiredRpcString(requireRpcParams(params), 'name')
      ) ?? null
    ),
    'secrets.get-environment-snapshot': () => services.secrets.getEnvironmentSnapshot(),

    'ai.get-config': () => services.ai.getConfig(),
    'ai.complete': (params, context) => services.ai.complete({
      ...(requireRpcParams(params) as unknown as Omit<FullTrustAiCompletionInput, 'signal'>),
      signal: context.signal
    }),
    'ai.raw-request': async (params, context) => {
      const response = await services.ai.rawRequest({
        ...(requireRpcParams(params) as unknown as Omit<FullTrustAiRequestInput, 'signal'>),
        signal: context.signal
      })
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text()
      }
    },

    'events.emit': (params) => services.events.emit(
      requireRpcParams(params) as unknown as WorkspaceEvent
    ),
    'workspace.notify-mutation': () => {
      services.notifyWorkspaceMutation()
      return null
    },
    'os-persistence.request': () => services.osPersistence.request(),

    'desktop.clipboard.read-text': () => services.desktop.clipboard.readText(),
    'desktop.clipboard.write-text': (params) => {
      services.desktop.clipboard.writeText(
        requiredRpcString(requireRpcParams(params), 'text', true)
      )
      return null
    },
    'desktop.clipboard.read-html': () => services.desktop.clipboard.readHTML(),
    'desktop.clipboard.write-html': (params) => {
      services.desktop.clipboard.writeHTML(
        requiredRpcString(requireRpcParams(params), 'html', true)
      )
      return null
    },
    'desktop.clipboard.clear': () => {
      services.desktop.clipboard.clear()
      return null
    },
    'desktop.shell.open-external': (params) => services.desktop.shell.openExternal(
      requiredRpcString(requireRpcParams(params), 'url')
    ),
    'desktop.shell.open-path': (params) => services.desktop.shell.openPath(
      requiredRpcString(requireRpcParams(params), 'path')
    ),
    'desktop.shell.show-item-in-folder': (params) => {
      services.desktop.shell.showItemInFolder(
        requiredRpcString(requireRpcParams(params), 'path')
      )
      return null
    }
  } satisfies SystemPluginServiceRpcMethodMap)
}

function createDesktopApi(
  options: KnowbookFullTrustServiceOptions
): KnowbookFullTrustServices['desktop'] {
  const { electron, registerDisposable } = options
  return {
    electron,
    clipboard: electron.clipboard,
    shell: electron.shell,
    getMainWindow: options.getMainWindow,
    createWindow(windowOptions = {}) {
      const window = new electron.BrowserWindow(windowOptions)
      registerDisposable?.(() => {
        if (!window.isDestroyed()) window.close()
      }, 'Electron BrowserWindow')
      return window
    },
    createMenu(template) {
      const menu = electron.Menu.buildFromTemplate(template)
      registerDisposable?.(() => {
        menu.closePopup()
        if (electron.Menu.getApplicationMenu() === menu) {
          electron.Menu.setApplicationMenu(null)
        }
      }, 'Electron Menu')
      return menu
    },
    createTray(image) {
      const tray = new electron.Tray(image)
      registerDisposable?.(() => {
        if (!tray.isDestroyed()) tray.destroy()
      }, 'Electron Tray')
      return tray
    }
  }
}

export interface FullTrustBackgroundSpawnOptions extends SpawnOptions {
  /** Keep the child alive after the plugin and KnowBook lifecycle stop. */
  persistAfterQuit?: boolean
}

function createBackgroundApi(
  registerDisposable: KnowbookFullTrustServiceOptions['registerDisposable']
): KnowbookFullTrustServices['background'] {
  const spawn = (
    command: string,
    args: string[] = [],
    options: FullTrustBackgroundSpawnOptions = {}
  ): ChildProcess => {
    if (typeof command !== 'string' || !command.trim() || command.includes('\0')) {
      throw new Error('Full Trust background command is invalid.')
    }
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
      throw new Error('Full Trust background arguments are invalid.')
    }
    const { persistAfterQuit = false, ...spawnOptions } = options
    const child = spawnChildProcess(command, args, {
      windowsHide: true,
      shell: false,
      ...spawnOptions,
      ...(persistAfterQuit ? { detached: true, stdio: spawnOptions.stdio ?? 'ignore' } : {})
    })
    if (persistAfterQuit) {
      child.unref()
    } else {
      registerDisposable?.(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill()
      }, `background process ${command}`)
    }
    return child
  }
  return {
    spawn,
    daemon(command, args = [], options = {}) {
      return spawn(command, args, { ...options, persistAfterQuit: true })
    }
  }
}

function createDocumentsApi(
  options: KnowbookFullTrustServiceOptions,
  notify: () => void
) {
  const { store, workspaceEventBus } = options
  return {
    list(databaseId?: string): DocumentCatalogEntry[] {
      return store.getDocumentCatalog(databaseId)
    },
    get(documentId: string): DocumentDetail | null {
      return store.getDocumentDetail(documentId)
    },
    async create(input: FullTrustDocumentCreateInput = {}): Promise<DocumentDetail> {
      const documentId = store.createDocument(input.parentId ?? null)
      try {
        if (input.title !== undefined || input.summary !== undefined || input.blocks !== undefined) {
          const current = requireDocument(store, documentId)
          store.updateDocument(documentId, {
            title: input.title ?? current.title,
            summary: input.summary ?? current.summary,
            blocks: input.blocks ?? current.blocks
          })
        }
        const document = requireDocument(store, documentId)
        const snapshot = store.getDocumentSnapshot(documentId)
        await workspaceEventBus.emit({
          type: 'document.created',
          createdAt: new Date().toISOString(),
          documentId: document.id,
          documentTitle: document.title,
          path: document.path,
          parentId: snapshot?.parentId ?? null
        })
        notify()
        return document
      } catch (error) {
        try {
          store.deleteDocument(documentId)
        } catch {
          // Preserve the primary create failure.
        }
        throw error
      }
    },
    async update(documentId: string, input: UpdateDocumentInput): Promise<DocumentDetail> {
      const before = store.getDocumentSnapshot(documentId)
      const affectedDocumentIds = store.updateDocument(documentId, input)
      const after = store.getDocumentSnapshot(documentId)
      if (before && after) {
        await workspaceEventBus.emit({
          type: 'document.updated',
          createdAt: new Date().toISOString(),
          documentId: after.id,
          documentTitle: after.title,
          path: after.path,
          affectedDocumentIds,
          pathChanged: before.path !== after.path
        })
      }
      notify()
      return requireDocument(store, documentId)
    },
    async move(documentId: string, newParentId: string | null): Promise<DocumentDetail> {
      const before = store.getDocumentSnapshot(documentId)
      const affectedDocumentIds = store.moveDocument(documentId, newParentId)
      const after = store.getDocumentSnapshot(documentId)
      if (before && after) {
        await workspaceEventBus.emit({
          type: 'document.moved',
          createdAt: new Date().toISOString(),
          documentId: after.id,
          documentTitle: after.title,
          oldPath: before.path,
          newPath: after.path,
          affectedDocumentIds
        })
      }
      notify()
      return requireDocument(store, documentId)
    },
    async delete(documentId: string): Promise<string[]> {
      const before = store.getDocumentSnapshot(documentId)
      options.cancelDocumentSummaryGeneration?.(documentId)
      const affectedDocumentIds = store.deleteDocument(documentId)
      if (before) {
        await workspaceEventBus.emit({
          type: 'document.deleted',
          createdAt: new Date().toISOString(),
          documentId: before.id,
          documentTitle: before.title,
          oldPath: before.path,
          affectedDocumentIds
        })
      }
      notify()
      return affectedDocumentIds
    }
  }
}

function createDatabasesApi(store: KnowbookStore, notify: () => void) {
  const mutate = <TArgs extends unknown[], TResult>(
    operation: (...args: TArgs) => TResult
  ) => (...args: TArgs): TResult => {
    const result = operation(...args)
    notify()
    return result
  }
  return {
    list: (): DocumentDatabase[] => store.getDatabases(),
    create: mutate((input: CreateDatabaseInput) => store.createDatabase(input)),
    updateMetadata: mutate((input: UpdateDatabaseMetadataInput) => {
      store.updateDatabaseMetadata(input)
      const database = store.getDatabases().find((candidate) => candidate.id === input.databaseId)
      if (!database) throw new Error('Database not found after metadata update.')
      return database
    }),
    delete: mutate((databaseId: string) => store.deleteDatabase(databaseId)),
    listColumns: (databaseId?: string): DocumentDatabaseColumn[] => (
      store.getDocumentDatabaseColumns(databaseId)
    ),
    createColumn: mutate((input: CreateDocumentDatabaseColumnInput) => (
      store.createDocumentDatabaseColumn(input)
    )),
    renameColumn: mutate((input: RenameDocumentDatabaseColumnInput) => (
      store.renameDocumentDatabaseColumn(input)
    )),
    moveColumn: mutate((input: MoveDocumentDatabaseColumnInput) => (
      store.moveDocumentDatabaseColumn(input)
    )),
    updateColumnOptions: mutate((input: UpdateDocumentDatabaseColumnOptionsInput) => (
      store.updateDocumentDatabaseColumnOptions(input)
    )),
    deleteColumn: mutate((columnId: string) => store.deleteDocumentDatabaseColumn(columnId)),
    updateDocumentValue: mutate((input: UpdateDocumentDatabaseValueInput) => (
      store.updateDocumentDatabaseValue(input)
    )),
    listViews: (databaseId: string): DatabaseSavedView[] => store.getDatabaseSavedViews(databaseId),
    createView: mutate((input: CreateDatabaseSavedViewInput) => store.createDatabaseSavedView(input)),
    updateView: mutate((input: UpdateDatabaseSavedViewInput) => store.updateDatabaseSavedView(input)),
    reorderViews: mutate((input: ReorderDatabaseSavedViewsInput) => (
      store.reorderDatabaseSavedViews(input)
    )),
    deleteView: mutate((viewId: string) => store.deleteDatabaseSavedView(viewId)),
    listEntities: (databaseId: string): DatabaseEntity[] => store.getDatabaseEntities(databaseId),
    createEntity: mutate((input: CreateDatabaseEntityInput) => store.createDatabaseEntity(input)),
    updateEntity: mutate((input: UpdateDatabaseEntityInput) => store.updateDatabaseEntity(input)),
    updateEntities: mutate((input: UpdateDatabaseEntitiesInput) => store.updateDatabaseEntities(input)),
    deleteEntity: mutate((entityId: string) => store.deleteDatabaseEntity(entityId)),
    deleteEntities: mutate((input: DeleteDatabaseEntitiesInput) => store.deleteDatabaseEntities(input))
  }
}

function createAiApi(
  getCredentials: () => FullTrustAiCredentials,
  fetchImplementation: typeof fetch
) {
  const rawRequest = async (input: FullTrustAiRequestInput = {}): Promise<Response> => {
    const credentials = getCredentials()
    if (!credentials.enabled) throw new Error('AI is disabled in KnowBook settings.')
    if (!credentials.apiKey) throw new Error('KnowBook AI API key is not configured.')
    const endpoint = resolveAiEndpoint(credentials.baseUrl, input.pathOrUrl)
    const headers = new Headers(input.headers)
    if (!headers.has('Authorization')) {
      headers.set('Authorization', buildAiAuthorizationHeader(credentials.apiKey))
    }
    let body: BodyInit | undefined
    if (input.body !== undefined) {
      if (typeof input.body === 'string' || input.body instanceof ArrayBuffer || ArrayBuffer.isView(input.body)) {
        body = input.body as BodyInit
      } else {
        headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json')
        body = JSON.stringify(input.body)
      }
    }
    return fetchImplementation(endpoint, {
      method: input.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      signal: input.signal
    })
  }

  const complete = async (input: FullTrustAiCompletionInput): Promise<unknown> => {
    if (!Array.isArray(input.messages)) throw new TypeError('AI completion messages must be an array.')
    const credentials = getCredentials()
    const response = await rawRequest({
      pathOrUrl: buildAiChatCompletionsEndpoint(credentials.baseUrl),
      method: 'POST',
      body: {
        ...input.extra,
        model: input.model ?? credentials.model,
        messages: input.messages,
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.tools === undefined ? {} : { tools: input.tools }),
        ...(input.toolChoice === undefined ? {} : { tool_choice: input.toolChoice }),
        ...(input.responseFormat === undefined ? {} : { response_format: input.responseFormat })
      },
      signal: input.signal
    })
    await requireOkAiResponse(response)
    return response.json()
  }

  return {
    getConfig: (): FullTrustAiCredentials => ({ ...getCredentials() }),
    getApiKey: (): string | null => getCredentials().apiKey,
    rawRequest,
    complete,
    async stream(input: FullTrustAiCompletionInput): Promise<Response> {
      const credentials = getCredentials()
      const response = await rawRequest({
        pathOrUrl: buildAiChatCompletionsEndpoint(credentials.baseUrl),
        method: 'POST',
        body: {
          ...input.extra,
          model: input.model ?? credentials.model,
          messages: input.messages,
          stream: true,
          ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
          ...(input.tools === undefined ? {} : { tools: input.tools }),
          ...(input.toolChoice === undefined ? {} : { tool_choice: input.toolChoice }),
          ...(input.responseFormat === undefined ? {} : { response_format: input.responseFormat })
        },
        signal: input.signal
      })
      await requireOkAiResponse(response)
      return response
    }
  }
}

function createSettingsApi(options: KnowbookFullTrustServiceOptions, notify: () => void) {
  const { store } = options
  function getAiConfig(): AiConfig
  function getAiConfig(includeSecret: false): AiConfig
  function getAiConfig(includeSecret: true): AiConfig & { apiKey: string | null }
  function getAiConfig(includeSecret = false): AiConfig | (AiConfig & { apiKey: string | null }) {
    const config = store.getAiConfigPublic()
    if (!includeSecret) return config
    return {
      ...config,
      apiKey: options.getAiCredentials().apiKey
    }
  }
  return {
    get: (key: string): string | null => store.getSettingPublic(key),
    list: (prefix = ''): Record<string, string> => store.getSettingsByPrefix(prefix),
    set(key: string, value: string): void {
      store.saveSetting(key, value)
      notify()
    },
    delete(key: string): void {
      store.deleteSetting(key)
      notify()
    },
    getAppearanceTheme: () => store.getAppearanceTheme(),
    setAppearanceTheme(theme: 'light' | 'dark') {
      const value = store.setAppearanceTheme(theme)
      notify()
      return value
    },
    getAiConfig
  }
}

function createSecretsApi(
  getAiCredentials: () => FullTrustAiCredentials,
  environment: NodeJS.ProcessEnv
) {
  const initialEnvironment = freezeEnvironmentSnapshot(environment)
  return {
    /** Environment captured when the plugin services were created. */
    environment: initialEnvironment,
    getAiApiKey: (): string | null => getAiCredentials().apiKey,
    /** Reads the current value, including mutations made after activation. */
    getEnvironmentVariable: (name: string): string | undefined => environment[name],
    /** Captures and freezes the environment at call time. */
    getEnvironmentSnapshot: (): Readonly<Record<string, string | undefined>> => (
      freezeEnvironmentSnapshot(environment)
    )
  }
}

function freezeEnvironmentSnapshot(
  environment: NodeJS.ProcessEnv
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({ ...environment })
}

function requireDocument(store: KnowbookStore, documentId: string): DocumentDetail {
  const document = store.getDocumentDetail(documentId)
  if (!document) throw new Error(`Document "${documentId}" was not found.`)
  return document
}

function resolveAiEndpoint(baseUrl: string, pathOrUrl: string | undefined): string {
  if (!pathOrUrl) return buildAiChatCompletionsEndpoint(baseUrl)
  try {
    const absolute = new URL(pathOrUrl)
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') {
      throw new Error('AI raw request URL must use http or https.')
    }
    return absolute.toString()
  } catch (error) {
    if (error instanceof Error && error.message === 'AI raw request URL must use http or https.') {
      throw error
    }
    const base = new URL(baseUrl)
    const normalizedBase = base.toString().endsWith('/') ? base.toString() : `${base.toString()}/`
    return new URL(pathOrUrl.replace(/^\/+/, ''), normalizedBase).toString()
  }
}

async function requireOkAiResponse(response: Response): Promise<void> {
  if (response.ok) return
  const detail = (await response.text().catch(() => response.statusText)).slice(0, 4_000)
  throw new Error(`AI request failed (${response.status}): ${detail}`)
}

function requireRpcParams(
  params: SystemPluginServiceRpcJson
): Record<string, SystemPluginServiceRpcJson> {
  if (params === null) return Object.create(null) as Record<string, SystemPluginServiceRpcJson>
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('System plugin RPC params must be an object.')
  }
  return params
}

function requiredRpcObject(
  params: Record<string, SystemPluginServiceRpcJson>,
  key: string
): Record<string, SystemPluginServiceRpcJson> {
  const value = params[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`System plugin RPC param "${key}" must be an object.`)
  }
  return value
}

function requiredRpcString(
  params: Record<string, SystemPluginServiceRpcJson>,
  key: string,
  allowEmpty = false
): string {
  const value = params[key]
  if (
    typeof value !== 'string'
    || value.includes('\0')
    || (!allowEmpty && !value.trim())
  ) {
    throw new TypeError(`System plugin RPC param "${key}" must be a valid string.`)
  }
  return value
}

function optionalRpcString(
  params: Record<string, SystemPluginServiceRpcJson>,
  key: string
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(params, key)) return undefined
  return requiredRpcString(params, key)
}

function nullableRpcString(
  params: Record<string, SystemPluginServiceRpcJson>,
  key: string
): string | null {
  if (!Object.prototype.hasOwnProperty.call(params, key) || params[key] === null) return null
  return requiredRpcString(params, key)
}

function optionalRpcBoolean(
  params: Record<string, SystemPluginServiceRpcJson>,
  key: string
): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(params, key)) return undefined
  const value = params[key]
  if (typeof value !== 'boolean') {
    throw new TypeError(`System plugin RPC param "${key}" must be a boolean.`)
  }
  return value
}
