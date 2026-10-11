import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentDetail } from '../src/shared/contracts'
import type { UiText } from '../src/renderer/src/i18n'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { useSingleBlockTreeActions } from '../src/renderer/src/hooks/useSingleBlockTreeActions'
import { useBlockFocusState } from '../src/renderer/src/hooks/useBlockFocusState'
import { useBlockStructureActions } from '../src/renderer/src/hooks/useBlockStructureActions'
import { useSlashCommandActions } from '../src/renderer/src/hooks/useSlashCommandActions'
import { isNestableBlock, normalizeBlockDepth } from '../src/renderer/src/utils/draftBlockShape'
import { validateBlockTreeStructure } from '../src/renderer/src/utils/draftTreeNormalization'
import { getBlockSubtreeEndIndex } from '../src/renderer/src/utils/draftTreeMove'
import { getSlashCommandContext } from '../src/renderer/src/utils/editorAssist'
import { isDraftTreeContiguous } from '../src/renderer/src/utils/draftTreeDepthChange'

type Editor = ReturnType<typeof useDocumentEditorState>
type Actions = ReturnType<typeof useSingleBlockTreeActions>
type HarnessState = {
  editor: Editor; actions: Actions; activeBlockIndex: number | null; activeCursorPosition: number
  structure: ReturnType<typeof useBlockStructureActions>; slash: ReturnType<typeof useSlashCommandActions>
  setCursor: (index: number, position: number) => void
}

const tree = (): DocumentBlockDraft[] => [
  { id: 'before', type: 'paragraph', content: 'Alpha', checked: false, depth: 0 },
  { id: 'parent', type: 'bulleted-list', content: 'Beta', checked: false, depth: 0 },
  { id: 'child', type: 'todo', content: 'First child', checked: true, depth: 1, parentBlockId: 'parent', tags: ['keep'], highlight: 'blue' },
  { id: 'grandchild', type: 'bulleted-list', content: 'Grandchild', checked: false, depth: 2, parentBlockId: 'child' },
  { id: 'other-child', type: 'numbered-list', content: 'Second child', checked: false, depth: 1, parentBlockId: 'parent', listStart: 4 },
  { id: 'after', type: 'paragraph', content: 'After', checked: false, depth: 0 }
]

