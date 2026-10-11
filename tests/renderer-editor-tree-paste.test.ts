import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useCallback, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentDetail } from '../src/shared/contracts'
import { getUiText } from '../src/renderer/src/i18n'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { useBlockInputActions } from '../src/renderer/src/hooks/useBlockInputActions'
import { useBlockFocusState } from '../src/renderer/src/hooks/useBlockFocusState'
import { useBlockSelectionState } from '../src/renderer/src/hooks/useBlockSelectionState'
import { isNestableBlock, normalizeBlockDepth } from '../src/renderer/src/utils/draftBlockShape'
import { isDraftTreeContiguous } from '../src/renderer/src/utils/draftTreeDepthChange'
import { validateBlockTreeStructure } from '../src/renderer/src/utils/draftTreeNormalization'
import { getBlockSubtreeEndIndex } from '../src/renderer/src/utils/draftTreeMove'

const item = (id: string, depth = 0, parentBlockId: string | null = null): DocumentBlockDraft =>
  ({ id, type: 'todo', content: id, checked: true, depth, parentBlockId, tags: [id], highlight: 'blue',
    markdownFormat: { listMarker: '+', listLoose: true } })
const tree = (nested = false): DocumentBlockDraft[] => [
  ...(nested ? [item('outer')] : []), item('parent', nested ? 1 : 0, nested ? 'outer' : null),
  item('child', nested ? 2 : 1, 'parent'), item('grandchild', nested ? 3 : 2, 'child'),
  item('other-child', nested ? 2 : 1, 'parent'), item('tail', nested ? 1 : 0, nested ? 'outer' : null),
  item('tail-child', nested ? 2 : 1, 'tail'),
  { id: 'after', type: 'paragraph', content: 'After', checked: false, depth: 0 }
]
type State = {
  editor: ReturnType<typeof useDocumentEditorState>; input: ReturnType<typeof useBlockInputActions>
  selection: ReturnType<typeof useBlockSelectionState>; activeBlockIndex: number | null; activeCursorPosition: number
  collapse: (ids: string[]) => void; historyCalls: () => number
}
async function withEditor(blocks: DocumentBlockDraft[], run: (current: () => State, document: Document) => Promise<void>) {
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
    const [collapsedBlockIds, setCollapsedBlockIds] = useState(new Set<string>())
    const selection = useBlockSelectionState({ activeBlockIndex, collapsedBlockIds, draftBlocks: editor.draftBlocks,
      onActiveBlockChange: setActiveBlockIndex, visibleSliceCrossParentGuard: 'different parents', selectionStaleGuard: 'stale' })
    const refs = useRef<Array<HTMLTextAreaElement | null>>([])
    const capture = useCallback((index: number, element: HTMLTextAreaElement) => {
      setActiveBlockIndex(index); setActiveCursorPosition(element.selectionStart)
    }, [])
    const focus = useBlockFocusState({ activeCursorPosition, blockTextareaRefs: refs, draftBlocks: editor.draftBlocks, captureBlockCursor: capture })
    const calls = useRef(0)
    const input = useBlockInputActions({ draftBlocks: editor.draftBlocks, selectedBlockRange: selection.selectedBlockRange,
      buildBlockTypePatch: (type, content, checked = false, depth = 0, parentBlockId = null) => ({ type, content, checked,
        depth: normalizeBlockDepth(type, depth), parentBlockId: isNestableBlock(type) ? parentBlockId : null }),
      clearBlockSelection: selection.clearBlockSelection, getMultiBlockOperationRange: selection.getMultiBlockOperationRange,
      detectCodeLanguage: () => undefined, normalizeCodeLanguage: language => language,
      endBlockDrag: noop, pushToHistory: blocks => { calls.current++; editor.pushToHistory(blocks) },
      setActiveBlockIndex, setActiveCursorPosition, setDraftBlocks: editor.setDraftBlocks,
      setPendingFocusBlockIndex: focus.setPendingFocusBlockIndex, updateDraftBlock: editor.updateDraftBlock })
    state = { editor, input, selection, activeBlockIndex, activeCursorPosition,
      collapse: ids => setCollapsedBlockIds(new Set(ids)), historyCalls: () => calls.current }
    return createElement('div', { className: 'block-editor-list' }, selection.getVisibleBlockEntries(editor.draftBlocks).map(({ block, index }) =>
      createElement('div', { key: block.id, className: 'block-editor-row', 'data-block-index': index, 'data-block-id': block.id },
        createElement('textarea', { className: 'block-inline-textarea', value: block.content, readOnly: true,
          onFocus: (event: { currentTarget: HTMLTextAreaElement }) => capture(index, event.currentTarget),
          ref: (element: HTMLTextAreaElement | null) => { if (element || !refs.current[index]?.isConnected) refs.current[index] = element } }))))
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => state.editor.loadDocumentIntoEditor({ id: 'doc', title: 'Tree paste', summary: '', blocks } as DocumentDetail))
    await run(() => state, dom.window.document)
  } finally {
    await act(async () => root.unmount())
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}
function assertValid(blocks: DocumentBlockDraft[]) {
  const validation = validateBlockTreeStructure(blocks)
  assert.equal(validation.valid, true, validation.errors.join('\n'))
  assert.equal(isDraftTreeContiguous(blocks), true)
  assert.equal(new Set(blocks.map(block => block.id)).size, blocks.length)
}
async function paste(current: () => State, index: number, text: string, start = 0, end = current().editor.draftBlocks[index].content.length) {
  await act(async () => assert.equal(current().input.handleBlockPaste(index, text, start, end), true))
  assertValid(current().editor.draftBlocks)
}
const serializable = (blocks: DocumentBlockDraft[]) => JSON.parse(JSON.stringify(blocks))

