import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { act, createElement, useCallback, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentDetail, UpdateDocumentInput } from '../src/shared/contracts'
import { isTaskBlockType } from '../src/shared/blockTypes'
import { getUiText } from '../src/renderer/src/i18n'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { useMultiBlockActions } from '../src/renderer/src/hooks/useMultiBlockActions'
import { useBlockSelectionState } from '../src/renderer/src/hooks/useBlockSelectionState'
import { useBlockFocusState } from '../src/renderer/src/hooks/useBlockFocusState'
import { isNestableBlock, normalizeBlockDepth } from '../src/renderer/src/utils/draftBlockShape'
import { isDraftTreeContiguous } from '../src/renderer/src/utils/draftTreeDepthChange'
import { validateBlockTreeStructure } from '../src/renderer/src/utils/draftTreeNormalization'

type State = {
  editor: ReturnType<typeof useDocumentEditorState>
  multi: ReturnType<typeof useMultiBlockActions>
  selection: ReturnType<typeof useBlockSelectionState>
  activeBlockIndex: number | null
  setCursor: (index: number, position: number) => void
  historyCalls: () => number
}
type Harness = {
  current: () => State
  document: Document
  saved: UpdateDocumentInput[]
  select: (start: number, end?: number) => Promise<void>
  convert: (type: string) => Promise<void>
  reload: () => Promise<void>
}

const item = (id: string, type = 'paragraph', depth = 0, parentBlockId: string | null = null): DocumentBlockDraft => ({
  id, type, content: `${id} 中文 😀`, checked: isTaskBlockType(type), depth, parentBlockId,
  tags: [id, 'keep'], highlight: 'blue'
})
const snapshot = (blocks: DocumentBlockDraft[]): DocumentBlockDraft[] => JSON.parse(JSON.stringify(blocks))
function detail(blocks: DocumentBlockDraft[], updatedAt = 'revision-0'): DocumentDetail {
  return { id: 'doc', title: 'Batch conversion', path: 'Batch conversion', summary: '', updatedAt,
    children: [], outgoingLinks: [], backlinks: [],
    blocks: blocks.map((block, sortOrder) => ({ ...block, id: block.id!, parentBlockId: block.parentBlockId ?? null, sortOrder })) }
}

