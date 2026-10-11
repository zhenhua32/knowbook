import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentDetail } from '../src/shared/contracts'
import type { UiText } from '../src/renderer/src/i18n'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { validateBlockTreeStructure } from '../src/renderer/src/utils/draftTreeNormalization'

type Editor = ReturnType<typeof useDocumentEditorState>

const initialBlocks: DocumentBlockDraft[] = [
  { id: 'root', type: 'numbered-todo', content: 'Parent', checked: true, depth: 0, parentBlockId: null, listStart: 5 },
  { id: 'child', type: 'bulleted-list', content: 'Child', checked: false, depth: 1, parentBlockId: 'root' },
  { id: 'grandchild', type: 'todo', content: 'Grandchild', checked: true, depth: 2, parentBlockId: 'child', tags: ['kept'], highlight: 'green' },
  { id: 'sibling', type: 'numbered-list', content: 'Sibling', checked: false, depth: 1, parentBlockId: 'root', listStart: 7 },
  { id: 'sibling-child', type: 'todo', content: 'Sibling child', checked: true, depth: 2, parentBlockId: 'sibling' },
  { id: 'after', type: 'paragraph', content: 'Following paragraph', checked: false, depth: 0, parentBlockId: null }
]

async function withEditor(index: number, type: string, run: (editor: () => Editor, button: HTMLButtonElement) => Promise<void>) {
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
    return createElement('button', { type: 'button', onClick: () => {
      editor.checkpointDraft()
      editor.updateDraftBlock(index, { type })
    } }, 'Convert block type')
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => editor.loadDocumentIntoEditor({ id: 'doc', title: 'List tree', summary: '', blocks: initialBlocks } as DocumentDetail))
    await run(() => editor, dom.window.document.querySelector('button')!)
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

function tree(blocks: DocumentBlockDraft[]) {
  return blocks.map(({ id, type, depth, parentBlockId }) => ({ id, type, depth, parentBlockId }))
}

function assertValid(blocks: DocumentBlockDraft[]) {
  assert.deepEqual(validateBlockTreeStructure(blocks), { valid: true, errors: [] })
  assert.deepEqual(blocks.map(block => [block.id, block.content]), initialBlocks.map(block => [block.id, block.content]))
  assert.deepEqual(blocks.find(block => block.id === 'grandchild')?.tags, ['kept'])
  assert.equal(blocks.find(block => block.id === 'grandchild')?.highlight, 'green')
  assert.equal(blocks.find(block => block.id === 'grandchild')?.checked, true)
  assert.equal(blocks.find(block => block.id === 'sibling')?.listStart, 7)
}

for (const index of [0, 1]) {
  test(`converting a ${index === 0 ? 'root' : 'nested'} list parent to paragraph preserves valid descendants through undo and redo`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      await withEditor(index, 'paragraph', async (current, button) => {
        const original = tree(current().draftBlocks)
        assertValid(current().draftBlocks)
        await act(async () => button.click())
        const converted = tree(current().draftBlocks)
        assert.deepEqual(converted, index === 0 ? [
          { id: 'root', type: 'paragraph', depth: 0, parentBlockId: null },
          { id: 'child', type: 'bulleted-list', depth: 0, parentBlockId: null },
          { id: 'grandchild', type: 'todo', depth: 1, parentBlockId: 'child' },
          { id: 'sibling', type: 'numbered-list', depth: 0, parentBlockId: null },
          { id: 'sibling-child', type: 'todo', depth: 1, parentBlockId: 'sibling' },
          { id: 'after', type: 'paragraph', depth: 0, parentBlockId: null }
        ] : [
          { id: 'root', type: 'numbered-todo', depth: 0, parentBlockId: null },
          { id: 'child', type: 'paragraph', depth: 0, parentBlockId: null },
          { id: 'grandchild', type: 'todo', depth: 0, parentBlockId: null },
          { id: 'sibling', type: 'numbered-list', depth: 0, parentBlockId: null },
          { id: 'sibling-child', type: 'todo', depth: 1, parentBlockId: 'sibling' },
          { id: 'after', type: 'paragraph', depth: 0, parentBlockId: null }
        ])
        assertValid(current().draftBlocks)
        await act(async () => { current().undoEdit(); t.mock.timers.tick(0) })
        assert.deepEqual(tree(current().draftBlocks), original)
        assertValid(current().draftBlocks)
        await act(async () => current().redoEdit())
        assert.deepEqual(tree(current().draftBlocks), converted)
        assertValid(current().draftBlocks)
      })
    } finally { t.mock.timers.reset() }
  })
}

test('converting between nestable list types retains the existing descendant tree', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(1, 'numbered-todo', async (current, button) => {
      const original = tree(current().draftBlocks)
      await act(async () => button.click())
      assert.deepEqual(tree(current().draftBlocks), original.map((block, index) => index === 1 ? { ...block, type: 'numbered-todo' } : block))
      assertValid(current().draftBlocks)
      await act(async () => current().undoEdit())
      assert.deepEqual(tree(current().draftBlocks), original)
    })
  } finally { t.mock.timers.reset() }
})
