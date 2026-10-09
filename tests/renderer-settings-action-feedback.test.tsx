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
    aiSaving: false, aiSaveError: '', aiSettingsDirty: false, onResetAiSettingsDraft: noop, aiClearingApiKey: false, onSaveAiConfig: noop, onOpenPlugins: noop, onRestoreBackup: noop, onBackupNow: noop,
    appUpdateState: null, appUpdateRefreshing: false, appUpdateLoading: false, appUpdateLoadError: null,
    appUpdateCheckError: null, appUpdateCanCheck: false, onReloadAppUpdateState: async () => undefined,
    onCheckForAppUpdates: noop, onInstallAppUpdate: noop,
    webClipBridgeStatus: { enabled: false, configuredPort: 4321, port: null, running: false, token: 'saved-token', endpoint: null, lastError: 'Service start error.' },
    webClipBridgeEnabledDraft: true, onWebClipBridgeEnabledChange: noop, webClipBridgePortDraft: '5432',
    webClipBridgePortError: null, onWebClipBridgePortChange: noop, webClipBridgeSaving: false,
    webClipBridgeActionError: null, webClipBridgeRegenerating: false, webClipBridgeLoading: false, webClipBridgeLoadError: null,
    webClipBridgeCopying: null,
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

function copyField(bridge: ParentNode, kind: 'endpoint' | 'token') {
  const fields = bridge.querySelectorAll<HTMLElement>(`.settings-bridge-copy-actions .settings-bridge-copy-field[data-copy-kind="${kind}"]`)
  assert.equal(fields.length, 1, `Expected one ${kind} field with its own copy control`)
  return fields[0]
}

function copyButton(bridge: ParentNode, kind: 'endpoint' | 'token') {
  const controls = copyField(bridge, kind).querySelectorAll<HTMLButtonElement>('.settings-bridge-copy-button')
  assert.equal(controls.length, 1)
  return controls[0]
}

function tokenControls(bridge: ParentNode) {
  const field = copyField(bridge, 'token')
  const input = field.querySelector<HTMLInputElement>('input')!
  const toggle = field.querySelector<HTMLButtonElement>('.settings-bridge-token-visibility')!
  assert.ok(input)
  assert.ok(toggle)
  return { field, input, toggle }
}

function runningBridgeStatus(token: string): NonNullable<Props['webClipBridgeStatus']> {
  return { enabled: true, configuredPort: 4321, port: 4321, running: true,
    endpoint: 'http://127.0.0.1:4321/clip', token, lastError: null }
}

function assertTokenOnlyInInputValue(bridge: HTMLElement, token: string) {
  for (const element of [bridge, ...bridge.querySelectorAll('*')]) {
    for (const attribute of element.attributes) {
      if (attribute.name === 'title' || attribute.name.startsWith('aria-')) {
        assert.equal(attribute.value.includes(token), false, `The raw token must not appear in ${attribute.name}`)
      }
    }
  }
  for (const live of bridge.querySelectorAll('[role="status"], [role="alert"], [aria-live]')) {
    assert.equal(live.textContent!.includes(token), false, 'The raw token must not enter an announcement')
  }
  assert.equal(bridge.textContent!.includes(token), false, 'Token visibility belongs to its input rather than surrounding text')
}

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
    await patch({ aiSettingsDirty: true, onSaveAiConfig: () => {
      const pending = deferred(); requests.push(pending)
      patchNow({ aiSaving: true, aiSaveError: '' })
      return pending.promise.then(() => patchNow({ aiApiKeyDraft: '', aiSaveError: '', aiSettingsDirty: false }),
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
    assert.equal(ai.querySelector('[role="status"]')?.textContent, 'No unsaved changes.', 'Persistent clean-draft status is distinct from the transient save notification')
  })
})