async function withEditor(context: TestContext, blocks: DocumentBlockDraft[], run: (harness: Harness) => Promise<void>,
  collapsedIds: string[] = []) {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: (): number => 1, cancelAnimationFrame: (): void => {}, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const saved: UpdateDocumentInput[] = []
  let persisted = detail(blocks)
  Object.defineProperty(dom.window, 'knowbook', { value: {
    updateDocument: async (documentId: string, input: UpdateDocumentInput) => {
      assert.equal(documentId, persisted.id)
      assert.equal(input.expectedUpdatedAt, persisted.updatedAt)
      saved.push({ ...input, blocks: snapshot(input.blocks) })
      persisted = { ...detail(snapshot(input.blocks), `revision-${saved.length}`), title: input.title, summary: input.summary }
      return { document: persisted, requiresFullRefresh: false }
    }
  } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const noop = () => {}
  let state!: State
  function EditorHarness() {
    const [selected, setSelected] = useState(persisted)
    const editor = useDocumentEditorState({ selectedDocumentId: selected.id, selectedDocument: selected,
      ui: getUiText('en-US'), onHomeDataChange: noop, onSelectedDocumentChange: next => { if (next) setSelected(next) }, onMessage: noop })
    const [activeBlockIndex, setActiveBlockIndex] = useState<number | null>(null)
    const [activeCursorPosition, setActiveCursorPosition] = useState(0)
    const selection = useBlockSelectionState({ activeBlockIndex, draftBlocks: editor.draftBlocks,
      collapsedBlockIds: new Set(collapsedIds), onActiveBlockChange: setActiveBlockIndex,
      visibleSliceCrossParentGuard: 'different parents', selectionStaleGuard: 'stale' })
    const blockTextareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])
    const captureBlockCursor = useCallback((index: number, input: HTMLTextAreaElement) => {
      setActiveBlockIndex(index); setActiveCursorPosition(input.selectionStart)
    }, [])
    const focus = useBlockFocusState({ activeCursorPosition, blockTextareaRefs,
      draftBlocks: editor.draftBlocks, captureBlockCursor })
    const historyCalls = useRef(0)
    const multi = useMultiBlockActions({ activeBlockIndex, activeCursorPosition, draftBlocks: editor.draftBlocks,
      buildBlockTypePatch: (type, content, checked = false, depth = 0, parentBlockId = null) => ({
        type, content: type === 'divider' ? '' : content, checked: isTaskBlockType(type) ? checked : false,
        depth: normalizeBlockDepth(type, depth), parentBlockId: isNestableBlock(type) ? parentBlockId : null }),
      clearBlockSelection: selection.clearBlockSelection, endBlockDrag: noop,
      getMultiBlockInteractionGuard: selection.getMultiBlockInteractionGuard,
      getMultiBlockOperationRange: selection.getMultiBlockOperationRange,
      getVisibleSiblingSelectionSlice: selection.getVisibleSiblingSelectionSlice,
      pushToHistory: source => { historyCalls.current++; editor.pushToHistory(source) },
      selectedBlockRange: selection.selectedBlockRange, selectionAnchorBlockId: selection.selectionAnchorBlockId,
      setActiveBlockIndex, setActiveCursorPosition, notify: noop, setDraftBlocks: editor.setDraftBlocks,
      setPendingFocusBlockIndex: focus.setPendingFocusBlockIndex, setSelectedBlockRange: selection.setSelectedBlockRange,
      setSelectionAnchorBlockId: selection.setSelectionAnchorBlockId, ui: getUiText('en-US') })
    state = { editor, multi, selection, activeBlockIndex, historyCalls: () => historyCalls.current,
      setCursor: (index, position) => { setActiveBlockIndex(index); setActiveCursorPosition(position) } }
    return createElement('div', { className: 'block-editor-list' },
      selection.getVisibleBlockEntries(editor.draftBlocks).map(({ block, index }) =>
        createElement('div', { key: block.id, className: 'block-editor-row', 'data-block-index': index, 'data-block-id': block.id },
          createElement('textarea', { className: 'block-inline-textarea', value: block.content, readOnly: true,
            onFocus: (event: { currentTarget: HTMLTextAreaElement }) => captureBlockCursor(index, event.currentTarget),
            ref: (element: HTMLTextAreaElement | null) => {
              if (element || !blockTextareaRefs.current[index]?.isConnected) blockTextareaRefs.current[index] = element
            } }))),
      ['todo', 'numbered-todo', 'numbered-list', 'heading-2', 'quote', 'code'].map(type =>
        createElement('button', { key: type, 'data-convert': type, onClick: () => multi.convertSelectedBlocks(type) }, type)))
  }
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await act(async () => root.render(createElement(EditorHarness)))
    await act(async () => state.editor.loadDocumentIntoEditor(persisted))
    await run({ current: () => state, document: dom.window.document, saved,
      select: async (start, end = start) => {
        await act(async () => state.selection.selectBlockRange(start))
        if (end !== start) await act(async () => state.selection.selectBlockRange(end, true))
      },
      convert: async type => { await act(async () => dom.window.document.querySelector<HTMLButtonElement>(`[data-convert="${type}"]`)!.click()) },
      reload: async () => { await act(async () => state.editor.loadDocumentIntoEditor(persisted)) }
    })
  } finally {
    await act(async () => root.unmount())
    context.mock.timers.reset()
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

function assertIdentityAndTree(actual: DocumentBlockDraft[], original: DocumentBlockDraft[]) {
  assert.deepEqual(actual.map(({ id, tags, highlight }) => ({ id, tags, highlight })),
    original.map(({ id, tags, highlight }) => ({ id, tags, highlight })))
  assert.deepEqual(actual.map(block => block.content), original.map(block => block.content))
  assert.deepEqual(validateBlockTreeStructure(actual), { valid: true, errors: [] })
  assert.equal(isDraftTreeContiguous(actual), true)
}

for (const type of ['todo', 'heading-2', 'quote', 'code']) {
  test(`batch conversion to ${type} preserves identities and metadata through history, save, and reload`, async context => {
    await withEditor(context, [item('first'), item('second', 'numbered-todo'), item('untouched')], async h => {
      const original = snapshot(h.current().editor.draftBlocks)
      await h.select(0, 1)
      const input = h.document.querySelector<HTMLTextAreaElement>('[data-block-id="second"] textarea')!
      await act(async () => {
        input.focus(); input.setSelectionRange(1, 6, 'backward')
        h.document.dispatchEvent(new input.ownerDocument.defaultView!.Event('selectionchange'))
        h.current().setCursor(1, 1)
      })
      await h.convert(type)
      const converted = snapshot(h.current().editor.draftBlocks)
      assertIdentityAndTree(converted, original)
      assert.deepEqual(converted.map(block => block.type), [type, type, 'paragraph'])
      assert.deepEqual(converted.map(block => block.checked), [false, type === 'todo', false])
      assert.deepEqual(converted[2], original[2])
      assert.equal(h.current().selection.selectionAnchorBlockId, 'first')
      assert.deepEqual(h.current().selection.selectedBlockRange, { start: 0, end: 1 })
      assert.equal(h.document.activeElement, input)
      assert.equal(h.current().historyCalls(), 1)
      await act(async () => h.current().editor.undoEdit())
      assert.deepEqual(snapshot(h.current().editor.draftBlocks), original)
      assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [1, 6, 'backward'])
      await act(async () => h.current().editor.redoEdit())
      assert.deepEqual(snapshot(h.current().editor.draftBlocks), converted)
      await act(async () => h.current().editor.saveDocument())
      assert.equal(h.saved.length, 1)
      assert.deepEqual(h.saved[0].blocks, converted)
      assert.equal(h.current().editor.saveStatus, 'saved')
      await h.reload()
      assert.deepEqual(snapshot(h.current().editor.draftBlocks), converted)
    })
  })
}

