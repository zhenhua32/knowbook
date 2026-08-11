import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import vm from 'node:vm'
import semver from 'semver'
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
import type {
  IsolatedPluginRuntime,
  IsolatedPluginRuntimeFactory,
  PluginRuntimeEffect,
  PluginRuntimeOutput,
  PluginRuntimeState
} from './plugin-runtime-protocol'

type PluginDashboardCardInput = {
  id: string
  title: string
  body: string
}

type PluginDocumentActionHandler = (context: { document: DocumentDetail }) =>
  | void
  | string
  | { message?: string; refreshDocument?: boolean }

type PluginEventHandler = (event: WorkspaceEvent) => void

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
  runtimeTimers: Map<number, ReturnType<typeof setTimeout>>
  dispose?: () => void
  context?: vm.Context
  isolatedRuntime?: IsolatedPluginRuntime
  isolatedStateFingerprint?: string
}

type PluginCommonJsModule = {
  exports: PluginModuleExports | PluginActivateFunction
}

type PluginActivateFunction = (api: PluginApi) =>
  | void
  | (() => void)

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

type PluginInvocationOptions = {
  argumentMode?: 'json' | 'direct'
  resultMode?: 'raw' | 'json'
}

type PluginHostOptions = {
  runtimeFactory?: IsolatedPluginRuntimeFactory
  pluginIdFilter?: string
  onStateChanged?: () => void
  activationConcurrency?: number
  packageLimits?: Partial<PluginPackageLimits>
}

type PluginPackageLimits = {
  maxEntries: number
  maxDepth: number
  maxFileBytes: number
  maxTotalBytes: number
}

type PluginActivationSnapshot = {
  settings: Record<string, string>
  documents: DocumentDetail[]
}

const DEFAULT_PLUGIN_ACTIVATION_CONCURRENCY = 4
const MAX_PLUGIN_ACTIVATION_CONCURRENCY = 8
const PLUGIN_SYNC_TIMEOUT_MS = 1_000
const PLUGIN_RESULT_MAX_BYTES = 1_000_000
const PLUGIN_MANIFEST_MAX_BYTES = 64_000
const PLUGIN_SOURCE_MAX_BYTES = 2_000_000
const PLUGIN_CONTRIBUTION_LIMIT = 100
const PLUGIN_TIMER_LIMIT = 100
const PLUGIN_RUNTIME_EFFECT_LIMIT = 500
const PLUGIN_RUNTIME_TEXT_MAX_BYTES = 1_000_000
const DEFAULT_PLUGIN_PACKAGE_LIMITS: PluginPackageLimits = {
  maxEntries: 1_000,
  maxDepth: 12,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024
}

export type PluginInstallPreview = {
  manifest: PluginManifest
  existingPlugin: PluginDescriptor | null
  canReplace: boolean
  sourceIsTarget: boolean
}

export class PluginHost {
  private readonly plugins = new Map<string, RegisteredPlugin>()
  private invocationSequence = 0
  private lifecycleGeneration = 0
  private initialDiscovery: {
    generation: number
    plugins: RegisteredPlugin[]
  } | null = null
  private initialLoadPromise: Promise<void> | null = null
  private reloadPromise: Promise<void> | null = null

  constructor(
    private readonly store: KnowbookStore,
    private readonly roots: Array<{ path: string; source: PluginSource }>,
    private readonly currentVersion = '0.1.2',
    private readonly onWorkspaceMutation: ((documentId: string) => void) | null = null,
    private readonly options: PluginHostOptions = {}
  ) {}

  discoverAll(): void {
    if (this.initialDiscovery || this.initialLoadPromise) {
      return
    }
    const generation = ++this.lifecycleGeneration
    const discovered = this.discoverPlugins()
    for (const plugin of discovered) {
      this.plugins.set(plugin.manifest.id, plugin)
    }
    this.initialDiscovery = { generation, plugins: discovered }
  }

  activateAll(): Promise<void> {
    if (this.initialLoadPromise) {
      return this.initialLoadPromise
    }

    this.discoverAll()
    const discovery = this.initialDiscovery
    if (!discovery) {
      return Promise.resolve()
    }

    this.initialLoadPromise = this.activatePlugins(discovery.plugins, discovery.generation, true)
    return this.initialLoadPromise
  }

  loadAll(): Promise<void> {
    this.discoverAll()
    return this.activateAll()
  }

  reloadAll(): Promise<void> {
    if (this.reloadPromise) {
      return this.reloadPromise
    }

    const generation = ++this.lifecycleGeneration
    const operation = this.performReloadAll(generation)
    this.reloadPromise = operation
    const clearReloadPromise = () => {
      if (this.reloadPromise === operation) {
        this.reloadPromise = null
      }
    }
    void operation.then(clearReloadPromise, clearReloadPromise)
    return operation
  }

