import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PluginHost } from '../src/main/plugin-host.ts'
import type { WorkspaceEvent } from '../src/main/event-bus.ts'
import type {
  IsolatedPluginRuntime,
  PluginRuntimeEffect,
  PluginRuntimeInitializeInput,
  PluginRuntimeOutput,
  PluginRuntimeState
} from '../src/main/plugin-runtime-protocol.ts'
import type {
  DocumentDetail,
  PluginSettingValue,
  RunPluginDocumentActionResult
} from '../src/shared/contracts.ts'

const initialState: PluginRuntimeState = {
  status: 'running',
  dashboardCards: [{
    pluginId: 'isolated-probe',
    id: 'probe-card',
    title: 'Isolated',
    body: 'ready'
  }],
  documentActions: [{
    pluginId: 'isolated-probe',
    id: 'refresh-summary',
    label: 'Refresh summary'
  }],
  settings: [{
    pluginId: 'isolated-probe',
    id: 'prefix',
    label: 'Prefix',
    type: 'text',
    value: '',
    defaultValue: ''
  }]
}

class FakeIsolatedRuntime implements IsolatedPluginRuntime {
  initializeInput: PluginRuntimeInitializeInput | null = null
  lastEvent: WorkspaceEvent | null = null
  lastEventDocuments: DocumentDetail[] = []
  disposed = false
  actionEffects: PluginRuntimeEffect[] = [
    {
      type: 'document.summary.updated',
      documentId: 'doc-1',
      summary: 'isolated summary'
    },
    {
      type: 'workspace-event.recorded',
      event: {
        type: 'plugin.action.executed',
        title: 'Action complete',
        description: 'Updated from isolated runtime.',
        documentId: 'doc-1'
      }
    }
  ]
  private state = structuredClone(initialState)
  private readonly stateListeners = new Set<(output: PluginRuntimeOutput) => void>()
  private readonly failureListeners = new Set<(error: Error) => void>()

  async initialize(input: PluginRuntimeInitializeInput): Promise<PluginRuntimeOutput> {
    this.initializeInput = structuredClone(input)
    return {
      state: this.state,
      effects: [{
        type: 'workspace-event.recorded',
        event: {
          type: 'plugin.loaded',
          title: 'Plugin loaded',
          description: 'Loaded in a fake isolated runtime.'
        }
      }]
    }
  }

  async handleWorkspaceEvent(
    event: WorkspaceEvent,
    documents: DocumentDetail[]
  ): Promise<PluginRuntimeOutput> {
    this.lastEvent = structuredClone(event)
    this.lastEventDocuments = structuredClone(documents)
    this.state = {
      ...this.state,
      dashboardCards: this.state.dashboardCards.map((card) => ({
        ...card,
        body: event.type
      }))
    }
    return { state: this.state, effects: [] }
  }

  async runDocumentAction(
    _actionId: string,
    document: DocumentDetail
  ): Promise<PluginRuntimeOutput<RunPluginDocumentActionResult>> {
    return {
      state: this.state,
      effects: this.actionEffects,
      result: {
        message: 'done',
        refreshDocument: true
      }
    }
  }

  async updateSetting(settingId: string, value: PluginSettingValue): Promise<PluginRuntimeOutput> {
    this.state = {
      ...this.state,
      settings: this.state.settings.map((setting) => (
        setting.id === settingId ? { ...setting, value } : setting
      ))
    }
    return {
      state: this.state,
      effects: [{
        type: 'setting.saved',
        key: `plugin.setting.isolated-probe.${settingId}`,
        value: String(value)
      }]
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }

  onStateChanged(listener: (output: PluginRuntimeOutput) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener)
    return () => this.failureListeners.delete(listener)
  }

  fail(message: string): void {
    for (const listener of this.failureListeners) {
      listener(new Error(message))
    }
  }
}

function createDocument(): DocumentDetail {
  return {
    id: 'doc-1',
    title: 'Document',
    path: 'Document',
    summary: '',
    updatedAt: '2026-07-30T00:00:00.000Z',
    blocks: [],
    children: [],
    outgoingLinks: [],
    backlinks: []
  }
}