async function withTreeEditor(blocks: DocumentBlockDraft[], run: (current: () => HarnessState, document: Document) => Promise<void>) {
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
  const noop = () => {}
  let state!: HarnessState
  function Harness() {
    const editor = useDocumentEditorState({ selectedDocumentId: null, selectedDocument: null, ui: {} as UiText,
      onHomeDataChange: noop, onSelectedDocumentChange: noop, onMessage: noop })
    const [activeBlockIndex, setActiveBlockIndex] = useState<number | null>(null)
    const [activeCursorPosition, setActiveCursorPosition] = useState(0)
    const blockTextareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])
    const focus = useBlockFocusState({ activeCursorPosition, blockTextareaRefs, draftBlocks: editor.draftBlocks,
      captureBlockCursor: (index, element) => { setActiveBlockIndex(index); setActiveCursorPosition(element.selectionStart) } })
    const buildBlockTypePatch = (type: string, content: string, checked = false, depth = 0, parentBlockId: string | null = null): DocumentBlockDraft => ({ type, content,
        checked: isNestableBlock(type) ? checked : false, depth: normalizeBlockDepth(type, depth),
        parentBlockId: isNestableBlock(type) ? parentBlockId : null })
    const structure = useBlockStructureActions({ buildBlockTypePatch, draftBlocks: editor.draftBlocks,
      clearBlockSelection: noop, endBlockDrag: noop, pushToHistory: editor.pushToHistory,
      setActiveBlockIndex, setActiveCursorPosition, setPendingFocusBlockIndex: focus.setPendingFocusBlockIndex,
      setDraftBlocks: editor.setDraftBlocks })
    const actions = useSingleBlockTreeActions({ activeCursorPosition, draftBlocks: editor.draftBlocks, buildBlockTypePatch,
      clearBlockSelection: noop, endBlockDrag: noop, pushToHistory: editor.pushToHistory,
      setActiveBlockIndex, setActiveCursorPosition, setPendingFocusBlockIndex: focus.setPendingFocusBlockIndex,
      setDraftBlocks: editor.setDraftBlocks, updateDraftBlock: editor.updateDraftBlock, splitDraftBlock: structure.splitDraftBlock })
    const slash = useSlashCommandActions({ activeBlockIndex, activeCursorPosition,
      activeSlashContext: activeBlockIndex === null ? null : getSlashCommandContext(editor.draftBlocks[activeBlockIndex]?.content ?? '', activeCursorPosition),
      adjustBlockDepth: actions.adjustBlockDepth, buildBlockTypePatch, clearBlockSelection: noop, draftBlocks: editor.draftBlocks,
      duplicateDraftBlock: structure.duplicateDraftBlock, endBlockDrag: noop, insertChildDraftBlock: structure.insertChildDraftBlock,
      insertDraftBlockAt: structure.insertDraftBlockAt, moveDraftBlockBySibling: actions.moveDraftBlockBySibling,
      pushToHistory: editor.pushToHistory, setActiveBlockIndex, setActiveCursorPosition,
      setDraftBlocks: editor.setDraftBlocks, setPendingFocusBlockIndex: focus.setPendingFocusBlockIndex, updateDraftBlock: editor.updateDraftBlock })
    state = { editor, actions, activeBlockIndex, activeCursorPosition, structure, slash,
      setCursor: (index, position) => { setActiveBlockIndex(index); setActiveCursorPosition(position) } }
    return createElement('div', { className: 'block-editor-list' }, editor.draftBlocks.map((block, index) =>
      createElement('div', { key: block.id, className: 'block-editor-row', 'data-block-index': index },
        createElement('textarea', { className: 'block-inline-textarea', value: block.content, readOnly: true,
          ref: (element: HTMLTextAreaElement | null) => { blockTextareaRefs.current[index] = element } }))))
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => state.editor.loadDocumentIntoEditor({ id: 'doc', title: 'Tree editing', summary: '', blocks } as DocumentDetail))
    await run(() => state, dom.window.document)
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

function assertValid(blocks: DocumentBlockDraft[]) {
  const validation = validateBlockTreeStructure(blocks)
  assert.equal(validation.valid, true, validation.errors.join('\n'))
}

function relationships(blocks: DocumentBlockDraft[]) {
  return blocks.map(({ id, type, content, depth, parentBlockId }) => [id, type, content, depth, parentBlockId ?? null])
}

test('downgrading a list parent preserves its descendants and undo/redo restores the complete tree and focus', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withTreeEditor(tree(), async (current, document) => {
      const original = current().editor.draftBlocks
      const parent = document.querySelectorAll('textarea')[1]
      parent.focus(); parent.setSelectionRange(0, 0)
      await act(async () => current().actions.downgradeBlockAt(1))
      const downgraded = current().editor.draftBlocks
      assertValid(downgraded)
      assert.deepEqual(relationships(downgraded), [
        ['before', 'paragraph', 'Alpha', 0, null], ['parent', 'paragraph', 'Beta', 0, null],
        ['child', 'todo', 'First child', 0, null], ['grandchild', 'bulleted-list', 'Grandchild', 1, 'child'],
        ['other-child', 'numbered-list', 'Second child', 0, null], ['after', 'paragraph', 'After', 0, null]
      ])
      assert.equal(downgraded[2].checked, true)
      assert.deepEqual(downgraded[2].tags, ['keep'])
      assert.equal(downgraded[2].highlight, 'blue')
      assert.equal(downgraded[4].listStart, 4)
      assert.equal(document.activeElement, parent)
      assert.equal(parent.selectionStart, 0)

      await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().editor.draftBlocks, original)
      assert.equal(document.activeElement, parent)
      await act(async () => current().editor.redoEdit())
      assert.deepEqual(current().editor.draftBlocks, downgraded)
      assert.equal(document.activeElement, parent)
    })
  } finally { t.mock.timers.reset() }
})

