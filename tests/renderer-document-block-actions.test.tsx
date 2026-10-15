import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState, type ReactNode } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentTreeNode } from '../src/shared/contracts'
import { getUiText } from '../src/renderer/src/i18n'
import { BLOCK_CONVERSION_TYPES } from '../src/renderer/src/utils/blockConversionTypes'
import { createColdBlockPopup } from '../src/renderer/src/utils/coldBlockPopup'
import type { DocumentsDomainState } from '../src/renderer/src/types/appDomains'
import { serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { BlockContextMenu } = await import('../src/renderer/src/components/BlockContextMenu')
const { BlockSelectionToolbar } = await import('../src/renderer/src/components/BlockSelectionToolbar')
const { default: DocumentBlockMoveDialog } = await import('../src/renderer/src/components/DocumentBlockMoveDialog')
const { BlockEditorRow } = await import('../src/renderer/src/components/BlockEditorRow')
await import('../src/renderer/src/components/SourceInlinePresentationToolbar')
type MenuProps = import('../src/renderer/src/components/BlockContextMenu').BlockContextMenuProps
type MoveProps = import('../src/renderer/src/components/DocumentBlockMoveDialog').DocumentBlockMoveDialogProps
type RowProps = import('../src/renderer/src/components/BlockEditorRow').BlockEditorRowProps

type Context = {
  document: Document
  window: JSDOM['window']
  render: (element: ReactNode) => Promise<void>
  change: (action: () => void) => Promise<void>
  key: (target: Element, key: string, options?: KeyboardEventInit) => Promise<KeyboardEvent>
  fill: (input: HTMLInputElement, value: string) => Promise<void>
}
async function withDom(run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<button id="opener">Block menu</button><input id="outside"><div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(20, 30, 160, 32) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return (this.isConnected && !this.closest('[hidden], [inert]') ? [this.getBoundingClientRect()] : []) as unknown as DOMRectList
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const change = async (action: () => void) => { await act(async () => { action() }) }
  const context: Context = {
    document: dom.window.document, window: dom.window,
    render: async element => { await act(async () => root.render(element)) }, change,
    key: async (target, key, options = {}) => {
      const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
      await change(() => target.dispatchEvent(event))
      return event as KeyboardEvent
    },
    fill: async (input, value) => {
      await change(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    }
  }
  try { await run(context) }
  finally {
    await act(async () => root.unmount())
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}
async function waitForUi(condition: () => boolean) {
  const deadline = Date.now() + 1000
  while (!condition() && Date.now() < deadline) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.equal(condition(), true, 'Expected the lazy action to finish within one second')
}
const noop = () => {}
const labels = getUiText('en-US').blockTypeOptions
function menuProps(overrides: Partial<MenuProps> = {}): MenuProps {
  return { x: 20, y: 30, blockType: 'paragraph', onTypeChange: noop, onDuplicate: noop, onDelete: noop, onClose: noop,
    typeOptions: labels, isZh: false, ui: getUiText('en-US'), ...overrides }
}
function button(context: Context, label: string): HTMLButtonElement {
  return [...context.document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === label || element.getAttribute('aria-label') === label)!
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const tree: DocumentTreeNode[] = [
  { id: 'source', title: 'Source', path: 'Source', updatedAt: '2026-10-14', children: [] },
  { id: 'parent', title: 'Research', path: 'Research', updatedAt: '2026-10-14', children: [
    { id: 'destination', title: 'Notes', path: 'Research/Notes', updatedAt: '2026-10-14', children: [] }
  ] }
]
function moveProps(overrides: Partial<MoveProps> = {}): MoveProps {
  return { isZh: false, sourceDocumentId: 'source', sourceDocumentTitle: 'Source', selectedBlockCount: 2, documents: tree,
    busy: false, onClose: noop, onMove: () => false, ...overrides }
}

test('single and multiple block controls expose all sixteen conversions in the same order', async () => withDom(async context => {
  const calls: string[] = []
  await context.render(createElement(BlockContextMenu, menuProps({ selectedBlockCount: 3, onTypeChange: type => calls.push(type), onClose: () => calls.push('close') })))
  assert.equal(context.document.querySelector('.context-menu-label')!.textContent, '3 blocks selected')
  assert.deepEqual([...context.document.querySelectorAll('.context-menu-group:first-of-type button')].map(element => element.textContent), BLOCK_CONVERSION_TYPES.map(type => labels[type]))
  await context.change(() => button(context, 'Heading 6').click())
  assert.deepEqual(calls, ['heading-6', 'close'])
  await context.render(createElement(BlockSelectionToolbar, {
    selectedBlockCount: 3, selectedVisibleBlockCount: 3, selectedBlockActionCount: 3, isIncoherent: false,
    hasHiddenCollapsedContent: false, interactionIssue: null, hasCrossParent: false, selectedBlockConversionType: 'paragraph',
    canMoveUp: true, canMoveDown: true, summaryLabel: '3 blocks', hintLabel: '', convertLabel: 'Convert', copyBlocksLabel: 'Copy blocks',
    copyTextLabel: 'Copy text', cutLabel: 'Cut', duplicateLabel: 'Duplicate', aiEditLabel: 'AI', deleteLabel: 'Delete',
    moveUpLabel: 'Move up', moveDownLabel: 'Move down', clearLabel: 'Clear', onConversionTypeChange: noop,
    onConvert: noop, onCopyBlocks: noop, onCopyText: noop, onCut: noop, onDuplicate: noop, onOpenAiEdit: noop,
    onDelete: noop, onMoveUp: noop, onMoveDown: noop, onClear: noop, conversionOptions: labels, rangeStart: 0, rangeEnd: 2
  }))
  assert.deepEqual([...context.document.querySelectorAll('select option')].map(option => option.getAttribute('value')), [...BLOCK_CONVERSION_TYPES])
}))

test('database single and mixed menus disable only ordinary conversions while copy, delete and move stay available', async () => withDom(async context => {
  for (const props of [{ blockType: 'database-view' }, { blockType: '', selectedBlockCount: 2, conversionDisabled: true }]) {
    const calls: string[] = []
    await context.render(createElement(BlockContextMenu, menuProps({ ...props, onTypeChange: type => calls.push(type),
      onCopyBlockLinks: () => calls.push('links'), onMoveToDocument: () => calls.push('move'), onDelete: () => calls.push('delete') })))
    for (const type of BLOCK_CONVERSION_TYPES) {
      const conversion = button(context, labels[type])
      assert.equal(conversion.disabled, true)
      await context.change(() => conversion.click())
    }
    assert.deepEqual(calls, [])
    for (const label of ['Copy block links', 'Move to document…', 'Delete']) assert.equal(button(context, label).disabled, false)
    await context.change(() => button(context, 'Copy block links').click())
    assert.deepEqual(calls, ['links'])
  }
}))

test('shared menu actions honor disabled state and keyboard Escape preserves an IME composition', async () => withDom(async context => {
  const calls: string[] = []
  await context.render(createElement(BlockContextMenu, menuProps({ onCopyBlockLinks: () => calls.push('links'), onMoveToDocument: () => calls.push('move'), onClose: () => calls.push('close') })))
  const first = context.document.querySelector<HTMLButtonElement>('.block-context-menu button')!
  assert.equal(context.document.activeElement, first)
  await context.key(first, 'ArrowDown')
  assert.equal(context.document.activeElement!.textContent, 'Heading 1')
  await context.key(context.document.activeElement!, 'Escape', { isComposing: true })
  await context.key(context.document.activeElement!, 'Escape', { keyCode: 229 })
  assert.deepEqual([...calls], [])
  await context.change(() => button(context, 'Copy block links').click())
  assert.deepEqual(calls, ['links', 'close'])
  await context.render(createElement(BlockContextMenu, menuProps({ disabled: true, disabledReason: 'The selection changed', onCopyBlockLinks: () => calls.push('unexpected'), onClose: () => calls.push('dismiss') })))
  assert.equal(context.document.querySelector('[role="status"]')!.textContent, 'The selection changed')
  assert.ok([...context.document.querySelectorAll<HTMLButtonElement>('.block-context-menu button')].every(element => element.disabled))
  await context.change(() => button(context, 'Copy block links').click())
  assert.deepEqual(calls, ['links', 'close'])
  await context.key(context.document.querySelector('.block-context-menu')!, 'Escape')
  assert.deepEqual(calls, ['links', 'close', 'dismiss'])
}))

test('move picker excludes its source, searches nested paths and retains a failed destination with a synchronous submit lock', async () => withDom(async context => {
  const pending = deferred<boolean>(), requests: string[] = []
  let closes = 0
  const props = moveProps({ onMove: id => { requests.push(id); return pending.promise }, onClose: () => { closes++ } })
  await context.render(createElement(DocumentBlockMoveDialog, props))
  assert.equal(context.document.activeElement!.tagName, 'INPUT')
  assert.equal(context.document.querySelector('input[value="source"]'), null)
  const search = context.document.querySelector<HTMLInputElement>('.document-capture-field input')!
  await context.fill(search, 'Research/Notes')
  assert.equal(context.document.querySelectorAll('input[type="radio"]').length, 1)
  const radio = context.document.querySelector<HTMLInputElement>('input[value="destination"]')!
  await context.change(() => { radio.focus(); radio.click() })
  const form = context.document.querySelector('form')!
  await context.change(() => {
    form.dispatchEvent(new context.window.Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new context.window.Event('submit', { bubbles: true, cancelable: true }))
  })
  assert.deepEqual(requests, ['destination'])
  assert.equal(context.document.querySelector('dialog')!.getAttribute('aria-busy'), 'true')
  assert.equal(radio.matches(':disabled'), true)
  await context.key(context.document.querySelector('dialog')!, 'Escape')
  assert.equal(closes, 0)
  await context.render(createElement(DocumentBlockMoveDialog, { ...props, error: 'Target changed, please retry.' }))
  await context.change(() => pending.resolve(false))
  assert.equal(context.document.querySelector('dialog')!.getAttribute('aria-busy'), 'false')
  assert.equal(radio.checked, true)
  assert.equal(search.value, 'Research/Notes')
  assert.equal(context.document.querySelector('[role="alert"]')!.textContent, 'Target changed, please retry.')
  assert.equal(closes, 0)
  await context.key(context.document.querySelector('dialog')!, 'Escape')
  assert.equal(closes, 1)
}))

test('move picker keeps Enter and Escape in composition, closes only on successful move, and rejects a stale lazy opening', async () => withDom(async context => {
  let moves = 0, closes = 0
  const props = moveProps({ onMove: () => { moves++; return true }, onClose: () => { closes++ } })
  await context.render(createElement(DocumentBlockMoveDialog, props))
  const radio = context.document.querySelector<HTMLInputElement>('input[value="destination"]')!
  await context.change(() => radio.click())
  const dialog = context.document.querySelector('dialog')!
  await context.change(() => radio.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true })))
  await context.key(radio, 'Enter')
  await context.key(radio, 'Escape')
  await context.change(() => context.document.querySelector('form')!.dispatchEvent(new context.window.Event('submit', { bubbles: true, cancelable: true })))
  assert.equal(moves, 0); assert.equal(closes, 0)
  await context.change(() => radio.dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true })))
  for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
    assert.equal((await context.key(radio, 'Enter', options)).defaultPrevented, true)
    assert.equal((await context.key(radio, 'Escape', options)).defaultPrevented, true)
  }
  assert.equal(dialog.open, true)
  await context.change(() => context.document.querySelector('form')!.dispatchEvent(new context.window.Event('submit', { bubbles: true, cancelable: true })))
  assert.equal(moves, 1); assert.equal(closes, 1)
  await context.render(null)
  await context.change(() => context.document.getElementById('outside')!.focus())
  await context.render(createElement(DocumentBlockMoveDialog, moveProps({ canOpen: () => false, onClose: () => { closes++ } })))
  assert.equal(context.document.querySelector('dialog')!.open, false)
  assert.equal(context.document.activeElement!.id, 'outside')
  assert.equal(closes, 2)
}))

