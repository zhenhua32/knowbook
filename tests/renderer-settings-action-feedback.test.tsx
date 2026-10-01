import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React, { act, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import { getUiText } from '../src/renderer/src/i18n'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { DashboardSettingsSection } = await import('../src/renderer/src/sections/DashboardSettingsSection')
type Props = ComponentProps<typeof DashboardSettingsSection>
function initialProps(isZh: boolean): Props {
  const noop = () => undefined
  return {
    ui: getUiText(isZh ? 'zh-CN' : 'en-US'), isZh, isSettingsPage: true, loading: false,
    summary: { databasePath: 'workspace.db', backupRoot: 'backups', documents: 0, blocks: 0, links: 0, lastBackupAt: null },
    aiEndpoint: '', recentDocuments: [], onOpenDocument: noop, uiLanguage: isZh ? 'zh-CN' : 'en-US', onUiLanguageChange: noop,
    aiEnabledDraft: true, onAiEnabledChange: noop, aiAutoSummaryOnSaveDraft: false, onAiAutoSummaryOnSaveChange: noop,
    aiRelatedNotesEnabledDraft: true, onAiRelatedNotesEnabledChange: noop, aiBaseUrlDraft: 'https://example.invalid/v1', onAiBaseUrlChange: noop,
    aiModelDraft: 'unsaved-model', onAiModelChange: noop, aiApiKeyDraft: 'unsaved-key', onAiApiKeyChange: noop, onClearAiApiKey: noop,
    aiSaving: false, aiSaveError: '', aiClearingApiKey: false, onSaveAiConfig: noop, onOpenPlugins: noop, onRestoreBackup: noop, onBackupNow: noop,
    appUpdateState: null, appUpdateRefreshing: false, appUpdateLoading: false, appUpdateLoadError: null,
    appUpdateCheckError: null, appUpdateCanCheck: false, onReloadAppUpdateState: async () => undefined,
    onCheckForAppUpdates: noop, onInstallAppUpdate: noop,
    webClipBridgeStatus: { enabled: false, configuredPort: 4321, port: null, running: false, token: 'saved-token', endpoint: null, lastError: 'Service start error.' },
    webClipBridgeEnabledDraft: true, onWebClipBridgeEnabledChange: noop, webClipBridgePortDraft: '5432',
    webClipBridgePortError: null, onWebClipBridgePortChange: noop, webClipBridgeSaving: false,
    webClipBridgeActionError: null, webClipBridgeRegenerating: false, webClipBridgeLoading: false, webClipBridgeLoadError: null,
    onReloadWebClipBridgeStatus: noop, onSaveWebClipBridgeSettings: noop, onRegenerateWebClipBridgeToken: noop,
    onCopyWebClipBridgeEndpoint: noop, onCopyWebClipBridgeToken: noop
  }
}
function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
type Context = {
  document: Document; window: Window & typeof globalThis; ui: Props['ui'];
  ai: HTMLElement; bridge: HTMLElement;
  patch: (value: Partial<Props>) => Promise<void>; patchNow: (value: Partial<Props>) => void;
  select: (label: string) => Promise<void>; activate: (target: HTMLButtonElement) => Promise<void>;
  edit: (target: HTMLInputElement, value: string) => Promise<void>;
}
async function withSettings(isZh: boolean, run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
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
    await run({ document: dom.window.document, window: dom.window as unknown as Window & typeof globalThis,
      ui: props.ui, ai: dom.window.document.querySelector('.settings-ai-panel')!, bridge: dom.window.document.querySelector('.settings-bridge-panel')!,
      patchNow, patch: async value => { await act(async () => patchNow(value)) },
      select: async label => { await act(async () => button(dom.window.document, label, '[role="tab"]').click()) },
      activate: async target => {
        await act(async () => { target.focus(); target.click() })
        await act(async () => {
          // JSDOM skips blur() when disabled, so simulate Chrome's native disable blur explicitly.
          if (target.disabled && dom.window.document.activeElement === target) { target.disabled = false; target.blur(); target.disabled = true }
        })
      },
      edit: async (target, value) => { await act(async () => {
        target.focus()
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(target, value)
        target.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) }
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
function button(scope: ParentNode, label: string, selector = 'button'): HTMLButtonElement {
  const target = [...scope.querySelectorAll<HTMLButtonElement>(selector)].find(item => item.textContent === label)
  assert.ok(target, `Missing button: ${label}`); return target
}
function assertFocused(document: Document, expected: Element) { assert.ok(document.activeElement === expected, `Unexpected focus ${document.activeElement?.tagName}#${document.activeElement?.id}`) }

test('localized AI and bridge action failures stay by their actions outside busy ancestors and service errors remain separate', async () => {
  for (const isZh of [true, false]) {
    await withSettings(isZh, async context => {
      const { ai, bridge, ui, patch } = context
      await patch({ aiSaveError: `${ui.aiSettingsSaveFailed}\nKeep this draft.`,
        webClipBridgeActionError: { kind: 'regenerate', message: `${ui.webClipBridgeTokenRefreshFailed}\nRetry this action.` } })
      await context.select('AI')
      const aiError = ai.querySelector('.settings-ai-save-error')!
      assert.equal(aiError.getAttribute('role'), 'alert')
      assert.equal(aiError.closest('[aria-busy="true"]'), null)
      assert.ok(aiError.textContent!.includes(ui.aiSettingsSaveFailed))
      assert.equal(ai.querySelector('.settings-action-feedback')!.nextElementSibling?.className, 'settings-actions')
      assert.equal(ai.getAttribute('aria-busy'), null)
      await context.select(isZh ? '网页剪藏' : 'Web clipping')
      const bridgeError = bridge.querySelector('.settings-bridge-action-error')!
      assert.equal(bridgeError.getAttribute('data-action-kind'), 'regenerate')
      assert.equal(bridgeError.getAttribute('role'), 'alert')
      assert.equal(bridgeError.closest('[aria-busy="true"]'), null)
      assert.ok(bridgeError.textContent!.includes(ui.webClipBridgeTokenRefreshFailed))
      assert.doesNotMatch(bridgeError.textContent!, /Service start error/)
      assert.match(bridge.querySelector('.meta-grid')!.textContent!, /Service start error/)
      assert.equal(bridge.querySelectorAll('.settings-form-actions .settings-actions button').length, 2)
      assert.equal(bridge.querySelector('.settings-form-actions')!.contains(bridge.querySelector('input[readonly]')), false)
    })
  }
})

test('AI save failure keeps all displayed drafts and restores its initiating button for a successful retry', async () => {
  await withSettings(false, async context => {
    const requests: Array<ReturnType<typeof deferred>> = []
    const { ai, ui, document, patch, patchNow } = context
    await patch({ onSaveAiConfig: () => {
      const pending = deferred(); requests.push(pending)
      patchNow({ aiSaving: true, aiSaveError: '' })
      return pending.promise.then(() => patchNow({ aiApiKeyDraft: '', aiSaveError: '' }),
        () => patchNow({ aiSaveError: `${ui.aiSettingsSaveFailed} No connection.` }))
        .finally(() => patchNow({ aiSaving: false }))
    } })
    await context.select('AI')
    const save = button(ai, ui.saveAiSettings)
    await context.activate(save)
    assert.equal(ai.querySelector('fieldset')!.disabled, true)
    assert.equal(ai.querySelector('[role="status"]')!.closest('[aria-busy="true"]'), null)
    assert.equal(save.getAttribute('aria-busy'), 'true')
    assertFocused(document, document.body)
    await act(async () => requests[0].reject(new Error('Handled failure')))
    assertFocused(document, save)
    assert.equal(ai.querySelector<HTMLInputElement>('#ai-api-key')!.value, 'unsaved-key')
    assert.equal(ai.querySelectorAll<HTMLInputElement>('input[type="text"]')[1].value, 'unsaved-model')
    assert.match(ai.querySelector('[role="alert"]')!.textContent!, /No connection/)
    await context.activate(save)
    assert.equal(ai.querySelector('.settings-ai-save-error'), null)
    await act(async () => requests[1].resolve())
    assertFocused(document, save)
    assert.equal(ai.querySelector<HTMLInputElement>('#ai-api-key')!.value, '')
    assert.equal(ai.querySelector('.settings-ai-save-error'), null)
    assert.equal(ai.querySelector('[role="status"]'), null, 'The UI must not add a second success message')
  })
})

test('opening a clear-key confirmation leaves existing save feedback until the parent starts clearing', async () => {
  await withSettings(true, async context => {
    let confirmations = 0
    await context.patch({ aiSaveError: '保存 AI 设置失败。请重试。', onClearAiApiKey: () => { confirmations++ } })
    await context.select('AI')
    await act(async () => button(context.ai, context.ui.clearAiApiKey).click())
    assert.equal(confirmations, 1)
    assert.equal(context.ai.querySelector('.settings-ai-save-error')!.textContent, '保存 AI 设置失败。请重试。')
    await context.patch({ aiModelDraft: 'Updated external model' })
    assert.equal(context.ai.querySelector('.settings-ai-save-error')!.textContent, '保存 AI 设置失败。请重试。')
    await context.patch({ aiSaveError: '', aiSaving: true, aiClearingApiKey: true })
    assert.equal(context.ai.querySelector('.settings-ai-save-error'), null)
    assert.match(context.ai.querySelector('[role="status"]')!.textContent!, /正在清除已保存的 API Key/)
    assert.equal(context.ai.querySelector('[role="status"]')!.closest('[aria-busy="true"]'), null)
  })
})

test('invalid bridge drafts still allow independent token rotation and preserve dirty input, failure kind and focus through retry', async () => {
  await withSettings(false, async context => {
    const requests: Array<ReturnType<typeof deferred>> = []
    let saves = 0
    const { bridge, ui, document, patch, patchNow } = context
    await patch({ webClipBridgePortDraft: 'invalid draft', webClipBridgePortError: 'Enter a whole number.', onSaveWebClipBridgeSettings: () => { saves++ },
      onRegenerateWebClipBridgeToken: () => {
        const pending = deferred(); requests.push(pending)
        patchNow({ webClipBridgeSaving: true, webClipBridgeRegenerating: true, webClipBridgeActionError: null })
        return pending.promise.then(() => patchNow({ webClipBridgeActionError: null }),
          () => patchNow({ webClipBridgeActionError: { kind: 'regenerate', message: `${ui.webClipBridgeTokenRefreshFailed} OS storage unavailable.` } }))
          .finally(() => patchNow({ webClipBridgeSaving: false, webClipBridgeRegenerating: false }))
      } })
    await context.select('Web clipping')
    const rotate = button(bridge, ui.webClipBridgeRegenerateToken), save = button(bridge, ui.webClipBridgeSave)
    const port = bridge.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!
    assert.equal(save.disabled, true)
    assert.equal(rotate.disabled, false)
    assert.ok(document.getElementById(rotate.getAttribute('aria-describedby')!)!.textContent!.includes(ui.webClipBridgeRegenerateHint))
    await context.activate(rotate)
    assert.equal(rotate.getAttribute('aria-busy'), 'true')
    assert.equal(save.getAttribute('aria-busy'), 'false')
    assert.equal(bridge.querySelector('fieldset')!.disabled, true)
    assert.equal(bridge.querySelector('.settings-action-feedback [role="status"]')!.textContent, ui.webClipBridgeRegenerating)
    await act(async () => requests[0].reject(new Error('Handled rotation failure')))
    assert.equal(saves, 0)
    assert.equal(port.value, 'invalid draft')
    assertFocused(document, rotate)
    assert.equal(bridge.querySelector('.settings-bridge-action-error')!.getAttribute('data-action-kind'), 'regenerate')
    await context.patch({ webClipBridgeLoading: true, webClipBridgeLoadError: 'Reading status failed.' })
    await context.patch({ webClipBridgeLoading: false })
    assert.match(bridge.querySelector('.settings-bridge-action-error')!.textContent!, /OS storage unavailable/)
    await context.activate(rotate)
    assert.equal(bridge.querySelector('.settings-bridge-action-error'), null)
    await act(async () => requests[1].resolve())
    assertFocused(document, rotate)
    assert.equal(port.value, 'invalid draft')
    assert.equal(bridge.querySelector('.settings-action-feedback [role="status"]'), null)
  })
})

test('bridge save action has its own failure kind and leaves inputs editable after the error', async () => {
  await withSettings(true, async context => {
    const pending = deferred(), { bridge, ui, patchNow } = context
    await context.patch({ onSaveWebClipBridgeSettings: () => {
      patchNow({ webClipBridgeSaving: true, webClipBridgeActionError: null })
      return pending.promise.catch(() => patchNow({ webClipBridgeActionError: { kind: 'save', message: `${ui.webClipBridgeSaveFailed} 无法写入。` } }))
        .finally(() => patchNow({ webClipBridgeSaving: false }))
    }, onWebClipBridgePortChange: value => patchNow({ webClipBridgePortDraft: value }) })
    await context.select('网页剪藏')
    const save = button(bridge, ui.webClipBridgeSave)
    await context.activate(save)
    await act(async () => pending.reject(new Error('Handled save failure')))
    const port = bridge.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!
    assert.equal(port.disabled, false)
    assert.equal(bridge.querySelector('fieldset')!.disabled, false)
    assert.equal(bridge.querySelector('.settings-bridge-action-error')!.getAttribute('data-action-kind'), 'save')
    await context.edit(port, '6543')
    assert.equal(port.value, '6543')
    assertFocused(context.document, port)
    assert.match(bridge.querySelector('.settings-bridge-action-error')!.textContent!, /无法写入/)
    assert.ok(button(bridge, ui.webClipBridgeCopyToken))
    assert.equal(button(bridge, ui.webClipBridgeCopyEndpoint).disabled, true)
  })
})

test('a pending AI save cannot pull focus back from another category when it fails', async () => {
  await withSettings(false, async context => {
    const pending = deferred(), { ui, patchNow } = context
    await context.patch({ onSaveAiConfig: () => {
      patchNow({ aiSaving: true })
      return pending.promise.finally(() => patchNow({ aiSaving: false, aiSaveError: 'Failed to save AI settings.' }))
    } })
    await context.select('AI')
    await context.activate(button(context.ai, ui.saveAiSettings))
    const general = button(context.document, 'General', '[role="tab"]')
    await act(async () => { general.focus(); general.click() })
    await act(async () => pending.resolve())
    assertFocused(context.document, general)
    assert.equal(context.ai.hidden, true)
    await context.select('AI')
    assert.equal(context.ai.querySelector('.settings-ai-save-error')!.textContent, 'Failed to save AI settings.')
  })
})
