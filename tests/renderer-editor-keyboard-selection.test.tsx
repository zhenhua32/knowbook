import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useCallback, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { getUiText } from '../src/renderer/src/i18n'
import { useBlockSelectionState } from '../src/renderer/src/hooks/useBlockSelectionState'
import { getBlockSubtreeEndIndex } from '../src/renderer/src/utils/draftTreeMove'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { BlockEditorRow } = await import('../src/renderer/src/components/BlockEditorRow')
await import('../src/renderer/src/components/MarkdownFormatToolbar')
type RowProps = import('../src/renderer/src/components/BlockEditorRow').BlockEditorRowProps
type State = { selection: ReturnType<typeof useBlockSelectionState>; activeBlockIndex: number | null; cursor: number }
const paragraph = (id: string): DocumentBlockDraft => ({ id, content: id, type: 'paragraph', checked: false, depth: 0 })
type HarnessApi = {
  current: () => State
  document: Document
  input: (id: string) => HTMLTextAreaElement
  select: (id: string, start: number, end?: number) => Promise<void>
  key: (key: string, options?: KeyboardEventInit) => Promise<KeyboardEvent>
  mouse: (target: Element, type: string, options?: MouseEventInit) => Promise<void>
  clipboard: (type: 'copy' | 'cut', text: string) => Promise<{ prevented: boolean; text: string }>
}

async function withSelection(blocks: DocumentBlockDraft[], run: (api: HarnessApi) => Promise<void>, collapsedIds: string[] = []) {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: (): number => 1, cancelAnimationFrame: (): void => {}, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  // React's SelectEventPlugin expects the browser's document-level notification.
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
    const [activeBlockIndex, setActiveBlockIndex] = useState<number | null>(null)
    const [cursor, setCursor] = useState(0)
    const blockTextareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])
    const collapsedBlockIds = new Set(collapsedIds)
    const selection = useBlockSelectionState({ activeBlockIndex, collapsedBlockIds, draftBlocks: blocks,
      onActiveBlockChange: setActiveBlockIndex, visibleSliceCrossParentGuard: '', selectionStaleGuard: '' })
    const captureBlockCursor = useCallback((index: number, element: HTMLTextAreaElement) => {
      setActiveBlockIndex(index); setCursor(element.selectionStart)
    }, [])
    state = { selection, activeBlockIndex, cursor }
    return createElement('div', { className: 'block-editor-list' }, selection.getVisibleBlockEntries(blocks).map(({ block, index }) => {
      const props: RowProps = {
        block, index, draftBlockCount: blocks.length, getDraftBlocks: () => blocks,
        selectedDocument: { id: 'doc', title: 'Selection' }, isSelected: selection.isBlockSelected(index), isHighlighted: false,
        hasChildren: getBlockSubtreeEndIndex(blocks, index) > index, dropPreview: null,
        indentPx: block.depth * 24, numberLabel: '', activeBlockIndex, collapsedBlockIds,
        activeSlashContext: null, filteredSlashCommands: [], activeSlashCommand: null,
        selectedBlockRange: selection.selectedBlockRange, selectedBlockCount: selection.selectedBlockCount, blockTextareaRefs,
        updateDraftBlock: noop, updateBlockHighlight: noop, insertDraftBlockAt: noop, handleBlockContentChange: noop,
        navigateInlineReferenceAtCursor: noop, captureBlockCursor, handleBlockPaste: () => false,
        beginBlockDrag: noop, endBlockDrag: noop, getDraggedBlockDepthPreview: () => null,
        dropBlockAt: noop, setDragOverBlockIndex: noop, setDragOverBlockDepth: noop,
        moveSelectedBlocks: noop, moveDraftBlockBySibling: noop, setSelectedSlashCommandIndex: noop,
        applySlashCommand: noop, dismissSlashCommand: noop, adjustSelectedBlocksDepth: noop,
        adjustBlockDepth: noop, deleteSelectedBlocks: noop, duplicateSelectedBlocks: noop, duplicateDraftBlock: noop,
        selectBlockRange: selection.selectBlockRange, selectAllBlocks: selection.selectAllBlocks,
        getBlockSelectionFocusIndex: selection.getBlockSelectionFocusIndex,
        clearBlockSelection: selection.clearBlockSelection,
        notifyBlockMouseDown: selection.notifyBlockMouseDown, handleBlockMouseEnter: selection.handleBlockMouseEnter,
        endBlockRangeSelection: selection.endBlockRangeSelection, isBlockRangeSelecting: selection.isBlockRangeSelecting,
        continueBlockAt: noop, downgradeBlockAt: noop, mergeWithPreviousBlock: noop, splitDraftBlock: noop,
        toggleBlockCollapse: noop, isSelectionCoherent: selection.isSelectionCoherent,
        getVisibleBlockCountInRange: selection.getVisibleBlockCountInRange,
        getMultiBlockOperationRange: selection.getMultiBlockOperationRange, removeSelectedBlockRange: noop,
        canMoveSelectedRange: selection.canMoveSelectedRange, onOpenSelectionAiEditor: noop,
        BLOCK_INDENT_SIZE: 24, ui: getUiText('en-US'), isZh: false
      }
      return createElement(BlockEditorRow, { key: block.id, ...props })
    }))
  }
  const document = dom.window.document
  const input = (id: string) => document.querySelector<HTMLTextAreaElement>(`[data-block-id="${id}"] textarea`)!
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ current: () => state, document, input,
      select: async (id, start, end = start) => {
        await act(async () => { input(id).focus(); input(id).setSelectionRange(start, end) })
      },
      key: async (key, options = {}) => {
        const source = document.activeElement!
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
        await act(async () => source.dispatchEvent(event))
        // Also emulate an already queued keyup from the old row after focus moved.
        await act(async () => source.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key, bubbles: true, ...options })))
        await act(async () => document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key, bubbles: true, ...options })))
        return event as KeyboardEvent
      },
      mouse: async (target, type, options = {}) => {
        await act(async () => target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...options })))
      },
      clipboard: async (type, text) => {
        // JSDOM has no native clipboard; expose the DataTransfer methods React uses.
        const values = new Map([['text/plain', text]])
        const dataTransfer = { getData: (type: string) => values.get(type) ?? '',
          setData: (type: string, value: string) => { values.set(type, value) } }
        const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'clipboardData', { value: dataTransfer })
        await act(async () => document.activeElement!.dispatchEvent(event))
        return { prevented: event.defaultPrevented, text: dataTransfer.getData('text/plain') }
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

