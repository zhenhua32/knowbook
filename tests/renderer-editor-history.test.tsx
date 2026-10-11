import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, StrictMode, useLayoutEffect, type FormEvent } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentDetail } from '../src/shared/contracts'
import type { UiText } from '../src/renderer/src/i18n'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { captureEditorHistoryBookmark } from '../src/renderer/src/utils/editorHistoryFocus'

type Editor = ReturnType<typeof useDocumentEditorState>
type Api = {
  current: () => Editor
  document: Document
  input: (id: string) => HTMLTextAreaElement
  focus: (id: string, start: number, end?: number, direction?: 'forward' | 'backward' | 'none') => Promise<void>
  type: (id: string, value: string, composing?: boolean) => Promise<void>
  afterLayout: (id: string, value: string, run: (input: HTMLTextAreaElement) => void) => void
}

function nativeInput(input: HTMLTextAreaElement, value: string, isComposing = false) {
  const view = input.ownerDocument.defaultView!
  input.dispatchEvent(new view.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', isComposing }))
  input.value = value
  input.setSelectionRange(value.length, value.length)
  input.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertText', isComposing }))
}

async function withHistory(run: (api: Api) => Promise<void>, strict = false) {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: (): number => 1, cancelAnimationFrame: (): void => {}, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const setSelectionRange = dom.window.HTMLTextAreaElement.prototype.setSelectionRange
  dom.window.HTMLTextAreaElement.prototype.setSelectionRange = function (start, end, direction) {
    setSelectionRange.call(this, start, end, direction)
    this.ownerDocument.dispatchEvent(new dom.window.Event('selectionchange'))
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const noop = () => {}
  let editor!: Editor
  let nextLayout: { id: string; value: string; run: (input: HTMLTextAreaElement) => void } | null = null
  function Harness() {
    editor = useDocumentEditorState({ selectedDocumentId: null, selectedDocument: null, ui: {} as UiText,
      onHomeDataChange: noop, onSelectedDocumentChange: noop, onMessage: noop })
    useLayoutEffect(() => {
      const step = nextLayout
      if (!step || !editor.draftBlocks.some(block => block.id === step.id && block.content === step.value)) return
      nextLayout = null
      // Reproduce the next native input between a committed value and passive effects.
      step.run(dom.window.document.querySelector<HTMLTextAreaElement>(`[data-block-id="${step.id}"] textarea`)!)
    }, [editor.draftBlocks])
    return createElement('div', { className: 'block-editor-list' }, editor.draftBlocks.map((block, index) =>
      createElement('div', { key: block.id, className: 'block-editor-row', 'data-block-index': index, 'data-block-id': block.id },
        createElement('textarea', { className: 'block-inline-textarea', value: block.content, onChange: noop,
          onInput: (event: FormEvent<HTMLTextAreaElement>) => editor.updateDraftBlock(index, { content: event.currentTarget.value }) }))))
  }
  const document = dom.window.document
  const input = (id: string) => document.querySelector<HTMLTextAreaElement>(`[data-block-id="${id}"] textarea`)!
  try {
    const harness = createElement(Harness)
    await act(async () => root.render(strict ? createElement(StrictMode, null, harness) : harness))
    await act(async () => editor.loadDocumentIntoEditor({ id: 'doc', title: 'History', summary: '', blocks: [
      { id: 'body', type: 'paragraph', content: 'abcdef', checked: false, depth: 0 },
      { id: 'second', type: 'paragraph', content: 'ghijkl', checked: false, depth: 0 }
    ] } as DocumentDetail))
    await run({ current: () => editor, document, input,
      focus: async (id, start, end = start, direction = 'none') => {
        await act(async () => { input(id).focus(); input(id).setSelectionRange(start, end, direction) })
      },
      type: async (id, value, composing = false) => { await act(async () => nativeInput(input(id), value, composing)) },
      afterLayout: (id, value, run) => { nextLayout = { id, value, run } }
    })
  } finally {
    await act(async () => root.unmount())
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

test('characters arriving before passive history effects remain one input transaction across blocks and StrictMode', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    for (const strict of [false, true]) {
      await withHistory(async api => {
        await api.focus('body', 6)
        api.afterLayout('body', 'abcdef ', input => nativeInput(input, 'abcdef A'))
        await api.type('body', 'abcdef ')
        assert.equal(api.input('body').value, 'abcdef A')
        await api.focus('second', 2, 5, 'backward')
        await api.type('second', 'ghXl')
        await act(async () => { api.current().undoEdit(); t.mock.timers.tick(0) })
        assert.deepEqual(api.current().draftBlocks.map(block => block.content), ['abcdef A', 'ghijkl'])
        assert.equal(api.document.activeElement, api.input('second'))
        assert.deepEqual([api.input('second').selectionStart, api.input('second').selectionEnd,
          api.input('second').selectionDirection], [2, 5, 'backward'])
        await act(async () => { api.current().undoEdit(); t.mock.timers.tick(0) })
        assert.deepEqual(api.current().draftBlocks.map(block => block.content), ['abcdef', 'ghijkl'])
        assert.equal(api.document.activeElement, api.input('body'))
        assert.equal(api.input('body').selectionStart, 6)
        await act(async () => { api.current().redoEdit(); t.mock.timers.tick(0) })
        assert.deepEqual(api.current().draftBlocks.map(block => block.content), ['abcdef A', 'ghijkl'])
        await act(async () => api.current().redoEdit())
        assert.deepEqual(api.current().draftBlocks.map(block => block.content), ['abcdef A', 'ghXl'])
        assert.equal(api.document.activeElement, api.input('second'))
      }, strict)
    }
  } finally { t.mock.timers.reset() }
})

test('composition starting before passive effects pauses the prior typing timer and keeps a slow IME in the same undo group', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withHistory(async api => {
      await api.focus('body', 6)
      api.afterLayout('body', 'abcdef A', input => {
        input.dispatchEvent(new api.document.defaultView!.CompositionEvent('compositionstart', { bubbles: true }))
        nativeInput(input, 'abcdef Azhong', true)
      })
      await api.type('body', 'abcdef A')
      assert.equal(api.input('body').value, 'abcdef Azhong')
      await act(async () => t.mock.timers.tick(700))
      await api.type('body', 'abcdef A中文', true)
      await act(async () => api.input('body').dispatchEvent(new api.document.defaultView!.CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
      await act(async () => { api.current().undoEdit(); t.mock.timers.tick(0) })
      assert.equal(api.input('body').value, 'abcdef')
      assert.equal(api.input('body').selectionStart, 6)
      await act(async () => api.current().redoEdit())
      assert.equal(api.input('body').value, 'abcdef A中文')
      assert.equal(api.input('body').selectionStart, 'abcdef A中文'.length)
    })
  } finally { t.mock.timers.reset() }
})

test('fresh typing after undo retires redo and keeps its rapidly committed characters in one new branch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withHistory(async api => {
      await api.focus('body', 6)
      await api.type('body', 'abcdef old')
      await act(async () => { api.current().undoEdit(); t.mock.timers.tick(0) })
      assert.equal(api.current().canRedo, true)
      api.afterLayout('body', 'abcdef c', input => nativeInput(input, 'abcdef cd'))
      await api.type('body', 'abcdef c')
      assert.equal(api.current().canRedo, false)
      await act(async () => api.current().redoEdit())
      assert.equal(api.input('body').value, 'abcdef cd')
      await act(async () => { api.current().undoEdit(); t.mock.timers.tick(0) })
      assert.equal(api.input('body').value, 'abcdef')
      await act(async () => api.current().redoEdit())
      assert.equal(api.input('body').value, 'abcdef cd')
    })
  } finally { t.mock.timers.reset() }
})

test('a committed structural checkpoint with a captured bookmark stays separate from the next native input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withHistory(async api => {
      await api.focus('body', 6)
      const before = api.current().draftBlocks
      const bookmark = captureEditorHistoryBookmark(before)
      api.afterLayout('body', 'abcdefghijkl', input => {
        api.current().pushToHistory(before, bookmark)
        input.setSelectionRange(6, 6)
      })
      await act(async () => api.current().setDraftBlocks([{ ...before[0], content: 'abcdefghijkl' }]))
      await api.type('body', 'abcdefXghijkl')
      await act(async () => { api.current().undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(api.current().draftBlocks.map(block => [block.id, block.content]), [['body', 'abcdefghijkl']])
      assert.equal(api.input('body').selectionStart, 6)
      await act(async () => { api.current().undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(api.current().draftBlocks, before)
      assert.equal(api.document.activeElement, api.input('body'))
      assert.equal(api.input('body').selectionStart, 6)
      await act(async () => { api.current().redoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(api.current().draftBlocks.map(block => [block.id, block.content]), [['body', 'abcdefghijkl']])
      await act(async () => api.current().redoEdit())
      assert.equal(api.input('body').value, 'abcdefXghijkl')
    })
  } finally { t.mock.timers.reset() }
})