for (const nested of [false, true]) {
  test(`pasting nested siblings into a ${nested ? 'nested' : 'root'} parent preserves all old children and an atomic selection bookmark`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      await withEditor(tree(nested), async (current, document) => {
        const original = current().editor.draftBlocks
        const index = nested ? 1 : 0
        const textarea = document.querySelector<HTMLTextAreaElement>('[data-block-id="parent"] textarea')!
        await act(async () => { textarea.focus(); textarea.setSelectionRange(0, textarea.value.length, 'backward') })
        await paste(current, index, '- [ ] New parent\n  - Pasted child\n- Second\n  - Last pasted child')
        const result = current().editor.draftBlocks
        assert.deepEqual(result.map(block => block.content), [...(nested ? ['outer'] : []), 'New parent', 'Pasted child',
          'child', 'grandchild', 'other-child', 'Second', 'Last pasted child', 'tail', 'tail-child', 'After'])
        assert.equal(result[index].id, 'parent')
        assert.deepEqual(result[index].tags, original[index].tags)
        assert.equal(result[index].highlight, original[index].highlight)
        assert.equal(result[index].checked, false)
        assert.equal(result[index + 1].parentBlockId, 'parent')
        assert.deepEqual(result.slice(index + 2, index + 5), original.slice(index + 1, index + 4))
        assert.deepEqual(result.slice(index + 7), original.slice(index + 4))
        assert.equal(getBlockSubtreeEndIndex(result, index), index + 4)
        assert.equal(current().activeBlockIndex, index + 6)
        assert.equal(document.activeElement, document.querySelectorAll('textarea')[index + 6])
        assert.equal(current().activeCursorPosition, 'Last pasted child'.length)
        assert.equal(current().historyCalls(), 1)
        await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
        assert.deepEqual(current().editor.draftBlocks, original)
        assert.equal(current().editor.canUndo, false)
        assert.equal(document.activeElement, textarea)
        assert.deepEqual([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection], [0, 'parent'.length, 'backward'])
        await act(async () => current().editor.redoEdit())
        assert.deepEqual(serializable(current().editor.draftBlocks), serializable(result))
        assert.equal((document.activeElement as HTMLTextAreaElement).selectionStart, 'Last pasted child'.length)
      })
    } finally { t.mock.timers.reset() }
  })
}

test('a heading followed by a nested list promotes old child and enclosing sibling trees without assigning a heading as parent', async () => {
  await withEditor(tree(true), async current => {
    const original = current().editor.draftBlocks
    await paste(current, 1, '# Heading\n\n- New root\n  - New child')
    const result = current().editor.draftBlocks
    assert.deepEqual(result.map(block => [block.content, block.depth]), [
      ['outer', 0], ['Heading', 0], ['child', 0], ['grandchild', 1], ['other-child', 0],
      ['New root', 0], ['New child', 1], ['tail', 0], ['tail-child', 1], ['After', 0]])
    assert.equal(result[1].id, 'parent')
    assert.equal(result[3].parentBlockId, 'child')
    assert.equal(result[6].parentBlockId, result[5].id)
    assert.equal(result[8].parentBlockId, 'tail')
    for (const id of ['child', 'grandchild', 'other-child', 'tail', 'tail-child']) {
      const kept = result.find(block => block.id === id)!
      const old = original.find(block => block.id === id)!
      assert.deepEqual({ ...kept, depth: old.depth, parentBlockId: old.parentBlockId }, old)
    }
  })
})

test('a later heading exits the old outer list only after the first pasted parent and its complete old child subtree', async () => {
  await withEditor(tree(true), async current => {
    const original = current().editor.draftBlocks
    await paste(current, 1, '- Replacement\n  - New child\n\n# Heading\n\n- After heading\n  - Last child')
    const result = current().editor.draftBlocks
    assert.deepEqual(result.map(block => [block.content, block.depth]), [['outer', 0], ['Replacement', 1], ['New child', 2],
      ['child', 2], ['grandchild', 3], ['other-child', 2], ['Heading', 0], ['After heading', 0], ['Last child', 1],
      ['tail', 0], ['tail-child', 1], ['After', 0]])
    assert.deepEqual(result.slice(3, 6), original.slice(2, 5))
    assert.equal(result[10].parentBlockId, 'tail')
    assert.equal(current().activeBlockIndex, 8)
  })
})