test('PluginHost applies isolated runtime state and host-owned effects', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-isolated-plugin-test-'))
  const workspaceRoot = join(tempRoot, 'plugins')
  const pluginRoot = join(workspaceRoot, 'isolated-probe')
  mkdirSync(pluginRoot, { recursive: true })
  writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify({
    id: 'isolated-probe',
    name: 'Isolated Probe',
    version: '1.0.0',
    entry: 'index.js'
  }))
  writeFileSync(join(pluginRoot, 'index.js'), 'throw new Error("must not execute in the main process")')

  const document = createDocument()
  const settings = new Map<string, string>([['plugin.setting.isolated-probe.prefix', 'stored']])
  const summaries: Array<{ documentId: string; summary: string }> = []
  const events: Array<{ type: string; description: string }> = []
  const runtime = new FakeIsolatedRuntime()
  const store = {
    getSettingPublic: () => null,
    getSettingsByPrefix: (prefix: string) => Object.fromEntries(
      [...settings].filter(([key]) => key.startsWith(prefix))
    ),
    getPluginWorkspaceDocuments: () => [document],
    saveSetting: (key: string, value: string) => settings.set(key, value),
    getDocumentDetail: () => document,
    updateDocumentSummary: (documentId: string, summary: string) => {
      summaries.push({ documentId, summary })
    },
    recordWorkspaceEvent: (event: { type: string; description: string }) => events.push(event)
  }
  let mutationDocumentId: string | null = null
  const host = new PluginHost(
    store as never,
    [{ path: workspaceRoot, source: 'workspace' }],
    '1.0.0',
    (documentId) => {
      mutationDocumentId = documentId
    },
    { runtimeFactory: () => runtime }
  )

  try {
    await host.loadAll()
    assert.equal(runtime.initializeInput?.settings['plugin.setting.isolated-probe.prefix'], 'stored')
    assert.equal(runtime.initializeInput?.documents[0]?.id, document.id)
    assert.equal(host.getHomeDataSnapshot().plugins[0]?.status, 'running')
    assert.equal(host.getHomeDataSnapshot().dashboardCards[0]?.body, 'ready')
    assert.equal(events.some((event) => event.type === 'plugin.loaded'), true)

    await host.updatePluginSetting('isolated-probe', 'prefix', 'next')
    assert.equal(settings.get('plugin.setting.isolated-probe.prefix'), 'next')
    assert.equal(host.getHomeDataSnapshot().plugins[0]?.settings[0]?.value, 'next')

    await host.handleWorkspaceEvent({
      type: 'document.updated',
      createdAt: '2026-07-30T00:00:00.000Z',
      documentId: document.id,
      documentTitle: document.title,
      path: document.path,
      affectedDocumentIds: [document.id],
      pathChanged: false
    })
    assert.equal(runtime.lastEvent?.type, 'document.updated')
    assert.equal(runtime.lastEventDocuments[0]?.id, document.id)
    assert.equal(host.getHomeDataSnapshot().dashboardCards[0]?.body, 'document.updated')

    const result = await host.runDocumentAction({
      pluginId: 'isolated-probe',
      actionId: 'refresh-summary',
      documentId: document.id
    })
    assert.deepEqual(result, { message: 'done', refreshDocument: true })
    assert.deepEqual(summaries, [{ documentId: document.id, summary: 'isolated summary' }])
    assert.equal(mutationDocumentId, document.id)
    assert.equal(events.some((event) => event.type === 'plugin.action.executed'), true)

    runtime.actionEffects = [{
      type: 'setting.saved',
      key: 'ai.apiKey',
      value: 'forbidden'
    }]
    await assert.rejects(
      host.runDocumentAction({
        pluginId: 'isolated-probe',
        actionId: 'refresh-summary',
        documentId: document.id
      }),
      /unauthorized setting key/
    )
    assert.equal(host.getHomeDataSnapshot().plugins[0]?.status, 'error')
    assert.equal(settings.has('ai.apiKey'), false)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost contains an isolated runtime failure to the owning plugin', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-isolated-failure-test-'))
  const workspaceRoot = join(tempRoot, 'plugins')
  const pluginRoot = join(workspaceRoot, 'isolated-probe')
  mkdirSync(pluginRoot, { recursive: true })
  writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify({
    id: 'isolated-probe',
    name: 'Isolated Probe',
    version: '1.0.0'
  }))
  writeFileSync(join(pluginRoot, 'index.js'), '')

  const runtime = new FakeIsolatedRuntime()
  const store = {
    getSettingPublic: () => null,
    getSettingsByPrefix: () => ({}),
    getPluginWorkspaceDocuments: () => [],
    saveSetting: () => undefined,
    getDocumentDetail: () => null,
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }
  const host = new PluginHost(
    store as never,
    [{ path: workspaceRoot, source: 'workspace' }],
    '1.0.0',
    null,
    { runtimeFactory: () => runtime }
  )

  try {
    await host.loadAll()
    runtime.fail('utility crashed')
    await new Promise((resolve) => setImmediate(resolve))

    const snapshot = host.getHomeDataSnapshot()
    assert.equal(snapshot.plugins[0]?.status, 'error')
    assert.equal(snapshot.plugins[0]?.error, 'utility crashed')
    assert.equal(snapshot.dashboardCards.length, 0)
    assert.equal(snapshot.documentActions.length, 0)
    assert.equal(runtime.disposed, true)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
