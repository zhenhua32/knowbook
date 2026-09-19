import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { parseMarkdownBlocks } from '../src/shared/markdown'
import type { DocumentDetail } from '../src/shared/contracts'
import type { UiText } from '../src/renderer/src/i18n'

test('save acknowledgements preserve reading task redo and history boundaries', async t => {
  const dom = new JSDOM('<div id="mount"></div>')
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let editor!: ReturnType<typeof useDocumentEditorState>
  const noop = () => {}
  function Harness({ reading }: { reading: boolean }) {
    editor = useDocumentEditorState({ selectedDocumentId: null, selectedDocument: null, isReadingMode: reading,
      ui: {} as UiText, onHomeDataChange: noop, onSelectedDocumentChange: noop, onMessage: noop })
    return null
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const source = '# **Tasks** $x$\n\n- [ ] Parent\n  - [x] Child\n\n* [ ] Complex\n\n  > Nested quote\n  > - [ ] Quoted task\n\n  continuation\n\n> [!tip]+ Work\n> - [ ] Callout task\n\nNote[^n]\n\n[^n]: - [ ] Footnote task\n\n3. Numbered\n4. Last\n\n`- [ ] code`'
  try {
    await act(async () => root.render(createElement(Harness, { reading: false })))
    await act(async () => editor.loadDocumentIntoEditor({ title: 'test', summary: '', blocks: [{ id: 'empty', type: 'paragraph', content: '', checked: false, depth: 0 }] } as DocumentDetail))
    await act(async () => { editor.checkpointDraft(); editor.setDraftBlocks(parseMarkdownBlocks(source).map((block, index) => ({ ...block, id: `b${index}`, depth: block.depth ?? 0, checked: block.checked ?? false, language: block.language ?? undefined }))) })
    await act(async () => { editor.undoEdit(); t.mock.timers.tick(0) })
    await act(async () => root.render(createElement(Harness, { reading: true })))
    await act(async () => editor.redoEdit())
    await act(async () => root.render(createElement(Harness, { reading: false })))
    await act(async () => { editor.redoEdit(); t.mock.timers.tick(0) })
    await act(async () => root.render(createElement(Harness, { reading: true })))
    await act(async () => editor.undoEdit())
    assert.equal(editor.canUndo, false, 'reading mode must keep the earlier source edit outside its undo scope')
    const index = editor.draftBlocks.findIndex(block => block.content.includes('Quoted task'))
    assert.ok(index >= 0)
    await act(async () => { editor.checkpointDraft(); editor.updateDraftBlock(index, { content: editor.draftBlocks[index].content.replace('[ ] Quoted task', '[x] Quoted task') }) })
    await act(async () => { editor.undoEdit(); t.mock.timers.tick(0) })
    // A save acknowledgement hydrates equivalent blocks with database field
    // order. It must not become a new user edit or truncate the redo branch.
    await act(async () => editor.setDraftBlocks(editor.draftBlocks.map(block => { const { id, type, content, ...rest } = block; return { id, type, content, ...rest } })))
    await act(async () => editor.undoEdit())
    assert.equal(editor.canUndo, false)
    assert.equal(editor.canRedo, true)
    await act(async () => editor.redoEdit())
    assert.ok(editor.draftBlocks[index].content.includes('[x] Quoted task'))
  } finally {
    await act(async () => root.unmount())
    t.mock.timers.reset()
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  }
})
