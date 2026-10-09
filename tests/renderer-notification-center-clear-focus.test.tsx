import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, Fragment, useRef, useState, useSyncExternalStore } from 'react'
import { JSDOM } from 'jsdom'
import { appNotifications } from '../src/renderer/src/app-notifications'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: AppNotificationList } = await import('../src/renderer/src/components/AppNotificationList')

type Context = {
  document: Document
  outside: HTMLButtonElement
  bell: () => HTMLButtonElement
  center: () => HTMLDialogElement
  clear: () => HTMLButtonElement
  close: () => HTMLButtonElement
  card: (id: number) => HTMLElement
  open: () => Promise<void>
  change: (run: () => void) => Promise<void>
  cancel: () => Promise<void>
}

function clearStore() {
  const ids = new Set([...appNotifications.getSnapshot(), ...appNotifications.getHistorySnapshot()].map(item => item.id))
  for (const id of ids) appNotifications.dismiss(id)
  appNotifications.clearCompleted()
}

async function withCenter(run: (context: Context) => Promise<void>, isZh = false) {
  clearStore()
  const dom = new JSDOM('<div id="mount"></div><button id="outside">Workspace control</button>', { url: 'http://localhost' })
  const { document } = dom.window
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  dom.window.matchMedia = query => ({ matches: false, media: query,
    addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList

  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) {
    if (this.closest('dialog:not([open])')) return
    nativeFocus.call(this, options)
  }
  // JSDOM has no modal lifecycle or native Tab loop. Supply opening/closing
  // only; all later focus changes must come from the actual component.
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
    this.querySelector<HTMLButtonElement>('.app-notification-close')?.focus()
  }
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }

  const noop = () => {}
  function HostFixture() {
    const notifications = useSyncExternalStore(appNotifications.subscribe, appNotifications.getSnapshot)
    const history = useSyncExternalStore(appNotifications.subscribe, appNotifications.getHistorySnapshot)
    const [open, setOpen] = useState(false)
    const bellRef = useRef<HTMLButtonElement>(null)
    return createElement(Fragment, null,
      createElement('button', { ref: bellRef, className: 'notification-bell', onClick: () => setOpen(true) }, 'Notification center'),
      (open || notifications.length > 0) ? createElement(AppNotificationList, {
        notifications, history, open, isZh, onDismiss: appNotifications.hide,
        onClose: () => setOpen(false), onOpenDocument: noop, returnFocusRef: bellRef
      }) : null)
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const center = () => {
    const dialog = document.querySelector<HTMLDialogElement>('.notification-center[open]')
    assert.ok(dialog, 'The notification center must remain open')
    return dialog
  }
  const bell = () => document.querySelector<HTMLButtonElement>('.notification-bell')!
  try {
    await change(() => root.render(createElement(HostFixture)))
    await run({ document, outside: document.getElementById('outside') as HTMLButtonElement,
      bell, center, change,
      clear: () => center().querySelector<HTMLButtonElement>('.notification-center-toolbar button')!,
      close: () => center().querySelector<HTMLButtonElement>('.notification-center-header .app-notification-close')!,
      card: id => {
        const card = center().querySelector<HTMLElement>(`.app-notification[data-notification-id="${id}"]`)
        assert.ok(card, `The retained task ${id} must remain in the notification center`)
        return card
      },
      open: () => change(() => { bell().focus(); bell().click() }),
      // Native Escape emits cancel; this exercises React's close lifecycle
      // without pretending that JSDOM implements native Escape behavior.
      cancel: () => change(() => center().dispatchEvent(new dom.window.Event('cancel', { bubbles: true, cancelable: true }))) })
  } finally {
    await change(() => root.unmount())
    clearStore()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

async function completed(context: Context) {
  await context.change(() => {
    appNotifications.show({ title: 'Saved result', message: 'Original saved result.', level: 'success', persistent: true })
    appNotifications.show({ title: 'Failure reason', message: 'Original failure reason.\n原始内容保持不变。', level: 'error' })
  })
}

test('clearing focused completed notifications leaves the same center open with a usable Close continuation', async () => {
  for (const isZh of [false, true]) {
    await withCenter(async context => {
      await completed(context)
      await context.open()
      const dialog = context.center()
      const close = context.close()
      const clear = context.clear()
      assert.equal(clear.disabled, false)
      assert.equal(clear.textContent, isZh ? '清除已结束通知' : 'Clear completed')
      await context.change(() => clear.focus())
      assert.ok(context.document.activeElement === clear, 'Clear must own focus before activation')
      await context.change(() => clear.click())
      assert.ok(context.center() === dialog, 'clearing records must preserve the existing open dialog')
      assert.ok(context.clear() === clear && clear.disabled, 'the same Clear control must become disabled')
      assert.ok(context.close() === close && !close.disabled, 'the existing Close control must remain usable')
      assert.equal(dialog.querySelectorAll('.app-notification').length, 0)
      assert.ok(dialog.querySelector('.notification-center-empty'))
      assert.equal(appNotifications.getHistorySnapshot().length, 0)
      assert.equal(appNotifications.getSnapshot().length, 0)
      // JSDOM leaves a disabled focused button active; require the actual
      // component to provide a usable continuation, independent of BODY quirks.
      assert.ok(context.document.activeElement === close, 'keyboard focus must continue on Close after Clear disables itself')
      await context.change(() => close.click())
      assert.equal(context.document.querySelector('.notification-center'), null)
      assert.ok(context.document.activeElement === context.bell(), 'closing the center must retain its existing return-focus behavior')
    }, isZh)
  }
})

test('clearing completed records preserves running task data and never cancels it, including center cancellation', async () => {
  await withCenter(async context => {
    let cancelled = 0
    await context.change(() => {
      appNotifications.show({ title: 'Running export', message: 'Writing file 37.', level: 'progress',
        progress: 37, progressLabel: '37 files written', actions: [{ label: 'Cancel task', run: () => { cancelled++ } }] })
    })
    const id = appNotifications.getHistorySnapshot()[0].id
    await completed(context)
    await context.open()
    const task = appNotifications.getHistorySnapshot().find(item => item.id === id)!
    const card = context.card(id)
    const clear = context.clear()
    await context.change(() => clear.focus())
    await context.change(() => clear.click())
    assert.deepEqual(appNotifications.getHistorySnapshot(), [task], 'only completed records may be removed')
    assert.ok(context.card(id) === card, 'the running task must keep its original card')
    assert.equal(card.querySelector('progress')!.value, 37)
    assert.equal(card.querySelector('.app-notification-meter span')!.textContent, '37 files written')
    assert.equal(card.querySelector('.app-notification-message')!.textContent, 'Writing file 37.')
    assert.equal(card.querySelector<HTMLButtonElement>('.app-notification-actions button')!.disabled, false)
    assert.equal(cancelled, 0)
    assert.equal(clear.disabled, true)
    assert.ok(context.document.activeElement === context.close(), 'the same Close continuation applies when running records remain')
    await context.cancel()
    assert.equal(context.document.querySelector('.notification-center'), null)
    assert.ok(context.document.activeElement === context.bell())
    assert.deepEqual(appNotifications.getHistorySnapshot(), [task], 'cancelling the dialog must not cancel or alter a running task')
    assert.equal(cancelled, 0)
  })
})

test('activating an unfocused Clear leaves an external focus owner untouched', async () => {
  await withCenter(async context => {
    await completed(context)
    await context.open()
    const clear = context.clear()
    await context.change(() => context.outside.focus())
    await context.change(() => clear.click())
    assert.equal(clear.disabled, true)
    assert.equal(appNotifications.getHistorySnapshot().length, 0)
    assert.ok(context.center().open)
    assert.ok(context.document.activeElement === context.outside, 'an activation without Clear-owned focus must not claim external focus')
  })
})

test('programmatic clearing preserves the external, Close or task action focus that owns the interaction', async () => {
  for (const owner of ['outside', 'close', 'task-action'] as const) {
    await withCenter(async context => {
      let cancelled = 0
      await context.change(() => {
        appNotifications.show({ title: 'Still running', message: 'Keep the task unchanged.', level: 'progress', progress: 24,
          actions: [{ label: 'Cancel task', run: () => { cancelled++ } }] })
      })
      const id = appNotifications.getHistorySnapshot()[0].id
      await completed(context)
      await context.open()
      const task = appNotifications.getHistorySnapshot().find(item => item.id === id)!
      const active = owner === 'outside' ? context.outside : owner === 'close' ? context.close()
        : context.card(id).querySelector<HTMLButtonElement>('.app-notification-actions button')!
      await context.change(() => active.focus())
      await context.change(() => appNotifications.clearCompleted())
      assert.equal(context.clear().disabled, true)
      assert.deepEqual(appNotifications.getHistorySnapshot(), [task])
      assert.equal(cancelled, 0)
      assert.ok(context.document.activeElement === active, 'a store change without a focused Clear activation must not relocate another interaction')
    })
  }
})

test('synchronous notification subscribers can transfer focus outside during Clear without it being reclaimed', async () => {
  await withCenter(async context => {
    await completed(context)
    await context.open()
    const clear = context.clear()
    await context.change(() => clear.focus())
    let transfers = 0
    let armed = true
    const unsubscribe = appNotifications.subscribe(() => {
      if (!armed) return
      armed = false
      transfers++
      context.outside.focus()
    })
    try {
      await context.change(() => clear.click())
      assert.equal(transfers, 1, 'the real store must synchronously deliver the external focus transfer')
      assert.equal(clear.disabled, true)
      assert.equal(appNotifications.getHistorySnapshot().length, 0)
      assert.ok(context.center().open)
      assert.ok(context.document.activeElement === context.outside, 'Clear must not override a subscriber that moved focus during the operation')
    } finally {
      unsubscribe()
    }
  })
})

test('a retained task can update and finish after clearing, re-enabling Clear without stealing outside focus', async () => {
  await withCenter(async context => {
    let task!: ReturnType<typeof appNotifications.show>
    await context.change(() => { task = appNotifications.show({ title: 'Exporting', message: 'Writing local files.', level: 'progress', progress: 15 }) })
    const id = appNotifications.getHistorySnapshot()[0].id
    await completed(context)
    await context.open()
    const clear = context.clear()
    await context.change(() => { clear.focus(); clear.click() })
    assert.equal(clear.disabled, true)
    assert.ok(context.document.activeElement === context.close())
    await context.change(() => context.outside.focus())
    await context.change(() => task.update({ title: 'Exporting', message: 'Writing file 66.', level: 'progress', progress: 66, progressLabel: '66 files written' }))
    assert.equal(clear.disabled, true)
    assert.equal(context.card(id).querySelector('progress')!.value, 66)
    assert.ok(context.document.activeElement === context.outside, 'a running task update must preserve the current focus owner')
    await context.change(() => task.update({ title: 'Export complete', message: 'All local files written.', level: 'success' }))
    assert.ok(context.clear() === clear && !clear.disabled, 'the retained task completion must re-enable the existing Clear control')
    assert.deepEqual(appNotifications.getHistorySnapshot().map(item => item.id), [id])
    assert.equal(context.card(id).querySelector('.app-notification-message')!.textContent, 'All local files written.')
    assert.ok(context.document.activeElement === context.outside, 'a new completion must not automatically focus Clear or Close')
    await context.change(() => { clear.focus(); clear.click() })
    assert.equal(clear.disabled, true)
    assert.equal(appNotifications.getHistorySnapshot().length, 0)
    assert.ok(context.document.activeElement === context.close(), 'the next explicit clear must again provide a usable continuation')
  })
})

test('fresh completed history re-enables the same Clear control while preserving Close focus', async () => {
  await withCenter(async context => {
    await completed(context)
    await context.open()
    const close = context.close()
    const clear = context.clear()
    await context.change(() => { clear.focus(); clear.click() })
    assert.equal(clear.disabled, true)
    assert.ok(context.document.activeElement === close)
    await context.change(() => { appNotifications.show({ title: 'New completed result', message: 'A later result is still available.', level: 'success' }) })
    const records = appNotifications.getHistorySnapshot()
    assert.equal(records.length, 1)
    assert.equal(records[0].title, 'New completed result')
    assert.ok(context.clear() === clear && !clear.disabled)
    assert.ok(context.document.activeElement === close, 'new history must not relocate focus from a usable Close control')
    await context.change(() => { clear.focus(); clear.click() })
    assert.equal(appNotifications.getHistorySnapshot().length, 0)
    assert.ok(context.document.activeElement === close)
  })
})