test('two Backspaces downgrade then merge the parent without losing child text, identity or history', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withTreeEditor(tree(), async (current, document) => {
      const parent = document.querySelectorAll('textarea')[1]
      parent.focus(); parent.setSelectionRange(0, 0)
      await act(async () => current().actions.downgradeBlockAt(1))
      const downgraded = current().editor.draftBlocks
      await act(async () => current().actions.mergeWithPreviousBlock(1))
      const merged = current().editor.draftBlocks
      assertValid(merged)
      assert.deepEqual(relationships(merged), [
        ['before', 'paragraph', 'AlphaBeta', 0, null], ['child', 'todo', 'First child', 0, null],
        ['grandchild', 'bulleted-list', 'Grandchild', 1, 'child'], ['other-child', 'numbered-list', 'Second child', 0, null],
        ['after', 'paragraph', 'After', 0, null]
      ])
      const target = document.querySelector('textarea')!
      assert.equal(document.activeElement, target)
      assert.equal(target.selectionStart, 'Alpha'.length)
      assert.equal(current().activeBlockIndex, 0)
      assert.equal(current().activeCursorPosition, 'Alpha'.length)
      await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().editor.draftBlocks, downgraded)
      assert.equal(document.activeElement, document.querySelectorAll('textarea')[1])
      assert.equal((document.activeElement as HTMLTextAreaElement).selectionStart, 0)
      await act(async () => current().editor.redoEdit())
      assert.deepEqual(current().editor.draftBlocks, merged)
      assert.equal(document.activeElement, target)
      assert.equal(target.selectionStart, 'Alpha'.length)
    })
  } finally { t.mock.timers.reset() }
})

test('exiting an empty root list with Enter promotes descendants into a valid tree', async () => {
  const blocks = tree(); blocks[1].content = ''
  await withTreeEditor(blocks, async current => {
    await act(async () => current().actions.continueBlockAt(1, 0))
    const result = current().editor.draftBlocks
    assertValid(result)
    assert.equal(result[1].type, 'paragraph')
    assert.equal(result[2].depth, 0)
    assert.equal(result[2].parentBlockId, null)
    assert.equal(result[3].parentBlockId, 'child')
    assert.deepEqual(result.map(block => [block.id, block.content]), blocks.map(block => [block.id, block.content]))
  })
})

test('merging a paragraph from an existing invalid tree preserves and promotes every descendant', async () => {
  const blocks = tree(); blocks[1].type = 'paragraph'
  await withTreeEditor(blocks, async current => {
    await act(async () => current().actions.mergeWithPreviousBlock(1))
    const result = current().editor.draftBlocks
    assertValid(result)
    assert.equal(result[0].content, 'AlphaBeta')
    assert.deepEqual(result.slice(1).map(block => block.id), ['child', 'grandchild', 'other-child', 'after'])
  })
})

test('merging sibling list roots keeps descendants attached to the surviving root', async () => {
  const blocks = tree(); blocks[0].type = 'bulleted-list'
  await withTreeEditor(blocks, async current => {
    await act(async () => current().actions.mergeWithPreviousBlock(1))
    const result = current().editor.draftBlocks
    assertValid(result)
    assert.equal(result[0].content, 'AlphaBeta')
    assert.deepEqual(result.slice(1).map(block => [block.id, block.depth, block.parentBlockId]), [
      ['child', 1, 'before'], ['grandchild', 2, 'child'], ['other-child', 1, 'before'], ['after', 0, null]
    ])
  })
})

