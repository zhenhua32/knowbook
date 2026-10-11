import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useCallback, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentDetail } from '../src/shared/contracts'
import type { UiText } from '../src/renderer/src/i18n'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { useSingleBlockTreeActions } from '../src/renderer/src/hooks/useSingleBlockTreeActions'
import { useMultiBlockActions } from '../src/renderer/src/hooks/useMultiBlockActions'
import { useBlockSelectionState } from '../src/renderer/src/hooks/useBlockSelectionState'
import { useBlockFocusState } from '../src/renderer/src/hooks/useBlockFocusState'
import { useBlockDragState } from '../src/renderer/src/hooks/useBlockDragState'
import { useBlockDragDropActions } from '../src/renderer/src/hooks/useBlockDragDropActions'
import { isNestableBlock, normalizeBlockDepth } from '../src/renderer/src/utils/draftBlockShape'
import { isDraftTreeContiguous } from '../src/renderer/src/utils/draftTreeDepthChange'
import { getBlockDropPreview } from '../src/renderer/src/utils/draftTreeDropPreview'
import { validateBlockTreeStructure } from '../src/renderer/src/utils/draftTreeNormalization'

const block = (id: string, depth = 0, parentBlockId: string | null = null): DocumentBlockDraft =>
  ({ id, type: 'todo', content: id, checked: true, depth, parentBlockId, tags: [id], highlight: 'blue' })
const tree = (): DocumentBlockDraft[] => [block('before'), block('a'), block('a-child', 1, 'a'), block('a-grandchild', 2, 'a-child'),
  block('b'), block('b-child', 1, 'b'), block('after'), block('after-child', 1, 'after')]
type State = {
  editor: ReturnType<typeof useDocumentEditorState>
  selection: ReturnType<typeof useBlockSelectionState>
  multi: ReturnType<typeof useMultiBlockActions>
  drag: ReturnType<typeof useBlockDragState> & ReturnType<typeof useBlockDragDropActions>
  activeBlockIndex: number | null
  activeCursorPosition: number
  setCursor: (index: number, position: number) => void
  collapse: (ids: string[]) => void
  historyCalls: () => number
}
async function withEditor(blocks: DocumentBlockDraft[], run: (current: () => State, document: Document) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, requestAnimationFrame: (): number => 1,
    cancelAnimationFrame: (): void => {}, IS_REACT_ACT_ENVIRONMENT: true })) {
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
    const refs = useRef<Array<HTMLTextAreaElement | null>>([])
    const capture = useCallback((index: number, element: HTMLTextAreaElement) => {
      setActiveBlockIndex(index); setActiveCursorPosition(element.selectionStart)
    }, [])
    const focus = useBlockFocusState({ activeCursorPosition, blockTextareaRefs: refs, draftBlocks: editor.draftBlocks, captureBlockCursor: capture })
    const dragState = useBlockDragState()
    const historyCalls = useRef(0)
    const buildBlockTypePatch = (type: string, content: string, checked = false, depth = 0, parentBlockId: string | null = null): DocumentBlockDraft =>
      ({ type, content, checked, depth: normalizeBlockDepth(type, depth), parentBlockId: isNestableBlock(type) ? parentBlockId : null })
    const shared = { activeCursorPosition, draftBlocks: editor.draftBlocks, buildBlockTypePatch,
      clearBlockSelection: selection.clearBlockSelection, endBlockDrag: dragState.endBlockDrag,
      pushToHistory: (blocks: DocumentBlockDraft[]) => { historyCalls.current++; editor.pushToHistory(blocks) },
      setActiveBlockIndex, setActiveCursorPosition, setPendingFocusBlockIndex: focus.setPendingFocusBlockIndex, setDraftBlocks: editor.setDraftBlocks }
    const single = useSingleBlockTreeActions({ ...shared, updateDraftBlock: editor.updateDraftBlock, splitDraftBlock: noop })
    const multi = useMultiBlockActions({ ...shared, activeBlockIndex, selectedBlockRange: selection.selectedBlockRange,
      selectionAnchorBlockId: selection.selectionAnchorBlockId, getMultiBlockInteractionGuard: selection.getMultiBlockInteractionGuard,
      getMultiBlockOperationRange: selection.getMultiBlockOperationRange, getVisibleSiblingSelectionSlice: selection.getVisibleSiblingSelectionSlice,
      setSelectedBlockRange: selection.setSelectedBlockRange, setSelectionAnchorBlockId: selection.setSelectionAnchorBlockId, notify: noop,
      ui: { convertedBlocks: () => '', copiedBlocks: () => '', copiedPlainText: () => '', copyFailed: '', copyTextFailed: '', cutBlocks: () => '',
        cutFailed: '', deletedBlocks: () => '', duplicatedBlocks: () => '', invalidVisibleTreeSlice: '' } })
    const dragActions = useBlockDragDropActions({ ...dragState, draftBlocks: editor.draftBlocks, blockDragDepthThreshold: 20,
      getMultiBlockInteractionGuard: selection.getMultiBlockInteractionGuard, moveDraftSubtree: single.moveDraftSubtree,
      moveSelectedBlocksTo: multi.moveSelectedBlocksTo, selectedBlockRange: selection.selectedBlockRange, notify: noop })
    state = { editor, selection, multi, drag: { ...dragState, ...dragActions }, activeBlockIndex, activeCursorPosition,
      setCursor: (index, position) => { setActiveBlockIndex(index); setActiveCursorPosition(position) },
      collapse: ids => setCollapsedBlockIds(new Set(ids)), historyCalls: () => historyCalls.current }
    return createElement('div', { className: 'block-editor-list' }, selection.getVisibleBlockEntries(editor.draftBlocks).map(({ block, index }) =>
      createElement('div', { key: block.id, className: 'block-editor-row', 'data-block-index': index, 'data-block-id': block.id },
        createElement('textarea', { className: 'block-inline-textarea', value: block.content, readOnly: true,
          onFocus: (event: { currentTarget: HTMLTextAreaElement }) => capture(index, event.currentTarget),
          ref: (element: HTMLTextAreaElement | null) => { if (element || !refs.current[index]?.isConnected) refs.current[index] = element } }))))
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => state.editor.loadDocumentIntoEditor({ id: 'doc', title: 'Range drag', summary: '', blocks } as DocumentDetail))
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
  const result = validateBlockTreeStructure(blocks)
  assert.equal(result.valid, true, result.errors.join('\n'))
  assert.equal(isDraftTreeContiguous(blocks), true)
}
async function select(current: () => State, start: number, end: number) {
  await act(async () => current().selection.selectBlockRange(start))
  await act(async () => current().selection.selectBlockRange(end, true))
}

