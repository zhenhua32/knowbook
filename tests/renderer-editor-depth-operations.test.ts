import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentDetail } from '../src/shared/contracts'
import type { UiText } from '../src/renderer/src/i18n'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { useSingleBlockTreeActions } from '../src/renderer/src/hooks/useSingleBlockTreeActions'
import { useMultiBlockActions } from '../src/renderer/src/hooks/useMultiBlockActions'
import { useBlockSelectionState } from '../src/renderer/src/hooks/useBlockSelectionState'
import { useBlockFocusState } from '../src/renderer/src/hooks/useBlockFocusState'
import { useSlashCommandActions } from '../src/renderer/src/hooks/useSlashCommandActions'
import { isNestableBlock, normalizeBlockDepth } from '../src/renderer/src/utils/draftBlockShape'
import { isDraftTreeContiguous, planDraftBlockDepthChange } from '../src/renderer/src/utils/draftTreeDepthChange'
import { validateBlockTreeStructure } from '../src/renderer/src/utils/draftTreeNormalization'
import { getBlockSubtreeEndIndex } from '../src/renderer/src/utils/draftTreeMove'
import { getVisibleDocumentEntries } from '../src/renderer/src/utils/documentSections'
import { getSlashCommandContext } from '../src/renderer/src/utils/editorAssist'

type State = {
  editor: ReturnType<typeof useDocumentEditorState>
  single: ReturnType<typeof useSingleBlockTreeActions>
  multi: ReturnType<typeof useMultiBlockActions>
  selection: ReturnType<typeof useBlockSelectionState>
  slash: ReturnType<typeof useSlashCommandActions>
  activeBlockIndex: number | null
  activeCursorPosition: number
  setCursor: (index: number, position: number) => void
  collapse: (ids: string[]) => void
}

function nestedTree(content = 'Branch'): DocumentBlockDraft[] {
  return [
    { id: 'outer', type: 'bulleted-list', content: 'Outer', checked: false, depth: 0 },
    { id: 'branch', type: 'todo', content, checked: true, depth: 1, parentBlockId: 'outer', tags: ['keep'], highlight: 'blue' },
    { id: 'child', type: 'numbered-list', content: 'Child', checked: false, depth: 2, parentBlockId: 'branch', listStart: 4 },
    { id: 'grandchild', type: 'bulleted-list', content: 'Grandchild', checked: false, depth: 3, parentBlockId: 'child' },
    { id: 'sibling', type: 'bulleted-list', content: 'Sibling', checked: false, depth: 1, parentBlockId: 'outer' },
    { id: 'sibling-child', type: 'todo', content: 'Sibling child', checked: true, depth: 2, parentBlockId: 'sibling' },
    { id: 'after', type: 'paragraph', content: 'After', checked: false, depth: 0 }
  ]
}

