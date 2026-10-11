import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, type FormEvent } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentDetail } from '../src/shared/contracts'
import type { UiText } from '../src/renderer/src/i18n'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'

type Editor = ReturnType<typeof useDocumentEditorState>

async function withEditor(run: (editor: () => Editor, document: Document) => Promise<void>, secondBlock = false) {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: (): number => 1, cancelAnimationFrame: (): void => {}, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let editor!: Editor
  const noop = () => {}
  function Harness() {
    editor = useDocumentEditorState({ selectedDocumentId: null, selectedDocument: null, ui: {} as UiText,
      onHomeDataChange: noop, onSelectedDocumentChange: noop, onMessage: noop })
    return createElement('div', { className: 'block-editor-list' }, editor.draftBlocks.map((block, index) => createElement('div', {
      key: block.id, className: 'block-editor-row', 'data-block-index': index
    }, createElement('textarea', { className: 'block-inline-textarea', value: block.content, onChange: noop,
      onInput: (event: FormEvent<HTMLTextAreaElement>) => editor.updateDraftBlock(index, { content: event.currentTarget.value }) }),
    createElement('div', { className: 'markdown-format-toolbar' }, createElement('button', { type: 'button' }, 'Bold')))),
    createElement('input', { 'aria-label': 'Title', value: editor.draftTitle, onChange: noop,
      onInput: (event: FormEvent<HTMLInputElement>) => editor.setDraftTitle(event.currentTarget.value) }),
    createElement('textarea', { 'aria-label': 'Summary', value: editor.draftSummary, onChange: noop,
      onInput: (event: FormEvent<HTMLTextAreaElement>) => editor.setDraftSummary(event.currentTarget.value) }))
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => editor.loadDocumentIntoEditor({ id: 'doc', title: 'test', summary: '', blocks: [
      { id: 'body', type: 'paragraph', content: 'abcdef', checked: false, depth: 0 },
      ...(secondBlock ? [{ id: 'second', type: 'paragraph' as const, content: 'second', checked: false, depth: 0 }] : [])
    ] } as DocumentDetail))
    await run(() => editor, dom.window.document)
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

async function inputText(input: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => {
    input.dispatchEvent(new input.ownerDocument.defaultView!.InputEvent('beforeinput', { bubbles: true, inputType: 'insertText' }))
    input.value = value
    input.dispatchEvent(new input.ownerDocument.defaultView!.InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  })
}

test('typing in two blocks within the idle debounce creates separate undo transactions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(async (current, document) => {
      const [first, second] = document.querySelectorAll<HTMLTextAreaElement>('.block-inline-textarea')
      await act(async () => first.focus())
      await inputText(first, 'abcdef A')
      await act(async () => second.focus())
      second.setSelectionRange(6, 6)
      await inputText(second, 'second B')
      await act(async () => { current().undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().draftBlocks.map(block => block.content), ['abcdef A', 'second'])
      assert.equal(document.activeElement, second)
      assert.equal(second.selectionStart, 6)
      await act(async () => { current().undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().draftBlocks.map(block => block.content), ['abcdef', 'second'])
      assert.equal(document.activeElement, first)
      await act(async () => { current().redoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().draftBlocks.map(block => block.content), ['abcdef A', 'second'])
      await act(async () => current().redoEdit())
      assert.deepEqual(current().draftBlocks.map(block => block.content), ['abcdef A', 'second B'])
      assert.equal(document.activeElement, second)
    }, true)
  } finally { t.mock.timers.reset() }
})

test('same-block typing and a visit to its format toolbar remain one transaction', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(async (current, document) => {
      const input = document.querySelector<HTMLTextAreaElement>('.block-inline-textarea')!
      await act(async () => input.focus())
      await inputText(input, 'abcdef A')
      await act(async () => document.querySelector<HTMLButtonElement>('.markdown-format-toolbar button')!.focus())
      await act(async () => input.focus())
      await inputText(input, 'abcdef AB')
      await act(async () => { current().undoEdit(); t.mock.timers.tick(0) })
      assert.equal(input.value, 'abcdef')
      await act(async () => current().redoEdit())
      assert.equal(input.value, 'abcdef AB')
    })
  } finally { t.mock.timers.reset() }
})

test('title and summary edits split body typing without joining document undo', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(async (current, document) => {
      const body = document.querySelector<HTMLTextAreaElement>('.block-inline-textarea')!
      const title = document.querySelector<HTMLInputElement>('[aria-label="Title"]')!
      const summary = document.querySelector<HTMLTextAreaElement>('[aria-label="Summary"]')!
      await act(async () => body.focus())
      await inputText(body, 'abcdef A')
      await act(async () => title.focus())
      await inputText(title, 'New title')
      await act(async () => summary.focus())
      await inputText(summary, 'New summary')
      await act(async () => body.focus())
      await inputText(body, 'abcdef AB')
      await act(async () => { current().undoEdit(); t.mock.timers.tick(0) })
      assert.equal(body.value, 'abcdef A')
      assert.equal(title.value, 'New title')
      assert.equal(summary.value, 'New summary')
      await act(async () => current().undoEdit())
      assert.equal(body.value, 'abcdef')
      assert.equal(title.value, 'New title')
      assert.equal(summary.value, 'New summary')
    })
  } finally { t.mock.timers.reset() }
})

