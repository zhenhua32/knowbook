import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { WorkspaceEventBus } from '../src/main/event-bus'
import { inspectSystemPluginArtifact } from '../src/main/system-plugin-artifact'
import { SystemPluginHost } from '../src/main/system-plugin/host'
import { createKnowbookFullTrustServices, type KnowbookFullTrustServiceOptions } from '../src/main/system-plugin/knowbook-services'
import type { FullTrustRendererPluginInitializer, SystemPluginServiceRpcJson } from '../src/shared/system-plugin-sdk'

type Json = SystemPluginServiceRpcJson
type Handler = (input: Json) => Json | Promise<Json>

async function withActivityPulse(operation: (fixture: {
  store: KnowbookStore
  bus: WorkspaceEventBus
  host: SystemPluginHost<ReturnType<typeof createKnowbookFullTrustServices>>
  services: ReturnType<typeof createKnowbookFullTrustServices>
  call(method: string, input?: Json): Promise<Json>
  restart(): Promise<void>
  listeners: Set<() => void>
  renderer: FullTrustRendererPluginInitializer
}) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-v3-activity-pulse-'))
  const runtime = join(directory, 'runtime')
  const dataRoot = join(directory, 'data')
  const store = new KnowbookStore(join(directory, 'knowbook.db'))
  const bus = new WorkspaceEventBus()
  const handlers = new Map<string, Handler>()
  const listeners = new Set<() => void>()
  let host: SystemPluginHost<ReturnType<typeof createKnowbookFullTrustServices>> | undefined
  try {
    cpSync(resolve('plugins/activity-pulse'), runtime, { recursive: true })
    mkdirSync(dataRoot)
    const artifact = await inspectSystemPluginArtifact(runtime)
    assert.equal(artifact.manifest.schemaVersion, 3)
    assert.equal(artifact.manifest.trust, 'full')
    assert.deepEqual(artifact.manifest.entries, { main: 'main.cjs', renderer: 'renderer.cjs' })
    const createHost = () => new SystemPluginHost({
      plugin: { id: artifact.manifest.id, version: artifact.manifest.version, revisionHash: artifact.artifactId },
      pluginRoot: runtime, dataRoot, mainEntry: 'main.cjs',
      createServices(bindings) {
        return createKnowbookFullTrustServices({
          store, sqlite: store.getUnsafeDatabaseHandle(), workspaceEventBus: bus,
          electron: {} as KnowbookFullTrustServiceOptions['electron'], getMainWindow: () => null,
          getAiCredentials: () => ({ enabled: false, apiKey: null, baseUrl: '', model: '' }),
          notifyWorkspaceMutation: () => { for (const listener of listeners) listener() },
          registerDisposable: bindings.registerDisposable,
          paths: { userData: directory, appData: directory, documents: directory, downloads: directory, temp: directory },
          workspaceEventContext: { originPluginId: 'activity-pulse', correlationId: 'activity-pulse-test' },
          renderer: {
            handle(method, handler) {
              assert.equal(handlers.has(method), false)
              handlers.set(method, handler)
              const dispose = () => { handlers.delete(method) }
              return dispose
            }
          }
        })
      }
    })
    host = createHost()
    store.saveSetting('plugin.setting.activity-pulse.summary-prefix', '迁移前缀：')
    await host.activate()
    assert.ok(host.context)
    await operation({
      store, bus, host, services: host.context,
      call: async (method, input) => {
        const handler = handlers.get(method)
        assert.ok(handler, `Main handler ${method} is available`)
        return handler(input ?? null)
      },
      restart: async () => {
        await host!.deactivate()
        host = createHost()
        await host.activate()
      },
      listeners,
      renderer: createRequire(import.meta.url)(join(runtime, 'renderer.cjs')) as FullTrustRendererPluginInitializer
    })
    await host.deactivate()
    assert.equal(handlers.size, 0)
  } finally {
    await host?.deactivate().catch(() => undefined)
    store.destroy()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

test('Activity Pulse v3 preserves settings and updates real documents, events, and lifecycle cleanup', async () => {
  await withActivityPulse(async ({ store, bus, host, services, call, restart }) => {
    assert.deepEqual(await call('get-state'), { summaryPrefix: '迁移前缀：', activity: null })
    await call('set-summary-prefix', { prefix: '摘要： ' })
    const document = await services.documents.create({ title: '活动测试', summary: '原摘要' })
    const content = `  First\n content\t${'x'.repeat(100)}  `
    await services.documents.update(document.id, {
      title: document.title, summary: document.summary,
      blocks: document.blocks.map((block, index) => ({ ...block, content: index === 0 ? ' \n ' : content }))
    })
    const events: Array<{ type: string; originPluginId?: string }> = []
    const stop = bus.subscribe((event) => { events.push(event) })
    assert.deepEqual(await call('summary-from-first-block', { documentId: document.id }), {
      message: '已从首个非空内容块更新摘要。', refreshDocument: true
    })
    assert.equal(services.documents.get(document.id)?.summary, `摘要： ${content.trim().replace(/\s+/g, ' ').slice(0, 80)}`)
    assert.ok(events.some((event) => event.type === 'document.updated' && event.originPluginId === 'activity-pulse'))
    assert.equal((await call('get-state') as { activity: { documentTitle: string } }).activity.documentTitle, '活动测试')
    await assert.rejects(call('summary-from-first-block', { documentId: 'missing' }), /文档不存在/)
    await assert.rejects(call('set-summary-prefix', { prefix: 3 }), /must be a string/)
    await assert.rejects(call('set-summary-prefix', { prefix: 'x'.repeat(1_001) }), /1000/)
    await services.documents.update(document.id, {
      title: document.title, summary: '保留摘要', blocks: document.blocks.map((block) => ({ ...block, content: ' \n ' }))
    })
    assert.deepEqual(await call('summary-from-first-block', { documentId: document.id }), {
      message: '没有找到非空内容块，原摘要已保留。', refreshDocument: false
    })
    assert.equal(services.documents.get(document.id)?.summary, '保留摘要')
    stop()
    await host.deactivate()
    const observed = store.getSettingPublic('activity-pulse.latest-activity')
    await bus.emit({ type: 'document.created', createdAt: new Date().toISOString(), documentId: 'ignored', documentTitle: '停用后', path: '停用后', parentId: null })
    assert.equal(store.getSettingPublic('activity-pulse.latest-activity'), observed)
    await restart()
    assert.equal((await call('get-state') as { summaryPrefix: string }).summaryPrefix, '摘要： ')
  })
})

test('Activity Pulse v3 renders live slots, invokes Main actions, and removes subscriptions and styles', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="mount"></div></body></html>', { pretendToBeVisual: true })
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const key of keys) Object.defineProperty(globalThis, key, {
    configurable: true, writable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key]
  })
  try {
    const { act, createElement, Fragment } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { FullTrustPluginRegistry } = await import('../src/renderer/src/full-trust-plugin-registry')
    await withActivityPulse(async ({ services, call, listeners, renderer }) => {
      const registry = new FullTrustPluginRegistry()
      Object.defineProperty(dom.window, 'knowbook', { configurable: true, value: {
        onWorkspaceMutated(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) }
      } })
      const identity = { id: 'activity-pulse', version: '1.0.0', revisionHash: 'sha256:activity-test' }
      const document = await services.documents.create({ title: 'Renderer 文档', blocks: [{ type: 'text', content: '测试正文', checked: false, depth: 0 }] })
      await registry.activatePlugin(identity, (api) => renderer({ ...api, invokeMain: call }))
      await registry.commitPlugin(identity.id, identity.revisionHash)
      assert.equal(listeners.size, 1)
      const mount = dom.window.document.querySelector('#mount')!
      const root = createRoot(mount)
      try {
        const slots = ['workspace.dashboard', 'documents.header.actions', 'settings.sections'] as const
        const contributions = slots.flatMap((slot) => [...registry.getSlotContributions(slot)])
        assert.equal(contributions.length, 3)
        await act(async () => root.render(createElement(Fragment, null, ...contributions.map((item) => createElement(item.component, {
          key: item.id, plugin: item.plugin, slot: item.slot, context: { documentId: document.id }
        })))))
        assert.match(mount.textContent ?? '', /创建了“Renderer 文档”/)
        assert.equal(mount.querySelector('input')?.value, '迁移前缀：')
        const action = mount.querySelector<HTMLButtonElement>('[data-testid="activity-pulse-action"] button')!
        await act(async () => { action.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
        assert.equal(services.documents.get(document.id)?.summary, '迁移前缀：测试正文')
        assert.match(mount.textContent ?? '', /已从首个非空内容块更新摘要/)
        assert.match(mount.textContent ?? '', /保存了“Renderer 文档”/)
        await act(async () => {
          await call('set-summary-prefix', { prefix: '新版：' })
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
        assert.equal(mount.querySelector('input')?.value, '新版：')
      } finally {
        await act(async () => root.unmount())
        await registry.deactivateAll()
      }
      assert.equal(listeners.size, 0)
      assert.equal(registry.getSlotContributions('workspace.dashboard').length, 0)
      assert.equal(dom.window.document.querySelector('style[data-full-trust-style="activity-pulse-style"]'), null)
    })
  } finally {
    for (const key of [...keys].reverse()) {
      const descriptor = previous.get(key)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