for (const type of ['todo', 'numbered-list']) {
  test(`batch ${type} conversion keeps compatible list syntax and clears incompatible properties`, async context => {
    await withEditor(context, [
      { ...item('ordered', 'numbered-todo'), listStart: 7, markdownFormat: { listMarker: ')', listLoose: true } },
      { ...item('unordered', 'todo'), markdownFormat: { listMarker: '+', listLoose: true } }, item('after')
    ], async h => {
      const original = snapshot(h.current().editor.draftBlocks)
      await h.select(0, 1); await h.convert(type)
      const result = h.current().editor.draftBlocks
      assertIdentityAndTree(result, original)
      assert.equal(result[0].listStart, type === 'numbered-list' ? 7 : undefined)
      assert.equal(result[1].listStart, undefined)
      assert.deepEqual(result[0].markdownFormat, type === 'numbered-list' ? { listMarker: ')', listLoose: true } : { listLoose: true })
      assert.deepEqual(result[1].markdownFormat, type === 'todo' ? { listMarker: '+', listLoose: true } : { listLoose: true })
      assert.deepEqual(result.slice(0, 2).map(block => block.checked), [type === 'todo', type === 'todo'])
      await act(async () => h.current().editor.saveDocument())
      assert.deepEqual(h.saved[0].blocks, snapshot(result))
    })
  })
}

