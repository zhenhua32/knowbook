import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { waitForRenderer } from './helpers/renderer-async'
import type { DocumentLinkCheck } from '../src/shared/contracts'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: DocumentLinkCheckDialog } = await import('../src/renderer/src/components/DocumentLinkCheckDialog')

test('link check dialog wraps Tab in both directions and restores its opener when closed', async () => {
  const dom = new JSDOM('<button class="document-header-more-button">More</button><div id="mount"></div>')
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  const report: DocumentLinkCheck = { documentId: 'source', checkedAt: '2026-10-04', checkedCount: 1,
    ignoredExternalCount: 0, issues: [{ blockId: 'paragraph', offset: 0, url: 'Missing.md', reason: 'missing-document' }] }
  Object.defineProperty(dom.window, 'knowbook', { value: { checkDocumentLinks: async () => report } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const opener = dom.window.document.querySelector<HTMLButtonElement>('.document-header-more-button')!
  let closeCalls = 0
  opener.focus()
  try {
    await act(async () => root.render(createElement(DocumentLinkCheckDialog, {
      documentId: 'source', isZh: false, onFlush: async () => true,
      onClose: () => { closeCalls++; root.render(null) },
      onLocate: () => assert.fail('Tab must not activate a link issue')
    })))
    await waitForRenderer(() => dom.window.document.querySelector('dialog footer button')?.hasAttribute('disabled') === false,
      'The link report must finish loading before keyboard navigation')
    const dialog = dom.window.document.querySelector<HTMLDialogElement>('dialog')!
    const close = dialog.querySelector<HTMLButtonElement>('header button')!
    const issue = dialog.querySelector<HTMLButtonElement>('li button')!
    const again = dialog.querySelector<HTMLButtonElement>('footer button')!
    assert.equal(dialog.open, true)
    assert.match(dialog.querySelector('[role="status"]')!.textContent!, /found 1 issues/)

    again.focus()
    const forward = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    again.dispatchEvent(forward)
    assert.equal(forward.defaultPrevented, true, 'The final Tab must not escape into browser focus')
    assert.equal(dom.window.document.activeElement, close)

    const backward = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    close.dispatchEvent(backward)
    assert.equal(backward.defaultPrevented, true)
    assert.equal(dom.window.document.activeElement, again)

    issue.focus()
    const middle = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    issue.dispatchEvent(middle)
    assert.equal(middle.defaultPrevented, false, 'Intermediate link buttons retain native Tab navigation')

    await act(async () => close.click())
    assert.equal(closeCalls, 1)
    assert.equal(dom.window.document.querySelector('dialog'), null)
    assert.equal(dom.window.document.activeElement, opener)
  } finally {
    try {
      await act(async () => root.unmount())
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
      dom.window.close()
    }
  }
})
