import { dirname } from 'node:path'
import type {
  DocumentDetail,
  PluginDescriptor,
  RunPluginDocumentActionResult,
  WorkspaceEventType
} from '@shared/contracts'
import type { KnowbookStore } from './database/store'
import { PluginHost } from './plugin-host'
import type {
  PluginRuntimeCommand,
  PluginRuntimeEffect,
  PluginRuntimeInitializeInput,
  PluginRuntimeMessage,
  PluginRuntimeOutput,
  PluginRuntimeRequest,
  PluginRuntimeState,
  PluginRuntimeWorkspaceEventRecord
} from './plugin-runtime-protocol'

class RuntimeStore {
  private readonly settings = new Map<string, string>()
  private readonly documents = new Map<string, DocumentDetail>()
  private effects: PluginRuntimeEffect[] = []

  reset(input: PluginRuntimeInitializeInput): void {
    this.settings.clear()
    for (const [key, value] of Object.entries(input.settings)) {
      this.settings.set(key, value)
    }
    this.settings.set(`plugin.enabled.${input.pluginId}`, 'true')
    this.documents.clear()
    this.updateDocuments(input.documents, [])
    this.effects = []
  }

  updateDocuments(documents: DocumentDetail[], removedDocumentIds: string[]): void {
    for (const documentId of removedDocumentIds) {
      this.documents.delete(documentId)
    }
    for (const document of documents) {
      this.documents.set(document.id, structuredClone(document))
    }
  }

  getSettingPublic(key: string): string | null {
    return this.settings.get(key) ?? null
  }

  saveSetting(key: string, value: string): void {
    this.settings.set(key, value)
    this.effects.push({ type: 'setting.saved', key, value })
  }

  getDocumentDetail(documentId: string): DocumentDetail | null {
    const document = this.documents.get(documentId)
    return document ? structuredClone(document) : null
  }

  updateDocumentSummary(documentId: string, summary: string): void {
    const document = this.documents.get(documentId)
    if (!document) {
      throw new Error('Document not found')
    }
    const normalizedSummary = summary.trim()
    this.documents.set(documentId, {
      ...document,
      summary: normalizedSummary,
      updatedAt: new Date().toISOString()
    })
    this.effects.push({
      type: 'document.summary.updated',
      documentId,
      summary: normalizedSummary
    })
  }

  recordWorkspaceEvent(event: PluginRuntimeWorkspaceEventRecord): void {
    this.effects.push({
      type: 'workspace-event.recorded',
      event: structuredClone(event)
    })
  }

  takeEffects(): PluginRuntimeEffect[] {
    const effects = this.effects
    this.effects = []
    return effects
  }
}

class PluginRuntimeServer {
  private readonly store = new RuntimeStore()
  private host: PluginHost | null = null
  private pluginId: string | null = null
  private lastStateFingerprint = ''
  private disposed = false

  async execute(command: PluginRuntimeCommand): Promise<PluginRuntimeOutput> {
    switch (command.type) {
      case 'initialize':
        return this.initialize(command.input)
      case 'workspace-event': {
        const host = this.requireHost()
        this.store.updateDocuments(command.documents, command.removedDocumentIds)
        await host.handleWorkspaceEvent(command.event)
        return this.takeOutput()
      }
      case 'document-action': {
        const host = this.requireHost()
        this.store.updateDocuments([command.document], [])
        const result = await host.runDocumentAction({
          pluginId: this.requirePluginId(),
          actionId: command.actionId,
          documentId: command.document.id
        })
        return this.takeOutput(result)
      }
      case 'setting-update': {
        const host = this.requireHost()
        await host.updatePluginSetting(this.requirePluginId(), command.settingId, command.value)
        return this.takeOutput()
      }
      case 'dispose': {
        if (this.host) {
          await this.host.destroy()
        }
        this.disposed = true
        return this.takeOutput()
      }
    }
  }

  takeNotification(): PluginRuntimeOutput | null {
    if (!this.host || this.disposed) {
      return null
    }

    const state = this.getState()
    const fingerprint = JSON.stringify(state)
    const effects = this.store.takeEffects()
    if (fingerprint === this.lastStateFingerprint && effects.length === 0) {
      return null
    }

    this.lastStateFingerprint = fingerprint
    return { state, effects }
  }

