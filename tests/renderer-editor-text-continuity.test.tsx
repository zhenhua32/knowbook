import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useCallback, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentDetail } from '../src/shared/contracts'
import { getUiText } from '../src/renderer/src/i18n'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { useBlockStructureActions } from '../src/renderer/src/hooks/useBlockStructureActions'
import { useBlockFocusState } from '../src/renderer/src/hooks/useBlockFocusState'
import { isNestableBlock, normalizeBlockDepth } from '../src/renderer/src/utils/draftBlockShape'
import { getBlockSubtreeEndIndex } from '../src/renderer/src/utils/draftTreeMove'
import { validateBlockTreeStructure } from '../src/renderer/src/utils/draftTreeNormalization'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { BlockEditorRow } = await import('../src/renderer/src/components/BlockEditorRow')
await import('../src/renderer/src/components/MarkdownFormatToolbar')
type RowProps = import('../src/renderer/src/components/BlockEditorRow').BlockEditorRowProps
type State = { editor: ReturnType<typeof useDocumentEditorState>; structure: ReturnType<typeof useBlockStructureActions>;
  focus: ReturnType<typeof useBlockFocusState>; activeBlockIndex: number | null; activeCursorPosition: number;
  setOptions: (options: Partial<RowProps>) => void }

const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, content, type: 'paragraph', checked: false, depth: 0 })
async function withEditor(blocks: DocumentBlockDraft[], run: (current: () => State, document: Document,
  key: (element: HTMLTextAreaElement, key: string, options?: KeyboardEventInit) => Promise<KeyboardEvent>) => Promise<void>, hiddenIds: string[] = []) {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: (): number => 1, cancelAnimationFrame: (): void => {}, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
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
    const [options, setOptions] = useState<Partial<RowProps>>({})
    const blockTextareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])
    const captureBlockCursor = useCallback((index: number, element: HTMLTextAreaElement) => {
      setActiveBlockIndex(index); setActiveCursorPosition(element.selectionStart)
    }, [])
    const focus = useBlockFocusState({ activeCursorPosition, blockTextareaRefs, draftBlocks: editor.draftBlocks, captureBlockCursor })
    const structure = useBlockStructureActions({ draftBlocks: editor.draftBlocks,
      buildBlockTypePatch: (type, content, checked = false, depth = 0, parentBlockId = null) => ({ type, content,
        checked: isNestableBlock(type) ? checked : false, depth: normalizeBlockDepth(type, depth),
        parentBlockId: isNestableBlock(type) ? parentBlockId : null }),
      clearBlockSelection: noop, endBlockDrag: noop, pushToHistory: editor.pushToHistory,
      setActiveBlockIndex, setActiveCursorPosition, setPendingFocusBlockIndex: focus.setPendingFocusBlockIndex,
      setDraftBlocks: editor.setDraftBlocks })
    state = { editor, structure, focus, activeBlockIndex, activeCursorPosition, setOptions }
    return createElement('div', { className: 'block-editor-list' }, editor.draftBlocks.map((block, index) => {
      if (hiddenIds.includes(block.id!)) return null
      const props: RowProps = {
        block, index, draftBlockCount: editor.draftBlocks.length, getDraftBlocks: editor.getDraftBlocks,
        selectedDocument: { id: 'doc', title: 'Continuity' }, isSelected: false, isHighlighted: false,
        hasChildren: getBlockSubtreeEndIndex(editor.draftBlocks, index) > index, dropPreview: null,
        indentPx: block.depth * 24, numberLabel: '', activeBlockIndex, collapsedBlockIds: new Set(),
        activeSlashContext: null, filteredSlashCommands: [], activeSlashCommand: null,
        selectedBlockRange: null, selectedBlockCount: 0, blockTextareaRefs,
        updateDraftBlock: editor.updateDraftBlock, checkpointDraft: editor.checkpointDraft,
        updateBlockHighlight: noop, insertDraftBlockAt: structure.insertDraftBlockAt,
        handleBlockContentChange: (index, content) => editor.updateDraftBlock(index, { content }),
        navigateInlineReferenceAtCursor: noop, captureBlockCursor, handleBlockPaste: () => false,
        beginBlockDrag: noop, endBlockDrag: noop, getDraggedBlockDepthPreview: () => null,
        dropBlockAt: noop, setDragOverBlockIndex: noop, setDragOverBlockDepth: noop,
        moveSelectedBlocks: noop, moveDraftBlockBySibling: noop, setSelectedSlashCommandIndex: noop,
        applySlashCommand: noop, dismissSlashCommand: noop, adjustSelectedBlocksDepth: noop,
        adjustBlockDepth: noop, deleteSelectedBlocks: noop, duplicateSelectedBlocks: noop,
        duplicateDraftBlock: structure.duplicateDraftBlock, selectBlockRange: noop, selectAllBlocks: noop,
        notifyBlockMouseDown: noop, handleBlockMouseEnter: noop, endBlockRangeSelection: noop,
        isBlockRangeSelecting: false, continueBlockAt: structure.splitDraftBlock,
        downgradeBlockAt: noop, mergeWithPreviousBlock: noop, splitDraftBlock: structure.splitDraftBlock,
        toggleBlockCollapse: noop, isSelectionCoherent: () => true, getVisibleBlockCountInRange: () => 0,
        getMultiBlockOperationRange: range => range, removeSelectedBlockRange: noop,
        canMoveSelectedRange: () => false, onOpenSelectionAiEditor: noop, BLOCK_INDENT_SIZE: 24,
        ui: getUiText('en-US'), isZh: false, ...options
      }
      return createElement(BlockEditorRow, { key: block.id, ...props })
    }))
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => state.editor.loadDocumentIntoEditor({ id: 'doc', title: 'Continuity', summary: '', blocks } as DocumentDetail))
    await run(() => state, dom.window.document, async (element, key, options = {}) => {
      const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
      await act(async () => element.dispatchEvent(event))
      return event as KeyboardEvent
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

test('paragraph Enter replaces the selected text and undo/redo restores identity, focus and backwards selection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withEditor([paragraph('text', 'Alpha selected Omega'), paragraph('after', 'After')], async (current, document, key) => {
    const original = current().editor.draftBlocks
    const input = document.querySelector('textarea')!
    await act(async () => { input.focus(); input.setSelectionRange(6, 15, 'backward') })
    assert.equal((await key(input, 'Enter')).defaultPrevented, true)
    const split = current().editor.draftBlocks
    assert.deepEqual(split.map(block => block.content), ['Alpha ', 'Omega', 'After'])
    assert.equal(split[0].id, 'text'); assert.equal(split[2].id, 'after')
    assert.notEqual(split[1].id, 'text')
    assert.equal(document.activeElement, document.querySelectorAll('textarea')[1])
    assert.equal(current().activeCursorPosition, 0)
    await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
    assert.deepEqual(current().editor.draftBlocks, original)
    assert.equal(document.activeElement, input)
    assert.equal(input.selectionStart, 6); assert.equal(input.selectionEnd, 15); assert.equal(input.selectionDirection, 'backward')
    await act(async () => current().editor.redoEdit())
    assert.deepEqual(JSON.parse(JSON.stringify(current().editor.draftBlocks)), JSON.parse(JSON.stringify(split)))
    assert.equal(document.activeElement, document.querySelectorAll('textarea')[1])
  })
})