function rowProps(block: DocumentBlockDraft, index: number, blocks: () => DocumentBlockDraft[], overrides: Partial<RowProps>): RowProps {
  return {
    block, index, draftBlockCount: blocks().length, getDraftBlocks: blocks, selectedDocument: { id: 'source', title: 'Source' },
    isSelected: false, isHighlighted: false, hasChildren: false, dropPreview: null, indentPx: 0, numberLabel: '',
    activeBlockIndex: null, collapsedBlockIds: new Set(), activeSlashContext: null, filteredSlashCommands: [], activeSlashCommand: null,
    selectedBlockRange: null, selectedBlockCount: 1, blockTextareaRefs: { current: [] }, updateDraftBlock: noop, updateBlockHighlight: noop,
    insertDraftBlockAt: noop, handleBlockContentChange: noop, navigateInlineReferenceAtCursor: noop, captureBlockCursor: noop, handleBlockPaste: () => false,
    beginBlockDrag: noop, endBlockDrag: noop, getDraggedBlockDepthPreview: () => null, dropBlockAt: noop, setDragOverBlockIndex: noop, setDragOverBlockDepth: noop,
    moveSelectedBlocks: noop, moveDraftBlockBySibling: noop, setSelectedSlashCommandIndex: noop, applySlashCommand: noop, dismissSlashCommand: noop,
    adjustSelectedBlocksDepth: noop, adjustBlockDepth: noop, deleteSelectedBlocks: noop, duplicateSelectedBlocks: noop, duplicateDraftBlock: noop,
    selectBlockRange: noop, selectAllBlocks: noop, notifyBlockMouseDown: noop, handleBlockMouseEnter: noop, endBlockRangeSelection: noop,
    isBlockRangeSelecting: false, continueBlockAt: noop, downgradeBlockAt: noop, mergeWithPreviousBlock: noop, splitDraftBlock: noop,
    toggleBlockCollapse: noop, isSelectionCoherent: () => true, getVisibleBlockCountInRange: () => 2,
    getMultiBlockOperationRange: range => range, removeSelectedBlockRange: noop, canMoveSelectedRange: () => false,
    onOpenSelectionAiEditor: noop, BLOCK_INDENT_SIZE: 24, ui: getUiText('en-US'), isZh: false, ...overrides
  }
}
const paragraph = (id: string): DocumentBlockDraft => ({ id, content: id, type: 'paragraph', checked: false, depth: 0 })

