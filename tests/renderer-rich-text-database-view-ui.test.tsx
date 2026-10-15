import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useRef, useState } from 'react'
import { JSDOM, VirtualConsole } from 'jsdom'
import type { DatabaseEmbedSnapshot, DatabaseEntity, DocumentBlockDraft, DocumentDetail, HomeData, UpdateDatabaseEntityInput, UpdateDocumentInput } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { serializeDatabaseViewPayload, type DatabaseViewBlockPayloadV1 } from '../src/shared/databaseViewBlock'
import { DatabaseEmbedProvider, type DatabaseEmbedContextValue, type DatabaseViewPickerRequest } from '../src/renderer/src/features/database/DatabaseEmbedContext'
import { getRichTextHistoryBridge } from '../src/renderer/src/rich-text/history'
import { captureEditorHistoryBookmark } from '../src/renderer/src/utils/editorHistoryFocus'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { useAppKeyboardShortcuts } from '../src/renderer/src/hooks/useAppKeyboardShortcuts'
import type { DocumentsKeyboardState } from '../src/renderer/src/types/appDomains'
import { getUiText } from '../src/renderer/src/i18n'
import { waitForRenderer } from './helpers/renderer-async'
import { normalizeDraftBlocks } from '../src/renderer/src/utils/draftTreeNormalization'
import { toDraftBlock } from '../src/renderer/src/utils/draftBlockShape'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
}`)}`, import.meta.url)
const noop = () => {}
const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null })
const payload = (databaseId = 'rich-database-A'): DatabaseViewBlockPayloadV1 => ({ version: 1, databaseId, viewId: null,
  config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, 'notes']) })
const embed = (id = 'embed', source?: string): DocumentBlockDraft => ({ ...paragraph(id, serializeDatabaseViewPayload(payload(source))), type: 'database-view' })
type Editor = ReturnType<typeof useDocumentEditorState>
type Api = {
  dom: JSDOM; editor: () => HTMLElement; history: () => Editor; blocks: () => DocumentBlockDraft[]
  pickers: DatabaseViewPickerRequest[]; writes: UpdateDatabaseEntityInput[]; hostCalls: string[]; reads: string[]
  records: Map<string, DatabaseEntity>; notes: (id?: string) => HTMLInputElement
  change: (action: () => void) => Promise<void>; key: (target: Element, key: string, options?: KeyboardEventInit) => Promise<KeyboardEvent>
  fill: (input: HTMLInputElement, value: string) => Promise<void>; replace: (blocks: DocumentBlockDraft[]) => Promise<void>; newSession: () => Promise<void>
}

