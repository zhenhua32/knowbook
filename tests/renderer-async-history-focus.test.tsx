import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { captureAsyncHistoryFocusPermission } from '../src/renderer/src/utils/editorHistoryFocus'

type Permission = ReturnType<typeof captureAsyncHistoryFocusPermission>
type Context = {
  window: JSDOM['window']
  document: Document
  capture: () => Permission
  element: (id: string) => HTMLElement
  setWindowFocus: (focused: boolean) => void
}
function withDom(run: (context: Context) => void) {
  const dom = new JSDOM('<main><div id="editor" contenteditable="true" tabindex="0"><span id="editor-child" tabindex="0">Text</span></div>'
    + '<textarea id="textarea" class="block-inline-textarea">Body</textarea><input id="foreign">'
    + '<button id="more" class="document-header-more-button">More</button>'
    + '<div id="header-menu" class="document-header-action-menu"><button id="undo">Undo</button></div>'
    + '<button id="foreign-more" class="document-header-more-button">Another More</button></main>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>(), permissions: Permission[] = []
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  let focused = true
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => focused })
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return (this.isConnected && !this.hidden && this.style.display !== 'none'
      ? [new dom.window.DOMRect(0, 0, 200, 100)] : []) as unknown as DOMRectList
  }
  const element = (id: string) => {
    const target = dom.window.document.getElementById(id)
    assert.ok(target)
    return target as HTMLElement
  }
  const capture = () => { const permission = captureAsyncHistoryFocusPermission(); permissions.push(permission); return permission }
  try { run({ window: dom.window, document: dom.window.document, capture, element, setWindowFocus: value => { focused = value } }) }
  finally {
    for (const permission of permissions) permission.dispose()
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

test('async history focus remains permitted for its exact editor, descendant focus and replacement-body cleanup', () => withDom(context => {
  context.element('editor').focus()
  const permission = context.capture()
  assert.equal(permission.canRestore(), true)
  context.element('editor-child').focus()
  assert.equal(permission.canRestore(), true, 'focus inside the captured editor retains ownership')
  context.element('editor').remove()
  assert.equal(context.document.activeElement, context.document.body)
  context.document.body.dispatchEvent(new context.window.FocusEvent('focusin', { bubbles: true }))
  assert.equal(permission.canRestore(), true, 'replacing the captured editor may briefly put focus on body')
}))

test('window blur permanently retires async history focus even after the same editor and window regain focus', () => withDom(context => {
  context.element('textarea').focus()
  const permission = context.capture()
  assert.equal(permission.canRestore(), true)
  context.setWindowFocus(false)
  context.window.dispatchEvent(new context.window.Event('blur'))
  assert.equal(permission.canRestore(), false)
  context.setWindowFocus(true)
  context.element('textarea').focus()
  context.window.dispatchEvent(new context.window.Event('focus'))
  assert.equal(permission.canRestore(), false, 'returning cannot revive a cursor the user abandoned')
}))

test('body-origin permission cannot mistake another focused control for a descendant editor and cannot revive on return', () => withDom(context => {
  assert.equal(context.document.activeElement, context.document.body)
  const permission = context.capture()
  assert.equal(permission.canRestore(), true)
  context.element('foreign').focus()
  assert.equal(permission.canRestore(), false)
  context.element('foreign').blur()
  assert.equal(context.document.activeElement, context.document.body)
  assert.equal(permission.canRestore(), false, 'returning to body does not revive abandoned ownership')
}))

test('foreign focus permanently retires permission even when the user returns to its original textarea', () => withDom(context => {
  context.element('textarea').focus()
  const permission = context.capture()
  context.element('foreign').focus()
  assert.equal(context.document.activeElement, context.element('foreign'))
  assert.equal(permission.canRestore(), false)
  context.element('textarea').focus()
  assert.equal(permission.canRestore(), false)
}))

test('subsequent pointer, keyboard and IME input retires permission even when the editor remains focused', () => {
  for (const type of ['pointerdown', 'keydown', 'compositionstart'] as const) withDom(context => {
    context.element('textarea').focus()
    const permission = context.capture()
    const event = type === 'keydown' ? new context.window.KeyboardEvent(type, { key: 'a', bubbles: true })
      : type === 'compositionstart' ? new context.window.CompositionEvent(type, { data: '中', bubbles: true })
        : new context.window.MouseEvent(type, { bubbles: true })
    context.element('textarea').dispatchEvent(event)
    assert.equal(context.document.activeElement, context.element('textarea'))
    assert.equal(permission.canRestore(), false, type + ' means later user activity owns the cursor')
  })
})

test('header menu cleanup can return to its exact captured More button while another More or an unrelated button cannot gain permission', () => {
  withDom(context => {
    context.element('undo').focus()
    const permission = context.capture()
    context.element('header-menu').remove()
    assert.equal(context.document.activeElement, context.document.body)
    context.element('more').focus()
    assert.equal(permission.canRestore(), true)
  })
  withDom(context => {
    context.element('undo').focus()
    const permission = context.capture()
    context.element('header-menu').remove()
    context.element('foreign-more').focus()
    assert.equal(permission.canRestore(), false, 'a matching CSS class is insufficient; the captured element must match')
    context.element('more').focus()
    assert.equal(permission.canRestore(), false)
  })
  withDom(context => {
    context.element('textarea').focus()
    const permission = context.capture()
    context.element('more').focus()
    assert.equal(permission.canRestore(), false, 'More is exempt only for the menu that initiated this operation')
  })
})

test('window focus and visible connected foreign native or ARIA modal checks veto restoration without treating hidden dialogs as visible', () => {
  for (const mode of ['native', 'dialog', 'alertdialog'] as const) withDom(context => {
    context.element('textarea').focus()
    const permission = context.capture()
    const modal = context.document.createElement(mode === 'native' ? 'dialog' : 'section')
    if (mode === 'native') modal.setAttribute('open', '')
    else { modal.setAttribute('role', mode); modal.setAttribute('aria-modal', 'true') }
    modal.hidden = true
    context.document.body.append(modal)
    assert.equal(permission.canRestore(), true)
    modal.hidden = false
    assert.ok(modal.getClientRects().length > 0)
    assert.equal(permission.canRestore(), false, mode + ' modal must prevent focus reclamation')
    modal.remove()
    assert.equal(permission.canRestore(), true, 'a disconnected dialog no longer blocks the active editor')
    context.setWindowFocus(false)
    assert.equal(permission.canRestore(), false)
  })
})

test('dispose removes the exact document and window listeners so only a subsequent live permission observes new input', () => withDom(context => {
  type Registration = { target: EventTarget; type: string; callback: EventListenerOrEventListenerObject | null; capture: boolean }
  const active: Registration[] = [], added: Registration[] = [], removed: Registration[] = []
  const track = (target: EventTarget, types: string[]) => {
    const trackedTypes = new Set(types)
    const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target)
    Object.defineProperty(target, 'addEventListener', { configurable: true, value: (type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
      if (trackedTypes.has(type)) {
        const entry = { target, type, callback, capture: typeof options === 'boolean' ? options : options?.capture ?? false }
        added.push(entry); active.push(entry)
      }
      add(type, callback, options)
    } })
    Object.defineProperty(target, 'removeEventListener', { configurable: true, value: (type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
      if (trackedTypes.has(type)) {
        const entry = { target, type, callback, capture: typeof options === 'boolean' ? options : options?.capture ?? false }
        removed.push(entry)
        const index = active.findIndex(candidate => candidate.target === target && candidate.type === type && candidate.callback === callback && candidate.capture === entry.capture)
        if (index >= 0) active.splice(index, 1)
      }
      remove(type, callback, options)
    } })
  }
  // JSDOM owns its window focusin/keydown listeners; track only the permission's actual targets.
  track(context.document, ['pointerdown', 'keydown', 'compositionstart', 'focusin'])
  track(context.window as unknown as EventTarget, ['blur'])
  context.element('textarea').focus()
  const retired = context.capture()
  assert.equal(added.length, 5)
  assert.deepEqual(added.map(entry => entry.type).sort(), ['blur', 'compositionstart', 'focusin', 'keydown', 'pointerdown'])
  retired.dispose()
  assert.equal(active.length, 0)
  assert.equal(removed.length, 5)
  for (const entry of added) assert.ok(removed.some(candidate => candidate.target === entry.target && candidate.type === entry.type && candidate.callback === entry.callback && candidate.capture === entry.capture))
  const live = context.capture()
  assert.equal(active.length, 5)
  context.element('textarea').dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }))
  assert.equal(retired.canRestore(), true, 'the disposed callbacks must not observe later events')
  assert.equal(live.canRestore(), false)
  live.dispose()
  assert.equal(active.length, 0)
}))
