import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, StrictMode, useCallback, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentDetail } from '../src/shared/contracts'
import { getUiText } from '../src/renderer/src/i18n'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { useSingleBlockTreeActions } from '../src/renderer/src/hooks/useSingleBlockTreeActions'
import { useBlockFocusState } from '../src/renderer/src/hooks/useBlockFocusState'
import { useBlockSelectionState } from '../src/renderer/src/hooks/useBlockSelectionState'
import { useMultiBlockActions } from '../src/renderer/src/hooks/useMultiBlockActions'
import { isNestableBlock, normalizeBlockDepth } from '../src/renderer/src/utils/draftBlockShape'
import { getBlockSubtreeEndIndex } from '../src/renderer/src/utils/draftTreeMove'
import { isDraftTreeContiguous } from '../src/renderer/src/utils/draftTreeDepthChange'
import type { EditorHistoryBookmark } from '../src/renderer/src/utils/editorHistoryFocus'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { BlockEditorRow } = await import('../src/renderer/src/components/BlockEditorRow')
await import('../src/renderer/src/components/MarkdownFormatToolbar')
type RowProps = import('../src/renderer/src/components/BlockEditorRow').BlockEditorRowProps
type State = {
  editor: ReturnType<typeof useDocumentEditorState>
  actions: ReturnType<typeof useSingleBlockTreeActions>
  selection: ReturnType<typeof useBlockSelectionState>
  activeBlockIndex: number | null
  activeCursorPosition: number
  metrics: { historyWrites: number; mergeCalls: number; endedDrags: number }
}
type Api = {
  current: () => State
  document: Document
  input: (id: string) => HTMLTextAreaElement
  select: (id: string, start: number, end?: number) => Promise<void>
  key: (id: string, key?: string, options?: KeyboardEventInit) => Promise<KeyboardEvent>
}
const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, content, type: 'paragraph', checked: false, depth: 0 })
const list = (id: string, content: string, depth = 0, parentBlockId: string | null = null): DocumentBlockDraft =>
  ({ ...paragraph(id, content), type: 'todo', depth, parentBlockId })

