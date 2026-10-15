import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentDetail } from '../src/shared/contracts'
import { getRichTextHistoryBridge } from '../src/renderer/src/rich-text/history'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { getUiText } from '../src/renderer/src/i18n'
import { parseMarkdownBlocks } from '../src/shared/markdown'
import { validColumnStructure } from '../src/shared/columns'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
}`)}`, import.meta.url)
await import('../src/renderer/src/components/ColumnsControls')
await import('../src/renderer/src/rich-text/ColumnContentControls')

const noop = () => {}
const initial = (): DocumentBlockDraft[] => [
  { id: 'group', type: 'columns', content: '', checked: false, depth: 0, parentBlockId: null },
  { id: 'left', type: 'column', content: '', checked: false, depth: 1, parentBlockId: 'group', markdownFormat: { columnWeight: 5000 } },
  { id: 'alpha', type: 'paragraph', content: 'Alpha😀Tail', checked: false, depth: 2, parentBlockId: 'left', tags: ['keep'] },
  { id: 'right', type: 'column', content: '', checked: false, depth: 1, parentBlockId: 'group', markdownFormat: { columnWeight: 5000 } },
  { id: 'beta', type: 'paragraph', content: 'Beta😀End', checked: false, depth: 2, parentBlockId: 'right' }
]

async function withRich(run: (api: { dom: JSDOM; blocks: () => DocumentBlockDraft[]; changes: () => number; editor: HTMLElement;
  selectionWrites: Array<{ blockId: string | undefined; hidden: boolean }>;
  history: () => ReturnType<typeof useDocumentEditorState>;
  key: (key: string, options?: KeyboardEventInit) => Promise<void>; point: (id: string, offset: number, endId?: string, endOffset?: number) => Promise<void> }) => Promise<void>, useHistory = false) {
  const dom = new JSDOM('<!doctype html><div id="mount"></div>', { pretendToBeVisual: true, url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { value: () => true })
  const rectangle = { top: 0, bottom: 20, left: 0, right: 100, x: 0, y: 0, width: 100, height: 20, toJSON: () => ({}) }
  dom.window.Range.prototype.getBoundingClientRect = () => rectangle
  dom.window.Range.prototype.getClientRects = () => [rectangle] as unknown as DOMRectList
  dom.window.scrollBy = noop
  const selectionWrites: Array<{ blockId: string | undefined; hidden: boolean }> = []
  const nativeCollapse = dom.window.Selection.prototype.collapse
  dom.window.Selection.prototype.collapse = function (node, offset) {
    const element = node?.nodeType === dom.window.Node.ELEMENT_NODE ? node as Element : node?.parentElement
    const row = element?.closest<HTMLElement>('[data-block-id]')
    if (row?.closest('.knowbook-rich-text-editor')) selectionWrites.push({ blockId: row.dataset.blockId,
      hidden: Boolean(row.closest('[aria-hidden="true"]')) || row.style.display === 'none' })
    nativeCollapse.call(this, node, offset)
  }
  const { DocumentRichTextEditor } = await import('../src/renderer/src/rich-text/DocumentRichTextEditor')
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  let current = initial(), changes = 0
  let history!: ReturnType<typeof useDocumentEditorState>
  function Harness() {
    const [blocks, setBlocks] = useState(current)
    history = useDocumentEditorState({ selectedDocumentId: null, selectedDocument: null, ui: getUiText('en-US'),
      onHomeDataChange: noop, onSelectedDocumentChange: noop, onMessage: noop })
    const effective = useHistory ? history.draftBlocks : blocks
    current = effective
    return effective.length ? createElement(DocumentRichTextEditor, { blocks: effective, visibleIndices: effective.map((_value, index) => index), documentId: 'columns-ui', isZh: false,
      checkpoint: useHistory ? history.checkpointDraft : noop, onChange: next => { current = next; changes++; if (useHistory) history.setDraftBlocks(next); else setBlocks(next) },
      onUndo: useHistory ? history.undoEdit : noop, onRedo: useHistory ? history.redoEdit : noop,
      onRevealBlock: noop, onEditSource: noop }) : null
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    if (useHistory) await act(async () => history.loadDocumentIntoEditor({ id: 'columns-ui', title: 'Columns', summary: '', blocks: initial() } as DocumentDetail))
    await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)) })
    const editor = dom.window.document.querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    await run({ dom, blocks: () => current, changes: () => changes, editor, history: () => history, selectionWrites,
      key: async (key, options = {}) => { await act(async () => editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))) },
      point: async (id, offset, endId = id, endOffset = offset) => {
        const index = current.findIndex(block => block.id === id), endIndex = current.findIndex(block => block.id === endId)
        await act(async () => getRichTextHistoryBridge(editor)!.restore({ blockId: id, index, start: offset, end: endOffset, direction: 'forward',
          richText: { anchor: { blockId: id, index, offset }, head: { blockId: endId, index: endIndex, offset: endOffset } } }))
      } })
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
}

