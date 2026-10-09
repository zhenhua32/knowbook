import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, Fragment, useRef, useSyncExternalStore } from 'react'
import { JSDOM } from 'jsdom'
import { AppNotificationStore } from '../src/renderer/src/app-notifications'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: AppNotificationList } = await import('../src/renderer/src/components/AppNotificationList')

type Context = {
  document: Document
  store: AppNotificationStore
  outside: HTMLButtonElement
  bell: () => HTMLButtonElement
  dismissButton: (id: number) => HTMLButtonElement
  dismissed: number[]
  change: (run: () => void) => Promise<void>
  advance: (milliseconds: number) => Promise<void>
}

async function withNotifications(run: (context: Context) => Promise<void>, options: { redirectOnDismiss?: boolean } = {}) {
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
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 160, 32) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rects = this.closest('[hidden], [inert]') ? [] : [this.getBoundingClientRect()]
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList
  }

  // Virtualize notification expiry only; module loading and React retain their native timers.
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let time = 0
  let nextTimer = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 6_000) return originalSetTimeout(callback, delay, ...args)
    const id = ++nextTimer
    timers.set(id, { at: time + delay, run: () => callback(...args) })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof globalThis.setTimeout
  globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
    if (typeof timer === 'number' && timers.delete(timer)) return
    originalClearTimeout(timer)
  }) as typeof globalThis.clearTimeout

  const store = new AppNotificationStore()
  const outside = document.getElementById('outside') as HTMLButtonElement
  const dismissed: number[] = []
  const onDismiss = (id: number) => {
    dismissed.push(id)
    store.hide(id)
    if (options.redirectOnDismiss) outside.focus()
  }
  const noop = () => {}
  function HostFixture() {
    const notifications = useSyncExternalStore(store.subscribe, store.getSnapshot)
    const history = useSyncExternalStore(store.subscribe, store.getHistorySnapshot)
    const bellRef = useRef<HTMLButtonElement>(null)
    return createElement(Fragment, null,
      createElement('button', { ref: bellRef, className: 'notification-bell' }, 'Notification center'),
      // The real Host removes the entire List when the final toast disappears.
      notifications.length > 0 ? createElement(AppNotificationList, {
        notifications, history, open: false, isZh: false, onDismiss,
        onClose: noop, onOpenDocument: noop, returnFocusRef: bellRef
      }) : null)
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  try {
    await change(() => root.render(createElement(HostFixture)))
    await run({ document, store, outside, dismissed, change,
      bell: () => document.querySelector<HTMLButtonElement>('.notification-bell')!,
      dismissButton: id => {
        const button = document.querySelector<HTMLButtonElement>(`.app-notification[data-notification-id="${id}"] .app-notification-close`)
        assert.ok(button, `Notification ${id} must expose its close button`)
        return button
      },
      advance: milliseconds => change(() => {
        time += milliseconds
        for (const [id, timer] of [...timers].sort((left, right) => left[1].at - right[1].at)) {
          if (timer.at <= time && timers.delete(id)) timer.run()
        }
      }) })
  } finally {
    await change(() => root.unmount())
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

async function showErrors(context: Context, count = 3) {
  await context.change(() => {
    for (let index = 1; index <= count; index++) context.store.show({ title: `Retained notification ${index}`,
      message: `Original reason ${index}\n原始通知内容 ${index}`, level: 'error' })
  })
  return context.store.getSnapshot().map(item => item.id)
}

function historyContents(store: AppNotificationStore) {
  return store.getHistorySnapshot().map(({ id, title, message }) => ({ id, title, message }))
}

test('closing the focused middle toast continues on the next notification close button and retains history', async () => {
  await withNotifications(async context => {
    const ids = await showErrors(context)
    const history = historyContents(context.store)
    const previous = context.dismissButton(ids[0])
    const closing = context.dismissButton(ids[1])
    const next = context.dismissButton(ids[2])
    await context.change(() => closing.focus())
    assert.ok(context.document.activeElement === closing, 'the closing notification must own keyboard focus')
    await context.change(() => closing.click())
    assert.equal(closing.isConnected, false)
    assert.ok(context.dismissButton(ids[0]) === previous, 'the earlier notification keeps its original DOM control')
    assert.ok(context.dismissButton(ids[2]) === next, 'the next notification keeps its original DOM control')
    assert.deepEqual(context.store.getSnapshot().map(item => item.id), [ids[0], ids[2]])
    assert.deepEqual(context.dismissed, [ids[1]])
    assert.ok(context.document.activeElement === next, 'dismissal must preserve keyboard continuation on the next notification')
    assert.deepEqual(historyContents(context.store), history)
  })
})

test('closing the focused tail toast falls back to the previous notification close button', async () => {
  await withNotifications(async context => {
    const ids = await showErrors(context)
    const history = historyContents(context.store)
    const previous = context.dismissButton(ids[1])
    const closing = context.dismissButton(ids[2])
    await context.change(() => closing.focus())
    await context.change(() => closing.click())
    assert.equal(closing.isConnected, false)
    assert.ok(context.dismissButton(ids[1]) === previous, 'the previous notification keeps its original DOM control')
    assert.deepEqual(context.store.getSnapshot().map(item => item.id), ids.slice(0, 2))
    assert.ok(context.document.activeElement === previous, 'the previous notification must provide a keyboard continuation')
    assert.deepEqual(historyContents(context.store), history)
  })
})

test('closing the final focused toast returns to the stable bell after the entire list unmounts', async () => {
  await withNotifications(async context => {
    const [id] = await showErrors(context, 1)
    const history = historyContents(context.store)
    const bell = context.bell()
    const list = context.document.querySelector('.app-notifications')!
    const closing = context.dismissButton(id)
    await context.change(() => closing.focus())
    await context.change(() => closing.click())
    assert.equal(closing.isConnected, false)
    assert.equal(list.isConnected, false, 'the fixture must actually unmount the final toast list')
    assert.equal(context.document.querySelector('.app-notifications'), null)
    assert.ok(context.bell() === bell && bell.isConnected, 'the notification entry must survive list removal')
    assert.ok(context.document.activeElement === bell, 'the final dismissal must return keyboard focus to the stable entry')
    assert.equal(context.store.getSnapshot().length, 0)
    assert.deepEqual(historyContents(context.store), history)
  })
})

test('an unfocused explicit close preserves the workspace focus with multiple or final toasts', async () => {
  for (const count of [2, 1]) {
    await withNotifications(async context => {
      const ids = await showErrors(context, count)
      const history = historyContents(context.store)
      const closing = context.dismissButton(ids[0])
      await context.change(() => context.outside.focus())
      await context.change(() => closing.click())
      assert.equal(closing.isConnected, false)
      assert.deepEqual(context.store.getSnapshot().map(item => item.id), ids.slice(1))
      assert.ok(context.document.activeElement === context.outside, 'a close without notification-owned focus must leave the workspace alone')
      assert.deepEqual(historyContents(context.store), history)
    })
  }
})

test('ordinary toast expiry preserves outside focus and retained history when its list disappears', async () => {
  await withNotifications(async context => {
    await context.change(() => { context.store.show({ title: 'Saved', message: 'Original saved result', level: 'success' }) })
    const [id] = context.store.getSnapshot().map(item => item.id)
    const history = historyContents(context.store)
    const closing = context.dismissButton(id)
    await context.change(() => context.outside.focus())
    await context.advance(5_999)
    assert.equal(closing.isConnected, true)
    await context.advance(1)
    assert.equal(closing.isConnected, false)
    assert.equal(context.document.querySelector('.app-notifications'), null)
    assert.deepEqual(context.dismissed, [id])
    assert.ok(context.document.activeElement === context.outside, 'automatic expiry must never send workspace focus into notification controls')
    assert.deepEqual(historyContents(context.store), history)
  })
})

test('programmatically hiding a toast does not claim outside focus or discard notification history', async () => {
  await withNotifications(async context => {
    const ids = await showErrors(context, 2)
    const history = historyContents(context.store)
    await context.change(() => context.outside.focus())
    await context.change(() => context.store.hide(ids[0]))
    assert.deepEqual(context.store.getSnapshot().map(item => item.id), [ids[1]])
    assert.deepEqual(context.dismissed, [], 'programmatic hiding must not pretend that the user activated a close button')
    assert.ok(context.document.activeElement === context.outside, 'background removal must preserve the workspace focus')
    assert.deepEqual(historyContents(context.store), history)
  })
})

test('a close callback that moves focus outside synchronously retains ownership of that new focus', async () => {
  await withNotifications(async context => {
    const ids = await showErrors(context, 2)
    const history = historyContents(context.store)
    const closing = context.dismissButton(ids[0])
    await context.change(() => closing.focus())
    await context.change(() => closing.click())
    assert.equal(closing.isConnected, false)
    assert.deepEqual(context.dismissed, [ids[0]])
    assert.deepEqual(context.store.getSnapshot().map(item => item.id), [ids[1]])
    assert.ok(context.document.activeElement === context.outside, 'dismissal must not reclaim focus moved by its callback')
    assert.deepEqual(historyContents(context.store), history)
  }, { redirectOnDismiss: true })
})

test('updating another ordinary notification does not restart the original toast expiry clock', async () => {
  await withNotifications(async context => {
    let later!: ReturnType<AppNotificationStore['show']>
    await context.change(() => {
      context.store.show({ title: 'First saved result', message: 'Keep the first expiry deadline', level: 'success' })
      later = context.store.show({ title: 'Later information', message: 'The second notice may update', level: 'info' })
    })
    const ids = context.store.getSnapshot().map(item => item.id)
    const first = context.dismissButton(ids[0])
    const second = context.dismissButton(ids[1])
    await context.change(() => context.outside.focus())
    await context.advance(5_000)
    await context.change(() => later.update({ title: 'Updated later information', message: 'Only this notice changed', level: 'info' }))
    const history = historyContents(context.store)
    await context.advance(999)
    assert.equal(first.isConnected, true)
    await context.advance(1)
    assert.equal(first.isConnected, false, 'the unchanged toast must expire at its original six-second deadline')
    assert.ok(context.dismissButton(ids[1]) === second && second.isConnected, 'the updated notification retains its own fresh deadline')
    assert.deepEqual(context.store.getSnapshot().map(item => item.id), [ids[1]])
    assert.deepEqual(context.dismissed, [ids[0]])
    assert.ok(context.document.activeElement === context.outside, 'independent expiry must leave outside keyboard focus alone')
    assert.deepEqual(historyContents(context.store), history)
  })
})