async function withEditor(blocks: DocumentBlockDraft[], run: (api: Api) => Promise<void>,
  { collapsedIds = [], strict = false }: { collapsedIds?: string[]; strict?: boolean } = {}) {
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
  let state!: State
  function Harness() {
    const editor = useDocumentEditorState({ selectedDocumentId: null, selectedDocument: null, ui: getUiText('en-US'),
      onHomeDataChange: noop, onSelectedDocumentChange: noop, onMessage: noop })
    const [activeBlockIndex, setActiveBlockIndex] = useState<number | null>(null)
    const [activeCursorPosition, setActiveCursorPosition] = useState(0)
    const blockTextareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])
    const collapsedBlockIds = new Set(collapsedIds)
    const selection = useBlockSelectionState({ activeBlockIndex, collapsedBlockIds, draftBlocks: editor.draftBlocks,
      onActiveBlockChange: setActiveBlockIndex, visibleSliceCrossParentGuard: '', selectionStaleGuard: '' })
    const captureBlockCursor = useCallback((index: number, element: HTMLTextAreaElement) => {
      setActiveBlockIndex(index); setActiveCursorPosition(element.selectionStart)
    }, [])
    const focus = useBlockFocusState({ activeCursorPosition, blockTextareaRefs, draftBlocks: editor.draftBlocks, captureBlockCursor })
    const metrics = useRef({ historyWrites: 0, mergeCalls: 0, endedDrags: 0 }).current
    const pushToHistory = (blocks: DocumentBlockDraft[], bookmark?: EditorHistoryBookmark | null) => {
      metrics.historyWrites++; editor.pushToHistory(blocks, bookmark)
    }
    const endBlockDrag = () => { metrics.endedDrags++ }
    const buildBlockTypePatch = (type: string, content: string, checked = false, depth = 0,
      parentBlockId: string | null = null): DocumentBlockDraft => ({ type, content,
      checked: isNestableBlock(type) ? checked : false, depth: normalizeBlockDepth(type, depth),
      parentBlockId: isNestableBlock(type) ? parentBlockId : null })
    const actions = useSingleBlockTreeActions({ activeCursorPosition, buildBlockTypePatch,
      clearBlockSelection: selection.clearBlockSelection, draftBlocks: editor.draftBlocks, endBlockDrag, pushToHistory,
      setActiveBlockIndex, setActiveCursorPosition, setDraftBlocks: editor.setDraftBlocks,
      setPendingFocusBlockIndex: focus.setPendingFocusBlockIndex, splitDraftBlock: noop, updateDraftBlock: editor.updateDraftBlock })
    const multi = useMultiBlockActions({ activeBlockIndex, activeCursorPosition, buildBlockTypePatch,
      clearBlockSelection: selection.clearBlockSelection, draftBlocks: editor.draftBlocks, endBlockDrag,
      getMultiBlockInteractionGuard: selection.getMultiBlockInteractionGuard,
      getMultiBlockOperationRange: selection.getMultiBlockOperationRange,
      getVisibleSiblingSelectionSlice: selection.getVisibleSiblingSelectionSlice, pushToHistory,
      selectedBlockRange: selection.selectedBlockRange, selectionAnchorBlockId: selection.selectionAnchorBlockId,
      setActiveBlockIndex, setActiveCursorPosition, notify: noop, setDraftBlocks: editor.setDraftBlocks,
      setPendingFocusBlockIndex: focus.setPendingFocusBlockIndex,
      setSelectedBlockRange: selection.setSelectedBlockRange, setSelectionAnchorBlockId: selection.setSelectionAnchorBlockId,
      ui: getUiText('en-US') })
    state = { editor, actions, selection, activeBlockIndex, activeCursorPosition, metrics }
    return createElement('div', { className: 'block-editor-list' }, selection.getVisibleBlockEntries(editor.draftBlocks).map(({ block, index }) => {
      const props: RowProps = {
        block, index, draftBlockCount: editor.draftBlocks.length, getDraftBlocks: editor.getDraftBlocks,
        selectedDocument: { id: 'doc', title: 'Forward Delete' }, isSelected: selection.isBlockSelected(index), isHighlighted: false,
        hasChildren: getBlockSubtreeEndIndex(editor.draftBlocks, index) > index, dropPreview: null,
        indentPx: block.depth * 24, numberLabel: '', activeBlockIndex, collapsedBlockIds,
        activeSlashContext: null, filteredSlashCommands: [], activeSlashCommand: null,
        selectedBlockRange: selection.selectedBlockRange, selectedBlockCount: selection.selectedBlockCount, blockTextareaRefs,
        updateDraftBlock: editor.updateDraftBlock, checkpointDraft: editor.checkpointDraft,
        updateBlockHighlight: noop, insertDraftBlockAt: noop,
        handleBlockContentChange: (index, content) => editor.updateDraftBlock(index, { content }),
        navigateInlineReferenceAtCursor: noop, captureBlockCursor, handleBlockPaste: () => false,
        beginBlockDrag: noop, endBlockDrag, getDraggedBlockDepthPreview: () => null,
        dropBlockAt: noop, setDragOverBlockIndex: noop, setDragOverBlockDepth: noop,
        moveSelectedBlocks: multi.moveSelectedBlocks, moveDraftBlockBySibling: actions.moveDraftBlockBySibling,
        setSelectedSlashCommandIndex: noop, applySlashCommand: noop, dismissSlashCommand: noop,
        adjustSelectedBlocksDepth: multi.adjustSelectedBlocksDepth, adjustBlockDepth: actions.adjustBlockDepth,
        deleteSelectedBlocks: multi.deleteSelectedBlocks, duplicateSelectedBlocks: multi.duplicateSelectedBlocks,
        duplicateDraftBlock: noop, selectBlockRange: selection.selectBlockRange, selectAllBlocks: selection.selectAllBlocks,
        getBlockSelectionFocusIndex: selection.getBlockSelectionFocusIndex, clearBlockSelection: selection.clearBlockSelection,
        notifyBlockMouseDown: selection.notifyBlockMouseDown, handleBlockMouseEnter: selection.handleBlockMouseEnter,
        endBlockRangeSelection: selection.endBlockRangeSelection, isBlockRangeSelecting: selection.isBlockRangeSelecting,
        continueBlockAt: actions.continueBlockAt, downgradeBlockAt: actions.downgradeBlockAt,
        mergeWithPreviousBlock: actions.mergeWithPreviousBlock,
        mergeWithNextBlock: (index, nextIndex) => { metrics.mergeCalls++; return actions.mergeWithNextBlock(index, nextIndex) },
        splitDraftBlock: noop, toggleBlockCollapse: noop, isSelectionCoherent: selection.isSelectionCoherent,
        getVisibleBlockCountInRange: selection.getVisibleBlockCountInRange,
        getMultiBlockOperationRange: selection.getMultiBlockOperationRange, removeSelectedBlockRange: multi.removeSelectedBlockRange,
        canMoveSelectedRange: selection.canMoveSelectedRange, onOpenSelectionAiEditor: noop,
        BLOCK_INDENT_SIZE: 24, ui: getUiText('en-US'), isZh: false
      }
      return createElement(BlockEditorRow, { key: block.id, ...props })
    }))
  }
  const document = dom.window.document
  const input = (id: string) => document.querySelector<HTMLTextAreaElement>(`[data-block-id="${id}"] textarea`)!
  try {
    const harness = createElement(Harness)
    await act(async () => root.render(strict ? createElement(StrictMode, null, harness) : harness))
    await act(async () => state.editor.loadDocumentIntoEditor({ id: 'doc', title: 'Forward Delete', summary: '', blocks } as DocumentDetail))
    await run({ current: () => state, document, input,
      select: async (id, start, end = start) => {
        await act(async () => { input(id).focus(); input(id).setSelectionRange(start, end) })
      },
      key: async (id, key = 'Delete', options = {}) => {
        const element = input(id)
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
        await act(async () => element.dispatchEvent(event))
        await act(async () => element.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key, bubbles: true, ...options })))
        return event as KeyboardEvent
      }
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

