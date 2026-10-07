import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React, { act, useState, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { getUiText } from '../src/renderer/src/i18n'
import { DEFAULT_WEBDAV_SYNC_CONFIG, type WebDavSyncStatus } from '../src/shared/webdav-sync'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { DashboardSettingsSection } = await import('../src/renderer/src/sections/DashboardSettingsSection')
type SettingsProps = ComponentProps<typeof DashboardSettingsSection>

function settingsProps(isZh: boolean): SettingsProps {
  const noop = () => undefined
  return {
    ui: getUiText(isZh ? 'zh-CN' : 'en-US'), isZh, isSettingsPage: true, loading: false,
    summary: { databasePath: 'local/knowbook.db', backupRoot: 'local/backups', documents: 0, blocks: 0, links: 0, lastBackupAt: null },
    aiEndpoint: 'https://example.invalid/v1', recentDocuments: [], onOpenDocument: noop,
    uiLanguage: isZh ? 'zh-CN' : 'en-US', onUiLanguageChange: noop,
    aiEnabledDraft: false, onAiEnabledChange: noop,
    aiAutoSummaryOnSaveDraft: false, onAiAutoSummaryOnSaveChange: noop,
    aiRelatedNotesEnabledDraft: false, onAiRelatedNotesEnabledChange: noop,
    aiBaseUrlDraft: '', onAiBaseUrlChange: noop, aiModelDraft: '', onAiModelChange: noop,
    aiApiKeyDraft: '', onAiApiKeyChange: noop, onClearAiApiKey: noop, aiSaving: false, aiClearingApiKey: false,
    aiSaveError: '',
    onSaveAiConfig: noop, onOpenPlugins: noop, onRestoreBackup: noop, onBackupNow: noop,
    appUpdateState: null, appUpdateRefreshing: false, onCheckForAppUpdates: noop, onInstallAppUpdate: noop,
    appUpdateLoading: false, appUpdateLoadError: null, appUpdateCheckError: null, appUpdateCanCheck: false,
    onReloadAppUpdateState: async () => undefined,
    webClipBridgeStatus: { enabled: false, running: false, port: null, configuredPort: 3030, token: 'fixture-token', endpoint: null, lastError: null }, webClipBridgeEnabledDraft: false, onWebClipBridgeEnabledChange: noop,
    webClipBridgePortDraft: '3030', onWebClipBridgePortChange: noop, webClipBridgeSaving: false,
    webClipBridgePortError: null,
    webClipBridgeRegenerating: false,
    webClipBridgeActionError: null,
    webClipBridgeCopying: null,
    webClipBridgeLoading: false, webClipBridgeLoadError: null, onReloadWebClipBridgeStatus: noop,
    onSaveWebClipBridgeSettings: noop, onRegenerateWebClipBridgeToken: noop,
    onCopyWebClipBridgeEndpoint: noop, onCopyWebClipBridgeToken: noop,
    appearanceContent: <input aria-label="Theme draft" defaultValue="appearance draft" />,
    recoveryContent: <button type="button">Open recovery fixture</button>
  }
}

test('settings opens general preferences first, with accessible category panels in either language', () => {
  for (const isZh of [true, false]) {
    const dom = new JSDOM(renderToStaticMarkup(<DashboardSettingsSection {...settingsProps(isZh)} />))
    try {
      const tabs = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      const visiblePanels = [...dom.window.document.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter(panel => !panel.hidden)
      assert.equal(tabs.length, 7)
      assert.equal(tabs[0].textContent, isZh ? '通用' : 'General')
      assert.equal(tabs[0].getAttribute('aria-selected'), 'true')
      assert.equal(visiblePanels.length, 1)
      assert.ok(visiblePanels[0].querySelector('select'))
      assert.equal(visiblePanels[0].querySelector('select')!.getAttribute('aria-label'), settingsProps(isZh).ui.languageSwitchLabel)
      assert.equal(visiblePanels[0].querySelector('input'), null)
      for (const tab of tabs) {
        const panel = dom.window.document.getElementById(tab.getAttribute('aria-controls')!)!
        assert.equal(panel.getAttribute('aria-labelledby'), tab.id)
      }
    } finally { dom.window.close() }
  }
})

test('category keyboard navigation and switching preserve controlled, sync, and appearance drafts', async () => {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  let syncReads = 0
  let compactNavigation = false
  let navigationMediaChanged: () => void = () => undefined
  let mediaListenerRemovals = 0
  const resizeObservers: NavigationResizeObserver[] = []
  class NavigationResizeObserver {
    readonly observed = new Set<Element>()
    disconnected = false
    constructor(private readonly callback: () => void) { resizeObservers.push(this) }
    observe(element: Element) { this.observed.add(element) }
    disconnect() { this.disconnected = true; this.observed.clear() }
    notify() { if (!this.disconnected) this.callback() }
  }
  const media = {
    get matches() { return compactNavigation },
    addEventListener: (_event: string, callback: () => void) => { navigationMediaChanged = callback },
    removeEventListener: () => { mediaListenerRemovals++; navigationMediaChanged = () => undefined }
  }
  Object.defineProperty(dom.window, 'matchMedia', { value: () => media })
  const status: WebDavSyncStatus = { config: { ...DEFAULT_WEBDAV_SYNC_CONFIG }, hasPassword: false,
    phase: 'idle', lastSyncAt: null, message: '', uploaded: 0, downloaded: 0, merged: 0, progress: null, conflicts: [] }
  Object.defineProperty(dom.window, 'knowbook', { value: { getWebDavSyncStatus: async () => { syncReads++; return status } } })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
    ResizeObserver: NavigationResizeObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const container = dom.window.document.getElementById('mount')!
  const root = createRoot(container)
  let rootMounted = true
  let isSettingsPage = true
  let requestedCategory: SettingsProps['requestedCategory'] = null
  let categoryRequestsHandled = 0
  const onCategoryRequestHandled = () => { categoryRequestsHandled++ }
  function Harness() {
    const [model, setModel] = useState('saved-model')
    const [port, setPort] = useState('3030')
    return <><button type="button" aria-label="Shell navigation fixture">Open settings fixture</button>
      <DashboardSettingsSection {...settingsProps(true)} isSettingsPage={isSettingsPage}
        aiModelDraft={model} onAiModelChange={setModel} webClipBridgePortDraft={port} onWebClipBridgePortChange={setPort}
        requestedCategory={requestedCategory} onCategoryRequestHandled={onCategoryRequestHandled} /></>
  }
  const tab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent === label)!
  const panel = (label: string) => dom.window.document.getElementById(tab(label).getAttribute('aria-controls')!)!
  const select = async (label: string) => { await act(async () => tab(label).click()) }
  const editInput = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }
  try {
    await act(async () => root.render(<Harness />))
    assert.equal(container.querySelector('[role="tablist"]')!.getAttribute('aria-orientation'), 'vertical')
    assert.equal(resizeObservers.length, 0, 'Wide vertical navigation does not need a resize observer')
    assert.equal(syncReads, 0, 'sync must not load until its category is opened')
    tab('通用').focus()
    await act(async () => tab('通用').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    assert.equal(dom.window.document.activeElement, tab('AI'))
    assert.equal(panel('AI').hidden, false)
    const model = panel('AI').querySelectorAll<HTMLInputElement>('input[type="text"]')[1]
    await editInput(model, 'unsaved-model')
    await select('网页剪藏')
    const port = panel('网页剪藏').querySelector<HTMLInputElement>('input[inputmode="numeric"]')!
    await editInput(port, '4040')
    await select('AI')
    assert.equal(model.value, 'unsaved-model')
    await select('网页剪藏')
    assert.equal(port.value, '4040')

    await select('同步')
    // React.lazy resolves the module separately from the tab click.
    for (let attempt = 0; attempt < 40 && !panel('同步').querySelector('input:not([type])'); attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    }
    const username = panel('同步').querySelector<HTMLInputElement>('input:not([type])')!
    assert.ok(username)
    await editInput(username, 'unsaved-sync-user')
    await select('外观')
    const appearance = panel('外观').querySelector<HTMLInputElement>('input')!
    appearance.value = 'unsaved-appearance'
    await select('同步')
    assert.equal(panel('同步').querySelector('input:not([type])'), username, 'sync category must keep the same component mounted')
    assert.equal(username.value, 'unsaved-sync-user')
    await select('外观')
    assert.equal(appearance.value, 'unsaved-appearance')
    await act(async () => tab('外观').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    assert.equal(dom.window.document.activeElement, tab('通用'))
    assert.equal(container.querySelectorAll('[role="tabpanel"]:not([hidden])').length, 1)
    await select('存储与恢复')
    assert.match(panel('存储与恢复').textContent!, /local\/knowbook.db/)
    assert.match(panel('存储与恢复').textContent!, /Open recovery fixture/)
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    let navigationWidth = 220
    const elementPrototype = dom.window.HTMLElement.prototype
    const originalClientWidth = Object.getOwnPropertyDescriptor(elementPrototype, 'clientWidth')
      ?? Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'clientWidth')!
    const originalBounds = elementPrototype.getBoundingClientRect
    Object.defineProperty(elementPrototype, 'clientWidth', { configurable: true, get() {
      return this.getAttribute('role') === 'tablist' ? navigationWidth : originalClientWidth.get!.call(this)
    } })
    elementPrototype.getBoundingClientRect = function () {
      if (this.getAttribute('role') === 'tablist') return new dom.window.DOMRect(0, 0, navigationWidth, 40)
      if (this.getAttribute('role') === 'tab') {
        const parent = this.parentElement!
        const index = [...parent.children].indexOf(this)
        return new dom.window.DOMRect(index * 100 - parent.scrollLeft, 0, 100, 40)
      }
      return originalBounds.call(this)
    }
    const activeObserver = (target: HTMLElement) => {
      const active = resizeObservers.filter(observer => !observer.disconnected)
      assert.equal(active.length, 1, 'Only the visible compact navigation may be observed')
      assert.ok(active[0].observed.has(target))
      return active[0]
    }
    const recovery = panel('存储与恢复').querySelector<HTMLButtonElement>('button')!
    recovery.focus()
    container.scrollTop = 150
    compactNavigation = true
    await act(async () => navigationMediaChanged())
    assert.equal(container.querySelector('[role="tablist"]')!.getAttribute('aria-orientation'), 'horizontal')
    assert.equal(list.scrollLeft, 180, 'Narrowing the window must reveal the selected category')
    assert.equal(dom.window.document.activeElement, recovery, 'Revealing a category must leave form focus alone')
    assert.equal(container.scrollTop, 150, 'Revealing a category must not scroll the settings page vertically')
    activeObserver(list)
    await act(async () => tab('存储与恢复').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    assert.equal(dom.window.document.activeElement, tab('网页剪藏'))
    assert.equal(port.value, '4040', 'Responsive navigation must preserve the category draft')
    const focusBeforeRequest = dom.window.document.activeElement
    requestedCategory = 'appearance'
    await act(async () => root.render(<Harness />))
    assert.equal(tab('外观').getAttribute('aria-selected'), 'true')
    assert.equal(list.scrollLeft, 480, 'An external category request must also reveal its selected tab')
    assert.equal(dom.window.document.activeElement, focusBeforeRequest, 'An external request must not move focus while revealing its tab')
    assert.equal(categoryRequestsHandled, 1)
    const appearanceInput = panel('外观').querySelector<HTMLInputElement>('input')!
    appearanceInput.focus()
    navigationWidth = 180
    await act(async () => activeObserver(list).notify())
    assert.equal(list.scrollLeft, 520, 'Shrinking 800 to 760 within the compact breakpoint must reveal the selected category again')
    assert.equal(dom.window.document.activeElement, appearanceInput, 'A container resize must preserve form focus')
    assert.equal(container.scrollTop, 150, 'A container resize must preserve vertical scroll')
    assert.equal(categoryRequestsHandled, 1, 'A resize must not replay an already handled category request')

    requestedCategory = null
    await act(async () => root.render(<Harness />))
    list.scrollLeft = 0
    requestedCategory = 'appearance'
    await act(async () => root.render(<Harness />))
    assert.equal(list.scrollLeft, 520, 'Requesting the current category must reveal it even without a selection change')
    assert.equal(dom.window.document.activeElement, appearanceInput)
    assert.equal(container.scrollTop, 150)
    assert.equal(categoryRequestsHandled, 2, 'Each external request must be handled exactly once')
    requestedCategory = null
    await act(async () => root.render(<Harness />))

    const shellNavigation = container.querySelector<HTMLButtonElement>('[aria-label="Shell navigation fixture"]')!
    shellNavigation.focus()
    isSettingsPage = false
    await act(async () => root.render(<Harness />))
    assert.equal(container.querySelector('[role="tablist"]'), null)
    assert.ok(resizeObservers.every(observer => observer.disconnected), 'Leaving settings must disconnect its navigation observer')
    isSettingsPage = true
    await act(async () => root.render(<Harness />))
    const returnedList = container.querySelector<HTMLElement>('[role="tablist"]')!
    assert.notEqual(returnedList, list)
    assert.equal(tab('外观').getAttribute('aria-selected'), 'true')
    assert.equal(returnedList.scrollLeft, 520, 'Returning from dashboard must reveal the retained active category in the new navigation')
    assert.equal(dom.window.document.activeElement, shellNavigation, 'Returning to settings must not steal shell navigation focus')
    assert.equal(container.scrollTop, 150)
    activeObserver(returnedList)
    await select('AI')
    assert.equal(panel('AI').querySelectorAll<HTMLInputElement>('input[type="text"]')[1].value, 'unsaved-model')
    await select('网页剪藏')
    assert.equal(panel('网页剪藏').querySelector<HTMLInputElement>('input[inputmode="numeric"]')!.value, '4040')
    compactNavigation = false
    await act(async () => navigationMediaChanged())
    assert.equal(container.querySelector('[role="tablist"]')!.getAttribute('aria-orientation'), 'vertical')
    assert.ok(resizeObservers.every(observer => observer.disconnected), 'Wide navigation must disconnect its resize observer')
    compactNavigation = true
    await act(async () => navigationMediaChanged())
    activeObserver(returnedList)
    await act(async () => root.unmount())
    rootMounted = false
    assert.ok(resizeObservers.every(observer => observer.disconnected), 'Unmounting must disconnect the last navigation observer')
    assert.equal(mediaListenerRemovals, 1)
  } finally {
    if (rootMounted) await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
