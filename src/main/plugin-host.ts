import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import type {
  DocumentDetail,
  PluginDashboardCard,
  PluginDescriptor,
  PluginDocumentAction,
  PluginHostInfo,
  PluginManifest,
  PluginSource,
  RunPluginDocumentActionInput,
  RunPluginDocumentActionResult,
  WorkspaceEventType
} from '@shared/contracts'
import type { KnowbookStore } from './database/store'
import type { WorkspaceEvent } from './event-bus'

type PluginDashboardCardInput = {
  id: string
  title: string
  body: string
}

type PluginDocumentActionHandler = (context: { document: DocumentDetail }) =>
  | void
  | string
  | { message?: string; refreshDocument?: boolean }
  | Promise<void | string | { message?: string; refreshDocument?: boolean }>

type PluginEventHandler = (event: WorkspaceEvent) => void | Promise<void>

type RegisteredDocumentAction = {
  action: PluginDocumentAction
  handler: PluginDocumentActionHandler
}

type RegisteredDashboardCard = PluginDashboardCard & {
  update: (patch: Partial<Pick<PluginDashboardCard, 'title' | 'body'>>) => void
}

type RegisteredPlugin = {
  manifest: PluginManifest
  directory: string
  source: PluginSource
  enabled: boolean
  status: PluginDescriptor['status']
  error?: string
  dashboardCards: Map<string, RegisteredDashboardCard>
  documentActions: Map<string, RegisteredDocumentAction>
  eventHandlers: Array<{ eventTypes: Set<WorkspaceEventType>; handler: PluginEventHandler }>
  dispose?: () => void | Promise<void>
}

type PluginCommonJsModule = {
  exports: PluginModuleExports | PluginActivateFunction
}

type PluginCommonJsWrapper = (
  exports: PluginCommonJsModule['exports'],
  module: PluginCommonJsModule
) => void

type PluginActivateFunction = (api: PluginApi) =>
  | void
  | (() => void | Promise<void>)
  | Promise<void | (() => void | Promise<void>)>

type PluginModuleExports = {
  activate?: PluginActivateFunction
}

type PluginApi = {
  contributeDashboardCard: (card: PluginDashboardCardInput) => RegisteredDashboardCard
  contributeDocumentAction: (
    action: Omit<PluginDocumentAction, 'pluginId'>,
    handler: PluginDocumentActionHandler
  ) => void
  onWorkspaceEvent: (eventTypes: WorkspaceEventType | WorkspaceEventType[], handler: PluginEventHandler) => void
  workspace: {
    getDocumentDetail: (documentId: string) => DocumentDetail | null
  }
  documents: {
    updateSummary: (documentId: string, summary: string) => void
  }
  log: (title: string, description: string, documentId?: string | null) => void
}

export class PluginHost {
  private readonly plugins = new Map<string, RegisteredPlugin>()

  constructor(
    private readonly store: KnowbookStore,
    private readonly roots: Array<{ path: string; source: PluginSource }>
  ) {}

  async loadAll(): Promise<void> {
    const discovered = this.discoverPlugins()
    for (const plugin of discovered) {
      this.plugins.set(plugin.manifest.id, plugin)
      if (plugin.enabled) {
        await this.activatePlugin(plugin)
      }
    }
  }

