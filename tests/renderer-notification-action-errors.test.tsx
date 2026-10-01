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

async function withNotification(item: AppNotification, isZh: boolean, api: Partial<ElectronApi>, run: (context: {
  document: Document; opened: string[]; actionButton: () => HTMLButtonElement
}) => Promise<void>, settlePending: () => void) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
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
  try {
    await act(async () => root.render(createElement(AppNotificationList, {
      notifications: [item], history: [item], open: false, isZh, onClose: () => {}, onDismiss: () => {},
      onOpenDocument: id => opened.push(id)
    })))
    await run({ document: dom.window.document, opened,
      actionButton: () => dom.window.document.querySelector<HTMLButtonElement>('.app-notification-actions button')! })
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
