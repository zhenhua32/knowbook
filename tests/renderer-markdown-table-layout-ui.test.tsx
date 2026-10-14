import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState, type ReactElement } from 'react'
import { JSDOM } from 'jsdom'
import { parseEditableMarkdownTable } from '../src/shared/markdownTableEditing'
import { parseMarkdownDocumentBlocks } from '../src/shared/markdownDocument'
import type { DocumentBlockDraft, DocumentDetail } from '../src/shared/contracts'
import type { MarkdownEnvironment } from '../src/shared/markdownEngine'
import { getUiText } from '../src/renderer/src/i18n'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { useAppKeyboardShortcuts } from '../src/renderer/src/hooks/useAppKeyboardShortcuts'
import type { DocumentsKeyboardState } from '../src/renderer/src/types/appDomains'
import { captureEditorHistoryBookmark, restoreEditorHistoryBookmark } from '../src/renderer/src/utils/editorHistoryFocus'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
}`)}`, import.meta.url)

const initial = '<!-- knowbook:table-widths:v1 [200,null] -->\n| A | B |\n| :--- | ---: |\n| alpha | beta | overflow one |\n| gamma | delta | overflow two |'
type Fixture = {
  dom: JSDOM; content: () => string; changes: string[]; begins: () => number; replace: (source: string, session?: string) => Promise<void>
  pointer: (target: EventTarget, type: string, x?: number, y?: number) => Promise<void>
  handle: (label: string) => HTMLButtonElement; hit: (row: number, column: number) => void; edit: (row: number, column: number) => Promise<HTMLTextAreaElement>
  remove: () => Promise<void>
  render: (element: ReactElement) => Promise<void>
}

