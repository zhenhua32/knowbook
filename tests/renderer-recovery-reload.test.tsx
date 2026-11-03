import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React, { act, useState } from 'react'
import { JSDOM, VirtualConsole } from 'jsdom'
import type { ElectronApi } from '../src/shared/contracts'
import { RecoveryState } from '../src/renderer/src/components/RecoveryState'
import { getActiveUiText, setActiveUiLanguage, type UiLanguage } from '../src/renderer/src/i18n'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
// Use the actual confirmation component for the separate safe-mode action.
await import('../src/renderer/src/components/showConfirmation')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

type Context = {
  document: Document
  reload: () => HTMLButtonElement
  button: (label: string) => HTMLButtonElement
  draft: () => string
  updateDraft: (value: string) => void
  actionError: () => HTMLParagraphElement | null
  assertNoDirectNavigation: () => void
}

async function withRecovery(api: Partial<ElectronApi>, language: UiLanguage, run: (context: Context) => Promise<void>,
  settlePending: () => void = () => undefined) {
  const virtualConsole = new VirtualConsole(), browserErrors: Error[] = []
  // Calling JSDOM's actual location.reload emits a navigation-not-implemented
  // error. Observe that behavior without replacing the production handler or
  // trying to redefine Location's nonconfigurable browser methods.
  virtualConsole.on('jsdomError', error => browserErrors.push(error))
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/retained-editor', virtualConsole })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  const previous = new Map<string, PropertyDescriptor | undefined>(), previousLanguage = getActiveUiText().language
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  setActiveUiLanguage(language)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  let updateDraft!: (value: string) => void
  function RetainedEditor() {
    const [draft, setDraft] = useState('Original unsaved W 中文🙂')
    updateDraft = setDraft
    return <>
      <textarea aria-label="Retained editor draft" value={draft} onChange={event => setDraft(event.target.value)} />
      <RecoveryState title="Editor recovery" description="The original recovery context remains visible."
        error={new Error('Original diagnostic bytes')} onRetry={() => undefined} allowRestart />
    </>
  }
  const button = (label: string) => {
    const found = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label)
    assert.ok(found, 'The actual recovery/confirmation button must exist: ' + label)
    return found
  }
  try {
    await act(async () => root.render(<RetainedEditor />))
    await run({ document: dom.window.document,
      reload: () => button(language === 'zh-CN' ? '重新加载界面' : 'Reload interface'), button,
      draft: () => dom.window.document.querySelector<HTMLTextAreaElement>('textarea')!.value,
      updateDraft: value => updateDraft(value),
      actionError: () => dom.window.document.querySelector<HTMLParagraphElement>('.recovery-state > p[role="alert"]'),
      assertNoDirectNavigation: () => {
        assert.deepEqual(browserErrors.map(error => error.message), [], 'No renderer-owned Location navigation may replace typed Main admission')
        assert.equal(dom.window.location.href, 'http://localhost/retained-editor')
      } })
  } finally {
    await act(async () => {
      settlePending()
      // Settle the real separate confirmation root on a failed assertion too.
      const cancel = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
        .find(item => item.textContent === (language === 'zh-CN' ? '取消' : 'Cancel'))
      cancel?.click()
    })
    await act(async () => root.unmount())
    setActiveUiLanguage(previousLanguage)
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('the actual recovery Reload button uses one typed admission while pending and never treats true as a renderer reload or save acknowledgement', async () => {
  const pending = deferred<boolean>()
  let calls = 0, restarts = 0
  await withRecovery({ requestEditorReload: () => { calls++; return pending.promise },
    restartInSystemPluginSafeMode: async () => { restarts++ } }, 'en-US', async context => {
    const { document, reload } = context
    await act(async () => { reload().click(); reload().click() })
    assert.equal(calls, 1, 'The ref lock covers two activations before React renders disabled')
    assert.equal(reload().disabled, true)
    assert.equal(document.querySelector('.recovery-state')!.getAttribute('aria-busy'), 'true')
    assert.equal(context.button('Working…').disabled, true)
    assert.equal(document.querySelector('[role="alertdialog"]'), null, 'Ordinary reload must not open the old discard confirmation')
    await act(async () => context.updateDraft('Newer unsaved W while admission is pending 中文🙂'))
    await act(async () => reload().click())
    assert.equal(calls, 1)
    await act(async () => pending.resolve(true))
    assert.equal(reload().disabled, false)
    assert.equal(document.querySelector('.recovery-state')!.getAttribute('aria-busy'), 'false')
    assert.equal(context.actionError(), null)
    assert.equal(context.draft(), 'Newer unsaved W while admission is pending 中文🙂')
    assert.equal(restarts, 0)
    context.assertNoDirectNavigation()
  }, () => pending.resolve(false))
})

test('a refused recovery reload shows its localized blocked message, retains the complete outside draft and retries through Main with the old error cleared', async () => {
  for (const language of ['en-US', 'zh-CN'] as const) {
    const requests: Array<ReturnType<typeof deferred<boolean>>> = []
    await withRecovery({ requestEditorReload: () => { const request = deferred<boolean>(); requests.push(request); return request.promise } }, language, async context => {
      await act(async () => context.updateDraft('Retained full working state\n二行中文🙂'))
      await act(async () => context.reload().click())
      assert.equal(requests.length, 1)
      await act(async () => requests[0].resolve(false))
      assert.equal(context.actionError()?.textContent, language === 'zh-CN'
        ? '当前编辑会话无法安全重载，草稿仍保留。' : 'The current editor cannot reload safely; drafts remain retained.')
      assert.equal(context.actionError()?.getAttribute('role'), 'alert')
      assert.equal(context.reload().disabled, false)
      assert.equal(context.draft(), 'Retained full working state\n二行中文🙂')
      assert.match(context.document.querySelector('.recovery-details')!.textContent!, /Original diagnostic bytes/)
      await act(async () => context.reload().click())
      assert.equal(requests.length, 2)
      assert.equal(context.actionError(), null)
      assert.equal(context.reload().disabled, true)
      await act(async () => requests[1].resolve(true))
      assert.equal(context.draft(), 'Retained full working state\n二行中文🙂')
      assert.equal(context.document.querySelector('[role="alertdialog"]'), null)
      context.assertNoDirectNavigation()
    }, () => requests.forEach(request => request.resolve(false)))
  }
})

test('a rejected or unavailable typed reload surfaces an action error and cannot fall back to Location.reload or discard the retained editor', async () => {
  let calls = 0
  const reason = 'Could not reload the registered editor.\nThe original W remains available.'
  const api: Partial<ElectronApi> = { requestEditorReload: async () => {
    calls++
    throw new Error("Error invoking remote method 'knowbook:request-editor-reload': Error: " + reason)
  } }
  await withRecovery(api, 'en-US', async context => {
    const original = context.draft()
    await act(async () => context.reload().click())
    assert.equal(calls, 1)
    assert.equal(context.actionError()?.textContent, reason)
    assert.equal(context.draft(), original)
    assert.equal(context.reload().disabled, false)
    context.assertNoDirectNavigation()
    delete api.requestEditorReload
    await act(async () => context.reload().click())
    assert.equal(calls, 1)
    assert.match(context.actionError()?.textContent ?? '', /requestEditorReload/)
    assert.equal(context.reload().disabled, false)
    assert.equal(context.draft(), original)
    assert.equal(context.document.querySelector('[role="alertdialog"]'), null)
    context.assertNoDirectNavigation()
  })
})

test('cancelling the actual safe-mode confirmation preserves outside W and releases the action lock for a separate typed recovery reload', async () => {
  let restarts = 0, reloads = 0
  await withRecovery({ requestEditorReload: async () => { reloads++; return true },
    restartInSystemPluginSafeMode: async () => { restarts++ } }, 'en-US', async context => {
    await act(async () => context.updateDraft('Original draft retained across confirmation cancellation 中文🙂'))
    await act(async () => context.button('Restart in safe mode').click())
    // The void click action crosses a dynamic import before rendering its separate root.
    // Wait for the actual mounted/open dialog within the existing recovery test budget.
    for (let attempt = 0; attempt < 100 && !context.document.querySelector('[role="alertdialog"][open]'); attempt++) {
      await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 10)) })
    }
    const confirmation = context.document.querySelector('[role="alertdialog"][open]')
    assert.ok(confirmation, 'The separate safe-mode action uses the genuine confirmation component')
    assert.match(confirmation.textContent!, /Unsaved changes may be lost/)
    assert.equal(restarts, 0)
    assert.equal(reloads, 0)
    await act(async () => context.button('Cancel').click())
    assert.equal(context.document.querySelector('[role="alertdialog"]'), null)
    assert.equal(context.draft(), 'Original draft retained across confirmation cancellation 中文🙂')
    assert.equal(context.reload().disabled, false)
    await act(async () => context.reload().click())
    assert.equal(reloads, 1)
    assert.equal(restarts, 0)
    assert.equal(context.draft(), 'Original draft retained across confirmation cancellation 中文🙂')
    assert.equal(context.document.querySelector('[role="alertdialog"]'), null)
    context.assertNoDirectNavigation()
  })
})