async function withRich(initial: DocumentBlockDraft[], run: (api: Api) => Promise<void>) {
  const errors: Error[] = [], virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => { errors.push(error) })
  const dom = new JSDOM('<div id="mount"></div><input id="outside">', { pretendToBeVisual: true, url: 'http://localhost', virtualConsole })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    AbortController: dom.window.AbortController, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { value: () => true })
  dom.window.scrollBy = noop
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  const rect = new dom.window.DOMRect(0, 0, 800, 200)
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => rect
  dom.window.HTMLElement.prototype.getClientRects = function () { return (this.isConnected ? [rect] : []) as unknown as DOMRectList }
  dom.window.Range.prototype.getBoundingClientRect = () => rect
  dom.window.Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList
  const pickers: DatabaseViewPickerRequest[] = [], writes: UpdateDatabaseEntityInput[] = [], hostCalls: string[] = [], reads: string[] = []
  let detail: DocumentDetail = { id: 'rich-database-ui', title: 'Embedded', path: 'Embedded', summary: '', updatedAt: 'document-v1',
    blocks: initial.map((block, sortOrder) => ({ ...block, id: block.id!, parentBlockId: block.parentBlockId ?? null, sortOrder })),
    children: [], outgoingLinks: [], backlinks: [] }
  const records = new Map<string, DatabaseEntity>(['rich-database-A', 'rich-database-B'].map(id => [id, {
    id: `${id}-record`, databaseId: id, title: `Real ${id} record`, documentId: null,
    createdAt: '2026-10-01', updatedAt: '2026-10-01', fieldValues: { notes: 'Original database value' }
  }]))
  const snapshot = (id: string): DatabaseEmbedSnapshot => ({ status: 'ready',
    database: { id, kind: 'custom', name: id, description: '', createdAt: '2026-10-01', updatedAt: '2026-10-01' },
    columns: [{ id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 0 }],
    savedViews: [], entities: [structuredClone(records.get(id)!)], catalogDocuments: [] })
  Object.defineProperty(dom.window, 'knowbook', { value: {
    onWorkspaceMutated: () => noop, getDocumentBlockMoveHistory: async () => null,
    getDocumentDetail: async () => structuredClone(detail), getHomeData: async () => ({} as HomeData),
    updateDocument: async (_id: string, input: UpdateDocumentInput) => {
      detail = { ...detail, title: input.title, summary: input.summary, updatedAt: `${detail.updatedAt}-saved`,
        blocks: input.blocks.map((block, sortOrder) => ({ ...block, id: block.id!, parentBlockId: block.parentBlockId ?? null, sortOrder })) }
      return { requiresFullRefresh: true, document: structuredClone(detail) }
    },
    getDatabaseEmbedSnapshot: async (id: string) => { reads.push(id); return snapshot(id) },
    updateDatabaseEntity: async (input: UpdateDatabaseEntityInput) => {
      writes.push(structuredClone(input))
      const record = [...records.values()].find(record => record.id === input.entityId)!
      record.fieldValues = { ...record.fieldValues, ...input.fieldValues }; record.updatedAt = `saved-${writes.length}`
    }
  } })
  // ReactDOM detects native input support once at module initialization. Load
  // the actual editor/workspace only after installing the browser document;
  // importing the rich editor earlier chooses React's old IE input polyfill.
  await import('../src/renderer/src/features/database/InlineDatabaseView')
  const { DocumentRichTextEditor } = await import('../src/renderer/src/rich-text/DocumentRichTextEditor')
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  let history!: Editor, replaceSession!: () => void
  function Harness() {
    const [selected, setSelected] = useState<DocumentDetail | null>(detail)
    history = useDocumentEditorState({ selectedDocumentId: 'rich-database-ui', selectedDocument: selected, ui: getUiText('en-US'),
      onHomeDataChange: noop, onSelectedDocumentChange: setSelected, onMessage: noop })
    const [session, setSession] = useState<object>({}), registry = useRef(new Map<string, unknown>())
    replaceSession = () => setSession({})
    const context: DatabaseEmbedContextValue = { documentId: 'rich-database-ui', session, registry: registry.current, locale: 'en-US', isZh: false,
      onMessage: noop, onOpenDocument: noop, onEnterEditing: noop, commitContent: () => false, openPicker: request => { pickers.push(request) } }
    const keyboard: DocumentsKeyboardState = {
      isEditing: true, isReadingMode: false, isGlobalSearchOpen: false, isBlockSearchOpen: false,
      detailLoading: false, documentLoadError: null, selectedDocumentId: 'rich-database-ui',
      selectedDocument: { id: 'rich-database-ui' } as DocumentsKeyboardState['selectedDocument'],
      globalSearchQuery: '', selectedBlockRange: null, navBack: () => hostCalls.push('back'), navForward: () => hostCalls.push('forward'),
      openGlobalSearch: () => hostCalls.push('palette'), closeGlobalSearch: noop, openBlockSearch: () => hostCalls.push('find'), closeBlockSearch: noop,
      saveDocument: async () => { hostCalls.push('save') }, undoEdit: () => { hostCalls.push('undo'); history.undoEdit() },
      redoEdit: () => { hostCalls.push('redo'); history.redoEdit() }
    }
    useAppKeyboardShortcuts({ documents: keyboard, shell: { activePage: 'documents', setActivePage: noop, openWorkspaceSearch: noop },
      onClearBlockRangeSelection: () => hostCalls.push('clear-selection') })
    return createElement(DatabaseEmbedProvider, { value: context }, createElement('div', { className: 'block-editor-list' },
      history.draftBlocks.length ? createElement(DocumentRichTextEditor, { blocks: history.draftBlocks,
        visibleIndices: history.draftBlocks.map((_block, index) => index), documentId: 'rich-database-ui', isZh: false,
        checkpoint: history.checkpointDraft, onChange: history.setDraftBlocks, onUndo: history.undoEdit, onRedo: history.redoEdit,
        onRevealBlock: noop, onEditSource: noop }) : null))
  }
  const change = async (action: () => void) => { await act(async () => action()) }
  try {
    await act(async () => root.render(createElement(Harness)))
    await change(() => history.loadDocumentIntoEditor(structuredClone(detail)))
    await run({ dom, editor: () => dom.window.document.querySelector<HTMLElement>('.knowbook-rich-text-editor')!, history: () => history,
      blocks: () => history.draftBlocks, pickers, writes, hostCalls, reads, records,
      notes: (id = 'embed') => dom.window.document.querySelector<HTMLInputElement>(`[data-block-id="${id}"] input[aria-label="Notes"]`)!,
      change, replace: blocks => change(() => history.setDraftBlocks(blocks)), newSession: () => change(replaceSession),
      fill: async (input, value) => change(() => {
        input.dispatchEvent(new dom.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }))
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
      }),
      key: async (target, key, options = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
        await change(() => target.dispatchEvent(event)); return event
      }
    })
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    assert.deepEqual(errors.map(error => error.message), [], 'Actual DOM input events must not throw or use missing legacy browser APIs')
  }
}
const ready = (api: Api, count = 1) => waitForRenderer(() => api.dom.window.document.querySelectorAll('.inline-database-view .dbw-shell').length === count,
  'The actual inline DatabaseWorkspace must mount in every atom portal')