async function withTable(run: (fixture: Fixture) => Promise<void>, source = initial, references?: MarkdownEnvironment['references']) {
  const dom = new JSDOM('<input id="foreign"><div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, CustomEvent: dom.window.CustomEvent, AbortController: dom.window.AbortController,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { value: () => true })
  const { createRoot } = await import('react-dom/client'), { MarkdownTableEditor } = await import('../src/renderer/src/components/MarkdownTableEditor')
  const { MarkdownReferencesContext } = await import('../src/renderer/src/components/MarkdownContent')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let current = source, setSource!: (value: string) => void, setSession!: (value: string) => void, beginCount = 0, removed = false
  const changes: string[] = []
  function Harness() {
    const [content, updateContent] = useState(source), [session, updateSession] = useState('one')
    setSource = updateContent; setSession = updateSession
    return createElement(MarkdownReferencesContext.Provider, { value: references }, createElement('div', { className: 'block-editor-row', 'data-block-index': 0, 'data-block-id': 'table' },
      createElement(MarkdownTableEditor, { content, sessionKey: session, isZh: false, onBeginEdit: () => { beginCount++ },
        onChange: (next: string) => { changes.push(next); current = next; updateContent(next) } })))
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ dom, changes, content: () => current, begins: () => beginCount,
      replace: async (content, session) => { current = content; await act(async () => { setSource(content); if (session) setSession(session) }) },
      pointer: async (target, type, x = 10, y = 10) => {
        const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
        Object.defineProperty(event, 'pointerId', { value: 7 })
        await act(async () => target.dispatchEvent(event))
      },
      handle: label => { const handle = dom.window.document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); assert.ok(handle, label); return handle },
      hit: (row, column) => { dom.window.document.elementFromPoint = () => dom.window.document.querySelector(`[data-row="${row}"][data-column="${column}"]`) },
      edit: async (row, column) => {
        const cell = dom.window.document.querySelector<HTMLElement>(`[data-row="${row}"][data-column="${column}"]`)!
        await act(async () => cell.click())
        const input = cell.querySelector<HTMLTextAreaElement>('textarea')!
        assert.ok(input); return input
      }, remove: async () => { await act(async () => root.unmount()); removed = true }, render: async element => { await act(async () => root.render(element)) }
    })
  } finally {
    if (!removed) await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('real column resizing previews locally, keeps its capture handle stable, commits once and restores backward cell selection', async () => {
  await withTable(async ({ dom, content, changes, begins, pointer, handle, edit }) => {
    const input = await edit(1, 1)
    input.setSelectionRange(1, 3, 'backward')
    const beforeBegin = begins(), resize = handle('Resize column 1')
    await pointer(resize, 'pointerdown', 10)
    assert.equal(begins(), beforeBegin); assert.equal(changes.length, 0)
    await pointer(dom.window, 'pointermove', 80)
    assert.equal(handle('Resize column 1'), resize)
    assert.equal(resize.getAttribute('aria-valuenow'), '270')
    assert.equal((dom.window.document.querySelector('col') as HTMLElement).style.width, '270px')
    assert.equal(changes.length, 0); assert.equal(content(), initial)
    await pointer(dom.window, 'pointerup', 80)
    assert.equal(changes.length, 1); assert.equal(begins(), beforeBegin + 1)
    assert.deepEqual(parseEditableMarkdownTable(content())?.widths, [270, null])
    const restored = dom.window.document.querySelector<HTMLTextAreaElement>('[data-row="1"][data-column="1"] textarea')!
    assert.equal(dom.window.document.activeElement, restored)
    assert.equal(restored.selectionStart, 1); assert.equal(restored.selectionEnd, 3); assert.equal(restored.selectionDirection, 'backward')
    await pointer(dom.window, 'pointerup', 90)
    assert.equal(changes.length, 1, 'a repeated release cannot commit again')
  })
})

for (const reason of ['escape', 'pointercancel', 'lostcapture', 'blur', 'foreignfocus', 'source', 'session', 'unmount'] as const) {
  test(`real resize rolls back on ${reason} without a checkpoint or write`, async () => {
    await withTable(async ({ dom, changes, begins, pointer, handle, replace, remove }) => {
      const resize = handle('Resize column 1')
      await pointer(resize, 'pointerdown', 10); await pointer(dom.window, 'pointermove', 110)
      assert.equal(resize.getAttribute('aria-valuenow'), '300'); assert.equal(changes.length, 0); assert.equal(begins(), 0)
      if (reason === 'escape') await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
      else if (reason === 'pointercancel') await pointer(dom.window, 'pointercancel')
      else if (reason === 'lostcapture') await act(async () => resize.dispatchEvent(new dom.window.Event('lostpointercapture')))
      else if (reason === 'blur') await act(async () => dom.window.dispatchEvent(new dom.window.Event('blur')))
      else if (reason === 'foreignfocus') await act(async () => (dom.window.document.querySelector('#foreign') as HTMLInputElement).focus())
      else if (reason === 'source') await replace(initial.replace('alpha', 'external'))
      else if (reason === 'session') await replace(initial, 'two')
      else await remove()
      await pointer(dom.window, 'pointerup', 110)
      assert.equal(changes.length, 0); assert.equal(begins(), 0)
      if (reason !== 'unmount') assert.equal(handle('Resize column 1').getAttribute('aria-valuenow'), '200')
    })
  })
}

test('a no-motion drag and a drag back to the default width preserve the exact original source without adding layout metadata', async () => {
  const plain = '| A | B |\r\n| - | - |\r\n| x | y |'
  await withTable(async ({ dom, content, changes, begins, pointer, handle }) => {
    const resize = handle('Resize column 1')
    await pointer(resize, 'pointerdown', 10); await pointer(dom.window, 'pointerup', 10)
    await pointer(resize, 'pointerdown', 10); await pointer(dom.window, 'pointermove', 40); await pointer(dom.window, 'pointermove', 10); await pointer(dom.window, 'pointerup', 10)
    assert.equal(content(), plain); assert.equal(changes.length, 0); assert.equal(begins(), 0)
  }, plain)
})

test('the first resize of an automatic table starts at its visible geometry and keeps every other visible column width', async () => {
  const source = '| A | B |\n| - | - |\n| alpha | beta |'
  await withTable(async ({ dom, changes, begins, content, pointer, handle }) => {
    for (const [column, width] of [300, 400].entries()) {
      dom.window.document.querySelector<HTMLElement>(`[data-row="0"][data-column="${column}"]`)!.getBoundingClientRect = () => ({
        width, height: 30, left: column ? 300 : 0, top: 0, right: column ? 700 : 300, bottom: 30, x: column ? 300 : 0, y: 0, toJSON: () => ({})
      })
    }
    await pointer(handle('Resize column 1'), 'pointerdown', 10); await pointer(dom.window, 'pointermove', 20)
    assert.equal(handle('Resize column 1').getAttribute('aria-valuenow'), '310')
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('col')).map(col => (col as HTMLElement).style.width), ['310px', '400px'])
    assert.equal((dom.window.document.querySelector('table') as HTMLElement).style.width, '710px')
    assert.equal(content(), source); assert.equal(changes.length, 0); assert.equal(begins(), 0)
    await pointer(dom.window, 'pointerup', 20)
    assert.deepEqual(parseEditableMarkdownTable(content())?.widths, [310, 400]); assert.equal(changes.length, 1)
  }, source)
})

