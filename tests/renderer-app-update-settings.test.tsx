import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React, { act, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import type { AppUpdateState } from '../src/shared/contracts'
import { getUiText } from '../src/renderer/src/i18n'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { DashboardSettingsSection } = await import('../src/renderer/src/sections/DashboardSettingsSection')
type Props = ComponentProps<typeof DashboardSettingsSection>
const snapshot: AppUpdateState = { status: 'not-available', currentVersion: '1.0.0', availableVersion: '1.1.0',
  downloadedVersion: null, releaseName: 'A useful release', releaseNotes: 'Release notes remain readable.',
  checkedAt: '2026-10-01T12:00:00Z', progressPercent: null, message: '', error: null, updatesEnabled: true, canInstall: false }
function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function initialProps(isZh: boolean): Props {
  const noop = () => undefined
  return {
    ui: getUiText(isZh ? 'zh-CN' : 'en-US'), isZh, isSettingsPage: true, loading: false,
    summary: { databasePath: 'workspace.db', backupRoot: 'backups', documents: 0, blocks: 0, links: 0, lastBackupAt: null },
    aiEndpoint: '', recentDocuments: [], onOpenDocument: noop, uiLanguage: isZh ? 'zh-CN' : 'en-US', onUiLanguageChange: noop,
    aiEnabledDraft: false, onAiEnabledChange: noop, aiAutoSummaryOnSaveDraft: false, onAiAutoSummaryOnSaveChange: noop,
    aiRelatedNotesEnabledDraft: false, onAiRelatedNotesEnabledChange: noop, aiBaseUrlDraft: '', onAiBaseUrlChange: noop,
    aiModelDraft: '', onAiModelChange: noop, aiApiKeyDraft: '', onAiApiKeyChange: noop, onClearAiApiKey: noop,
    aiSaving: false, aiClearingApiKey: false, onSaveAiConfig: noop, onOpenPlugins: noop, onRestoreBackup: noop, onBackupNow: noop,
    aiSaveError: '',
    appUpdateState: null, appUpdateRefreshing: false, appUpdateLoading: false, appUpdateLoadError: null,
    appUpdateCheckError: null, appUpdateCanCheck: false, onReloadAppUpdateState: async () => undefined,
    onCheckForAppUpdates: noop, onInstallAppUpdate: noop,
    webClipBridgeStatus: null, webClipBridgeEnabledDraft: false, onWebClipBridgeEnabledChange: noop,
    webClipBridgePortDraft: '', webClipBridgePortError: null, onWebClipBridgePortChange: noop,
    webClipBridgeSaving: false, webClipBridgeRegenerating: false, webClipBridgeLoading: false, webClipBridgeLoadError: null,
    webClipBridgeActionError: null,
    webClipBridgeCopying: null,
    onReloadWebClipBridgeStatus: noop, onSaveWebClipBridgeSettings: noop, onRegenerateWebClipBridgeToken: noop,
    onCopyWebClipBridgeEndpoint: noop, onCopyWebClipBridgeToken: noop
  }
}
type Context = {
  document: Document; window: Window & typeof globalThis; panel: HTMLElement; ui: ReturnType<typeof getUiText>;
  patch: (value: Partial<Props>) => Promise<void>; patchNow: (value: Partial<Props>) => void;
  button: (label: string) => HTMLButtonElement; activate: (button: HTMLButtonElement) => Promise<void>;
}
async function withUpdates(isZh: boolean, run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div><input id="other-setting" />', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  Object.defineProperty(dom.window.document, 'hasFocus', { value: () => true })
  dom.window.HTMLElement.prototype.getClientRects = function () {
    if (!this.isConnected || this.closest('[hidden], [inert], [aria-hidden="true"]')) return [] as unknown as DOMRectList
    return [new dom.window.DOMRect(0, 0, 240, 32)] as unknown as DOMRectList
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let props = initialProps(isZh)
  const patchNow = (value: Partial<Props>) => { props = { ...props, ...value }; root.render(<DashboardSettingsSection {...props} />) }
  try {
    await act(async () => patchNow({}))
    const tab = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent === (isZh ? '更新' : 'Updates'))!
    await act(async () => tab.click())
    const panel = dom.window.document.querySelector<HTMLElement>('.settings-updates-panel')!
    const button = (label: string) => {
      const target = [...panel.querySelectorAll('button')].find(item => item.textContent === label)
      assert.ok(target, `Missing button: ${label}`); return target
    }
    await run({ document: dom.window.document, window: dom.window as unknown as Window & typeof globalThis,
      panel, ui: props.ui, button, patchNow,
      patch: async value => { await act(async () => patchNow(value)) },
      activate: async target => {
        await act(async () => { target.focus(); target.click() })
        await act(async () => {
          // JSDOM skips blur() on disabled elements, unlike native Chrome disable behaviour.
          if (target.disabled && dom.window.document.activeElement === target) { target.disabled = false; target.blur(); target.disabled = true }
        })
      }
    })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}
function assertFocused(document: Document, expected: Element) {
  assert.ok(document.activeElement === expected, `Unexpected focus ${document.activeElement?.tagName}#${document.activeElement?.id}`)
}
function statusValue(context: Context) { return [...context.panel.querySelectorAll('dl > div')].find(item => item.querySelector('dt')?.textContent === context.ui.updateStatusField)!.querySelector('dd')!.textContent }

test('unknown update status stops reporting loading after a read failure, with disabled actions and a persistent reload in both languages', async () => {
  for (const isZh of [true, false]) {
    await withUpdates(isZh, async context => {
      const { ui, panel, button, patch } = context
      await patch({ appUpdateLoading: true })
      assert.equal(statusValue(context), ui.common.loading)
      assert.equal(button(ui.appUpdateReload).disabled, true)
      assert.equal(button(ui.appUpdateReload).getAttribute('aria-busy'), 'true')
      await patch({ appUpdateLoading: false, appUpdateLoadError: `${ui.appUpdateLoadFailed} No connection.` })
      assert.equal(statusValue(context), ui.appUpdateStatusUnavailable)
      assert.equal(panel.querySelector('[role="status"]'), null)
      assert.equal(panel.querySelector('.settings-update-read-error[role="alert"]')!.textContent, `${ui.appUpdateLoadFailed} No connection.`)
      assert.equal(button(ui.checkForUpdates).disabled, true)
      assert.equal(button(ui.installUpdateNow).disabled, true)
      assert.equal(button(ui.appUpdateReload).disabled, false)
      assert.doesNotMatch(panel.textContent!, new RegExp(isZh ? '初始化中|检查中' : 'Initializing|Checking\\.'))
      await patch({ appUpdateState: { ...snapshot, status: 'unsupported', updatesEnabled: false }, appUpdateLoadError: null })
      assert.equal(statusValue(context), ui.updateStatusUnsupported)
      assert.equal(button(ui.checkForUpdates).disabled, true)
      assert.equal(button(ui.appUpdateReload).disabled, false, 'Reload remains mounted after recovery')
    })
  }
})

test('a failed status refresh preserves metadata and notes with a last-known hint and independent check error', async () => {
  await withUpdates(false, async context => {
    const { ui, panel, button, patch } = context
    await patch({ appUpdateState: { ...snapshot, status: 'downloaded', downloadedVersion: '1.1.0', canInstall: true },
      appUpdateLoadError: 'Failed to load update status. Offline.', appUpdateCheckError: 'Check failed. Try again.', appUpdateCanCheck: true })
    assert.match(panel.textContent!, /1\.0\.0/)
    assert.match(panel.textContent!, /1\.1\.0/)
    assert.match(panel.textContent!, /Release notes remain readable/)
    assert.ok(panel.textContent!.includes(ui.appUpdateLastKnownStatus))
    assert.equal(panel.querySelectorAll('[role="alert"]').length, 2)
    assert.equal(button(ui.installUpdateNow).disabled, true)
    const feedback = panel.querySelector('.settings-update-feedback')!
    assert.equal(feedback.nextElementSibling?.className, 'settings-actions')
    assert.equal(feedback.closest('[aria-busy="true"]'), null)
    await patch({ appUpdateLoadError: null, appUpdateLoading: true })
    assert.equal(button(ui.installUpdateNow).disabled, false, 'Ordinary polling must not repeatedly disable the install action')
    assert.equal(panel.querySelector('.settings-update-read-error'), null)
    assert.equal(panel.querySelector('.settings-update-check-error')!.textContent, 'Check failed. Try again.')
  })
})

test('check errors replace stale success feedback while fresh native checking, downloading, downloaded and error states stay visible', async () => {
  await withUpdates(true, async context => {
    const { ui, panel, patch, button } = context
    for (const status of ['idle', 'not-available'] as const) {
      await patch({ appUpdateState: { ...snapshot, status }, appUpdateCheckError: '检查更新失败。网络不可用。', appUpdateCanCheck: true })
      assert.equal(statusValue(context), ui.appUpdateCheckFailed)
      assert.equal(button(ui.checkForUpdates).getAttribute('aria-busy'), 'false')
      assert.equal(panel.querySelector('[role="status"]'), null)
    }
    for (const state of [
      { ...snapshot, status: 'downloading' as const, progressPercent: 65 },
      { ...snapshot, status: 'downloaded' as const, downloadedVersion: '1.1.0' },
      { ...snapshot, status: 'error' as const, error: 'Updater error.' },
      { ...snapshot, status: 'checking' as const },
      { ...snapshot, status: 'unsupported' as const, updatesEnabled: false }
    ]) {
      await patch({ appUpdateState: state, appUpdateCanCheck: false })
      assert.notEqual(statusValue(context), ui.appUpdateCheckFailed)
      assert.equal(panel.querySelector('.settings-update-check-error')!.textContent, '检查更新失败。网络不可用。')
    }
    await patch({ appUpdateState: { ...snapshot, status: 'checking' }, appUpdateCheckError: null, appUpdateCanCheck: false })
    assert.equal(button(ui.checkingForUpdates).getAttribute('aria-busy'), 'true')
    assert.equal(statusValue(context), ui.updateStatusChecking)
  })
})

test('manual reload and check keep their actual promise focus through success or failure and wait for the enabling commit', async () => {
  for (const operation of ['reload', 'check'] as const) {
    for (const fail of [false, true]) {
      await withUpdates(false, async context => {
        const pending = deferred(), { ui, patch, patchNow, button, document } = context
        const finish = () => patchNow(operation === 'reload'
          ? { appUpdateLoading: false, appUpdateLoadError: fail ? 'Read failed.' : null, appUpdateState: snapshot }
          : { appUpdateRefreshing: false, appUpdateCanCheck: false, appUpdateCheckError: fail ? 'Check failed.' : null })
        const start = () => {
          patchNow(operation === 'reload' ? { appUpdateLoading: true } : { appUpdateRefreshing: true, appUpdateCanCheck: false })
          return pending.promise.then(finish, finish)
        }
        await patch({ appUpdateState: snapshot, appUpdateCanCheck: true, onReloadAppUpdateState: start, onCheckForAppUpdates: start })
        const trigger = button(operation === 'reload' ? ui.appUpdateReload : ui.checkForUpdates)
        await context.activate(trigger)
        assert.equal(trigger.disabled, true)
        assertFocused(document, document.body)
        await act(async () => fail ? pending.reject(new Error('Handled provider failure')) : pending.resolve())
        if (operation === 'check') {
          assertFocused(document, document.body)
          await patch({ appUpdateCanCheck: true })
        }
        assertFocused(document, trigger)
        assert.equal(trigger.disabled, false)
      })
    }
  }
})

test('switching categories or moving to another input during an update check cannot steal focus when it settles', async () => {
  for (const movement of ['category', 'input'] as const) {
    await withUpdates(true, async context => {
      const pending = deferred(), { ui, document, patch, patchNow } = context
      await patch({ appUpdateState: snapshot, appUpdateCanCheck: true, onCheckForAppUpdates: () => {
        patchNow({ appUpdateRefreshing: true, appUpdateCanCheck: false })
        return pending.promise.then(() => patchNow({ appUpdateRefreshing: false, appUpdateCanCheck: true }))
      } })
      await context.activate(context.button(ui.checkForUpdates))
      const destination = movement === 'input' ? document.getElementById('other-setting')!
        : [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent === '通用')!
      await act(async () => { destination.focus(); if (movement === 'category') (destination as HTMLButtonElement).click() })
      await act(async () => pending.resolve())
      assertFocused(document, destination)
      if (movement === 'category') assert.equal(context.panel.hidden, true)
    })
  }
})

test('fresh native status from automatic polling never moves an editor input focus', async () => {
  await withUpdates(false, async context => {
    await context.patch({ appUpdateState: snapshot, appUpdateCanCheck: true })
    const outside = context.document.getElementById('other-setting')!
    outside.focus()
    await context.patch({ appUpdateLoading: true })
    await context.patch({ appUpdateLoading: false, appUpdateState: { ...snapshot, status: 'downloaded', downloadedVersion: '1.1.0', canInstall: true } })
    assertFocused(context.document, outside)
    assert.equal(context.button(context.ui.installUpdateNow).disabled, false)
  })
})
