import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { register } from 'node:module'
import { act, createElement, useCallback, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentDetail } from '../src/shared/contracts'
import { getUiText } from '../src/renderer/src/i18n'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { useBlockSelectionState } from '../src/renderer/src/hooks/useBlockSelectionState'
import { getBlockSubtreeEndIndex } from '../src/renderer/src/utils/draftTreeMove'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { BlockEditorRow } = await import('../src/renderer/src/components/BlockEditorRow')
await import('../src/renderer/src/components/CodeBlockPreview')
await import('../src/renderer/src/components/MathBlockPreview')
await import('../src/renderer/src/components/MarkdownTableEditor')
await import('../src/renderer/src/components/MarkdownFormatToolbar')
type RowProps = import('../src/renderer/src/components/BlockEditorRow').BlockEditorRowProps
type Direction = 'forward' | 'backward' | 'none'
type State = {
  editor: ReturnType<typeof useDocumentEditorState>
  selection: ReturnType<typeof useBlockSelectionState>
  activeBlockIndex: number | null
  cursor: number
}
type Api = {
  current: () => State
  document: Document
  initialBlock: DocumentBlockDraft
  input: (id?: string) => HTMLTextAreaElement
  focus: (start: number, end?: number, direction?: Direction, id?: string) => Promise<void>
  key: (options?: KeyboardEventInit, id?: string) => Promise<KeyboardEvent>
  history: (action: 'undo' | 'redo') => Promise<void>
  type: (value: string, cursor: number) => Promise<void>
  metrics: { checkpoints: number; changes: number; list: number[][]; multi: number[][] }
}
const code = (content: string): DocumentBlockDraft => ({ id: 'code', type: 'code', content,
  checked: false, depth: 0, parentBlockId: null, tags: ['keep'], highlight: 'blue', language: 'javascript',
  markdownFormat: { codeInfo: 'js extra' } })

