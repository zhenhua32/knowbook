import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentDetail } from '../src/shared/contracts'
import type { UiText } from '../src/renderer/src/i18n'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'

type Editor = ReturnType<typeof useDocumentEditorState>

async function withEditor(run: (editor: () => Editor, document: Document) => Promise<void>) {
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
    return createElement('div', null, editor.draftBlocks.map((block, index) => createElement('div', {
      key: block.id, className: 'block-editor-row', 'data-block-index': index
    }, createElement('textarea', { className: 'block-inline-textarea', value: block.content, readOnly: true }))))
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => editor.loadDocumentIntoEditor({ id: 'doc', title: 'test', summary: '', blocks: [
      { id: 'body', type: 'paragraph', content: 'abcdef', checked: false, depth: 0 }
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
      const original = document.querySelector('textarea')!
      original.focus(); original.setSelectionRange(3, 3)
      await act(async () => {
        current().checkpointDraft()
        current().setDraftBlocks([...current().draftBlocks, { id: 'new', type: 'paragraph', content: '', checked: false, depth: 0 }])
      })
      const added = document.querySelectorAll('textarea')[1]
      added.focus()
      await act(async () => { current().undoEdit(); t.mock.timers.tick(0) })
      assert.equal(document.querySelectorAll('textarea').length, 1)
      assert.equal(document.activeElement, original)
      assert.equal(original.selectionStart, 3)
      await act(async () => current().redoEdit())
      assert.equal(document.activeElement, document.querySelectorAll('textarea')[1])
    })
  } finally { t.mock.timers.reset() }
})