test('real row and column drags move values, alignment, widths and overflow together while mapping an editing cell', async () => {
  await withTable(async ({ dom, content, changes, begins, pointer, handle, hit, edit }) => {
    const input = await edit(1, 0); input.setSelectionRange(1, 4, 'backward')
    let beforeBegin = begins()
    const column = handle('Drag column 1')
    await pointer(column, 'pointerdown', 10); hit(0, 1); await pointer(dom.window, 'pointermove', 200)
    assert.equal(changes.length, 0); assert.equal(begins(), beforeBegin)
    assert.equal(column.isConnected, true, 'column preview retains the pointer capture node')
    assert.equal(column.closest<HTMLElement>('[data-column]')?.dataset.column, '1')
    assert.equal(dom.window.document.querySelector('[data-row="1"][data-column="1"] textarea'), input, 'the same editing textarea moves with its logical column')
    assert.equal(dom.window.document.activeElement, input)
    assert.equal(input.selectionDirection, 'backward')
    await pointer(dom.window, 'pointerup', 200)
    let parsed = parseEditableMarkdownTable(content())!
    assert.deepEqual(parsed.headers, ['B', 'A']); assert.deepEqual(parsed.alignments, ['right', 'left']); assert.deepEqual(parsed.widths, [null, 200])
    assert.deepEqual(parsed.rows[0], ['beta', 'alpha']); assert.deepEqual(parsed.overflow, [['overflow one'], ['overflow two']])
    const moved = dom.window.document.querySelector<HTMLTextAreaElement>('[data-row="1"][data-column="1"] textarea')!
    assert.equal(moved.value, 'alpha'); assert.equal(moved.selectionDirection, 'backward'); assert.equal(moved.selectionStart, 1); assert.equal(moved.selectionEnd, 4)
    beforeBegin = begins()
    const row = handle('Drag row 1')
    await pointer(row, 'pointerdown', 10, 10); hit(2, 0); await pointer(dom.window, 'pointermove', 10, 90)
    assert.equal(changes.length, 1); assert.equal(begins(), beforeBegin)
    assert.equal(row.isConnected, true)
    assert.equal(row.closest<HTMLElement>('[data-row]')?.dataset.row, '2')
    await pointer(dom.window, 'pointerup', 10, 90)
    parsed = parseEditableMarkdownTable(content())!
    assert.deepEqual(parsed.rows, [['delta', 'gamma'], ['beta', 'alpha']]); assert.deepEqual(parsed.overflow, [['overflow two'], ['overflow one']])
    assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>('[data-row="2"][data-column="1"] textarea')?.selectionDirection, 'backward')
    assert.equal(changes.length, 2)
    assert.equal(dom.window.document.querySelector('[aria-label="Drag row 0"]'), null, 'the header is not draggable as a body row')
  })
})

test('real keyboard width and reorder controls remain available without a pointer and IME cannot resize', async () => {
  await withTable(async ({ dom, content, changes, handle, edit }) => {
    await act(async () => handle('Resize column 1').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
    assert.deepEqual(parseEditableMarkdownTable(content())?.widths, [210, null])
    const input = await edit(1, 0)
    await act(async () => input.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true })))
    await act(async () => handle('Resize column 1').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', isComposing: true, bubbles: true, cancelable: true })))
    assert.equal(changes.length, 1)
    await act(async () => input.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true })))
    await act(async () => Array.from(dom.window.document.querySelectorAll('button')).find(button => button.textContent === 'Move row down')!.click())
    assert.deepEqual(parseEditableMarkdownTable(content())?.rows.map(row => row[0]), ['gamma', 'alpha'])
  })
})