const typeCommand = (type: string, templateContent?: string) => ({
  id: type, label: type, description: '', keywords: [], kind: 'type' as const, type, templateContent
})

function nestedTree(content: string): DocumentBlockDraft[] {
  return [
    { id: 'outer', type: 'bulleted-list', content: 'Outer', checked: false, depth: 0 },
    { id: 'parent', type: 'bulleted-list', content, checked: false, depth: 1, parentBlockId: 'outer' },
    { id: 'child', type: 'todo', content: 'Child', checked: true, depth: 2, parentBlockId: 'parent' },
    { id: 'grandchild', type: 'bulleted-list', content: 'Grandchild', checked: false, depth: 3, parentBlockId: 'child' },
    { id: 'sibling', type: 'numbered-list', content: 'Sibling', checked: false, depth: 1, parentBlockId: 'outer' },
    { id: 'sibling-child', type: 'bulleted-list', content: 'Sibling child', checked: false, depth: 2, parentBlockId: 'sibling' },
    { id: 'after', type: 'paragraph', content: 'After', checked: false, depth: 0 }
  ]
}

test('slash conversion of a nested list preserves child trees and trailing siblings across undo/redo', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withTreeEditor(nestedTree('/h2 Beta'), async (current, document) => {
      const original = current().editor.draftBlocks
      const parent = document.querySelectorAll('textarea')[1]
      parent.focus(); parent.setSelectionRange(3, 3)
      await act(async () => current().setCursor(1, 3))
      await act(async () => current().slash.applySlashCommand(typeCommand('heading-2')))
      const converted = current().editor.draftBlocks
      assertValid(converted)
      assert.deepEqual(relationships(converted), [
        ['outer', 'bulleted-list', 'Outer', 0, null], ['parent', 'heading-2', ' Beta', 0, null],
        ['child', 'todo', 'Child', 0, null], ['grandchild', 'bulleted-list', 'Grandchild', 1, 'child'],
        ['sibling', 'numbered-list', 'Sibling', 0, null], ['sibling-child', 'bulleted-list', 'Sibling child', 1, 'sibling'],
        ['after', 'paragraph', 'After', 0, null]
      ])
      assert.equal(getBlockSubtreeEndIndex(converted, 0), 0)
      assert.equal(getBlockSubtreeEndIndex(converted, 2), 3)
      assert.equal(getBlockSubtreeEndIndex(converted, 4), 5)
      assert.equal(document.activeElement, parent)
      assert.equal(parent.selectionStart, 0)
      await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().editor.draftBlocks, original)
      assert.equal(document.activeElement, parent)
      assert.equal(parent.selectionStart, 3)
      await act(async () => current().editor.redoEdit())
      assert.deepEqual(current().editor.draftBlocks, converted)
      assert.equal(document.activeElement, parent)
    })
  } finally { t.mock.timers.reset() }
})

test('slash template replacement keeps the list root id and every child tree', async () => {
  await withTreeEditor(nestedTree('/mermaid'), async (current, document) => {
    await act(async () => current().setCursor(1, 8))
    await act(async () => current().slash.applySlashCommand({ ...typeCommand('code', 'flowchart LR\n  A --> B'), templateLanguage: 'mermaid' }))
    const result = current().editor.draftBlocks
    assertValid(result)
    assert.equal(result[1].id, 'parent')
    assert.equal(result[1].type, 'code')
    assert.equal(result[1].content, 'flowchart LR\n  A --> B')
    assert.equal(result[1].language, 'mermaid')
    assert.equal(result[1].markdownFormat?.codeInfo, 'mermaid')
    assert.deepEqual(result.slice(2).map(block => [block.id, block.depth, block.parentBlockId]), [
      ['child', 0, null], ['grandchild', 1, 'child'], ['sibling', 0, null], ['sibling-child', 1, 'sibling'], ['after', 0, null]
    ])
    const parent = document.querySelectorAll('textarea')[1]
    assert.equal(document.activeElement, parent)
    assert.equal(parent.selectionStart, result[1].content.length)
  })
})