test('AI discard clears dirty feedback locally, preserves its focus stop and updates status in either language', async () => {
  for (const isZh of [true, false]) await withSettings(isZh, async context => {
    let resets = 0, saves = 0, clears = 0
    const { ai, document, patch, patchNow } = context
    const clean = isZh ? '没有未保存的修改。' : 'No unsaved changes.'
    const unsaved = isZh ? '有未保存的修改，保存后生效。' : 'Unsaved changes. Save to apply.'
    const discardLabel = isZh ? '撤销未保存修改' : 'Discard unsaved changes'
    await patch({ onSaveAiConfig: () => { saves++ }, onClearAiApiKey: () => { clears++ }, onResetAiSettingsDraft: () => {
      resets++
      patchNow({ aiSettingsDirty: false, aiSaveError: '', aiApiKeyDraft: '', aiModelDraft: 'latest-saved-model' })
    } })
    await context.select('AI')
    const discard = button(ai, discardLabel)
    assert.equal(ai.querySelector('[role="status"]')?.textContent, clean)
    assert.equal(discard.disabled, false)
    assert.equal(discard.getAttribute('aria-disabled'), 'true')
    await context.activate(discard)
    assert.equal(resets, 0, 'Clicking an aria-disabled clean-form action does not call reset')
    assertFocused(document, discard)

    const model = ai.querySelectorAll<HTMLInputElement>('input[type="text"]')[1]
    await act(async () => model.focus())
    await patch({ aiSettingsDirty: true, aiSaveError: 'Previous save failed; retain this draft.' })
    assertFocused(document, model)
    assert.equal(ai.querySelector('[role="status"]')?.textContent, unsaved)
    assert.equal(ai.querySelector('[role="status"]')?.closest('[aria-busy="true"]'), null)
    assert.equal(discard.getAttribute('aria-disabled'), 'false')
    assert.match(ai.querySelector('[role="alert"]')!.textContent!, /Previous save failed/)
    assert.equal(ai.querySelector('[role="status"]')?.nextElementSibling, ai.querySelector('[role="alert"]'), 'Dirty feedback precedes a potentially long failure message')
    assert.equal(ai.querySelector('[role="status"]')!.textContent!.includes('unsaved-key'), false)
    await context.activate(discard)
    assert.equal(resets, 1)
    assert.equal(discard.disabled, false)
    assert.equal(discard.getAttribute('aria-disabled'), 'true')
    assertFocused(document, discard)
    assert.equal(ai.querySelectorAll('[role="status"]').length, 1)
    assert.equal(ai.querySelector('[role="status"]')?.textContent, clean)
    assert.equal(ai.querySelector('[role="alert"]'), null)
    assert.equal(ai.querySelector<HTMLInputElement>('#ai-api-key')!.value, '')
    assert.equal(model.value, 'latest-saved-model')
    await context.activate(discard)
    assert.equal(resets, 1, 'A second activation after discarding remains a no-op without losing focus')
    assertFocused(document, discard)

    await patch({ isZh: !isZh, ui: getUiText(isZh ? 'en-US' : 'zh-CN'), uiLanguage: isZh ? 'en-US' : 'zh-CN' })
    assert.equal(ai.querySelector('[role="status"]')?.textContent, isZh ? 'No unsaved changes.' : '没有未保存的修改。')
    assert.equal(button(ai, isZh ? 'Discard unsaved changes' : '撤销未保存修改'), discard)
    assertFocused(document, discard)
    assert.equal(saves, 0)
    assert.equal(clears, 0)
  })
})