  private async initialize(
    input: PluginRuntimeInitializeInput
  ): Promise<PluginRuntimeOutput<RunPluginDocumentActionResult>> {
    if (this.host) {
      throw new Error('Plugin runtime has already been initialized.')
    }

    this.pluginId = input.pluginId
    this.store.reset(input)
    this.host = new PluginHost(
      this.store as unknown as KnowbookStore,
      [{ path: dirname(input.directory), source: input.source }],
      input.currentVersion,
      null,
      { pluginIdFilter: input.pluginId }
    )
    await this.host.loadAll()

    if (!input.recordLoadEvent) {
      const effects = this.store.takeEffects()
      for (const effect of effects) {
        if (
          effect.type !== 'workspace-event.recorded'
          || effect.event.type !== 'plugin.loaded'
        ) {
          this.restoreEffect(effect)
        }
      }
    }

    return this.takeOutput()
  }

  private restoreEffect(effect: PluginRuntimeEffect): void {
    if (effect.type === 'setting.saved') {
      this.store.saveSetting(effect.key, effect.value)
      return
    }
    if (effect.type === 'document.summary.updated') {
      this.store.updateDocumentSummary(effect.documentId, effect.summary)
      return
    }
    this.store.recordWorkspaceEvent(effect.event)
  }

  private takeOutput(
    result?: RunPluginDocumentActionResult
  ): PluginRuntimeOutput<RunPluginDocumentActionResult> {
    const state = this.getState()
    this.lastStateFingerprint = JSON.stringify(state)
    return {
      state,
      effects: this.store.takeEffects(),
      ...(result ? { result } : {})
    }
  }

  private getState(): PluginRuntimeState {
    const snapshot = this.requireHost().getHomeDataSnapshot()
    const plugin = snapshot.plugins.find((candidate) => candidate.id === this.requirePluginId())
    return plugin
      ? mapPluginState(plugin, snapshot.dashboardCards, snapshot.documentActions)
      : {
          status: 'error',
          error: `Plugin "${this.requirePluginId()}" was not discovered by the isolated runtime.`,
          dashboardCards: [],
          documentActions: [],
          settings: []
        }
  }

  private requireHost(): PluginHost {
    if (!this.host) {
      throw new Error('Plugin runtime is not initialized.')
    }
    return this.host
  }

  private requirePluginId(): string {
    if (!this.pluginId) {
      throw new Error('Plugin runtime is not initialized.')
    }
    return this.pluginId
  }
}

function mapPluginState(
  plugin: PluginDescriptor,
  dashboardCards: PluginRuntimeState['dashboardCards'],
  documentActions: PluginRuntimeState['documentActions']
): PluginRuntimeState {
  return {
    status: plugin.status,
    error: plugin.error,
    dashboardCards: dashboardCards.filter((card) => card.pluginId === plugin.id),
    documentActions: documentActions.filter((action) => action.pluginId === plugin.id),
    settings: plugin.settings
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }
  return 'Isolated plugin runtime failed.'
}

const runtime = new PluginRuntimeServer()
let commandQueue = Promise.resolve()
const runtimeParentPort = process.parentPort

runtimeParentPort.on('message', (event) => {
  const request = event.data as PluginRuntimeRequest
  if (!request || request.kind !== 'request' || typeof request.requestId !== 'number') {
    return
  }

  commandQueue = commandQueue.then(async () => {
    let message: PluginRuntimeMessage
    try {
      const output = await runtime.execute(request.command)
      message = {
        kind: 'response',
        requestId: request.requestId,
        ok: true,
        output
      }
    } catch (error) {
      message = {
        kind: 'response',
        requestId: request.requestId,
        ok: false,
        error: getErrorMessage(error)
      }
    }
    runtimeParentPort.postMessage(message)
  }).catch((error) => {
    runtimeParentPort.postMessage({
      kind: 'response',
      requestId: request.requestId,
      ok: false,
      error: getErrorMessage(error)
    } satisfies PluginRuntimeMessage)
  })
})

const notificationTimer = setInterval(() => {
  const output = runtime.takeNotification()
  if (output) {
    runtimeParentPort.postMessage({
      kind: 'state-changed',
      output
    } satisfies PluginRuntimeMessage)
  }
}, 100)
notificationTimer.unref()
