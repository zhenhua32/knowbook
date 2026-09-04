import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { PluginSlot } from '../src/renderer/src/components/PluginSlot.tsx'
import {
  FullTrustPluginRegistry,
  exposeFullTrustPluginRegistry,
  fullTrustPluginRegistry
} from '../src/renderer/src/full-trust-plugin-registry.ts'
import type { PluginUiContribution } from '../src/shared/plugin-ui.ts'

const contribution: PluginUiContribution = {
  owner: {
    pluginId: 'safe-plugin',
    revisionId: 'revision-1',
    runId: 'run-1',
    grantSetId: 'grant-1',
    scope: { kind: 'workspace', workspaceId: 'workspace-1' },
    epoch: 1
  },
  slot: 'workspace.dashboard',
  id: 'safe-view',
  order: 1,
  value: {
    kind: 'view',
    view: {
      version: 1,
      root: {
        type: 'stack',
        children: [
          { type: 'markdown', markdown: '<img src=x onerror=alert(1)>' },
          { type: 'button', label: 'Run', action: { handler: 'run' } },
          { type: 'progress', label: 'Done', value: 50 }
        ]
      }
    }
  }
}

test('PluginSlot renders ViewSpec as escaped host controls without arbitrary HTML', () => {
  const html = renderToStaticMarkup(<PluginSlot contributions={[contribution]} slot="workspace.dashboard" />)
  assert.match(html, /data-plugin-slot="workspace.dashboard"/)
  assert.match(html, /data-plugin-slot-version="1"/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.equal(html.includes('<img src=x'), false)
  assert.match(html, /<button[^>]*type="button"/)
  assert.match(html, /<progress[^>]*value="50"/)
})

test('PluginSlot appends registered Full Trust React contributions without changing v2 rendering', async () => {
  await fullTrustPluginRegistry.deactivateAll()
  try {
    let activationIdentity: unknown = null
    const api = await fullTrustPluginRegistry.activatePlugin({
      id: 'full-trust-renderer',
      version: '1.0.0',
      revisionHash: 'sha256:renderer-revision'
    }, (pluginApi) => {
      activationIdentity = fullTrustPluginRegistry.currentPlugin
      pluginApi.registerSlotContribution({
        id: 'dashboard-react',
        slot: 'workspace.dashboard',
        order: 10,
        component: ({ plugin, context }) => (
          <strong>{plugin.id}:{context?.documentId}</strong>
        )
      })
    })

    assert.deepEqual(activationIdentity, api.plugin)
    assert.equal(fullTrustPluginRegistry.currentPlugin, null)
    assert.equal(api.React.createElement, React.createElement)
    assert.equal(typeof api.ReactDOM.createPortal, 'function')
    assert.equal(typeof api.ReactDOMClient.createRoot, 'function')

    const html = renderToStaticMarkup(
      <PluginSlot
        context={{ documentId: 'document-1' }}
        contributions={[contribution]}
        slot="workspace.dashboard"
      />
    )
    assert.match(html, /data-plugin-contribution="safe-view"/)
    assert.match(html, /data-full-trust-plugin="full-trust-renderer"/)
    assert.match(html, /data-full-trust-plugin-revision="sha256:renderer-revision"/)
    assert.match(html, /full-trust-renderer:document-1/)

    await fullTrustPluginRegistry.deactivatePlugin('full-trust-renderer')
    const afterDeactivate = renderToStaticMarkup(
      <PluginSlot contributions={[]} slot="workspace.dashboard" />
    )
    assert.equal(afterDeactivate, '')
  } finally {
    await fullTrustPluginRegistry.deactivateAll()
  }
})

test('renderer bootstrap exposes the Full Trust registry as a fixed window API', () => {
  const target = {} as Window
  exposeFullTrustPluginRegistry(target)
  assert.equal(target.knowbookFullTrust, fullTrustPluginRegistry)
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, 'knowbookFullTrust'), {
    configurable: false,
    enumerable: true,
    writable: false,
    value: fullTrustPluginRegistry
  })
  const main = readFileSync(new URL('../src/renderer/src/main.tsx', import.meta.url), 'utf8')
  assert.match(main, /exposeFullTrustPluginRegistry\(\)/)
})

