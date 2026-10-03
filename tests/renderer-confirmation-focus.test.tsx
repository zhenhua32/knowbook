import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { ConfirmationDialog } from '../src/renderer/src/components/ConfirmationDialog'
import { setActiveUiLanguage } from '../src/renderer/src/i18n'

async function withConfirmation(markup: string, run: (context: {
  document: Document
  window: JSDOM['window']
  open: (opener: HTMLElement, onConfirm?: () => void | Promise<void>, options?: { canReturnFocus?: () => boolean }) => Promise<void>
  confirm: () => Promise<void>
  cancel: () => Promise<void>
  frames: FrameRequestCallback[]
  focusCalls: HTMLElement[]
  foreground: (value: boolean) => void
  change: (callback: () => void) => Promise<void>
  runFrames: () => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM(`<!doctype html><html><body>${markup}<input id="editor" /><div id="mount"></div></body></html>`, { pretendToBeVisual: true })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  const frames: FrameRequestCallback[] = []
  dom.window.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length }
  // Retain held callbacks even when cancelled: tests can model an already-copied scheduler callback being delivered late.
  dom.window.cancelAnimationFrame = () => {}
  let foreground = true
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => foreground })
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 400, 80) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    let element: HTMLElement | null = this
    if (!element.isConnected) return [] as unknown as DOMRectList
    while (element) {
      const style = dom.window.getComputedStyle(element)
      if (element.hidden || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || element instanceof dom.window.HTMLDialogElement && !element.open) return [] as unknown as DOMRectList
      element = element.parentElement
    }
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 80 } })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 80 } })
  const focusCalls: HTMLElement[] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) { focusCalls.push(this); nativeFocus.call(this, options) }
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
    await run({ document: dom.window.document, window: dom.window, frames, focusCalls,
      foreground: value => { foreground = value }, change: async callback => { await act(async () => callback()) },
      open: async (opener, onConfirm = () => undefined, options = {}) => {
        opener.focus()
        await act(async () => root.render(<ConfirmationDialog title="Delete document" description="Delete this document?"
          returnFocus={opener} canReturnFocus={options.canReturnFocus} onConfirm={onConfirm} onCancel={close} onComplete={close} />))
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

test('an enabled delayed opener is restored exactly once even if its consumed RAF callback is delivered again', async () => {
  await withConfirmation('<button id="opener">Open confirmation</button>', async ({ document, open, cancel, frames, focusCalls, runFrames, change }) => {
    const opener = document.getElementById('opener') as HTMLButtonElement
    await open(opener)
    opener.disabled = true
    await cancel()
    assert.equal(document.activeElement, document.body)
    assert.equal(frames.length, 1)
    const callback = frames[0]
    opener.disabled = false
    focusCalls.length = 0
    await runFrames()
    assert.equal(document.activeElement, opener)
    assert.equal(focusCalls.filter(element => element === opener).length, 1)
    await change(() => callback(0))
    assert.equal(document.activeElement, opener)
    assert.equal(focusCalls.filter(element => element === opener).length, 1, 'The close lease is consumed before the delegated native focus call')
  })
})

test('editor focus followed by blur back to BODY permanently cancels a delayed opener lease', async () => {
  await withConfirmation('<button id="opener">Open confirmation</button>', async ({ document, open, cancel, frames, focusCalls, runFrames, change }) => {
    const opener = document.getElementById('opener') as HTMLButtonElement, editor = document.getElementById('editor')!
    await open(opener)
    opener.disabled = true
    await cancel()
    const callback = frames[0]
    opener.disabled = false
    await change(() => { editor.focus(); editor.blur() })
    assert.equal(document.activeElement, document.body)
    focusCalls.length = 0
    await runFrames()
    await change(() => callback(0))
    assert.equal(document.activeElement, document.body)
    assert.equal(focusCalls.length, 0)
  })
})

test('new pointer, keyboard, IME or window-blur activity cannot revive delayed close focus when foreground resumes', async () => {
  for (const activity of ['pointer', 'key', 'composition', 'window-blur'] as const) await withConfirmation('<button id="opener">Open confirmation</button>',
    async ({ document, window, open, cancel, frames, focusCalls, foreground, runFrames, change }) => {
      const opener = document.getElementById('opener') as HTMLButtonElement, editor = document.getElementById('editor')!
      await open(opener)
      opener.disabled = true
      await cancel()
      const callback = frames[0]
      opener.disabled = false
      await change(() => {
        if (activity === 'pointer') editor.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
        else if (activity === 'key') editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        else if (activity === 'composition') editor.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }))
        else { foreground(false); window.dispatchEvent(new window.Event('blur')) }
      })
      focusCalls.length = 0
      await runFrames()
      await change(() => {
        if (activity === 'composition') editor.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true }))
        foreground(true)
        window.dispatchEvent(new window.Event('focus'))
        callback(0)
      })
      assert.equal(document.activeElement, document.body)
      assert.equal(focusCalls.length, 0, `New ${activity} activity permanently abandons close restoration`)
    })
})

test('foreign modal, unfocused document or canReturnFocus veto consumes delayed close focus without later replay', async () => {
  for (const blocker of ['foreign-modal', 'document-unfocused', 'owner-veto'] as const) await withConfirmation('<button id="opener">Open confirmation</button>',
    async ({ document, open, cancel, frames, focusCalls, foreground, runFrames, change }) => {
      const opener = document.getElementById('opener') as HTMLButtonElement
      let allowed = true
      await open(opener, undefined, { canReturnFocus: () => allowed })
      opener.disabled = true
      await cancel()
      const callback = frames[0]
      opener.disabled = false
      const foreign = document.createElement('dialog')
      foreign.open = true
      foreign.setAttribute('aria-modal', 'true')
      if (blocker === 'foreign-modal') document.body.append(foreign)
      else if (blocker === 'document-unfocused') foreground(false)
      else allowed = false
      focusCalls.length = 0
      await runFrames()
      foreign.remove()
      foreground(true)
      allowed = true
      await change(() => callback(0))
      assert.equal(document.activeElement, document.body)
      assert.equal(focusCalls.length, 0, `${blocker} must not postpone focus until an unrelated later turn`)
    })
})