function expectSelection(api: HarnessApi, start: number, end: number, focus: string, position: number) {
  assert.deepEqual(api.current().selection.selectedBlockRange, { start, end })
  assert.equal(api.document.activeElement, api.input(focus))
  assert.equal(api.current().selection.getBlockSelectionFocusIndex(), api.current().activeBlockIndex)
  assert.equal(api.current().cursor, position)
  assert.equal(api.input(focus).selectionStart, position)
  assert.equal(api.input(focus).selectionEnd, position)
}

test('repeated Shift arrows expand, contract and cross the anchor while late keyup preserves the focus endpoint', async () => {
  await withSelection(['A', 'B', 'C', 'D'].map(paragraph), async api => {
    await api.select('B', 1)
    for (const [key, start, end, focus, position] of [
      ['ArrowDown', 1, 2, 'C', 1], ['ArrowDown', 1, 3, 'D', 1], ['ArrowDown', 1, 3, 'D', 1],
      ['ArrowUp', 1, 2, 'C', 0], ['ArrowUp', 1, 1, 'B', 0], ['ArrowUp', 0, 1, 'A', 0],
      ['ArrowUp', 0, 1, 'A', 0], ['ArrowDown', 1, 1, 'B', 1], ['ArrowDown', 1, 2, 'C', 1]
    ] as const) {
      assert.equal((await api.key(key, { shiftKey: true })).defaultPrevented, true)
      expectSelection(api, start, end, focus, position)
      assert.equal(api.current().selection.selectionAnchorBlockId, 'B')
    }
    await api.key('ArrowUp', { altKey: true })
    expectSelection(api, 1, 2, 'C', 1)
    await act(async () => api.current().selection.clearBlockSelection())
    assert.equal(api.current().selection.getBlockSelectionFocusIndex(), null)
    assert.equal(api.current().selection.selectionAnchorBlockId, null)
  })
})