async function withEditor(blocks: DocumentBlockDraft[], run: (current: () => State, document: Document) => Promise<void>) {
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
  let state!: State
  function Harness() {
    const editor = useDocumentEditorState({ selectedDocumentId: null, selectedDocument: null, ui: {} as UiText,
      onHomeDataChange: noop, onSelectedDocumentChange: noop, onMessage: noop })
    const [activeBlockIndex, setActiveBlockIndex] = useState<number | null>(null)
    const [activeCursorPosition, setActiveCursorPosition] = useState(0)
    const [collapsedBlockIds, setCollapsedBlockIds] = useState(new Set<string>())
    const selection = useBlockSelectionState({ activeBlockIndex, collapsedBlockIds, draftBlocks: editor.draftBlocks,
      onActiveBlockChange: setActiveBlockIndex, visibleSliceCrossParentGuard: 'different parents', selectionStaleGuard: 'stale' })
    const blockTextareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])
    const focus = useBlockFocusState({ activeCursorPosition, blockTextareaRefs, draftBlocks: editor.draftBlocks,
      captureBlockCursor: (index, element) => { setActiveBlockIndex(index); setActiveCursorPosition(element.selectionStart) } })
    const buildBlockTypePatch = (type: string, content: string, checked = false, depth = 0, parentBlockId: string | null = null): DocumentBlockDraft =>
      ({ type, content, checked: isNestableBlock(type) ? checked : false, depth: normalizeBlockDepth(type, depth), parentBlockId: isNestableBlock(type) ? parentBlockId : null })
    const shared = { activeCursorPosition, draftBlocks: editor.draftBlocks, buildBlockTypePatch,
      clearBlockSelection: selection.clearBlockSelection, endBlockDrag: noop, pushToHistory: editor.pushToHistory,
      setActiveBlockIndex, setActiveCursorPosition, setPendingFocusBlockIndex: focus.setPendingFocusBlockIndex, setDraftBlocks: editor.setDraftBlocks }
    const single = useSingleBlockTreeActions({ ...shared, updateDraftBlock: editor.updateDraftBlock, splitDraftBlock: noop })
    const multi = useMultiBlockActions({ ...shared, activeBlockIndex, selectedBlockRange: selection.selectedBlockRange,
      getMultiBlockInteractionGuard: selection.getMultiBlockInteractionGuard, getMultiBlockOperationRange: selection.getMultiBlockOperationRange,
      getVisibleSiblingSelectionSlice: selection.getVisibleSiblingSelectionSlice, setSelectedBlockRange: selection.setSelectedBlockRange,
      setSelectionAnchorBlockId: selection.setSelectionAnchorBlockId, notify: noop,
      ui: { convertedBlocks: () => '', copiedBlocks: () => '', copiedPlainText: () => '', copyFailed: '', copyTextFailed: '', cutBlocks: () => '',
        cutFailed: '', deletedBlocks: () => '', duplicatedBlocks: () => '', invalidVisibleTreeSlice: '' } })
    const slash = useSlashCommandActions({ ...shared, activeBlockIndex,
      activeSlashContext: activeBlockIndex === null ? null : getSlashCommandContext(editor.draftBlocks[activeBlockIndex]?.content ?? '', activeCursorPosition),
      adjustBlockDepth: single.adjustBlockDepth, duplicateDraftBlock: noop, insertChildDraftBlock: noop, insertDraftBlockAt: noop,
      moveDraftBlockBySibling: single.moveDraftBlockBySibling, updateDraftBlock: editor.updateDraftBlock })
    state = { editor, single, multi, selection, slash, activeBlockIndex, activeCursorPosition,
      setCursor: (index, position) => { setActiveBlockIndex(index); setActiveCursorPosition(position) },
      collapse: ids => setCollapsedBlockIds(new Set(ids)) }
    return createElement('div', { className: 'block-editor-list' }, selection.getVisibleBlockEntries(editor.draftBlocks).map(({ block, index }) =>
      createElement('div', { key: block.id, className: 'block-editor-row', 'data-block-index': index, 'data-block-id': block.id },
        createElement('textarea', { className: 'block-inline-textarea', value: block.content, readOnly: true,
          ref: (element: HTMLTextAreaElement | null) => { if (element || !blockTextareaRefs.current[index]?.isConnected) blockTextareaRefs.current[index] = element } }))))
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => state.editor.loadDocumentIntoEditor({ id: 'doc', title: 'Depth editing', summary: '', blocks } as DocumentDetail))
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
  assert.equal(isDraftTreeContiguous(blocks), true, 'parent references must stay inside consecutive subtrees')
}

function relationships(blocks: DocumentBlockDraft[]) {
  return blocks.map(({ id, depth, parentBlockId }) => [id, depth, parentBlockId ?? null])
}

const outdented = [ ['outer', 0, null], ['sibling', 1, 'outer'], ['sibling-child', 2, 'sibling'],
  ['branch', 0, null], ['child', 1, 'branch'], ['grandchild', 2, 'child'], ['after', 0, null] ]