test('real source and shared menu AI entries reject database atoms and their selected owners while atomic actions stay enabled', async () => withDom(async context => {
  const { useDocumentBlockActions } = await import('../src/renderer/src/hooks/useDocumentBlockActions')
  const database: DocumentBlockDraft = { ...paragraph('database'), type: 'database-view', depth: 1, parentBlockId: 'owner',
    content: serializeDatabaseViewPayload({ version: 1, databaseId: 'private-source', viewId: null,
      config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title]) }) }
  const blocks = [{ ...paragraph('owner'), type: 'toggle' }, database, paragraph('ordinary')]
  let aiCalls = 0, selections = 0
  for (const index of [0, 1, 2]) {
    await context.render(null)
    await context.render(createElement(BlockEditorRow, rowProps(blocks[index], index, () => blocks, {
      hasChildren: index === 0, selectBlockRange: () => { selections++ }, onOpenSelectionAiEditor: () => { aiCalls++ }
    })))
    await context.change(() => context.document.querySelector<HTMLButtonElement>('.block-drag-handle')!.click())
    const ai = context.document.querySelector<HTMLButtonElement>('.block-toolbar-ai-edit')!
    assert.equal(ai.disabled, index !== 2)
    for (const selector of ['.block-toolbar-duplicate', '.block-toolbar-delete']) {
      assert.equal(context.document.querySelector<HTMLButtonElement>(selector)!.disabled, false)
    }
    await context.change(() => ai.click())
  }
  assert.equal(aiCalls, 1)
  assert.equal(selections, 1, 'blocked Source AI buttons must not alter the block selection')

  let actions!: ReturnType<typeof useDocumentBlockActions>
  function Harness() {
    const documents = { draftBlocks: blocks, selectedDocumentId: 'source', selectedDocument: { title: 'Source' },
      selectedBlockRange: null, isBlockMoveBusy: false, checkpointDraft: noop,
      getDraftBlocks: () => blocks, getRenameTarget: () => ({ documentId: 'source', session: 1 }),
      getBlockActionTarget: (ids: string[]) => ids.length ? { documentId: 'source', session: 1, blockIds: ids, blocks, bookmark: null } : null,
      isBlockActionTargetCurrent: () => true, setSelectedBlockRange: () => { selections++ }
    } as unknown as DocumentsDomainState
    actions = useDocumentBlockActions({ documents, documentTree: [], isZh: false, ui: getUiText('en-US'), onOpenAiEdit: () => { aiCalls++ } })
    return actions.contextMenuProps ? createElement(BlockContextMenu, actions.contextMenuProps) : null
  }
  await context.render(createElement(Harness))
  for (const blockIds of [['owner'], ['database'], ['owner', 'ordinary']]) {
    await context.change(() => actions.openBlockActions({ blockIds, x: 20, y: 30 }))
    assert.equal(button(context, 'AI edit').disabled, true)
    for (const label of ['Copy block links', 'Move to document…', 'Duplicate', 'Delete']) assert.equal(button(context, label).disabled, false)
    await context.change(() => { button(context, 'AI edit').click(); actions.contextMenuProps!.onOpenAiEdit!() })
    assert.equal(aiCalls, 1, 'the actual shared hook must reject programmatic invocation as well as the disabled button')
    assert.equal(selections, 1)
  }
  await context.change(() => actions.openBlockActions({ blockIds: ['ordinary'], x: 20, y: 30 }))
  assert.equal(button(context, 'AI edit').disabled, false)
  await context.change(() => button(context, 'AI edit').click())
  await waitForUi(() => aiCalls === 2)
}))