test('an upward selection reverses through its anchor and keeps native events untouched at initial document boundaries', async () => {
  await withSelection(['A', 'B', 'C', 'D'].map(paragraph), async api => {
    await api.select('A', 0)
    assert.equal((await api.key('ArrowUp', { shiftKey: true })).defaultPrevented, false)
    await api.select('D', 1)
    assert.equal((await api.key('ArrowDown', { shiftKey: true })).defaultPrevented, false)
    assert.equal(api.current().selection.selectedBlockRange, null)
    await api.select('C', 0)
    await api.key('ArrowUp', { shiftKey: true }); expectSelection(api, 1, 2, 'B', 0)
    await api.key('ArrowUp', { shiftKey: true }); expectSelection(api, 0, 2, 'A', 0)
    await api.key('ArrowDown', { shiftKey: true }); expectSelection(api, 1, 2, 'B', 1)
    await api.key('ArrowDown', { shiftKey: true }); expectSelection(api, 2, 2, 'C', 1)
    await api.key('ArrowDown', { shiftKey: true }); expectSelection(api, 2, 3, 'D', 1)
    assert.equal(api.current().selection.selectionAnchorBlockId, 'C')
  })
})

test('keyboard selection skips folded descendants in both directions and keeps the complete operation range', async () => {
  const blocks: DocumentBlockDraft[] = [paragraph('Before'), { ...paragraph('Parent'), type: 'todo' },
    { ...paragraph('Child'), type: 'todo', depth: 1, parentBlockId: 'Parent' },
    { ...paragraph('Grandchild'), type: 'todo', depth: 2, parentBlockId: 'Child' }, paragraph('After')]
  await withSelection(blocks, async api => {
    assert.equal(api.document.querySelector('[data-block-id="Child"]'), null)
    await api.select('Before', 6)
    await api.key('ArrowDown', { shiftKey: true }); expectSelection(api, 0, 1, 'Parent', 6)
    assert.deepEqual(api.current().selection.getMultiBlockOperationRange({ start: 0, end: 1 }), { start: 0, end: 3 })
    await api.key('ArrowDown', { shiftKey: true }); expectSelection(api, 0, 4, 'After', 5)
    await api.key('ArrowDown', { shiftKey: true }); expectSelection(api, 0, 4, 'After', 5)
    await api.key('ArrowUp', { shiftKey: true }); expectSelection(api, 0, 1, 'Parent', 0)
    await api.key('ArrowUp', { shiftKey: true }); expectSelection(api, 0, 0, 'Before', 0)
  }, ['Parent'])
})

test('Shift click and mouse range selection retain their endpoint when keyboard input resumes from the old textarea', async () => {
  await withSelection(['A', 'B', 'C', 'D', 'E'].map(paragraph), async api => {
    await api.select('B', 1)
    await api.mouse(api.input('D'), 'mousedown', { shiftKey: true })
    assert.deepEqual(api.current().selection.selectedBlockRange, { start: 1, end: 3 })
    assert.equal(api.document.activeElement, api.input('B'))
    await api.key('ArrowDown', { shiftKey: true }); expectSelection(api, 1, 4, 'E', 1)
    await act(async () => api.current().selection.clearBlockSelection())
    await api.select('A', 1)
    await api.mouse(api.input('A'), 'mousedown', { buttons: 1 })
    await api.mouse(api.input('A'), 'mouseout', { buttons: 1, relatedTarget: api.input('C').closest('.block-editor-row')! })
    await api.mouse(api.input('C'), 'mouseup')
    assert.deepEqual(api.current().selection.selectedBlockRange, { start: 0, end: 2 })
    assert.equal(api.document.activeElement, api.input('A'))
    await api.key('ArrowDown', { shiftKey: true }); expectSelection(api, 0, 3, 'D', 1)
    assert.equal(api.current().selection.selectionAnchorBlockId, 'A')
  })
})

