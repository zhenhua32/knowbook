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

class DeferredIsolatedRuntime implements IsolatedPluginRuntime {
  disposed = false
  initializeInput: PluginRuntimeInitializeInput | null = null
  private releaseInitialization: (() => void) | null = null
  private readonly initializationGate = new Promise<void>((resolve) => {
    this.releaseInitialization = resolve
  })

  constructor(
    readonly pluginId: string,
    private readonly onInitializeStarted: (runtime: DeferredIsolatedRuntime) => void,
    private readonly onInitializeFinished: () => void
  ) {}

  async initialize(input: PluginRuntimeInitializeInput): Promise<PluginRuntimeOutput> {
    this.initializeInput = structuredClone(input)
    this.onInitializeStarted(this)
    try {
      await this.initializationGate
    } finally {
      this.onInitializeFinished()
    }
    return { state: this.getRunningState(), effects: [] }
  }

  async handleWorkspaceEvent(): Promise<PluginRuntimeOutput> {
    return { state: this.getRunningState(), effects: [] }
  }

  async runDocumentAction(): Promise<PluginRuntimeOutput<RunPluginDocumentActionResult>> {
    return {
      state: this.getRunningState(),
      effects: [],
      result: { message: 'done', refreshDocument: false }
    }
  }

  async updateSetting(): Promise<PluginRuntimeOutput> {
    return { state: this.getRunningState(), effects: [] }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.release()
  }

  onStateChanged(): () => void {
    return () => undefined
  }

  onFailure(): () => void {
    return () => undefined
  }

  release(): void {
    this.releaseInitialization?.()
    this.releaseInitialization = null
  }

  private getRunningState(): PluginRuntimeState {
    return {
      status: 'running',
      dashboardCards: [],
      documentActions: [],
      settings: []
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

async function waitForRuntimeCount(runtimes: DeferredIsolatedRuntime[], expectedCount: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && runtimes.length < expectedCount; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(runtimes.length, expectedCount)
}

test('PluginHost exposes loading inventory immediately and caps background activation concurrency', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-concurrency-test-'))
  const workspaceRoot = join(tempRoot, 'plugins')
  mkdirSync(workspaceRoot, { recursive: true })
  for (const pluginId of ['concurrency-a', 'concurrency-b', 'concurrency-c']) {
    const pluginRoot = join(workspaceRoot, pluginId)
    mkdirSync(pluginRoot, { recursive: true })
    writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify({
      id: pluginId,
      name: pluginId,
      version: '1.0.0'
    }))
    writeFileSync(join(pluginRoot, 'index.js'), '')
  }

  let activeInitializations = 0
  let maximumActiveInitializations = 0
  let settingsSnapshotReads = 0
  let documentSnapshotReads = 0
  const startedRuntimes: DeferredIsolatedRuntime[] = []
  const store = {
    getSettingPublic: () => null,
    getSettingsByPrefix: () => {
      settingsSnapshotReads += 1
      return {
        'plugin.setting.concurrency-a.token': 'a-secret',
        'plugin.setting.concurrency-b.token': 'b-secret',
        'plugin.setting.concurrency-c.token': 'c-secret'
      }
    },
    getPluginWorkspaceDocuments: () => {
      documentSnapshotReads += 1
      return []
    },
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
    {
      activationConcurrency: 2,
      runtimeFactory: (pluginId) => new DeferredIsolatedRuntime(
        pluginId,
        (runtime) => {
          activeInitializations += 1
          maximumActiveInitializations = Math.max(maximumActiveInitializations, activeInitializations)
          startedRuntimes.push(runtime)
        },
        () => {
          activeInitializations -= 1
        }
      )
    }
  )

  try {
    host.discoverAll()
    const loadingSnapshot = host.getHomeDataSnapshot()
    assert.equal(loadingSnapshot.plugins.length, 3)
    assert.deepEqual(loadingSnapshot.plugins.map((plugin) => plugin.status), ['loading', 'loading', 'loading'])
    assert.equal(startedRuntimes.length, 0)
    assert.equal(settingsSnapshotReads, 0)
    assert.equal(documentSnapshotReads, 0)

    const loadingPromise = host.activateAll()
    assert.equal(startedRuntimes.length, 2)
    assert.equal(settingsSnapshotReads, 1)
    assert.equal(documentSnapshotReads, 1)

    startedRuntimes[0]?.release()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(startedRuntimes.length, 3)
    assert.equal(maximumActiveInitializations, 2)

    for (const runtime of startedRuntimes) {
      runtime.release()
    }
    await loadingPromise
    assert.deepEqual(
      host.getHomeDataSnapshot().plugins.map((plugin) => plugin.status),
      ['running', 'running', 'running']
    )
    for (const runtime of startedRuntimes) {
      assert.deepEqual(runtime.initializeInput?.settings, {
        [`plugin.setting.${runtime.pluginId}.token`]: `${runtime.pluginId.at(-1)}-secret`
      })
    }
  } finally {
    for (const runtime of startedRuntimes) {
      runtime.release()
    }
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost reload cancels queued activations from the previous lifecycle generation', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-generation-test-'))
  const workspaceRoot = join(tempRoot, 'plugins')
  mkdirSync(workspaceRoot, { recursive: true })
  for (const pluginId of ['generation-a', 'generation-b', 'generation-c']) {
    const pluginRoot = join(workspaceRoot, pluginId)
    mkdirSync(pluginRoot, { recursive: true })
    writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify({
      id: pluginId,
      name: pluginId,
      version: '1.0.0'
    }))
    writeFileSync(join(pluginRoot, 'index.js'), '')
  }

