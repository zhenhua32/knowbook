import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { RunPluginUiActionInput, PluginUiSlot } from '@shared/plugin-ui'
import { PLUGIN_UI_SLOT_CATALOG } from '@shared/plugin-ui'

export type FullTrustRendererDisposable = () => void | Promise<void>

export interface FullTrustRendererPluginIdentity {
  id: string
  version: string
  revisionHash: string
}

export type FullTrustPluginSlotContext = NonNullable<RunPluginUiActionInput['context']>

export interface FullTrustPluginSlotProps {
  plugin: Readonly<FullTrustRendererPluginIdentity>
  slot: PluginUiSlot
  context?: FullTrustPluginSlotContext
}

export interface FullTrustReactSlotContributionInput {
  id: string
  slot: PluginUiSlot
  order?: number
  component: ComponentType<FullTrustPluginSlotProps>
}

export interface FullTrustReactSlotContribution extends Required<Omit<FullTrustReactSlotContributionInput, 'component'>> {
  plugin: Readonly<FullTrustRendererPluginIdentity>
  component: ComponentType<FullTrustPluginSlotProps>
}

export interface FullTrustStyleOptions {
  id?: string
  media?: string
  target?: HTMLElement | ShadowRoot
}

export interface FullTrustFrameOptions {
  src: string
  allowedOrigins?: string[]
  allowPopups?: boolean
  allowNavigation?: boolean
  allowDownloads?: boolean
  allowPermissions?: boolean
  container?: Element
  className?: string
  title?: string
  allow?: string
}

export interface FullTrustFrameHandle {
  frame: HTMLIFrameElement
  frameName: string
  popupName: string
  dispose: FullTrustRendererDisposable
}

export interface FullTrustPopupOptions {
  url: string
  allowedOrigins?: string[]
  features?: string
}

export interface FullTrustPopupHandle {
  window: Window | null
  popupName: string
  dispose: FullTrustRendererDisposable
}

export interface FullTrustKeyboardShortcut {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  allowInEditable?: boolean
  preventDefault?: boolean
  stopPropagation?: boolean
}

export interface FullTrustCommandExecutionContext<TArguments = unknown> {
  plugin: Readonly<FullTrustRendererPluginIdentity>
  commandId: string
  arguments: TArguments
  source: 'api' | 'keyboard'
  keyboardEvent?: KeyboardEvent
}

export interface FullTrustCommandInput<TArguments = unknown, TResult = unknown> {
  id: string
  title: string
  description?: string
  order?: number
  shortcut?: FullTrustKeyboardShortcut
  execute(context: FullTrustCommandExecutionContext<TArguments>): TResult | Promise<TResult>
}

export interface FullTrustCommandRegistration {
  id: string
  title: string
  description?: string
  order: number
  shortcut?: Readonly<FullTrustKeyboardShortcut>
  plugin: Readonly<FullTrustRendererPluginIdentity>
}

export interface FullTrustPageProps {
  plugin: Readonly<FullTrustRendererPluginIdentity>
  pageId: string
  route: string
  params?: Readonly<Record<string, string>>
  context?: unknown
}

export interface FullTrustPageInput {
  id: string
  route: string
  title: string
  order?: number
  component: ComponentType<FullTrustPageProps>
}

export interface FullTrustPageRegistration extends Required<Omit<FullTrustPageInput, 'component'>> {
  plugin: Readonly<FullTrustRendererPluginIdentity>
  component: ComponentType<FullTrustPageProps>
}

export interface FullTrustThemeSnapshot {
  theme: string | null
  root: HTMLElement
}

export interface FullTrustThemeSubscriptionOptions {
  emitCurrent?: boolean
  root?: HTMLElement
}

export interface FullTrustRendererPluginApi {
  readonly plugin: Readonly<FullTrustRendererPluginIdentity>
  readonly React: typeof React
  readonly ReactDOM: typeof ReactDOM
  readonly ReactDOMClient: typeof ReactDOMClient
  registerSlotContribution(input: FullTrustReactSlotContributionInput): FullTrustRendererDisposable
  createRoot(container: Element | DocumentFragment, options?: ReactDOMClient.RootOptions): ReactDOMClient.Root
  createPortal(children: ReactNode, container: Element | DocumentFragment, key?: string | null): React.ReactPortal
  injectCss(cssText: string, options?: FullTrustStyleOptions): FullTrustRendererDisposable
  createUnsandboxedFrame(options: FullTrustFrameOptions): Promise<FullTrustFrameHandle>
  openPrivilegedPopup(options: FullTrustPopupOptions): Promise<FullTrustPopupHandle>
  registerCommand<TArguments = unknown, TResult = unknown>(
    input: FullTrustCommandInput<TArguments, TResult>
  ): FullTrustRendererDisposable
  executeCommand<TResult = unknown>(commandId: string, argumentsValue?: unknown): Promise<TResult>
  listCommands(): readonly FullTrustCommandRegistration[]
  registerPage(input: FullTrustPageInput): FullTrustRendererDisposable
  listPages(): readonly FullTrustPageRegistration[]
  addDomEventListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): FullTrustRendererDisposable
  subscribeToTheme(
    listener: (snapshot: FullTrustThemeSnapshot) => void,
    options?: FullTrustThemeSubscriptionOptions
  ): FullTrustRendererDisposable
  registerDisposable(disposable: FullTrustRendererDisposable, label?: string): FullTrustRendererDisposable
}

export type FullTrustRendererPluginInitializer = (
  api: FullTrustRendererPluginApi
) => void | FullTrustRendererDisposable | Promise<void | FullTrustRendererDisposable>

type TrackedDisposable = {
  label: string
  disposed: boolean
  committed: boolean
  commit?: () => void
  dispose: FullTrustRendererDisposable
}

type PluginRecordState = 'staging' | 'committing' | 'committed' | 'inactive'

