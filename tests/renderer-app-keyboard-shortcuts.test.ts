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
    detailLoading: false, documentLoadError: null,
    selectedDocumentId: 'current', selectedDocument: { id: 'current' } as DocumentsKeyboardState['selectedDocument'],
    saveDocument: async () => { calls.push('save') },
    globalSearchQuery: '',
    selectedBlockRange: null, navBack: noop, navForward: noop,
    openGlobalSearch: noop, closeGlobalSearch: noop, openBlockSearch: noop, closeBlockSearch: noop,
    undoEdit: () => { calls.push('undo') }, redoEdit: () => { calls.push('redo') }
  }
  const fullSearchQueries: Array<string | undefined> = []
  const shell: ShellPageState = { activePage: 'documents', setActivePage: noop,
    openWorkspaceSearch: (query) => { fullSearchQueries.push(query) } }
  function Harness() {
    useAppKeyboardShortcuts({ documents, shell, onClearBlockRangeSelection: () => {} })
    return null
  }
  const press = (id: string, key: string, shiftKey = false, metaKey = false, repeat = false) => {
    const event = new dom.window.KeyboardEvent('keydown', {
      key, shiftKey, metaKey, repeat, ctrlKey: !metaKey, bubbles: true, cancelable: true
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
    assert.equal(press('title', 'f', true).defaultPrevented, true)
    assert.deepEqual(fullSearchQueries, [undefined], 'full search can open from a metadata input without taking over its history')
    documents.isGlobalSearchOpen = true
    documents.globalSearchQuery = 'research notes'
    assert.equal(press('search', 'f', true).defaultPrevented, true)
    documents.globalSearchQuery = '> settings'
    assert.equal(press('search', 'f', true).defaultPrevented, true)
    assert.deepEqual(fullSearchQueries, [undefined, 'research notes', undefined], 'search carries palette keywords, while commands retain the current full search')
    documents.isGlobalSearchOpen = false
    calls.length = 0
    for (const id of ['title', 'summary', 'body', 'cell', 'toolbar', 'todo']) {
      for (const metaKey of [false, true]) assert.equal(press(id, 's', false, metaKey).defaultPrevented, true)
    }
    documents.isReadingMode = true
    assert.equal(press('todo', 's').defaultPrevented, true)
    assert.equal(calls.filter(call => call === 'save').length, 13, 'metadata, body, tables, and reading tasks share Save')
    assert.equal(press('body', 's', false, false, true).defaultPrevented, true)
    assert.equal(calls.length, 13, 'holding Save does not repeat writes')
    const title = dom.window.document.getElementById('title')!
    title.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }))
    assert.equal(press('title', 's').defaultPrevented, false)
    title.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }))
    const dialog = dom.window.document.createElement('dialog')
    dialog.setAttribute('data-block-shortcuts', '')
    // jsdom has no layout; model a visible blocking dialog.
    Object.defineProperty(dialog, 'getClientRects', { value: () => [new dom.window.DOMRect(0, 0, 200, 100)] })
    dom.window.document.body.append(dialog)
    assert.equal(press('body', 's').defaultPrevented, false)
    dialog.remove()
    documents.isGlobalSearchOpen = true
    assert.equal(press('search', 's').defaultPrevented, false)
    documents.isGlobalSearchOpen = false
    shell.activePage = 'search'
    assert.equal(press('search', 's').defaultPrevented, false)
    shell.activePage = 'documents'
    documents.detailLoading = true
    assert.equal(press('title', 's').defaultPrevented, true)
    documents.detailLoading = false
    documents.selectedDocumentId = 'still-loading'
    assert.equal(press('body', 's').defaultPrevented, true)
    assert.equal(calls.length, 13, 'composition, blocking dialogs, search, other pages, and unloaded documents cannot save')
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})

test('retained hidden settings panels do not block global shortcuts, while visible editors still do', async () => {
  const dom = new JSDOM('<div id="mount"></div><button id="navigation">Navigation</button><section id="sync-panel"><div id="merge-editor" data-block-shortcuts><textarea>Retained merge draft</textarea></div></section>')
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    AbortController: dom.window.AbortController, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const calls: string[] = []
  const noop = () => {}
  const documents: DocumentsKeyboardState = {
    isEditing: false, isReadingMode: false, isGlobalSearchOpen: false, isBlockSearchOpen: false,
    detailLoading: false, documentLoadError: null, selectedDocumentId: null, selectedDocument: null,
    saveDocument: async () => {}, globalSearchQuery: '', selectedBlockRange: null, navBack: noop, navForward: noop,
    openGlobalSearch: () => { calls.push('search') }, closeGlobalSearch: noop, openBlockSearch: noop, closeBlockSearch: noop,
    undoEdit: noop, redoEdit: noop
  }
  const shell: ShellPageState = { activePage: 'settings', setActivePage: (page) => {
    calls.push(typeof page === 'function' ? page(shell.activePage) : page)
  }, openWorkspaceSearch: noop }
  function Harness() {
    useAppKeyboardShortcuts({ documents, shell, onClearBlockRangeSelection: noop })
    return null
  }
  const panel = dom.window.document.getElementById('sync-panel')!
  const editor = dom.window.document.getElementById('merge-editor')!
  let hasLayout = true
  // Model layout independently of hidden/inert so each visibility guard is exercised.
  Object.defineProperty(editor, 'getClientRects', { value: () => hasLayout ? [new dom.window.DOMRect(0, 0, 200, 100)] : [] })
  const pressShortcuts = () => {
    calls.length = 0
    for (const key of ['k', '2']) dom.window.document.getElementById('navigation')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key, ctrlKey: true, bubbles: true, cancelable: true
    }))
    return [...calls]
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    assert.deepEqual(pressShortcuts(), [], 'a visible conflict editor blocks search and page navigation')
    panel.hidden = true
    assert.deepEqual(pressShortcuts(), ['search', 'dashboard'], 'switching away from Sync restores global shortcuts')
    assert.equal(editor.querySelector('textarea')!.value, 'Retained merge draft', 'the hidden merge draft stays mounted')
    panel.hidden = false
    assert.deepEqual(pressShortcuts(), [], 'returning to the editor restores its shortcut protection')
    panel.setAttribute('inert', '')
    assert.deepEqual(pressShortcuts(), ['search', 'dashboard'], 'an inactive surface does not block workspace navigation')
    panel.removeAttribute('inert')
    hasLayout = false
    assert.deepEqual(pressShortcuts(), ['search', 'dashboard'], 'CSS-hidden and closed-details editors without layout do not block shortcuts')
    hasLayout = true
    assert.deepEqual(pressShortcuts(), [], 'revealing the same retained editor blocks shortcuts again')
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