test('composition stays one transaction and remains separate from the next block', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(async (current, document) => {
      const [first, second] = document.querySelectorAll<HTMLTextAreaElement>('.block-inline-textarea')
      await act(async () => {
        first.focus()
        first.dispatchEvent(new document.defaultView!.CompositionEvent('compositionstart', { bubbles: true }))
      })
      await inputText(first, 'abcdef zhong')
      await act(async () => t.mock.timers.tick(700))
      await inputText(first, 'abcdef 中文')
      await act(async () => first.dispatchEvent(new document.defaultView!.CompositionEvent('compositionend', { bubbles: true })))
      await act(async () => second.focus())
      await inputText(second, 'second B')
      await act(async () => { current().undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().draftBlocks.map(block => block.content), ['abcdef 中文', 'second'])
      await act(async () => current().undoEdit())
      assert.deepEqual(current().draftBlocks.map(block => block.content), ['abcdef', 'second'])
    }, true)
  } finally { t.mock.timers.reset() }
})

test('IME replacement restores the original backward selection on undo and the committed caret on redo', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(async (current, document) => {
      const input = document.querySelector<HTMLTextAreaElement>('.block-inline-textarea')!
      await act(async () => input.focus())
      input.setSelectionRange(2, 5, 'backward')
      await act(async () => input.dispatchEvent(new document.defaultView!.CompositionEvent('compositionstart', { bubbles: true })))
      await inputText(input, 'abzhongf')
      await act(async () => t.mock.timers.tick(700))
      await inputText(input, 'ab中文f')
      input.setSelectionRange(4, 4)
      await act(async () => input.dispatchEvent(new document.defaultView!.CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
      await act(async () => { current().undoEdit(); t.mock.timers.tick(0) })
      assert.equal(input.value, 'abcdef')
      assert.equal(document.activeElement, input)
      assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [2, 5, 'backward'])
      await act(async () => current().redoEdit())
      assert.equal(input.value, 'ab中文f')
      assert.deepEqual([input.selectionStart, input.selectionEnd], [4, 4])
    })
  } finally { t.mock.timers.reset() }
})

test('starting composition within a pending typing group keeps both edits together', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(async (current, document) => {
      const input = document.querySelector<HTMLTextAreaElement>('.block-inline-textarea')!
      await act(async () => input.focus())
      input.setSelectionRange(6, 6)
      await inputText(input, 'abcdef A')
      await act(async () => input.dispatchEvent(new document.defaultView!.CompositionEvent('compositionstart', { bubbles: true })))
      await inputText(input, 'abcdef A中文')
      await act(async () => input.dispatchEvent(new document.defaultView!.CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
      await act(async () => { current().undoEdit(); t.mock.timers.tick(0) })
      assert.equal(input.value, 'abcdef')
      assert.deepEqual([input.selectionStart, input.selectionEnd], [6, 6])
      await act(async () => current().redoEdit())
      assert.equal(input.value, 'abcdef A中文')
    })
  } finally { t.mock.timers.reset() }
})

test('undo availability updates immediately and new edits invalidate redo before debounce', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(async current => {
      await act(async () => current().updateDraftBlock(0, { content: 'version B' }))
      assert.equal(current().canUndo, true)
      await act(async () => { current().undoEdit(); t.mock.timers.tick(0) })
      assert.equal(current().draftBlocks[0].content, 'abcdef')
      assert.equal(current().canRedo, true)
      await act(async () => current().updateDraftBlock(0, { content: 'new version C' }))
      assert.equal(current().canRedo, false)
      await act(async () => current().redoEdit())
      assert.equal(current().draftBlocks[0].content, 'new version C')
      await act(async () => current().undoEdit())
      assert.equal(current().draftBlocks[0].content, 'abcdef')
    })
  } finally { t.mock.timers.reset() }
})

test('format undo and redo restore the original and resulting selections', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(async (current, document) => {
      const input = document.querySelector('textarea')!
      input.focus()
      input.setSelectionRange(2, 5, 'backward')
      await act(async () => { current().checkpointDraft(); current().updateDraftBlock(0, { content: 'ab**cde**f' }) })
      input.setSelectionRange(4, 7)
      await act(async () => { current().undoEdit(); t.mock.timers.tick(0) })
      assert.equal(document.activeElement, input)
      assert.equal(input.value, 'abcdef')
      assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [2, 5, 'backward'])
      await act(async () => current().redoEdit())
      assert.equal(input.value, 'ab**cde**f')
      assert.deepEqual([input.selectionStart, input.selectionEnd], [4, 7])
    })
  } finally { t.mock.timers.reset() }
})

test('removing a focused new block through undo restores focus to the preceding checkpoint', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(async (current, document) => {
      const original = document.querySelector<HTMLTextAreaElement>('.block-inline-textarea')!
      await act(async () => { original.focus(); original.setSelectionRange(3, 3) })
      await act(async () => {
        current().checkpointDraft()
        current().setDraftBlocks([...current().draftBlocks, { id: 'new', type: 'paragraph', content: '', checked: false, depth: 0 }])
      })
      const added = document.querySelectorAll<HTMLTextAreaElement>('.block-inline-textarea')[1]
      await act(async () => added.focus())
      await act(async () => { current().undoEdit(); t.mock.timers.tick(0) })
      assert.equal(document.querySelectorAll('.block-inline-textarea').length, 1)
      assert.equal(document.activeElement, original)
      assert.equal(original.selectionStart, 3)
      await act(async () => current().redoEdit())
      assert.equal(document.activeElement, document.querySelectorAll('.block-inline-textarea')[1])
    })
  } finally { t.mock.timers.reset() }
})
