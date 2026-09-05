import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { WorkspaceEventBus, type WorkspaceEvent } from '../src/main/event-bus'
import {
  createKnowbookFullTrustServices,
  createKnowbookFullTrustServiceRpcMethods,
  type KnowbookFullTrustServiceOptions
} from '../src/main/system-plugin/knowbook-services'
import {
  SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
  SYSTEM_PLUGIN_SERVICE_RPC_REQUEST,
  SystemPluginServiceRpcHost,
  type SystemPluginServiceRpcJson
} from '../src/main/system-plugin/service-rpc'

test('Full Trust services expose Store/SQLite and keep document mutations observable', async () => {
  await withServices(async ({ services, events, notifications }) => {
    assert.equal(services.sqlite, services.store.getUnsafeDatabaseHandle())

    const parent = await services.documents.create({
      title: 'Parent',
      summary: 'Parent summary',
      blocks: [block('Parent body')]
    })
    const child = await services.documents.create({
      parentId: parent.id,
      title: 'Child',
      blocks: [block('Child body')]
    })
    assert.equal(child.path, 'Parent/Child')

    const updated = await services.documents.update(child.id, {
      title: 'Renamed',
      summary: 'Updated by Full Trust',
      blocks: [block('Updated body')]
    })
    assert.equal(updated.path, 'Parent/Renamed')

    const moved = await services.documents.move(child.id, null)
    assert.equal(moved.path, 'Renamed')
    const affected = await services.documents.delete(parent.id)
    assert.deepEqual(affected, [])

    assert.deepEqual(
      events.map((event) => event.type),
      ['document.created', 'document.created', 'document.updated', 'document.moved', 'document.deleted']
    )
    assert.equal(notifications.count, 5)
  })
})

test('Full Trust workspace events retain plugin-run correlation and unique mutation causation', async () => {
  let causationSequence = 0
  await withServices(async ({ services, events }) => {
    const document = await services.documents.create({
      title: 'Attributed document',
      blocks: [block('Original body')]
    })
    await services.documents.update(document.id, {
      title: 'Attributed update',
      summary: '',
      blocks: [block('Updated body')]
    })
    await services.documents.move(document.id, null)
    await services.documents.delete(document.id)
    await services.events.emit({
      type: 'ai.config.updated',
      createdAt: new Date().toISOString(),
      model: 'test-model',
      aiEnabled: true,
      originPluginId: 'spoofed-plugin',
      correlationId: 'spoofed-correlation',
      causationId: 'spoofed-causation'
    })

    assert.deepEqual(events.map((event) => event.type), [
      'document.created',
      'document.updated',
      'document.moved',
      'document.deleted',
      'ai.config.updated'
    ])
    assert.deepEqual(
      events.map(({ originPluginId, correlationId, causationId }) => ({
        originPluginId,
        correlationId,
        causationId
      })),
      [1, 2, 3, 4, 5].map((sequence) => ({
        originPluginId: 'system.metadata-test',
        correlationId: 'system-run-123',
        causationId: `mutation-${sequence}`
      }))
    )
  }, fetch, {
    workspaceEventContext: {
      originPluginId: 'system.metadata-test',
      correlationId: 'system-run-123',
      createCausationId: () => `mutation-${++causationSequence}`
    }
  })
})

test('Full Trust database and settings APIs notify the renderer while retaining raw access', async () => {
  await withServices(async ({ services, notifications }) => {
    const database = services.databases.create({ name: 'Automation DB', description: 'Created by plugin' })
    const column = services.databases.createColumn({
      databaseId: database.id,
      name: 'Status',
      type: 'select',
      options: ['Open', 'Done']
    })
    const entity = services.databases.createEntity({
      databaseId: database.id,
      title: 'Record',
      fieldValues: { [column.id]: 'Open' }
    })
    services.databases.updateEntity({ entityId: entity.id, title: 'Updated record' })
    assert.equal(services.databases.listEntities(database.id)[0]?.title, 'Updated record')

    services.settings.set('system-plugin.test', 'enabled')
    assert.equal(services.settings.get('system-plugin.test'), 'enabled')
    services.settings.delete('system-plugin.test')
    assert.equal(services.settings.get('system-plugin.test'), null)
    assert.equal(notifications.count, 6)
  })
})