async function withEditor(context: TestContext, content: string, run: (api: Api) => Promise<void>,
  otherBlocks: DocumentBlockDraft[] = [], initialBlock: DocumentBlockDraft = code(content)) {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
    // Deliberately never execute RAF: source selection must be correct at layout.
    requestAnimationFrame: (): number => 1, cancelAnimationFrame: (): void => {}, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const setSelectionRange = dom.window.HTMLTextAreaElement.prototype.setSelectionRange
  dom.window.HTMLTextAreaElement.prototype.setSelectionRange = function (start, end, direction) {
    setSelectionRange.call(this, start, end, direction)
    this.ownerDocument.dispatchEvent(new dom.window.Event('selectionchange'))
  }
  const setNativeValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!
  const nativeType = (input: HTMLTextAreaElement, value: string, cursor: number) => {
    // beforeinput captures the original selection before the browser replaces
    // the DOM value. Bypass React's value tracker to emulate native typing.
    input.dispatchEvent(new dom.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText' }))
    setNativeValue.call(input, value)
    setSelectionRange.call(input, cursor, cursor)
    input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    input.ownerDocument.dispatchEvent(new dom.window.Event('selectionchange'))
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const noop = () => {}
  const metrics: Api['metrics'] = { checkpoints: 0, changes: 0, list: [], multi: [] }
  let state!: State
  function Harness() {
    const editor = useDocumentEditorState({ selectedDocumentId: null, selectedDocument: null, ui: getUiText('en-US'),
      onHomeDataChange: noop, onSelectedDocumentChange: noop, onMessage: noop })
    const [activeBlockIndex, setActiveBlockIndex] = useState<number | null>(null)
    const [cursor, setCursor] = useState(0)
    const blockTextareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])
    const selection = useBlockSelectionState({ activeBlockIndex, collapsedBlockIds: new Set(), draftBlocks: editor.draftBlocks,
      onActiveBlockChange: setActiveBlockIndex, visibleSliceCrossParentGuard: '', selectionStaleGuard: '' })
    const captureBlockCursor = useCallback((index: number, input: HTMLTextAreaElement) => {
      setActiveBlockIndex(index); setCursor(input.selectionStart)
    }, [])
    state = { editor, selection, activeBlockIndex, cursor }
    return createElement('div', { className: 'block-editor-list' }, editor.draftBlocks.map((block, index) => {
      const props: RowProps = {
        block, index, draftBlockCount: editor.draftBlocks.length, getDraftBlocks: editor.getDraftBlocks,
        selectedDocument: { id: 'doc', title: 'Code indentation' }, isSelected: selection.isBlockSelected(index), isHighlighted: false,
        hasChildren: getBlockSubtreeEndIndex(editor.draftBlocks, index) > index, dropPreview: null,
        indentPx: block.depth * 24, numberLabel: '', activeBlockIndex, collapsedBlockIds: new Set(),
        activeSlashContext: null, filteredSlashCommands: [], activeSlashCommand: null,
        selectedBlockRange: selection.selectedBlockRange, selectedBlockCount: selection.selectedBlockCount, blockTextareaRefs,
        updateDraftBlock: (index, patch) => { metrics.changes++; editor.updateDraftBlock(index, patch) },
        checkpointDraft: () => { metrics.checkpoints++; editor.checkpointDraft() },
        updateBlockHighlight: noop, insertDraftBlockAt: noop,
        handleBlockContentChange: (index, content) => { metrics.changes++; editor.updateDraftBlock(index, { content }) },
        navigateInlineReferenceAtCursor: noop, captureBlockCursor, handleBlockPaste: () => false,
        beginBlockDrag: noop, endBlockDrag: noop, getDraggedBlockDepthPreview: () => null,
        dropBlockAt: noop, setDragOverBlockIndex: noop, setDragOverBlockDepth: noop,
        moveSelectedBlocks: noop, moveDraftBlockBySibling: noop, setSelectedSlashCommandIndex: noop,
        applySlashCommand: noop, dismissSlashCommand: noop,
        adjustSelectedBlocksDepth: (delta, index, position) => { metrics.multi.push([delta, index, position]) },
        adjustBlockDepth: (index, delta, position) => { metrics.list.push([index, delta, position]) },
        deleteSelectedBlocks: noop, duplicateSelectedBlocks: noop, duplicateDraftBlock: noop,
        selectBlockRange: selection.selectBlockRange, selectAllBlocks: selection.selectAllBlocks,
        getBlockSelectionFocusIndex: selection.getBlockSelectionFocusIndex, clearBlockSelection: selection.clearBlockSelection,
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
  const input = (id = initialBlock.id!) => document.querySelector<HTMLTextAreaElement>(`[data-block-id="${id}"] .block-inline-textarea`)!
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => state.editor.loadDocumentIntoEditor({ id: 'doc', title: 'Code indentation', summary: '',
      blocks: [initialBlock, ...otherBlocks] } as DocumentDetail))
    const normalizedBlock = state.editor.draftBlocks[0]
    await run({ current: () => state, document, input, metrics, initialBlock: {
      ...normalizedBlock, tags: normalizedBlock.tags ? [...normalizedBlock.tags] : undefined,
      markdownFormat: normalizedBlock.markdownFormat ? { ...normalizedBlock.markdownFormat } : undefined },
      focus: async (start, end = start, direction = 'none', id = initialBlock.id!) => {
        await act(async () => {
          const details = input(id).closest<HTMLDetailsElement>('details')
          if (details && !details.open) {
            details.querySelector<HTMLElement>('summary')!.click()
            // JSDOM queues toggle on a timer; notify React without advancing
            // the typing/history timers while opening the real source control.
            details.dispatchEvent(new dom.window.Event('toggle'))
          }
          input(id).focus(); input(id).setSelectionRange(start, end, direction)
        })
      },
      key: async (options = {}, id = initialBlock.id!) => {
        const event = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, ...options })
        await act(async () => input(id).dispatchEvent(event))
        await act(async () => input(id).dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'Tab', bubbles: true, ...options })))
        return event as KeyboardEvent
      },
      history: async action => {
        await act(async () => {
          if (action === 'undo') state.editor.undoEdit()
          else state.editor.redoEdit()
          context.mock.timers.tick(0)
        })
      },
      type: async (value, position) => { await act(async () => nativeType(input(), value, position)) }
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

function assertEditor(api: Api, content: string, start: number, end = start, direction: Direction = 'none') {
  assert.equal(api.input().value, content)
  assert.equal(api.current().editor.draftBlocks[0].content, content)
  assert.equal(api.document.activeElement, api.input())
  assert.deepEqual([api.input().selectionStart, api.input().selectionEnd, api.input().selectionDirection], [start, end, direction])
  assert.equal(api.current().activeBlockIndex, 0)
  assert.equal(api.current().cursor, start)
  assert.deepEqual({ ...api.current().editor.draftBlocks[0], content: api.initialBlock.content }, api.initialBlock)
}

test('code Tab indents a backward multiline UTF-16 selection without replacing text or touching the excluded final line', async context => {
  await withEditor(context, '😀alpha\nbeta\nlast', async api => {
    await api.focus(2, 13, 'backward')
    assert.equal((await api.key()).defaultPrevented, true)
    assertEditor(api, '  😀alpha\n  beta\nlast', 4, 17, 'backward')
    await api.history('undo')
    assertEditor(api, '😀alpha\nbeta\nlast', 2, 13, 'backward')
    await api.history('redo')
    assertEditor(api, '  😀alpha\n  beta\nlast', 4, 17, 'backward')
    assert.equal((await api.key({ shiftKey: true })).defaultPrevented, true)
    assertEditor(api, '😀alpha\nbeta\nlast', 2, 13, 'backward')
    await api.history('undo')
    assertEditor(api, '  😀alpha\n  beta\nlast', 4, 17, 'backward')
    await api.history('redo')
    assertEditor(api, '😀alpha\nbeta\nlast', 2, 13, 'backward')
  })
})

test('code Shift+Tab removes one tab or two spaces per selected line and retains backwards selection', async context => {
  await withEditor(context, '\t😀alpha\n  beta\nlast', async api => {
    await api.focus(3, 16, 'backward')
    assert.equal((await api.key({ shiftKey: true })).defaultPrevented, true)
    assertEditor(api, '😀alpha\nbeta\nlast', 2, 13, 'backward')
    await api.history('undo')
    assertEditor(api, '\t😀alpha\n  beta\nlast', 3, 16, 'backward')
    await api.history('redo')
    assertEditor(api, '😀alpha\nbeta\nlast', 2, 13, 'backward')
  })
})

test('collapsed code Tab inserts two spaces at the UTF-16 caret and restores it through history without RAF', async context => {
  await withEditor(context, '😀xy', async api => {
    await api.focus(2)
    assert.equal((await api.key()).defaultPrevented, true)
    assertEditor(api, '😀  xy', 4)
    await api.history('undo')
    assertEditor(api, '😀xy', 2)
    await api.history('redo')
    assertEditor(api, '😀  xy', 4)
  })
})

for (const [content, position, expectedPosition] of [['  😀x', 4, 2], ['\t😀x', 3, 2], [' 😀x', 1, 0]] as const) {
  test(`collapsed code Shift+Tab removes leading indentation and maps caret ${position} to ${expectedPosition}`, async context => {
    await withEditor(context, content, async api => {
      await api.focus(position)
      assert.equal((await api.key({ shiftKey: true })).defaultPrevented, true)
      assertEditor(api, '😀x', expectedPosition)
      await api.history('undo')
      assertEditor(api, content, position)
      await api.history('redo')
      assertEditor(api, '😀x', expectedPosition)
    })
  })
}

test('consecutive code Tabs form separate history steps without advancing the typing debounce', async context => {
  await withEditor(context, 'x', async api => {
    await api.focus(0)
    await api.key(); assertEditor(api, '  x', 2)
    await api.key(); assertEditor(api, '    x', 4)
    await api.history('undo'); assertEditor(api, '  x', 2)
    await api.history('undo'); assertEditor(api, 'x', 0)
    await api.history('redo'); assertEditor(api, '  x', 2)
    await api.history('redo'); assertEditor(api, '    x', 4)
  })
})

test('a no-op code outdent does not checkpoint, mutate the draft, or discard the redo branch', async context => {
  await withEditor(context, 'plain', async api => {
    await api.focus(0); await api.key(); await api.history('undo')
    assertEditor(api, 'plain', 0)
    assert.equal(api.current().editor.canRedo, true)
    const counts = { checkpoints: api.metrics.checkpoints, changes: api.metrics.changes }
    assert.equal((await api.key({ shiftKey: true })).defaultPrevented, true)
    assertEditor(api, 'plain', 0)
    assert.deepEqual({ checkpoints: api.metrics.checkpoints, changes: api.metrics.changes }, counts)
    assert.equal(api.current().editor.canRedo, true)
    await api.history('redo'); assertEditor(api, '  plain', 2)
  })
})

test('native input immediately after code indentation remains a separate undo transaction', async context => {
  await withEditor(context, 'ab', async api => {
    await api.focus(1)
    await api.key()
    assertEditor(api, 'a  b', 3)
    // Native input occurs after the synchronous React commit, with no idle
    // history timer advance between the Tab and the following keystroke.
    await api.type('a  Xb', 4)
    assertEditor(api, 'a  Xb', 4)
    await api.history('undo'); assertEditor(api, 'a  b', 3)
    await api.history('undo'); assertEditor(api, 'ab', 1)
    await api.history('redo'); assertEditor(api, 'a  b', 3)
    await api.history('redo'); assertEditor(api, 'a  Xb', 4)
  })
})

for (const selection of [
  { label: 'caret', start: 5, end: 5, direction: 'none', content: 'a  bcXd', cursor: 6 },
  { label: 'backward selection', start: 4, end: 6, direction: 'backward', content: 'a  bX', cursor: 5 }
] as const) {
  test(`typing after code indentation and moving the ${selection.label} restores the new input bookmark on undo`, async context => {
    await withEditor(context, 'abcd', async api => {
      await api.focus(1)
      await api.key()
      assertEditor(api, 'a  bcd', 3)
      await api.focus(selection.start, selection.end, selection.direction)
      assertEditor(api, 'a  bcd', selection.start, selection.end, selection.direction)
      await api.type(selection.content, selection.cursor)
      assertEditor(api, selection.content, selection.cursor)
      await api.history('undo')
      assertEditor(api, 'a  bcd', selection.start, selection.end, selection.direction)
      await api.history('undo'); assertEditor(api, 'abcd', 1)
      await api.history('redo')
      assertEditor(api, 'a  bcd', selection.start, selection.end, selection.direction)
      await api.history('redo'); assertEditor(api, selection.content, selection.cursor)
    })
  })
}

test('rapid native typing before Tab is retained and undone independently from indentation', async context => {
  await withEditor(context, 'a', async api => {
    await api.focus(1)
    await api.type('aX', 2)
    assertEditor(api, 'aX', 2)
    await api.key(); assertEditor(api, 'aX  ', 4)
    await api.history('undo'); assertEditor(api, 'aX', 2)
    await api.history('undo'); assertEditor(api, 'a', 1)
  })
})

test('IME composition, native composing keys, and legacy key 229 keep ownership of code Tab', async context => {
  await withEditor(context, '中文x', async api => {
    await api.focus(2)
    assert.equal((await api.key({ isComposing: true })).defaultPrevented, false)
    assert.equal((await api.key({ keyCode: 229 })).defaultPrevented, false)
    const view = api.input().ownerDocument.defaultView!
    await act(async () => api.input().dispatchEvent(new view.CompositionEvent('compositionstart', { bubbles: true })))
    assert.equal((await api.key()).defaultPrevented, false)
    assertEditor(api, '中文x', 2)
    assert.equal(api.metrics.checkpoints, 0)
    await act(async () => api.input().dispatchEvent(new view.CompositionEvent('compositionend', { bubbles: true })))
    assert.equal((await api.key()).defaultPrevented, true)
    assertEditor(api, '中文  x', 4)
  })
})

test('modified Tab shortcuts keep native ownership without changing code or recording history', async context => {
  await withEditor(context, 'unchanged', async api => {
    await api.focus(3)
    for (const options of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }]) {
      assert.equal((await api.key(options)).defaultPrevented, false)
      assertEditor(api, 'unchanged', 3)
    }
    assert.equal(api.metrics.checkpoints, 0)
    assert.equal(api.metrics.changes, 0)
  })
})