test('single Shift+Tab moves the complete branch after its old parent, preserves attributes, caret, and undo/redo', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(nestedTree(), async (current, document) => {
      const original = current().editor.draftBlocks
      const textarea = document.querySelector<HTMLTextAreaElement>('[data-block-id="branch"] textarea')!
      textarea.focus(); textarea.setSelectionRange(3, 3)
      await act(async () => current().setCursor(1, 3))
      await act(async () => current().single.adjustBlockDepth(1, -1))
      const result = current().editor.draftBlocks
      assertValid(result)
      assert.deepEqual(relationships(result), outdented)
      assert.deepEqual(result[3], { ...original[1], depth: 0, parentBlockId: null })
      assert.deepEqual(result[4], { ...original[2], depth: 1 })
      assert.equal(getBlockSubtreeEndIndex(result, 0), 2)
      assert.equal(getBlockSubtreeEndIndex(result, 3), 5)
      assert.equal(document.activeElement, textarea)
      assert.equal(textarea.selectionStart, 3)
      assert.equal(current().activeBlockIndex, 3)
      assert.deepEqual(getVisibleDocumentEntries(result, { collapsedIds: new Set(['outer']), focusedHeadingId: null }).map(({ block }) => block.id),
        ['outer', 'branch', 'child', 'grandchild', 'after'])
      await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().editor.draftBlocks, original)
      assert.equal(document.activeElement, textarea)
      assert.equal(textarea.selectionStart, 3)
      await act(async () => { current().editor.redoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().editor.draftBlocks, result)
      assert.equal(document.activeElement, textarea)
    })
  } finally { t.mock.timers.reset() }
})

test('Tab attaches a root subtree to the preceding list root after its existing descendants', async () => {
  await withEditor(nestedTree(), async current => {
    await act(async () => current().single.adjustBlockDepth(1, -1))
    await act(async () => current().single.adjustBlockDepth(3, 1, 2))
    const result = current().editor.draftBlocks
    assertValid(result)
    assert.deepEqual(relationships(result), [ ['outer', 0, null], ['sibling', 1, 'outer'], ['sibling-child', 2, 'sibling'],
      ['branch', 1, 'outer'], ['child', 2, 'branch'], ['grandchild', 3, 'child'], ['after', 0, null] ])
    assert.equal(current().activeBlockIndex, 3)
    assert.equal(current().activeCursorPosition, 2)
  })
})

test('outdenting a deeper child keeps its old siblings under the parent and its new siblings under the grandparent', async () => {
  const blocks = nestedTree()
  blocks.splice(4, 0, { id: 'inner-tail', type: 'todo', content: 'Inner tail', checked: true, depth: 2, parentBlockId: 'branch' })
  await withEditor(blocks, async current => {
    await act(async () => current().single.adjustBlockDepth(2, -1, 1))
    const result = current().editor.draftBlocks
    assertValid(result)
    assert.deepEqual(relationships(result), [ ['outer', 0, null], ['branch', 1, 'outer'], ['inner-tail', 2, 'branch'],
      ['child', 1, 'outer'], ['grandchild', 2, 'child'], ['sibling', 1, 'outer'], ['sibling-child', 2, 'sibling'], ['after', 0, null] ])
    assert.equal(current().activeBlockIndex, 3)
    assert.equal(current().activeCursorPosition, 1)
    assert.equal(getBlockSubtreeEndIndex(result, 1), 2)
    assert.equal(getBlockSubtreeEndIndex(result, 3), 4)
  })
})

test('Backspace and empty Enter share complete subtree outdent behavior', async () => {
  for (const action of ['backspace', 'enter'] as const) {
    await withEditor(nestedTree(action === 'enter' ? '' : 'Branch'), async current => {
      await act(async () => action === 'backspace' ? current().single.downgradeBlockAt(1) : current().single.continueBlockAt(1, 0))
      const result = current().editor.draftBlocks
      assertValid(result)
      assert.deepEqual(relationships(result), outdented)
      assert.equal(result[3].type, 'todo')
      assert.equal(result[3].checked, true)
    })
  }
})

