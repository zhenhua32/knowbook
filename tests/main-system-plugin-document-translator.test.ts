import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { KnowbookStore } from '../src/main/database/store'
import { WorkspaceEventBus } from '../src/main/event-bus'
import { inspectSystemPluginArtifact } from '../src/main/system-plugin-artifact'
import { SystemPluginHost } from '../src/main/system-plugin/host'
import { createKnowbookFullTrustServices, type KnowbookFullTrustServiceOptions } from '../src/main/system-plugin/knowbook-services'
import type { FullTrustRendererPluginInitializer, SystemPluginServiceRpcJson } from '../src/shared/system-plugin-sdk'
import { parseMarkdownTable } from '../src/shared/markdownTable'

type Json = SystemPluginServiceRpcJson
type Item = { id: string; text: string }
type State = {
  aiReady: boolean
  model: string
  job: null | {
    id: string; documentId: string; sourceTitle: string; mode: string; status: string
    completed: number; total: number; resultId: string | null; error: string | null
  }
}
type Request = { items: Item[]; signal: AbortSignal; headers: Headers; body: Record<string, unknown> }

const words: Record<string, string> = {
  Guide: '指南', Summary: '摘要', Hello: '你好', World: '世界', Parent: '父项', Child: '子项',
  Name: '名称', Value: '值', See: '参见', word: '词'
}
function responseFor(items: Item[]): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
    translations: items.map(({ id, text }) => ({ id, text: text.replace(/Guide|Summary|Hello|World|Parent|Child|Name|Value|See|word/g, (word) => words[word]) }))
  }) } }] }), { headers: { 'Content-Type': 'application/json' } })
}