type ActivePluginRecord = {
  identity: Readonly<FullTrustRendererPluginIdentity>
  state: PluginRecordState
  disposables: TrackedDisposable[]
  contributions: Map<string, FullTrustReactSlotContribution>
  commands: Map<string, RegisteredCommand>
  shortcutOwners: Map<string, RegisteredCommand>
  pages: Map<string, FullTrustPageRegistration>
  pageRoutes: Map<string, FullTrustPageRegistration>
}

type RegisteredCommand = {
  publicValue: FullTrustCommandRegistration
  execute: FullTrustCommandInput['execute']
  owner: ActivePluginRecord
  shortcutKey?: string
  keyboardTarget?: Document
  keyboardListener?: (event: KeyboardEvent) => void
}

const EMPTY_CONTRIBUTIONS: readonly FullTrustReactSlotContribution[] = Object.freeze([])
const EMPTY_COMMANDS: readonly FullTrustCommandRegistration[] = Object.freeze([])
const EMPTY_PAGES: readonly FullTrustPageRegistration[] = Object.freeze([])

/**
 * Registry exposed to confirmed Full Trust renderer entries.
 *
 * This is a lifecycle and cleanup facility, not a security boundary. Full Trust
 * code can deliberately bypass it and use React, DOM, and CSS APIs directly.
 */
export class FullTrustPluginRegistry {
  readonly React = React
  readonly ReactDOM = ReactDOM
  readonly ReactDOMClient = ReactDOMClient

  private readonly activePlugins = new Map<string, ActivePluginRecord>()
  private readonly stagedPlugins = new Map<string, ActivePluginRecord>()
  private readonly contributions = new Map<string, FullTrustReactSlotContribution>()
  private readonly slotSnapshots = new Map<PluginUiSlot, readonly FullTrustReactSlotContribution[]>()
  private readonly slotListeners = new Map<PluginUiSlot, Set<() => void>>()
  private readonly commands = new Map<string, RegisteredCommand>()
  private readonly shortcutOwners = new Map<string, RegisteredCommand>()
  private readonly commandListeners = new Set<() => void>()
  private commandSnapshot: readonly FullTrustCommandRegistration[] = EMPTY_COMMANDS
  private readonly pages = new Map<string, FullTrustPageRegistration>()
  private readonly pageRoutes = new Map<string, string>()
  private readonly pageListeners = new Set<() => void>()
  private pageSnapshot: readonly FullTrustPageRegistration[] = EMPTY_PAGES
  private activatingPlugin: ActivePluginRecord | null = null
  private publishBatchDepth = 0
  private readonly pendingSlotPublishes = new Set<PluginUiSlot>()
  private pendingCommandPublish = false
  private pendingPagePublish = false

  get currentPlugin(): Readonly<FullTrustRendererPluginIdentity> | null {
    return this.activatingPlugin?.identity ?? null
  }

  async activatePlugin(
    identityInput: FullTrustRendererPluginIdentity,
    initializer: FullTrustRendererPluginInitializer
  ): Promise<FullTrustRendererPluginApi> {
    if (this.activatingPlugin) {
      throw new Error(
        `Full Trust renderer plugin "${this.activatingPlugin.identity.id}" is already activating.`
      )
    }
    const identity = normalizeIdentity(identityInput)
    if (this.stagedPlugins.size > 0) {
      const [staged] = this.stagedPlugins.values()
      throw new Error(
        `Full Trust renderer plugin "${staged.identity.id}" is awaiting commit or deactivation.`
      )
    }
    const record: ActivePluginRecord = {
      identity,
      state: 'staging',
      disposables: [],
      contributions: new Map(),
      commands: new Map(),
      shortcutOwners: new Map(),
      pages: new Map(),
      pageRoutes: new Map()
    }
    this.stagedPlugins.set(identity.id, record)
    this.activatingPlugin = record
    const api = this.createPluginApi(record)
    try {
      const disposable = await initializer(api)
      if (!this.isLiveRecord(record)) {
        const inactiveError = this.createInactiveRecordError(record)
        if (typeof disposable === 'function') {
          try {
            await disposable()
          } catch (cleanupError) {
            throw new AggregateError(
              [inactiveError, normalizeError(cleanupError)],
              `Full Trust renderer plugin "${identity.id}" returned a disposer after cancellation, but cleanup failed.`
            )
          }
        }
        throw inactiveError
      }
      if (typeof disposable === 'function') {
        this.trackDisposable(record, disposable, 'activation result')
      }
      return api
    } catch (error) {
      try {
        await this.cleanupRecord(record)
      } catch (cleanupError) {
        console.warn(
          `Full Trust renderer plugin ${identity.id} cleanup failed after activation error.`,
          cleanupError
        )
      }
      throw error
    } finally {
      if (this.activatingPlugin === record) this.activatingPlugin = null
    }
  }

