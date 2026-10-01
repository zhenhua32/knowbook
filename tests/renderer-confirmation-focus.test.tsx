import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { ConfirmationDialog } from '../src/renderer/src/components/ConfirmationDialog'
import { setActiveUiLanguage } from '../src/renderer/src/i18n'

async function withConfirmation(markup: string, run: (context: {
  document: Document
  open: (opener: HTMLElement, onConfirm?: () => void | Promise<void>) => Promise<void>
  confirm: () => Promise<void>
  cancel: () => Promise<void>
  frames: FrameRequestCallback[]
  runFrames: () => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM(`<!doctype html><html><body>${markup}<input id="editor" /><div id="mount"></div></body></html>`, { pretendToBeVisual: true })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  const frames: FrameRequestCallback[] = []
  dom.window.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length }
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const key of keys) Object.defineProperty(globalThis, key, {
    configurable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key]
  })
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const close = () => root.render(null)
  const click = async (selector: string) => {
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(selector)!.click())
  }
  try {
    setActiveUiLanguage('en-US')
    await run({ document: dom.window.document, frames,
      open: async (opener, onConfirm = () => undefined) => {
        opener.focus()
        await act(async () => root.render(<ConfirmationDialog title="Delete document" description="Delete this document?"
          returnFocus={opener} onConfirm={onConfirm} onCancel={close} onComplete={close} />))
        assert.equal(dom.window.document.activeElement, dom.window.document.querySelector('.app-confirm-dialog .secondary-button'))
      },
      confirm: () => click('.app-confirm-dialog .danger-button'),
      cancel: () => click('.app-confirm-dialog .secondary-button'),
      runFrames: async () => { await act(async () => { for (const callback of frames.splice(0)) callback(0) }) }
    })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of keys) {
      const descriptor = originals.get(key)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

const trees = (nestedButton = false) => `
  <ul role="tree" id="other-tree"><li role="treeitem" tabindex="0" id="other-entry">Other tree</li></ul>
  <ul role="tree" id="origin-tree">
    <li role="treeitem" tabindex="0" id="deleted">${nestedButton ? '<button id="opener">Delete me</button>' : 'Delete me'}</li>
    <li role="treeitem" tabindex="-1" id="next">Next document</li>
  </ul>`

test('cancelling a confirmation restores its connected opener', async () => {
  await withConfirmation('<button id="opener">Open confirmation</button>', async ({ document, open, cancel }) => {
    const opener = document.getElementById('opener')!
    await open(opener)
    await cancel()
    assert.equal(document.activeElement, opener)
  })
})

for (const nestedButton of [false, true]) {
  test(`confirmed tree deletion restores the same tree's new Tab entry from ${nestedButton ? 'a nested button' : 'a tree item'}`, async () => {
    await withConfirmation(trees(nestedButton), async ({ document, open, confirm }) => {
      const opener = document.getElementById(nestedButton ? 'opener' : 'deleted')!
      const next = document.getElementById('next')!
      await open(opener, () => {
        document.getElementById('deleted')!.remove()
        next.tabIndex = 0
      })
      await confirm()
      assert.equal(document.activeElement, next)
      assert.equal(document.querySelector('.app-confirm-dialog'), null)
    })
  })
}

for (const nextFocus of ['editor', 'modal']) {
  test(`tree deletion does not replace ${nextFocus === 'editor' ? 'another page' : 'another modal'} focus`, async () => {
    await withConfirmation(trees(), async ({ document, open, confirm }) => {
      const opener = document.getElementById('deleted')!
      let target = document.getElementById('editor')!
      await open(opener, () => {
        opener.remove()
        document.getElementById('next')!.tabIndex = 0
        if (nextFocus === 'modal') {
          const modal = document.createElement('dialog')
          modal.setAttribute('role', 'dialog')
          modal.setAttribute('aria-modal', 'true')
          modal.innerHTML = '<input id="modal-input" />'
          document.body.append(modal)
          modal.showModal()
          target = modal.querySelector<HTMLInputElement>('input')!
        }
        target.focus()
      })
      await confirm()
      assert.equal(document.activeElement, target)
    })
  })
}

for (const unavailable of ['removed', 'hidden', 'inert']) {
  test(`an unavailable origin tree (${unavailable}) never redirects focus to another tree`, async () => {
    await withConfirmation(trees(), async ({ document, open, confirm }) => {
      const opener = document.getElementById('deleted')!
      const tree = document.getElementById('origin-tree')!
      await open(opener, () => {
        opener.remove()
        document.getElementById('next')!.tabIndex = 0
        if (unavailable === 'removed') tree.remove()
        else tree.setAttribute(unavailable, '')
      })
      await confirm()
      assert.equal(document.activeElement, document.body)
    })
  })
}

test('a disabled opener keeps its animation-frame recovery when the action settles', async () => {
  await withConfirmation('<button id="opener">Open confirmation</button>', async ({ document, open, cancel, frames, runFrames }) => {
    const opener = document.getElementById('opener') as HTMLButtonElement
    await open(opener)
    opener.disabled = true
    await cancel()
    assert.equal(frames.length, 1)
    assert.equal(document.activeElement, document.body)
    opener.disabled = false
    await runFrames()
    assert.equal(document.activeElement, opener)
  })
})

test('delayed opener recovery does not override focus moved after the confirmation closes', async () => {
  await withConfirmation('<button id="opener">Open confirmation</button>', async ({ document, open, cancel, runFrames }) => {
    const opener = document.getElementById('opener') as HTMLButtonElement
    await open(opener)
    opener.disabled = true
    await cancel()
    opener.disabled = false
    const editor = document.getElementById('editor')!
    editor.focus()
    await runFrames()
    assert.equal(document.activeElement, editor)
  })
})