test('multiblock and list depth handlers retain priority over the code indentation branch', async context => {
  await withEditor(context, 'code text', async api => {
    await api.focus(2)
    await act(async () => api.current().selection.selectBlockRange(0))
    await act(async () => api.current().selection.selectBlockRange(1, true))
    assert.equal((await api.key()).defaultPrevented, true)
    assert.deepEqual(api.metrics.multi, [[1, 0, 2]])
    assert.equal(api.current().editor.draftBlocks[0].content, 'code text')
    await act(async () => api.current().selection.clearBlockSelection())
    await api.focus(2, 2, 'none', 'list')
    assert.equal((await api.key({ shiftKey: true }, 'list')).defaultPrevented, true)
    assert.deepEqual(api.metrics.list, [[1, -1, 2]])
    assert.equal(api.metrics.checkpoints, 0)
    assert.equal(api.metrics.changes, 0)
  }, [{ id: 'list', type: 'bulleted-list', content: 'List content', checked: false, depth: 0 }])
})

for (const [type, content] of [
  ['math', 'x^2 + y\nz^2 = 1\nw = 0'],
  ['table', '| A | B |\n| --- | --- |\n| 😀 | two |'],
  ['frontmatter', 'title: "😀"\nlist: [one, two]\ncount: 3'],
  ['html', '<section data-value="😀">\n  <b>keep</b>\n</section>']
] as const) {
  const source: DocumentBlockDraft = { id: `source-${type}`, type, content,
    checked: false, depth: 0, parentBlockId: null, tags: ['source', type], highlight: 'yellow' }
  const lines = content.split('\n')
  const end = lines[0].length + lines[1].length + 2
  const indented = lines.map((line, index) => index < 2 ? `  ${line}` : line).join('\n')

  test(`${type} source Tab and Shift+Tab retain a backward multiline selection, syntax and metadata through Undo/Redo`, async context => {
    await withEditor(context, content, async api => {
      await api.focus(2, end, 'backward')
      assert.equal(api.current().editor.draftBlocks[0].type, type)
      assert.equal(api.current().editor.draftBlocks[0].language, undefined)
      assert.equal(api.current().editor.draftBlocks[0].markdownFormat, undefined)
      if (type === 'table') assert.equal(api.input().closest<HTMLDetailsElement>('details')!.open, true)
      assert.equal((await api.key()).defaultPrevented, true)
      assertEditor(api, indented, 4, end + 4, 'backward')
      await api.history('undo'); assertEditor(api, content, 2, end, 'backward')
      await api.history('redo'); assertEditor(api, indented, 4, end + 4, 'backward')
      assert.equal((await api.key({ shiftKey: true })).defaultPrevented, true)
      assertEditor(api, content, 2, end, 'backward')
      await api.history('undo'); assertEditor(api, indented, 4, end + 4, 'backward')
      await api.history('redo'); assertEditor(api, content, 2, end, 'backward')
    }, [], source)
  })

  test(`${type} source caret indentation restores focus and preserves redo through a no-op outdent`, async context => {
    await withEditor(context, content, async api => {
      await api.focus(0)
      assert.equal((await api.key()).defaultPrevented, true)
      assertEditor(api, `  ${content}`, 2)
      await api.history('undo'); assertEditor(api, content, 0)
      assert.equal(api.current().editor.canRedo, true)
      const counts = { checkpoints: api.metrics.checkpoints, changes: api.metrics.changes }
      assert.equal((await api.key({ shiftKey: true })).defaultPrevented, true)
      assertEditor(api, content, 0)
      assert.deepEqual({ checkpoints: api.metrics.checkpoints, changes: api.metrics.changes }, counts)
      assert.equal(api.current().editor.canRedo, true)
      await api.history('redo'); assertEditor(api, `  ${content}`, 2)
      assert.equal((await api.key({ shiftKey: true })).defaultPrevented, true)
      assertEditor(api, content, 0)
      await api.history('undo'); assertEditor(api, `  ${content}`, 2)
      await api.history('redo'); assertEditor(api, content, 0)
    }, [], source)
  })
}