  getHomeDataSnapshot(): {
    plugins: PluginDescriptor[]
    dashboardCards: PluginDashboardCard[]
    documentActions: PluginDocumentAction[]
    host: PluginHostInfo
  } {
    const plugins = [...this.plugins.values()]
      .map((plugin): PluginDescriptor => ({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        description: plugin.manifest.description?.trim() || 'No description provided.',
        author: plugin.manifest.author?.trim() || undefined,
        source: plugin.source,
        enabled: plugin.enabled,
        status: plugin.status,
        error: plugin.error
      }))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

    const dashboardCards = [...this.plugins.values()]
      .flatMap((plugin) => [...plugin.dashboardCards.values()])
      .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'))

    const documentActions = [...this.plugins.values()]
      .flatMap((plugin) => [...plugin.documentActions.values()].map((entry) => entry.action))
      .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))

    return {
      plugins,
      dashboardCards,
      documentActions,
      host: {
        roots: this.roots.map((root) => root.path)
      }
    }
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) {
      throw new Error('Plugin not found.')
    }

    this.store.saveSetting(this.getPluginEnabledSettingKey(pluginId), enabled ? 'true' : 'false')
    plugin.enabled = enabled

    if (!enabled) {
      await this.deactivatePlugin(plugin)
      plugin.status = 'disabled'
      plugin.error = undefined
      this.store.recordWorkspaceEvent({
        type: 'plugin.loaded',
        title: `Plugin disabled: ${plugin.manifest.name}`,
        description: `Disabled plugin ${plugin.manifest.name}.`
      })
      return
    }

    await this.activatePlugin(plugin)
  }

  async handleWorkspaceEvent(event: WorkspaceEvent): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.status !== 'running') {
        continue
      }

      for (const subscription of plugin.eventHandlers) {
        if (!subscription.eventTypes.has(event.type)) {
          continue
        }

        try {
          await subscription.handler(structuredClone(event))
        } catch (error) {
          this.handlePluginError(plugin, `workspace event ${event.type}`, error)
        }
      }
    }
  }

  async runDocumentAction(input: RunPluginDocumentActionInput): Promise<RunPluginDocumentActionResult> {
    const plugin = this.plugins.get(input.pluginId)
    if (!plugin || plugin.status !== 'running') {
      throw new Error('Plugin action is not available.')
    }

    const action = plugin.documentActions.get(input.actionId)
    if (!action) {
      throw new Error('Plugin action not found.')
    }

    const document = this.store.getDocumentDetail(input.documentId)
    if (!document) {
      throw new Error('Document not found.')
    }

    try {
      const rawResult = await action.handler({ document: structuredClone(document) })
      const normalizedResult = normalizePluginActionResult(rawResult, action.action.label)
      this.store.recordWorkspaceEvent({
        type: 'plugin.action.executed',
        title: `${plugin.manifest.name}: ${action.action.label}`,
        description: normalizedResult.message,
        documentId: document.id
      })
      return normalizedResult
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown plugin action error.'
      this.store.recordWorkspaceEvent({
        type: 'plugin.action.failed',
        title: `${plugin.manifest.name}: ${action.action.label}`,
        description: errorMessage,
        documentId: document.id
      })
      throw error
    }
  }

  async destroy(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await this.deactivatePlugin(plugin)
    }
  }

  private discoverPlugins(): RegisteredPlugin[] {
    const discovered: RegisteredPlugin[] = []
    const seenPluginIds = new Set<string>()

    for (const root of this.roots) {
      if (!existsSync(root.path)) {
        continue
      }

      for (const directoryName of readdirSync(root.path)) {
        const directoryPath = join(root.path, directoryName)
        if (!statSync(directoryPath, { throwIfNoEntry: false })?.isDirectory()) {
          continue
        }

        const manifestPath = join(directoryPath, 'plugin.json')
        if (!existsSync(manifestPath)) {
          continue
        }

        try {
          const manifest = this.parseManifest(manifestPath)
          if (seenPluginIds.has(manifest.id)) {
            console.warn(`Skipping duplicate plugin id "${manifest.id}" from ${directoryPath}.`)
            continue
          }

          seenPluginIds.add(manifest.id)
          discovered.push({
            manifest,
            directory: directoryPath,
            source: root.source,
            enabled: this.readPluginEnabled(manifest),
            status: this.readPluginEnabled(manifest) ? 'disabled' : 'disabled',
            dashboardCards: new Map(),
            documentActions: new Map(),
            eventHandlers: []
          })
        } catch (error) {
          console.error(`Failed to load plugin manifest at ${manifestPath}.`, error)
        }
      }
    }

    return discovered.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name, 'zh-CN'))
  }

  private parseManifest(manifestPath: string): PluginManifest {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginManifest
    const id = raw.id?.trim()
    const name = raw.name?.trim()
    const version = raw.version?.trim()

    if (!id || !name || !version) {
      throw new Error('Plugin manifest requires id, name, and version.')
    }

    return {
      id,
      name,
      version,
      description: raw.description?.trim() || undefined,
      author: raw.author?.trim() || undefined,
      entry: raw.entry?.trim() || 'index.js',
      enabledByDefault: raw.enabledByDefault ?? true
    }
  }

  private readPluginEnabled(manifest: PluginManifest): boolean {
    const storedValue = this.store.getSettingPublic(this.getPluginEnabledSettingKey(manifest.id))
    if (storedValue === 'true') {
      return true
    }
    if (storedValue === 'false') {
      return false
    }
    return manifest.enabledByDefault ?? true
  }

  private getPluginEnabledSettingKey(pluginId: string): string {
    return `plugin.enabled.${pluginId}`
  }

  private async activatePlugin(plugin: RegisteredPlugin): Promise<void> {
    await this.deactivatePlugin(plugin)

    plugin.dashboardCards.clear()
    plugin.documentActions.clear()
    plugin.eventHandlers = []
    plugin.error = undefined

    const entryPath = join(plugin.directory, plugin.manifest.entry ?? 'index.js')
    if (!existsSync(entryPath)) {
      plugin.status = 'error'
      plugin.error = `Missing entry file: ${entryPath}`
      return
    }

    try {
      const source = readFileSync(entryPath, 'utf8')
      const module: PluginCommonJsModule = { exports: {} }
      const exports = module.exports
      const context = vm.createContext(
        {
          console: createPluginConsole(plugin.manifest.id),
          setTimeout,
          clearTimeout
        },
        {
          name: `knowbook-plugin-${plugin.manifest.id}`,
          codeGeneration: {
            strings: false,
            wasm: false
          }
        }
      )
      const script = new vm.Script(`(function (exports, module) {\n${source}\n})`, {
        filename: entryPath
      })

      const wrapper = script.runInContext(context, { timeout: 1000, displayErrors: true }) as PluginCommonJsWrapper
      wrapper(exports, module)

      const activate = this.resolveActivate(module.exports)
      if (!activate) {
        plugin.status = 'error'
        plugin.error = 'Plugin entry must export an activate(api) function.'
        return
      }

      const api = this.createPluginApi(plugin)
      const dispose = await activate(api)
      plugin.dispose = typeof dispose === 'function' ? dispose : undefined
      plugin.status = 'running'
      this.store.recordWorkspaceEvent({
        type: 'plugin.loaded',
        title: `Plugin loaded: ${plugin.manifest.name}`,
        description: `${plugin.manifest.name} is now active.`
      })
    } catch (error) {
      this.handlePluginError(plugin, 'activation', error)
    }
  }

  private resolveActivate(
    exported: PluginModuleExports | PluginActivateFunction
  ): PluginActivateFunction | undefined {
    if (typeof exported === 'function') {
      return exported
    }
    if (exported && typeof exported.activate === 'function') {
      return exported.activate
    }
    return undefined
  }

  private async deactivatePlugin(plugin: RegisteredPlugin): Promise<void> {
    if (plugin.dispose) {
      try {
        await plugin.dispose()
      } catch (error) {
        console.error(`Plugin ${plugin.manifest.id} dispose failed.`, error)
      }
    }

    plugin.dispose = undefined
    plugin.dashboardCards.clear()
    plugin.documentActions.clear()
    plugin.eventHandlers = []
    if (plugin.status === 'running') {
      plugin.status = 'disabled'
    }
  }

  private createPluginApi(plugin: RegisteredPlugin): PluginApi {
    return {
      contributeDashboardCard: (cardInput) => {
        const cardId = cardInput.id.trim()
        if (!cardId) {
          throw new Error('Dashboard card id is required.')
        }

        const card: RegisteredDashboardCard = {
          pluginId: plugin.manifest.id,
          id: cardId,
          title: cardInput.title.trim(),
          body: cardInput.body.trim(),
          update: (patch) => {
            if (typeof patch.title === 'string') {
              card.title = patch.title.trim() || card.title
            }
            if (typeof patch.body === 'string') {
              card.body = patch.body.trim() || card.body
            }
          }
        }

        plugin.dashboardCards.set(card.id, card)
        return card
      },
      contributeDocumentAction: (actionInput, handler) => {
        const actionId = actionInput.id.trim()
        if (!actionId) {
          throw new Error('Document action id is required.')
        }
        plugin.documentActions.set(actionId, {
          action: {
            pluginId: plugin.manifest.id,
            id: actionId,
            label: actionInput.label.trim(),
            description: actionInput.description?.trim() || undefined
          },
          handler
        })
      },
      onWorkspaceEvent: (eventTypes, handler) => {
        const normalizedEventTypes = new Set(Array.isArray(eventTypes) ? eventTypes : [eventTypes])
        plugin.eventHandlers.push({ eventTypes: normalizedEventTypes, handler })
      },
      workspace: {
        getDocumentDetail: (documentId: string) => {
          const detail = this.store.getDocumentDetail(documentId)
          return detail ? structuredClone(detail) : null
        }
      },
      documents: {
        updateSummary: (documentId: string, summary: string) => {
          this.store.updateDocumentSummary(documentId, summary.trim())
        }
      },
      log: (title: string, description: string, documentId?: string | null) => {
        this.store.recordWorkspaceEvent({
          type: 'plugin.action.executed',
          title: `${plugin.manifest.name}: ${title.trim()}`,
          description: description.trim(),
          documentId: documentId ?? null
        })
      }
    }
  }

  private handlePluginError(plugin: RegisteredPlugin, phase: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : `Unknown error during ${phase}.`
    plugin.status = 'error'
    plugin.error = errorMessage
    plugin.dashboardCards.clear()
    plugin.documentActions.clear()
    plugin.eventHandlers = []
    console.error(`Plugin ${plugin.manifest.id} failed during ${phase}.`, error)
  }
}

function normalizePluginActionResult(
  rawResult: void | string | { message?: string; refreshDocument?: boolean },
  actionLabel: string
): RunPluginDocumentActionResult {
  if (typeof rawResult === 'string') {
    return {
      message: rawResult,
      refreshDocument: false
    }
  }

  return {
    message: rawResult?.message?.trim() || `${actionLabel} completed.`,
    refreshDocument: rawResult?.refreshDocument ?? false
  }
}

function createPluginConsole(pluginId: string): Console {
  return {
    ...console,
    log: (...args: unknown[]) => console.log(`[plugin:${pluginId}]`, ...args),
    info: (...args: unknown[]) => console.info(`[plugin:${pluginId}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[plugin:${pluginId}]`, ...args),
    error: (...args: unknown[]) => console.error(`[plugin:${pluginId}]`, ...args)
  } as Console
}