  async commitPlugin(pluginId: string, revisionHash: string): Promise<void> {
    const record = this.stagedPlugins.get(pluginId)
    if (!record || record.identity.revisionHash !== revisionHash) {
      throw new Error(
        `Full Trust renderer plugin "${pluginId}" has no staged revision matching "${revisionHash}".`
      )
    }
    if (this.activatingPlugin === record) {
      throw new Error(`Full Trust renderer plugin "${pluginId}" cannot commit while activating.`)
    }
    this.validateCommit(record)

    const previous = this.activePlugins.get(pluginId) ?? null
    const contributionsSnapshot = new Map(this.contributions)
    const commandsSnapshot = new Map(this.commands)
    const shortcutOwnersSnapshot = new Map(this.shortcutOwners)
    const pagesSnapshot = new Map(this.pages)
    const pageRoutesSnapshot = new Map(this.pageRoutes)
    const affectedSlots = new Set<PluginUiSlot>([
      ...[...this.contributions.values()].map(({ slot }) => slot),
      ...[...record.contributions.values()].map(({ slot }) => slot)
    ])

    const cleanupOperations: Promise<void>[] = []
    let commitError: Error | null = null
    this.beginPublishBatch()
    try {
      try {
        record.state = 'committing'
        for (const tracked of record.disposables) this.commitTracked(tracked)
        this.stagedPlugins.delete(pluginId)
        this.activePlugins.set(pluginId, record)
        record.state = 'committed'
      } catch (error) {
        commitError = normalizeError(error)
        cleanupOperations.push(this.cleanupRecord(record))
        replaceMap(this.contributions, contributionsSnapshot)
        replaceMap(this.commands, commandsSnapshot)
        replaceMap(this.shortcutOwners, shortcutOwnersSnapshot)
        replaceMap(this.pages, pagesSnapshot)
        replaceMap(this.pageRoutes, pageRoutesSnapshot)
        for (const slot of affectedSlots) this.publishSlot(slot)
        this.publishCommands()
        this.publishPages()
      }
      if (!commitError && previous && previous !== record) {
        cleanupOperations.push(this.cleanupRecord(previous).catch((error) => {
          console.warn(
            `Full Trust renderer plugin ${pluginId} previous revision cleanup failed after commit.`,
            error
          )
        }))
      }
    } finally {
      this.endPublishBatch()
    }
    const cleanupResults = await Promise.allSettled(cleanupOperations)
    if (commitError) {
      const failures = [commitError, ...cleanupResults.flatMap((result) => (
        result.status === 'rejected' ? [normalizeError(result.reason)] : []
      ))]
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, `Full Trust renderer plugin "${pluginId}" commit failed.`)
    }
  }

  async deactivatePlugin(pluginId: string): Promise<void> {
    const records = [
      this.stagedPlugins.get(pluginId),
      this.activePlugins.get(pluginId)
    ].filter((record): record is ActivePluginRecord => Boolean(record))
    if (records.length === 0) return
    const cleanupOperations: Promise<void>[] = []
    this.beginPublishBatch()
    try {
      for (const record of records) {
        if (this.activatingPlugin === record) this.activatingPlugin = null
        cleanupOperations.push(this.cleanupRecord(record))
      }
    } finally {
      this.endPublishBatch()
    }
    const results = await Promise.allSettled(cleanupOperations)
    const failures = results.flatMap((result) => (
      result.status === 'rejected' ? [normalizeError(result.reason)] : []
    ))
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Full Trust renderer plugin "${pluginId}" cleanup failed.`
      )
    }
  }

  async deactivateAll(): Promise<void> {
    const cleanupOperations: Promise<void>[] = []
    const records = [
      ...this.stagedPlugins.values(),
      ...this.activePlugins.values()
    ].reverse()
    this.activatingPlugin = null
    this.beginPublishBatch()
    try {
      for (const record of records) {
        cleanupOperations.push(this.cleanupRecord(record))
      }
    } finally {
      this.endPublishBatch()
    }
    const results = await Promise.allSettled(cleanupOperations)
    const failures = results.flatMap((result) => (
      result.status === 'rejected' ? [normalizeError(result.reason)] : []
    ))
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more Full Trust renderer plugins failed to deactivate.')
    }
  }

  getSlotContributions(slot: PluginUiSlot): readonly FullTrustReactSlotContribution[] {
    return this.slotSnapshots.get(slot) ?? EMPTY_CONTRIBUTIONS
  }

  subscribeToSlot(slot: PluginUiSlot, listener: () => void): () => void {
    let listeners = this.slotListeners.get(slot)
    if (!listeners) {
      listeners = new Set()
      this.slotListeners.set(slot, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners?.delete(listener)
      if (listeners?.size === 0) this.slotListeners.delete(slot)
    }
  }

  listCommands(): readonly FullTrustCommandRegistration[] {
    return this.commandSnapshot
  }

  subscribeToCommands(listener: () => void): FullTrustRendererDisposable {
    this.commandListeners.add(listener)
    return () => {
      this.commandListeners.delete(listener)
    }
  }

  async executeCommand<TResult = unknown>(
    commandId: string,
    argumentsValue?: unknown
  ): Promise<TResult> {
    return this.executeRegisteredCommand<TResult>(commandId, argumentsValue, 'api')
  }

  listPages(): readonly FullTrustPageRegistration[] {
    return this.pageSnapshot
  }

  subscribeToPages(listener: () => void): FullTrustRendererDisposable {
    this.pageListeners.add(listener)
    return () => {
      this.pageListeners.delete(listener)
    }
  }

  private createPluginApi(record: ActivePluginRecord): FullTrustRendererPluginApi {
    return Object.freeze({
      plugin: record.identity,
      React,
      ReactDOM,
      ReactDOMClient,
      registerSlotContribution: (input: FullTrustReactSlotContributionInput) =>
        this.registerSlotContribution(record, input),
      createRoot: (container: Element | DocumentFragment, options?: ReactDOMClient.RootOptions) =>
        this.createRoot(record, container, options),
      createPortal: (children: ReactNode, container: Element | DocumentFragment, key?: string | null) => {
        this.assertActiveRecord(record)
        return ReactDOM.createPortal(children, container, key)
      },
      injectCss: (cssText: string, options?: FullTrustStyleOptions) =>
        this.injectCss(record, cssText, options),
      createUnsandboxedFrame: (options: FullTrustFrameOptions) =>
        this.createUnsandboxedFrame(record, options),
      openPrivilegedPopup: (options: FullTrustPopupOptions) =>
        this.openPrivilegedPopup(record, options),
      registerCommand: <TArguments = unknown, TResult = unknown>(
        input: FullTrustCommandInput<TArguments, TResult>
      ) => this.registerCommand(record, input),
      executeCommand: <TResult = unknown>(commandId: string, argumentsValue?: unknown) =>
        this.executePluginCommand<TResult>(record, commandId, argumentsValue),
      listCommands: () => this.listCommands(),
      registerPage: (input: FullTrustPageInput) => this.registerPage(record, input),
      listPages: () => this.listPages(),
      addDomEventListener: (
        target: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) => this.addDomEventListener(record, target, type, listener, options),
      subscribeToTheme: (
        listener: (snapshot: FullTrustThemeSnapshot) => void,
        options?: FullTrustThemeSubscriptionOptions
      ) => this.subscribeToTheme(record, listener, options),
      registerDisposable: (disposable: FullTrustRendererDisposable, label?: string) =>
        this.trackDisposable(record, disposable, label ?? 'plugin disposable')
    })
  }

  private createRoot(
    record: ActivePluginRecord,
    container: Element | DocumentFragment,
    options?: ReactDOMClient.RootOptions
  ): ReactDOMClient.Root {
    this.assertActiveRecord(record)
    let committedRoot: ReactDOMClient.Root | null = null
    let pendingChildren: ReactNode = null
    let hasPendingRender = false
    let unmounted = false
    const facade = {
      render: (children: ReactNode) => {
        this.assertActiveRecord(record)
        if (unmounted) throw new Error('Cannot update an unmounted Full Trust renderer root.')
        if (committedRoot) committedRoot.render(children)
        else {
          pendingChildren = children
          hasPendingRender = true
        }
      },
      unmount: () => {
        if (unmounted) return
        unmounted = true
        hasPendingRender = false
        committedRoot?.unmount()
        committedRoot = null
      }
    } as ReactDOMClient.Root
    this.trackDisposable(
      record,
      () => facade.unmount(),
      'React root',
      () => {
        if (unmounted) return
        committedRoot = ReactDOMClient.createRoot(container, options)
        if (hasPendingRender) committedRoot.render(pendingChildren)
      }
    )
    return facade
  }

  private registerCommand<TArguments, TResult>(
    record: ActivePluginRecord,
    input: FullTrustCommandInput<TArguments, TResult>
  ): FullTrustRendererDisposable {
    this.assertActiveRecord(record)
    const id = normalizeRegistryId(input.id, 'command')
    const title = normalizeLabel(input.title, 'command title')
    if (typeof input.execute !== 'function') {
      throw new Error(`Full Trust renderer command "${id}" execute must be a function.`)
    }
    if (record.commands.has(id)) {
      throw new Error(`Full Trust renderer command "${id}" is already registered.`)
    }
    const committedCommand = this.commands.get(id)
    if (committedCommand && committedCommand.owner.identity.id !== record.identity.id) {
      throw new Error(`Full Trust renderer command "${id}" is already registered.`)
    }
    const order = normalizeOrder(input.order, 'command')
    const shortcut = input.shortcut ? normalizeShortcut(input.shortcut) : undefined
    const shortcutKey = shortcut ? serializeShortcut(shortcut) : undefined
    if (shortcutKey && shortcut) {
      const stagedOwner = record.shortcutOwners.get(shortcutKey)
      const committedOwner = this.shortcutOwners.get(shortcutKey)
      const owner = stagedOwner
        ?? (committedOwner?.owner.identity.id === record.identity.id ? undefined : committedOwner)
      if (owner) {
        throw new Error(
          `Full Trust renderer shortcut "${describeShortcut(shortcut)}" is already registered by "${owner.publicValue.id}".`
        )
      }
    }
    const publicValue: FullTrustCommandRegistration = Object.freeze({
      id,
      title,
      ...(input.description === undefined
        ? {}
        : { description: normalizeLabel(input.description, 'command description') }),
      order,
      ...(shortcut ? { shortcut } : {}),
      plugin: record.identity
    })
    const registered: RegisteredCommand = {
      publicValue,
      execute: input.execute as FullTrustCommandInput['execute'],
      owner: record,
      ...(shortcutKey ? { shortcutKey } : {})
    }
    record.commands.set(id, registered)
    if (shortcutKey) record.shortcutOwners.set(shortcutKey, registered)

    if (shortcut) {
      if (typeof document === 'undefined') {
        record.commands.delete(id)
        if (shortcutKey) record.shortcutOwners.delete(shortcutKey)
        throw new Error(`Full Trust renderer command "${id}" shortcut requires a document.`)
      }
      registered.keyboardTarget = document
      registered.keyboardListener = (event) => {
        if (!matchesShortcut(event, shortcut)) return
        if (!shortcut.allowInEditable && isEditableEventTarget(event.target)) return
        if (shortcut.preventDefault) event.preventDefault()
        if (shortcut.stopPropagation) event.stopPropagation()
        void this.executeRegisteredCommand(id, undefined, 'keyboard', event).catch((error) => {
          console.error(`Full Trust renderer command "${id}" failed from keyboard.`, error)
        })
      }
    }
    return this.trackDisposable(
      record,
      () => {
        if (registered.keyboardTarget && registered.keyboardListener) {
          registered.keyboardTarget.removeEventListener('keydown', registered.keyboardListener)
        }
        record.commands.delete(id)
        if (shortcutKey && record.shortcutOwners.get(shortcutKey) === registered) {
          record.shortcutOwners.delete(shortcutKey)
        }
        if (this.commands.get(id) !== registered) return
        this.commands.delete(id)
        if (shortcutKey && this.shortcutOwners.get(shortcutKey) === registered) {
          this.shortcutOwners.delete(shortcutKey)
        }
        this.publishCommands()
      },
      `command ${id}`,
      () => {
        this.commands.set(id, registered)
        if (shortcutKey) this.shortcutOwners.set(shortcutKey, registered)
        if (registered.keyboardTarget && registered.keyboardListener) {
          registered.keyboardTarget.addEventListener('keydown', registered.keyboardListener)
        }
        this.publishCommands()
      }
    )
  }

  private async executePluginCommand<TResult>(
    record: ActivePluginRecord,
    commandId: string,
    argumentsValue: unknown
  ): Promise<TResult> {
    this.assertActiveRecord(record)
    const staged = record.commands.get(commandId)
    if (staged) {
      return this.invokeRegisteredCommand<TResult>(staged, argumentsValue, 'api')
    }
    return this.executeRegisteredCommand<TResult>(commandId, argumentsValue, 'api')
  }

  private async executeRegisteredCommand<TResult>(
    commandId: string,
    argumentsValue: unknown,
    source: 'api' | 'keyboard',
    keyboardEvent?: KeyboardEvent
  ): Promise<TResult> {
    const registered = this.commands.get(commandId)
    if (!registered) {
      throw new Error(`Full Trust renderer command "${commandId}" is not registered.`)
    }
    return this.invokeRegisteredCommand<TResult>(registered, argumentsValue, source, keyboardEvent)
  }

  private async invokeRegisteredCommand<TResult>(
    registered: RegisteredCommand,
    argumentsValue: unknown,
    source: 'api' | 'keyboard',
    keyboardEvent?: KeyboardEvent
  ): Promise<TResult> {
    this.assertActiveRecord(registered.owner)
    return await registered.execute({
      plugin: registered.owner.identity,
      commandId: registered.publicValue.id,
      arguments: argumentsValue,
      source,
      ...(keyboardEvent ? { keyboardEvent } : {})
    }) as TResult
  }

  private registerPage(
    record: ActivePluginRecord,
    input: FullTrustPageInput
  ): FullTrustRendererDisposable {
    this.assertActiveRecord(record)
    const id = normalizeRegistryId(input.id, 'page')
    const route = normalizeRoute(input.route)
    const title = normalizeLabel(input.title, 'page title')
    const order = normalizeOrder(input.order, 'page')
    if (typeof input.component !== 'function') {
      throw new Error(`Full Trust renderer page "${id}" component is invalid.`)
    }
    if (record.pages.has(id)) {
      throw new Error(`Full Trust renderer page "${id}" is already registered.`)
    }
    const committedPage = this.pages.get(id)
    if (committedPage && committedPage.plugin.id !== record.identity.id) {
      throw new Error(`Full Trust renderer page "${id}" is already registered.`)
    }
    const committedRouteOwnerId = this.pageRoutes.get(route)
    const routeOwner = record.pageRoutes.get(route)
      ?? (committedRouteOwnerId ? this.pages.get(committedRouteOwnerId) : undefined)
    if (routeOwner) {
      if (routeOwner.plugin.id !== record.identity.id || record.pageRoutes.has(route)) {
        throw new Error(`Full Trust renderer route "${route}" is already registered by "${routeOwner.id}".`)
      }
    }
    const page: FullTrustPageRegistration = Object.freeze({
      id,
      route,
      title,
      order,
      component: input.component,
      plugin: record.identity
    })
    record.pages.set(id, page)
    record.pageRoutes.set(route, page)
    return this.trackDisposable(
      record,
      () => {
        record.pages.delete(id)
        if (record.pageRoutes.get(route) === page) record.pageRoutes.delete(route)
        if (this.pages.get(id) !== page) return
        this.pages.delete(id)
        if (this.pageRoutes.get(route) === id) this.pageRoutes.delete(route)
        this.publishPages()
      },
      `page ${id}`,
      () => {
        this.pages.set(id, page)
        this.pageRoutes.set(route, id)
        this.publishPages()
      }
    )
  }

  private addDomEventListener(
    record: ActivePluginRecord,
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): FullTrustRendererDisposable {
    this.assertActiveRecord(record)
    if (!target || typeof target.addEventListener !== 'function') {
      throw new Error('Full Trust renderer DOM event target is invalid.')
    }
    if (!type.trim()) throw new Error('Full Trust renderer DOM event type is invalid.')
    let listening = false
    return this.trackDisposable(
      record,
      () => {
        if (!listening) return
        listening = false
        target.removeEventListener(type, listener, options)
      },
      `DOM event ${type}`,
      () => {
        target.addEventListener(type, listener, options)
        listening = true
      }
    )
  }

  private subscribeToTheme(
    record: ActivePluginRecord,
    listener: (snapshot: FullTrustThemeSnapshot) => void,
    options?: FullTrustThemeSubscriptionOptions
  ): FullTrustRendererDisposable {
    this.assertActiveRecord(record)
    if (typeof listener !== 'function') {
      throw new Error('Full Trust renderer theme listener must be a function.')
    }
    if (typeof document === 'undefined') {
      throw new Error('Full Trust renderer theme subscription requires a document.')
    }
    const root = options?.root ?? document.documentElement
    const MutationObserverConstructor = root.ownerDocument.defaultView?.MutationObserver
      ?? globalThis.MutationObserver
    if (!MutationObserverConstructor) {
      throw new Error('Full Trust renderer theme subscription requires MutationObserver.')
    }
    const emit = () => listener(Object.freeze({ theme: root.dataset.theme ?? null, root }))
    const observer = new MutationObserverConstructor((mutations) => {
      if (mutations.some((mutation) => mutation.attributeName === 'data-theme')) emit()
    })
    return this.trackDisposable(
      record,
      () => observer.disconnect(),
      'theme subscription',
      () => {
        observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
        try {
          if (options?.emitCurrent ?? true) emit()
        } catch (error) {
          observer.disconnect()
          throw error
        }
      }
    )
  }

  private registerSlotContribution(
    record: ActivePluginRecord,
    input: FullTrustReactSlotContributionInput
  ): FullTrustRendererDisposable {
    this.assertActiveRecord(record)
    if (!Object.hasOwn(PLUGIN_UI_SLOT_CATALOG, input.slot)) {
      throw new Error(`Unknown Full Trust renderer slot "${String(input.slot)}".`)
    }
    if (!input.id.trim() || input.id.length > 200) {
      throw new Error('Full Trust renderer contribution id is invalid.')
    }
    if (typeof input.component !== 'function') {
      throw new Error('Full Trust renderer contribution component is invalid.')
    }
    const order = input.order ?? 0
    if (!Number.isSafeInteger(order)) {
      throw new Error('Full Trust renderer contribution order must be an integer.')
    }
    const key = contributionKey(record.identity.id, input.slot, input.id)
    if (record.contributions.has(key)) {
      throw new Error(
        `Full Trust renderer contribution "${input.id}" is already registered in ${input.slot}.`
      )
    }
    const contribution: FullTrustReactSlotContribution = Object.freeze({
      id: input.id,
      slot: input.slot,
      order,
      plugin: record.identity,
      component: input.component
    })
    record.contributions.set(key, contribution)
    return this.trackDisposable(
      record,
      () => {
        record.contributions.delete(key)
        if (this.contributions.get(key) !== contribution) return
        this.contributions.delete(key)
        this.publishSlot(input.slot)
      },
      `slot contribution ${input.slot}:${input.id}`,
      () => {
        this.contributions.set(key, contribution)
        this.publishSlot(input.slot)
      }
    )
  }

  private injectCss(
    record: ActivePluginRecord,
    cssText: string,
    options?: FullTrustStyleOptions
  ): FullTrustRendererDisposable {
    this.assertActiveRecord(record)
    if (typeof document === 'undefined') {
      throw new Error('Full Trust renderer CSS requires a document.')
    }
    const style = document.createElement('style')
    style.dataset.fullTrustPlugin = record.identity.id
    style.dataset.fullTrustRevision = record.identity.revisionHash
    if (options?.id) style.dataset.fullTrustStyle = options.id
    if (options?.media) style.media = options.media
    style.textContent = cssText
    const target = options?.target ?? document.head
    return this.trackDisposable(
      record,
      () => style.remove(),
      `CSS ${options?.id ?? 'style'}`,
      () => { target.appendChild(style) }
    )
  }

  private async createUnsandboxedFrame(
    record: ActivePluginRecord,
    options: FullTrustFrameOptions
  ): Promise<FullTrustFrameHandle> {
    this.assertActiveRecord(record)
    const token = createPolicyToken()
    const frameName = `knowbook-full-trust-frame:${record.identity.id}:${token}`
    const popupName = `knowbook-full-trust-popup:${record.identity.id}:${token}`
    const policy = {
      pluginId: record.identity.id,
      revisionHash: record.identity.revisionHash,
      frameName,
      popupName,
      allowedOrigins: resolveFrameOrigins(options.src, options.allowedOrigins),
      allowPopups: options.allowPopups ?? true,
      allowNavigation: options.allowNavigation ?? true,
      allowDownloads: options.allowDownloads ?? true,
      allowPermissions: options.allowPermissions ?? true
    }
    let policyRegistered = false
    try {
      await window.knowbook.registerSystemPluginFramePolicy(policy)
      policyRegistered = true
      this.assertActiveRecord(record)
      const frame = document.createElement('iframe')
      frame.name = frameName
      frame.dataset.fullTrustPlugin = record.identity.id
      frame.dataset.fullTrustPopupName = popupName
      if (options.className) frame.className = options.className
      if (options.title) frame.title = options.title
      if (options.allow) frame.allow = options.allow
      frame.src = options.src
      const dispose = this.trackDisposable(
        record,
        async () => {
          frame.remove()
          if (!policyRegistered) return
          policyRegistered = false
          await window.knowbook.removeSystemPluginFramePolicy({
            pluginId: record.identity.id,
            revisionHash: record.identity.revisionHash,
            frameName
          })
        },
        `unsandboxed frame ${frameName}`,
        () => {
          if (options.container) options.container.appendChild(frame)
        }
      )
      return Object.freeze({ frame, frameName, popupName, dispose })
    } catch (error) {
      if (policyRegistered) {
        policyRegistered = false
        await window.knowbook.removeSystemPluginFramePolicy({
          pluginId: record.identity.id,
          revisionHash: record.identity.revisionHash,
          frameName
        }).catch(() => undefined)
      }
      throw error
    }
  }

  private async openPrivilegedPopup(
    record: ActivePluginRecord,
    options: FullTrustPopupOptions
  ): Promise<FullTrustPopupHandle> {
    this.assertActiveRecord(record)
    const token = createPolicyToken()
    const frameName = `knowbook-full-trust-frame:${record.identity.id}:${token}`
    const popupName = `knowbook-full-trust-popup:${record.identity.id}:${token}`
    const policy = {
      pluginId: record.identity.id,
      revisionHash: record.identity.revisionHash,
      frameName,
      popupName,
      allowedOrigins: resolveFrameOrigins(options.url, options.allowedOrigins),
      allowPopups: true,
      allowNavigation: true,
      allowDownloads: true,
      allowPermissions: true
    }
    let policyRegistered = false
    let opened: Window | null = null
    try {
      await window.knowbook.registerSystemPluginFramePolicy(policy)
      policyRegistered = true
      this.assertActiveRecord(record)
      const dispose = this.trackDisposable(
        record,
        async () => {
          opened?.close()
          opened = null
          if (!policyRegistered) return
          policyRegistered = false
          await window.knowbook.removeSystemPluginFramePolicy({
            pluginId: record.identity.id,
            revisionHash: record.identity.revisionHash,
            frameName
          })
        },
        `privileged popup ${popupName}`,
        () => {
          opened = window.open(options.url, popupName, options.features)
        }
      )
      return Object.freeze({
        get window() { return opened },
        popupName,
        dispose
      })
    } catch (error) {
      if (policyRegistered) {
        policyRegistered = false
        await window.knowbook.removeSystemPluginFramePolicy({
          pluginId: record.identity.id,
          revisionHash: record.identity.revisionHash,
          frameName
        }).catch(() => undefined)
      }
      throw error
    }
  }

  private trackDisposable(
    record: ActivePluginRecord,
    dispose: FullTrustRendererDisposable,
    label: string,
    commit?: () => void
  ): FullTrustRendererDisposable {
    this.assertActiveRecord(record)
    if (typeof dispose !== 'function') {
      throw new Error('Full Trust renderer disposable must be a function.')
    }
    const tracked: TrackedDisposable = {
      label,
      disposed: false,
      committed: commit === undefined,
      ...(commit ? { commit } : {}),
      dispose
    }
    record.disposables.push(tracked)
    if (record.state === 'committed') {
      try {
        this.commitTracked(tracked)
      } catch (error) {
        void this.disposeTracked(tracked).catch((cleanupError) => {
          console.warn(`Full Trust renderer cleanup failed for ${label}.`, cleanupError)
        })
        throw error
      }
    }
    return () => this.disposeTracked(tracked)
  }

  private commitTracked(tracked: TrackedDisposable): void {
    if (tracked.disposed || tracked.committed) return
    tracked.committed = true
    tracked.commit?.()
  }

  private async disposeTracked(tracked: TrackedDisposable): Promise<void> {
    if (tracked.disposed) return
    tracked.disposed = true
    await tracked.dispose()
  }

  private async cleanupRecord(record: ActivePluginRecord): Promise<void> {
    if (this.activePlugins.get(record.identity.id) === record) {
      this.activePlugins.delete(record.identity.id)
    }
    if (this.stagedPlugins.get(record.identity.id) === record) {
      this.stagedPlugins.delete(record.identity.id)
    }
    record.state = 'inactive'
    const failures: Error[] = []
    // Begin every release before awaiting plugin code: a hung custom disposer
    // must not keep commands, DOM resources, or the publication batch alive.
    const disposables = record.disposables.splice(0).reverse()
    await Promise.all(disposables.map(async (tracked) => {
      try {
        await this.disposeTracked(tracked)
      } catch (error) {
        failures.push(new Error(
          `Full Trust renderer cleanup failed for ${tracked.label}.`,
          { cause: error }
        ))
      }
    }))
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Full Trust renderer plugin "${record.identity.id}" cleanup failed.`
      )
    }
  }

  private isLiveRecord(record: ActivePluginRecord): boolean {
    return record.state !== 'inactive' && (
      this.activePlugins.get(record.identity.id) === record
      || this.stagedPlugins.get(record.identity.id) === record
    )
  }

  private createInactiveRecordError(record: ActivePluginRecord): Error {
    return new Error(`Full Trust renderer plugin "${record.identity.id}" is not active.`)
  }

  private assertActiveRecord(record: ActivePluginRecord): void {
    if (!this.isLiveRecord(record)) throw this.createInactiveRecordError(record)
  }

  private validateCommit(record: ActivePluginRecord): void {
    for (const [id, command] of record.commands) {
      const existing = this.commands.get(id)
      if (existing && existing.owner.identity.id !== record.identity.id) {
        throw new Error(`Full Trust renderer command "${id}" is already registered.`)
      }
      if (command.shortcutKey) {
        const shortcutOwner = this.shortcutOwners.get(command.shortcutKey)
        if (shortcutOwner && shortcutOwner.owner.identity.id !== record.identity.id) {
          throw new Error(
            `Full Trust renderer shortcut is already registered by "${shortcutOwner.publicValue.id}".`
          )
        }
      }
    }
    for (const [id, page] of record.pages) {
      const existing = this.pages.get(id)
      if (existing && existing.plugin.id !== record.identity.id) {
        throw new Error(`Full Trust renderer page "${id}" is already registered.`)
      }
      const routeOwnerId = this.pageRoutes.get(page.route)
      const routeOwner = routeOwnerId ? this.pages.get(routeOwnerId) : null
      if (routeOwner && routeOwner.plugin.id !== record.identity.id) {
        throw new Error(
          `Full Trust renderer route "${page.route}" is already registered by "${routeOwner.id}".`
        )
      }
    }
  }

  private publishSlot(slot: PluginUiSlot): void {
    if (this.publishBatchDepth > 0) {
      this.pendingSlotPublishes.add(slot)
      return
    }
    this.publishSlotNow(slot)
  }

  private publishSlotNow(slot: PluginUiSlot, notify = true): void {
    const next = [...this.contributions.values()]
      .filter((contribution) => contribution.slot === slot)
      .sort((left, right) =>
        left.order - right.order
        || left.plugin.id.localeCompare(right.plugin.id)
        || left.id.localeCompare(right.id)
      )
    this.slotSnapshots.set(slot, Object.freeze(next))
    if (notify) this.notifySubscribers(this.slotListeners.get(slot) ?? [])
  }

  private publishCommands(): void {
    if (this.publishBatchDepth > 0) {
      this.pendingCommandPublish = true
      return
    }
    this.publishCommandsNow()
  }

  private publishCommandsNow(notify = true): void {
    this.commandSnapshot = Object.freeze(
      [...this.commands.values()]
        .map(({ publicValue }) => publicValue)
        .sort((left, right) =>
          left.order - right.order
          || left.plugin.id.localeCompare(right.plugin.id)
          || left.id.localeCompare(right.id)
        )
    )
    if (notify) this.notifySubscribers(this.commandListeners)
  }

  private publishPages(): void {
    if (this.publishBatchDepth > 0) {
      this.pendingPagePublish = true
      return
    }
    this.publishPagesNow()
  }

  private publishPagesNow(notify = true): void {
    this.pageSnapshot = Object.freeze(
      [...this.pages.values()].sort((left, right) =>
        left.order - right.order
        || left.plugin.id.localeCompare(right.plugin.id)
        || left.id.localeCompare(right.id)
      )
    )
    if (notify) this.notifySubscribers(this.pageListeners)
  }

  private notifySubscribers(listeners: Iterable<() => void>): void {
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        console.error('Full Trust renderer registry subscriber failed.', error)
      }
    }
  }

  private beginPublishBatch(): void {
    this.publishBatchDepth += 1
  }

  private endPublishBatch(): void {
    this.publishBatchDepth -= 1
    if (this.publishBatchDepth > 0) return
    if (this.publishBatchDepth < 0) {
      this.publishBatchDepth = 0
      throw new Error('Full Trust renderer publish batch underflow.')
    }
    const slots = [...this.pendingSlotPublishes]
    this.pendingSlotPublishes.clear()
    const publishCommands = this.pendingCommandPublish
    const publishPages = this.pendingPagePublish
    this.pendingCommandPublish = false
    this.pendingPagePublish = false
    // Refresh every public snapshot before any subscriber can observe the
    // revision, including subscribers that read more than one registry.
    const listeners = new Set<() => void>()
    for (const slot of slots) {
      this.publishSlotNow(slot, false)
      for (const listener of this.slotListeners.get(slot) ?? []) listeners.add(listener)
    }
    if (publishCommands) {
      this.publishCommandsNow(false)
      for (const listener of this.commandListeners) listeners.add(listener)
    }
    if (publishPages) {
      this.publishPagesNow(false)
      for (const listener of this.pageListeners) listeners.add(listener)
    }
    this.notifySubscribers(listeners)
  }
}