test('AI save and key-clear busy states show only progress and block the discard action', async () => {
  for (const isZh of [true, false]) for (const clearing of [false, true]) await withSettings(isZh, async context => {
    let resets = 0
    await context.select('AI')
    await context.patch({ aiSettingsDirty: true, aiSaving: true, aiClearingApiKey: clearing, onResetAiSettingsDraft: () => { resets++ } })
    const discard = button(context.ai, isZh ? '撤销未保存修改' : 'Discard unsaved changes')
    const statuses = context.ai.querySelectorAll('[role="status"]')
    assert.equal(statuses.length, 1)
    assert.equal(statuses[0].textContent, clearing
      ? (isZh ? '正在清除已保存的 API Key…' : 'Clearing the saved API key…')
      : (isZh ? '正在保存 AI 设置…' : 'Saving AI settings…'))
    assert.equal(statuses[0].closest('[aria-busy="true"]'), null)
    assert.equal(context.ai.querySelector('fieldset')!.disabled, true)
    assert.equal(discard.disabled, true)
    assert.equal(discard.getAttribute('aria-disabled'), 'true')
    await act(async () => discard.click())
    assert.equal(resets, 0)
    await context.patch({ aiSaving: false, aiClearingApiKey: false })
    assert.equal(discard.disabled, false)
    assert.equal(discard.getAttribute('aria-disabled'), 'false')
    assert.equal(context.ai.querySelector('[role="status"]')?.textContent,
      isZh ? '有未保存的修改，保存后生效。' : 'Unsaved changes. Save to apply.')
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

test('copy controls require their actual saved values and lock for mutations or either copy operation with accurate localized progress', async () => {
  for (const isZh of [true, false]) {
    await withSettings(isZh, async context => {
      const { bridge, ui, patch } = context
      await context.select(isZh ? '网页剪藏' : 'Web clipping')
      const group = bridge.querySelector('.settings-bridge-copy-actions')!
      assert.equal(bridge.querySelectorAll('.settings-bridge-copy-actions').length, 1)
      assert.equal(group.querySelectorAll('.settings-bridge-copy-button').length, 2)
      const endpoint = copyButton(bridge, 'endpoint'), token = copyButton(bridge, 'token')
      const fields = { endpoint: copyField(bridge, 'endpoint'), token: copyField(bridge, 'token') }
      const feedback = { endpoint: fields.endpoint.querySelector('.settings-bridge-copy-feedback')!,
        token: fields.token.querySelector('.settings-bridge-copy-feedback')! }
      for (const kind of ['endpoint', 'token'] as const) {
        const input = fields[kind].querySelector<HTMLInputElement>('input')!
        assert.ok(input.labels?.length)
        assert.ok(input.labels![0].textContent!.includes(kind === 'endpoint' ? ui.webClipBridgeEndpointLabel : ui.webClipBridgeTokenLabel))
        assert.equal(input.readOnly, true)
        assert.ok(fields[kind].contains(copyButton(bridge, kind)))
        assert.ok(feedback[kind])
        assert.equal(feedback[kind].textContent, '')
        assert.equal(feedback[kind].querySelector('[role="status"]'), null)
        assert.equal(feedback[kind].closest('[aria-busy="true"]'), null)
      }
      assert.equal(endpoint.disabled, true)
      assert.equal(token.disabled, false)
      await patch({ webClipBridgeStatus: null })
      assert.equal(endpoint.disabled, true)
      assert.equal(token.disabled, true)
      await patch({ webClipBridgeStatus: { enabled: true, configuredPort: 4321, port: 4321, running: true,
        endpoint: 'http://127.0.0.1:4321/clip', token: 'saved-token', lastError: null } })
      assert.equal(endpoint.disabled, false)
      assert.equal(token.disabled, false)
      for (const regenerating of [false, true]) {
        await patch({ webClipBridgeSaving: true, webClipBridgeRegenerating: regenerating })
        assert.equal(endpoint.disabled, true)
        assert.equal(token.disabled, true)
        assert.equal(group.querySelector('[role="status"]'), null, 'Mutation progress belongs to its existing mutation feedback')
      }
      for (const kind of ['endpoint', 'token'] as const) {
        await patch({ webClipBridgeSaving: false, webClipBridgeRegenerating: false, webClipBridgeCopying: kind })
        assert.equal(endpoint.disabled, true)
        assert.equal(token.disabled, true)
        assert.equal(endpoint.getAttribute('aria-busy'), String(kind === 'endpoint'))
        assert.equal(token.getAttribute('aria-busy'), String(kind === 'token'))
        assert.equal((kind === 'endpoint' ? endpoint : token).textContent, ui.webClipBridgeCopying)
        assert.equal(group.querySelectorAll('[role="status"]').length, 1)
        assert.equal(feedback[kind].querySelector('[role="status"]')!.textContent, kind === 'endpoint' ? ui.webClipBridgeCopyingEndpoint : ui.webClipBridgeCopyingToken)
        assert.equal(feedback[kind].querySelector('[role="status"]')!.closest('[aria-busy="true"]'), null)
        const other = kind === 'endpoint' ? 'token' : 'endpoint'
        assert.equal(feedback[other].textContent, '')
        assert.equal(feedback[other].querySelector('[role="status"]'), null)
        assert.equal(fields[kind].querySelector('.settings-bridge-copy-feedback'), feedback[kind], 'Each field keeps its feedback slot while its contents change')
        assert.equal(button(bridge, ui.webClipBridgeSave).disabled, false, 'Copying must not lock configuration editing or saving')
        assert.equal(button(bridge, ui.webClipBridgeRegenerateToken).disabled, false)
        assert.equal(bridge.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!.disabled, false)
      }
      await patch({ webClipBridgeCopying: null })
      assert.equal(group.querySelector('[role="status"]'), null)
      assert.equal(endpoint.textContent, ui.webClipBridgeCopyEndpoint)
      assert.equal(token.textContent, ui.webClipBridgeCopyToken)
      assert.equal(fields.endpoint.querySelector('.settings-bridge-copy-feedback'), feedback.endpoint)
      assert.equal(fields.token.querySelector('.settings-bridge-copy-feedback'), feedback.token)
    })
  }
})

test('copy buttons consume their actual deferred handlers and recover focus after success or a handled failure without duplicate success text', async () => {
  for (const kind of ['endpoint', 'token'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      await withSettings(false, async context => {
        const pending = deferred(), { bridge, ui, patchNow } = context
        const calls = { endpoint: 0, token: 0 }
        const copy = (selected: 'endpoint' | 'token') => {
          calls[selected]++
          patchNow({ webClipBridgeCopying: selected })
          return pending.promise.then(() => patchNow({ webClipBridgeCopying: null }), () => patchNow({ webClipBridgeCopying: null }))
        }
        await context.patch({ webClipBridgeStatus: { enabled: true, configuredPort: 4321, port: 4321, running: true,
          endpoint: 'http://127.0.0.1:4321/clip', token: 'saved-token', lastError: null },
          onCopyWebClipBridgeEndpoint: () => copy('endpoint'), onCopyWebClipBridgeToken: () => copy('token') })
        await context.select('Web clipping')
        const group = bridge.querySelector('.settings-bridge-copy-actions')!
        const trigger = copyButton(bridge, kind)
        const otherKind = kind === 'endpoint' ? 'token' : 'endpoint'
        const other = copyButton(bridge, otherKind)
        await context.activate(trigger)
        assert.equal(calls[kind], 1)
        assertFocused(context.document, context.document.body)
        assert.equal(trigger.getAttribute('aria-busy'), 'true')
        assert.equal(other.getAttribute('aria-busy'), 'false')
        assert.equal(copyField(bridge, kind).querySelector('.settings-bridge-copy-feedback [role="status"]')!.textContent,
          kind === 'endpoint' ? ui.webClipBridgeCopyingEndpoint : ui.webClipBridgeCopyingToken)
        assert.equal(copyField(bridge, otherKind).querySelector('.settings-bridge-copy-feedback [role="status"]'), null)
        assert.equal(group.querySelector('[role="status"]')!.closest('[aria-busy="true"]'), null)
        await act(async () => { trigger.click(); other.click() })
        assert.deepEqual(calls, kind === 'endpoint' ? { endpoint: 1, token: 0 } : { endpoint: 0, token: 1 })
        await act(async () => outcome === 'success' ? pending.resolve() : pending.reject(new Error('The action provider handled the clipboard error')))
        assertFocused(context.document, trigger)
        assert.equal(trigger.disabled, false)
        assert.equal(other.disabled, false)
        assert.equal(group.querySelector('[role="status"]'), null)
        assert.doesNotMatch(group.textContent!, /copied|已复制/)
      })
    }
  }
})

test('copy completion preserves a readonly input or category focus after the user moves away', async () => {
  for (const destination of ['readonly-input', 'category'] as const) {
    await withSettings(false, async context => {
      const pending = deferred(), { bridge, ui, patchNow } = context
      await context.patch({ onCopyWebClipBridgeToken: () => {
        patchNow({ webClipBridgeCopying: 'token' })
        return pending.promise.finally(() => patchNow({ webClipBridgeCopying: null }))
      } })
      await context.select('Web clipping')
      await context.activate(copyButton(bridge, 'token'))
      const target = destination === 'readonly-input' ? tokenControls(bridge).input
        : button(context.document, 'General', '[role="tab"]')
      await act(async () => { target.focus(); if (destination === 'category') (target as HTMLButtonElement).click() })
      await act(async () => pending.resolve())
      assertFocused(context.document, target)
      if (destination === 'category') assert.equal(bridge.hidden, true)
      assert.equal(bridge.querySelector('.settings-bridge-copy-feedback [role="status"]'), null)
    })
  }
})

test('token visibility starts masked and localized Show or Hide only changes its readonly input presentation', async () => {
  for (const isZh of [true, false]) {
    await withSettings(isZh, async context => {
      const { bridge, ui } = context
      const token = 'kb-full-token-presentation-47d6b8'
      let configCalls = 0, copyCalls = 0
      const saved = runningBridgeStatus(token)
      await context.patch({ webClipBridgeStatus: saved,
        onSaveWebClipBridgeSettings: () => { configCalls++ }, onRegenerateWebClipBridgeToken: () => { configCalls++ },
        onWebClipBridgeEnabledChange: () => { configCalls++ }, onWebClipBridgePortChange: () => { configCalls++ },
        onCopyWebClipBridgeToken: () => { copyCalls++ }, onCopyWebClipBridgeEndpoint: () => { copyCalls++ } })
      await context.select(isZh ? '网页剪藏' : 'Web clipping')
      const { input, toggle } = tokenControls(bridge)
      assert.equal(input.type, 'password')
      assert.equal(input.readOnly, true)
      assert.equal(input.value, token)
      assert.ok(input.id)
      assert.equal(toggle.getAttribute('aria-controls'), input.id)
      assert.equal(context.document.getElementById(toggle.getAttribute('aria-controls')!), input)
      assert.equal(toggle.textContent, ui.webClipBridgeShowToken)
      assert.equal(toggle.disabled, false)
      assertTokenOnlyInInputValue(bridge, token)
      await context.activate(toggle)
      assert.equal(input.type, 'text')
      assert.equal(input.readOnly, true)
      assert.equal(input.value, token)
      assert.equal(toggle.textContent, ui.webClipBridgeHideToken)
      assertFocused(context.document, toggle)
      assertTokenOnlyInInputValue(bridge, token)
      await context.activate(toggle)
      assert.equal(input.type, 'password')
      assert.equal(input.value, token)
      assert.equal(toggle.textContent, ui.webClipBridgeShowToken)
      assert.equal(copyField(bridge, 'endpoint').querySelector<HTMLInputElement>('input')!.type, 'text')
      assert.equal(copyField(bridge, 'endpoint').querySelector<HTMLInputElement>('input')!.value, saved.endpoint)
      assert.equal(configCalls, 0)
      assert.equal(copyCalls, 0)
      assertTokenOnlyInInputValue(bridge, token)
    })
  }
})

test('same-token status refreshes preserve an explicit reveal but changing or returning to an old token stays masked', async () => {
  await withSettings(false, async context => {
    const original = runningBridgeStatus('original-known-token')
    await context.patch({ webClipBridgeStatus: original })
    await context.select('Web clipping')
    const { input, toggle } = tokenControls(context.bridge)
    await context.activate(toggle)
    assert.equal(input.type, 'text')
    await context.patch({ webClipBridgeLoading: true })
    assert.equal(input.type, 'text')
    await context.patch({ webClipBridgeStatus: { ...original, configuredPort: 5432, port: 5432,
      endpoint: 'http://127.0.0.1:5432/clip' }, webClipBridgeLoading: false })
    assert.equal(input.type, 'text', 'A status poll with the same token must not undo the user reveal')
    assert.equal(input.value, original.token)
    await context.patch({ webClipBridgeStatus: { ...original, token: 'replacement-known-token' } })
    assert.equal(input.value, 'replacement-known-token')
    assert.equal(input.type, 'password')
    assert.equal(toggle.textContent, context.ui.webClipBridgeShowToken)
    await context.patch({ webClipBridgeStatus: { ...original } })
    assert.equal(input.value, original.token)
    assert.equal(input.type, 'password', 'An old value returning later must not resurrect its previous reveal')
    await context.activate(toggle)
    assert.equal(input.type, 'text')
    await context.patch({ webClipBridgeStatus: { ...original, token: 'another-known-token' } })
    await context.patch({ webClipBridgeStatus: { ...original } })
    assert.equal(input.type, 'password')
  })
})

test('unknown or empty tokens disable Show and recover to a masked value when a known token returns', async () => {
  await withSettings(false, async context => {
    await context.select('Web clipping')
    const { input, toggle } = tokenControls(context.bridge)
    await context.activate(toggle)
    assert.equal(input.type, 'text')
    await context.patch({ webClipBridgeStatus: null })
    assert.equal(input.value, '')
    assert.equal(input.type, 'password')
    assert.equal(toggle.disabled, true)
    assert.equal(toggle.textContent, context.ui.webClipBridgeShowToken)
    await act(async () => toggle.click())
    assert.equal(input.type, 'password')
    const known = runningBridgeStatus('known-token-after-read')
    await context.patch({ webClipBridgeStatus: known })
    assert.equal(input.type, 'password')
    assert.equal(input.value, known.token)
    assert.equal(toggle.disabled, false)
    await context.activate(toggle)
    await context.patch({ webClipBridgeStatus: { ...known, token: '' } })
    assert.equal(input.type, 'password')
    assert.equal(input.value, '')
    assert.equal(toggle.disabled, true)
    await act(async () => toggle.click())
    await context.patch({ webClipBridgeStatus: { ...known } })
    assert.equal(input.type, 'password')
    assert.equal(toggle.disabled, false)
  })
})

test('user category navigation and external requests reopen clipping with a masked token and preserved drafts', async () => {
  for (const path of ['click', 'keyboard', 'external-other', 'external-current', 'settings-page'] as const) {
    await withSettings(false, async context => {
      await context.select('Web clipping')
      const initial = tokenControls(context.bridge)
      await context.activate(initial.toggle)
      assert.equal(initial.input.type, 'text')
      if (path === 'click') {
        await context.select('AI')
        await context.select('Web clipping')
      } else if (path === 'keyboard') {
        const clipping = button(context.document, 'Web clipping', '[role="tab"]')
        await act(async () => clipping.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
        const storage = button(context.document, 'Storage & recovery', '[role="tab"]')
        assertFocused(context.document, storage)
        await act(async () => storage.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
      } else if (path === 'external-other') {
        let handled = 0
        const onHandled = () => { handled++ }
        await context.patch({ requestedCategory: 'ai', onCategoryRequestHandled: onHandled })
        assert.equal(context.bridge.hidden, true)
        await context.patch({ requestedCategory: undefined })
        await context.patch({ requestedCategory: 'clipping' })
        assert.equal(handled, 2)
        await context.patch({ requestedCategory: undefined })
      } else if (path === 'external-current') {
        let handled = 0
        await context.patch({ requestedCategory: 'clipping', onCategoryRequestHandled: () => { handled++ } })
        assert.equal(handled, 1, 'A new external request can reopen the current category')
        await context.patch({ requestedCategory: undefined })
      } else {
        await context.patch({ isSettingsPage: false })
        assert.equal(context.document.querySelector('.settings-bridge-panel'), null)
        await context.patch({ isSettingsPage: true })
      }
      const currentBridge = context.document.querySelector<HTMLElement>('.settings-bridge-panel')!
      assert.ok(currentBridge)
      assert.equal(currentBridge.hidden, false)
      const reopened = tokenControls(currentBridge)
      assert.equal(reopened.input.type, 'password', `${path} must not carry over a reveal`)
      assert.equal(reopened.input.value, 'saved-token')
      assert.equal(reopened.toggle.textContent, context.ui.webClipBridgeShowToken)
      assert.equal(currentBridge.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!.value, '5432')
      assert.equal(currentBridge.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]')!.checked, true)
      await context.activate(reopened.toggle)
      assert.equal(reopened.input.type, 'text', 'A consumed navigation request must allow a new explicit reveal')
    })
  }
})

test('visibility remains independent of pending copies and copy completion preserves focus on the visibility button', async () => {
  for (const kind of ['endpoint', 'token'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      await withSettings(false, async context => {
        const pending = deferred(), token = 'pending-copy-display-token'
        const copies = { endpoint: 0, token: 0 }
        let configCalls = 0
        const copy = (selected: 'endpoint' | 'token') => {
          copies[selected]++
          context.patchNow({ webClipBridgeCopying: selected })
          return pending.promise.then(() => context.patchNow({ webClipBridgeCopying: null }),
            () => context.patchNow({ webClipBridgeCopying: null }))
        }
        await context.patch({ webClipBridgeStatus: runningBridgeStatus(token),
          onSaveWebClipBridgeSettings: () => { configCalls++ }, onRegenerateWebClipBridgeToken: () => { configCalls++ },
          onCopyWebClipBridgeToken: () => copy('token'), onCopyWebClipBridgeEndpoint: () => copy('endpoint') })
        await context.select('Web clipping')
        const { input, toggle } = tokenControls(context.bridge)
        await context.activate(toggle)
        assert.equal(input.type, 'text')
        const trigger = copyButton(context.bridge, kind)
        await context.activate(trigger)
        assert.equal(input.type, 'text', 'Starting a copy must not hide the unchanged revealed token')
        assert.equal(toggle.disabled, false)
        assert.equal(copyButton(context.bridge, 'endpoint').disabled, true)
        assert.equal(copyButton(context.bridge, 'token').disabled, true)
        assert.equal(context.bridge.querySelectorAll('.settings-bridge-copy-actions .settings-bridge-copy-button').length, 2)
        assert.equal(context.bridge.querySelectorAll('.settings-bridge-copy-actions button').length, 3)
        await context.activate(toggle)
        assert.equal(input.type, 'password')
        await context.activate(toggle)
        assert.equal(input.type, 'text')
        assert.equal(input.value, token)
        assert.equal(input.readOnly, true)
        assertFocused(context.document, toggle)
        assert.equal(copyField(context.bridge, kind).querySelector('.settings-bridge-copy-feedback [role="status"]')!.closest('[aria-busy="true"]'), null)
        assertTokenOnlyInInputValue(context.bridge, token)
        assert.deepEqual(copies, kind === 'endpoint' ? { endpoint: 1, token: 0 } : { endpoint: 0, token: 1 })
        assert.equal(configCalls, 0)
        await act(async () => outcome === 'success' ? pending.resolve() : pending.reject(new Error('Handled clipboard failure')))
        assertFocused(context.document, toggle)
        assert.equal(input.type, 'text')
        assert.equal(context.bridge.querySelector('.settings-bridge-copy-feedback [role="status"]'), null)
        assert.equal(copyButton(context.bridge, 'endpoint').disabled, false)
        assert.equal(copyButton(context.bridge, 'token').disabled, false)
        assert.deepEqual(copies, kind === 'endpoint' ? { endpoint: 1, token: 0 } : { endpoint: 0, token: 1 })
        assert.equal(configCalls, 0)
      })
    }
  }
})
