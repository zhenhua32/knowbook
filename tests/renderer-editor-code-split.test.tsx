import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { act, createElement, useCallback, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentDetail } from '../src/shared/contracts'
import { isTaskBlockType } from '../src/shared/blockTypes'
import { getUiText } from '../src/renderer/src/i18n'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { useBlockStructureActions } from '../src/renderer/src/hooks/useBlockStructureActions'
import { useBlockFocusState } from '../src/renderer/src/hooks/useBlockFocusState'
import { isNestableBlock, normalizeBlockDepth } from '../src/renderer/src/utils/draftBlockShape'
import { getBlockSubtreeEndIndex } from '../src/renderer/src/utils/draftTreeMove'
import { validateBlockTreeStructure } from '../src/renderer/src/utils/draftTreeNormalization'

type Direction = 'forward' | 'backward' | 'none'
type State = {
  editor: ReturnType<typeof useDocumentEditorState>
  structure: ReturnType<typeof useBlockStructureActions>
  activeBlockIndex: number | null
  cursor: number
}
type Api = {
  current: () => State
  document: Document
  input: (id: string) => HTMLTextAreaElement
  focus: (start: number, end?: number, direction?: Direction) => Promise<void>
  split: (start: number, end?: number, nextType?: string, index?: number) => Promise<void>
  history: (action: 'undo' | 'redo') => Promise<void>
  historyCalls: () => number
}
const snapshot = (blocks: DocumentBlockDraft[]): DocumentBlockDraft[] => JSON.parse(JSON.stringify(blocks))
const source = (type: string, content: string, metadata: Partial<DocumentBlockDraft> = {}): DocumentBlockDraft => ({
  id: 'source', type, content, checked: false, depth: 0, parentBlockId: null,
  tags: ['source', 'keep'], highlight: 'blue', ...metadata
})
const blocksAround = (block: DocumentBlockDraft): DocumentBlockDraft[] => [
  { id: 'before', type: 'paragraph', content: 'Before', checked: false, depth: 0 }, block,
  { id: 'after', type: 'paragraph', content: 'After', checked: false, depth: 0, tags: ['untouched'], highlight: 'yellow' }
]