const selectAtom = (api: Api, id = 'embed') => api.change(() => api.dom.window.document.querySelector<HTMLButtonElement>(`[data-block-id="${id}"] .rich-database-view-select`)!.click())

test('a real rich view opens and selects database-only columns without treating nested atom text as a complete forest', async () => {
  const blocks: DocumentBlockDraft[] = [
    { ...paragraph('columns', ''), type: 'columns' },
    { ...paragraph('left-column', ''), type: 'column', depth: 1, parentBlockId: 'columns', markdownFormat: { columnWeight: 5000 } },
    { ...embed(), depth: 2, parentBlockId: 'left-column' },
    { ...paragraph('right-column', ''), type: 'column', depth: 1, parentBlockId: 'columns', markdownFormat: { columnWeight: 5000 } },
    { ...embed('right-embed', 'rich-database-B'), depth: 2, parentBlockId: 'right-column' },
    paragraph('tail', 'Host tail')
  ]
  const normalized = normalizeDraftBlocks(blocks.map(block => toDraftBlock({ ...block, id: block.id!, parentBlockId: block.parentBlockId ?? null })))
  await withRich(blocks, async api => {
    await ready(api, 2)
    assert.equal(api.dom.window.document.querySelectorAll('.knowbook-rich-text-editor').length, 1)
    await selectAtom(api)
    assert.equal(getRichTextHistoryBridge(api.editor())!.capture().richText!.kind, 'node')
    await selectAtom(api, 'right-embed')
    const bookmark = getRichTextHistoryBridge(api.editor())!.capture()
    assert.equal(bookmark.richText!.kind, 'node')
    assert.equal(bookmark.richText!.anchor.blockId, 'right-embed')
    assert.equal(api.notes().value, 'Original database value')
    assert.equal(api.notes('right-embed').value, 'Original database value')
    const dragged = api.editor().querySelector<HTMLElement>('.rich-database-view[data-block-id="right-embed"]')!
    Object.defineProperty(api.dom.window.document, 'elementFromPoint', { configurable: true, value: () => dragged })
    const data = new Map<string, string>()
    const transfer = { files: [], effectAllowed: 'none', clearData: () => data.clear(),
      setData: (type: string, value: string) => { data.set(type, value) }, getData: (type: string) => data.get(type) ?? '' }
    const drag = new api.dom.window.MouseEvent('dragstart', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    Object.defineProperty(drag, 'dataTransfer', { value: transfer })
    await api.change(() => { dragged.dispatchEvent(drag) })
    assert.equal(transfer.effectAllowed, 'copyMove', 'the production Rich NodeView must let PM serialize its outer atom drag')
    assert.match(data.get('text/plain')!, /```knowbook-database-view-v1/)
    assert.ok(data.get('text/plain')!.includes('rich-database-B'))
    assert.match(data.get('text/html')!, /data-block-depth="2"/)
    assert.deepEqual(api.blocks(), normalized, 'reading atom text must retain the full legitimately normalized editor forest')
    const ownership = (items: DocumentBlockDraft[]) => items.map(({ id, type, content, depth, parentBlockId, markdownFormat }) => ({ id, type, content, depth, parentBlockId, markdownFormat }))
    assert.deepEqual(ownership(api.blocks()), ownership(blocks), 'every public identity, parent, depth, content and column weight must remain exact without filler blocks')
    assert.deepEqual(api.writes, [])
  })
})

test('two actual database workspaces share one body EditorView and internal clipboard, IME and document keys stay in the database island', async () => {
  await withRich([paragraph('before', 'Before'), embed(), embed('second-embed'), paragraph('after', 'After')], async api => {
    await ready(api, 2)
    assert.equal(api.dom.window.document.querySelectorAll('.knowbook-rich-text-editor').length, 1)
    assert.equal(api.reads.length, 1, 'Same-source portals share the atomic snapshot read')
    await selectAtom(api)
    const bridge = getRichTextHistoryBridge(api.editor())!, selected = bridge.capture()
    assert.equal(selected.richText!.kind, 'node')
    const typeControl = api.dom.window.document.querySelector<HTMLSelectElement>('.rich-text-toolbar select')!
    assert.equal(typeControl.disabled, true, 'A database payload cannot be converted to prose by the ordinary type control')
    const before = structuredClone(api.blocks()), input = api.notes()
    await api.change(() => input.focus())
    assert.equal(captureEditorHistoryBookmark(api.blocks()), null)
    await api.change(() => input.dispatchEvent(new api.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
    assert.ok(api.history().getBlockActionTarget(['embed']), 'Database composition must not mark the host draft as composing or block its own actions')
    assert.equal((await api.key(input, 'Enter', { isComposing: true })).defaultPrevented, false)
    await api.change(() => input.dispatchEvent(new api.dom.window.CompositionEvent('compositionend', { bubbles: true })))
    for (const [key, options] of [['z', { ctrlKey: true }], ['y', { ctrlKey: true }], ['f', { ctrlKey: true }], ['s', { ctrlKey: true }],
      ['Backspace', {}], ['Delete', {}]] as const) assert.equal((await api.key(input, key, options)).defaultPrevented, false, key)
    const data = new Map([['text/plain', 'Native cell selection']]), event = new api.dom.window.Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => data.get(type) ?? '', setData: (type: string, value: string) => data.set(type, value) } })
    await api.change(() => input.dispatchEvent(event))
    assert.equal(event.defaultPrevented, false); assert.deepEqual([...data], [['text/plain', 'Native cell selection']])
    assert.deepEqual(api.hostCalls, []); assert.deepEqual(api.blocks(), before)
    assert.deepEqual(bridge.capture().richText, selected.richText)
  })
})

test('a selected database atom copies the finite reference instead of its live rows', async () => {
  await withRich([paragraph('before', 'Before'), embed(), paragraph('after', 'After')], async api => {
    await ready(api); await selectAtom(api)
    const data = new Map<string, string>(), event = new api.dom.window.Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => data.set(type, value) } })
    await api.change(() => api.editor().dispatchEvent(event))
    assert.equal(event.defaultPrevented, true)
    assert.match(data.get('text/plain')!, /```knowbook-database-view-v1/)
    assert.match(data.get('text/html')!, /data-knowbook-markdown-source="true"/)
    assert.equal(data.get('text/plain')!.includes('Original database value'), false)
    assert.deepEqual(api.writes, [])
  })
})

test('confirmed public picker insertion keeps its empty host identity and one actual undo/redo restores the selected atom', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try { await withRich([{ ...paragraph('public-host', ''), tags: ['linked'], highlight: 'yellow' }], async api => {
    await api.change(() => api.editor().focus())
    await api.change(() => Array.from(api.dom.window.document.querySelectorAll('button')).find(button => button.textContent === 'Insert database view')!.click())
    assert.equal(api.pickers.length, 1); assert.equal(api.blocks()[0].type, 'paragraph')
    const picker = api.pickers[0]
    await api.change(() => { assert.equal(picker.isCurrent(), true); assert.equal(picker.onSelect(payload()), true); picker.onComplete?.() })
    await ready(api)
    assert.equal(api.blocks().length, 1); assert.equal(api.blocks()[0].id, 'public-host'); assert.equal(api.blocks()[0].type, 'database-view')
    assert.deepEqual(api.blocks()[0].tags, ['linked']); assert.equal(api.blocks()[0].highlight, 'yellow')
    assert.equal(getRichTextHistoryBridge(api.editor())!.capture().richText!.kind, 'node')
    await api.key(api.editor(), 'z', { ctrlKey: true }); await api.change(() => context.mock.timers.tick(0))
    assert.equal(api.blocks()[0].type, 'paragraph'); assert.equal(api.blocks()[0].content, '')
    assert.deepEqual(api.blocks()[0].tags, ['linked'])
    await api.key(api.editor(), 'y', { ctrlKey: true }); await api.change(() => context.mock.timers.tick(0))
    assert.equal(api.blocks()[0].type, 'database-view'); assert.equal(api.blocks()[0].id, 'public-host')
    assert.equal(getRichTextHistoryBridge(api.editor())!.capture().richText!.kind, 'node')
  }) } finally { context.mock.timers.reset() }
})