test('slash outdent preserves the queued command removal and the original content in undo', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(nestedTree('/outdent Branch'), async current => {
      const original = current().editor.draftBlocks
      await act(async () => current().setCursor(1, 8))
      await act(async () => current().slash.applySlashCommand({ id: 'outdent', label: '', description: '', keywords: [], kind: 'action', action: 'outdent' }))
      const result = current().editor.draftBlocks
      assertValid(result)
      assert.deepEqual(relationships(result), outdented)
      assert.equal(result[3].content, ' Branch')
      assert.equal(current().activeBlockIndex, 3)
      assert.equal(current().activeCursorPosition, 0)
      await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().editor.draftBlocks, original)
      await act(async () => current().editor.redoEdit())
      assert.deepEqual(current().editor.draftBlocks, result)
    })
  } finally { t.mock.timers.reset() }
})

test('multi Shift+Tab moves selected folded siblings with their descendants and remaps selection/focus', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const blocks = nestedTree()
    blocks.splice(4, 0, { id: 'second', type: 'bulleted-list', content: 'Second', checked: false, depth: 1, parentBlockId: 'outer' },
      { id: 'second-child', type: 'todo', content: 'Second child', checked: true, depth: 2, parentBlockId: 'second' })
    await withEditor(blocks, async (current, document) => {
      const original = current().editor.draftBlocks
      await act(async () => current().collapse(['branch', 'second']))
      await act(async () => { current().selection.selectBlockRange(1); current().setCursor(4, 2) })
      await act(async () => current().selection.selectBlockRange(4, true))
      const textarea = document.querySelector<HTMLTextAreaElement>('[data-block-id="second"] textarea')!
      textarea.focus(); textarea.setSelectionRange(2, 2)
      await act(async () => current().multi.adjustSelectedBlocksDepth(-1, 4, 2))
      const result = current().editor.draftBlocks
      assertValid(result)
      assert.deepEqual(relationships(result), [ ['outer', 0, null], ['sibling', 1, 'outer'], ['sibling-child', 2, 'sibling'],
        ['branch', 0, null], ['child', 1, 'branch'], ['grandchild', 2, 'child'], ['second', 0, null], ['second-child', 1, 'second'], ['after', 0, null] ])
      assert.deepEqual(current().selection.selectedBlockRange, { start: 3, end: 6 })
      assert.equal(current().selection.selectionAnchorBlockId, 'branch')
      assert.equal(current().activeBlockIndex, 6)
      assert.equal(document.activeElement, textarea)
      assert.equal(textarea.selectionStart, 2)
      await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().editor.draftBlocks, original)
      await act(async () => { current().editor.redoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().editor.draftBlocks, result)
      // Deleting the old parent must remove only its retained sibling subtree.
      await act(async () => { current().selection.clearBlockSelection(); current().selection.selectBlockRange(0) })
      await act(async () => current().multi.deleteSelectedBlocks())
      assertValid(current().editor.draftBlocks)
      assert.deepEqual(current().editor.draftBlocks.map(block => block.id), ['branch', 'child', 'grandchild', 'second', 'second-child', 'after'])
    })
  } finally { t.mock.timers.reset() }
})