test('the actual text AI hook never submits a database subtree and cannot apply a late prose preview to its replacement selection', async () => withDom(async context => {
  const { useDocumentSelectionAiState } = await import('../src/renderer/src/hooks/useDocumentSelectionAiState')
  const { DocumentSelectionAiPanel } = await import('../src/renderer/src/components/DocumentSelectionAiPanel')
  const ordinary = [paragraph('ordinary')]
  const protectedSelection: DocumentBlockDraft[] = [{ ...paragraph('owner'), type: 'toggle' }, {
    ...paragraph('database'), type: 'database-view', depth: 1, parentBlockId: 'owner',
    content: serializeDatabaseViewPayload({ version: 1, databaseId: 'private-source', viewId: null,
      config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title]) })
  }]
  type AiRequest = { input: import('../src/shared/contracts').PreviewDocumentBlockAiEditInput;
    response: ReturnType<typeof deferred<import('../src/shared/contracts').PreviewDocumentBlockAiEditResult>> }
  const requests: AiRequest[] = []
  const recordedRequests = (): AiRequest[] => requests.slice()
  Object.defineProperty(context.window, 'knowbook', { value: {
    previewDocumentBlockAiEdit: (input: import('../src/shared/contracts').PreviewDocumentBlockAiEditInput) => {
      const response = deferred<import('../src/shared/contracts').PreviewDocumentBlockAiEditResult>()
      requests.push({ input, response }); return response.promise
    }
  } })
  let current = protectedSelection, replace!: (blocks: DocumentBlockDraft[]) => void
  let ai!: ReturnType<typeof useDocumentSelectionAiState>, opened = 0
  const pasted: string[] = []
  const ui = getUiText('en-US')
  function Harness() {
    const [blocks, setBlocks] = useState(current); current = blocks; replace = setBlocks
    ai = useDocumentSelectionAiState({ aiEnabled: true, hasApiKey: true, documentsAuxPanelOpen: false,
      draftBlocks: blocks, draftTitle: 'Source', draftSummary: '', selectedBlockRange: { start: 0, end: 0 },
      selectedDocument: { id: 'source', title: 'Source', path: 'Source' }, getMultiBlockOperationRange: () => ({ start: 0, end: blocks.length - 1 }),
      onOpenAuxPanel: () => { opened++ }, handleBlockPaste: (_index, text) => { pasted.push(text); return true }, ui })
    return createElement(DocumentSelectionAiPanel, { ...ai, aiEnabled: true, hasApiKey: true, ui,
      onApplyPreview: () => { ai.applyPreview() }, onClearPreview: ai.clearPreview, onCustomInstructionChange: ai.setCustomInstruction,
      onGeneratePreview: () => { void ai.generatePreview() }, onModeChange: ai.setMode,
      selectedBlockActionCount: ai.selectedBlockActionCount, selectedBlockCount: ai.selectedBlockCount })
  }
  await context.render(createElement(Harness))
  assert.equal(ai.canGeneratePreview, false)
  assert.equal(button(context, ui.aiSelectionGeneratePreview).disabled, true)
  await context.change(() => { ai.openSelectionAiEditor(); void ai.generatePreview() })
  assert.equal(opened, 0)
  assert.deepEqual(recordedRequests(), [])

  await context.change(() => replace(ordinary))
  let first!: Promise<void>
  await context.change(() => { first = ai.generatePreview() })
  assert.equal(recordedRequests().length, 1)
  const firstRequest = recordedRequests()[0]
  assert.ok(firstRequest)
  assert.deepEqual(firstRequest.input.selectedBlocks.map(block => block.type), ['paragraph'])
  await act(async () => { firstRequest.response.resolve({ documentId: 'source', mode: 'summarize', instruction: 'Summarize', replacementText: 'Valid prose' }); await first })
  assert.equal(ai.canApplyPreview, true)
  await context.change(() => { assert.equal(ai.applyPreview(), true) })
  assert.deepEqual(pasted, ['Valid prose'])

  let late!: Promise<void>
  await context.change(() => { late = ai.generatePreview() })
  assert.equal(recordedRequests().length, 2)
  const lateRequest = recordedRequests()[1]
  assert.ok(lateRequest)
  await context.change(() => replace(protectedSelection))
  await act(async () => { lateRequest.response.resolve({ documentId: 'source', mode: 'summarize', instruction: 'Summarize', replacementText: 'Late prose' }); await late })
  assert.equal(ai.canGeneratePreview, false)
  assert.equal(ai.canApplyPreview, false)
  assert.equal(ai.isPreviewStale, true)
  assert.equal(button(context, ui.aiSelectionApplyPreview).disabled, true)
  await context.change(() => { assert.equal(ai.applyPreview(), false); void ai.generatePreview() })
  assert.equal(recordedRequests().length, 2, 'the new protected selection must not issue another text AI request')
  assert.deepEqual(pasted, ['Valid prose'], 'a late text result must never be pasted into a database atom or its parent')
  assert.deepEqual(current, protectedSelection)
}))