test('System Plugin management keeps install and OS-startup approvals explicit and exact', () => {
  const section = readFileSync(new URL('../src/renderer/src/sections/PluginsSection.tsx', import.meta.url), 'utf8')
  const management = readFileSync(new URL('../src/renderer/src/hooks/usePluginManagement.ts', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')

  assert.match(section, /systemPluginIdConfirmations\[request\.id\] !== request\.pluginId/)
  assert.match(section, /!systemAcknowledgements\[request\.id\]/)
  assert.match(section, /osPersistenceIdConfirmations\[osPersistence\.id\] !== plugin\.pluginId/)
  assert.match(section, /!osPersistenceAcknowledgements\[osPersistence\.id\]/)
  assert.match(section, /This is separate from plugin installation approval/)
  assert.match(management, /revisionHash: record\.revisionHash/)
  assert.match(preload, /knowbook:resolve-system-plugin-install-request/)
  assert.match(preload, /knowbook:resolve-system-plugin-os-persistence/)
})

test('Full Trust renderer deactivation removes managed roots, CSS, frames, and disposables', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="mount"></div><div id="frame-mount"></div></body></html>', {
    pretendToBeVisual: true
  })
  const registry = new FullTrustPluginRegistry()
  const globalKeys = ['window', 'document', 'navigator', 'HTMLElement', 'Node'] as const
  const previous = new Map<(typeof globalKeys)[number], PropertyDescriptor | undefined>()
  for (const key of globalKeys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: dom.window[key]
    })
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true
  })

  let disposed = 0
  const registeredPolicies: unknown[] = []
  const removedPolicies: unknown[] = []
  Object.defineProperty(dom.window, 'knowbook', {
    configurable: true,
    value: {
      registerSystemPluginFramePolicy: async (policy: unknown) => { registeredPolicies.push(policy) },
      removeSystemPluginFramePolicy: async (policy: unknown) => { removedPolicies.push(policy) }
    }
  })
  try {
    const mount = dom.window.document.querySelector('#mount') as HTMLElement
    const frameMount = dom.window.document.querySelector('#frame-mount') as HTMLElement
    await act(async () => {
      await registry.activatePlugin({
        id: 'managed-renderer',
        version: '1.0.0',
        revisionHash: 'sha256:managed'
      }, async (api) => {
        api.injectCss('body { --full-trust-test: 1; }', { id: 'global-test' })
        const root = api.createRoot(mount)
        root.render(<span>Managed renderer root</span>)
        const portal = api.createPortal(<span>Portal value</span>, dom.window.document.body)
        assert.ok(portal)
        api.registerDisposable(() => { disposed += 1 }, 'test disposable')
        const frame = await api.createUnsandboxedFrame({
          src: 'https://plugins.example.test/app',
          allowedOrigins: ['https://plugins.example.test'],
          container: frameMount
        })
        assert.equal(frame.frame.hasAttribute('sandbox'), false)
        assert.match(frame.frameName, /^knowbook-full-trust-frame:managed-renderer:/)
        assert.match(frame.popupName, /^knowbook-full-trust-popup:managed-renderer:/)
      })
    })

    assert.match(mount.textContent ?? '', /Managed renderer root/)
    assert.ok(dom.window.document.querySelector('style[data-full-trust-style="global-test"]'))
    assert.equal(frameMount.querySelectorAll('iframe').length, 1)
    assert.equal(registeredPolicies.length, 1)
    assert.deepEqual(registeredPolicies[0], {
      pluginId: 'managed-renderer',
      revisionHash: 'sha256:managed',
      frameName: (registeredPolicies[0] as { frameName: string }).frameName,
      popupName: (registeredPolicies[0] as { popupName: string }).popupName,
      allowedOrigins: ['about:', 'https://plugins.example.test'],
      allowPopups: true,
      allowNavigation: true,
      allowDownloads: true,
      allowPermissions: true
    })

    await act(async () => {
      await registry.deactivatePlugin('managed-renderer')
    })
    assert.equal(mount.textContent, '')
    assert.equal(dom.window.document.querySelector('style[data-full-trust-style="global-test"]'), null)
    assert.equal(disposed, 1)
    assert.equal(frameMount.querySelectorAll('iframe').length, 0)
    assert.equal(removedPolicies.length, 1)
    assert.equal((removedPolicies[0] as { revisionHash?: string }).revisionHash, 'sha256:managed')
    assert.equal(registry.getSlotContributions('workspace.dashboard').length, 0)
  } finally {
    await registry.deactivateAll()
    for (const key of [...globalKeys].reverse()) {
      const descriptor = previous.get(key)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    dom.window.close()
  }
})