test('real Rich columns controls add an empty column, explicitly create a focused paragraph, and move a content subtree', async () => {
  await withRich(async ({ dom, blocks, editor, point, selectionWrites }) => {
    assert.equal(dom.window.document.querySelectorAll('.knowbook-rich-text-editor').length, 1)
    assert.equal(editor.querySelectorAll('.document-columns-grid > .document-column').length, 2)
    await act(async () => Array.from(editor.querySelectorAll('button')).find(button => button.textContent === 'Add column')!.click())
    const columns = blocks().filter(block => block.type === 'column')
    assert.equal(columns.length, 3)
    assert.equal(columns.reduce((sum, block) => sum + block.markdownFormat!.columnWeight!, 0), 10000)
    assert.equal(blocks().some(block => block.parentBlockId === columns[2].id), false)
    selectionWrites.length = 0
    await act(async () => {
      const button = editor.querySelector<HTMLButtonElement>('[aria-label="Add content to column 3"]')!
      button.focus(); button.click()
    })
    const added = blocks().find(block => block.parentBlockId === columns[2].id)!
    assert.equal(added.type, 'paragraph'); assert.equal(added.content, '')
    assert.equal(getRichTextHistoryBridge(editor)!.capture().blockId, added.id)
    assert.ok(selectionWrites.some(write => write.blockId === added.id), 'the actual DOM selection is installed in the new column child')
    assert.ok(selectionWrites.filter(write => write.blockId === added.id).every(write => !write.hidden),
      'a native caret is never installed before the new child is visible')
    await point('alpha', 2)
    const move = dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="Move to column"]')!
    assert.ok(move)
    await act(async () => { move.value = 'right'; move.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
    assert.equal(blocks().find(block => block.id === 'alpha')!.parentBlockId, 'right')
    assert.deepEqual(blocks().find(block => block.id === 'alpha')!.tags, ['keep'])
    assert.equal(blocks().filter(block => block.id === 'alpha').length, 1)
  })
})

test('real deep keyboard formatting and cross-column Delete retain the two column shells and stable bookmarks', async () => {
  await withRich(async ({ blocks, editor, point, key }) => {
    await point('alpha', 5, 'beta', 4)
    await key('b', { ctrlKey: true })
    assert.match(blocks().find(block => block.id === 'alpha')!.content, /\*\*😀Tail\*\*/)
    assert.match(blocks().find(block => block.id === 'beta')!.content, /\*\*Beta\*\*/)
    await key('Delete')
    assert.equal(blocks().find(block => block.id === 'alpha')!.content, 'Alpha')
    assert.equal(blocks().find(block => block.id === 'beta')!.content, '😀End')
    assert.deepEqual(blocks().filter(block => block.type === 'column').map(block => [block.id, block.markdownFormat]),
      [['left', { columnWeight: 5000 }], ['right', { columnWeight: 5000 }]])
    assert.equal(getRichTextHistoryBridge(editor)!.capture().blockId, 'alpha')
  })
})

test('Shift+Enter replaces a cross-column text selection with a hard break in its first column', async () => {
  await withRich(async ({ blocks, point, key }) => {
    await point('alpha', 5, 'beta', 4)
    await key('Enter', { shiftKey: true })
    assert.equal(blocks().find(block => block.id === 'alpha')!.content, 'Alpha\\\n')
    assert.equal(blocks().find(block => block.id === 'beta')!.content, '😀End')
    assert.equal(validColumnStructure(blocks(), { checkParentIds: true }), true)
    assert.deepEqual(blocks().filter(block => block.type === 'column').map(block => block.id), ['left', 'right'])
  })
})

test('real Rich clipboard handlers close a selected column slice and paste a fresh nested editable forest', async () => {
  await withRich(async ({ dom, blocks, editor, point }) => {
    await point('alpha', 1, 'alpha', 7)
    const copied = new Map<string, string>()
    const copy = new dom.window.Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(copy, 'clipboardData', { value: { setData: (type: string, value: string) => copied.set(type, value) } })
    await act(async () => editor.dispatchEvent(copy))
    assert.equal(copy.defaultPrevented, true)
    const markdown = copied.get('text/plain')!
    assert.ok(markdown.includes('lpha😀'))
    assert.equal(validColumnStructure(parseMarkdownBlocks(markdown)), true)
    assert.equal(copied.get('application/x-knowbook-markdown'), markdown)
    assert.ok(copied.get('text/html')!.includes('data-knowbook-markdown-source="true"'))
    assert.deepEqual(blocks(), initial())
    await point('beta', 0)
    const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { files: [], getData: (type: string) => copied.get(type) ?? '' } })
    await act(async () => editor.dispatchEvent(paste))
    assert.equal(paste.defaultPrevented, true)
    assert.equal(validColumnStructure(blocks(), { checkParentIds: true }), true)
    assert.ok(blocks().some(block => block.content === 'lpha😀' && block.id !== 'alpha'))
    assert.deepEqual(blocks().find(block => block.id === 'alpha'), initial().find(block => block.id === 'alpha'))
    assert.equal(new Set(blocks().map(block => block.id)).size, blocks().length)
    assert.equal(editor.querySelectorAll('.knowbook-rich-text-editor').length, 0, 'nested columns keep the one existing editor')
    assert.ok(editor.querySelector('.document-column .document-columns .document-column .rich-text-block'))
  })
})