test('formatted and global-reference cells move in the live preview while editing identity and backward range survive cancellation', async () => {
  const source = '| **First** | [Second][external] |\n| - | - |\n| *Alpha* | [Beta][external] |\n| Gamma | Delta |'
  await withTable(async ({ dom, changes, pointer, handle, hit, edit, content }) => {
    const input = await edit(1, 0); input.setSelectionRange(1, 5, 'backward')
    await pointer(handle('Drag column 1'), 'pointerdown', 10); hit(0, 1); await pointer(dom.window, 'pointermove', 200)
    assert.equal(dom.window.document.querySelector('[data-row="0"][data-column="1"] strong')?.textContent, 'First')
    assert.equal(dom.window.document.querySelector('[data-row="0"][data-column="0"] .inline-link')?.textContent, 'Second')
    assert.equal(dom.window.document.querySelector('[data-row="1"][data-column="0"] .inline-link')?.getAttribute('title'), 'External')
    assert.equal(dom.window.document.querySelector('[data-row="1"][data-column="1"] textarea'), input)
    assert.equal(dom.window.document.activeElement, input); assert.equal(input.selectionDirection, 'backward')
    await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    assert.equal(content(), source); assert.equal(changes.length, 0)
    assert.equal(dom.window.document.querySelector('[data-row="1"][data-column="0"] textarea'), input)
    assert.equal(dom.window.document.activeElement, input); assert.equal(input.selectionStart, 1); assert.equal(input.selectionEnd, 5); assert.equal(input.selectionDirection, 'backward')
    await pointer(handle('Drag column 1'), 'pointerdown', 10); hit(0, 1); await pointer(dom.window, 'pointermove', 200); await pointer(dom.window, 'pointerup', 200)
    assert.equal(dom.window.document.querySelector('[data-row="0"][data-column="1"] strong')?.textContent, 'First')
    assert.equal(dom.window.document.querySelector('[data-row="0"][data-column="0"] .inline-link')?.textContent, 'Second')
    assert.equal(changes.length, 1)
  }, source, { EXTERNAL: { href: 'https://example.test', title: 'External' } })
})