function assertFocus(api: Api, id: string, position: number) {
  assert.equal(api.document.activeElement, api.input(id))
  assert.equal(api.input(id).selectionStart, position)
  assert.equal(api.input(id).selectionEnd, position)
  assert.equal(api.current().activeBlockIndex, api.current().editor.draftBlocks.findIndex(block => block.id === id))
  assert.equal(api.current().activeCursorPosition, position)
}

test('paragraph end Delete joins soft-line content while preserving identity, focus and undo/redo', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor([{ ...paragraph('left', 'Alpha'), tags: ['left'], highlight: 'blue' },
      paragraph('right', 'Beta\nGamma'), paragraph('after', 'After')], async api => {
      const original = api.current().editor.draftBlocks
      await api.select('left', 5)
      await act(async () => api.current().selection.selectBlockRange(0))
      assert.equal((await api.key('left')).defaultPrevented, true)
      const merged = api.current().editor.draftBlocks
      assert.deepEqual(merged, [{ ...original[0], content: 'AlphaBeta\nGamma' }, original[2]])
      assert.equal(api.current().selection.selectedBlockRange, null)
      assert.equal(api.current().metrics.historyWrites, 1)
      assertFocus(api, 'left', 5)
      await act(async () => { api.current().editor.undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(api.current().editor.draftBlocks, original); assertFocus(api, 'left', 5)
      await act(async () => api.current().editor.redoEdit())
      assert.deepEqual(api.current().editor.draftBlocks, merged); assertFocus(api, 'left', 5)
    })
  } finally { t.mock.timers.reset() }
})

test('queued left and right typing uses the latest text, caret and undo snapshot once, including StrictMode replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    for (const strict of [false, true]) {
      await withEditor([paragraph('left', 'A'), paragraph('right', 'B'), paragraph('after', 'After')], async api => {
        await api.select('left', 1)
        await act(async () => {
          const state = api.current()
          state.editor.updateDraftBlock(0, { content: 'Latest left' })
          state.editor.updateDraftBlock(1, { content: 'Latest right' })
          // Native input changes the DOM before React commits the queued state.
          api.input('left').value = 'Latest left'
          api.input('left').setSelectionRange('Latest left'.length, 'Latest left'.length)
          assert.equal(state.actions.mergeWithNextBlock(0, 1), true)
        })
        assert.deepEqual(api.current().editor.draftBlocks.map(block => [block.id, block.content]),
          [['left', 'Latest leftLatest right'], ['after', 'After']])
        assertFocus(api, 'left', 'Latest left'.length)
        assert.equal(api.current().metrics.historyWrites, 1)
        assert.equal(api.current().metrics.endedDrags, 1)
        const merged = api.current().editor.draftBlocks
        await act(async () => { api.current().editor.undoEdit(); t.mock.timers.tick(0) })
        assert.deepEqual(api.current().editor.draftBlocks.map(block => [block.id, block.content]),
          [['left', 'Latest left'], ['right', 'Latest right'], ['after', 'After']])
        assertFocus(api, 'left', 'Latest left'.length)
        await act(async () => { api.current().editor.redoEdit(); t.mock.timers.tick(0) })
        assert.deepEqual(api.current().editor.draftBlocks, merged)
        assertFocus(api, 'left', 'Latest left'.length)
        await act(async () => api.current().editor.updateDraftBlock(1, { content: 'Changed after' }))
        assert.equal(api.current().metrics.endedDrags, 1)
        assertFocus(api, 'left', 'Latest left'.length)
      }, { strict })
    }
  } finally { t.mock.timers.reset() }
})

