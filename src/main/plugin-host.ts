import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import vm from 'node:vm'
import type {
  DocumentDetail,
  InstallPluginResult,
  PluginDashboardCard,
  PluginDescriptor,
  PluginDocumentAction,
  PluginHostInfo,
  PluginManifest,
  PluginSettingDescriptor,
  PluginSettingOption,
  PluginSettingType,
  PluginSettingValue,
  PluginSource,
  RunPluginDocumentActionInput,
  RunPluginDocumentActionResult,
  WorkspaceEventType
} from '@shared/contracts'

export type { PluginApi } from './plugin-sdk'
import type { KnowbookStore } from './database/store'
import type { WorkspaceEvent } from './event-bus'
import { isPluginVersionCompatible, getVersionCompatibilityMessage } from './plugin-version'

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

type RegisteredPluginSetting = PluginSettingDescriptor & {
  getValue: () => PluginSettingValue
  setValue: (value: PluginSettingValue) => void
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
  settings: Map<string, RegisteredPluginSetting>
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
  contributeSetting: (setting: {
    id: string
    label: string
    description?: string
    type: PluginSettingType
    defaultValue: PluginSettingValue
    options?: PluginSettingOption[]
  }) => {
    id: string
    pluginId: string
    getValue: () => PluginSettingValue
    setValue: (value: PluginSettingValue) => void
  }
  onWorkspaceEvent: (eventTypes: WorkspaceEventType | WorkspaceEventType[], handler: PluginEventHandler) => void
  workspace: {
    getDocumentDetail: (documentId: string) => DocumentDetail | null
  }
  documents: {
    updateSummary: (documentId: string, summary: string) => void
  }
  log: (title: string, description: string, documentId?: string | null) => void
}

type InstallCandidate = {
  manifest: PluginManifest
  targetDirectory: string
  sourceIsTarget: boolean
  existingPlugin: RegisteredPlugin | null
  targetExists: boolean
}

type InstallPluginOptions = {
  replaceExisting?: boolean
}