test('converting code blocks clears code-only metadata while converting to the same type is a no-op', async context => {
  await withEditor(context, [
    { ...item('python', 'code'), content: 'print("value")', language: 'python', markdownFormat: { codeInfo: 'python extra' } },
    { ...item('javascript', 'code'), content: '', language: 'javascript', markdownFormat: { codeInfo: 'js', emptyCode: true } }, item('after')
  ], async h => {
    const original = snapshot(h.current().editor.draftBlocks)
    await h.select(0, 1); await h.convert('code')
    assert.deepEqual(snapshot(h.current().editor.draftBlocks), original)
    assert.equal(h.current().editor.canUndo, false)
    await act(async () => h.current().editor.saveDocument())
    assert.equal(h.saved.length, 0)
    await h.convert('quote')
    const converted = h.current().editor.draftBlocks
    assertIdentityAndTree(converted, original)
    for (const block of converted.slice(0, 2)) {
      assert.equal(block.language, undefined); assert.equal(block.markdownFormat, undefined)
    }
    await act(async () => h.current().editor.undoEdit())
    assert.deepEqual(snapshot(h.current().editor.draftBlocks), original)
  })
})

function nestedTree(): DocumentBlockDraft[] {
  return [item('outer', 'todo'),
    { ...item('branch', 'numbered-todo', 1, 'outer'), listStart: 5, markdownFormat: { listMarker: ')', listLoose: true } },
    item('child', 'bulleted-list', 2, 'branch'), item('grandchild', 'todo', 3, 'child'),
    { ...item('tail', 'numbered-list', 1, 'outer'), listStart: 11, markdownFormat: { listMarker: ')' } },
    item('tail-child', 'todo', 2, 'tail'), item('after')]
}

for (const collapsed of [false, true]) {
  test(`converting a ${collapsed ? 'folded' : 'visible'} nested subtree to headings promotes the outside tail and keeps every ID`, async context => {
    await withEditor(context, nestedTree(), async h => {
      const original = snapshot(h.current().editor.draftBlocks)
      await h.select(1); await h.convert('heading-2')
      const converted = snapshot(h.current().editor.draftBlocks)
      assertIdentityAndTree(converted, original)
      assert.deepEqual(converted.map(({ id, depth, parentBlockId }) => [id, depth, parentBlockId]), [
        ['outer', 0, null], ['branch', 0, null], ['child', 0, null], ['grandchild', 0, null],
        ['tail', 0, null], ['tail-child', 1, 'tail'], ['after', 0, null]
      ])
      assert.deepEqual(converted.map(block => block.type), ['todo', 'heading-2', 'heading-2', 'heading-2', 'numbered-list', 'todo', 'paragraph'])
      assert.deepEqual(converted[4], { ...original[4], depth: 0, parentBlockId: null })
      assert.deepEqual(converted[5], { ...original[5], depth: 1 })
      assert.equal(h.current().selection.selectionAnchorBlockId, 'branch')
      await act(async () => h.current().editor.undoEdit())
      assert.deepEqual(snapshot(h.current().editor.draftBlocks), original)
      await act(async () => h.current().editor.redoEdit())
      assert.deepEqual(snapshot(h.current().editor.draftBlocks), converted)
      await act(async () => h.current().editor.saveDocument())
      assert.deepEqual(h.saved[0].blocks, converted)
      await h.reload()
      assert.deepEqual(snapshot(h.current().editor.draftBlocks), converted)
    }, collapsed ? ['branch'] : [])
  })
}

test('converting a folded list subtree between nestable types retains parent identities and all outside metadata', async context => {
  await withEditor(context, nestedTree(), async h => {
    const original = snapshot(h.current().editor.draftBlocks)
    await h.select(1); await h.convert('todo')
    const result = h.current().editor.draftBlocks
    assertIdentityAndTree(result, original)
    assert.deepEqual(result.map(({ id, depth, parentBlockId }) => [id, depth, parentBlockId]),
      original.map(({ id, depth, parentBlockId }) => [id, depth, parentBlockId]))
    assert.deepEqual(result.slice(1, 4).map(block => block.type), ['todo', 'todo', 'todo'])
    assert.deepEqual(result.slice(1, 4).map(block => block.checked), [true, false, true])
    assert.deepEqual(result[1].markdownFormat, { listLoose: true })
    assert.equal(result[1].listStart, undefined)
    assert.deepEqual(snapshot(result.slice(4)), original.slice(4))
    await act(async () => h.current().editor.saveDocument())
    assert.deepEqual(h.saved[0].blocks, snapshot(result))
  }, ['branch'])
})