test('empty current or following paragraphs join at the original boundary without deleting another block', async () => {
  for (const [left, right] of [['Alpha', ''], ['', 'Beta']]) {
    await withEditor([paragraph('left', left), paragraph('right', right), paragraph('after', 'After')], async api => {
      await api.select('left', left.length)
      assert.equal((await api.key('left')).defaultPrevented, true)
      assert.deepEqual(api.current().editor.draftBlocks.map(block => [block.id, block.content]),
        [['left', left + right], ['after', 'After']])
      assertFocus(api, 'left', left.length)
    })
  }
})

test('a queued incompatible target cancels the request without checkpointing history or focusing on later input', async () => {
  await withEditor([paragraph('left', 'Alpha'), paragraph('right', 'Beta'), paragraph('after', 'After')], async api => {
    await api.select('left', 5)
    await act(async () => {
      const state = api.current()
      state.editor.updateDraftBlock(1, { type: 'code' })
      assert.equal(state.actions.mergeWithNextBlock(0, 1), true)
    })
    assert.deepEqual(api.current().editor.draftBlocks.map(block => [block.id, block.type, block.content]),
      [['left', 'paragraph', 'Alpha'], ['right', 'code', 'Beta'], ['after', 'paragraph', 'After']])
    assert.equal(api.current().metrics.historyWrites, 0); assert.equal(api.current().metrics.endedDrags, 0)
    await api.select('after', 2)
    await act(async () => api.current().editor.updateDraftBlock(2, { content: 'After changed' }))
    assert.equal(api.current().metrics.historyWrites, 0); assert.equal(api.current().metrics.endedDrags, 0)
    assert.equal(api.document.activeElement, api.input('after'))
  })
})

test('folded sibling lists preserve both child trees, attributes and collapse state across Delete history', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const blocks = [list('outer', 'Outer'),
    { ...list('left', 'Alpha', 1, 'outer'), checked: true, tags: ['left'], highlight: 'blue',
      markdownFormat: { listMarker: '-' as const, listLoose: true } },
    list('left-child', 'Left child', 2, 'left'), list('right', 'Beta', 1, 'outer'),
    { ...list('right-child', 'Right child', 2, 'right'), checked: true, tags: ['child'], highlight: 'yellow' },
    list('grandchild', 'Grandchild', 3, 'right-child'), paragraph('after', 'After')]
  try {
    await withEditor(blocks, async api => {
      const original = api.current().editor.draftBlocks
      assert.equal(api.input('left-child'), null); assert.equal(api.input('right-child'), null)
      await api.select('left', 5)
      assert.equal((await api.key('left')).defaultPrevented, true)
      const merged = api.current().editor.draftBlocks
      assert.deepEqual(merged, [original[0], { ...original[1], content: 'AlphaBeta' }, original[2],
        { ...original[4], parentBlockId: 'left' }, original[5], original[6]])
      assert.equal(isDraftTreeContiguous(merged), true)
      assert.equal(api.input('right-child'), null); assertFocus(api, 'left', 5)
      await act(async () => { api.current().editor.undoEdit(); t.mock.timers.tick(0) })
      assert.deepEqual(api.current().editor.draftBlocks, original); assertFocus(api, 'left', 5)
      assert.equal(api.input('right-child'), null)
      await act(async () => api.current().editor.redoEdit())
      assert.deepEqual(api.current().editor.draftBlocks, merged); assertFocus(api, 'left', 5)
    }, { collapsedIds: ['left', 'right'] })
  } finally { t.mock.timers.reset() }
})