test('multi Tab attaches selected root siblings under one previous list and retains visible endpoint selection', async () => {
  const blocks = [ { id: 'previous', type: 'bulleted-list', content: 'Previous', checked: false, depth: 0 },
    { id: 'a', type: 'todo', content: 'A', checked: true, depth: 0 },
    { id: 'a-child', type: 'bulleted-list', content: 'A child', checked: false, depth: 1, parentBlockId: 'a' },
    { id: 'b', type: 'bulleted-list', content: 'B', checked: false, depth: 0 },
    { id: 'b-child', type: 'bulleted-list', content: 'B child', checked: false, depth: 1, parentBlockId: 'b' } ]
  await withEditor(blocks, async current => {
    await act(async () => current().collapse(['a', 'b']))
    await act(async () => current().selection.selectBlockRange(1))
    await act(async () => current().selection.selectBlockRange(3, true))
    await act(async () => current().multi.adjustSelectedBlocksDepth(1, 3, 1))
    assertValid(current().editor.draftBlocks)
    assert.deepEqual(relationships(current().editor.draftBlocks), [['previous', 0, null], ['a', 1, 'previous'], ['a-child', 2, 'a'], ['b', 1, 'previous'], ['b-child', 2, 'b']])
    assert.deepEqual(current().selection.selectedBlockRange, { start: 1, end: 3 })
    assert.equal(current().activeBlockIndex, 3)
  })
})

test('indent rejects a paragraph parent and descendants exceeding depth six without adding undo history', async () => {
  const blocks = nestedTree(); blocks[0] = { ...blocks[0], type: 'paragraph' }
  const roots = [blocks[0], { ...blocks[1], depth: 0, parentBlockId: null },
    { ...blocks[2], depth: 1 }, { ...blocks[3], depth: 2 }]
  await withEditor(roots, async current => {
    const original = current().editor.draftBlocks
    await act(async () => current().single.adjustBlockDepth(1, 1))
    assert.deepEqual(current().editor.draftBlocks, original)
    assert.equal(current().editor.canUndo, false)
    await act(async () => current().selection.selectBlockRange(1))
    await act(async () => current().multi.adjustSelectedBlocksDepth(1, 1))
    assert.deepEqual(current().editor.draftBlocks, original)
    assert.equal(current().editor.canUndo, false)
  })
  const deep: DocumentBlockDraft[] = [{ id: 'previous', type: 'bulleted-list', content: 'Previous', checked: false, depth: 0 }]
  for (let depth = 0; depth <= 6; depth++) deep.push({ id: `deep-${depth}`, type: 'bulleted-list', content: `Deep ${depth}`, checked: false,
    depth, parentBlockId: depth === 0 ? null : `deep-${depth - 1}` })
  await withEditor(deep, async current => {
    const original = current().editor.draftBlocks
    await act(async () => current().single.adjustBlockDepth(1, 1))
    assert.deepEqual(current().editor.draftBlocks, original)
    await act(async () => current().selection.selectBlockRange(1))
    await act(async () => current().multi.adjustSelectedBlocksDepth(1, 1))
    assert.deepEqual(current().editor.draftBlocks, original)
    assert.equal(current().editor.canUndo, false)
  })
})

test('depth no-ops preserve redo and cross-parent visible selections leave the tree intact', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(nestedTree(), async current => {
      const original = current().editor.draftBlocks
      await act(async () => current().single.adjustBlockDepth(1, -1))
      await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
      assert.equal(current().editor.canRedo, true)
      await act(async () => current().single.adjustBlockDepth(0, -1))
      assert.equal(current().editor.canRedo, true)
      await act(async () => current().selection.selectBlockRange(1))
      await act(async () => current().selection.selectBlockRange(4, true))
      await act(async () => current().multi.adjustSelectedBlocksDepth(-1, 4))
      assert.deepEqual(current().editor.draftBlocks, original)
      assert.equal(current().editor.canRedo, true)
    })
  } finally { t.mock.timers.reset() }
})

test('independent continuity check rejects a parent spanning an unrelated root accepted by the existing validator', () => {
  const tree = nestedTree()
  const broken = [tree[0], { ...tree[1], depth: 0, parentBlockId: null }, { ...tree[2], depth: 1 }, { ...tree[3], depth: 2 }, tree[4], tree[5], tree[6]]
  assert.equal(validateBlockTreeStructure(broken).valid, true)
  assert.equal(isDraftTreeContiguous(broken), false)
  assert.equal(planDraftBlockDepthChange(broken, { start: 1, end: 3 }, 1), null)
  assert.equal(planDraftBlockDepthChange(tree, { start: 1, end: 2 }, -1), null, 'partial subtrees cannot move')
})