test('native text selections, middle carets, IME and additional modifiers do not become block selections', async () => {
  await withSelection([paragraph('Before'), paragraph('Text'), paragraph('After')], async api => {
    await api.select('Text', 2)
    assert.equal((await api.key('ArrowDown', { shiftKey: true })).defaultPrevented, false)
    await api.select('Text', 0, 4)
    assert.equal((await api.key('ArrowUp', { shiftKey: true })).defaultPrevented, false)
    await api.select('Text', 4)
    for (const options of [{ isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      assert.equal((await api.key('ArrowDown', { shiftKey: true, ...options })).defaultPrevented, false)
      assert.equal(api.current().selection.selectedBlockRange, null)
    }
    await api.key('ArrowDown', { shiftKey: true })
    await api.select('After', 0, 5)
    assert.equal((await api.key('ArrowUp', { shiftKey: true })).defaultPrevented, false)
    assert.equal(api.current().selection.selectedBlockRange, null)
    assert.equal(api.document.activeElement, api.input('After'))
  })
})

test('native caret movement and mouse placement end the single-block range after contracting to its anchor', async () => {
  await withSelection([paragraph('Alpha'), paragraph('Bravo'), paragraph('Charlie')], async api => {
    await api.select('Bravo', 5)
    await api.key('ArrowDown', { shiftKey: true })
    await api.key('ArrowUp', { shiftKey: true }); expectSelection(api, 1, 1, 'Bravo', 0)
    assert.equal((await api.key('ArrowRight')).defaultPrevented, false)
    assert.equal(api.current().selection.selectedBlockRange, null)
    for (const type of ['copy', 'cut']) {
      const event = new api.document.defaultView!.Event(type, { bubbles: true, cancelable: true })
      await act(async () => api.input('Bravo').dispatchEvent(event))
      assert.equal(event.defaultPrevented, false)
    }
    await api.select('Bravo', 2)
    assert.equal((await api.key('ArrowDown', { shiftKey: true })).defaultPrevented, false)
    assert.equal(api.document.activeElement, api.input('Bravo'))
    await api.select('Bravo', 5)
    await api.key('ArrowDown', { shiftKey: true })
    await api.key('ArrowUp', { shiftKey: true })
    assert.equal((await api.key('ArrowLeft', { shiftKey: true })).defaultPrevented, false)
    assert.equal(api.current().selection.getBlockSelectionFocusIndex(), null)
    await api.select('Bravo', 5)
    await api.key('ArrowDown', { shiftKey: true })
    await api.key('ArrowUp', { shiftKey: true })
    await api.mouse(api.input('Bravo'), 'mousedown')
    assert.equal(api.current().selection.getBlockSelectionFocusIndex(), null)
    await api.select('Bravo', 2)
    assert.equal((await api.key('ArrowDown', { shiftKey: true })).defaultPrevented, false)
  })
})

test('first Ctrl+A clears a multi-block range for native text copy/cut and the second Ctrl+A copies every block', async () => {
  await withSelection(['A', 'B', 'C', 'D'].map(paragraph), async api => {
    await api.select('B', 1)
    await api.key('ArrowDown', { shiftKey: true }); expectSelection(api, 1, 2, 'C', 1)
    assert.equal((await api.key('a', { ctrlKey: true, isComposing: true })).defaultPrevented, false)
    expectSelection(api, 1, 2, 'C', 1)
    assert.equal((await api.key('a', { ctrlKey: true })).defaultPrevented, false)
    assert.equal(api.current().selection.selectedBlockRange, null)
    // Apply the native selection that JSDOM does not perform for keyboard events.
    await api.select('C', 0, 1)
    assert.deepEqual(await api.clipboard('copy', 'C'), { prevented: false, text: 'C' })
    assert.deepEqual(await api.clipboard('cut', 'C'), { prevented: false, text: 'C' })
    assert.deepEqual(Array.from(api.document.querySelectorAll('textarea'), input => input.value), ['A', 'B', 'C', 'D'])
    assert.equal((await api.key('a', { ctrlKey: true })).defaultPrevented, true)
    assert.deepEqual(api.current().selection.selectedBlockRange, { start: 0, end: 3 })
    assert.equal(api.current().selection.selectionAnchorBlockId, 'A')
    assert.deepEqual(await api.clipboard('copy', 'native'), { prevented: true, text: 'A\n\nB\n\nC\n\nD' })
  })
})

test('empty-block Ctrl+A selects the complete range while IME keeps Ctrl+A untouched', async () => {
  await withSelection([paragraph('Before'), { ...paragraph('Empty'), content: '' }, paragraph('After')], async api => {
    await api.select('Empty', 0)
    assert.equal((await api.key('a', { ctrlKey: true, isComposing: true })).defaultPrevented, false)
    assert.equal(api.current().selection.selectedBlockRange, null)
    assert.equal((await api.key('a', { ctrlKey: true })).defaultPrevented, true)
    assert.deepEqual(api.current().selection.selectedBlockRange, { start: 0, end: 2 })
    assert.equal(api.current().selection.selectionAnchorBlockId, 'Before')
    assert.equal(api.current().selection.getBlockSelectionFocusIndex(), 2)
  })
})