test('visible child and shallower successor merges retain and reparent all following descendants', async () => {
  await withEditor([list('parent', 'Parent'), list('child', 'Child', 1, 'parent'),
    list('grandchild', 'Grandchild', 2, 'child'), list('sibling', 'Sibling', 1, 'parent'),
    list('next-root', 'Next'), list('next-child', 'Next child', 1, 'next-root')], async api => {
    await api.select('parent', 6)
    await api.key('parent')
    assert.deepEqual(api.current().editor.draftBlocks.map(block => [block.id, block.depth, block.parentBlockId]), [
      ['parent', 0, null], ['grandchild', 1, 'parent'], ['sibling', 1, 'parent'], ['next-root', 0, null], ['next-child', 1, 'next-root']])
    assertFocus(api, 'parent', 6)
    await api.select('sibling', 7)
    await api.key('sibling')
    const result = api.current().editor.draftBlocks
    assert.deepEqual(result.map(block => [block.id, block.content, block.depth, block.parentBlockId]), [
      ['parent', 'ParentChild', 0, null], ['grandchild', 'Grandchild', 1, 'parent'],
      ['sibling', 'SiblingNext', 1, 'parent'], ['next-child', 'Next child', 2, 'sibling']])
    assert.equal(isDraftTreeContiguous(result), true); assertFocus(api, 'sibling', 7)
  })
})

test('paragraph Delete promotes the absorbed list children without changing child identities or properties', async () => {
  await withEditor([paragraph('left', 'Alpha'), list('right', 'Beta'),
    { ...list('child', 'Child', 1, 'right'), checked: true, tags: ['keep'], highlight: 'blue' },
    list('grandchild', 'Grandchild', 2, 'child'), paragraph('after', 'After')], async api => {
    const original = api.current().editor.draftBlocks
    await api.select('left', 5)
    await api.key('left')
    assert.deepEqual(api.current().editor.draftBlocks, [{ ...original[0], content: 'AlphaBeta' },
      { ...original[2], depth: 0, parentBlockId: null }, { ...original[3], depth: 1 }, original[4]])
    assert.equal(isDraftTreeContiguous(api.current().editor.draftBlocks), true); assertFocus(api, 'left', 5)
  })
})

test('native selected-text Delete, interior carets, modifiers and IME never enter structural merging', async () => {
  await withEditor([paragraph('left', 'Alpha'), paragraph('right', 'Beta')], async api => {
    const original = api.current().editor.draftBlocks
    await api.select('left', 2)
    assert.equal((await api.key('left')).defaultPrevented, false)
    await api.select('left', 1, 5)
    assert.equal((await api.key('left')).defaultPrevented, false)
    await api.select('left', 5)
    for (const options of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true },
      { isComposing: true }, { keyCode: 229 }]) {
      assert.equal((await api.key('left', 'Delete', options)).defaultPrevented, false)
    }
    await act(async () => api.input('left').dispatchEvent(new api.document.defaultView!.CompositionEvent('compositionstart', { bubbles: true })))
    assert.equal((await api.key('left')).defaultPrevented, false)
    await act(async () => api.input('left').dispatchEvent(new api.document.defaultView!.CompositionEvent('compositionend', { bubbles: true })))
    assert.deepEqual(api.current().editor.draftBlocks, original)
    assert.equal(api.current().metrics.mergeCalls, 0); assert.equal(api.current().metrics.historyWrites, 0)
    assert.equal((await api.key('left')).defaultPrevented, true)
    assert.deepEqual(api.current().editor.draftBlocks.map(block => block.content), ['AlphaBeta'])
  })
})

test('a multi-block Delete takes priority and removes folded descendants instead of joining the following block', async () => {
  await withEditor([paragraph('before', 'Before'), list('parent', 'Parent'),
    list('child', 'Child', 1, 'parent'), list('grandchild', 'Grandchild', 2, 'child'), paragraph('after', 'After')], async api => {
    await api.select('before', 6)
    await api.key('before', 'ArrowDown', { shiftKey: true })
    assert.deepEqual(api.current().selection.selectedBlockRange, { start: 0, end: 1 })
    assert.equal((await api.key('parent')).defaultPrevented, true)
    assert.deepEqual(api.current().editor.draftBlocks.map(block => [block.id, block.content]), [['after', 'After']])
    assert.equal(api.current().metrics.mergeCalls, 0)
    assert.equal(api.current().selection.selectedBlockRange, null)
  }, { collapsedIds: ['parent'] })
})