test('source right-click freezes explicitly selected IDs without adding hidden descendants, while outside the selection targets itself', async () => withDom(async context => {
  let blocks = ['A', 'child', 'B', 'C'].map(paragraph)
  const opened: Array<{ blockIds: string[]; x: number; y: number }> = []
  const selected = rowProps(blocks[0], 0, () => blocks, { isSelected: true, selectedBlockRange: { start: 0, end: 2 }, selectedBlockCount: 3,
    getMultiBlockOperationRange: () => ({ start: 0, end: 2 }), getSelectedBlockActionIds: () => ['A', 'B'], onOpenBlockActions: input => opened.push(input) })
  await context.render(createElement(BlockEditorRow, selected))
  const row = context.document.querySelector('.block-editor-row')!
  await context.change(() => row.dispatchEvent(new context.window.MouseEvent('contextmenu', { clientX: 50, clientY: 80, bubbles: true, cancelable: true })))
  assert.deepEqual(opened[0], { blockIds: ['A', 'B'], x: 50, y: 80 })
  blocks = ['fresh', 'A', 'child', 'B', 'C'].map(paragraph)
  assert.deepEqual(opened[0].blockIds, ['A', 'B'])
  await context.render(createElement(BlockEditorRow, rowProps(blocks[4], 4, () => blocks, { selectedBlockRange: { start: 1, end: 3 },
    selectedBlockCount: 3, onOpenBlockActions: input => opened.push(input) })))
  await context.change(() => context.document.querySelector('.block-editor-row')!.dispatchEvent(new context.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  assert.deepEqual(opened[1].blockIds, ['C'])
}))

test('source keyboard block menu retains text selection and uses current block identity after an index changes', async () => withDom(async context => {
  let blocks = ['A', 'B'].map(paragraph)
  const ids: string[][] = []
  await context.render(createElement(BlockEditorRow, rowProps(blocks[1], 1, () => blocks, { onOpenBlockActions: input => ids.push(input.blockIds) })))
  const textarea = context.document.querySelector('textarea')!
  await context.change(() => { textarea.focus(); textarea.setSelectionRange(0, 1) })
  blocks = ['inserted', 'A', 'B'].map(paragraph)
  assert.equal((await context.key(textarea, 'F10', { shiftKey: true })).defaultPrevented, true)
  assert.deepEqual(ids, [['B']])
  assert.equal(textarea.selectionStart, 0); assert.equal(textarea.selectionEnd, 1)
  await context.key(textarea, 'ContextMenu', { isComposing: true })
  await context.key(textarea, 'F10', { shiftKey: true, keyCode: 229 })
  assert.deepEqual(ids, [['B']])
}))


test('a cold menu validates attention before focusing its first action', async () => withDom(async context => {
  const outside = context.document.getElementById('outside')!
  await context.change(() => outside.focus())
  let closes = 0
  await context.render(createElement(BlockContextMenu, menuProps({ canOpen: () => false, onClose: () => { closes++ } })))
  assert.equal(context.document.activeElement, outside)
  assert.equal(closes, 1)
}))

test('source underline shortcut records one checkpoint, preserves marked text metadata and restores a backward selection', async () => withDom(async context => {
  const initial: DocumentBlockDraft = { ...paragraph('source-format'), content: '**alpha** beta', highlight: 'blue', tags: ['kept'] }
  let current = [initial], checkpoints = 0
  function Harness() {
    const [blocks, setBlocks] = useState(current)
    current = blocks
    return createElement(BlockEditorRow, rowProps(blocks[0], 0, () => current, {
      activeBlockIndex: 0, checkpointDraft: () => { checkpoints++ },
      updateDraftBlock: (index, patch) => setBlocks(previous => previous.map((block, offset) => offset === index ? { ...block, ...patch } : block))
    }))
  }
  await context.render(createElement(Harness))
  const textarea = context.document.querySelector('textarea')!
  await context.change(() => { textarea.focus(); textarea.setSelectionRange(2, 7, 'backward') })
  assert.equal((await context.key(textarea, 'u', { ctrlKey: true })).defaultPrevented, true)
  await waitForUi(() => checkpoints === 1)
  assert.equal(checkpoints, 1)
  assert.match(current[0].content, /<strong><u>alpha<\/u><\/strong>/)
  assert.equal(current[0].id, 'source-format'); assert.equal(current[0].highlight, 'blue'); assert.deepEqual(current[0].tags, ['kept'])
  assert.equal(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd), 'alpha')
  assert.equal(textarea.selectionDirection, 'backward')
  assert.equal(context.document.activeElement, textarea)
}))

test('source palette applies a finite color and rejects partial delimiters or composing shortcuts without checkpoints', async () => withDom(async context => {
  let current = [{ ...paragraph('source-format'), content: '**alpha** beta' }], checkpoints = 0
  function Harness() {
    const [blocks, setBlocks] = useState(current)
    current = blocks
    return createElement(BlockEditorRow, rowProps(blocks[0], 0, () => current, {
      activeBlockIndex: 0, checkpointDraft: () => { checkpoints++ },
      updateDraftBlock: (index, patch) => setBlocks(previous => previous.map((block, offset) => offset === index ? { ...block, ...patch } : block))
    }))
  }
  await context.render(createElement(Harness))
  const textarea = context.document.querySelector('textarea')!
  await context.change(() => { textarea.focus(); textarea.setSelectionRange(1, 7) })
  await context.key(textarea, 'u', { ctrlKey: true })
  await waitForUi(() => Boolean(context.document.querySelector('.block-editor-input-column [role="status"]')))
  assert.equal(current[0].content, '**alpha** beta'); assert.equal(checkpoints, 0)
  assert.equal(context.document.querySelector('.block-editor-input-column [role="status"]')!.textContent, 'Select complete text that can be formatted.')
  await context.change(() => textarea.setSelectionRange(2, 7))
  await context.key(textarea, 'u', { ctrlKey: true, isComposing: true })
  await context.key(textarea, 'u', { ctrlKey: true, keyCode: 229 })
  assert.equal(checkpoints, 0)
  const floating = textarea.parentElement!.querySelector<HTMLElement>(':scope > .markdown-format-toolbar')!
  const presentation = context.document.querySelector<HTMLElement>('.source-inline-presentation-toolbar')!
  assert.equal(presentation.parentElement, floating, 'old and new controls share the measured floating surface')
  await context.key(textarea, 'F10', { altKey: true })
  assert.equal(context.document.activeElement?.getAttribute('aria-label'), 'Bold')
  await context.key(context.document.activeElement!, 'Escape')
  assert.equal(context.document.activeElement, textarea)
  await context.key(textarea, 'Tab', { shiftKey: true })
  assert.equal(context.document.activeElement?.getAttribute('aria-label'), 'Background color')
  const composingEscape = await context.key(context.document.activeElement!, 'Escape', { isComposing: true })
  assert.equal(composingEscape.defaultPrevented, false)
  assert.equal(context.document.activeElement?.getAttribute('aria-label'), 'Background color')
  await context.key(context.document.activeElement!, 'Escape')
  assert.equal(context.document.activeElement, textarea)
  assert.equal(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd), 'alpha')
  await context.change(() => button(context, 'Text color').click())
  const swatch = context.document.querySelector<HTMLButtonElement>('.source-inline-presentation-toolbar [data-palette-color="red"]')!
  assert.equal(swatch.closest('.markdown-format-toolbar'), floating, 'expanded colors remain within the same measured surface')
  await context.change(() => swatch.click())
  await waitForUi(() => checkpoints === 1)
  assert.equal(checkpoints, 1)
  assert.match(current[0].content, /data-knowbook-text-color="red"/)
  assert.equal(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd), 'alpha')
  assert.equal(context.document.activeElement, textarea)
}))