test('paragraph Enter splits only at its caret, including existing soft lines and an empty final paragraph', async () => {
  await withEditor([paragraph('text', 'Alpha\nBeta'), paragraph('empty', '')], async (current, document, key) => {
    const input = document.querySelector('textarea')!
    await act(async () => { input.focus(); input.setSelectionRange(7, 7) })
    await key(input, 'Enter')
    assert.deepEqual(current().editor.draftBlocks.map(block => block.content), ['Alpha\nB', 'eta', ''])
    const empty = document.querySelectorAll('textarea')[2]
    await act(async () => empty.focus())
    await key(empty, 'Enter')
    assert.deepEqual(current().editor.draftBlocks.map(block => block.content), ['Alpha\nB', 'eta', '', ''])
    assert.equal(document.activeElement, document.querySelectorAll('textarea')[3])
  })
})

test('splitting a nested checked list parent keeps its complete child tree before the new unchecked sibling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const blocks: DocumentBlockDraft[] = [
    { ...paragraph('outer', 'Outer'), type: 'bulleted-list' },
    { ...paragraph('parent', 'AlphaBeta'), type: 'numbered-todo', depth: 1, parentBlockId: 'outer', checked: true,
      listStart: 4, tags: ['keep'], highlight: 'blue', markdownFormat: { listMarker: ')' } },
    { ...paragraph('child', 'Child'), type: 'todo', depth: 2, parentBlockId: 'parent', checked: true },
    { ...paragraph('grandchild', 'Grandchild'), type: 'bulleted-list', depth: 3, parentBlockId: 'child' },
    { ...paragraph('sibling', 'Sibling'), type: 'bulleted-list', depth: 1, parentBlockId: 'outer' }, paragraph('after', 'After')
  ]
  await withEditor(blocks, async (current, document, key) => {
    const original = current().editor.draftBlocks
    const input = document.querySelectorAll('textarea')[1]
    await act(async () => { input.focus(); input.setSelectionRange(5, 5) })
    await key(input, 'Enter')
    const split = current().editor.draftBlocks
    assert.deepEqual(split.map(block => block.content), ['Outer', 'Alpha', 'Child', 'Grandchild', 'Beta', 'Sibling', 'After'])
    assert.deepEqual(split[1], { ...original[1], content: 'Alpha' })
    assert.deepEqual(split.slice(2, 4), original.slice(2, 4))
    assert.equal(split[4].depth, 1); assert.equal(split[4].parentBlockId, 'outer'); assert.equal(split[4].checked, false)
    assert.equal(split[4].listStart, undefined); assert.deepEqual(split[4].markdownFormat, original[1].markdownFormat)
    assert.equal(getBlockSubtreeEndIndex(split, 1), 3)
    assert.equal(validateBlockTreeStructure(split).valid, true)
    assert.equal(document.activeElement, document.querySelectorAll('textarea')[4])
    await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
    assert.deepEqual(current().editor.draftBlocks, original); assert.equal(document.activeElement, input)
    assert.equal(input.selectionStart, 5)
    await act(async () => current().editor.redoEdit())
    assert.deepEqual(JSON.parse(JSON.stringify(current().editor.draftBlocks)), JSON.parse(JSON.stringify(split)))
    assert.equal(document.activeElement, document.querySelectorAll('textarea')[4])
  })
})