  private async performReloadAll(generation: number): Promise<void> {
    const currentPlugins = [...this.plugins.values()]
    await this.runWithConcurrency(currentPlugins, async (plugin) => {
      await this.deactivatePlugin(plugin)
    })

    if (generation !== this.lifecycleGeneration) {
      return
    }

    this.plugins.clear()

    const discovered = this.discoverPlugins()
    for (const plugin of discovered) {
      this.plugins.set(plugin.manifest.id, plugin)
    }
    await this.activatePlugins(discovered, generation, false)
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

  async previewInstallFromDirectory(sourceDirectory: string): Promise<PluginInstallPreview> {
    const candidate = this.resolveInstallCandidate(sourceDirectory)
    await this.processPluginPackageDirectory(sourceDirectory)
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
      await this.processPluginPackageDirectory(sourceDirectory)
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

    const writableRoot = this.getWritableRoot()
    if (!writableRoot) {
      throw new Error('No writable plugin root is configured.')
    }
    const operationRoot = resolve(writableRoot, '.knowbook-operations')
    await mkdir(operationRoot, { recursive: true })
    const stagingDirectory = resolve(operationRoot, `install-${candidate.manifest.id}-${randomUUID()}`)
    const previousDirectory = resolve(operationRoot, `previous-${candidate.manifest.id}-${randomUUID()}`)
    const operation = existingUserPlugin || candidate.targetExists ? 'updated' : 'installed'
    const previousVersion = existingUserPlugin?.manifest.version ?? null
    let previousDirectoryCreated = false
    let targetReplaced = false

    try {
      await this.processPluginPackageDirectory(sourceDirectory, stagingDirectory)
      const stagedManifest = this.parseManifest(join(stagingDirectory, 'plugin.json'))
      if (stagedManifest.id !== candidate.manifest.id) {
        throw new Error('Staged plugin manifest id changed during installation.')
      }
      this.validatePluginPackageDirectory(stagingDirectory, stagedManifest)

      if (existingUserPlugin) {
        await this.deactivatePlugin(existingUserPlugin)
        this.plugins.delete(existingUserPlugin.manifest.id)
      }

      if (candidate.targetExists) {
        await rename(candidate.targetDirectory, previousDirectory)
        previousDirectoryCreated = true
      }
      await rename(stagingDirectory, candidate.targetDirectory)
      targetReplaced = true

      try {
        await this.reloadAll()
        const installedPlugin = this.plugins.get(candidate.manifest.id)
        if (!installedPlugin) {
          throw new Error('Installed plugin could not be discovered after reload.')
        }
        if (installedPlugin.status === 'error') {
          throw new Error(installedPlugin.error || 'Installed plugin failed to activate.')
        }

        this.store.recordWorkspaceEvent({
          type: operation === 'updated' ? 'plugin.updated' : 'plugin.installed',
          title: `${operation === 'updated' ? 'Plugin updated' : 'Plugin installed'}: ${installedPlugin.manifest.name}`,
          description:
            operation === 'updated'
              ? `Updated plugin ${installedPlugin.manifest.name} from ${previousVersion ?? 'an unknown version'} to ${installedPlugin.manifest.version}.`
              : `Installed plugin ${installedPlugin.manifest.name} into ${candidate.targetDirectory}.`
        })

        if (previousDirectoryCreated) {
          try {
            await rm(previousDirectory, { recursive: true, force: true })
          } catch (error) {
            console.warn(`Failed to remove previous plugin directory ${previousDirectory}.`, error)
          }
        }

        return {
          plugin: this.toPluginDescriptor(installedPlugin),
          operation,
          previousVersion
        }
      } catch (error) {
        if (targetReplaced && existsSync(candidate.targetDirectory)) {
          await rm(candidate.targetDirectory, { recursive: true, force: true })
        }
        if (previousDirectoryCreated && existsSync(previousDirectory)) {
          await rename(previousDirectory, candidate.targetDirectory)
        }
        await this.reloadAll()
        throw error
      }
    } finally {
      if (existsSync(stagingDirectory)) {
        await rm(stagingDirectory, { recursive: true, force: true })
      }
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
    try {
      await rm(plugin.directory, { recursive: true, force: true })
    } catch (error) {
      await this.reloadAll()
      throw error
    }
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

    let nextManifest: PluginManifest
    try {
      nextManifest = this.parseManifest(manifestPath)
    } catch (error) {
      plugin.status = 'error'
      plugin.error = error instanceof Error ? error.message : 'Plugin manifest is invalid.'
      this.store.recordWorkspaceEvent({
        type: 'plugin.reloaded',
        title: `Plugin reload failed: ${plugin.manifest.name}`,
        description: plugin.error
      })
      return
    }
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

    if (plugin.isolatedRuntime) {
      const runtime = plugin.isolatedRuntime
      try {
        const output = await runtime.updateSetting(settingId, value)
        if (plugin.isolatedRuntime === runtime) {
          this.applyIsolatedOutput(plugin, output)
        }
      } catch (error) {
        this.failIsolatedPlugin(plugin, runtime, `setting update ${settingId}`, error)
        throw new Error(this.getPluginErrorMessage(plugin, error, 'Plugin setting update failed.'))
      }
      return
    }

    setting.setValue(value)
  }

  async handleWorkspaceEvent(event: WorkspaceEvent): Promise<void> {
    let isolatedEventDocuments: DocumentDetail[] | undefined
    for (const plugin of this.plugins.values()) {
      if (plugin.status !== 'running') {
        continue
      }

      if (plugin.isolatedRuntime) {
        const runtime = plugin.isolatedRuntime
        try {
          const output = await runtime.handleWorkspaceEvent(
            event,
            isolatedEventDocuments ??= this.getWorkspaceEventDocuments(event),
            event.type === 'document.deleted' ? [event.documentId] : []
          )
          if (plugin.isolatedRuntime === runtime) {
            this.applyIsolatedOutput(plugin, output)
          }
        } catch (error) {
          this.failIsolatedPlugin(plugin, runtime, `workspace event ${event.type}`, error)
        }
        continue
      }

      for (const subscription of plugin.eventHandlers) {
        if (!subscription.eventTypes.has(event.type)) {
          continue
        }

        try {
          await this.invokePluginFunction(plugin, subscription.handler, [structuredClone(event)], `workspace event ${event.type}`)
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

    if (plugin.isolatedRuntime) {
      const runtime = plugin.isolatedRuntime
      let output: PluginRuntimeOutput<RunPluginDocumentActionResult>
      try {
        output = await runtime.runDocumentAction(input.actionId, document)
      } catch (error) {
        throw new Error(this.getPluginErrorMessage(plugin, error, 'Unknown plugin action error.'))
      }

      if (plugin.isolatedRuntime !== runtime) {
        throw new Error('Plugin runtime stopped before the action completed.')
      }

      try {
        this.applyIsolatedOutput(plugin, output)
        if (!output.result) {
          throw new Error('Plugin action did not return a result.')
        }
        return output.result
      } catch (error) {
        this.failIsolatedPlugin(plugin, runtime, `document action ${action.action.id}`, error)
        throw new Error(this.getPluginErrorMessage(plugin, error, 'Unknown plugin action error.'))
      }
    }

    try {
      const rawResult = await this.invokePluginFunction(
        plugin,
        action.handler,
        [{ document: structuredClone(document) }],
        `document action ${action.action.id}`,
        { resultMode: 'json' }
      )
      const normalizedResult = normalizePluginActionResult(rawResult, action.action.label)
      this.store.recordWorkspaceEvent({
        type: 'plugin.action.executed',
        title: `${plugin.manifest.name}: ${action.action.label}`,
        description: normalizedResult.message,
        documentId: document.id
      })
      return normalizedResult
    } catch (error) {
      const errorMessage = this.getPluginErrorMessage(plugin, error, 'Unknown plugin action error.')
      this.store.recordWorkspaceEvent({
        type: 'plugin.action.failed',
        title: `${plugin.manifest.name}: ${action.action.label}`,
        description: errorMessage,
        documentId: document.id
      })
      throw new Error(errorMessage)
    }
  }

  async destroy(): Promise<void> {
    this.lifecycleGeneration += 1
    await this.runWithConcurrency([...this.plugins.values()], async (plugin) => {
      await this.deactivatePlugin(plugin)
    })
  }

  private async activatePlugins(
    plugins: RegisteredPlugin[],
    generation: number,
    recordLoadEvent: boolean
  ): Promise<void> {
    if (generation !== this.lifecycleGeneration) {
      return
    }

    const enabledPlugins = plugins.filter((plugin) => plugin.enabled)
    let activationSnapshot: PluginActivationSnapshot | undefined
    if (this.options.runtimeFactory && enabledPlugins.length > 0) {
      try {
        activationSnapshot = this.createPluginActivationSnapshot()
      } catch (error) {
        for (const plugin of enabledPlugins) {
          if (
            generation === this.lifecycleGeneration
            && this.plugins.get(plugin.manifest.id) === plugin
            && plugin.enabled
          ) {
            plugin.status = 'error'
            plugin.error = this.getPluginErrorMessage(
              plugin,
              error,
              'Failed to prepare the isolated plugin workspace snapshot.'
            )
          }
        }
        this.options.onStateChanged?.()
        return
      }
    }

    await this.runWithConcurrency(enabledPlugins, async (plugin) => {
      if (
        generation !== this.lifecycleGeneration
        || this.plugins.get(plugin.manifest.id) !== plugin
        || !plugin.enabled
      ) {
        return
      }
      await this.activatePlugin(plugin, recordLoadEvent, activationSnapshot)
    })
  }

  private createPluginActivationSnapshot(): PluginActivationSnapshot {
    return {
      settings: this.store.getSettingsByPrefix('plugin.setting.'),
      documents: this.store.getPluginWorkspaceDocuments()
    }
  }

  private async runWithConcurrency<T>(
    items: T[],
    operation: (item: T) => Promise<void>
  ): Promise<void> {
    if (items.length === 0) {
      return
    }

    const requestedConcurrency = this.options.activationConcurrency ?? DEFAULT_PLUGIN_ACTIVATION_CONCURRENCY
    const normalizedConcurrency = Number.isFinite(requestedConcurrency)
      ? Math.floor(requestedConcurrency)
      : DEFAULT_PLUGIN_ACTIVATION_CONCURRENCY
    const concurrency = Math.min(
      Math.max(normalizedConcurrency, 1),
      MAX_PLUGIN_ACTIVATION_CONCURRENCY,
      items.length
    )
    let nextIndex = 0

    const workers = Array.from({ length: concurrency }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex]
        nextIndex += 1
        if (item !== undefined) {
          await operation(item)
        }
      }
    })
    await Promise.all(workers)
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
          if (this.options.pluginIdFilter && manifest.id !== this.options.pluginIdFilter) {
            continue
          }
          if (seenPluginIds.has(manifest.id)) {
            console.warn(`Skipping duplicate plugin id "${manifest.id}" from ${directoryPath}.`)
            continue
          }

          seenPluginIds.add(manifest.id)
          const enabled = this.readPluginEnabled(manifest)
          discovered.push({
            manifest,
            directory: directoryPath,
            source: root.source,
            enabled,
            status: enabled ? 'loading' : 'disabled',
            dashboardCards: new Map(),
            documentActions: new Map(),
            settings: new Map(),
            eventHandlers: [],
            runtimeTimers: new Map()
          })
        } catch (error) {
          console.error(`Failed to load plugin manifest at ${manifestPath}.`, error)
        }
      }
    }