export type PluginInstallPreview = {
  manifest: PluginManifest
  existingPlugin: PluginDescriptor | null
  canReplace: boolean
  sourceIsTarget: boolean
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

  async reloadAll(): Promise<void> {
    const currentPlugins = [...this.plugins.values()]
    for (const plugin of currentPlugins) {
      await this.deactivatePlugin(plugin)
    }

    this.plugins.clear()

    const discovered = this.discoverPlugins()
    for (const plugin of discovered) {
      this.plugins.set(plugin.manifest.id, plugin)
      if (plugin.enabled) {
        await this.activatePlugin(plugin, false)
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
      .map((plugin): PluginDescriptor => this.toPluginDescriptor(plugin))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

    const dashboardCards = [...this.plugins.values()]
      .flatMap((plugin) => [...plugin.dashboardCards.values()])
      .map((card): PluginDashboardCard => ({
        pluginId: card.pluginId,
        id: card.id,
        title: card.title,
        body: card.body
      }))
      .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'))

    const documentActions = [...this.plugins.values()]
      .flatMap((plugin) => [...plugin.documentActions.values()].map((entry) => entry.action))
      .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))

    return {
      plugins,
      dashboardCards,
      documentActions,
      host: {
        roots: this.roots.map((root) => root.path),
        writableRoot: this.getWritableRoot()
      }
    }
  }

  previewInstallFromDirectory(sourceDirectory: string): PluginInstallPreview {
    const candidate = this.resolveInstallCandidate(sourceDirectory)
    const existingPlugin = candidate.existingPlugin ? this.toPluginDescriptor(candidate.existingPlugin) : null

    return {
      manifest: candidate.manifest,
      existingPlugin,
      canReplace: Boolean(existingPlugin && existingPlugin.source === 'user-data' && !candidate.sourceIsTarget),
      sourceIsTarget: candidate.sourceIsTarget
    }
  }

  async installPluginFromDirectory(sourceDirectory: string, options: InstallPluginOptions = {}): Promise<InstallPluginResult> {
    const candidate = this.resolveInstallCandidate(sourceDirectory)

    if (candidate.sourceIsTarget) {
      await this.reloadAll()
      const installedPlugin = this.plugins.get(candidate.manifest.id)
      if (!installedPlugin) {
        throw new Error('Plugin reload failed after install request.')
      }
      return {
        plugin: this.toPluginDescriptor(installedPlugin),
        operation: 'reloaded',
        previousVersion: installedPlugin.manifest.version
      }
    }

    if (candidate.existingPlugin?.source === 'workspace') {
      throw new Error(`Plugin id "${candidate.manifest.id}" is already provided by the workspace plugin "${candidate.existingPlugin.manifest.name}". Remove or rename the workspace plugin before installing another copy.`)
    }

    const existingUserPlugin = candidate.existingPlugin?.source === 'user-data' ? candidate.existingPlugin : null
    if ((existingUserPlugin || candidate.targetExists) && !options.replaceExisting) {
      throw new Error(`A user-data plugin with id "${candidate.manifest.id}" is already installed.`)
    }

    if (existingUserPlugin) {
      await this.deactivatePlugin(existingUserPlugin)
      this.plugins.delete(existingUserPlugin.manifest.id)
    }

    if (candidate.targetExists) {
      rmSync(candidate.targetDirectory, { recursive: true, force: true })
    }

    cpSync(sourceDirectory, candidate.targetDirectory, {
      recursive: true,
      errorOnExist: false,
      force: false
    })

    await this.reloadAll()

    const installedPlugin = this.plugins.get(candidate.manifest.id)
    if (!installedPlugin) {
      throw new Error('Installed plugin could not be discovered after reload.')
    }

    const operation = existingUserPlugin || candidate.targetExists ? 'updated' : 'installed'
    const previousVersion = existingUserPlugin?.manifest.version ?? null
    this.store.recordWorkspaceEvent({
      type: operation === 'updated' ? 'plugin.updated' : 'plugin.installed',
      title: `${operation === 'updated' ? 'Plugin updated' : 'Plugin installed'}: ${installedPlugin.manifest.name}`,
      description:
        operation === 'updated'
          ? `Updated plugin ${installedPlugin.manifest.name} from ${previousVersion ?? 'an unknown version'} to ${installedPlugin.manifest.version}.`
          : `Installed plugin ${installedPlugin.manifest.name} into ${candidate.targetDirectory}.`
    })

    return {
      plugin: this.toPluginDescriptor(installedPlugin),
      operation,
      previousVersion
    }
  }

  async removePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) {
      throw new Error('Plugin not found.')
    }

    if (plugin.source !== 'user-data') {
      throw new Error('Only plugins installed into the user-data root can be removed here.')
    }

    await this.deactivatePlugin(plugin)
    this.plugins.delete(pluginId)
    rmSync(plugin.directory, { recursive: true, force: true })
    await this.reloadAll()
    this.store.recordWorkspaceEvent({
      type: 'plugin.removed',
      title: `Plugin removed: ${plugin.manifest.name}`,
      description: `Removed plugin ${plugin.manifest.name} from ${plugin.directory}.`
    })
  }

  async reloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) {
      throw new Error('Plugin not found.')
    }

    await this.deactivatePlugin(plugin)

    const manifestPath = join(plugin.directory, 'plugin.json')
    if (!existsSync(manifestPath)) {
      plugin.status = 'error'
      plugin.error = `Missing manifest file: ${manifestPath}`
      this.store.recordWorkspaceEvent({
        type: 'plugin.reloaded',
        title: `Plugin reload failed: ${plugin.manifest.name}`,
        description: plugin.error
      })
      return
    }

    const nextManifest = this.parseManifest(manifestPath)
    if (nextManifest.id !== pluginId) {
      plugin.status = 'error'
      plugin.error = `Plugin manifest id changed from ${pluginId} to ${nextManifest.id}. Use full reload to re-index plugin ids.`
      this.store.recordWorkspaceEvent({
        type: 'plugin.reloaded',
        title: `Plugin reload failed: ${plugin.manifest.name}`,
        description: plugin.error
      })
      return
    }

    plugin.manifest = nextManifest
    plugin.enabled = this.readPluginEnabled(nextManifest)
    plugin.error = undefined

    if (plugin.enabled) {
      await this.activatePlugin(plugin, false)
    } else {
      plugin.status = 'disabled'
    }

    this.store.recordWorkspaceEvent({
      type: 'plugin.reloaded',
      title: `Plugin reloaded: ${plugin.manifest.name}`,
      description:
        plugin.status === 'running'
          ? `Reloaded plugin ${plugin.manifest.name} (${plugin.manifest.version}).`
          : `Reloaded metadata for disabled plugin ${plugin.manifest.name}.`
    })
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

  async updatePluginSetting(pluginId: string, settingId: string, value: PluginSettingValue): Promise<void> {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) {
      throw new Error('Plugin not found.')
    }

    const setting = plugin.settings.get(settingId)
    if (!setting) {
      throw new Error('Plugin setting not found.')
    }

    setting.setValue(value)
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
            status: 'disabled',
            dashboardCards: new Map(),
            documentActions: new Map(),
            settings: new Map(),
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

  private getPluginSettingKey(pluginId: string, settingId: string): string {
    return `plugin.setting.${pluginId}.${settingId}`
  }

  private normalizePluginSettingOptions(options?: PluginSettingOption[]): PluginSettingOption[] | undefined {
    if (!options) {
      return undefined
    }

    const normalized = options
      .map((option) => ({
        value: option.value.trim(),
        label: option.label.trim() || option.value.trim()
      }))
      .filter((option) => option.value.length > 0)

    if (normalized.length === 0) {
      return undefined
    }

    const seenValues = new Set<string>()
    return normalized.filter((option) => {
      if (seenValues.has(option.value)) {
        return false
      }

      seenValues.add(option.value)
      return true
    })
  }

  private normalizePluginSettingValue(
    setting: {
      type: PluginSettingType
      defaultValue: PluginSettingValue
      options?: PluginSettingOption[]
    },
    value: PluginSettingValue
  ): PluginSettingValue {
    if (setting.type === 'checkbox') {
      return Boolean(value)
    }

    const textValue = typeof value === 'string' ? value : value ? 'true' : 'false'
    if (setting.type !== 'select') {
      return textValue
    }

    const options = setting.options ?? []
    if (options.some((option) => option.value === textValue)) {
      return textValue
    }

    const fallback = typeof setting.defaultValue === 'string' ? setting.defaultValue : options[0]?.value ?? ''
    return fallback
  }

  private readPluginSettingValue(
    pluginId: string,
    settingId: string,
    type: PluginSettingType,
    defaultValue: PluginSettingValue,
    options?: PluginSettingOption[]
  ): PluginSettingValue {
    const storedValue = this.store.getSettingPublic(this.getPluginSettingKey(pluginId, settingId))
    if (storedValue === null) {
      return defaultValue
    }

    if (type === 'checkbox') {
      return storedValue === 'true'
    }

    return this.normalizePluginSettingValue({ type, defaultValue, options }, storedValue)
  }

  private serializePluginSettingValue(type: PluginSettingType, value: PluginSettingValue): string {
    if (type === 'checkbox') {
      return Boolean(value) ? 'true' : 'false'
    }

    return typeof value === 'string' ? value : value ? 'true' : 'false'
  }

  private getWritableRoot(): string | null {
    return this.roots.find((root) => root.source === 'user-data')?.path ?? null
  }

  private resolveInstallCandidate(sourceDirectory: string): InstallCandidate {
    const sourceStats = statSync(sourceDirectory, { throwIfNoEntry: false })
    if (!sourceStats?.isDirectory()) {
      throw new Error('Selected plugin folder does not exist.')
    }

    const manifestPath = join(sourceDirectory, 'plugin.json')
    if (!existsSync(manifestPath)) {
      throw new Error('Selected folder does not contain plugin.json.')
    }

    const manifest = this.parseManifest(manifestPath)
    const writableRoot = this.getWritableRoot()
    if (!writableRoot) {
      throw new Error('No writable plugin root is configured.')
    }

    mkdirSync(writableRoot, { recursive: true })
    const targetDirectory = join(writableRoot, manifest.id)
    const existingPlugin = this.plugins.get(manifest.id) ?? null

    return {
      manifest,
      targetDirectory,
      sourceIsTarget: resolve(sourceDirectory) === resolve(targetDirectory),
      existingPlugin,
      targetExists: existsSync(targetDirectory)
    }
  }

  private async activatePlugin(plugin: RegisteredPlugin, recordLoadEvent = true): Promise<void> {
    if (plugin.status === 'error') {
      return
    }

    // Check version compatibility
    const currentVersion = '0.1.0' // This should come from package.json or a config
    if (!isPluginVersionCompatible(plugin.manifest, currentVersion)) {
      const message = getVersionCompatibilityMessage(plugin.manifest, currentVersion)
      plugin.status = 'error'
      plugin.error = message ?? 'Version compatibility check failed'
      return
    }

    try {
      plugin.dashboardCards.clear()
      plugin.documentActions.clear()
      plugin.settings.clear()
      plugin.eventHandlers = []

      const api = this.createPluginApi(plugin)
      const entryPath = join(plugin.directory, plugin.manifest.entry ?? 'index.js')
      
      if (!existsSync(entryPath)) {
        plugin.status = 'error'
        plugin.error = `Missing entry file: ${entryPath}`
        return
      }

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

      // activate is PluginActivateFunction, call it with api
      const result = await activate(api)

      // result could be dispose function or void/Promise
      if (typeof result === 'function') {
        plugin.dispose = result as () => void | Promise<void>
      }
      
      if (recordLoadEvent) {
        this.store.recordWorkspaceEvent({
          type: 'plugin.loaded',
          title: `Plugin loaded: ${plugin.manifest.name}`,
          description: `Plugin ${plugin.manifest.name} v${plugin.manifest.version} loaded from ${plugin.directory}.`
        })
      }

      plugin.status = 'running'
    } catch (error) {
      plugin.status = 'error'
      plugin.error = String(error)
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
      contributeSetting: (settingInput) => {
        const settingId = settingInput.id.trim()
        const label = settingInput.label.trim()
        if (!settingId) {
          throw new Error('Plugin setting id is required.')
        }
        if (!label) {
          throw new Error('Plugin setting label is required.')
        }

        const options = settingInput.type === 'select'
          ? this.normalizePluginSettingOptions(settingInput.options)
          : undefined

        if (settingInput.type === 'select' && (!options || options.length === 0)) {
          throw new Error('Select plugin settings require at least one option.')
        }

        const defaultValue = this.normalizePluginSettingValue(
          {
            type: settingInput.type,
            defaultValue: settingInput.defaultValue,
            options
          },
          settingInput.defaultValue
        )

        const setting: RegisteredPluginSetting = {
          pluginId: plugin.manifest.id,
          id: settingId,
          label,
          description: settingInput.description?.trim() || undefined,
          type: settingInput.type,
          value: this.readPluginSettingValue(plugin.manifest.id, settingId, settingInput.type, defaultValue, options),
          defaultValue,
          options,
          getValue: () => setting.value,
          setValue: (value) => {
            const nextValue = this.normalizePluginSettingValue(
              {
                type: setting.type,
                defaultValue: setting.defaultValue,
                options: setting.options
              },
              value
            )
            setting.value = nextValue
            this.store.saveSetting(
              this.getPluginSettingKey(plugin.manifest.id, setting.id),
              this.serializePluginSettingValue(setting.type, nextValue)
            )
          }
        }

        plugin.settings.set(setting.id, setting)

        return {
          id: setting.id,
          pluginId: setting.pluginId,
          getValue: () => setting.getValue(),
          setValue: (value) => setting.setValue(value)
        }
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
    plugin.settings.clear()
    plugin.eventHandlers = []
    console.error(`Plugin ${plugin.manifest.id} failed during ${phase}.`, error)
  }

  private toPluginDescriptor(plugin: RegisteredPlugin): PluginDescriptor {
    return {
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      description: plugin.manifest.description?.trim() || 'No description provided.',
      author: plugin.manifest.author?.trim() || undefined,
      source: plugin.source,
      enabled: plugin.enabled,
      status: plugin.status,
      error: plugin.error,
      settings: [...plugin.settings.values()]
        .map((setting): PluginSettingDescriptor => ({
          pluginId: setting.pluginId,
          id: setting.id,
          label: setting.label,
          description: setting.description,
          type: setting.type,
          value: setting.value,
          defaultValue: setting.defaultValue,
          options: setting.options ? [...setting.options] : undefined
        }))
        .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
    }
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