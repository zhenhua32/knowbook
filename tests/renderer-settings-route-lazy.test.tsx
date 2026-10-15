import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React, { act, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import type { AppUpdateState, ElectronApi, HomeData, WebClipBridgeStatus } from '../src/shared/contracts'
import { getUiText } from '../src/renderer/src/i18n'
import type { PageId } from '../src/renderer/src/hooks/useAppShellState'
import { waitForRenderer } from './helpers/renderer-async'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
type PageProps = ComponentProps<typeof import('../src/renderer/src/components/AppPageContent').AppPageContent>
const noop = () => undefined
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const update: AppUpdateState = { status: 'idle', currentVersion: '1.0.0', availableVersion: null, downloadedVersion: null,
  releaseName: null, releaseNotes: null, checkedAt: null, progressPercent: null, message: '', error: null, updatesEnabled: true, canInstall: false }
const bridge = (port = 3210): WebClipBridgeStatus => ({ enabled: true, running: true, port, configuredPort: port,
  token: 'route-test-token', endpoint: `http://127.0.0.1:${port}/clip`, lastError: null })

async function withRoute(run: (context: {
  document: Document; ui: ReturnType<typeof getUiText>; reads: () => { updates: number; bridge: number };
  render: (page: PageId) => Promise<void>; timers: () => number;
  poll: () => Promise<void>;
  select: (label: string) => Promise<void>; port: () => HTMLInputElement;
  editPort: (value: string) => Promise<void>;
  delayNextBridgeRead: () => ReturnType<typeof deferred<WebClipBridgeStatus>>;
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const original = new Map<string, PropertyDescriptor | undefined>(), intervals = new Map<number, () => void>()
  let timer = 0, updateReads = 0, bridgeReads = 0, page: PageId = 'dashboard'
  let delayed: ReturnType<typeof deferred<WebClipBridgeStatus>> | null = null
  const pending: Array<ReturnType<typeof deferred<WebClipBridgeStatus>>> = []
  const interval = (callback: () => void) => { intervals.set(++timer, callback); return timer }
  const clear = (id: number) => { intervals.delete(id) }
  const api: Pick<ElectronApi, 'getAppUpdateState' | 'getWebClipBridgeStatus'> = {
    getAppUpdateState: async () => { updateReads++; return update },
    getWebClipBridgeStatus: () => { bridgeReads++; const request = delayed; delayed = null; return request?.promise ?? Promise.resolve(bridge()) }
  }
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  Object.defineProperty(dom.window.document, 'hasFocus', { value: () => true })
  dom.window.HTMLElement.prototype.getClientRects = function () {
    if (!this.isConnected || this.closest('[hidden], [inert], [aria-hidden="true"]')) return [] as unknown as DOMRectList
    return [new dom.window.DOMRect(0, 0, 240, 32)] as unknown as DOMRectList
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Node: dom.window.Node,
    setInterval: interval, clearInterval: clear, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  // AppPageContent's plugin registry imports react-dom/client too. Initialize
  // its event feature detection after the real DOM globals are installed.
  const [{ createRoot }, { AppPageContent }, { useAppFeatureDomains }] = await Promise.all([
    import('react-dom/client'), import('../src/renderer/src/components/AppPageContent'), import('../src/renderer/src/hooks/useAppFeatureDomains')
  ])
  const root = createRoot(dom.window.document.getElementById('mount')!), ui = getUiText('en-US')
  const home: HomeData = {
    appearanceTheme: 'light', summary: { databasePath: 'route.db', backupRoot: 'route-backups', documents: 0, blocks: 0, links: 0, lastBackupAt: null },
    recentDocuments: [], recentEvents: [], documentCatalog: [], databaseColumns: [], documentTree: [], initialDocumentId: null,
    aiConfig: { enabled: false, baseUrl: 'https://example.invalid/v1', model: '', autoSummaryOnSave: false, relatedNotesEnabled: false, hasApiKey: false },
    pluginDashboardCards: [], pluginDocumentActions: [], pluginUiContributions: [], pluginV2Installations: [], systemPluginInstallRequests: []
  }
  const documents = { selectedDocumentId: null, selectedDocument: null, detailLoading: false, setDraftSummary: noop,
    setSelectedDocument: noop, openDocumentInDocumentsPage: noop, selectDocumentContext: async () => false } as unknown as PageProps['documents']
  function Harness() {
    const shell = { activePage: page, homeData: home, isZh: false, ui, uiLanguage: 'en-US', loading: false,
      workspaceReady: true, workspaceError: null, settingsCategoryRequest: null, clearSettingsCategoryRequest: noop,
      setActivePage: noop, notify: noop, setHomeData: noop, setUiLanguage: noop, openAiSettings: noop } as unknown as PageProps['shell']
    const features = useAppFeatureDomains({ documents, shell, handleBackup: async () => undefined, handleRestoreBackup: async () => undefined })
    return <><button type="button" id="other-page-focus">Other page focus</button>
      <AppPageContent shell={shell} documents={documents} features={features}
        database={{ databaseEntityDatabaseId: null } as unknown as PageProps['database']}
        workspace={{ importReport: null } as unknown as PageProps['workspace']} /></>
  }
  const render = async (next: PageId) => {
    page = next
    await act(async () => root.render(<Harness />))
    if (next === 'settings') await waitForRenderer(() => {
      const scope = dom.window.document.querySelector('[data-testid="settings-route"]')
      const input = scope?.querySelector<HTMLInputElement>('.settings-bridge-panel input[inputmode="numeric"]')
      return !!scope?.querySelector('[role="tablist"]') && !!input && !input.disabled
    }, 'The real lazy settings route and initial bridge configuration must become ready')
    if (next === 'dashboard') await waitForRenderer(() => {
      const metadata = dom.window.document.querySelector('.content.page-dashboard > .detail-grid .meta-grid')
      return !!metadata?.textContent?.includes('route.db')
    }, 'The real lazy dashboard storage overview must become ready')
  }
  const select = async (label: string) => { await act(async () => {
    const tab = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent === label)
    assert.ok(tab); tab.click()
  }) }
  const port = () => {
    const input = dom.window.document.querySelector<HTMLInputElement>('.settings-bridge-panel input[inputmode="numeric"]')
    assert.ok(input); return input
  }
  try {
    await render('dashboard')
    await run({ document: dom.window.document, ui, reads: () => ({ updates: updateReads, bridge: bridgeReads }), render,
      timers: () => intervals.size, select, port,
      poll: async () => { await act(async () => { [...intervals.values()].forEach(callback => callback()) }) },
      editPort: async value => { await act(async () => {
        const input = port()
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      delayNextBridgeRead: () => { delayed = deferred<WebClipBridgeStatus>(); pending.push(delayed); return delayed }
    })
  } finally {
    await act(async () => { root.unmount(); pending.forEach(request => request.resolve(bridge())) })
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('settings state loads only on its first route visit and retains drafts with polling inactive away from settings', () => withRoute(async context => {
  assert.deepEqual(context.reads(), { updates: 0, bridge: 0 })
  assert.equal(context.timers(), 0)
  assert.equal(context.document.querySelector('[data-testid="settings-route"]'), null)
  assert.ok(context.document.body.textContent!.includes('route.db'), 'Dashboard storage overview stays available without settings state')
  await context.render('settings')
  assert.deepEqual(context.reads(), { updates: 1, bridge: 1 })
  assert.equal(context.timers(), 1)
  const host = context.document.querySelector<HTMLElement>('[data-testid="settings-route"]')!
  assert.equal(host.hidden, false)
  assert.equal(context.document.defaultView!.getComputedStyle(host).display, 'flex')
  await context.select('Web clipping')
  await context.editPort('5432')
  assert.equal(context.port().value, '5432')
  await context.render('dashboard')
  assert.equal(context.document.querySelector('[data-testid="settings-route"]'), host)
  assert.equal(host.hidden, true)
  assert.equal(context.document.defaultView!.getComputedStyle(host).display, 'none')
  assert.equal([...host.querySelectorAll<HTMLElement>('button,input,select,textarea,[tabindex]')]
    .some(control => control.getClientRects().length > 0 && !control.matches(':disabled')), false)
  assert.equal(context.timers(), 0)
  assert.deepEqual(context.reads(), { updates: 1, bridge: 1 })
  await context.render('settings')
  assert.equal(context.document.querySelector('[data-testid="settings-route"]'), host)
  assert.equal(context.timers(), 1)
  assert.equal(context.port().value, '5432', 'Background refresh must not replace the unsaved bridge draft')
  assert.deepEqual(context.reads(), { updates: 2, bridge: 2 })
}))

test('a settings read completing after route departure cannot focus the hidden settings controls', () => withRoute(async context => {
  await context.render('settings'); await context.select('Web clipping')
  const failed = context.delayNextBridgeRead()
  await context.poll()
  await act(async () => failed.reject(new Error('Temporary bridge read failure')))
  const reload = [...context.document.querySelectorAll<HTMLButtonElement>('.settings-bridge-panel button')].find(item => item.textContent === context.ui.webClipBridgeReload)!
  assert.ok(reload)
  const pending = context.delayNextBridgeRead()
  await act(async () => { reload.focus(); reload.click() })
  await context.render('dashboard')
  const other = context.document.getElementById('other-page-focus')!
  other.focus()
  await act(async () => pending.resolve(bridge(4321)))
  assert.equal(context.document.activeElement, other)
  assert.equal(context.timers(), 0)
  assert.equal(context.document.querySelector<HTMLElement>('[data-testid="settings-route"]')!.hidden, true)
}))