    return discovered.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name, 'zh-CN'))
  }

  private parseManifest(manifestPath: string): PluginManifest {
    const manifestStat = statSync(manifestPath)
    if (!manifestStat.isFile() || manifestStat.size > PLUGIN_MANIFEST_MAX_BYTES) {
      throw new Error(`Plugin manifest must be a regular file no larger than ${PLUGIN_MANIFEST_MAX_BYTES} bytes.`)
    }

    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginManifest
    const id = raw.id?.trim()
    const name = raw.name?.trim()
    const version = raw.version?.trim()

    if (!id || !name || !version) {
      throw new Error('Plugin manifest requires id, name, and version.')
    }

    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || id === '.' || id === '..') {
      throw new Error('Plugin id may only contain letters, numbers, dots, underscores, and hyphens.')
    }

    if (!semver.valid(version)) {
      throw new Error('Plugin version must be a valid semantic version.')
    }

    const knowbookVersionRange = raw.engines?.knowbook?.trim()
    if (knowbookVersionRange && !semver.validRange(knowbookVersionRange)) {
      throw new Error('Plugin engines.knowbook must be a valid semantic version range.')
    }

    const entry = raw.entry?.trim() || 'index.js'
    const entrySegments = entry.replace(/\\/g, '/').split('/')
    if (isAbsolute(entry) || entrySegments.some((segment) => segment === '..') || entrySegments.every((segment) => !segment || segment === '.')) {
      throw new Error('Plugin entry must be a relative path inside the plugin directory.')
    }

    return {
      id,
      name,
      version,
      description: raw.description?.trim() || undefined,
      author: raw.author?.trim() || undefined,
      entry,
      enabledByDefault: raw.enabledByDefault ?? true,
      engines: knowbookVersionRange
        ? { knowbook: knowbookVersionRange }
        : undefined
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

  private async processPluginPackageDirectory(
    sourceDirectory: string,
    destinationDirectory?: string
  ): Promise<void> {
    const sourceRootStat = await lstat(sourceDirectory).catch(() => null)
    if (!sourceRootStat?.isDirectory() || sourceRootStat.isSymbolicLink()) {
      throw new Error('Selected plugin folder must be a regular directory.')
    }

    const limits = this.getPluginPackageLimits()
    const realSourceRoot = await realpath(sourceDirectory)
    let entryCount = 0
    let totalBytes = 0

    if (destinationDirectory) {
      if (this.isPathInsideRoot(destinationDirectory, sourceDirectory)) {
        throw new Error('Plugin install staging directory cannot be created inside the selected plugin folder.')
      }
      await mkdir(destinationDirectory)
    }

    const visit = async (
      source: string,
      destination: string | undefined,
      depth: number
    ): Promise<void> => {
      if (depth > limits.maxDepth) {
        throw new Error(`Plugin package exceeds the maximum directory depth of ${limits.maxDepth}.`)
      }

      for (const entry of await readdir(source, { withFileTypes: true })) {
        entryCount += 1
        if (entryCount > limits.maxEntries) {
          throw new Error(`Plugin package exceeds the ${limits.maxEntries}-entry limit.`)
        }

        const sourcePath = join(source, entry.name)
        const destinationPath = destination ? join(destination, entry.name) : undefined
        const entryStat = await lstat(sourcePath)
        if (entryStat.isSymbolicLink()) {
          throw new Error(`Plugin package cannot contain symbolic links: ${sourcePath}`)
        }

        if (entryStat.isDirectory()) {
          const realDirectoryPath = await realpath(sourcePath)
          if (!this.isPathInsideRoot(realDirectoryPath, realSourceRoot)) {
            throw new Error(`Plugin package directory resolves outside the selected root: ${sourcePath}`)
          }
          if (destinationPath) {
            await mkdir(destinationPath)
          }
          await visit(sourcePath, destinationPath, depth + 1)
          continue
        }

        if (!entryStat.isFile()) {
          throw new Error(`Plugin package contains an unsupported file type: ${sourcePath}`)
        }

        const realSourcePath = await realpath(sourcePath)
        if (!this.isPathInsideRoot(realSourcePath, realSourceRoot)) {
          throw new Error(`Plugin package file resolves outside the selected root: ${sourcePath}`)
        }
        const sourceFileStat = await stat(realSourcePath)
        if (sourceFileStat.size > limits.maxFileBytes) {
          throw new Error(`Plugin package file exceeds the ${limits.maxFileBytes}-byte limit: ${sourcePath}`)
        }
        totalBytes += sourceFileStat.size
        if (totalBytes > limits.maxTotalBytes) {
          throw new Error(`Plugin package exceeds the ${limits.maxTotalBytes}-byte total limit.`)
        }

        if (destinationPath) {
          await copyFile(realSourcePath, destinationPath)
          const copiedFileStat = await stat(destinationPath)
          totalBytes += copiedFileStat.size - sourceFileStat.size
          if (copiedFileStat.size > limits.maxFileBytes || totalBytes > limits.maxTotalBytes) {
            throw new Error('Plugin package changed while it was being copied and now exceeds its size limits.')
          }
        }
      }
    }

    await visit(sourceDirectory, destinationDirectory, 0)
  }

  private getPluginPackageLimits(): PluginPackageLimits {
    const configured = this.options.packageLimits ?? {}
    const normalize = (value: number | undefined, fallback: number, minimum: number): number => (
      typeof value === 'number' && Number.isFinite(value)
        ? Math.max(Math.floor(value), minimum)
        : fallback
    )

    return {
      maxEntries: normalize(configured.maxEntries, DEFAULT_PLUGIN_PACKAGE_LIMITS.maxEntries, 1),
      maxDepth: normalize(configured.maxDepth, DEFAULT_PLUGIN_PACKAGE_LIMITS.maxDepth, 0),
      maxFileBytes: normalize(configured.maxFileBytes, DEFAULT_PLUGIN_PACKAGE_LIMITS.maxFileBytes, 1),
      maxTotalBytes: normalize(configured.maxTotalBytes, DEFAULT_PLUGIN_PACKAGE_LIMITS.maxTotalBytes, 1)
    }
  }

  private validatePluginPackageDirectory(directory: string, manifest: PluginManifest): void {
    const entryPath = resolve(directory, manifest.entry ?? 'index.js')
    if (!this.isPathInsideRoot(entryPath, directory) || !existsSync(entryPath)) {
      throw new Error('Plugin entry is missing or outside the plugin directory.')
    }

    const resolvedEntryPath = realpathSync(entryPath)
    const entryStat = statSync(resolvedEntryPath)
    if (!this.isPathInsideRoot(resolvedEntryPath, realpathSync(directory)) || !entryStat.isFile()) {
      throw new Error('Plugin entry must be a file inside the plugin directory.')
    }
    if (entryStat.size > PLUGIN_SOURCE_MAX_BYTES) {
      throw new Error(`Plugin entry exceeds the ${PLUGIN_SOURCE_MAX_BYTES}-byte source limit.`)
    }
  }

  private isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
    const relativePath = relative(resolve(rootPath), resolve(candidatePath))
    return relativePath.length > 0 && relativePath !== '..' && !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(relativePath)
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
    const targetDirectory = resolve(writableRoot, manifest.id)
    if (!this.isPathInsideRoot(targetDirectory, writableRoot)) {
      throw new Error('Plugin install target is outside the writable plugin root.')
    }
    const existingPlugin = this.plugins.get(manifest.id) ?? null

    return {
      manifest,
      targetDirectory,
      sourceIsTarget: resolve(sourceDirectory) === resolve(targetDirectory),
      existingPlugin,
      targetExists: existsSync(targetDirectory)
    }
  }

  private async activatePlugin(
    plugin: RegisteredPlugin,
    recordLoadEvent = true,
    activationSnapshot?: PluginActivationSnapshot
  ): Promise<void> {
    if (plugin.context || plugin.isolatedRuntime) {
      await this.deactivatePlugin(plugin)
    }
    plugin.status = 'loading'
    plugin.error = undefined
    this.options.onStateChanged?.()

    // Check version compatibility
    if (!isPluginVersionCompatible(plugin.manifest, this.currentVersion)) {
      const message = getVersionCompatibilityMessage(plugin.manifest, this.currentVersion)
      plugin.status = 'error'
      plugin.error = message ?? 'Version compatibility check failed'
      this.options.onStateChanged?.()
      return
    }

    if (this.options.runtimeFactory) {
      await this.activateIsolatedPlugin(plugin, recordLoadEvent, activationSnapshot)
      return
    }

    try {
      plugin.dashboardCards.clear()
      plugin.documentActions.clear()
      plugin.settings.clear()
      plugin.eventHandlers = []

      const entryPath = resolve(plugin.directory, plugin.manifest.entry ?? 'index.js')
      if (!this.isPathInsideRoot(entryPath, plugin.directory)) {
        plugin.status = 'error'
        plugin.error = 'Plugin entry resolves outside the plugin directory.'
        return
      }
      
      if (!existsSync(entryPath)) {
        plugin.status = 'error'
        plugin.error = `Missing entry file: ${entryPath}`
        return
      }

      if (!this.isPathInsideRoot(realpathSync(entryPath), realpathSync(plugin.directory))) {
        plugin.status = 'error'
        plugin.error = 'Plugin entry resolves outside the plugin directory.'
        return
      }

      const entryStat = statSync(entryPath)
      if (!entryStat.isFile()) {
        plugin.status = 'error'
        plugin.error = 'Plugin entry must be a regular file.'
        return
      }
      if (entryStat.size > PLUGIN_SOURCE_MAX_BYTES) {
        plugin.status = 'error'
        plugin.error = `Plugin entry exceeds the ${PLUGIN_SOURCE_MAX_BYTES}-byte source limit.`
        return
      }

      const source = readFileSync(entryPath, 'utf8')
      const context = vm.createContext(Object.create(null), {
        name: `knowbook-plugin-${plugin.manifest.id}`,
        codeGeneration: {
          strings: false,
          wasm: false
        },
        microtaskMode: 'afterEvaluate'
      })
      plugin.context = context
      this.installPluginRuntimeGlobals(plugin, context)
      const api = this.createPluginApi(plugin)
      const script = new vm.Script(`
        (() => {
          const module = { exports: {} }
          const exports = module.exports
          ;(function (exports, module) {\n${source}\n})(exports, module)
          return module
        })()
      `, {
        filename: entryPath
      })

      const module = script.runInContext(context, {
        timeout: PLUGIN_SYNC_TIMEOUT_MS,
        displayErrors: true
      }) as PluginCommonJsModule

      const activate = this.resolveActivate(module.exports)
      if (!activate) {
        plugin.status = 'error'
        plugin.error = 'Plugin entry must export an activate(api) function.'
        this.releasePluginRuntime(plugin)
        return
      }

      const result = await this.invokePluginFunction(plugin, activate, [api], 'activation', {
        argumentMode: 'direct'
      })

      // A synchronous activation may return a disposer.
      if (typeof result === 'function') {
        plugin.dispose = result as () => void
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
      plugin.error = this.getPluginErrorMessage(plugin, error, 'Plugin activation failed.')
      this.releasePluginRuntime(plugin)
      plugin.dashboardCards.clear()
      plugin.documentActions.clear()
      plugin.settings.clear()
      plugin.eventHandlers = []
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
    if (plugin.isolatedRuntime) {
      const runtime = plugin.isolatedRuntime
      plugin.isolatedRuntime = undefined
      try {
        await runtime.dispose()
      } catch (error) {
        console.error(
          `Plugin ${plugin.manifest.id} isolated runtime dispose failed.`,
          this.getPluginErrorMessage(plugin, error, 'Unknown dispose error.')
        )
      }

      plugin.dashboardCards.clear()
      plugin.documentActions.clear()
      plugin.eventHandlers = []
      if (plugin.status === 'running' || plugin.status === 'loading') {
        plugin.status = 'disabled'
      }
      return
    }

    if (plugin.dispose) {
      try {
        await this.invokePluginFunction(plugin, plugin.dispose, [], 'dispose')
      } catch (error) {
        console.error(
          `Plugin ${plugin.manifest.id} dispose failed.`,
          this.getPluginErrorMessage(plugin, error, 'Unknown dispose error.')
        )
      }
    }

    this.releasePluginRuntime(plugin)
    plugin.dashboardCards.clear()
    plugin.documentActions.clear()
    plugin.eventHandlers = []
    if (plugin.status === 'running' || plugin.status === 'loading') {
      plugin.status = 'disabled'
    }
  }

  private installPluginRuntimeGlobals(plugin: RegisteredPlugin, context: vm.Context): void {
    const hostCall = (operation: string, ...args: unknown[]): unknown => {
      try {
        if (plugin.context !== context) {
          throw new Error('Plugin runtime is no longer active.')
        }

        switch (operation) {
          case 'console': {
            const level = args[0]
            const message = args[1]
            if (typeof level !== 'string' || typeof message !== 'string') {
              throw new Error('Invalid plugin console call.')
            }
            const prefix = `[plugin:${plugin.manifest.id}]`
            if (level === 'error') {
              console.error(prefix, message)
            } else if (level === 'warn') {
              console.warn(prefix, message)
            } else if (level === 'info') {
              console.info(prefix, message)
            } else {
              console.log(prefix, message)
            }
            return undefined
          }
          case 'timer.set': {
            const callback = args[0]
            const delay = args[1]
            const serializedArgs = args[2]
            if (typeof callback !== 'function' || typeof delay !== 'number' || typeof serializedArgs !== 'string') {
              throw new Error('Invalid plugin timer call.')
            }
            if (Buffer.byteLength(serializedArgs, 'utf8') > PLUGIN_RESULT_MAX_BYTES) {
              throw new Error('Plugin timer arguments are too large.')
            }
            if (plugin.runtimeTimers.size >= PLUGIN_TIMER_LIMIT) {
              throw new Error(`Plugin timer limit exceeded (${PLUGIN_TIMER_LIMIT}).`)
            }

            const timerId = ++this.invocationSequence
            const timeout = setTimeout(() => {
              plugin.runtimeTimers.delete(timerId)
              if (plugin.context !== context) {
                return
              }

              let callbackArgs: unknown[]
              try {
                const parsed = JSON.parse(serializedArgs)
                callbackArgs = Array.isArray(parsed) ? parsed : []
              } catch (error) {
                this.handlePluginError(plugin, 'timer argument parsing', error)
                return
              }

              void this.invokePluginFunction(plugin, callback as (...callbackArgs: unknown[]) => unknown, callbackArgs, 'timer callback')
                .catch((error) => this.handlePluginError(plugin, 'timer callback', error))
            }, Math.min(Math.max(delay, 0), 60_000))
            plugin.runtimeTimers.set(timerId, timeout)
            return timerId
          }
          case 'timer.clear': {
            const timerId = args[0]
            if (typeof timerId !== 'number') {
              return undefined
            }
            const timeout = plugin.runtimeTimers.get(timerId)
            if (timeout) {
              clearTimeout(timeout)
              plugin.runtimeTimers.delete(timerId)
            }
            return undefined
          }
          default:
            throw new Error('Unknown plugin runtime operation.')
        }
      } catch (error) {
        throw error instanceof Error ? error.message : 'Plugin runtime operation failed.'
      }
    }

    Object.setPrototypeOf(hostCall, null)
    Object.freeze(hostCall)

    const bridgeKey = `__knowbookRuntimeBridge${++this.invocationSequence}`
    const contextRecord = context as vm.Context & Record<string, unknown>
    Object.defineProperty(contextRecord, bridgeKey, {
      configurable: true,
      enumerable: false,
      value: hostCall,
      writable: false
    })

    try {
      new vm.Script(`
        ((hostCall) => {
          const freeze = Object.freeze
          const safeString = String
          const safeNumber = Number
          const stringify = JSON.stringify.bind(JSON)
          const format = (value) => {
            try {
              return typeof value === 'string' ? value : safeString(value)
            } catch {
              return '[unprintable]'
            }
          }
          const write = (level) => freeze((...args) => hostCall('console', level, args.map(format).join(' ')))
          const safeConsole = freeze({
            log: write('log'),
            info: write('info'),
            warn: write('warn'),
            error: write('error'),
            debug: write('debug')
          })
          const safeSetTimeout = freeze((callback, delay = 0, ...args) => {
            if (typeof callback !== 'function') {
              throw new TypeError('setTimeout callback must be a function.')
            }
            const normalizedDelay = safeNumber(delay)
            return hostCall('timer.set', callback, Number.isFinite(normalizedDelay) ? normalizedDelay : 0, stringify(args))
          })
          const safeClearTimeout = freeze((timerId) => hostCall('timer.clear', safeNumber(timerId)))
          Object.defineProperties(globalThis, {
            console: { enumerable: false, configurable: false, writable: false, value: safeConsole },
            setTimeout: { enumerable: false, configurable: false, writable: false, value: safeSetTimeout },
            clearTimeout: { enumerable: false, configurable: false, writable: false, value: safeClearTimeout }
          })
        })(${bridgeKey})
      `).runInContext(context, {
        timeout: PLUGIN_SYNC_TIMEOUT_MS,
        displayErrors: true
      })
    } finally {
      delete contextRecord[bridgeKey]
    }
  }

  private releasePluginRuntime(plugin: RegisteredPlugin): void {
    for (const timeout of plugin.runtimeTimers.values()) {
      clearTimeout(timeout)
    }
    plugin.runtimeTimers.clear()
    plugin.dispose = undefined
    plugin.context = undefined
  }

  private createPluginApi(plugin: RegisteredPlugin): PluginApi {
    const context = plugin.context
    if (!context) {
      throw new Error('Plugin context is unavailable while creating the API bridge.')
    }

    const hostApi = this.createHostPluginApi(plugin)
    const parseInput = (value: unknown): unknown => {
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > PLUGIN_RESULT_MAX_BYTES) {
        throw new Error('Plugin bridge payload is invalid or too large.')
      }
      return JSON.parse(value)
    }
    const requireString = (value: unknown): string => {
      if (typeof value !== 'string') {
        throw new Error('Plugin bridge string argument is invalid.')
      }
      return value
    }
    const requireFunction = <T extends (...args: any[]) => unknown>(value: unknown): T => {
      if (typeof value !== 'function') {
        throw new Error('Plugin bridge callback is invalid.')
      }
      return value as T
    }
    const hostCall = (operation: string, ...args: unknown[]): unknown => {
      try {
        if (plugin.context !== context) {
          throw new Error('Plugin runtime is no longer active.')
        }

        switch (operation) {
          case 'dashboard.contribute': {
            const card = hostApi.contributeDashboardCard(parseInput(args[0]) as PluginDashboardCardInput)
            return JSON.stringify({
              id: card.id,
              pluginId: card.pluginId,
              title: card.title,
              body: card.body
            })
          }
          case 'dashboard.update': {
            const card = plugin.dashboardCards.get(requireString(args[0]))
            if (!card) {
              throw new Error('Plugin dashboard card not found.')
            }
            card.update(parseInput(args[1]) as Partial<Pick<PluginDashboardCard, 'title' | 'body'>>)
            return undefined
          }
          case 'documentAction.contribute':
            hostApi.contributeDocumentAction(
              parseInput(args[0]) as Omit<PluginDocumentAction, 'pluginId'>,
              requireFunction<PluginDocumentActionHandler>(args[1])
            )
            return undefined
          case 'setting.contribute': {
            const setting = hostApi.contributeSetting(
              parseInput(args[0]) as Parameters<PluginApi['contributeSetting']>[0]
            )
            return JSON.stringify({ id: setting.id, pluginId: setting.pluginId })
          }
          case 'setting.get': {
            const setting = plugin.settings.get(requireString(args[0]))
            if (!setting) {
              throw new Error('Plugin setting not found.')
            }
            return JSON.stringify(setting.getValue())
          }
          case 'setting.set': {
            const setting = plugin.settings.get(requireString(args[0]))
            if (!setting) {
              throw new Error('Plugin setting not found.')
            }
            setting.setValue(parseInput(args[1]) as PluginSettingValue)
            return undefined
          }
          case 'event.subscribe':
            hostApi.onWorkspaceEvent(
              parseInput(args[0]) as WorkspaceEventType | WorkspaceEventType[],
              requireFunction<PluginEventHandler>(args[1])
            )
            return undefined
          case 'workspace.getDocumentDetail':
            return JSON.stringify(hostApi.workspace.getDocumentDetail(requireString(args[0])))
          case 'documents.updateSummary':
            hostApi.documents.updateSummary(requireString(args[0]), requireString(args[1]))
            return undefined
          case 'log':
            hostApi.log(
              requireString(args[0]),
              requireString(args[1]),
              args[2] == null ? null : requireString(args[2])
            )
            return undefined
          default:
            throw new Error(`Unknown plugin bridge operation: ${operation}`)
        }
      } catch (error) {
        throw error instanceof Error ? error.message : 'Plugin bridge operation failed.'
      }
    }

    Object.setPrototypeOf(hostCall, null)
    Object.freeze(hostCall)

    const bridgeKey = `__knowbookHostBridge${++this.invocationSequence}`
    const contextRecord = context as vm.Context & Record<string, unknown>
    Object.defineProperty(contextRecord, bridgeKey, {
      configurable: true,
      enumerable: false,
      value: hostCall,
      writable: false
    })

    try {
      return new vm.Script(`
        ((hostCall) => {
          const freeze = Object.freeze
          const safeString = String
          const parse = JSON.parse.bind(JSON)
          const stringify = JSON.stringify.bind(JSON)
          const api = {
            contributeDashboardCard(cardInput) {
              const descriptor = parse(hostCall('dashboard.contribute', stringify(cardInput)))
              return freeze({
                ...descriptor,
                update: freeze((patch) => hostCall('dashboard.update', descriptor.id, stringify(patch)))
              })
            },
            contributeDocumentAction(actionInput, handler) {
              return hostCall('documentAction.contribute', stringify(actionInput), handler)
            },
            contributeSetting(settingInput) {
              const descriptor = parse(hostCall('setting.contribute', stringify(settingInput)))
              return freeze({
                ...descriptor,
                getValue: freeze(() => parse(hostCall('setting.get', descriptor.id))),
                setValue: freeze((value) => hostCall('setting.set', descriptor.id, stringify(value)))
              })
            },
            onWorkspaceEvent(eventTypes, handler) {
              return hostCall('event.subscribe', stringify(eventTypes), handler)
            },
            workspace: freeze({
              getDocumentDetail: freeze((documentId) => parse(hostCall('workspace.getDocumentDetail', safeString(documentId))))
            }),
            documents: freeze({
              updateSummary: freeze((documentId, summary) => hostCall('documents.updateSummary', safeString(documentId), safeString(summary)))
            }),
            log: freeze((title, description, documentId) => hostCall('log', safeString(title), safeString(description), documentId == null ? null : safeString(documentId)))
          }
          api.contributeDashboardCard = freeze(api.contributeDashboardCard)
          api.contributeDocumentAction = freeze(api.contributeDocumentAction)
          api.contributeSetting = freeze(api.contributeSetting)
          api.onWorkspaceEvent = freeze(api.onWorkspaceEvent)
          return freeze(api)
        })(${bridgeKey})
      `).runInContext(context, {
        timeout: PLUGIN_SYNC_TIMEOUT_MS,
        displayErrors: true
      }) as PluginApi
    } finally {
      delete contextRecord[bridgeKey]
    }
  }

  private createHostPluginApi(plugin: RegisteredPlugin): PluginApi {
    return {
      contributeDashboardCard: (cardInput) => {
        const cardId = cardInput.id.trim()
        if (!cardId) {
          throw new Error('Dashboard card id is required.')
        }
        if (!plugin.dashboardCards.has(cardId) && plugin.dashboardCards.size >= PLUGIN_CONTRIBUTION_LIMIT) {
          throw new Error(`Plugin dashboard card limit exceeded (${PLUGIN_CONTRIBUTION_LIMIT}).`)
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
        if (!plugin.documentActions.has(actionId) && plugin.documentActions.size >= PLUGIN_CONTRIBUTION_LIMIT) {
          throw new Error(`Plugin document action limit exceeded (${PLUGIN_CONTRIBUTION_LIMIT}).`)
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
        if (!plugin.settings.has(settingId) && plugin.settings.size >= PLUGIN_CONTRIBUTION_LIMIT) {
          throw new Error(`Plugin setting limit exceeded (${PLUGIN_CONTRIBUTION_LIMIT}).`)
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
        if (plugin.eventHandlers.length >= PLUGIN_CONTRIBUTION_LIMIT) {
          throw new Error(`Plugin workspace event subscription limit exceeded (${PLUGIN_CONTRIBUTION_LIMIT}).`)
        }
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
          this.onWorkspaceMutation?.(documentId)
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

  private async invokePluginFunction<T>(
    plugin: RegisteredPlugin,
    callback: (...args: any[]) => T,
    args: unknown[],
    operation: string,
    options: PluginInvocationOptions = {}
  ): Promise<T> {
    if (!plugin.context) {
      throw new Error(`Plugin context is unavailable during ${operation}.`)
    }

    const context = plugin.context
    const invocationArgs = this.createPluginInvocationArguments(plugin, args, options.argumentMode ?? 'json')
    const invocationKey = `__knowbookInvocation${++this.invocationSequence}`
    const contextRecord = context as vm.Context & Record<string, unknown>
    const invocation = Object.create(null) as { callback: typeof callback; args: unknown[] }
    Object.defineProperties(invocation, {
      callback: { enumerable: true, value: callback, writable: false },
      args: { enumerable: true, value: invocationArgs, writable: false }
    })
    Object.freeze(invocation)
    Object.defineProperty(contextRecord, invocationKey, {
      configurable: true,
      enumerable: false,
      value: invocation,
      writable: false
    })

    try {
      const result = new vm.Script(`${invocationKey}.callback(...${invocationKey}.args)`).runInContext(context, {
        timeout: PLUGIN_SYNC_TIMEOUT_MS,
        displayErrors: true
      }) as T
      if (this.isPluginPromiseLike(plugin, result)) {
        const error = new Error(
          `Plugin ${operation} returned a Promise. Asynchronous plugin callbacks are not supported; schedule deferred side effects with setTimeout instead.`
        )
        this.handlePluginError(plugin, operation, error)
        throw error
      }
      return options.resultMode === 'json'
        ? this.clonePluginResultToHost(plugin, result, operation)
        : result
    } finally {
      delete contextRecord[invocationKey]
    }
  }

  private isPluginPromiseLike(plugin: RegisteredPlugin, result: unknown): boolean {
    const context = plugin.context
    if (!context) {
      return false
    }

    const contextRecord = context as vm.Context & Record<string, unknown>
    const resultKey = `__knowbookPromiseProbe${++this.invocationSequence}`
    Object.defineProperty(contextRecord, resultKey, {
      configurable: true,
      enumerable: false,
      value: result,
      writable: false
    })

    try {
      return new vm.Script(`
        (() => {
          const value = ${resultKey}
          return value !== null
            && (typeof value === 'object' || typeof value === 'function')
            && typeof value.then === 'function'
        })()
      `).runInContext(context, {
        timeout: PLUGIN_SYNC_TIMEOUT_MS,
        displayErrors: true
      }) as boolean
    } finally {
      delete contextRecord[resultKey]
    }
  }

  private createPluginInvocationArguments(
    plugin: RegisteredPlugin,
    args: unknown[],
    mode: 'json' | 'direct'
  ): unknown[] {
    const context = plugin.context
    if (!context) {
      throw new Error('Plugin context is unavailable while preparing invocation arguments.')
    }

    const contextRecord = context as vm.Context & Record<string, unknown>
    const argumentKey = `__knowbookArguments${++this.invocationSequence}`
    const value = mode === 'json' ? JSON.stringify(args) : args
    if (mode === 'json' && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > PLUGIN_RESULT_MAX_BYTES)) {
      throw new Error('Plugin invocation arguments are too large.')
    }

    Object.defineProperty(contextRecord, argumentKey, {
      configurable: true,
      enumerable: false,
      value,
      writable: false
    })

    try {
      const expression = mode === 'json'
        ? `JSON.parse(${argumentKey})`
        : `[...${argumentKey}]`
      return new vm.Script(expression).runInContext(context, {
        timeout: PLUGIN_SYNC_TIMEOUT_MS,
        displayErrors: true
      }) as unknown[]
    } finally {
      delete contextRecord[argumentKey]
    }
  }

  private clonePluginResultToHost<T>(plugin: RegisteredPlugin, result: T, operation: string): T {
    if (result === undefined) {
      return result
    }

    const context = plugin.context
    if (!context) {
      throw new Error(`Plugin context is unavailable after ${operation}.`)
    }

    const contextRecord = context as vm.Context & Record<string, unknown>
    const resultKey = `__knowbookResult${++this.invocationSequence}`
    Object.defineProperty(contextRecord, resultKey, {
      configurable: true,
      enumerable: false,
      value: result,
      writable: false
    })

    try {
      const serialized = new vm.Script(`JSON.stringify(${resultKey})`).runInContext(context, {
        timeout: PLUGIN_SYNC_TIMEOUT_MS,
        displayErrors: true
      })
      if (typeof serialized !== 'string') {
        throw new Error(`Plugin ${operation} returned an unsupported value.`)
      }
      if (Buffer.byteLength(serialized, 'utf8') > PLUGIN_RESULT_MAX_BYTES) {
        throw new Error(`Plugin ${operation} returned too much data.`)
      }
      return JSON.parse(serialized) as T
    } finally {
      delete contextRecord[resultKey]
    }
  }

  private handlePluginError(plugin: RegisteredPlugin, phase: string, error: unknown): void {
    const errorMessage = this.getPluginErrorMessage(plugin, error, `Unknown error during ${phase}.`)
    plugin.status = 'error'
    plugin.error = errorMessage
    this.releasePluginRuntime(plugin)
    plugin.dashboardCards.clear()
    plugin.documentActions.clear()
    plugin.settings.clear()
    plugin.eventHandlers = []
    console.error(`Plugin ${plugin.manifest.id} failed during ${phase}.`, errorMessage)
  }

  private async activateIsolatedPlugin(
    plugin: RegisteredPlugin,
    recordLoadEvent: boolean,
    activationSnapshot?: PluginActivationSnapshot
  ): Promise<void> {
    const runtimeFactory = this.options.runtimeFactory
    if (!runtimeFactory) {
      throw new Error('Isolated plugin runtime factory is unavailable.')
    }

    plugin.dashboardCards.clear()
    plugin.documentActions.clear()
    plugin.settings.clear()
    plugin.eventHandlers = []
    plugin.isolatedStateFingerprint = undefined

    let snapshot: PluginActivationSnapshot
    try {
      snapshot = activationSnapshot ?? this.createPluginActivationSnapshot()
    } catch (error) {
      plugin.status = 'error'
      plugin.error = this.getPluginErrorMessage(
        plugin,
        error,
        'Failed to prepare the isolated plugin workspace snapshot.'
      )
      this.options.onStateChanged?.()
      return
    }

    let runtime: IsolatedPluginRuntime
    try {
      runtime = runtimeFactory(plugin.manifest.id)
    } catch (error) {
      plugin.status = 'error'
      plugin.error = this.getPluginErrorMessage(plugin, error, 'Failed to create isolated plugin runtime.')
      this.options.onStateChanged?.()
      return
    }

    plugin.isolatedRuntime = runtime
    runtime.onStateChanged((output) => {
      if (plugin.isolatedRuntime !== runtime) {
        return
      }
      try {
        this.applyIsolatedOutput(plugin, output)
      } catch (error) {
        this.failIsolatedPlugin(plugin, runtime, 'runtime state synchronization', error)
      }
    })
    runtime.onFailure((error) => {
      this.failIsolatedPlugin(plugin, runtime, 'utility process', error)
    })

    try {
      const output = await runtime.initialize({
        pluginId: plugin.manifest.id,
        directory: plugin.directory,
        source: plugin.source,
        currentVersion: this.currentVersion,
        settings: this.getPluginActivationSettings(plugin.manifest.id, snapshot.settings),
        documents: snapshot.documents,
        recordLoadEvent
      })
      if (plugin.isolatedRuntime !== runtime) {
        return
      }
      this.applyIsolatedOutput(plugin, output)
      if (plugin.status !== 'running') {
        plugin.isolatedRuntime = undefined
        await runtime.dispose().catch(() => undefined)
      }
    } catch (error) {
      this.failIsolatedPlugin(plugin, runtime, 'activation', error)
    }
  }

  private getPluginActivationSettings(
    pluginId: string,
    settings: Record<string, string>
  ): Record<string, string> {
    const settingPrefix = `plugin.setting.${pluginId}.`
    return Object.fromEntries(
      Object.entries(settings).filter(([key]) => key.startsWith(settingPrefix))
    )
  }

  private applyIsolatedOutput(plugin: RegisteredPlugin, output: PluginRuntimeOutput): void {
    this.applyIsolatedEffects(plugin, output.effects)
    this.applyIsolatedState(plugin, output.state)
    if (plugin.status === 'error' && plugin.isolatedRuntime) {
      const runtime = plugin.isolatedRuntime
      plugin.isolatedRuntime = undefined
      void runtime.dispose().catch(() => undefined)
    }
  }

  private applyIsolatedEffects(plugin: RegisteredPlugin, effects: PluginRuntimeEffect[]): void {
    if (!Array.isArray(effects) || effects.length > PLUGIN_RUNTIME_EFFECT_LIMIT) {
      throw new Error(`Plugin runtime effect limit exceeded (${PLUGIN_RUNTIME_EFFECT_LIMIT}).`)
    }

    for (const effect of effects) {
      if (effect.type === 'setting.saved') {
        if (!effect.key.startsWith(`plugin.setting.${plugin.manifest.id}.`)) {
          throw new Error('Plugin runtime attempted to write an unauthorized setting key.')
        }
        this.requireIsolatedRuntimeText(effect.value, 'setting value')
        this.store.saveSetting(effect.key, effect.value)
        continue
      }
      if (effect.type === 'document.summary.updated') {
        this.requireIsolatedRuntimeText(effect.documentId, 'document id', 1_000)
        this.requireIsolatedRuntimeText(effect.summary, 'document summary')
        this.store.updateDocumentSummary(effect.documentId, effect.summary)
        this.onWorkspaceMutation?.(effect.documentId)
        continue
      }
      if (
        effect.type !== 'workspace-event.recorded'
        || !['plugin.loaded', 'plugin.action.executed', 'plugin.action.failed'].includes(effect.event.type)
      ) {
        throw new Error('Plugin runtime attempted to record an unauthorized workspace event.')
      }
      this.requireIsolatedRuntimeText(effect.event.title, 'workspace event title', 10_000)
      this.requireIsolatedRuntimeText(effect.event.description, 'workspace event description')
      if (effect.event.documentId) {
        this.requireIsolatedRuntimeText(effect.event.documentId, 'workspace event document id', 1_000)
      }
      if (effect.event.createdAt) {
        this.requireIsolatedRuntimeText(effect.event.createdAt, 'workspace event timestamp', 100)
      }
      this.store.recordWorkspaceEvent(effect.event)
    }
  }

  private applyIsolatedState(plugin: RegisteredPlugin, state: PluginRuntimeState): void {
    if (!['running', 'disabled', 'error'].includes(state.status)) {
      throw new Error('Plugin runtime returned an invalid status.')
    }
    if (
      !Array.isArray(state.dashboardCards)
      || !Array.isArray(state.documentActions)
      || !Array.isArray(state.settings)
      || state.dashboardCards.length > PLUGIN_CONTRIBUTION_LIMIT
      || state.documentActions.length > PLUGIN_CONTRIBUTION_LIMIT
      || state.settings.length > PLUGIN_CONTRIBUTION_LIMIT
    ) {
      throw new Error(`Plugin runtime contribution limit exceeded (${PLUGIN_CONTRIBUTION_LIMIT}).`)
    }
    const nextFingerprint = JSON.stringify(state)
    const stateChanged = plugin.isolatedStateFingerprint !== nextFingerprint
    plugin.isolatedStateFingerprint = nextFingerprint

    plugin.status = state.status
    plugin.error = state.error
      ? this.requireIsolatedRuntimeText(state.error, 'plugin error', 10_000)
      : undefined

    plugin.dashboardCards.clear()
    for (const descriptor of state.dashboardCards) {
      this.requireMatchingIsolatedPluginId(plugin, descriptor.pluginId)
      this.requireIsolatedRuntimeText(descriptor.id, 'dashboard card id', 1_000)
      this.requireIsolatedRuntimeText(descriptor.title, 'dashboard card title', 10_000)
      this.requireIsolatedRuntimeText(descriptor.body, 'dashboard card body')
      const card: RegisteredDashboardCard = {
        ...descriptor,
        update: () => undefined
      }
      plugin.dashboardCards.set(card.id, card)
    }

    plugin.documentActions.clear()
    for (const descriptor of state.documentActions) {
      this.requireMatchingIsolatedPluginId(plugin, descriptor.pluginId)
      this.requireIsolatedRuntimeText(descriptor.id, 'document action id', 1_000)
      this.requireIsolatedRuntimeText(descriptor.label, 'document action label', 10_000)
      if (descriptor.description) {
        this.requireIsolatedRuntimeText(descriptor.description, 'document action description', 100_000)
      }
      plugin.documentActions.set(descriptor.id, {
        action: { ...descriptor },
        handler: () => {
          throw new Error('Isolated plugin actions must be invoked through the runtime bridge.')
        }
      })
    }

    plugin.settings.clear()
    for (const descriptor of state.settings) {
      this.requireMatchingIsolatedPluginId(plugin, descriptor.pluginId)
      this.requireIsolatedRuntimeText(descriptor.id, 'setting id', 1_000)
      this.requireIsolatedRuntimeText(descriptor.label, 'setting label', 10_000)
      if (descriptor.description) {
        this.requireIsolatedRuntimeText(descriptor.description, 'setting description', 100_000)
      }
      if (!['text', 'checkbox', 'select'].includes(descriptor.type)) {
        throw new Error('Plugin runtime returned an invalid setting type.')
      }
      if (
        descriptor.options
        && (!Array.isArray(descriptor.options) || descriptor.options.length > PLUGIN_CONTRIBUTION_LIMIT)
      ) {
        throw new Error(`Plugin setting option limit exceeded (${PLUGIN_CONTRIBUTION_LIMIT}).`)
      }
      if (descriptor.type === 'select' && (!descriptor.options || descriptor.options.length === 0)) {
        throw new Error('Plugin select setting requires options.')
      }
      this.requireIsolatedSettingValue(descriptor.type, descriptor.value, 'setting value')
      this.requireIsolatedSettingValue(descriptor.type, descriptor.defaultValue, 'setting default value')
      for (const option of descriptor.options ?? []) {
        this.requireIsolatedRuntimeText(option.value, 'setting option value', 10_000)
        this.requireIsolatedRuntimeText(option.label, 'setting option label', 10_000)
      }
      const setting: RegisteredPluginSetting = {
        ...descriptor,
        options: descriptor.options ? descriptor.options.map((option) => ({ ...option })) : undefined,
        getValue: () => setting.value,
        setValue: (value) => {
          setting.value = value
        }
      }
      plugin.settings.set(setting.id, setting)
    }

    if (state.status !== 'running') {
      plugin.dashboardCards.clear()
      plugin.documentActions.clear()
      plugin.eventHandlers = []
    }
    if (stateChanged) {
      this.options.onStateChanged?.()
    }
  }

  private requireMatchingIsolatedPluginId(plugin: RegisteredPlugin, pluginId: string): void {
    if (pluginId !== plugin.manifest.id) {
      throw new Error('Plugin runtime returned a contribution for another plugin.')
    }
  }

  private requireIsolatedRuntimeText(value: string, label: string, maxBytes = PLUGIN_RUNTIME_TEXT_MAX_BYTES): string {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
      throw new Error(`Plugin runtime ${label} is invalid or too large.`)
    }
    return value
  }

  private requireIsolatedSettingValue(
    type: PluginSettingType,
    value: PluginSettingValue,
    label: string
  ): void {
    if (type === 'checkbox') {
      if (typeof value !== 'boolean') {
        throw new Error(`Plugin runtime ${label} must be a boolean.`)
      }
      return
    }
    this.requireIsolatedRuntimeText(value as string, label)
  }

  private getWorkspaceEventDocuments(event: WorkspaceEvent): DocumentDetail[] {
    const documentIds = new Set<string>()
    if (event.type !== 'ai.config.updated' && event.type !== 'document.deleted') {
      documentIds.add(event.documentId)
    }
    if ('affectedDocumentIds' in event) {
      for (const documentId of event.affectedDocumentIds) {
        documentIds.add(documentId)
      }
    }

    return [...documentIds]
      .map((documentId) => this.store.getDocumentDetail(documentId))
      .filter((document): document is DocumentDetail => document !== null)
  }

  private failIsolatedPlugin(
    plugin: RegisteredPlugin,
    runtime: IsolatedPluginRuntime,
    phase: string,
    error: unknown
  ): void {
    if (plugin.isolatedRuntime !== runtime) {
      return
    }

    const errorMessage = this.getPluginErrorMessage(plugin, error, `Unknown error during ${phase}.`)
    plugin.isolatedRuntime = undefined
    plugin.status = 'error'
    plugin.error = errorMessage
    plugin.dashboardCards.clear()
    plugin.documentActions.clear()
    plugin.settings.clear()
    plugin.eventHandlers = []
    void runtime.dispose().catch(() => undefined)
    this.options.onStateChanged?.()
    console.error(`Plugin ${plugin.manifest.id} failed during isolated ${phase}.`, errorMessage)
  }

  private getPluginErrorMessage(plugin: RegisteredPlugin, error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) {
      return error.message
    }
    if (typeof error === 'string' && error.trim()) {
      return error.trim()
    }

    const context = plugin.context
    if (context) {
      const errorKey = `__knowbookError${++this.invocationSequence}`
      const contextRecord = context as vm.Context & Record<string, unknown>
      Object.defineProperty(contextRecord, errorKey, {
        configurable: true,
        enumerable: false,
        value: error,
        writable: false
      })
      try {
        const message = new vm.Script(`
          (() => {
            try {
              const value = ${errorKey}
              return value && typeof value.message === 'string' ? value.message : ''
            } catch {
              return ''
            }
          })()
        `).runInContext(context, {
          timeout: PLUGIN_SYNC_TIMEOUT_MS,
          displayErrors: false
        })
        if (typeof message === 'string' && message.trim()) {
          return message.trim().slice(0, 4_000)
        }
      } catch {
        // The fallback below is intentionally host-owned and does not inspect the plugin value.
      } finally {
        delete contextRecord[errorKey]
      }
    }
    return fallback
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
