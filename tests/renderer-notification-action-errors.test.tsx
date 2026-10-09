import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentDetail, ElectronApi } from '../src/shared/contracts'
import type { AppNotification } from '../src/renderer/src/app-notifications'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: AppNotificationList } = await import('../src/renderer/src/components/AppNotificationList')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}

const originalMessage = '  Error: 原通知正文保持原样。\nD:\\Notes\\Error: guide.md  '
const notification = (actions: AppNotification['actions']): AppNotification => ({
  id: 1, title: 'An existing notification', level: 'error', message: originalMessage, actions,
  createdAt: Date.parse('2026-10-01T00:00:00Z'), updatedAt: Date.parse('2026-10-01T00:00:00Z'), read: false
})

type NotificationContext = {
  document: Document
  opened: string[]
  actionButton: () => HTMLButtonElement
  card: () => HTMLElement
  outside: HTMLButtonElement
  renderNotifications: (items: readonly AppNotification[]) => void
}

async function withNotification(item: AppNotification, isZh: boolean, api: Partial<ElectronApi>, run: (context: NotificationContext) => Promise<void>, settlePending: () => void) {
  const dom = new JSDOM('<button id="outside">Workspace control</button><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const opened: string[] = []
  const renderNotifications = (items: readonly AppNotification[]) => root.render(createElement(AppNotificationList, {
    notifications: items, history: items, open: false, isZh, onClose: () => {}, onDismiss: () => {},
    onOpenDocument: id => opened.push(id)
  }))
  try {
    await act(async () => renderNotifications([item]))
    await run({ document: dom.window.document, opened,
      actionButton: () => dom.window.document.querySelector<HTMLButtonElement>('.app-notification-actions button')!,
      card: () => dom.window.document.querySelector<HTMLElement>(`.app-notification[data-notification-id="${item.id}"]`)!,
      outside: dom.window.document.getElementById('outside') as HTMLButtonElement,
      renderNotifications })
  } finally {
    await act(async () => settlePending())
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

async function withPendingRetry(run: (context: NotificationContext & {
  request: ReturnType<typeof deferred<void>>
  attempts: () => number
}) => Promise<void>) {
  const request = deferred<void>()
  let attempts = 0
  let renderNotifications: NotificationContext['renderNotifications']
  const retry = async () => {
    attempts += 1
    // A task update replaces the input, removing actions while retaining its id.
    renderNotifications([{ ...item, title: 'Backup in progress', level: 'progress', actions: undefined }])
    try {
      await request.promise
      renderNotifications([{ ...item, title: 'Backup completed', level: 'success', actions: undefined }])
    } catch {
      renderNotifications([{ ...item, title: 'Backup failed again', actions: [{ label: 'Retry', run: retry }] }])
    }
  }
  const item = notification([{ label: 'Retry', run: retry }])
  await withNotification(item, false, {}, async context => {
    renderNotifications = context.renderNotifications
    await run({ ...context, request, attempts: () => attempts })
  }, () => request.resolve(undefined))
}

test('notification document actions suppress reentry, show a clean IPC failure and only open after a successful retry', async () => {
  const requests: Array<ReturnType<typeof deferred<DocumentDetail | null>> & { documentId: string }> = []
  const item = notification([{ label: 'Open document', documentId: 'document-result' }])
  await withNotification(item, false, { getDocumentDetail: documentId => {
    const request = { ...deferred<DocumentDetail | null>(), documentId }
    requests.push(request)
    return request.promise
  } }, async ({ document, opened, actionButton }) => {
    const message = () => document.querySelector('.app-notification-message')?.textContent
    const failure = () => document.querySelector('.app-notification-action-error')
    assert.equal(message(), originalMessage)
    await act(async () => { actionButton().click(); actionButton().click() })
    assert.equal(requests.length, 1, 'a second activation before React renders disabled must not invoke IPC again')
    assert.equal(requests[0].documentId, 'document-result')
    assert.equal(actionButton().disabled, true)
    assert.deepEqual(opened, [])
    await act(async () => actionButton().click())
    assert.equal(requests.length, 1)
    const reason = 'Could not read "D:\\Notes\\Error: guide.md".\nYour original document is preserved.'
    await act(async () => requests[0].reject(new Error("Error invoking remote method 'knowbook:get-document-detail': Error: " + reason)))
    assert.equal(failure()?.textContent, reason)
    assert.equal(failure()?.getAttribute('role'), 'alert')
    assert.equal(actionButton().disabled, false)
    assert.deepEqual(opened, [])
    assert.equal(message(), originalMessage)
    await act(async () => actionButton().click())
    assert.equal(requests.length, 2)
    assert.equal(failure(), null, 'retry clears the previous action error while leaving the notification body alone')
    assert.equal(actionButton().disabled, true)
    assert.deepEqual(opened, [])
    await act(async () => requests[1].resolve({ id: 'document-result', title: 'Result', path: 'Result', summary: '',
      updatedAt: '2026-10-01T00:00:00Z', blocks: [], children: [], outgoingLinks: [], backlinks: [] }))
    assert.deepEqual(opened, ['document-result'])
    assert.equal(actionButton().disabled, false)
    assert.equal(failure(), null)
    assert.equal(message(), originalMessage)
    assert.equal(item.message, originalMessage)
  }, () => requests.forEach(request => request.resolve(null)))
})

test('ordinary notification actions use the localized fallback for empty failures, retain the body and remain retryable', async () => {
  for (const isZh of [true, false]) {
    for (const cause of [new Error(''), new Error('Error: TypeError: '), null]) {
      const requests: Array<ReturnType<typeof deferred<void>>> = []
      const item = notification([{ label: isZh ? '重试操作' : 'Retry action', run: () => {
        const request = deferred<void>()
        requests.push(request)
        return request.promise
      } }])
      await withNotification(item, isZh, {}, async ({ document, opened, actionButton }) => {
        await act(async () => actionButton().click())
        assert.equal(actionButton().disabled, true)
        await act(async () => requests[0].reject(cause))
        const failure = document.querySelector('.app-notification-action-error')
        assert.equal(failure?.textContent, isZh ? '操作失败，请重试。' : 'Action failed. Please retry.')
        assert.equal(failure?.getAttribute('role'), 'alert')
        assert.equal(actionButton().disabled, false)
        assert.equal(document.querySelector('.app-notification-message')?.textContent, originalMessage)
        await act(async () => actionButton().click())
        assert.equal(requests.length, 2)
        assert.equal(document.querySelector('.app-notification-action-error'), null)
        await act(async () => requests[1].resolve(undefined))
        assert.equal(actionButton().disabled, false)
        assert.deepEqual(opened, [])
        assert.equal(document.querySelector('.app-notification-message')?.textContent, originalMessage)
        assert.equal(item.message, originalMessage)
      }, () => requests.forEach(request => request.resolve(undefined)))
    }
  }
})

test('a focused Retry keeps a stable notification focus owner while progress removes actions and returns to the new Retry after failure', async () => {
  await withPendingRetry(async ({ document, card, actionButton, request, attempts }) => {
    const originalCard = card()
    const originalButton = actionButton()
    await act(async () => { originalButton.focus(); originalButton.click(); originalButton.click() })
    assert.equal(attempts(), 1, 'duplicate activation must still share the pending task')
    assert.ok(card() === originalCard, 'progress must preserve the same notification card')
    assert.equal(originalButton.isConnected, false, 'the original Retry must actually unmount')
    assert.equal(document.querySelectorAll('.app-notification-actions button').length, 0)
    assert.ok(document.activeElement === originalCard, 'notification-owned focus needs a stable pending owner')
    await act(async () => request.reject(new Error('Backup still unavailable')))
    assert.ok(card() === originalCard, 'failure must preserve the same notification card')
    assert.equal(document.querySelectorAll('.app-notification').length, 1)
    assert.equal(card().dataset.notificationId, '1')
    assert.ok(actionButton() !== originalButton, 'failure must create a replacement Retry')
    assert.equal(actionButton().disabled, false)
    assert.ok(document.activeElement === actionButton(), 'the next keyboard activation must reach the replacement Retry')
  })
})

test('a Retry failure leaves focus on the workspace control selected while the task was pending', async () => {
  await withPendingRetry(async ({ document, card, actionButton, outside, request }) => {
    await act(async () => { actionButton().focus(); actionButton().click() })
    assert.ok(document.activeElement === card(), 'notification-owned focus needs a stable pending owner')
    await act(async () => outside.focus())
    await act(async () => request.reject(new Error('Backup still unavailable')))
    assert.equal(actionButton().disabled, false)
    assert.ok(document.activeElement === outside, 'a completed task must not reclaim focus the user moved away')
  })
})

test('successful Retry without replacement actions preserves the same card as a keyboard continuation', async () => {
  await withPendingRetry(async ({ document, card, actionButton, request }) => {
    const originalCard = card()
    await act(async () => { actionButton().focus(); actionButton().click() })
    assert.ok(document.activeElement === originalCard, 'notification-owned focus needs a stable pending owner')
    await act(async () => request.resolve(undefined))
    assert.ok(card() === originalCard, 'success must preserve the same notification card')
    assert.equal(card().classList.contains('app-notification-success'), true)
    assert.equal(document.querySelectorAll('.app-notification-actions button').length, 0)
    assert.ok(document.activeElement === originalCard, 'success must not discard the task-owned keyboard continuation')
  })
})

test('an unfocused Retry never claims initial body or workspace focus when its actions are replaced', async () => {
  for (const focusedOutside of [false, true]) {
    await withPendingRetry(async ({ document, actionButton, outside, request }) => {
      if (focusedOutside) await act(async () => outside.focus())
      const previous = document.activeElement
      assert.ok(previous === (focusedOutside ? outside : document.body), 'the initial focus must belong to the body or workspace control')
      await act(async () => actionButton().click())
      assert.ok(document.activeElement === previous, 'removing an unfocused action must not move focus into its notification')
      await act(async () => request.reject(new Error('Backup still unavailable')))
      assert.equal(actionButton().disabled, false)
      assert.ok(document.activeElement === previous, 'replacement actions must not capture body or unrelated workspace focus')
    })
  }
})

test('focused ordinary actions stay keyboard reachable after synchronous failure or immediate success', async () => {
  for (const fails of [true, false]) {
    let calls = 0
    const item = notification([{ label: 'Run action', run: () => {
      calls += 1
      if (fails) throw new Error('This action could not complete')
    } }])
    await withNotification(item, false, {}, async ({ document, actionButton }) => {
      const button = actionButton()
      await act(async () => button.focus())
      assert.ok(document.activeElement === button, 'the action must own focus before it starts')
      await act(async () => button.click())
      assert.equal(calls, 1)
      assert.equal(button.disabled, false, 'the completed action must be available again')
      assert.ok(actionButton() === button, 'an ordinary action must retain its original button')
      assert.ok(document.activeElement === button, 'completion must return keyboard focus even when no pending render occurred')
      assert.equal(document.querySelector('.app-notification-action-error')?.textContent ?? null,
        fails ? 'This action could not complete' : null)
    }, () => {})
  }
})
