import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { ResolveWebDavProtocol5Conflict, WebDavProtocol5ConflictPreview } from '../src/shared/webdav-sync'
import WebDavProtocol5ConflictReview from '../src/renderer/src/sections/WebDavProtocol5ConflictReview'

const preview: WebDavProtocol5ConflictPreview = {
  previewId: 'current-preview', previewHash: 'current-hash',
  components: ['one', 'two'].map(componentId => ({ componentId, choices: ['local', 'remote', 'merge'], records: [{
    key: `doc:${componentId}`, baseHash: 'base', localHash: 'local', remoteHash: 'remote', unresolvedPartIds: ['body'],
    parts: [{ id: 'body', field: 'block-property', blockId: 'block', property: 'content',
      basePreview: 'Original', localPreview: 'Saved locally', remotePreview: 'Saved remotely', canEditText: true }]
  }] }))
}

function button(scope: ParentNode, text: string) {
  const element = [...scope.querySelectorAll('button')].find(node => node.textContent === text)
  assert.ok(element, `Missing button ${text}`)
  return element
}

test('protocol 5 conflict attempts bind the displayed preview, keep failed drafts and return keyboard focus', async () => {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const { document, navigator, HTMLElement, Node } = dom.window
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document, navigator, HTMLElement, Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(document, 'hasFocus', { value: () => true })
  HTMLElement.prototype.getClientRects = () => [new dom.window.DOMRect(0, 0, 240, 32)] as unknown as DOMRectList
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('mount')!)
  const submissions: ResolveWebDavProtocol5Conflict[] = []
  let fail: (message: string) => void = () => assert.fail('Expected an active conflict action')
  function Harness() {
    const [disabled, setDisabled] = useState(false)
    const [current, setCurrent] = useState(preview)
    return <WebDavProtocol5ConflictReview preview={current} disabled={disabled} isZh
      onPreview={async () => { setCurrent({ ...preview, previewId: 'refreshed-preview' }); return true }}
      onResolve={(selection, onError) => {
        submissions.push(selection)
        setDisabled(true)
        return new Promise(resolve => { fail = message => { onError(message); setDisabled(false); resolve(false) } })
      }} />
  }
  async function activate(target: HTMLButtonElement) {
    await act(async () => { target.focus(); target.click() })
    await act(async () => {
      if (target.disabled && document.activeElement === target) {
        target.disabled = false
        target.blur()
        target.disabled = true
      }
    })
  }
  try {
    await act(async () => root.render(<Harness />))
    const [first, second] = document.querySelectorAll('details')
    await activate(button(first, '逐项合并'))
    assert.match(first.textContent!, /doc:one/)
    assert.equal(first.querySelector('legend')?.textContent, '正文块 1')
    const apply = button(first, '应用逐项合并')
    assert.ok(apply.disabled)
    await act(async () => first.querySelectorAll<HTMLInputElement>('input[type="radio"]')[2].click())
    const draft = first.querySelector('textarea')!
    const text = '自行合并的内容'
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, text)
      draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await activate(apply)
    assert.equal(apply.getAttribute('aria-busy'), 'true')
    assert.equal(first.querySelector('[role="status"]')?.textContent, '正在应用选择…')
    assert.deepEqual(submissions, [{ previewId: preview.previewId, previewHash: preview.previewHash, componentId: 'one',
      choice: 'merge', records: [{ key: 'doc:one', parts: [{ id: 'body', value: { choice: 'custom', text } }] }] }])
    await act(async () => fail('首组操作失败'))
    assert.equal(first.querySelector('[role="alert"]')?.textContent, '首组操作失败')
    assert.equal(document.activeElement, apply)
    assert.equal(draft.value, text)

    const applyRemote = button(second, '应用远端整组')
    await activate(applyRemote)
    await act(async () => fail('另一个组操作失败'))
    assert.equal(first.querySelector('[role="alert"]'), null)
    assert.equal(second.querySelector('[role="alert"]')?.textContent, '另一个组操作失败')
    assert.equal(document.activeElement, applyRemote)
    assert.equal(draft.value, text)

    await activate(button(document, '读取最新冲突'))
    assert.equal(document.querySelector('[role="alert"]'), null)
    assert.equal(document.querySelector('textarea'), null)
    assert.equal(submissions.length, 2)
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