test('rich table portal inherits document references and navigation, captures cell history before its body bridge, and restores actual undo and redo', async context => {
  await withTable(async ({ dom, render, edit, pointer, handle, hit }) => {
    const { DocumentRichTextEditor } = await import('../src/renderer/src/rich-text/DocumentRichTextEditor')
    const { MarkdownReferencesContext } = await import('../src/renderer/src/components/MarkdownContent')
    const { MarkdownDocumentContext } = await import('../src/renderer/src/components/MarkdownDocumentContext')
    const { MarkdownNavigationContext } = await import('../src/renderer/src/components/MarkdownNavigationContext')
    const blocks: DocumentBlockDraft[] = [
      { id: 'callout', type: 'callout', content: '**Owner**', checked: false, depth: 0, parentBlockId: null },
      { id: 'table', type: 'table', content: '| [Header][target] | Other |\n| - | - |\n| alpha | beta |\n| gamma | delta |', checked: false, depth: 1, parentBlockId: 'callout' },
      { id: 'definition', type: 'paragraph', content: '[target]: Other.md#section "Local target"', checked: false, depth: 0, parentBlockId: null }
    ]
    const detail = { id: 'rich-table-history', title: 'Table', summary: '', blocks } as DocumentDetail
    let editor!: ReturnType<typeof useDocumentEditorState>
    const navigated: string[] = [], noop = () => {}
    function Harness() {
      editor = useDocumentEditorState({ selectedDocumentId: null, selectedDocument: null, ui: getUiText('en-US'), onHomeDataChange: noop, onSelectedDocumentChange: noop, onMessage: noop })
      const model = parseMarkdownDocumentBlocks(editor.draftBlocks)
      const keyboard: DocumentsKeyboardState = { isEditing: editor.isEditing, isReadingMode: false, isGlobalSearchOpen: false, isBlockSearchOpen: false,
        detailLoading: false, documentLoadError: null, selectedDocumentId: detail.id, selectedDocument: detail, saveDocument: async () => {}, globalSearchQuery: '',
        selectedBlockRange: null, navBack: noop, navForward: noop, openGlobalSearch: noop, closeGlobalSearch: noop, openBlockSearch: noop, closeBlockSearch: noop,
        undoEdit: editor.undoEdit, redoEdit: editor.redoEdit }
      useAppKeyboardShortcuts({ documents: keyboard, onClearBlockRangeSelection: noop, shell: { activePage: 'documents', setActivePage: noop, openWorkspaceSearch: noop } })
      return editor.draftBlocks.length ? createElement(MarkdownNavigationContext.Provider, { value: href => navigated.push(href) },
        createElement(MarkdownReferencesContext.Provider, { value: model.environment.references },
          createElement(MarkdownDocumentContext.Provider, { value: { model, isZh: false, footnoteId: String, navigateFootnote: noop } },
            createElement(DocumentRichTextEditor, { blocks: editor.draftBlocks, visibleIndices: editor.draftBlocks.map((_block, index) => index), documentId: detail.id,
              isZh: false, references: model.environment.references, checkpoint: editor.checkpointDraft, onChange: editor.setDraftBlocks,
              onUndo: editor.undoEdit, onRedo: editor.redoEdit, onRevealBlock: noop, onEditSource: noop })))) : null
    }
    const rectangle = { top: 0, bottom: 20, left: 0, right: 100, x: 0, y: 0, width: 100, height: 20, toJSON: () => ({}) }
    dom.window.Range.prototype.getBoundingClientRect = () => rectangle
    dom.window.Range.prototype.getClientRects = () => [rectangle] as unknown as DOMRectList
    dom.window.scrollBy = noop
    context.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      await render(createElement(Harness)); await act(async () => editor.loadDocumentIntoEditor(detail))
      await act(async () => { await import('../src/renderer/src/components/MarkdownTableEditor'); await import('../src/renderer/src/components/NativeContainerStyle'); await new Promise<void>(resolve => setImmediate(resolve)) })
      const headerLink = dom.window.document.querySelector<HTMLButtonElement>('[data-block-id="table"] [data-row="0"][data-column="0"] .inline-link')!
      assert.ok(headerLink, dom.window.document.body.innerHTML); assert.equal(headerLink.title, 'Local target')
      await act(async () => headerLink.click())
      assert.deepEqual(navigated, ['Other.md#section'])
      const input = await edit(1, 0); input.setSelectionRange(1, 4, 'backward')
      dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'))
      const before = captureEditorHistoryBookmark(editor.draftBlocks)!
      assert.deepEqual(before.cell, { row: 1, column: 0, editing: true }); assert.equal(before.richText, undefined); assert.equal(before.direction, 'backward')
      await pointer(handle('Drag column 1'), 'pointerdown', 10); hit(0, 1); await pointer(dom.window, 'pointermove', 200)
      await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
      assert.equal(editor.canUndo, false, 'a canceled structural preview creates no actual document history')
      assert.equal(editor.draftBlocks[1].content, blocks[1].content)
      assert.equal(dom.window.document.querySelector('[data-row="1"][data-column="0"] textarea'), input)
      assert.deepEqual(captureEditorHistoryBookmark(editor.draftBlocks), before, 'cancel preserves the original cell and backward range')
      await pointer(handle('Drag column 1'), 'pointerdown', 10); hit(0, 1); await pointer(dom.window, 'pointermove', 200); await pointer(dom.window, 'pointerup', 200)
      assert.equal(editor.draftBlocks[1].id, 'table'); assert.equal(editor.draftBlocks[1].parentBlockId, 'callout'); assert.equal(editor.draftBlocks[1].depth, 1)
      assert.deepEqual(parseEditableMarkdownTable(editor.draftBlocks[1].content)?.headers, ['Other', '[Header][target]'])
      const moved = dom.window.document.querySelector<HTMLTextAreaElement>('[data-row="1"][data-column="1"] textarea')!
      assert.equal(moved.value, 'alpha'); assert.equal(moved.selectionDirection, 'backward')
      await act(async () => moved.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })))
      await act(async () => context.mock.timers.tick(0))
      assert.equal(editor.draftBlocks[1].content, blocks[1].content)
      const restored = dom.window.document.querySelector<HTMLTextAreaElement>('[data-row="1"][data-column="0"] textarea')!
      assert.ok(restored); assert.equal(dom.window.document.activeElement, restored); assert.equal(restored.selectionStart, 1); assert.equal(restored.selectionEnd, 4); assert.equal(restored.selectionDirection, 'backward')
      await act(async () => restored.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true })))
      await act(async () => context.mock.timers.tick(0))
      assert.deepEqual(parseEditableMarkdownTable(editor.draftBlocks[1].content)?.headers, ['Other', '[Header][target]'])
      const redone = dom.window.document.querySelector<HTMLTextAreaElement>('[data-row="1"][data-column="1"] textarea')!
      assert.ok(redone); assert.equal(dom.window.document.activeElement, redone); assert.equal(redone.selectionDirection, 'backward')
      await act(async () => { assert.equal(restoreEditorHistoryBookmark(before, editor.draftBlocks), true) })
    } finally { context.mock.timers.reset() }
  })
})