async function withTranslator(operation: (fixture: {
  store: KnowbookStore
  bus: WorkspaceEventBus
  services: ReturnType<typeof createKnowbookFullTrustServices>
  call(method: string, input?: Json): Promise<State>
  rawCall(method: string, input?: Json): Promise<Json>
  settled(): Promise<State>
  stop(): Promise<void>
  requests: Request[]
  listeners: Set<() => void>
  renderer: FullTrustRendererPluginInitializer
  configure(update: Partial<{ enabled: boolean; apiKey: string | null; model: string; baseUrl: string }>): void
}) => Promise<void>, respond: (request: Request) => Response | Promise<Response> = ({ items }) => responseFor(items)): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-v3-translator-'))
  const runtime = join(directory, 'runtime')
  const dataRoot = join(directory, 'data')
  const store = new KnowbookStore(join(directory, 'knowbook.db'))
  const bus = new WorkspaceEventBus()
  const handlers = new Map<string, (input: Json) => Json | Promise<Json>>()
  const listeners = new Set<() => void>()
  const requests: Request[] = []
  const credentials = { enabled: true, apiKey: 'test-private-key' as string | null, model: 'test-model', baseUrl: 'https://ai.example.invalid/v1' }
  let host: SystemPluginHost<ReturnType<typeof createKnowbookFullTrustServices>> | undefined
  try {
    cpSync(resolve('plugins/document-translator'), runtime, { recursive: true })
    mkdirSync(dataRoot)
    const artifact = await inspectSystemPluginArtifact(runtime)
    assert.equal(artifact.manifest.id, 'document-translator')
    assert.equal(artifact.manifest.schemaVersion, 3)
    assert.equal(artifact.manifest.trust, 'full')
    assert.deepEqual(artifact.manifest.entries, { main: 'main.cjs', renderer: 'renderer.cjs' })
    host = new SystemPluginHost({
      plugin: { id: artifact.manifest.id, version: artifact.manifest.version, revisionHash: artifact.artifactId },
      pluginRoot: runtime, dataRoot, mainEntry: 'main.cjs',
      createServices(bindings) {
        return createKnowbookFullTrustServices({
          store, sqlite: store.getUnsafeDatabaseHandle(), workspaceEventBus: bus,
          electron: {} as KnowbookFullTrustServiceOptions['electron'], getMainWindow: () => null,
          getAiCredentials: () => credentials,
          fetchImplementation: async (_url, init) => {
            const body = JSON.parse(String(init!.body)) as Record<string, unknown>
            const messages = body.messages as Array<{ role: string; content: string }>
            assert.equal(messages[0].role, 'system')
            const items = (JSON.parse(messages[1].content) as { translations: Item[] }).translations
            const request = { items, signal: init!.signal!, headers: new Headers(init!.headers), body }
            requests.push(request)
            return respond(request)
          },
          notifyWorkspaceMutation: () => { for (const listener of listeners) listener() },
          registerDisposable: bindings.registerDisposable,
          paths: { userData: directory, appData: directory, documents: directory, downloads: directory, temp: directory },
          workspaceEventContext: { originPluginId: 'document-translator', correlationId: 'translator-test' },
          renderer: { handle(method, handler) { handlers.set(method, handler); return () => { handlers.delete(method) } } }
        })
      }
    })
    await host.activate()
    assert.equal(host.status, 'active')
    assert.ok(host.context)
    const rawCall = async (method: string, input?: Json): Promise<Json> => {
      const handler = handlers.get(method)
      assert.ok(handler, `${method} is registered`)
      return handler(input ?? null)
    }
    const call = async (method: string, input?: Json) => await rawCall(method, input) as unknown as State
    await operation({
      store, bus, services: host.context, call, rawCall, requests, listeners,
      renderer: createRequire(import.meta.url)(join(runtime, 'renderer.cjs')) as FullTrustRendererPluginInitializer,
      configure(update) { Object.assign(credentials, update); for (const listener of listeners) listener() },
      async settled() {
        for (let attempt = 0; attempt < 100; attempt++) {
          const state = await call('get-state')
          if (state.job && !['running', 'saving'].includes(state.job.status)) return state
          await nextTurn()
        }
        throw new Error('Translation did not settle')
      },
      async stop() { await host!.deactivate(); assert.equal(handlers.size, 0) }
    })
  } finally {
    await host?.deactivate().catch(() => undefined)
    store.destroy()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

test('document translator creates Chinese and bilingual siblings through v3 services without changing the source', async () => {
  await withTranslator(async ({ services, bus, call, settled, requests }) => {
    const parent = await services.documents.create({ title: 'Folder' })
    const source = await services.documents.create({ parentId: parent.id, title: 'Guide', summary: 'Summary', blocks: [
      { type: 'heading-1', content: 'Guide', checked: false, depth: 0 },
      { type: 'paragraph', content: 'Hello `World` $x+y$ [See](Other.md) ![image](file:///image.png) [[Other]]', checked: false, depth: 0, tags: ['keep'], highlight: 'yellow' },
      { id: 'source-parent', type: 'numbered-todo', content: 'Parent', checked: true, depth: 0, listStart: 3, markdownFormat: { listMarker: ')', listLoose: true } },
      { id: 'source-child', type: 'bulleted-list', content: 'Child', checked: false, depth: 1, parentBlockId: 'source-parent' },
      { type: 'table', content: '| Name | Value |\n| --- | --- |\n| Hello | 1 |', checked: false, depth: 0 },
      { type: 'code', content: 'const Hello = "World";', language: 'javascript', markdownFormat: { codeInfo: 'javascript example' }, checked: false, depth: 0 },
      { type: 'math', content: 'x = 2', checked: false, depth: 0 },
      { type: 'frontmatter', content: 'title: Hello', checked: false, depth: 0 },
      { type: 'custom-widget', content: 'Hello widget', checked: false, depth: 0 },
      { type: 'paragraph', content: '已经是中文', checked: false, depth: 0 }
    ] })
    const events: Array<{ type: string; originPluginId?: string }> = []
    const unsubscribe = bus.subscribe((event) => { events.push(event) })
    const before = services.documents.list().length
    await call('start-translation', { documentId: source.id, mode: 'chinese' })
    const chinese = await settled()
    assert.equal(chinese.job?.status, 'completed', chinese.job?.error ?? '')
    const translated = services.documents.get(chinese.job!.resultId!)!
    assert.equal(translated.title, '指南（中文）')
    assert.equal(translated.summary, '摘要')
    assert.equal(services.documents.list().find((entry) => entry.id === translated.id)?.parentId, parent.id)
    assert.equal(translated.blocks.length, source.blocks.length)
    assert.equal(translated.blocks[1].content, '你好 `World` $x+y$ [See](Other.md) ![image](file:///image.png) [[Other]]')
    assert.deepEqual(translated.blocks[1].tags, ['keep'])
    assert.equal(translated.blocks[1].highlight, 'yellow')
    assert.equal(translated.blocks[2].checked, true)
    assert.equal(translated.blocks[2].listStart, 3)
    assert.deepEqual(translated.blocks[2].markdownFormat, source.blocks[2].markdownFormat)
    assert.equal(translated.blocks[3].parentBlockId, translated.blocks[2].id)
    assert.ok(parseMarkdownTable(translated.blocks[4].content))
    for (const index of [5, 6, 7, 8]) assert.equal(translated.blocks[index].content, source.blocks[index].content)
    assert.equal(translated.blocks[5].language, 'javascript')
    assert.deepEqual(translated.blocks[5].markdownFormat, source.blocks[5].markdownFormat)
    assert.ok(translated.blocks.every((block) => !source.blocks.some((original) => block.id === original.id)))
    assert.deepEqual(services.documents.get(source.id), source)
    assert.equal(services.documents.list().length, before + 1)
    assert.ok(events.some((event) => event.type === 'document.created' && event.originPluginId === 'document-translator'))
    assert.equal(requests[0].headers.get('Authorization'), 'Bearer test-private-key')
    assert.equal(requests[0].body.model, 'test-model')
    assert.doesNotMatch(JSON.stringify(await call('get-state')), /test-private-key|const Hello/)

    await call('start-translation', { documentId: source.id, mode: 'bilingual' })
    const bilingualJob = (await settled()).job!
    assert.equal(bilingualJob.status, 'completed', bilingualJob.error ?? '')
    const bilingual = services.documents.get(bilingualJob.resultId!)!
    assert.equal(bilingual.title, 'Guide（双语对照）')
    assert.equal(bilingual.summary, 'Summary\n\n摘要')
    assert.equal(bilingual.blocks[0].content, 'Guide / 指南')
    assert.equal(bilingual.blocks[1].content, source.blocks[1].content)
    assert.equal(bilingual.blocks[2].content, translated.blocks[1].content)
    assert.equal(bilingual.blocks[3].content, 'Parent\n\n父项')
    assert.equal(bilingual.blocks[4].content, 'Child\n\n子项')
    assert.equal(bilingual.blocks[4].parentBlockId, bilingual.blocks[3].id)
    assert.ok(parseMarkdownTable(bilingual.blocks[5].content))
    assert.ok(parseMarkdownTable(bilingual.blocks[6].content))
    assert.equal(bilingual.blocks.filter((block) => block.type === 'code').length, 1)
    assert.equal(bilingual.blocks.filter((block) => block.content === '已经是中文').length, 1)
    assert.deepEqual(services.documents.get(source.id), source)
    unsubscribe()
  })
})

test('document translator splits long Unicode text and preserves protected syntax and whitespace across batches', async () => {
  await withTranslator(async ({ services, call, settled, requests }) => {
    const content = `  ${'Hello 😀 '.repeat(1_700)}\n\nSee \`Hello\` [See](../Guide.md)  `
    const source = await services.documents.create({ title: 'Guide', blocks: [{ type: 'paragraph', content, checked: false, depth: 0 }] })
    await call('start-translation', { documentId: source.id, mode: 'chinese' })
    const state = await settled()
    assert.equal(state.job?.status, 'completed', state.job?.error ?? '')
    assert.ok(requests.length > 1)
    for (const request of requests) {
      assert.ok(request.items.reduce((sum, item) => sum + item.text.length, 0) <= 6_000)
      assert.ok(request.items.every((item) => item.text.length <= 3_000 && !/[\uD800-\uDBFF]$/.test(item.text)))
    }
    const result = services.documents.get(state.job!.resultId!)!
    assert.equal(result.blocks[0].content, `  ${'你好 😀 '.repeat(1_700)}\n\n参见 \`Hello\` [See](../Guide.md)  `)
    assert.equal(state.job?.completed, state.job?.total)
  })
})

test('document translator rejects invalid requests and missing AI configuration before making network requests', async () => {
  await withTranslator(async ({ services, call, requests, configure }) => {
    const source = await services.documents.create({ title: 'Guide', blocks: [{ type: 'paragraph', content: 'Hello', checked: false, depth: 0 }] })
    await assert.rejects(call('start-translation', { documentId: source.id, mode: 'replace' }), /中文翻译或双语/)
    await assert.rejects(call('start-translation', { documentId: 3, mode: 'chinese' }), /documentId/)
    await assert.rejects(call('start-translation', { documentId: 'missing', mode: 'chinese' }), /不存在/)
    for (const change of [{ enabled: false }, { apiKey: null }, { model: '' }, { baseUrl: '' }]) {
      configure(change)
      assert.equal((await call('get-state')).aiReady, false)
      await assert.rejects(call('start-translation', { documentId: source.id, mode: 'chinese' }), /启用 AI/)
      configure({ enabled: true, apiKey: 'test-private-key', model: 'test-model', baseUrl: 'https://ai.example.invalid/v1' })
    }
    await services.documents.update(source.id, { title: source.title, summary: '', blocks: [] })
    await assert.rejects(call('start-translation', { documentId: source.id, mode: 'chinese' }), /正文为空/)
    assert.equal(requests.length, 0)
  })
})

test('document translator rejects malformed, incomplete and truncated responses without creating partial documents', async () => {
  for (const kind of ['json', 'missing', 'duplicate', 'empty', 'markers', 'truncated', 'http', 'timeout']) {
    await withTranslator(async ({ services, call, settled }) => {
      const source = await services.documents.create({ title: 'Guide', blocks: [
        { type: 'paragraph', content: 'Hello `World`', checked: false, depth: 0 }
      ] })
      const count = services.documents.list().length
      await call('start-translation', { documentId: source.id, mode: 'chinese' })
      const state = await settled()
      assert.equal(state.job?.status, 'failed', kind)
      assert.ok(state.job?.error)
      assert.doesNotMatch(JSON.stringify(state), /test-private-key/)
      assert.equal(services.documents.list().length, count, kind)
      assert.deepEqual(services.documents.get(source.id), source)
    }, async ({ items }) => {
      if (kind === 'timeout') throw new DOMException('Request timed out', 'TimeoutError')
      if (kind === 'http') return new Response('test-private-key', { status: 401 })
      const translations = items.map((item) => ({ ...item }))
      if (kind === 'missing') translations.pop()
      if (kind === 'duplicate') translations[1] = translations[0]
      if (kind === 'empty') translations[0].text = ''
      if (kind === 'markers') translations.find((item) => item.text.includes('⟦KB:'))!.text = '你好，丢失了代码'
      return new Response(JSON.stringify({ choices: [{ finish_reason: kind === 'truncated' ? 'length' : 'stop', message: {
        content: kind === 'json' ? 'not json' : JSON.stringify({ translations })
      } }] }))
    })
  }
})

test('document translator keeps successful earlier batches in memory when a later batch fails', async () => {
  let responses = 0
  await withTranslator(async ({ services, call, settled }) => {
    const source = await services.documents.create({ title: 'Guide', summary: '', blocks: [
      { type: 'paragraph', content: 'Hello '.repeat(2_000), checked: false, depth: 0 }
    ] })
    const count = services.documents.list().length
    await call('start-translation', { documentId: source.id, mode: 'chinese' })
    const state = await settled()
    assert.equal(state.job?.status, 'failed')
    assert.equal(state.job?.completed, 1)
    assert.equal(responses, 2)
    assert.equal(services.documents.list().length, count)
    assert.deepEqual(services.documents.get(source.id), source)
  }, ({ items }) => ++responses === 1 ? responseFor(items) : new Response('{}'))
})

test('document translator cancels promptly, rejects concurrent jobs, and ignores late AI responses', async () => {
  let release: (() => void) | undefined
  await withTranslator(async ({ services, call, requests }) => {
    const source = await services.documents.create({ title: 'Guide' })
    const before = services.documents.list().length
    const started = await call('start-translation', { documentId: source.id, mode: 'bilingual' })
    assert.equal(started.job?.status, 'running')
    await assert.rejects(call('start-translation', { documentId: source.id, mode: 'chinese' }), /已有翻译任务/)
    await call('cancel-translation', { jobId: 'stale-job' })
    assert.equal(requests[0].signal.aborted, false)
    const cancelled = await call('cancel-translation', { jobId: started.job!.id })
    assert.equal(cancelled.job?.status, 'cancelled')
    assert.equal(requests[0].signal.aborted, true)
    release!()
    await nextTurn()
    assert.equal(services.documents.list().length, before)
    assert.equal((await call('get-state')).job?.status, 'cancelled')
  }, ({ items }) => new Promise((resolve) => { release = () => resolve(responseFor(items)) }))
})

test('document translator aborts on deactivation and refuses to save after source edits or deletion', async () => {
  for (const action of ['stop', 'edit', 'delete']) {
    let release: (() => void) | undefined
    await withTranslator(async ({ services, call, settled, stop, requests }) => {
      const source = await services.documents.create({ title: 'Guide' })
      const before = services.documents.list().length
      await call('start-translation', { documentId: source.id, mode: 'chinese' })
      if (action === 'stop') { await stop(); assert.equal(requests[0].signal.aborted, true) }
      else if (action === 'edit') await services.documents.update(source.id, { title: 'Edited', summary: '', blocks: source.blocks })
      else await services.documents.delete(source.id)
      release!()
      await nextTurn()
      if (action !== 'stop') {
        const state = await settled()
        assert.equal(state.job?.status, 'failed')
        assert.match(state.job?.error ?? '', /原文/)
      }
      assert.equal(services.documents.list().length, before - (action === 'delete' ? 1 : 0))
    }, ({ items }) => new Promise((resolve) => { release = () => resolve(responseFor(items)) }))
  }
})

test('document translator keeps progress and results in host notifications across menu unmounts', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="mount"></div></body></html>', { pretendToBeVisual: true })
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const key of keys) Object.defineProperty(globalThis, key, {
    configurable: true, writable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key]
  })
  let release: (() => void) | undefined
  try {
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { FullTrustPluginRegistry } = await import('../src/renderer/src/full-trust-plugin-registry')
    const { appNotifications } = await import('../src/renderer/src/app-notifications')
    await withTranslator(async ({ services, call, rawCall, settled, renderer, listeners, configure }) => {
      const source = await services.documents.create({ title: 'Guide', blocks: [{ type: 'paragraph', content: 'Hello', checked: false, depth: 0 }] })
      Object.defineProperty(dom.window, 'knowbook', { configurable: true, value: {
        onWorkspaceMutated(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) }
      } })
      const registry = new FullTrustPluginRegistry()
      const identity = { id: 'document-translator', version: '1.0.0', revisionHash: 'sha256:translation-test' }
      await registry.activatePlugin(identity, (api) => renderer({ ...api, invokeMain: rawCall }))
      await registry.commitPlugin(identity.id, identity.revisionHash)
      const mount = dom.window.document.querySelector('#mount')!
      const root = createRoot(mount)
      assert.equal(registry.getSlotContributions('documents.header.actions').length, 0)
      const contribution = registry.getSlotContributions('documents.header.menu')[0]
      const render = (documentId?: string) => root.render(createElement(contribution.component, {
        plugin: contribution.plugin, slot: contribution.slot, context: documentId ? { documentId } : undefined
      }))
      const button = (text: string) => [...mount.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!
      const latest = () => appNotifications.getSnapshot().at(-1)!
      try {
        assert.equal(listeners.size, 1)
        await act(async () => render())
        assert.equal(button('翻译成中文').disabled, true)
        await act(async () => render(source.id))
        await act(async () => { configure({ enabled: false }); await nextTurn() })
        assert.match(button('翻译成中文').title, /启用 AI/)
        assert.equal(button('生成双语对照').disabled, true)
        await act(async () => { configure({ enabled: true }); await nextTurn() })
        await act(async () => { button('翻译成中文').click(); await nextTurn() })
        assert.equal((await call('get-state')).job?.mode, 'chinese')
        assert.equal(mount.querySelector('progress'), null)
        assert.equal(latest().level, 'progress')
        assert.equal(appNotifications.getSnapshot().length, 1)
        assert.equal(button('生成双语对照').disabled, true)
        // Closing the menu unmounts its contribution, but the job keeps running.
        await act(async () => root.render(null))
        assert.equal((await call('get-state')).job?.status, 'running')
        assert.equal(latest().level, 'progress')
        await act(async () => render(source.id))
        assert.equal(mount.querySelector('progress'), null)
        assert.equal(button('取消翻译'), undefined)
        assert.equal(latest().actions?.[0].disabled, false)
        await act(async () => { release!(); await settled(); await nextTurn() })
        // Saving emits a workspace mutation, which updates the same notification.
        await act(async () => { for (const listener of listeners) listener(); await nextTurn() })
        assert.doesNotMatch(mount.textContent ?? '', /已生成/)
        assert.equal(appNotifications.getSnapshot().length, 1)
        assert.equal(latest().level, 'success')
        assert.match(latest().message ?? '', /已生成「指南（中文）/)
        assert.deepEqual(latest().actions, [{ label: '打开译文', documentId: (await call('get-state')).job?.resultId }])
        appNotifications.dismiss(latest().id)
        await act(async () => { for (const listener of listeners) listener(); await nextTurn() })
        assert.equal(appNotifications.getSnapshot().length, 0)
        await act(async () => { button('生成双语对照').click(); await nextTurn() })
        assert.equal((await call('get-state')).job?.mode, 'bilingual')
        const cancel = latest().actions![0]
        assert.ok('run' in cancel)
        await act(async () => { await cancel.run(); release!(); await nextTurn() })
        assert.match(latest().title, /已取消/)
        assert.doesNotMatch(mount.textContent ?? '', /已取消/)
      } finally {
        await act(async () => root.unmount())
        await registry.deactivateAll()
      }
      assert.equal(listeners.size, 0)
      assert.equal(appNotifications.getSnapshot().length, 0)
      assert.equal(registry.getSlotContributions('documents.header.menu').length, 0)
      assert.equal(dom.window.document.querySelector('style[data-full-trust-style="document-translator-style"]'), null)
    }, ({ items }) => new Promise((resolve) => { release = () => resolve(responseFor(items)) }))
  } finally {
    for (const key of [...keys].reverse()) {
      const descriptor = previous.get(key)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
