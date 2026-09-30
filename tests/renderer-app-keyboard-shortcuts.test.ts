import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { useAppKeyboardShortcuts } from '../src/renderer/src/hooks/useAppKeyboardShortcuts'
import type { DocumentsKeyboardState } from '../src/renderer/src/types/appDomains'
import type { ShellPageState } from '../src/renderer/src/types/appShell'

test('undo and redo preserve input history outside the body while retaining block and table history', async () => {
  const dom = new JSDOM(`<div id="mount"></div>
    <input id="title"><textarea id="summary"></textarea><textarea id="prompt"></textarea>
    <input id="search"><div id="rich-input" contenteditable="true"></div>
    <div class="block-editor-list"><textarea id="body" class="block-inline-textarea"></textarea>
      <div class="markdown-table-editor"><textarea id="cell"></textarea><select id="alignment"></select></div>
      <button id="toolbar">Format</button><input id="todo" type="checkbox"><input id="language-search"></div>`)
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    AbortController: dom.window.AbortController, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  // jsdom does not implement the browser's contenteditable state.
  Object.defineProperty(dom.window.document.getElementById('rich-input')!, 'isContentEditable', { value: true })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const calls: string[] = []
  const noop = () => {}
  const documents: DocumentsKeyboardState = {
    isEditing: true, isReadingMode: false, isGlobalSearchOpen: false, isBlockSearchOpen: false,
    selectedBlockRange: null, navBack: noop, navForward: noop,
    openGlobalSearch: noop, closeGlobalSearch: noop, openBlockSearch: noop, closeBlockSearch: noop,
    undoEdit: () => { calls.push('undo') }, redoEdit: () => { calls.push('redo') }
  }
  const shell = { activePage: 'documents' } as ShellPageState
  function Harness() {
    useAppKeyboardShortcuts({ documents, shell, onClearBlockRangeSelection: () => {} })
    return null
  }
  const press = (id: string, key: string, shiftKey = false, metaKey = false) => {
    const event = new dom.window.KeyboardEvent('keydown', {
      key, shiftKey, metaKey, ctrlKey: !metaKey, bubbles: true, cancelable: true
    })
    dom.window.document.getElementById(id)!.dispatchEvent(event)
    return event
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    for (const id of ['title', 'summary', 'prompt', 'search', 'rich-input', 'language-search']) {
      for (const metaKey of [false, true]) {
        for (const [key, shiftKey] of [['z', false], ['y', false], ['z', true]] as const) {
          assert.equal(press(id, key, shiftKey, metaKey).defaultPrevented, false, `${id} retains native history`)
        }
      }
    }
    assert.deepEqual(calls, [], 'auxiliary inputs must never change body history')
    for (const id of ['body', 'cell', 'toolbar', 'todo', 'alignment']) {
      for (const metaKey of [false, true]) {
        assert.equal(press(id, 'z', false, metaKey).defaultPrevented, true)
        assert.equal(press(id, 'y', false, metaKey).defaultPrevented, true)
        assert.equal(press(id, 'z', true, metaKey).defaultPrevented, true)
      }
    }
    assert.deepEqual(calls, Array.from({ length: 10 }, () => ['undo', 'redo', 'redo']).flat())
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