test('blocked source types, dividers, collapsed headings and document boundaries preserve redo and history', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    for (const type of ['code', 'math', 'table', 'html', 'frontmatter', 'divider', 'unknown']) {
      await withEditor([paragraph('left', 'Alpha'), { ...paragraph('right', 'Source'), type }, paragraph('after', 'After')], async api => {
        await api.select('left', 5)
        await act(async () => api.current().editor.updateDraftBlock(2, { content: 'Changed' }))
        await act(async () => { api.current().editor.undoEdit(); t.mock.timers.tick(0) })
        const original = api.current().editor.draftBlocks
        assert.equal(api.current().editor.canRedo, true)
        assert.equal((await api.key('left')).defaultPrevented, false)
        assert.deepEqual(api.current().editor.draftBlocks, original)
        assert.equal(api.current().editor.canRedo, true); assert.equal(api.current().metrics.historyWrites, 0)
        await api.select('after', 5)
        assert.equal((await api.key('after')).defaultPrevented, false)
        assert.equal(api.current().editor.canRedo, true)
        await act(async () => api.current().editor.redoEdit())
        assert.equal(api.current().editor.draftBlocks[2].content, 'Changed')
      })
    }
    await withEditor([{ ...paragraph('heading', 'Heading'), type: 'heading-1' }, paragraph('hidden', 'Hidden'),
      { ...paragraph('next', 'Next'), type: 'heading-1' }], async api => {
      const original = api.current().editor.draftBlocks
      await api.select('heading', 7)
      assert.equal(api.input('hidden'), null)
      assert.equal((await api.key('heading')).defaultPrevented, false)
      assert.deepEqual(api.current().editor.draftBlocks, original)
      assert.equal(api.current().metrics.historyWrites, 0)
    }, { collapsedIds: ['heading'] })
  } finally { t.mock.timers.reset() }
})

test('Delete refuses a deeper reparenting that would exceed six levels without normalizing away ancestry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const blocks = Array.from({ length: 7 }, (_, depth) => list(`level-${depth}`, `Level ${depth}`, depth,
    depth === 0 ? null : `level-${depth - 1}`))
  blocks.push(list('next', 'Next'), list('next-child', 'Next child', 1, 'next'))
  try {
    await withEditor(blocks, async api => {
      await api.select('level-6', 7)
      await act(async () => api.current().editor.updateDraftBlock(7, { content: 'Changed next' }))
      await act(async () => { api.current().editor.undoEdit(); t.mock.timers.tick(0) })
      const original = api.current().editor.draftBlocks
      assert.equal(api.current().editor.canRedo, true)
      assert.equal((await api.key('level-6')).defaultPrevented, false)
      assert.deepEqual(api.current().editor.draftBlocks, original)
      assert.equal(isDraftTreeContiguous(original), true)
      assert.equal(api.current().metrics.historyWrites, 0); assert.equal(api.current().editor.canRedo, true)
    })
  } finally { t.mock.timers.reset() }
})

test('Backspace between table sources cannot concatenate Markdown, checkpoint history or retire redo', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const table = '| A |\n| --- |\n| B |'
  try {
    await withEditor([{ ...paragraph('left', table), type: 'table' }, { ...paragraph('right', table), type: 'table' }], async api => {
      await act(async () => api.current().editor.updateDraftBlock(0, { content: `${table}\n| C |` }))
      await act(async () => { api.current().editor.undoEdit(); t.mock.timers.tick(0) })
      const original = api.current().editor.draftBlocks
      assert.equal(api.current().editor.canRedo, true)
      await api.select('right', 0)
      await api.key('right', 'Backspace')
      assert.deepEqual(api.current().editor.draftBlocks, original)
      assert.equal(api.current().metrics.historyWrites, 0); assertFocus(api, 'right', 0)
      assert.equal(api.current().editor.canRedo, true)
      await act(async () => api.current().editor.redoEdit())
      assert.equal(api.current().editor.draftBlocks[0].content, `${table}\n| C |`)
    })
  } finally { t.mock.timers.reset() }
})