test('dragging either selected folded root moves the entire range with hidden descendants, visible endpoints and reverse anchor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const dragIndex of [1, 4]) {
    await withEditor(tree(), async (current, document) => {
      const original = current().editor.draftBlocks
      await act(async () => current().collapse(['a', 'b']))
      await select(current, 4, 1)
      const textarea = document.querySelector<HTMLTextAreaElement>('[data-block-id="b"] textarea')!
      await act(async () => { textarea.focus(); textarea.setSelectionRange(1, 1); current().setCursor(4, 1) })
      await act(async () => current().drag.beginBlockDrag(dragIndex))
      const range = current().selection.getMultiBlockOperationRange(current().selection.selectedBlockRange!)
      assert.deepEqual(range, { start: 1, end: 5 })
      assert.equal(getBlockDropPreview(original, dragIndex, 7, 0, range)?.effectiveDepth, 0)
      await act(async () => current().drag.dropBlockAt(7, 0))
      const result = current().editor.draftBlocks
      assertValid(result)
      assert.deepEqual(result.map(b => b.id), ['before', 'after', 'after-child', 'a', 'a-child', 'a-grandchild', 'b', 'b-child'])
      assert.deepEqual(result.slice(3), original.slice(1, 6))
      assert.deepEqual(current().selection.selectedBlockRange, { start: 3, end: 6 })
      assert.equal(current().selection.selectionAnchorBlockId, 'b')
      assert.equal(current().activeBlockIndex, 6)
      assert.equal(current().activeCursorPosition, 1)
      assert.equal(document.activeElement, textarea); assert.equal(textarea.selectionStart, 1)
      assert.equal(current().historyCalls(), 1)
      assert.equal(current().drag.draggingBlockIndex, null)
      await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().editor.draftBlocks, original)
      assert.equal(document.activeElement, textarea)
      await act(async () => { current().editor.redoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(current().editor.draftBlocks, result)
    })
  }
})

test('adjacent upward and downward targets remain valid exchanges rather than rejected no-ops', async () => {
  await withEditor([block('before'), block('a'), block('b'), block('after')], async current => {
    await select(current, 1, 2)
    await act(async () => current().drag.beginBlockDrag(2))
    await act(async () => current().drag.dropBlockAt(0, 0))
    assert.deepEqual(current().editor.draftBlocks.map(b => b.id), ['a', 'b', 'before', 'after'])
    assert.deepEqual(current().selection.selectedBlockRange, { start: 0, end: 1 })
    await act(async () => current().drag.beginBlockDrag(0))
    await act(async () => current().drag.dropBlockAt(2, 0))
    assert.deepEqual(current().editor.draftBlocks.map(b => b.id), ['before', 'a', 'b', 'after'])
    assert.deepEqual(current().selection.selectedBlockRange, { start: 1, end: 2 })
    assert.equal(current().historyCalls(), 2)
  })
})