  const runtimes: DeferredIsolatedRuntime[] = []
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
    {
      activationConcurrency: 1,
      runtimeFactory: (pluginId) => {
        const runtime = new DeferredIsolatedRuntime(pluginId, () => {
          runtimes.push(runtime)
        }, () => undefined)
        return runtime
      }
    }
  )

  try {
    const initialLoad = host.loadAll()
    await waitForRuntimeCount(runtimes, 1)
    assert.equal(runtimes[0]?.pluginId, 'generation-a')

    const reload = host.reloadAll()
    await waitForRuntimeCount(runtimes, 2)
    assert.deepEqual(runtimes.map((runtime) => runtime.pluginId), ['generation-a', 'generation-a'])
    assert.equal(runtimes[0]?.disposed, true)

    runtimes[1]?.release()
    await waitForRuntimeCount(runtimes, 3)
    assert.equal(runtimes[2]?.pluginId, 'generation-b')
    runtimes[2]?.release()
    await waitForRuntimeCount(runtimes, 4)
    assert.equal(runtimes[3]?.pluginId, 'generation-c')
    runtimes[3]?.release()

    await Promise.all([initialLoad, reload])
    assert.equal(runtimes.length, 4)
    assert.deepEqual(
      host.getHomeDataSnapshot().plugins.map((plugin) => plugin.status),
      ['running', 'running', 'running']
    )
  } finally {
    for (const runtime of runtimes) {
      runtime.release()
    }
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

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

test('PluginHost attributes isolated runtime workspace events to the owning plugin', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-isolated-attribution-test-'))
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
  runtime.actionEffects = [{
    type: 'workspace-event.recorded',
    event: {
      type: 'plugin.action.executed',
      title: 'Backup completed',
      description: 'Spoofed system-looking entry.'
    }
  }]
  const recordedEvents: Array<{ type: string; title: string }> = []
  const document = createDocument()
  const store = {
    getSettingPublic: () => null,
    getSettingsByPrefix: () => ({}),
    getPluginWorkspaceDocuments: () => [document],
    saveSetting: () => undefined,
    getDocumentDetail: () => document,
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: (event: { type: string; title: string }) => recordedEvents.push(event)
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

    const loadedEvent = recordedEvents.find((event) => event.type === 'plugin.loaded')
    assert.ok(loadedEvent, 'expected the plugin.loaded event to be recorded')
    assert.equal(
      loadedEvent.title,
      'Isolated Probe: Plugin loaded',
      'isolated plugin events must be prefixed with the plugin name'
    )

    await host.runDocumentAction({
      pluginId: 'isolated-probe',
      actionId: 'refresh-summary',
      documentId: document.id
    })

    const executedEvent = recordedEvents.find((event) => event.title.includes('Backup completed'))
    assert.ok(executedEvent, 'expected the action event to be recorded')
    assert.equal(
      executedEvent.title,
      'Isolated Probe: Backup completed',
      'system-looking titles must stay attributed to the plugin'
    )
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