test('Full Trust renderer commands, pages, DOM listeners, and theme subscriptions are lifecycle-managed', async () => {
  const dom = new JSDOM('<!doctype html><html data-theme="light"><head></head><body><input id="editor"></body></html>', {
    pretendToBeVisual: true
  })
  const registry = new FullTrustPluginRegistry()
  const globalKeys = ['window', 'document', 'navigator', 'HTMLElement', 'Node'] as const
  const previous = new Map<(typeof globalKeys)[number], PropertyDescriptor | undefined>()
  for (const key of globalKeys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: dom.window[key]
    })
  }

  const commandNotifications: number[] = []
  const pageNotifications: number[] = []
  let commandExecutions = 0
  let domEvents = 0
  const themes: Array<string | null> = []
  const unsubscribeCommands = registry.subscribeToCommands(() => {
    commandNotifications.push(registry.listCommands().length)
  })
  const unsubscribePages = registry.subscribeToPages(() => {
    pageNotifications.push(registry.listPages().length)
  })
  try {
    const api = await registry.activatePlugin({
      id: 'renderer-extensions',
      version: '1.0.0',
      revisionHash: 'sha256:extensions'
    }, (pluginApi) => {
      pluginApi.registerCommand<{ value: number }, number>({
        id: 'renderer-extensions.increment',
        title: 'Increment',
        order: 5,
        shortcut: { key: 'k', ctrlKey: true },
        execute: ({ plugin, commandId, arguments: commandArguments, source }) => {
          assert.equal(plugin.id, 'renderer-extensions')
          assert.equal(commandId, 'renderer-extensions.increment')
          assert.ok(source === 'api' || source === 'keyboard')
          commandExecutions += 1
          return (commandArguments?.value ?? 0) + 1
        }
      })
      pluginApi.registerPage({
        id: 'renderer-extensions.home',
        route: '/plugins/extensions/',
        title: 'Extensions',
        order: 2,
        component: ({ plugin }) => <span>{plugin.id}</span>
      })
      pluginApi.addDomEventListener(document, 'knowbook-extension-test', () => {
        domEvents += 1
      })
      pluginApi.subscribeToTheme(({ theme, root }) => {
        assert.equal(root, document.documentElement)
        themes.push(theme)
      })
    })

    assert.equal(Object.isFrozen(registry.listCommands()), true)
    assert.equal(Object.isFrozen(registry.listCommands()[0]), true)
    assert.deepEqual(registry.listCommands().map(({ id }) => id), ['renderer-extensions.increment'])
    assert.deepEqual(registry.listPages().map(({ route }) => route), ['/plugins/extensions'])
    assert.equal(await api.executeCommand<number>('renderer-extensions.increment', { value: 4 }), 5)

    document.dispatchEvent(new dom.window.Event('knowbook-extension-test'))
    assert.equal(domEvents, 1)
    const shortcutEvent = new dom.window.KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })
    document.body.dispatchEvent(shortcutEvent)
    assert.equal(shortcutEvent.defaultPrevented, true)
    assert.equal(commandExecutions, 2)

    const editor = document.querySelector('#editor') as HTMLInputElement
    editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    }))
    assert.equal(commandExecutions, 2)

    document.documentElement.dataset.theme = 'dark'
    await new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0))
    assert.deepEqual(themes, ['light', 'dark'])

    await assert.rejects(registry.activatePlugin({
      id: 'duplicate-command',
      version: '1.0.0',
      revisionHash: 'sha256:duplicate-command'
    }, (duplicateApi) => {
      duplicateApi.registerCommand({
        id: 'renderer-extensions.increment',
        title: 'Duplicate',
        execute: () => undefined
      })
    }), /command "renderer-extensions\.increment" is already registered/)

    await assert.rejects(registry.activatePlugin({
      id: 'duplicate-shortcut',
      version: '1.0.0',
      revisionHash: 'sha256:duplicate-shortcut'
    }, (duplicateApi) => {
      duplicateApi.registerCommand({
        id: 'duplicate-shortcut.command',
        title: 'Duplicate shortcut',
        shortcut: { key: 'K', ctrlKey: true },
        execute: () => undefined
      })
    }), /shortcut "Ctrl\+K" is already registered/)

    await assert.rejects(registry.activatePlugin({
      id: 'duplicate-route',
      version: '1.0.0',
      revisionHash: 'sha256:duplicate-route'
    }, (duplicateApi) => {
      duplicateApi.registerPage({
        id: 'duplicate-route.home',
        route: '/plugins/extensions',
        title: 'Duplicate route',
        component: () => null
      })
    }), /route "\/plugins\/extensions" is already registered/)

    await registry.deactivatePlugin('renderer-extensions')
    assert.deepEqual(registry.listCommands(), [])
    assert.deepEqual(registry.listPages(), [])
    document.dispatchEvent(new dom.window.Event('knowbook-extension-test'))
    document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'k', ctrlKey: true, bubbles: true
    }))
    document.documentElement.dataset.theme = 'light'
    await new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0))
    assert.equal(domEvents, 1)
    assert.equal(commandExecutions, 2)
    assert.deepEqual(themes, ['light', 'dark'])
    assert.deepEqual(commandNotifications, [1, 0])
    assert.deepEqual(pageNotifications, [1, 0])
  } finally {
    unsubscribeCommands()
    unsubscribePages()
    await registry.deactivateAll()
    for (const key of [...globalKeys].reverse()) {
      const descriptor = previous.get(key)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})