test('real database cell persistence survives deleting the host atom and undoing or redoing only that host change', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try { await withRich([paragraph('before', 'Before'), embed(), paragraph('after', 'After')], async api => {
    await ready(api)
    const input = api.notes(); await api.change(() => input.focus()); await api.fill(input, '中文 saved independently')
    await api.key(input, 'Enter')
    await waitForRenderer(() => api.writes.length === 1 && api.notes()?.value === '中文 saved independently' && !api.notes().readOnly,
      'The real DatabaseValueEditor must confirm its persisted value')
    assert.equal(api.records.get('rich-database-A')!.fieldValues.notes, '中文 saved independently')
    await selectAtom(api); await api.key(api.editor(), 'Delete', { keyCode: 46 })
    assert.deepEqual(api.blocks().map(block => block.id), ['before', 'after'])
    await api.key(api.editor(), 'z', { ctrlKey: true }); await api.change(() => context.mock.timers.tick(0)); await ready(api)
    assert.equal(api.notes().value, '中文 saved independently')
    assert.equal(getRichTextHistoryBridge(api.editor())!.capture().richText!.kind, 'node')
    await api.key(api.editor(), 'y', { ctrlKey: true }); await api.change(() => context.mock.timers.tick(0))
    assert.deepEqual(api.blocks().map(block => block.id), ['before', 'after'])
    assert.equal(api.records.get('rich-database-A')!.fieldValues.notes, '中文 saved independently'); assert.equal(api.writes.length, 1)
  }) } finally { context.mock.timers.reset() }
})