test('inserting a slash template alongside existing list text leaves the enclosing list together', async () => {
  await withTreeEditor(nestedTree('/table Beta'), async current => {
    await act(async () => current().setCursor(1, 6))
    await act(async () => current().slash.applySlashCommand(typeCommand('table', '| A |\n| --- |\n| B |')))
    const result = current().editor.draftBlocks
    assertValid(result)
    assert.deepEqual(result.map(block => block.id).filter(id => id && id !== result[6].id),
      ['outer', 'parent', 'child', 'grandchild', 'sibling', 'sibling-child', 'after'])
    assert.equal(result[1].content, ' Beta')
    assert.equal(result[6].type, 'table')
    assert.equal(getBlockSubtreeEndIndex(result, 0), 5)
    assert.equal(result[4].parentBlockId, 'outer')
    assert.equal(current().activeBlockIndex, 6)
  })
})

test('child insertion requires a list parent and preserves valid nested insertion', async () => {
  await withTreeEditor(tree(), async current => {
    const original = current().editor.draftBlocks
    await act(async () => current().structure.insertChildDraftBlock(0, 'Do not replace this paragraph'))
    assert.deepEqual(current().editor.draftBlocks, original)
    assert.equal(current().editor.canUndo, false)
    await act(async () => current().structure.insertChildDraftBlock(1))
    const result = current().editor.draftBlocks
    assertValid(result)
    assert.equal(result.length, original.length + 1)
    assert.deepEqual(result.slice(0, 5), original.slice(0, 5))
    assert.equal(result[5].type, 'bulleted-list')
    assert.equal(result[5].depth, 1)
    assert.equal(result[5].parentBlockId, 'parent')
  })
})

test('inserting below a root list places the new sibling after every child and inherits only list formatting', async () => {
  const blocks = tree()
  blocks[1] = { ...blocks[1], type: 'numbered-todo', checked: true, listStart: 7,
    tags: ['parent-only'], highlight: 'yellow', markdownFormat: { listMarker: ')', listLoose: true } }
  await withTreeEditor(blocks, async (current, document) => {
    const original = current().editor.draftBlocks
    await act(async () => current().structure.insertDraftBlockAt(2, 1))
    const result = current().editor.draftBlocks
    assert.equal(isDraftTreeContiguous(result), true)
    assert.deepEqual(result.slice(0, 5), original.slice(0, 5))
    assert.deepEqual(result[6], original[5])
    assert.equal(result[5].type, 'numbered-todo')
    assert.equal(result[5].content, '')
    assert.equal(result[5].checked, false)
    assert.equal(result[5].depth, 0)
    assert.equal(result[5].parentBlockId, null)
    assert.deepEqual(result[5].markdownFormat, blocks[1].markdownFormat)
    assert.notEqual(result[5].markdownFormat, result[1].markdownFormat)
    assert.equal(result[5].listStart, undefined)
    assert.equal(result[5].tags, undefined)
    assert.equal(result[5].highlight, undefined)
    assert.equal(new Set(result.map(block => block.id)).size, result.length)
    assert.equal(document.activeElement, document.querySelectorAll('textarea')[5])
    assert.equal(current().activeBlockIndex, 5)
    assert.equal(current().activeCursorPosition, 0)
  })
})