async function withEditor(context: TestContext, blocks: DocumentBlockDraft[], run: (api: Api) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
    // Focus and history selection must restore during layout, without RAF.
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
  let historyCalls = 0
  function Harness() {
    const editor = useDocumentEditorState({ selectedDocumentId: null, selectedDocument: null, ui: getUiText('en-US'),
      onHomeDataChange: noop, onSelectedDocumentChange: noop, onMessage: noop })
    const [activeBlockIndex, setActiveBlockIndex] = useState<number | null>(null)
    const [cursor, setCursor] = useState(0)
    const blockTextareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])
    const captureBlockCursor = useCallback((index: number, input: HTMLTextAreaElement) => {
      setActiveBlockIndex(index); setCursor(input.selectionStart)
    }, [])
    const focus = useBlockFocusState({ activeCursorPosition: cursor, blockTextareaRefs,
      draftBlocks: editor.draftBlocks, captureBlockCursor })
    const structure = useBlockStructureActions({ draftBlocks: editor.draftBlocks,
      buildBlockTypePatch: (type, content, checked = false, depth = 0, parentBlockId = null) => ({
        type, content: type === 'divider' ? '' : content, checked: isTaskBlockType(type) ? checked : false,
        depth: normalizeBlockDepth(type, depth), parentBlockId: isNestableBlock(type) ? parentBlockId : null }),
      clearBlockSelection: noop, endBlockDrag: noop, setActiveBlockIndex, setActiveCursorPosition: setCursor,
      pushToHistory: previous => { historyCalls++; editor.pushToHistory(previous) },
      setPendingFocusBlockIndex: focus.setPendingFocusBlockIndex, setDraftBlocks: editor.setDraftBlocks })
    state = { editor, structure, activeBlockIndex, cursor }
    return createElement('div', { className: 'block-editor-list' }, editor.draftBlocks.map((block, index) =>
      createElement('div', { key: block.id, className: 'block-editor-row', 'data-block-index': index, 'data-block-id': block.id },
        createElement('textarea', { className: 'block-inline-textarea', value: block.content, readOnly: true,
          onFocus: (event: { currentTarget: HTMLTextAreaElement }) => captureBlockCursor(index, event.currentTarget),
          onSelect: (event: { currentTarget: HTMLTextAreaElement }) => captureBlockCursor(index, event.currentTarget),
          ref: (element: HTMLTextAreaElement | null) => {
            if (element || !blockTextareaRefs.current[index]?.isConnected) blockTextareaRefs.current[index] = element
          } }))))
  }
  const document = dom.window.document
  const input = (id: string) => document.querySelector<HTMLTextAreaElement>(`[data-block-id="${id}"] textarea`)!
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => state.editor.loadDocumentIntoEditor({ id: 'doc', title: 'Split content metadata', summary: '', blocks } as DocumentDetail))
    await run({ current: () => state, document, input, historyCalls: () => historyCalls,
      focus: async (start, end = start, direction = 'none') => {
        await act(async () => { input('source').focus(); input('source').setSelectionRange(start, end, direction) })
      },
      split: async (start, end = start, nextType, index = state.editor.draftBlocks.findIndex(block => block.id === 'source')) => {
        await act(async () => state.structure.splitDraftBlock(index, start, end, nextType))
      },
      history: async action => {
        await act(async () => {
          if (action === 'undo') state.editor.undoEdit()
          else state.editor.redoEdit()
          context.mock.timers.tick(0)
        })
      }
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

function assertFocus(api: Api, id: string, start: number, end = start, direction: Direction = 'none') {
  const input = api.input(id)
  assert.equal(api.document.activeElement, input)
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [start, end, direction])
  assert.equal(api.current().activeBlockIndex, api.current().editor.draftBlocks.findIndex(block => block.id === id))
  assert.equal(api.current().cursor, start)
}

function assertSplit(api: Api, original: DocumentBlockDraft[], leftContent: string, rightContent: string,
  rightType = original.find(block => block.id === 'source')!.type,
  rightLanguage = rightType === 'code' ? original.find(block => block.id === 'source')!.language : undefined) {
  const index = original.findIndex(block => block.id === 'source')
  const rightIndex = getBlockSubtreeEndIndex(original, index) + 1
  const blocks = api.current().editor.draftBlocks
  const left = blocks[index], right = blocks[rightIndex], before = original[index]
  assert.equal(blocks.length, original.length + 1)
  assert.deepEqual(snapshot([left])[0], { ...before, content: leftContent })
  assert.deepEqual(snapshot(blocks.filter((_, offset) => offset !== index && offset !== rightIndex)),
    original.filter((_, offset) => offset !== index))
  assert.equal(typeof right.id, 'string')
  assert.equal(new Set(blocks.map(block => block.id)).size, blocks.length)
  assert.equal(right.type, rightType)
  assert.equal(right.content, rightContent)
  assert.equal(right.checked, false)
  assert.equal(right.depth, isNestableBlock(rightType) ? before.depth : 0)
  assert.equal(right.parentBlockId, isNestableBlock(rightType) ? before.parentBlockId : null)
  assert.equal(right.listStart, undefined)
  assert.equal(right.language, rightLanguage)
  if (rightType === before.type) {
    assert.deepEqual(right.tags, before.tags)
    assert.equal(right.highlight, before.highlight)
    assert.notEqual(right.tags, left.tags)
    assert.deepEqual(right.markdownFormat, before.markdownFormat)
    if (before.markdownFormat) assert.notEqual(right.markdownFormat, left.markdownFormat)
  } else {
    assert.equal(right.tags, undefined)
    assert.equal(right.highlight, undefined)
    assert.equal(right.markdownFormat, undefined)
  }
  assert.deepEqual(validateBlockTreeStructure(blocks), { valid: true, errors: [] })
  assertFocus(api, right.id!, 0)
  return { after: snapshot(blocks), rightId: right.id! }
}

async function assertHistory(api: Api, original: DocumentBlockDraft[], split: { after: DocumentBlockDraft[]; rightId: string },
  start: number, end = start, direction: Direction = 'none') {
  await api.history('undo')
  assert.deepEqual(snapshot(api.current().editor.draftBlocks), original)
  assertFocus(api, 'source', start, end, direction)
  assert.equal(api.current().editor.canUndo, false)
  await api.history('redo')
  assert.deepEqual(snapshot(api.current().editor.draftBlocks), split.after)
  assertFocus(api, split.rightId, 0)
}

for (const [language, expected] of [['typescript', 'typescript'], ['py', 'python'], ['plaintext', 'plaintext']] as const) {
  test(`same-type code split retains explicit ${language} language, independent codeInfo and copied content metadata`, async context => {
    const content = 'header😀\nSELECT value FROM table'
    const position = content.indexOf('SELECT')
    await withEditor(context, blocksAround(source('code', content, { language,
      markdownFormat: { codeInfo: 'custom title="😀" linenos' } })), async api => {
      const original = snapshot(api.current().editor.draftBlocks)
      assert.equal(original[1].language, expected)
      await api.focus(position)
      await api.split(position)
      const split = assertSplit(api, original, content.slice(0, position), content.slice(position), 'code', expected)
      await assertHistory(api, original, split, position)
    })
  })
}

test('Auto Detect code with no recognized language remains undefined after splitting plain source', async context => {
  const content = 'left😀\nright', position = content.indexOf('right')
  await withEditor(context, blocksAround(source('code', content, { markdownFormat: { codeInfo: 'unknown option=1' } })), async api => {
    const original = snapshot(api.current().editor.draftBlocks)
    assert.equal(original[1].language, undefined)
    await api.focus(position)
    await api.split(position)
    const split = assertSplit(api, original, content.slice(0, position), content.slice(position))
    await assertHistory(api, original, split, position)
  })
})

test('Auto Detect code permits a newly recognizable JSON right fragment while retaining the raw fence info', async context => {
  const content = 'prefix😀\n{"value":1}', position = content.indexOf('{')
  await withEditor(context, blocksAround(source('code', content, { markdownFormat: { codeInfo: '' } })), async api => {
    const original = snapshot(api.current().editor.draftBlocks)
    assert.equal(original[1].language, undefined)
    await api.focus(position)
    await api.split(position)
    const split = assertSplit(api, original, content.slice(0, position), content.slice(position), 'code', 'json')
    await assertHistory(api, original, split, position)
  })
})

test('splitting an empty code fence clones emptyCode and codeInfo without losing explicit language or history', async context => {
  await withEditor(context, blocksAround(source('code', '', { language: 'plaintext',
    markdownFormat: { codeInfo: 'text title="empty"', emptyCode: true } })), async api => {
    const original = snapshot(api.current().editor.draftBlocks)
    await api.focus(0)
    await api.split(0)
    const split = assertSplit(api, original, '', '')
    assert.deepEqual(api.current().editor.draftBlocks[2].markdownFormat, { codeInfo: 'text title="empty"', emptyCode: true })
    await assertHistory(api, original, split, 0)
  })
})

const rangeContent = 'ab😀REMOVEcd'
for (const [label, start, end, direction] of [
  ['start', 0, 0, 'none'], ['end', rangeContent.length, rangeContent.length, 'none'],
  ['backward UTF-16 range', 4, 10, 'backward'], ['whole backward range', 0, rangeContent.length, 'backward']
] as const) {
  test(`code split at ${label} preserves compatible metadata, IDs and the original Undo selection`, async context => {
    await withEditor(context, blocksAround(source('code', rangeContent, { language: 'python',
      markdownFormat: { codeInfo: 'py title="range"' } })), async api => {
      const original = snapshot(api.current().editor.draftBlocks)
      await api.focus(start, end, direction)
      await api.split(start, end)
      const split = assertSplit(api, original, rangeContent.slice(0, start), rangeContent.slice(end))
      await assertHistory(api, original, split, start, end, direction)
    })
  })
}

for (const [start, end, safeStart, safeEnd] of [[-20, -1, 0, 0], [100, 200, 9, 9], [5, 2, 5, 5]] as const) {
  test(`code split clamps the supplied range ${start}..${end} while restoring the actual DOM bookmark`, async context => {
    const content = 'AlphaBeta'
    await withEditor(context, blocksAround(source('code', content, { language: 'python' })), async api => {
      const original = snapshot(api.current().editor.draftBlocks)
      await api.focus(safeStart, safeEnd)
      await api.split(start, end)
      const split = assertSplit(api, original, content.slice(0, safeStart), content.slice(safeEnd))
      await assertHistory(api, original, split, safeStart, safeEnd)
    })
  })
}

for (const type of ['paragraph', 'bulleted-list', 'todo', 'numbered-list', 'numbered-todo']) {
  test(`same-type ${type} split copies tags and highlight without inheriting completion or numbering restart`, async context => {
    const metadata: Partial<DocumentBlockDraft> = { checked: isTaskBlockType(type),
      ...(type.startsWith('numbered-') ? { listStart: 7, markdownFormat: { listMarker: ')', listLoose: true } }
        : isNestableBlock(type) ? { markdownFormat: { listMarker: '+', listLoose: true } } : {}) }
    await withEditor(context, blocksAround(source(type, 'AlphaBeta', metadata)), async api => {
      const original = snapshot(api.current().editor.draftBlocks)
      await api.focus(5)
      await api.split(5)
      const split = assertSplit(api, original, 'Alpha', 'Beta')
      await assertHistory(api, original, split, 5)
    })
  })
}

test('splitting a nested list parent places its metadata-carrying sibling after every existing child and retains all tree identities', async context => {
  await withEditor(context, [
    { id: 'outer', type: 'bulleted-list', content: 'Outer', checked: false, depth: 0, parentBlockId: null },
    source('numbered-todo', 'AlphaBeta', { checked: true, depth: 1, parentBlockId: 'outer', listStart: 7,
      markdownFormat: { listMarker: ')', listLoose: true } }),
    { id: 'child', type: 'todo', content: 'Child', checked: true, depth: 2, parentBlockId: 'source', tags: ['child'] },
    { id: 'grandchild', type: 'bulleted-list', content: 'Grandchild', checked: false, depth: 3, parentBlockId: 'child', highlight: 'yellow' },
    { id: 'sibling', type: 'todo', content: 'Sibling', checked: true, depth: 1, parentBlockId: 'outer' },
    { id: 'after', type: 'paragraph', content: 'After', checked: false, depth: 0, parentBlockId: null }
  ], async api => {
    const original = snapshot(api.current().editor.draftBlocks)
    await api.focus(5)
    await api.split(5)
    const split = assertSplit(api, original, 'Alpha', 'Beta')
    assert.equal(api.current().editor.draftBlocks[4].id, split.rightId)
    assert.equal(api.current().editor.draftBlocks[4].parentBlockId, 'outer')
    await assertHistory(api, original, split, 5)
  })
})

for (const type of ['code', 'heading-2']) {
  test(`${type} split to paragraph does not carry source-only content metadata across types`, async context => {
    await withEditor(context, blocksAround(source(type, 'AlphaBeta', type === 'code'
      ? { language: 'python', markdownFormat: { codeInfo: 'py extra' } } : {})), async api => {
      const original = snapshot(api.current().editor.draftBlocks)
      await api.focus(5)
      await api.split(5, 5, type === 'code' ? 'paragraph' : undefined)
      const split = assertSplit(api, original, 'Alpha', 'Beta', 'paragraph')
      await assertHistory(api, original, split, 5)
    })
  })
}

test('splitting a missing source does not record history or discard an existing redo branch', async context => {
  await withEditor(context, blocksAround(source('code', 'AlphaBeta', { language: 'python' })), async api => {
    const original = snapshot(api.current().editor.draftBlocks)
    await api.focus(5)
    await api.split(5)
    const split = assertSplit(api, original, 'Alpha', 'Beta')
    await api.history('undo')
    const calls = api.historyCalls()
    await api.split(0, 0, undefined, 999)
    assert.equal(api.historyCalls(), calls)
    assert.deepEqual(snapshot(api.current().editor.draftBlocks), original)
    assert.equal(api.current().editor.canRedo, true)
    assertFocus(api, 'source', 5)
    await api.history('redo')
    assert.deepEqual(snapshot(api.current().editor.draftBlocks), split.after)
    assertFocus(api, split.rightId, 0)
  })
})