test('invalid move structure disables only its move action and keeps existing block highlighting and AI reachable', async () => withDom(async context => {
  const calls: Array<string | undefined> = []
  const props = menuProps({ moveDisabledReason: 'Choose consecutive siblings', onMoveToDocument: () => calls.push('unexpected move'),
    currentHighlight: 'blue', onHighlightChange: color => calls.push(color), onOpenAiEdit: () => calls.push('AI'), onClose: () => calls.push('close') })
  await context.render(createElement(BlockContextMenu, props))
  assert.equal(button(context, 'Move to document…').disabled, true)
  assert.equal(button(context, 'Move to document…').title, 'Choose consecutive siblings')
  assert.equal(button(context, 'Duplicate').disabled, false)
  assert.equal(button(context, 'Heading 6').disabled, false)
  await context.change(() => context.document.querySelector<HTMLButtonElement>('.block-highlight-picker [aria-label="Green"]')!.click())
  assert.deepEqual(calls, ['green', 'close'])
  await context.change(() => button(context, 'AI edit').click())
  assert.deepEqual(calls, ['green', 'close', 'AI', 'close'])
}))

test('a source formatting action awaiting its lazy formatter cannot mutate after foreign focus takes attention', async () => withDom(async context => {
  const block = { ...paragraph('source-format'), content: 'alpha beta' }, blocks = [block]
  let changes = 0, checkpoints = 0
  await context.render(createElement(BlockEditorRow, rowProps(block, 0, () => blocks, { activeBlockIndex: 0,
    checkpointDraft: () => { checkpoints++ }, updateDraftBlock: () => { changes++ } })))
  const textarea = context.document.querySelector('textarea')!
  await context.change(() => { textarea.focus(); textarea.setSelectionRange(0, 5) })
  await context.change(() => {
    textarea.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'u', ctrlKey: true, bubbles: true, cancelable: true }))
    context.document.getElementById('outside')!.focus()
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
  assert.equal(context.document.activeElement!.id, 'outside')
  assert.equal(changes, 0); assert.equal(checkpoints, 0)
  assert.equal(block.content, 'alpha beta')
}))