export const fullTrustPluginRegistry = new FullTrustPluginRegistry()

export function useFullTrustSlotContributions(
  slot: PluginUiSlot
): readonly FullTrustReactSlotContribution[] {
  return useSyncExternalStore(
    (listener) => fullTrustPluginRegistry.subscribeToSlot(slot, listener),
    () => fullTrustPluginRegistry.getSlotContributions(slot),
    () => fullTrustPluginRegistry.getSlotContributions(slot)
  )
}

export function exposeFullTrustPluginRegistry(target: Window = window): void {
  const existing = Object.getOwnPropertyDescriptor(target, 'knowbookFullTrust')
  if (existing?.value === fullTrustPluginRegistry) return
  if (existing) throw new Error('window.knowbookFullTrust is already defined.')
  Object.defineProperty(target, 'knowbookFullTrust', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: fullTrustPluginRegistry
  })
}

function normalizeIdentity(
  identity: FullTrustRendererPluginIdentity
): Readonly<FullTrustRendererPluginIdentity> {
  for (const [field, value] of Object.entries(identity)) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Full Trust renderer plugin ${field} is invalid.`)
    }
  }
  return Object.freeze({
    id: identity.id,
    version: identity.version,
    revisionHash: identity.revisionHash
  })
}

function replaceMap<TKey, TValue>(
  target: Map<TKey, TValue>,
  source: ReadonlyMap<TKey, TValue>
): void {
  target.clear()
  for (const [key, value] of source) target.set(key, value)
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function contributionKey(pluginId: string, slot: PluginUiSlot, id: string): string {
  return `${pluginId}\u0000${slot}\u0000${id}`
}

function normalizeRegistryId(value: string, kind: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f]/u.test(normalized)) {
    throw new Error(`Full Trust renderer ${kind} id is invalid.`)
  }
  return normalized
}

function normalizeLabel(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 500) {
    throw new Error(`Full Trust renderer ${field} is invalid.`)
  }
  return normalized
}

function normalizeOrder(order: number | undefined, kind: string): number {
  const normalized = order ?? 0
  if (!Number.isSafeInteger(normalized)) {
    throw new Error(`Full Trust renderer ${kind} order must be an integer.`)
  }
  return normalized
}

function normalizeShortcut(shortcut: FullTrustKeyboardShortcut): Readonly<FullTrustKeyboardShortcut> {
  const key = shortcut.key.trim()
  if (!key || key.length > 100) {
    throw new Error('Full Trust renderer shortcut key is invalid.')
  }
  return Object.freeze({
    key,
    ctrlKey: shortcut.ctrlKey ?? false,
    metaKey: shortcut.metaKey ?? false,
    altKey: shortcut.altKey ?? false,
    shiftKey: shortcut.shiftKey ?? false,
    allowInEditable: shortcut.allowInEditable ?? false,
    preventDefault: shortcut.preventDefault ?? true,
    stopPropagation: shortcut.stopPropagation ?? false
  })
}

function serializeShortcut(shortcut: Readonly<FullTrustKeyboardShortcut>): string {
  return [
    shortcut.ctrlKey ? 'ctrl' : '',
    shortcut.metaKey ? 'meta' : '',
    shortcut.altKey ? 'alt' : '',
    shortcut.shiftKey ? 'shift' : '',
    shortcut.key.toLocaleLowerCase('en-US')
  ].join('+')
}

function describeShortcut(shortcut: Readonly<FullTrustKeyboardShortcut>): string {
  return [
    shortcut.ctrlKey ? 'Ctrl' : '',
    shortcut.metaKey ? 'Meta' : '',
    shortcut.altKey ? 'Alt' : '',
    shortcut.shiftKey ? 'Shift' : '',
    shortcut.key
  ].filter(Boolean).join('+')
}

function matchesShortcut(event: KeyboardEvent, shortcut: Readonly<FullTrustKeyboardShortcut>): boolean {
  return event.key.toLocaleLowerCase('en-US') === shortcut.key.toLocaleLowerCase('en-US')
    && event.ctrlKey === Boolean(shortcut.ctrlKey)
    && event.metaKey === Boolean(shortcut.metaKey)
    && event.altKey === Boolean(shortcut.altKey)
    && event.shiftKey === Boolean(shortcut.shiftKey)
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false
  const candidate = target as {
    nodeName?: string
    isContentEditable?: boolean
    closest?: (selector: string) => Element | null
  }
  if (candidate.isContentEditable) return true
  const nodeName = candidate.nodeName?.toLocaleLowerCase('en-US')
  if (nodeName === 'input' || nodeName === 'textarea' || nodeName === 'select') return true
  return Boolean(candidate.closest?.('[contenteditable="true"]'))
}

function normalizeRoute(value: string): string {
  let route = value.trim()
  if (
    !route.startsWith('/')
    || route.length > 500
    || route.includes('?')
    || route.includes('#')
    || route.includes('\\')
    || route.includes('//')
    || /[\u0000-\u001f]/u.test(route)
  ) {
    throw new Error(`Full Trust renderer route "${value}" is invalid.`)
  }
  if (route.length > 1) route = route.replace(/\/+$/u, '')
  return route
}

function resolveFrameOrigins(url: string, declaredOrigins?: string[]): string[] {
  const values = declaredOrigins?.length ? declaredOrigins : [url]
  const origins = values.map((value) => {
    if (value === '*') {
      throw new Error('Full Trust frame origins must be explicit; wildcard origin is not allowed.')
    }
    const parsed = new URL(value, document.baseURI)
    if (parsed.protocol === 'javascript:') {
      throw new Error('Full Trust frame policy cannot register a javascript: origin.')
    }
    return parsed.origin && parsed.origin !== 'null' ? parsed.origin : parsed.protocol
  })
  return [...new Set(['about:', ...origins])]
}

function createPolicyToken(): string {
  if (typeof crypto?.randomUUID !== 'function') {
    throw new Error('Full Trust frame policies require crypto.randomUUID().')
  }
  return crypto.randomUUID()
}

declare global {
  interface Window {
    readonly knowbookFullTrust: FullTrustPluginRegistry
  }
}