for (const interruption of ['source-A-B-A', 'session', 'delete'] as const) test(`an old actual inline picker cannot publish into the host after ${interruption}`, async () => {
  await withRich([paragraph('before', 'Before'), embed(), paragraph('after', 'After')], async api => {
    await ready(api)
    await api.change(() => api.editor().querySelector<HTMLButtonElement>('.dbw-source-trigger')!.click())
    const picker = api.pickers.at(-1)!
    assert.ok(picker); assert.equal(picker.isCurrent(), true)
    if (interruption === 'source-A-B-A') {
      await api.replace([paragraph('before', 'Before'), embed('embed', 'rich-database-B'), paragraph('after', 'After')]); await ready(api)
      await api.replace([paragraph('before', 'Before'), embed(), paragraph('after', 'After')]); await ready(api)
    } else if (interruption === 'session') { await api.newSession(); await ready(api) }
    else await api.replace([paragraph('before', 'Before'), paragraph('after', 'After')])
    const before = structuredClone(api.blocks()), outside = api.dom.window.document.getElementById('outside')!
    await api.change(() => { outside.focus(); assert.equal(picker.isCurrent(), false); assert.equal(picker.onSelect(payload('rich-database-B')), false); picker.onComplete?.() })
    assert.deepEqual(api.blocks(), before); assert.equal(api.dom.window.document.activeElement, outside)
    assert.deepEqual(api.writes, [])
  })
})
