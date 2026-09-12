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
type ThemeCatalog = {
  themes: Array<{ id: string; name: string; description: string; mode: 'light' | 'dark'; colors: Record<string, string> }>
  css: string
}

const settingKey = 'theme-switcher.selected-theme'
const themeAttribute = 'data-knowbook-theme-switcher'

async function withThemeSwitcher(operation: (fixture: {
  store: KnowbookStore
  call(method: string, input?: Json): Promise<Json>
  restart(): Promise<void>
  listeners: Set<() => void>
  renderer: FullTrustRendererPluginInitializer
}) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-v3-theme-switcher-'))
  const runtime = join(directory, 'runtime')
  const dataRoot = join(directory, 'data')
  const store = new KnowbookStore(join(directory, 'knowbook.db'))
  const handlers = new Map<string, Handler>()
  const listeners = new Set<() => void>()
  let host: SystemPluginHost<ReturnType<typeof createKnowbookFullTrustServices>> | undefined
  try {
    cpSync(resolve('plugins/theme-switcher'), runtime, { recursive: true })
    mkdirSync(dataRoot)
    const artifact = await inspectSystemPluginArtifact(runtime)
    assert.equal(artifact.manifest.schemaVersion, 3)
    assert.equal(artifact.manifest.trust, 'full')
    assert.equal(artifact.manifest.id, 'theme-switcher')
    assert.deepEqual(artifact.manifest.entries, { main: 'main.cjs', renderer: 'renderer.cjs' })
    const createHost = () => new SystemPluginHost({
      plugin: { id: artifact.manifest.id, version: artifact.manifest.version, revisionHash: artifact.artifactId },
      pluginRoot: runtime, dataRoot, mainEntry: 'main.cjs',
      createServices(bindings) {
        return createKnowbookFullTrustServices({
          store, sqlite: store.getUnsafeDatabaseHandle(), workspaceEventBus: new WorkspaceEventBus(),
          electron: {} as KnowbookFullTrustServiceOptions['electron'], getMainWindow: () => null,
          getAiCredentials: () => ({ enabled: false, apiKey: null, baseUrl: '', model: '' }),
          notifyWorkspaceMutation: () => { for (const listener of listeners) listener() },
          registerDisposable: bindings.registerDisposable,
          paths: { userData: directory, appData: directory, documents: directory, downloads: directory, temp: directory },
          workspaceEventContext: { originPluginId: 'theme-switcher', correlationId: 'theme-switcher-test' },
          renderer: {
            handle(method, handler) {
              assert.equal(handlers.has(method), false)
              handlers.set(method, handler)
              return () => { handlers.delete(method) }
            }
          }
        })
      }
    })
    // A custom theme must never overwrite the user's underlying host preference.
    store.setAppearanceTheme('dark')
    host = createHost()
    await host.activate()
    await operation({
      store, listeners,
      call: async (method, input) => {
        const handler = handlers.get(method)
        assert.ok(handler, `Main handler ${method} is available`)
        return handler(input ?? null)
      },
      restart: async () => {
        await host!.deactivate()
        assert.equal(handlers.size, 0)
        host = createHost()
        await host.activate()
      },
      renderer: createRequire(import.meta.url)(join(runtime, 'renderer.cjs')) as FullTrustRendererPluginInitializer
    })
    await host.deactivate()
    assert.equal(handlers.size, 0)
    assert.equal(store.getAppearanceTheme(), 'dark')
  } finally {
    await host?.deactivate().catch(() => undefined)
    store.destroy()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

test('Theme Switcher v3 validates presets and persists selection through Main lifecycle without changing host appearance', async () => {
  await withThemeSwitcher(async ({ store, call, restart }) => {
    assert.deepEqual(await call('get-state'), { selectedThemeId: 'default' })
    const catalog = await call('get-catalog') as ThemeCatalog
    assert.equal(catalog.themes.length, 6)
    assert.equal(new Set(catalog.themes.map((theme) => theme.id)).size, 6)
    assert.ok(catalog.themes.some((theme) => theme.mode === 'light'))
    assert.ok(catalog.themes.some((theme) => theme.mode === 'dark'))
    assert.match(catalog.css, /data-knowbook-theme-switcher/)
    for (const theme of catalog.themes) {
      assert.ok(theme.name && theme.description)
      assert.ok(Object.keys(theme.colors).length > 0)
      assert.notEqual(theme.id, 'default')
      assert.ok(catalog.css.includes(theme.id), `${theme.id} has a stylesheet`)
    }
    const selectedId = catalog.themes[0].id
    assert.deepEqual(await call('set-theme', { themeId: selectedId }), { selectedThemeId: selectedId })
    assert.equal(store.getSettingPublic(settingKey), selectedId)
    assert.equal(store.getAppearanceTheme(), 'dark')
    await restart()
    assert.deepEqual(await call('get-state'), { selectedThemeId: selectedId })

    const invalidInputs: Json[] = [null, [], {}, 'default', 1, { themeId: null }, { themeId: 42 }, { themeId: '' }, { themeId: 'unknown-preset' }]
    for (const input of invalidInputs) {
      await assert.rejects(call('set-theme', input))
      assert.deepEqual(await call('get-state'), { selectedThemeId: selectedId })
    }

    assert.deepEqual(await call('set-theme', { themeId: 'default' }), { selectedThemeId: 'default' })
    await restart()
    assert.deepEqual(await call('get-state'), { selectedThemeId: 'default' })
    store.saveSetting(settingKey, 'removed-preset')
    await restart()
    assert.deepEqual(await call('get-state'), { selectedThemeId: 'default' })
  })
})

test('Theme Switcher v3 applies React selections, preserves state on failed saves, and disposes renderer effects', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><head></head><body><div id="mount"></div></body></html>', { pretendToBeVisual: true })
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const key of keys) Object.defineProperty(globalThis, key, {
    configurable: true, writable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key]
  })
  try {
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { FullTrustPluginRegistry } = await import('../src/renderer/src/full-trust-plugin-registry')
    await withThemeSwitcher(async ({ store, call, listeners, renderer }) => {
      const catalog = await call('get-catalog') as ThemeCatalog
      const [firstTheme, secondTheme] = catalog.themes
      const registry = new FullTrustPluginRegistry()
      Object.defineProperty(dom.window, 'knowbook', { configurable: true, value: {
        onWorkspaceMutated(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) }
      } })
      const identity = { id: 'theme-switcher', version: '1.0.0', revisionHash: 'sha256:theme-test' }
      let failSave = false
      let pendingRefresh: Promise<Json> | undefined
      await registry.activatePlugin(identity, (api) => renderer({
        ...api,
        invokeMain: (method, input) => {
          if (method === 'set-theme' && failSave) return Promise.reject(new Error('模拟保存失败'))
          if (method === 'get-state' && pendingRefresh) return pendingRefresh
          return call(method, input)
        }
      }))
      await registry.commitPlugin(identity.id, identity.revisionHash)
      assert.equal(listeners.size, 1)
      assert.equal(dom.window.document.documentElement.getAttribute(themeAttribute), null)
      for (const style of ['theme-switcher-themes', 'theme-switcher-controls']) {
        assert.ok(dom.window.document.querySelector(`style[data-full-trust-style="${style}"]`))
      }
      const mount = dom.window.document.querySelector('#mount')!
      const root = createRoot(mount)
      const element = dom.window.document.documentElement
      const button = (id: string) => {
        const found = mount.querySelector<HTMLButtonElement>(`[data-testid="theme-option-${id}"]`)
        assert.ok(found, `${id} is selectable`)
        return found
      }
      const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
      try {
        const contributions = registry.getSlotContributions('settings.sections')
        assert.equal(contributions.length, 1)
        const item = contributions[0]
        await act(async () => root.render(createElement(item.component, { plugin: item.plugin, slot: item.slot, context: {} })))
        assert.ok(mount.querySelector('[data-testid="theme-switcher-settings"]'))
        assert.equal(button('default').getAttribute('aria-pressed'), 'true')
        for (const theme of catalog.themes) assert.equal(button(theme.id).getAttribute('aria-pressed'), 'false')

        await act(async () => { button(firstTheme.id).click(); await flush() })
        assert.equal(element.getAttribute(themeAttribute), firstTheme.id)
        assert.equal(button(firstTheme.id).getAttribute('aria-pressed'), 'true')
        assert.equal(store.getSettingPublic(settingKey), firstTheme.id)
        assert.equal(element.dataset.theme, 'dark')

        failSave = true
        await act(async () => { button(secondTheme.id).click(); await flush() })
        assert.match(mount.textContent ?? '', /模拟保存失败/)
        assert.equal(element.getAttribute(themeAttribute), firstTheme.id)
        assert.equal(button(firstTheme.id).getAttribute('aria-pressed'), 'true')
        assert.equal(store.getSettingPublic(settingKey), firstTheme.id)
        failSave = false

        await act(async () => { button('default').click(); await flush() })
        assert.equal(element.getAttribute(themeAttribute), null)
        assert.equal(button('default').getAttribute('aria-pressed'), 'true')
        assert.equal(element.dataset.theme, 'dark')

        await act(async () => { await call('set-theme', { themeId: secondTheme.id }); await flush() })
        assert.equal(element.getAttribute(themeAttribute), secondTheme.id)
        assert.equal(button(secondTheme.id).getAttribute('aria-pressed'), 'true')

        // In-flight workspace refreshes must not reapply CSS after the plugin stops.
        let resolveRefresh!: (value: Json) => void
        pendingRefresh = new Promise((resolve) => { resolveRefresh = resolve })
        await act(async () => {
          for (const listener of listeners) listener()
          await registry.deactivateAll()
          resolveRefresh({ selectedThemeId: firstTheme.id })
          await flush()
        })
        assert.equal(element.getAttribute(themeAttribute), null)
        assert.equal(element.dataset.theme, 'dark')
        assert.equal(listeners.size, 0)
        assert.equal(registry.getSlotContributions('settings.sections').length, 0)
        assert.equal(dom.window.document.querySelector('style[data-full-trust-plugin="theme-switcher"]'), null)

        await registry.activatePlugin(identity, (api) => renderer({ ...api, invokeMain: call }))
        await registry.commitPlugin(identity.id, identity.revisionHash)
        assert.equal(element.getAttribute(themeAttribute), secondTheme.id)
        assert.equal(element.dataset.theme, 'dark')
        assert.equal(listeners.size, 1)
      } finally {
        await act(async () => root.unmount())
        await registry.deactivateAll()
      }
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