test('sandbox frame uses only allow-scripts, one-time MessageChannel, exact identity checks, and cleanup', () => {
  const source = readFileSync(new URL('../src/renderer/src/components/PluginSlot.tsx', import.meta.url), 'utf8')
  const protocol = readFileSync(new URL('../src/shared/plugin-frame-protocol.ts', import.meta.url), 'utf8')
  assert.match(source, /sandbox="allow-scripts"/)
  assert.match(source, /src=\{contribution\.value\.src\}/)
  assert.equal(source.includes('srcDoc='), false)
  assert.equal(source.includes('allow-same-origin'), false)
  assert.match(source, /new MessageChannel\(\)/)
  assert.match(protocol, /revisionId === expected\.revisionId/)
  assert.match(protocol, /runId === expected\.runId/)
  assert.match(protocol, /candidate\.epoch === expected\.epoch/)
  assert.match(protocol, /MAX_FRAME_MESSAGE_DEPTH/)
  assert.match(protocol, /MAX_FRAME_MESSAGE_BYTES/)
  assert.match(source, /portRef\.current\?\.close\(\)/)
  assert.match(source, /reportPluginUiRuntimeFailure/)
  assert.match(source, /MAX_PENDING_IFRAME_ACTIONS/)
  assert.match(source, /ready handshake timed out after activation/)
  assert.equal(source.includes('addEventListener(\'message\''), false)
})

test('renderer mounts a hidden staging host for iframe ready handshakes', () => {
  const host = readFileSync(new URL('../src/renderer/src/components/PluginUiPreparationHost.tsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /<PluginUiPreparationHost \/>/)
  assert.match(host, /onPluginUiPreparation/)
  assert.match(host, /reportPluginUiPreparation/)
  assert.match(host, /sandbox="allow-scripts"/)
  assert.match(host, /src=\{frame\.src\}/)
  assert.equal(host.includes('srcDoc='), false)
  assert.match(host, /new MessageChannel\(\)/)
  assert.match(host, /Plugin iframe ready handshake timed out/)
})

test('all published slots are mounted in product surfaces', () => {
  const page = readFileSync(new URL('../src/renderer/src/components/AppPageContent.tsx', import.meta.url), 'utf8')
  const sidebar = readFileSync(new URL('../src/renderer/src/components/WorkspaceShellSidebar.tsx', import.meta.url), 'utf8')
  for (const slot of [
    'workspace.dashboard', 'documents.header.actions', 'documents.editor.toolbar',
    'documents.block.context-menu', 'documents.aux-panel', 'database.view.tabs',
    'database.record.actions', 'settings.sections', 'assistant.tools', 'assistant.message.cards'
  ]) assert.ok(page.includes(`slot="${slot}"`), slot)
  assert.ok(sidebar.includes('slot="navigation.primary"'))
})