test('real reading tables use validated colgroup geometry and unbound invalid directives remain visible source', async () => {
  await withTable(async ({ dom, render }) => {
    const { MarkdownContent } = await import('../src/renderer/src/components/MarkdownContent')
    await render(createElement(MarkdownContent, { content: initial }))
    await act(async () => { await import('../src/renderer/src/components/MarkdownTableLayout'); await new Promise<void>(resolve => setImmediate(resolve)) })
    const table = dom.window.document.querySelector<HTMLTableElement>('table')!
    assert.equal(table.getAttribute('data-knowbook-table-layout'), 'true'); assert.equal(table.style.width, '320px')
    assert.deepEqual(Array.from(table.querySelectorAll('col')).map(col => col.style.width), ['200px', '120px'])
    const invalid = '<!-- knowbook:table-widths:v1 [90000,null] -->\n| A | B |\n| - | - |\n| x | y |'
    await render(createElement(MarkdownContent, { content: invalid }))
    assert.equal(dom.window.document.querySelector('table')?.hasAttribute('data-knowbook-table-layout'), false)
    assert.ok(dom.window.document.getElementById('mount')!.textContent!.includes('90000'), 'invalid metadata is retained as source')
  })
})

for (const destination of ['title-input', 'tree-button', 'other-block-textarea'] as const) {
  test(`numeric width blur commits one actual history step and preserves ${destination} focus`, async context => {
    await withTable(async ({ dom, render }) => {
      const { MarkdownTableEditor } = await import('../src/renderer/src/components/MarkdownTableEditor')
      const detail = { id: 'numeric-width', title: 'Width focus', summary: '', blocks: [
        { id: 'table', type: 'table', content: initial, checked: false, depth: 0, parentBlockId: null },
        { id: 'other', type: 'paragraph', content: 'Other block', checked: false, depth: 0, parentBlockId: null }
      ] } as DocumentDetail
      let editor!: ReturnType<typeof useDocumentEditorState>, writes = 0
      const noop = () => {}
      function Harness() {
        editor = useDocumentEditorState({ selectedDocumentId: null, selectedDocument: null, ui: getUiText('en-US'),
          onHomeDataChange: noop, onSelectedDocumentChange: noop, onMessage: noop })
        const block = editor.draftBlocks[0]
        return block ? createElement('div', { className: 'block-editor-row', 'data-block-index': 0, 'data-block-id': block.id },
          createElement(MarkdownTableEditor, { content: block.content, sessionKey: detail.id, isZh: false, onBeginEdit: editor.checkpointDraft,
            onChange: (content, transaction) => { if (transaction) editor.checkpointDraft(); writes++; editor.updateDraftBlock(0, { content }) } })) : null
      }
      const foreign = dom.window.document.createElement(destination === 'tree-button' ? 'button' : destination === 'other-block-textarea' ? 'textarea' : 'input')
      foreign.className = destination === 'tree-button' ? 'tree-button' : destination === 'other-block-textarea' ? 'block-inline-textarea' : 'editor-input'
      if (destination === 'other-block-textarea') {
        const row = dom.window.document.createElement('div')
        row.className = 'block-editor-row'; row.dataset.blockIndex = '1'; row.dataset.blockId = 'other'
        row.append(foreign); dom.window.document.body.append(row)
      } else dom.window.document.body.append(foreign)
      context.mock.timers.enable({ apis: ['setTimeout'] })
      try {
        await render(createElement(Harness)); await act(async () => editor.loadDocumentIntoEditor(detail))
        const width = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Column width"]')!
        await act(async () => { width.focus(); width.value = '300'; foreign.focus() })
        assert.equal(dom.window.document.activeElement, foreign)
        assert.deepEqual(parseEditableMarkdownTable(editor.draftBlocks[0].content)?.widths, [300, null])
        assert.equal(writes, 1)
        await act(async () => context.mock.timers.tick(0))
        assert.equal(dom.window.document.activeElement, foreign, 'a later layout cannot reclaim the previous table cell')
        await act(async () => editor.undoEdit()); await act(async () => context.mock.timers.tick(0))
        assert.equal(editor.draftBlocks[0].content, initial)
        assert.equal(editor.canUndo, false, 'one blur produces exactly one history step')
        await act(async () => editor.redoEdit()); await act(async () => context.mock.timers.tick(0))
        assert.deepEqual(parseEditableMarkdownTable(editor.draftBlocks[0].content)?.widths, [300, null])
        assert.equal(writes, 1, 'history does not call the width commit callback again')
      } finally { context.mock.timers.reset() }
    })
  })
}