test('horizontal arrows skip unmounted rows and dividers and capture the destination caret', async () => {
  await withEditor([paragraph('before', 'Before'), paragraph('hidden', 'Hidden'),
    { ...paragraph('divider', ''), type: 'divider' }, paragraph('after', 'After')], async (current, document, key) => {
    const [before, after] = document.querySelectorAll('textarea')
    await act(async () => { before.focus(); before.setSelectionRange(6, 6) })
    assert.equal((await key(before, 'ArrowRight')).defaultPrevented, true)
    assert.equal(document.activeElement, after); assert.equal(after.selectionStart, 0)
    assert.equal(current().activeBlockIndex, 3); assert.equal(current().activeCursorPosition, 0)
    assert.equal((await key(after, 'ArrowLeft')).defaultPrevented, true)
    assert.equal(document.activeElement, before); assert.equal(before.selectionStart, 6)
    assert.equal(current().activeBlockIndex, 0); assert.equal(current().activeCursorPosition, 6)
  }, ['hidden'])
})

test('Enter and arrow guards preserve IME, suggestions, soft breaks, selections and modifier keys', async () => {
  await withEditor([paragraph('before', 'Before'), paragraph('text', 'Text'), paragraph('after', 'After')], async (current, document, key) => {
    const input = document.querySelectorAll('textarea')[1]
    await act(async () => { input.focus(); input.setSelectionRange(0, 0) })
    const original = current().editor.draftBlocks
    assert.equal((await key(input, 'Enter', { shiftKey: true })).defaultPrevented, false)
    assert.equal((await key(input, 'Enter', { isComposing: true })).defaultPrevented, false)
    assert.equal((await key(input, 'ArrowLeft', { isComposing: true })).defaultPrevented, false)
    for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey']) {
      assert.equal((await key(input, 'ArrowLeft', { [modifier]: true })).defaultPrevented, false)
    }
    input.setSelectionRange(0, 4, 'backward')
    assert.equal((await key(input, 'ArrowLeft')).defaultPrevented, false)
    assert.equal((await key(input, 'ArrowRight')).defaultPrevented, false)
    input.setSelectionRange(2, 2)
    assert.equal((await key(input, 'ArrowRight')).defaultPrevented, false)
    let slashApplied = 0
    await act(async () => current().setOptions({ activeSlashContext: { query: 'p' }, activeSlashCommand: { id: 'paragraph' },
      applySlashCommand: () => { slashApplied += 1 } }))
    await key(input, 'Enter')
    assert.equal(slashApplied, 1)
    await act(async () => current().setOptions({ handleLinkSuggestionKeyDown: event => {
      if (event.key !== 'Enter') return false
      event.preventDefault(); return true
    } }))
    await key(input, 'Enter')
    assert.deepEqual(current().editor.draftBlocks, original)
    assert.equal(document.activeElement, input)
  })
})

test('horizontal arrows at the document edges leave the native event untouched', async () => {
  await withEditor([paragraph('only', '')], async (_current, document, key) => {
    const input = document.querySelector('textarea')!
    await act(async () => input.focus())
    assert.equal((await key(input, 'ArrowLeft')).defaultPrevented, false)
    assert.equal((await key(input, 'ArrowRight')).defaultPrevented, false)
    assert.equal(document.activeElement, input)
  })
})

test('a new focus request replaces an earlier caret override while an index remap retains its requested caret', async () => {
  await withEditor([paragraph('first', 'First'), paragraph('middle', 'Middle'), paragraph('last', 'Last')], async (current, document, key) => {
    const inputs = document.querySelectorAll('textarea')
    await act(async () => { inputs[1].focus(); inputs[1].setSelectionRange(3, 3) })
    await key(inputs[1], 'ArrowRight', { ctrlKey: true })
    assert.equal(current().activeCursorPosition, 3)
    await act(async () => {
      current().focus.setPendingFocusBlockIndex(0, 0)
      current().focus.setPendingFocusBlockIndex(2)
    })
    assert.equal(document.activeElement, inputs[2]); assert.equal(inputs[2].selectionStart, 3)
    await act(async () => {
      current().focus.setPendingFocusBlockIndex(1, 0)
      current().focus.setPendingFocusBlockIndex(index => index === null ? null : index + 1)
    })
    assert.equal(document.activeElement, inputs[2]); assert.equal(inputs[2].selectionStart, 0)
  })
})