test('paste at the maximum depth keeps overflowing Markdown verbatim and preserves every existing field and child', async () => {
  const blocks = Array.from({ length: 7 }, (_, index) => item(`level-${index}`, index, index ? `level-${index - 1}` : null))
  const text = '- Replacement\n  - Child\n    - Grandchild'
  await withEditor(blocks, async (current, document) => {
    const original = current().editor.draftBlocks
    await paste(current, 5, text)
    const result = current().editor.draftBlocks
    assert.deepEqual(result, original.map((block, index) => index === 5 ? { ...block, content: text } : block))
    assert.equal(document.activeElement, document.querySelectorAll('textarea')[5])
    assert.equal(current().activeCursorPosition, text.length)
  })
})

test('paste can use the final supported nested level without flattening the pasted or existing child trees', async () => {
  const blocks = Array.from({ length: 6 }, (_, index) => item(`level-${index}`, index, index ? `level-${index - 1}` : null))
  await withEditor(blocks, async current => {
    const original = current().editor.draftBlocks
    await paste(current, 4, '- Replacement\n  - Child\n    - Grandchild\n- Second')
    const result = current().editor.draftBlocks
    assert.deepEqual(result.map(block => block.depth), [0, 1, 2, 3, 4, 5, 6, 5, 4])
    assert.deepEqual(result[7], original[5])
    assert.equal(result[6].parentBlockId, result[5].id)
  })
})

test('plain multiline text retains a checked parent and its subtree, keeps Unicode prefix/suffix and focuses that parent', async () => {
  const blocks = tree(true); blocks[1].content = '前🙂後'
  await withEditor(blocks, async (current, document) => {
    const original = current().editor.draftBlocks
    await paste(current, 1, '甲\r\n乙', 1, 3)
    const result = current().editor.draftBlocks
    assert.deepEqual(result, original.map((block, index) => index === 1 ? { ...block, content: '前甲\n乙後' } : block))
    assert.equal(current().activeBlockIndex, 1)
    assert.equal(document.activeElement, document.querySelectorAll('textarea')[1])
    assert.equal(current().activeCursorPosition, '前甲\n乙'.length)
  })
})

test('replacing a folded block range removes all selected hidden descendants and creates fresh pasted identities', async () => {
  await withEditor(tree(), async current => {
    const original = current().editor.draftBlocks
    await act(async () => current().collapse(['parent', 'tail']))
    await act(async () => current().selection.selectBlockRange(0))
    await act(async () => current().selection.selectBlockRange(4, true))
    await paste(current, 4, '- New\n  - New child')
    const result = current().editor.draftBlocks
    assert.deepEqual(result.map(block => block.content), ['New', 'New child', 'After'])
    assert.equal(result.some(block => original.slice(0, 6).some(old => old.id === block.id)), false)
    assert.equal(current().selection.selectedBlockRange, null)
  })
})

test('replacing a parent plus its first child promotes unselected later children instead of adopting them into the new parent', async () => {
  await withEditor(tree(true), async current => {
    const original = current().editor.draftBlocks
    await act(async () => current().selection.selectBlockRange(1))
    await act(async () => current().selection.selectBlockRange(2, true))
    await paste(current, 2, '- New\n  - New child')
    const result = current().editor.draftBlocks
    assert.deepEqual(result.map(block => [block.content, block.depth]), [['outer', 0], ['New', 1], ['New child', 2],
      ['other-child', 1], ['tail', 1], ['tail-child', 2], ['After', 0]])
    assert.equal(result[3].id, 'other-child')
    assert.equal(result[3].parentBlockId, 'outer')
    assert.deepEqual(result.slice(4), original.slice(5))
  })
})

test('functional paste preserves queued changes in untouched blocks and no-op paste leaves history available', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(tree(), async current => {
      await act(async () => {
        current().editor.updateDraftBlock(6, { content: 'Queued text' })
        assert.equal(current().input.handleBlockPaste(0, '- New\n- Second', 0, 6), true)
      })
      assert.equal(current().editor.draftBlocks.at(-1)!.content, 'Queued text')
      assertValid(current().editor.draftBlocks)
      await act(async () => { current().editor.undoEdit(); t.mock.timers.tick(0) })
      const original = current().editor.draftBlocks
      const calls = current().historyCalls()
      assert.equal(current().editor.canRedo, true)
      await act(async () => {
        assert.equal(current().input.handleBlockPaste(-1, 'a\nb', 0, 0), false)
        assert.equal(current().input.handleBlockPaste(0, 'single line', 0, 0), false)
        assert.equal(current().input.handleBlockPaste(0, '\n', 0, 6), false)
      })
      assert.deepEqual(current().editor.draftBlocks, original)
      assert.equal(current().historyCalls(), calls)
      assert.equal(current().editor.canRedo, true)
    })
  } finally { t.mock.timers.reset() }
})