test('composition starts after a cross-column selection without joining columns and composing Enter stays with the IME', async () => {
  await withRich(async ({ dom, blocks, editor, point, key }) => {
    await point('alpha', 5, 'beta', 4)
    await act(async () => editor.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' })))
    assert.equal(blocks().find(block => block.id === 'alpha')!.content, 'Alpha')
    assert.equal(blocks().find(block => block.id === 'beta')!.content, '😀End')
    const before = structuredClone(blocks())
    await key('Enter', { isComposing: true })
    assert.deepEqual(blocks(), before)
    assert.equal(validColumnStructure(blocks(), { checkParentIds: true }), true)
    await act(async () => editor.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '' })))
  })
})

test('the actual Rich slash command creates two empty columns and retains its original host identity and tags', async () => {
  await withRich(async ({ dom, blocks, editor, point, key }) => {
    await point('alpha', 0, 'alpha', 'Alpha😀Tail'.length)
    const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { files: [], getData: (type: string) => type === 'text/plain' ? '/columns' : '' } })
    await act(async () => editor.dispatchEvent(paste))
    assert.equal(blocks().find(block => block.id === 'alpha')!.content, '/columns')
    assert.ok(dom.window.document.querySelector('.rich-text-slash-menu [role="option"]'))
    await key('Enter')
    // The user action waits for this cold module. One event-loop iteration is
    // not evidence that the real import completed under the tsx loader.
    await act(async () => { await import('../src/renderer/src/utils/columnOperations') })
    const group = blocks().find(block => block.id === 'alpha')!
    assert.equal(group.type, 'columns', JSON.stringify({ blocks: blocks(), status: dom.window.document.querySelector('[role="status"]')?.textContent,
      bookmark: getRichTextHistoryBridge(editor)!.capture() })); assert.equal(group.content, '')
    assert.deepEqual(group.tags, ['keep'])
    assert.equal(group.parentBlockId, 'left')
    const columns = blocks().filter(block => block.parentBlockId === group.id)
    assert.deepEqual(columns.map(block => [block.type, block.markdownFormat!.columnWeight]), [['column', 5000], ['column', 5000]])
    assert.equal(blocks().some(block => columns.some(column => block.parentBlockId === column.id)), false)
    assert.equal(validColumnStructure(blocks(), { checkParentIds: true }), true)
  })
})

for (const kind of ['all', 'node'] as const) test(`actual document history restores Rich ${kind} selection and a repeated Delete clears the same entire layout`, async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try { await withRich(async ({ dom, blocks, editor, history, key }) => {
    const bridge = getRichTextHistoryBridge(editor)!, before = structuredClone(blocks())
    await act(async () => bridge.restore({ blockId: 'group', index: 0, start: 0, end: 0, direction: 'forward',
      richText: { kind, anchor: { blockId: 'group', index: 0, offset: 0 }, head: { blockId: 'group', index: 0, offset: 0 } } }))
    assert.equal(bridge.capture().richText!.kind, kind)
    await key('Delete')
    assert.equal(blocks().length, 1); assert.equal(blocks()[0].type, 'paragraph'); assert.equal(blocks()[0].content, '')
    assert.equal(history().canUndo, true)
    await key('z', { ctrlKey: true }); await act(async () => context.mock.timers.tick(0))
    assert.deepEqual(blocks(), before)
    assert.equal(bridge.capture().richText!.kind, kind)
    assert.equal(history().canRedo, true)
    await key('Delete')
    assert.equal(blocks().length, 1); assert.equal(blocks()[0].type, 'paragraph'); assert.equal(blocks()[0].content, '')
    assert.equal(dom.window.document.querySelectorAll('.document-columns').length, 0)
  }, true) } finally { context.mock.timers.reset() }
})

test('rejecting a bare column deletion leaves the real document history and existing Redo intact', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try { await withRich(async ({ dom, blocks, editor, history, key }) => {
    const before = structuredClone(blocks()), bridge = getRichTextHistoryBridge(editor)!
    await act(async () => Array.from(editor.querySelectorAll('button')).find(button => button.textContent === 'Add column')!.click())
    assert.equal(blocks().filter(block => block.type === 'column').length, 3)
    await act(async () => history().undoEdit()); await act(async () => context.mock.timers.tick(0))
    assert.deepEqual(blocks(), before); assert.equal(history().canRedo, true)
    await act(async () => bridge.restore({ blockId: 'left', index: 1, start: 0, end: 0, direction: 'none',
      richText: { kind: 'node', anchor: { blockId: 'left', index: 1, offset: 0 }, head: { blockId: 'left', index: 1, offset: 0 } } }))
    await key('Delete')
    assert.deepEqual(blocks(), before)
    assert.equal(history().canRedo, true); assert.equal(history().canUndo, false)
    assert.match(dom.window.document.querySelector('[role="status"]')!.textContent!, /column controls/)
    await key('y', { ctrlKey: true }); await act(async () => context.mock.timers.tick(0))
    assert.equal(blocks().filter(block => block.type === 'column').length, 3)
  }, true) } finally { context.mock.timers.reset() }
})