test('Full Trust AI API supports arbitrary completion payloads and direct API-key access', async () => {
  let request: Request | null = null
  await withServices(async ({ services }) => {
    assert.equal(services.ai.getApiKey(), 'secret-key')
    const result = await services.ai.complete({
      messages: [{ role: 'user', content: 'Call a tool' }],
      tools: [{ type: 'function', function: { name: 'demo' } }],
      extra: { seed: 7 }
    }) as { id: string }
    assert.equal(result.id, 'completion-1')
    assert.ok(request)
    assert.equal(request.headers.get('authorization'), 'Bearer secret-key')
    const payload = JSON.parse(await request.clone().text()) as Record<string, unknown>
    assert.equal(payload.model, 'test-model')
    assert.equal(payload.seed, 7)
    assert.ok(Array.isArray(payload.tools))
  }, async (input, init) => {
    request = new Request(input, init)
    return new Response(JSON.stringify({ id: 'completion-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })
})

test('Full Trust secrets expose AI credentials plus snapshot and live environment reads', async () => {
  const environment: NodeJS.ProcessEnv = {
    KNOWBOOK_PLUGIN_TOKEN: 'initial',
    KNOWBOOK_PLUGIN_EMPTY: ''
  }
  await withServices(async ({ services }) => {
    assert.equal(services.secrets.getAiApiKey(), 'secret-key')
    assert.equal(services.secrets.environment.KNOWBOOK_PLUGIN_TOKEN, 'initial')
    assert.ok(Object.isFrozen(services.secrets.environment))

    environment.KNOWBOOK_PLUGIN_TOKEN = 'updated'
    assert.equal(services.secrets.environment.KNOWBOOK_PLUGIN_TOKEN, 'initial')
    assert.equal(services.secrets.getEnvironmentVariable('KNOWBOOK_PLUGIN_TOKEN'), 'updated')
    const latest = services.secrets.getEnvironmentSnapshot()
    assert.equal(latest.KNOWBOOK_PLUGIN_TOKEN, 'updated')
    assert.ok(Object.isFrozen(latest))

    const publicConfig = services.settings.getAiConfig()
    assert.equal('apiKey' in publicConfig, false)
    const secretConfig = services.settings.getAiConfig(true)
    assert.equal(secretConfig.apiKey, 'secret-key')
  }, fetch, { environment })
})

test('Full Trust desktop helpers register lifecycle cleanup for windows, menus and trays', async () => {
  const clipboard = { marker: 'clipboard' }
  const shell = { marker: 'shell' }
  const lifecycle: Array<{ dispose: () => void | Promise<void>; label?: string }> = []
  const events: string[] = []
  let applicationMenu: object | null = null

  class FakeBrowserWindow {
    private destroyed = false

    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      events.push(`window:create:${String(options.show)}`)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    close(): void {
      this.destroyed = true
      events.push('window:close')
    }
  }

  class FakeTray {
    private destroyed = false

    constructor(readonly image: Electron.NativeImage | string) {
      events.push(`tray:create:${String(image)}`)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    destroy(): void {
      this.destroyed = true
      events.push('tray:destroy')
    }
  }

  const menu = {
    closePopup() {
      events.push('menu:close')
    }
  }
  const electron = {
    BrowserWindow: FakeBrowserWindow,
    Tray: FakeTray,
    Menu: {
      buildFromTemplate(template: unknown[]) {
        events.push(`menu:create:${template.length}`)
        applicationMenu = menu
        return menu
      },
      getApplicationMenu() {
        return applicationMenu
      },
      setApplicationMenu(nextMenu: object | null) {
        applicationMenu = nextMenu
        events.push('menu:unset')
      }
    },
    clipboard,
    shell
  } as unknown as KnowbookFullTrustServiceOptions['electron']

  await withServices(async ({ services }) => {
    assert.equal(services.desktop.electron, electron)
    assert.equal(services.desktop.clipboard, clipboard)
    assert.equal(services.desktop.shell, shell)

    services.desktop.createWindow({ show: false })
    services.desktop.createMenu([{ label: 'Plugin menu' }])
    services.desktop.createTray('plugin-icon.png')
    assert.deepEqual(
      lifecycle.map((entry) => entry.label),
      ['AI requests', 'Electron BrowserWindow', 'Electron Menu', 'Electron Tray']
    )

    for (const entry of [...lifecycle].reverse()) await entry.dispose()
    assert.deepEqual(events, [
      'window:create:false',
      'menu:create:1',
      'tray:create:plugin-icon.png',
      'tray:destroy',
      'menu:close',
      'menu:unset',
      'window:close'
    ])
    assert.equal(applicationMenu, null)
  }, fetch, {
    electron,
    registerDisposable(dispose, label) {
      lifecycle.push({ dispose, label })
    }
  })
})

test('Full Trust service RPC uses stable Main APIs for documents, databases, settings and AI', async () => {
  await withServices(async ({ services, events, notifications }) => {
    const identity = {
      pluginId: 'system.service.rpc',
      revisionHash: `sha256:${'c'.repeat(64)}`
    }
    const host = new SystemPluginServiceRpcHost({
      ...identity,
      methods: createKnowbookFullTrustServiceRpcMethods(services)
    })
    let sequence = 0
    const call = async <T>(method: string, params: SystemPluginServiceRpcJson = null): Promise<T> => {
      const response = await host.dispatch({
        type: SYSTEM_PLUGIN_SERVICE_RPC_REQUEST,
        protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
        ...identity,
        requestId: `rpc-${++sequence}`,
        method,
        params
      })
      assert.ok(response)
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      return response.result as T
    }

    const document = await call<{ id: string; title: string }>('documents.create', {
      title: 'Created over service RPC',
      blocks: [block('RPC body')]
    })
    assert.equal(document.title, 'Created over service RPC')
    assert.equal((await call<Array<{ id: string }>>('documents.list')).some(({ id }) => id === document.id), true)

    const database = await call<{ id: string }>('databases.create', {
      name: 'RPC database',
      description: 'Created from a service process'
    })
    const entity = await call<{ id: string; title: string }>('databases.create-entity', {
      databaseId: database.id,
      title: 'RPC entity',
      fieldValues: {}
    })
    assert.equal(entity.title, 'RPC entity')

    await call('settings.set', { key: 'system-plugin.rpc-setting', value: 'enabled' })
    assert.equal(
      await call<string>('settings.get', { key: 'system-plugin.rpc-setting' }),
      'enabled'
    )
    assert.equal(await call<string>('secrets.get-ai-api-key'), 'secret-key')
    const completion = await call<{ id: string }>('ai.complete', {
      messages: [{ role: 'user', content: 'RPC prompt' }]
    })
    assert.equal(completion.id, 'completion-1')

    assert.equal(events[0]?.type, 'document.created')
    assert.equal(events[0]?.originPluginId, 'system.service.rpc')
    assert.equal(events[0]?.correlationId, 'service-run-123')
    assert.equal(events[0]?.causationId, 'service-mutation-1')
    assert.ok(notifications.count >= 4)
  }, async () => new Response(JSON.stringify({ id: 'completion-1' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }), {
    workspaceEventContext: {
      originPluginId: 'system.service.rpc',
      correlationId: 'service-run-123',
      createCausationId: () => 'service-mutation-1'
    }
  })
})

function block(content: string) {
  return {
    type: 'paragraph',
    content,
    checked: false,
    depth: 0
  }
}

async function withServices(
  run: (input: {
    services: ReturnType<typeof createKnowbookFullTrustServices>
    events: WorkspaceEvent[]
    notifications: { count: number }
  }) => Promise<void>,
  fetchImplementation: typeof fetch = fetch,
  overrides: {
    electron?: KnowbookFullTrustServiceOptions['electron']
    environment?: NodeJS.ProcessEnv
    registerDisposable?: KnowbookFullTrustServiceOptions['registerDisposable']
    workspaceEventContext?: KnowbookFullTrustServiceOptions['workspaceEventContext']
  } = {}
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-system-plugin-services-'))
  const store = new KnowbookStore(join(directory, 'knowbook.db'))
  const eventBus = new WorkspaceEventBus()
  const events: WorkspaceEvent[] = []
  const notifications = { count: 0 }
  eventBus.subscribe((event) => {
    events.push(event)
  })
  try {
    const services = createKnowbookFullTrustServices({
      store,
      sqlite: store.getUnsafeDatabaseHandle(),
      workspaceEventBus: eventBus,
      workspaceEventContext: overrides.workspaceEventContext,
      electron: overrides.electron ?? ({} as KnowbookFullTrustServiceOptions['electron']),
      getMainWindow: () => null,
      getAiCredentials: () => ({
        enabled: true,
        apiKey: 'secret-key',
        baseUrl: 'https://ai.example.test/v1',
        model: 'test-model'
      }),
      fetchImplementation,
      environment: overrides.environment,
      registerDisposable: overrides.registerDisposable,
      notifyWorkspaceMutation: () => {
        notifications.count += 1
      },
      paths: {
        userData: directory,
        appData: directory,
        documents: directory,
        downloads: directory,
        temp: directory
      }
    })
    await run({ services, events, notifications })
  } finally {
    store.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
}