for (const activity of ['foreign-focus-return', 'window-blur', 'pointer', 'keyboard', 'composition'] as const) {
  test(`a cold block menu permanently abandons ${activity} before claiming focus`, async () => withDom(async context => {
    const opener = context.document.getElementById('opener')!, outside = context.document.getElementById('outside')!
    await context.change(() => opener.focus())
    const pending = createColdBlockPopup(opener)
    await context.change(() => {
      if (activity === 'foreign-focus-return') { outside.focus(); opener.focus() }
      else if (activity === 'window-blur') context.window.dispatchEvent(new context.window.Event('blur'))
      else if (activity === 'pointer') opener.dispatchEvent(new context.window.Event('pointerdown', { bubbles: true }))
      else if (activity === 'keyboard') opener.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      else opener.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true }))
    })
    assert.equal(pending.vetoed(), true)
    let closes = 0
    await context.render(createElement(BlockContextMenu, menuProps({ canOpen: pending.claim, onClose: () => { closes++ } })))
    assert.equal(context.document.activeElement, opener)
    assert.equal(closes, 1)
    assert.equal(pending.claim(), false, 'Returning to the original focus cannot revive a canceled lazy request')
    pending.dispose()
  }))
}

test('a claimed lazy popup separates cold eligibility from return-focus ownership and supports exact handoff', async () => withDom(async context => {
  const opener = context.document.getElementById('opener')!
  await context.change(() => opener.focus())
  const pending = createColdBlockPopup(opener)
  assert.equal(pending.claim(), true)
  await context.change(() => context.document.getElementById('outside')!.focus())
  assert.equal(pending.vetoed(), false)
  assert.equal(pending.canRestore(), false)
  assert.equal(pending.claim(), true)
  pending.dispose()
  assert.equal(pending.claim(), false, 'An explicitly closed opening is expired')
  const scope = context.document.createElement('div'), action = context.document.createElement('button')
  scope.append(action); context.document.body.append(scope)
  await context.change(() => action.focus())
  const handoff = createColdBlockPopup(opener, scope)
  await context.change(() => { scope.remove(); opener.focus() })
  assert.equal(handoff.vetoed(), false)
  assert.equal(handoff.claim(), true)
  handoff.dispose()
}))

for (const activity of ['window-blur', 'foreign-focus-return'] as const) test(`a claimed menu does not restore its opener after ${activity}`, async () => withDom(async context => {
  const opener = context.document.getElementById('opener')!, outside = context.document.getElementById('outside')!
  await context.change(() => opener.focus())
  const pending = createColdBlockPopup(opener)
  let returnCalls = 0
  const focus = opener.focus.bind(opener)
  opener.focus = options => { returnCalls++; focus(options) }
  await context.render(createElement(BlockContextMenu, menuProps({ canOpen: () => pending.claim(context.document.querySelector<HTMLElement>('.block-context-menu')),
    canReturnFocus: pending.canRestore })))
  const action = context.document.querySelector<HTMLButtonElement>('.block-context-menu button')!
  await context.change(() => {
    if (activity === 'window-blur') context.window.dispatchEvent(new context.window.Event('blur'))
    else { outside.focus(); action.focus() }
  })
  assert.equal(pending.canRestore(), false)
  await context.render(null)
  assert.equal(returnCalls, 0)
  assert.notEqual(context.document.activeElement, opener)
  pending.dispose()
}))