test('drag placement and sibling moves retain complete trees and focus under the shared planner', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(nestedTree(), async (current, document) => {
      const original = current().editor.draftBlocks
      const textarea = document.querySelector<HTMLTextAreaElement>('[data-block-id="branch"] textarea')!
      textarea.focus(); textarea.setSelectionRange(2, 2)
      await act(async () => current().setCursor(1, 2))
      await act(async () => current().single.moveDraftSubtree(1, 5, 0, 1))
      const result = current().editor.draftBlocks
      assertValid(result)
      assert.deepEqual(relationships(result), outdented)
      assert.equal(current().activeBlockIndex, 3)
      assert.equal(document.activeElement, textarea)
      assert.equal(textarea.selectionStart, 2)
      await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().editor.draftBlocks, original)
      await act(async () => current().single.moveDraftBlockBySibling(1, 1, 2))
      const siblingMoved = current().editor.draftBlocks
      assertValid(siblingMoved)
      assert.deepEqual(siblingMoved.map(block => block.id), ['outer', 'sibling', 'sibling-child', 'branch', 'child', 'grandchild', 'after'])
      assert.equal(siblingMoved[3].parentBlockId, 'outer')
      assert.equal(siblingMoved[4].parentBlockId, 'branch')
      await act(async () => current().single.moveDraftBlockBySibling(3, -1, 2))
      assert.deepEqual(current().editor.draftBlocks, original)
    })
  } finally { t.mock.timers.reset() }
})

test('invalid drag placements and mixed paragraph/list indentation never add a history checkpoint', async () => {
  await withEditor(nestedTree(), async current => {
    const original = current().editor.draftBlocks
    // A root paragraph inserted before a nested child would close its parent subtree.
    await act(async () => current().single.moveDraftSubtree(6, 2, 0))
    await act(async () => current().single.moveDraftSubtree(1, 2, 0))
    assert.deepEqual(current().editor.draftBlocks, original)
    assert.equal(current().editor.canUndo, false)
  })
  const deep: DocumentBlockDraft[] = [{ id: 'paragraph', type: 'paragraph', content: 'Paragraph', checked: false, depth: 0 }]
  for (let depth = 0; depth <= 6; depth++) deep.push({ id: `deep-${depth}`, type: 'bulleted-list', content: `Deep ${depth}`, checked: false,
    depth, parentBlockId: depth === 0 ? null : `deep-${depth - 1}` })
  deep.push({ id: 'anchor', type: 'bulleted-list', content: 'Anchor', checked: false, depth: 0 })
  await withEditor(deep, async current => {
    const original = current().editor.draftBlocks
    await act(async () => current().single.moveDraftSubtree(1, 8, 1))
    assert.deepEqual(current().editor.draftBlocks, original, 'no deepest descendant may be clamped to its parent depth')
    assert.equal(current().editor.canUndo, false)
  })
  const mixed: DocumentBlockDraft[] = [
    { id: 'previous', type: 'bulleted-list', content: 'Previous', checked: false, depth: 0 },
    { id: 'list', type: 'todo', content: 'List', checked: true, depth: 0 },
    { id: 'paragraph', type: 'paragraph', content: 'Paragraph', checked: false, depth: 0 }
  ]
  await withEditor(mixed, async current => {
    const original = current().editor.draftBlocks
    await act(async () => current().selection.selectBlockRange(1))
    await act(async () => current().selection.selectBlockRange(2, true))
    await act(async () => current().multi.adjustSelectedBlocksDepth(1, 2))
    assert.deepEqual(current().editor.draftBlocks, original)
    assert.equal(current().editor.canUndo, false)
  })
})