test('range depth placement uses one list parent and retains internal relationships and preview metadata', async () => {
  await withEditor(tree(), async current => {
    await act(async () => current().collapse(['a', 'b']))
    await select(current, 1, 4)
    const range = current().selection.getMultiBlockOperationRange(current().selection.selectedBlockRange!)
    const preview = getBlockDropPreview(current().editor.draftBlocks, 4, 7, 1, range)
    assert.equal(preview?.effectiveDepth, 1); assert.equal(preview?.parentText, 'after')
    await act(async () => current().drag.beginBlockDrag(4))
    await act(async () => current().drag.dropBlockAt(7, 1))
    const result = current().editor.draftBlocks
    assertValid(result)
    assert.deepEqual(result.slice(3).map(b => [b.id, b.depth, b.parentBlockId]), [ ['a', 1, 'after'], ['a-child', 2, 'a'], ['a-grandchild', 3, 'a-child'], ['b', 1, 'after'], ['b-child', 2, 'b'] ])
    assert.deepEqual(current().selection.selectedBlockRange, { start: 3, end: 6 })
  })
})

test('self, broken-tree and over-depth range drops show no preview, record no history and preserve redo', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const blocks = tree(); blocks[6] = { ...blocks[6], type: 'paragraph' }; blocks.splice(7, 1)
  await withEditor(blocks, async current => {
    await act(async () => current().collapse(['a', 'b']))
    await select(current, 1, 4)
    await act(async () => current().drag.beginBlockDrag(1))
    await act(async () => current().drag.dropBlockAt(0, 0))
    await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
    assert.equal(current().editor.canRedo, true)
    const restored = current().editor.draftBlocks
    await select(current, 1, 4)
    const range = current().selection.getMultiBlockOperationRange(current().selection.selectedBlockRange!)
    for (const target of [2, 6]) {
      assert.equal(getBlockDropPreview(restored, 1, target, 1, range), null)
      await act(async () => current().drag.beginBlockDrag(1))
      await act(async () => current().drag.dropBlockAt(target, 1))
      assert.deepEqual(current().editor.draftBlocks, restored)
      assert.equal(current().historyCalls(), 1)
      assert.equal(current().editor.canRedo, true)
    }
  })
  const deep = [block('previous'), block('a'), ...Array.from({ length: 6 }, (_, index) => block(`depth-${index + 1}`, index + 1, index === 0 ? 'a' : `depth-${index}`)), block('b'), block('after')]
  await withEditor(deep, async current => {
    await act(async () => current().collapse(['a']))
    await select(current, 1, 8)
    const original = current().editor.draftBlocks
    const range = current().selection.getMultiBlockOperationRange(current().selection.selectedBlockRange!)
    assert.equal(getBlockDropPreview(original, 8, 9, 1, range), null)
    await act(async () => current().drag.beginBlockDrag(8))
    await act(async () => current().drag.dropBlockAt(9, 1))
    assert.deepEqual(current().editor.draftBlocks, original)
    assert.equal(current().historyCalls(), 0)
  })
})

test('expanded cross-parent selection cannot begin or drop a range drag and one-block drag retains its subtree', async () => {
  await withEditor(tree(), async current => {
    const original = current().editor.draftBlocks
    await select(current, 1, 4)
    await act(async () => current().drag.beginBlockDrag(1))
    assert.equal(current().drag.draggingBlockIndex, null)
    await act(async () => current().drag.dropBlockAt(7, 0))
    assert.deepEqual(current().editor.draftBlocks, original)
    assert.equal(current().historyCalls(), 0)
    await act(async () => current().selection.clearBlockSelection())
    await act(async () => current().drag.beginBlockDrag(1))
    await act(async () => current().drag.dropBlockAt(7, 0))
    assertValid(current().editor.draftBlocks)
    assert.deepEqual(current().editor.draftBlocks.map(b => b.id), ['before', 'b', 'b-child', 'after', 'after-child', 'a', 'a-child', 'a-grandchild'])
    assert.deepEqual(current().editor.draftBlocks.slice(5), original.slice(1, 4))
    assert.equal(current().historyCalls(), 1)
  })
})

test('mixed non-nestable range depth changes cannot partly indent only the list root', async () => {
  await withEditor([block('before'), block('a'), { ...block('paragraph'), type: 'paragraph' }, block('after')], async current => {
    const original = current().editor.draftBlocks
    await select(current, 1, 2)
    const range = current().selection.getMultiBlockOperationRange(current().selection.selectedBlockRange!)
    assert.equal(getBlockDropPreview(original, 1, 3, 1, range), null)
    await act(async () => current().drag.beginBlockDrag(1))
    await act(async () => current().drag.dropBlockAt(3, 1))
    assert.deepEqual(current().editor.draftBlocks, original)
    assert.equal(current().historyCalls(), 0)
  })
})