for (const below of [false, true]) {
  test(`inserting ${below ? 'below' : 'above'} a nested parent preserves complete trees and undo/redo selection`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      await withTreeEditor(nestedTree('Beta'), async (current, document) => {
        const original = current().editor.draftBlocks
        const parent = document.querySelectorAll('textarea')[1]
        parent.focus(); parent.setSelectionRange(1, 3, 'backward')
        await act(async () => current().structure.insertDraftBlockAt(below ? 2 : 1, 1))
        const result = current().editor.draftBlocks
        const insertionIndex = below ? 4 : 1
        assert.equal(isDraftTreeContiguous(result), true)
        assert.deepEqual(result.filter((_, index) => index !== insertionIndex), original)
        assert.equal(result[insertionIndex].depth, 1)
        assert.equal(result[insertionIndex].parentBlockId, 'outer')
        assert.equal(result[insertionIndex].type, 'bulleted-list')
        const inserted = document.querySelectorAll('textarea')[insertionIndex]
        assert.equal(document.activeElement, inserted)
        assert.equal(inserted.selectionStart, 0)
        await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
        assert.deepEqual(current().editor.draftBlocks, original)
        assert.equal(document.activeElement, parent)
        assert.deepEqual([parent.selectionStart, parent.selectionEnd, parent.selectionDirection], [1, 3, 'backward'])
        await act(async () => current().editor.redoEdit())
        assert.deepEqual(JSON.parse(JSON.stringify(current().editor.draftBlocks)), JSON.parse(JSON.stringify(result)))
        assert.equal(document.activeElement, document.querySelectorAll('textarea')[insertionIndex])
        assert.equal((document.activeElement as HTMLTextAreaElement).selectionStart, 0)
      })
    } finally { t.mock.timers.reset() }
  })
}

for (const action of ['insert-above', 'insert-below'] as const) {
  test(`slash ${action} removes only the command and inserts a sibling as one undoable operation`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      await withTreeEditor(nestedTree('/below Beta'), async (current, document) => {
        const original = current().editor.draftBlocks
        const parent = document.querySelectorAll('textarea')[1]
        parent.focus(); parent.setSelectionRange(6, 6)
        await act(async () => current().setCursor(1, 6))
        await act(async () => current().slash.applySlashCommand({ id: action, label: action, description: '',
          keywords: [], kind: 'action', action }))
        const result = current().editor.draftBlocks
        const insertionIndex = action === 'insert-above' ? 1 : 4
        assert.equal(isDraftTreeContiguous(result), true)
        assert.deepEqual(result.filter((_, index) => index !== insertionIndex),
          original.map(block => block.id === 'parent' ? { ...block, content: ' Beta' } : block))
        assert.equal(result[insertionIndex].parentBlockId, 'outer')
        assert.equal(result[insertionIndex].depth, 1)
        assert.equal(document.activeElement, document.querySelectorAll('textarea')[insertionIndex])
        await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
        assert.deepEqual(current().editor.draftBlocks, original)
        assert.equal(current().editor.canUndo, false)
        assert.equal(document.activeElement, parent)
        assert.equal(parent.selectionStart, 6)
        await act(async () => current().editor.redoEdit())
        assert.deepEqual(JSON.parse(JSON.stringify(current().editor.draftBlocks)), JSON.parse(JSON.stringify(result)))
      })
    } finally { t.mock.timers.reset() }
  })
}

test('invalid insertion anchors leave redo available and unanchored insertion still appends a paragraph', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withTreeEditor(tree(), async current => {
      const original = current().editor.draftBlocks
      await act(async () => current().structure.insertDraftBlockAt(2, 1))
      await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
      assert.equal(current().editor.canRedo, true)
      for (const anchor of [-1, 99]) {
        await act(async () => current().structure.insertDraftBlockAt(2, anchor, 'Do not change anything'))
        assert.deepEqual(current().editor.draftBlocks, original)
        assert.equal(current().editor.canRedo, true)
        assert.equal(current().editor.canUndo, false)
      }
      await act(async () => current().slash.addDraftBlock())
      const result = current().editor.draftBlocks
      assert.deepEqual(result.slice(0, original.length), original)
      assert.equal(result.at(-1)?.type, 'paragraph')
      assert.equal(result.at(-1)?.depth, 0)
      assert.equal(isDraftTreeContiguous(result), true)
    })
  } finally { t.mock.timers.reset() }
})
