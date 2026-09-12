import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import React, { act, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import type { PluginV2InstallationSummary, SystemPluginSummary } from '../src/shared/contracts.ts'
import { getUiText } from '../src/renderer/src/i18n.ts'

// Styles remain owned by the production section; the DOM tests only need its markup.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { PluginsSection } = await import('../src/renderer/src/sections/PluginsSection.tsx')

const dynamicPlugin: PluginV2InstallationSummary = {
  pluginId: 'dynamic-notes', name: 'Dynamic notes', version: '1.0.0', description: 'Organize notes',
  author: null, source: 'dynamic', scope: 'workspace', enabled: true,
  currentRevisionId: 'revision-1', activeRunId: 'run-1', revisionCount: 2,
  updatedAt: '2026-09-12T00:00:00Z', lastError: null, quarantined: false,
  violationCount: 0, quarantineReason: null, quarantinedAt: null
}

function systemPlugin(overrides: Partial<SystemPluginSummary> = {}): SystemPluginSummary {
  return {
    pluginId: 'activity-pulse', name: 'Activity Pulse', description: 'Workspace activity',
    publisher: 'KnowBook', enabled: true, safeModeDisabled: false, status: 'active',
    currentVersion: '3.0.0', currentArtifactSha256: 'artifact-1', pendingVersion: null,
    pendingArtifactSha256: null, riskDeclarations: ['local-database'], lastError: null,
    restartRequired: false, updatedAt: '2026-09-12T00:00:00Z', runtimeStatus: 'ready',
    backupPath: null, availablePackages: [], dependencyJobs: [], lastRun: null,
    recentRuns: [], managedResources: [], osPersistence: null, dataPath: '/data', logPath: '/logs',
    ...overrides
  }
}

function props(overrides: Partial<ComponentProps<typeof PluginsSection>> = {}): ComponentProps<typeof PluginsSection> {
  const noop = () => undefined
  return {
    ui: getUiText('en-US'), aiEnabled: true, hasApiKey: true,
    pluginV2Installations: [], systemPlugins: [], systemPluginInstallRequests: [],
    pluginBusyId: null, pluginInventoryBusy: false,
    onInstallSystemPluginFromFolder: noop, onSetPluginV2Enabled: noop,
    onRemovePluginV2: noop, onRecoverPluginV2Installation: noop,
    onSetSystemPluginEnabled: noop, onRecoverSystemPlugin: noop,
    onUninstallSystemPlugin: noop, onRollbackSystemPlugin: noop,
    onStartSystemPluginService: noop, onStopSystemPluginService: noop,
    onRequestSystemPluginOsPersistence: noop, onResolveSystemPluginOsPersistence: noop,
    onRemoveSystemPluginOsPersistence: noop, onOpenSystemPluginDirectory: noop,
    onRestartInSystemPluginSafeMode: noop, onResolveSystemPluginInstallRequest: noop,
    ...overrides
  }
}

test('plugin overview counts v3 installations and failures alongside dynamic plugins', () => {
  const dom = new JSDOM(renderToStaticMarkup(<PluginsSection {...props({
    pluginV2Installations: [dynamicPlugin],
    systemPlugins: [systemPlugin(), systemPlugin({
      pluginId: 'failed-system', name: 'Failed system plugin', status: 'failed',
      lastError: { message: 'Startup failed' }, runtimeStatus: 'failed'
    })]
  })} />))
  try {
    const document = dom.window.document
    const counts = [...document.querySelectorAll('.plugin-overview-card strong')].map((element) => element.textContent)
    assert.deepEqual(counts, ['3', '2', '1', '1'])
    assert.equal(document.querySelectorAll('.plugin-toolbar button').length, 1)
    assert.equal(document.querySelector('.plugin-toolbar button')?.textContent, '⚠Install Full Trust')
    assert.match(document.querySelector('.plugin-inventory-head')!.textContent!, /Workspace plugins/)
    assert.equal(document.querySelector('.plugin-inspector'), null)
    assert.equal(document.querySelector('.plugin-details-toggle')?.getAttribute('aria-expanded'), 'false')
    assert.match(document.querySelector('.plugin-card-meta')!.textContent!, /Source: AI created/)
    assert.match(document.body.textContent!, /Installed Full Trust plugins.*Activity Pulse/)
    assert.doesNotMatch(document.body.textContent!, /Legacy v1|Install Folder|Plugin roots/)
  } finally {
    dom.window.close()
  }
})

test('v3-only installation does not display a misleading empty workspace message', () => {
  const dom = new JSDOM(renderToStaticMarkup(<PluginsSection {...props({ systemPlugins: [systemPlugin()] })} />))
  try {
    assert.equal(dom.window.document.querySelector('.plugin-overview-card strong')?.textContent, '1')
    assert.equal(dom.window.document.querySelector('.plugin-inspector'), null)
    assert.match(dom.window.document.querySelector('.plugin-inventory-panel .plugin-empty-state')!.textContent!, /No dynamic plugins installed yet/)
    assert.match(dom.window.document.body.textContent!, /Activity Pulse/)
  } finally {
    dom.window.close()
  }
})

test('workspace plugins expand one inline detail at a time and retain independent lifecycle controls', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true })
  const globalKeys = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const previous = new Map(globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const key of globalKeys) Object.defineProperty(globalThis, key, {
    configurable: true, writable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key]
  })
  Object.defineProperty(dom.window, 'knowbook', {
    value: { getPluginV2Details: async () => null }, configurable: true
  })
  const calls: unknown[] = []
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  try {
    await act(async () => root.render(<PluginsSection {...props({
      pluginV2Installations: [dynamicPlugin, {
        ...dynamicPlugin, pluginId: 'builtin-notes', name: 'Built-in notes', source: 'builtin',
        enabled: false, activeRunId: null
      }],
      onInstallSystemPluginFromFolder: () => { calls.push('install-system') },
      onSetPluginV2Enabled: (plugin, enabled) => { calls.push([plugin.pluginId, enabled]) },
      onRemovePluginV2: (plugin) => { calls.push(['remove', plugin.pluginId]) }
    })} />))
    const button = (label: string) => [...dom.window.document.querySelectorAll('button')]
      .find((element) => element.textContent?.includes(label))!
    const document = dom.window.document
    const toggle = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button.plugin-details-toggle')]
      .find((element) => element.getAttribute('aria-label')?.includes(name))!
    const inspector = () => document.querySelector('.plugin-inspector')
    const setQuery = async (value: string) => act(async () => {
      const input = document.querySelector<HTMLInputElement>('input[type="search"]')!
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
    })

    assert.equal(inspector(), null)
    assert.equal(toggle('Dynamic notes').getAttribute('aria-expanded'), 'false')
    await act(async () => document.querySelector<HTMLInputElement>('input[aria-label="Enable Dynamic notes"]')!.click())
    assert.equal(inspector(), null, 'The enable switch must not open details')
    assert.deepEqual(calls, [['dynamic-notes', false]])
    calls.length = 0

    await act(async () => toggle('Dynamic notes').click())
    assert.equal(toggle('Dynamic notes').getAttribute('aria-expanded'), 'true')
    assert.equal(toggle('Dynamic notes').getAttribute('aria-label'), 'Hide details for Dynamic notes')
    assert.equal(inspector()?.id, toggle('Dynamic notes').getAttribute('aria-controls'))
    assert.equal(inspector()?.tagName, 'SECTION')
    assert.ok(inspector()?.matches('.plugin-item .plugin-inline-details'))
    assert.match(inspector()!.textContent!, /Continue with AI/)

    await act(async () => toggle('Built-in notes').click())
    assert.equal(document.querySelectorAll('.plugin-inspector').length, 1)
    assert.equal(toggle('Dynamic notes').getAttribute('aria-expanded'), 'false')
    assert.match(inspector()!.textContent!, /Plugin details · Source: Built in/)
    assert.match(inspector()!.closest('.plugin-item')!.textContent!, /Built-in notes/)
    await act(async () => toggle('Built-in notes').click())
    assert.equal(inspector(), null)

    await act(async () => toggle('Dynamic notes').click())
    await act(async () => button('Disabled').click())
    assert.equal(inspector(), null, 'Filtering out an expanded plugin must close its details')
    assert.equal(document.querySelectorAll('.plugin-item').length, 1)
    await act(async () => button('All').click())
    assert.equal(inspector(), null, 'Clearing a filter must not reopen stale details')
    await act(async () => toggle('Dynamic notes').click())
    await setQuery('Built-in notes')
    assert.equal(inspector(), null, 'Searching out an expanded plugin must close its details')
    assert.equal(document.querySelectorAll('.plugin-item').length, 1)
    await setQuery('')
    assert.equal(inspector(), null, 'Clearing search must not reopen stale details')
    assert.equal(document.querySelectorAll('.plugin-item').length, 2)

    await act(async () => button('Install Full Trust').click())
    await act(async () => toggle('Dynamic notes').click())
    await act(async () => button('Disable plugin').click())
    await act(async () => button('Uninstall plugin').click())
    assert.deepEqual(calls, ['install-system', ['dynamic-notes', false], ['remove', 'dynamic-notes']])
  } finally {
    await act(async () => root.unmount())
    for (const key of globalKeys) {
      const descriptor = previous.get(key)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
