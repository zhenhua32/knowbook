import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentDetail } from '../src/shared/contracts'
import { getUiText } from '../src/renderer/src/i18n'
import { getRichTextHistoryBridge } from '../src/renderer/src/rich-text/history'
import { useBlockCollapseState } from '../src/renderer/src/hooks/useBlockCollapseState'
import { useSingleBlockTreeActions } from '../src/renderer/src/hooks/useSingleBlockTreeActions'
import { useBlockStructureActions } from '../src/renderer/src/hooks/useBlockStructureActions'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { useDocumentFoldingActions } from '../src/renderer/src/hooks/useDocumentFoldingActions'
import { useBlockSelectionState } from '../src/renderer/src/hooks/useBlockSelectionState'
import { getVisibleDocumentEntries } from '../src/renderer/src/utils/documentSections'
import { BLOCK_CONVERSION_TYPES } from '../src/renderer/src/utils/blockConversionTypes'
import { serializeBlocksToMarkdown } from '../src/shared/markdown'
import type { BlockEditorRowProps } from '../src/renderer/src/components/BlockEditorRow'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
}`)}`, import.meta.url)
let DocumentRichTextEditor: typeof import('../src/renderer/src/rich-text/DocumentRichTextEditor')['DocumentRichTextEditor']
let BlockEditorRow: typeof import('../src/renderer/src/components/BlockEditorRow')['BlockEditorRow']
// Preload the lazy UI module, without replacing the real components or handlers.
await import('../src/renderer/src/components/NativeContainerControls')

const block = (id: string, type: string, content: string, depth = 0, parentBlockId: string | null = null): DocumentBlockDraft => ({ id, type, content, depth, parentBlockId, checked: false })
const noop = () => {}
async function nativeControlReady(dom: JSDOM, label: string) {
  const selector = `select[aria-label="${label}"]`
  let disconnectControl = noop
  try {
    const controlReady = new Promise<void>(resolve => {
      const check = () => {
        if (dom.window.document.querySelector(selector)) { observer.disconnect(); resolve() }
      }
      const observer = new dom.window.MutationObserver(check)
      disconnectControl = () => observer.disconnect()
      observer.observe(dom.window.document.getElementById('mount')!, { childList: true, subtree: true })
      check()
    })
    await act(async () => { await import('../src/renderer/src/components/NativeContainerControls') })
    // Wait outside act so React can commit the real private lazy boundary.
    await controlReady
    await act(async () => {})
  } finally { disconnectControl() }
}
async function withDom(run: (context: { dom: JSDOM; root: import('react-dom/client').Root; select: (label: string, value: string) => Promise<void> }) => Promise<void>) {
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
  ;({ DocumentRichTextEditor } = await import('../src/renderer/src/rich-text/DocumentRichTextEditor'))
  ;({ BlockEditorRow } = await import('../src/renderer/src/components/BlockEditorRow'))
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  try { await run({ dom, root, select: async (label, value) => {
    await nativeControlReady(dom, label)
    const select = dom.window.document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
    assert.ok(select, label)
    await act(async () => { select.value = value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
  } }) } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('real rich callout controls change finite metadata, retain title selection and children, and delegate mixed child insertion', async () => {
  await withDom(async ({ dom, root, select }) => {
    const initial = [block('owner', 'callout', '**Title**'), block('code', 'code', 'const x = 1', 1, 'owner'), block('task', 'todo', 'Task', 1, 'owner')]
    let current = initial, checkpoints = 0
    const added: Array<[string, string]> = []
    function Harness() {
      const [blocks, setBlocks] = useState(initial)
      return createElement(DocumentRichTextEditor, { blocks, visibleIndices: [0, 1, 2], documentId: 'rich-controls', isZh: false,
        checkpoint: () => { checkpoints++ }, onChange: next => { current = next; setBlocks(next) }, onUndo: noop, onRedo: noop,
        onRevealBlock: noop, onEditSource: noop, onAddContainerChild: (id, type) => { added.push([id, type]) } })
    }
    await act(async () => root.render(createElement(Harness)))
    const editor = dom.window.document.querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    const bridge = getRichTextHistoryBridge(editor)!
    await act(async () => bridge.restore({ blockId: 'owner', index: 0, start: 4, end: 1, direction: 'backward',
      richText: { anchor: { blockId: 'owner', index: 0, offset: 4 }, head: { blockId: 'owner', index: 0, offset: 1 } } }))
    const bookmark = bridge.capture()
    await select('Callout kind', 'warning'); await select('Callout icon', 'book'); await select('Callout tone', 'purple')
    assert.deepEqual(current[0].markdownFormat, { calloutKind: 'warning', calloutIcon: 'book', calloutTone: 'purple' })
    assert.equal(editor.querySelector('[data-block-id="owner"]')?.getAttribute('data-native-container-tone'), 'purple')
    assert.equal(editor.querySelector('.native-container-icon')?.getAttribute('data-native-container-icon'), 'book')
    assert.equal(editor.querySelector('[data-block-id="owner"]')?.textContent, 'Title', 'decoration icons stay out of body text')
    assert.deepEqual(bridge.capture().richText, bookmark.richText)
    assert.deepEqual(current.slice(1), initial.slice(1))
    assert.ok(checkpoints >= 6, 'each metadata gesture is separate from later typing')
    assert.deepEqual(Array.from(dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="Child block type"]')!.options).map(option => option.value), [...BLOCK_CONVERSION_TYPES])
    await select('Child block type', 'table')
    await act(async () => Array.from(dom.window.document.querySelectorAll('button')).find(button => button.textContent === 'Add child block')!.click())
    assert.deepEqual(added, [['owner', 'table']])
    const before = current
    await act(async () => editor.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true })))
    await select('Callout tone', 'red')
    assert.equal(current, before, 'composition prevents a format transaction')
  })
})

test('real rich toggle folding uses personal overrides while default-open author metadata remains editable', async () => {
  await withDom(async ({ dom, root }) => {
    const initial = [block('owner', 'toggle', 'Toggle'), block('child', 'paragraph', 'Body', 1, 'owner'), block('outside', 'paragraph', 'Outside')]
    initial[0].markdownFormat = { toggleDefaultOpen: false }
    let current = initial
    function Harness() {
      const [blocks, setBlocks] = useState(initial), folding = useBlockCollapseState({ documentId: 'toggle-ui', draftBlocks: blocks })
      return createElement(DocumentRichTextEditor, { blocks, documentId: 'toggle-ui', isZh: false,
        visibleIndices: getVisibleDocumentEntries(blocks, folding.foldView).map(entry => entry.index), collapsedBlockIds: folding.collapsedBlockIds,
        onToggleCollapse: id => {
          const open = folding.collapsedBlockIds.has(id), collapsedIds = new Set(folding.collapsedBlockIds)
          if (open) collapsedIds.delete(id); else collapsedIds.add(id)
          folding.setFoldView({ ...folding.foldView, collapsedIds, toggleOpenOverrides: new Map([[id, open]]) })
        }, checkpoint: noop, onChange: next => { current = next; setBlocks(next) }, onUndo: noop, onRedo: noop,
        onRevealBlock: folding.revealBlockAncestors, onEditSource: noop })
    }
    await act(async () => root.render(createElement(Harness)))
    const title = dom.window.document.querySelector<HTMLElement>('[data-block-id="owner"]')!
    assert.equal(title.querySelector('button')?.getAttribute('aria-expanded'), 'false')
    assert.equal((dom.window.document.querySelector('[data-block-id="child"]') as HTMLElement).style.display, 'none')
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[data-block-id="owner"] .native-toggle-control')!.click())
    assert.equal((dom.window.document.querySelector('[data-block-id="child"]') as HTMLElement).style.display, '')
    assert.deepEqual(current[0].markdownFormat, { toggleDefaultOpen: false })
    const authored = dom.window.document.querySelector<HTMLInputElement>('.native-container-controls input[type="checkbox"]')!
    await act(async () => authored.click())
    assert.deepEqual(current[0].markdownFormat, { toggleDefaultOpen: true })
    const editor = dom.window.document.querySelector<HTMLElement>('.knowbook-rich-text-editor')!, bridge = getRichTextHistoryBridge(editor)!
    await act(async () => bridge.restore({ blockId: 'child', index: 1, start: 3, end: 1, direction: 'backward',
      richText: { anchor: { blockId: 'child', index: 1, offset: 3 }, head: { blockId: 'child', index: 1, offset: 1 } } }))
    const childSelection = bridge.capture().richText
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[data-block-id="owner"] .native-toggle-control')!.click())
    assert.equal((dom.window.document.querySelector('[data-block-id="child"]') as HTMLElement).style.display, 'none')
    assert.equal(bridge.capture().blockId, 'owner', 'a folded child caret moves to the visible owner title')
    assert.deepEqual(current[0].markdownFormat, { toggleDefaultOpen: true })
    const foreign = dom.window.document.createElement('input'); dom.window.document.body.append(foreign); foreign.focus()
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[data-block-id="owner"] .native-toggle-control')!.click())
    assert.deepEqual(bridge.capture().richText, childSelection, 'unfolding restores the unchanged backward bookmark')
    assert.equal(dom.window.document.activeElement, foreign, 'restoring a bookmark does not take another input focus')
  })
})

test('reader renders native owner titles once and complete Markdown shells retain finite callout and authored toggle presentation', async () => {
  await withDom(async ({ dom, root }) => {
    const { BlockReadingRow } = await import('../src/renderer/src/components/BlockReadingRow')
    const { MarkdownContent } = await import('../src/renderer/src/components/MarkdownContent')
    await import('../src/renderer/src/components/NativeMarkdownNode')
    const owner = block('owner', 'callout', '**Heading**')
    owner.markdownFormat = { calloutKind: 'tip', calloutIcon: 'check', calloutTone: 'green' }
    const toggle = block('toggle', 'toggle', '*Nested*', 1, 'owner')
    toggle.markdownFormat = { toggleDefaultOpen: false }
    const source = serializeBlocksToMarkdown([owner, toggle, block('body', 'paragraph', 'Body', 2, 'toggle')])
    await act(async () => root.render(createElement('div', null,
      createElement(BlockReadingRow, { block: owner, index: 0, indentPx: 0, numberLabel: '', isHighlighted: false, hasChildren: true,
        collapsed: false, onToggleCollapse: noop, onNavigateReference: noop, ui: getUiText('en-US'), isZh: false }),
      createElement('section', { id: 'full-markdown' }, createElement(MarkdownContent, { content: source })))))
    await act(async () => { await import('../src/renderer/src/components/NativeMarkdownNode'); await import('../src/renderer/src/components/NativeContainerStyle'); await new Promise<void>(resolve => setImmediate(resolve)) })
    const reading = dom.window.document.querySelector('.document-reading-row')!
    assert.equal(reading.getAttribute('data-native-container-tone'), 'green')
    assert.equal(reading.querySelector('.native-container-title strong')?.textContent, 'Heading')
    assert.equal(reading.querySelector('.native-container-icon')?.getAttribute('data-native-container-icon'), 'check')
    const shell = dom.window.document.querySelector('#full-markdown aside[data-native-container="callout"]')!
    assert.ok(shell); assert.equal(shell.getAttribute('data-native-container-tone'), 'green')
    assert.equal(shell.querySelectorAll('.native-container-title strong').length, 1)
    const details = shell.querySelector<HTMLDetailsElement>('details[data-native-container="toggle"]')!
    assert.ok(details); assert.equal(details.open, false); assert.equal(details.querySelector('summary em')?.textContent, 'Nested')
    assert.equal(details.textContent, 'NestedBody')
  })
})

test('rich conversion exposes all eighteen types and splitting a native title creates a paragraph child without duplicating its owner', async () => {
  await withDom(async ({ dom, root, select }) => {
    const initial = [block('owner', 'callout', 'TitleTail'), block('old-child', 'todo', 'Task', 1, 'owner'), block('outside', 'paragraph', 'Outside')]
    let current = initial
    function Harness() {
      const [blocks, setBlocks] = useState(initial)
      return createElement(DocumentRichTextEditor, { blocks, visibleIndices: blocks.map((_value, index) => index), documentId: 'split-ui', isZh: false,
        checkpoint: noop, onChange: next => { current = next; setBlocks(next) }, onUndo: noop, onRedo: noop, onRevealBlock: noop, onEditSource: noop })
    }
    await act(async () => root.render(createElement(Harness)))
    assert.deepEqual(Array.from(dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="Block type"]')!.options).map(option => option.value), [...BLOCK_CONVERSION_TYPES])
    const editor = dom.window.document.querySelector<HTMLElement>('.knowbook-rich-text-editor')!, bridge = getRichTextHistoryBridge(editor)!
    await act(async () => bridge.restore({ blockId: 'owner', index: 0, start: 5, end: 5, direction: 'none',
      richText: { anchor: { blockId: 'owner', index: 0, offset: 5 }, head: { blockId: 'owner', index: 0, offset: 5 } } }))
    await act(async () => editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    assert.equal(current.length, 4)
    assert.equal(current[0].id, 'owner'); assert.equal(current[0].type, 'callout'); assert.equal(current[0].content, 'Title')
    assert.equal(current[1].type, 'paragraph'); assert.equal(current[1].content, 'Tail'); assert.equal(current[1].parentBlockId, 'owner')
    assert.deepEqual(current[2], initial[1]); assert.deepEqual(current[3], initial[2])
    await select('Block type', 'toggle')
    assert.equal(current[1].type, 'toggle'); assert.equal(current[1].parentBlockId, 'owner')
  })
})

function rowProps(blocks: DocumentBlockDraft[], patches: Array<Partial<DocumentBlockDraft>>, added: Array<string>, continued: Array<number>, checkpoints: { value: number }): BlockEditorRowProps {
  return { block: blocks[0], index: 0, draftBlockCount: blocks.length, getDraftBlocks: () => blocks, selectedDocument: { id: 'source', title: 'Source' },
    isSelected: false, isHighlighted: false, hasChildren: true, dropPreview: null, indentPx: 0, numberLabel: '', activeBlockIndex: null,
    collapsedBlockIds: new Set(), activeSlashContext: null, filteredSlashCommands: [], activeSlashCommand: null,
    selectedBlockRange: null, selectedBlockCount: 0, blockTextareaRefs: { current: [] },
    updateDraftBlock: (_index, patch) => patches.push(patch), checkpointDraft: () => { checkpoints.value++ }, updateBlockHighlight: noop,
    insertDraftBlockAt: noop, insertChildDraftBlock: (_index, _content, type) => added.push(type!), handleBlockContentChange: noop,
    navigateInlineReferenceAtCursor: noop, captureBlockCursor: noop, handleBlockPaste: () => false, beginBlockDrag: noop, endBlockDrag: noop,
    getDraggedBlockDepthPreview: () => null, dropBlockAt: noop, setDragOverBlockIndex: noop, setDragOverBlockDepth: noop,
    moveSelectedBlocks: noop, moveDraftBlockBySibling: noop, setSelectedSlashCommandIndex: noop, applySlashCommand: noop, dismissSlashCommand: noop,
    adjustSelectedBlocksDepth: noop, adjustBlockDepth: noop, deleteSelectedBlocks: noop, duplicateSelectedBlocks: noop, duplicateDraftBlock: noop,
    selectBlockRange: noop, selectAllBlocks: noop, notifyBlockMouseDown: noop, handleBlockMouseEnter: noop, endBlockRangeSelection: noop,
    isBlockRangeSelecting: false, continueBlockAt: (_index, start) => continued.push(start), downgradeBlockAt: noop, mergeWithPreviousBlock: noop,
    splitDraftBlock: noop, toggleBlockCollapse: noop, isSelectionCoherent: () => true, getVisibleBlockCountInRange: () => 0,
    getMultiBlockOperationRange: range => range, removeSelectedBlockRange: noop, canMoveSelectedRange: () => false, onOpenSelectionAiEditor: noop,
    BLOCK_INDENT_SIZE: 24, ui: getUiText('en-US'), isZh: false }
}

test('real source row exposes native title and finite controls, creates mixed children, and protects Enter and settings during IME', async () => {
  await withDom(async ({ dom, root, select }) => {
    const blocks = [block('owner', 'callout', 'TitleTail')], patches: Array<Partial<DocumentBlockDraft>> = [], added: string[] = [], continued: number[] = [], checkpoints = { value: 0 }
    await act(async () => root.render(createElement(BlockEditorRow, rowProps(blocks, patches, added, continued, checkpoints))))
    await act(async () => { await import('../src/renderer/src/components/NativeContainerControls'); await new Promise<void>(resolve => setImmediate(resolve)) })
    const title = dom.window.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Callout title"]')!
    assert.ok(title)
    await select('Callout kind', 'danger')
    assert.deepEqual(patches.at(-1), { markdownFormat: { calloutKind: 'danger' } })
    assert.equal(checkpoints.value, 2)
    await select('Child block type', 'code')
    await act(async () => Array.from(dom.window.document.querySelectorAll('button')).find(button => button.textContent === 'Add child block')!.click())
    assert.deepEqual(added, ['code'])
    await act(async () => { title.focus(); title.setSelectionRange(5, 5) })
    await act(async () => title.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    assert.deepEqual(continued, [5])
    await act(async () => title.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true })))
    await select('Callout tone', 'red')
    await act(async () => title.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })))
    assert.equal(patches.length, 1); assert.deepEqual(continued, [5]); assert.equal(checkpoints.value, 2)
  })
})

async function withSourceTree(initial: DocumentBlockDraft[], run: (api: {
  dom: JSDOM; blocks: () => DocumentBlockDraft[]; input: () => HTMLTextAreaElement; key: (shift?: boolean, composing?: boolean) => Promise<KeyboardEvent>
  histories: DocumentBlockDraft[][]; changes: () => number
}) => Promise<void>) {
  await withDom(async ({ dom, root }) => {
    let current = initial, changeCount = 0
    const histories: DocumentBlockDraft[][] = []
    function Harness() {
      const [blocks, setBlocks] = useState(initial), [active, setActive] = useState<number | null>(null), [cursor, setCursor] = useState(0)
      current = blocks
      const update = (index: number, patch: Partial<DocumentBlockDraft>) => {
        changeCount++; setBlocks(previous => previous.map((value, position) => position === index ? { ...value, ...patch } : value))
      }
      const actions = useSingleBlockTreeActions({ draftBlocks: blocks, activeCursorPosition: cursor,
        buildBlockTypePatch: (type, content, checked = false, depth = 0, parentBlockId = null) => ({ type, content, checked, depth, parentBlockId }),
        clearBlockSelection: noop, endBlockDrag: noop, pushToHistory: snapshot => histories.push(structuredClone(snapshot)),
        setActiveBlockIndex: setActive, setActiveCursorPosition: setCursor, setDraftBlocks: setBlocks, setPendingFocusBlockIndex: noop,
        splitDraftBlock: noop, updateDraftBlock: update })
      const index = blocks.findIndex(value => value.id === 'target')
      const props = rowProps(blocks, [], [], [], { value: 0 })
      return createElement(BlockEditorRow, { ...props, block: blocks[index], index, indentPx: blocks[index].depth * 24,
        hasChildren: false, activeBlockIndex: active, getDraftBlocks: () => current, adjustBlockDepth: actions.adjustBlockDepth,
        updateDraftBlock: update, handleBlockContentChange: (position, content) => update(position, { content }),
        captureBlockCursor: (position, input) => { setActive(position); setCursor(input.selectionStart) } })
    }
    await act(async () => root.render(createElement(Harness)))
    const input = () => dom.window.document.querySelector<HTMLTextAreaElement>('[data-block-id="target"] .block-inline-textarea')!
    await act(async () => {
      const details = input().closest<HTMLDetailsElement>('details.markdown-table-source')
      if (details) { details.open = true; details.dispatchEvent(new dom.window.Event('toggle')) }
      input().focus(); input().setSelectionRange(2, 2)
    })
    await act(async () => {
      await import('../src/renderer/src/components/BlockFormatToolbar'); await import('../src/renderer/src/components/SourceInlinePresentationToolbar')
      if (initial.find(value => value.id === 'target')?.type === 'table') await import('../src/renderer/src/components/MarkdownTableEditor')
      if (initial.find(value => value.id === 'target')?.type === 'code') await import('../src/renderer/src/components/CodeBlockPreview')
      if (initial.find(value => value.id === 'target')?.type === 'math') await import('../src/renderer/src/components/MathBlockPreview')
      await new Promise<void>(resolve => setImmediate(resolve))
    })
    await run({ dom, blocks: () => current, input, histories, changes: () => changeCount, key: async (shift = false, composing = false) => {
      const event = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, isComposing: composing, bubbles: true, cancelable: true })
      await act(async () => input().dispatchEvent(event))
      return event as KeyboardEvent
    } })
  })
}

for (const type of ['paragraph', 'quote', 'heading-2']) {
  test(`actual mixed ${type} Shift+Tab outdents and Tab finds its native sibling past the complete nested subtree`, async () => {
    const initial = [block('owner', 'toggle', 'Owner'), block('inner', 'callout', 'Inner', 1, 'owner'),
      block('code', 'code', 'const x = 1', 2, 'inner'), block('target', type, '**Unicode 😀 text**', 1, 'owner')]
    await withSourceTree(initial, async api => {
      const content = initial.at(-1)!.content
      assert.equal((await api.key(true)).defaultPrevented, true)
      assert.deepEqual(api.blocks().at(-1), { ...initial.at(-1), depth: 0, parentBlockId: null })
      assert.deepEqual(api.blocks().slice(0, -1), initial.slice(0, -1))
      assert.equal(api.histories.length, 1); assert.equal(api.changes(), 0)
      assert.equal(api.dom.window.document.activeElement, api.input())
      assert.equal((await api.key()).defaultPrevented, true)
      assert.deepEqual(api.blocks(), initial)
      assert.equal(api.blocks().at(-1)!.content, content)
      assert.equal(api.histories.length, 2); assert.equal(api.changes(), 0)
      await act(async () => api.input().dispatchEvent(new api.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
      assert.equal((await api.key(true, true)).defaultPrevented, false)
      assert.deepEqual(api.blocks(), initial); assert.equal(api.histories.length, 2)
    })
  })
}

for (const [type, content] of [['code', 'alpha'], ['math', 'x + y'], ['table', '| A |\n| - |\n| value |'], ['html', '<kbd>value</kbd>']] as const) {
  test(`actual ${type} source inside a native owner retains text indentation rather than changing its tree`, async () => {
    const initial = [block('owner', 'callout', 'Owner'), block('target', type, content, 1, 'owner')]
    await withSourceTree(initial, async api => {
      assert.equal((await api.key()).defaultPrevented, true)
      assert.equal(api.blocks()[1].content, content.slice(0, 2) + '  ' + content.slice(2))
      assert.equal(api.blocks()[1].depth, 1); assert.equal(api.blocks()[1].parentBlockId, 'owner'); assert.equal(api.histories.length, 0)
    })
  })
}

test('ordinary root prose Shift+Tab retains its format toolbar without changing its tree or content', async () => {
  const initial = [block('target', 'paragraph', 'Ordinary root text')]
  await withSourceTree(initial, async api => {
    assert.equal((await api.key(true)).defaultPrevented, true)
    assert.ok(api.dom.window.document.activeElement?.closest('.markdown-format-toolbar'))
    assert.deepEqual(api.blocks(), initial); assert.equal(api.histories.length, 0); assert.equal(api.changes(), 0)
  })
})

type ChildInterruption = 'foreign-focus' | 'blur' | 'key' | 'composition' | 'session' | 'hidden' | 'changed-source' | 'unmount'
async function withRichChildAction(type: typeof BLOCK_CONVERSION_TYPES[number], run: (api: {
  dom: JSDOM; editor: () => ReturnType<typeof useDocumentEditorState>; id: () => string | undefined; initial: DocumentBlockDraft[];
  click: () => Promise<void>; edits: () => number; pendingSourceFocus: () => [number | null, number | undefined] | undefined;
}) => Promise<void>, interruption?: ChildInterruption, tableContent?: string) {
  await withDom(async ({ dom, root, select }) => {
    const initial = [block('owner', 'callout', '**Owner**'), block('old-child', 'todo', 'Existing', 1, 'owner'), block('outside', 'paragraph', 'Outside')]
    initial[0].markdownFormat = { calloutKind: 'warning', calloutIcon: 'pin', calloutTone: 'pink' }
    initial[1].tags = ['identity']; initial[1].highlight = 'blue'; initial[1].checked = true
    let editor!: ReturnType<typeof useDocumentEditorState>, newId: string | undefined, edits = 0
    let sourceFocus: [number | null, number | undefined] | undefined
    const foreign = dom.window.document.createElement('input'); foreign.id = 'foreign'; dom.window.document.body.append(foreign)
    function Harness() {
      editor = useDocumentEditorState({ selectedDocumentId: null, selectedDocument: null, ui: getUiText('en-US'),
        onHomeDataChange: noop, onSelectedDocumentChange: noop, onMessage: noop })
      const [documentId, setDocumentId] = useState('child-focus'), [shown, setShown] = useState(true)
      const actions = useBlockStructureActions({ draftBlocks: editor.draftBlocks, setDraftBlocks: editor.setDraftBlocks, pushToHistory: editor.pushToHistory,
        clearBlockSelection: noop, endBlockDrag: noop, setActiveBlockIndex: noop, setActiveCursorPosition: noop,
        setPendingFocusBlockIndex: (index, offset) => { sourceFocus = [index, offset] },
        buildBlockTypePatch: (kind, content, checked = false, depth = 0, parentBlockId = null) =>
          ({ type: kind, content: kind === 'table' ? tableContent ?? content : content, checked, depth, parentBlockId }) })
      return shown && editor.draftBlocks.length ? createElement(DocumentRichTextEditor, { blocks: editor.draftBlocks,
        visibleIndices: editor.draftBlocks.map((_block, index) => index).filter(index => interruption !== 'hidden' || editor.draftBlocks[index].id !== newId),
        documentId, isZh: false, checkpoint: editor.checkpointDraft, onChange: editor.setDraftBlocks,
        onUndo: editor.undoEdit, onRedo: editor.redoEdit, onRevealBlock: noop, onEditSource: () => { edits++ },
        onAddContainerChild: (parentId, childType) => {
          newId = actions.insertChildDraftBlock(editor.getDraftBlocks().findIndex(value => value.id === parentId), undefined, childType)
          if (interruption === 'foreign-focus') foreign.focus()
          if (interruption === 'blur') dom.window.dispatchEvent(new dom.window.Event('blur'))
          if (interruption === 'key') dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
          if (interruption === 'composition') dom.window.document.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }))
          if (interruption === 'session') { foreign.focus(); setDocumentId('another-session') }
          if (interruption === 'changed-source') { foreign.focus(); editor.updateDraftBlock(2, { content: 'Another edit' }) }
          if (interruption === 'unmount') { foreign.focus(); setShown(false) }
          return newId
        } }) : null
    }
    await act(async () => root.render(createElement(Harness)))
    await act(async () => editor.loadDocumentIntoEditor({ id: 'child-focus', title: 'Focus', summary: '', blocks: initial } as DocumentDetail))
    const body = dom.window.document.querySelector<HTMLElement>('.knowbook-rich-text-editor')!, bridge = getRichTextHistoryBridge(body)!
    await act(async () => bridge.restore({ blockId: 'owner', index: 0, start: 0, end: 0, direction: 'none',
      richText: { anchor: { blockId: 'owner', index: 0, offset: 0 }, head: { blockId: 'owner', index: 0, offset: 0 } } }))
    await select('Child block type', type)
    const button = Array.from(dom.window.document.querySelectorAll('button')).find(value => value.textContent === 'Add child block')!
    await run({ dom, editor: () => editor, id: () => newId, initial: editor.draftBlocks, edits: () => edits,
      pendingSourceFocus: () => sourceFocus, click: async () => { await act(async () => { button.focus(); button.click() }) } })
  })
}

for (const type of BLOCK_CONVERSION_TYPES) test(`real rich Add child ${type} focuses its stable new block, retains the forest and adds one undo step`, async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try { await withRichChildAction(type, async api => {
    await api.click()
    const blocks = api.editor().draftBlocks.map(value => ({ ...value, tags: value.tags, markdownFormat: value.markdownFormat })), id = api.id()!, child = blocks.find(value => value.id === id)!
    assert.ok(id); assert.equal(child.type, type); assert.equal(child.depth, 1); assert.equal(child.parentBlockId, 'owner')
    assert.equal(child.content, '', 'focus does not rewrite the default child payload')
    assert.deepEqual(blocks.filter(value => value.id !== id), api.initial)
    assert.deepEqual(api.pendingSourceFocus(), [2, 0], 'the existing source-mode focus path remains intact')
    const body = api.dom.window.document.querySelector<HTMLElement>('.knowbook-rich-text-editor')!, bridge = getRichTextHistoryBridge(body)!
    assert.equal(bridge.capture().blockId, id)
    if (['code', 'math', 'table'].includes(type)) {
      const entry = api.dom.window.document.querySelector<HTMLElement>(`[data-block-id="${id}"] [data-rich-source-entry]`)!
      assert.ok(entry); assert.equal(api.dom.window.document.activeElement, entry); assert.equal(api.edits(), 0, 'creation never opens the whole-document source dialog')
      await act(async () => entry.click()); assert.equal(api.edits(), 1, 'the actual public source entry still works')
    } else {
      assert.equal(api.dom.window.document.activeElement, body)
      if (type !== 'divider') assert.deepEqual(bridge.capture().richText, {
        anchor: { blockId: id, index: 2, offset: 0 }, head: { blockId: id, index: 2, offset: 0 } })
    }
    assert.equal(api.editor().canUndo, true)
    await act(async () => api.editor().undoEdit()); await act(async () => context.mock.timers.tick(0))
    assert.deepEqual(api.editor().draftBlocks, api.initial); assert.equal(api.editor().canUndo, false, 'creation is exactly one undo step')
    await act(async () => api.editor().redoEdit()); await act(async () => context.mock.timers.tick(0))
    assert.deepEqual(api.editor().draftBlocks, blocks, 'redo retains the same child ID and complete metadata')
  }) } finally { context.mock.timers.reset() }
})

for (const interruption of ['foreign-focus', 'blur', 'key', 'composition', 'session', 'hidden', 'changed-source', 'unmount'] as const) {
  test(`real rich Add child does not reclaim focus after ${interruption}`, async () => {
    await withRichChildAction('quote', async api => {
      await api.click()
      assert.ok(api.editor().draftBlocks.some(value => value.id === api.id()), 'the authorized insertion still completes')
      const body = api.dom.window.document.querySelector<HTMLElement>('.knowbook-rich-text-editor')
      assert.notEqual(api.dom.window.document.activeElement, body)
      if (['foreign-focus', 'session', 'changed-source', 'unmount'].includes(interruption)) assert.equal(api.dom.window.document.activeElement?.id, 'foreign')
      if (body && interruption !== 'session') assert.equal(getRichTextHistoryBridge(body)!.capture().blockId, 'owner', 'vetoed focus does not move the old body caret')
      await act(async () => new Promise<void>(resolve => setImmediate(resolve)))
      assert.notEqual(api.dom.window.document.activeElement, body, 'there is no deferred frame that reclaims the editor')
    }, interruption)
  })
}

test('real rich Add child valid table waits for its portal and focuses the first public cell', async () => {
  await withRichChildAction('table', async api => {
    await api.click()
    await act(async () => { await import('../src/renderer/src/components/MarkdownTableEditor'); await new Promise<void>(resolve => setImmediate(resolve)) })
    const cell = api.dom.window.document.querySelector<HTMLElement>(`[data-block-id="${api.id()}"] [data-row="0"][data-column="0"]`)!
    assert.ok(cell); assert.equal(api.dom.window.document.activeElement, cell); assert.equal(api.edits(), 0)
  }, undefined, '| A | B |\n| - | - |\n| x | y |')
})

for (const mode of ['source', 'rich'] as const) test(`${mode} actual author controls and personal folding share visible rows and keep the expanded mixed forest across reload`, async () => {
  await withDom(async ({ dom, root }) => {
    const initial = [block('owner', 'toggle', 'Owner'), block('child', 'callout', 'Mixed child', 1, 'owner'),
      block('grandchild', 'code', 'const x = 1', 2, 'child'), block('outside', 'paragraph', 'Outside')]
    initial[0].markdownFormat = { toggleDefaultOpen: false }
    initial[1].tags = ['retained']; initial[1].markdownFormat = { calloutTone: 'green' }
    let current!: { blocks: DocumentBlockDraft[]; folding: ReturnType<typeof useBlockCollapseState>; selection: ReturnType<typeof useBlockSelectionState> }
    function Harness() {
      const [blocks, setBlocks] = useState(initial), [activeBlockIndex, setActiveBlockIndex] = useState<number | null>(0)
      const refs = useRef<Array<HTMLTextAreaElement | null>>([])
      const folding = useBlockCollapseState({ draftBlocks: blocks, documentId: 'integrated-toggle' })
      const selection = useBlockSelectionState({ draftBlocks: blocks, activeBlockIndex, onActiveBlockChange: setActiveBlockIndex,
        collapsedBlockIds: folding.collapsedBlockIds, focusedHeadingId: folding.focusedHeadingId,
        toggleOpenOverrides: folding.foldView.toggleOpenOverrides, visibleSliceCrossParentGuard: 'Cross parent', selectionStaleGuard: 'Stale' })
      const actions = useDocumentFoldingActions({ documentId: 'integrated-toggle', draftBlocks: blocks, sections: folding.sections,
        foldView: folding.foldView, setFoldView: folding.setFoldView, activeBlockIndex, setActiveBlockIndex,
        selectedBlockRange: selection.selectedBlockRange, clearBlockSelection: selection.clearBlockSelection,
        setSelectedBlockRange: selection.setSelectedBlockRange, setSelectionAnchorBlockId: selection.setSelectionAnchorBlockId,
        blockTextareaRefs: refs, setActiveCursorPosition: noop, setPendingFocusBlockIndex: noop, clearEditorAssistSuggestions: noop, endBlockDrag: noop, onScrollToBlock: noop })
      current = { blocks, folding, selection }
      const entries = selection.getVisibleBlockEntries(blocks)
      if (mode === 'rich') return createElement(DocumentRichTextEditor, { blocks, visibleIndices: entries.map(entry => entry.index), documentId: 'integrated-toggle',
        isZh: false, checkpoint: noop, onChange: setBlocks, onUndo: noop, onRedo: noop, onEditSource: noop,
        onRevealBlock: folding.revealBlockAncestors, collapsedBlockIds: folding.collapsedBlockIds, onToggleCollapse: actions.toggleBlockCollapse })
      return createElement('div', { className: 'block-editor-list' }, entries.map(({ block: value, index }) =>
        createElement(BlockEditorRow, { ...rowProps(blocks, [], [], [], { value: 0 }), key: value.id, block: value, index,
          hasChildren: folding.blockHasChildren(index), collapsedBlockIds: folding.collapsedBlockIds, activeBlockIndex,
          blockTextareaRefs: refs, toggleBlockCollapse: actions.toggleBlockCollapse,
          updateDraftBlock: (position, patch) => setBlocks(previous => previous.map((item, offset) => offset === position ? { ...item, ...patch } : item)) })))
    }
    const rendered = (id: string) => {
      const row = dom.window.document.querySelector<HTMLElement>(`.block-editor-row[data-block-id="${id}"]`)
      return Boolean(row && row.style.display !== 'none')
    }
    const ids = () => current.selection.getVisibleBlockEntries(current.blocks).map(entry => entry.block.id)
    await act(async () => root.render(createElement(Harness, { key: 'initial' })))
    await act(async () => { await import('../src/renderer/src/components/NativeContainerControls'); await new Promise<void>(resolve => setImmediate(resolve)) })
    const authored = () => dom.window.document.querySelector<HTMLInputElement>('.native-container-controls input[type="checkbox"]')!
    assert.equal(authored().checked, false); assert.equal(rendered('child'), false); assert.deepEqual(ids(), ['owner', 'outside'])
    await act(async () => authored().click())
    assert.equal(authored().checked, true); assert.equal(rendered('child'), true); assert.equal(rendered('grandchild'), true)
    await act(async () => authored().click())
    assert.equal(authored().checked, false); assert.equal(rendered('child'), false)
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[data-block-id="owner"] .native-toggle-control')!.click())
    assert.equal(current.folding.foldView.toggleOpenOverrides?.get('owner'), true)
    assert.equal(authored().checked, false, 'the arrow only changes the personal fold override')
    assert.deepEqual(ids(), initial.map(value => value.id)); assert.equal(rendered('child'), true); assert.equal(rendered('grandchild'), true)
    assert.equal(current.selection.getVisibleBlockCountInRange({ start: 0, end: 3 }), 4, 'selection actions address the same expanded rows as the editor')
    assert.deepEqual(current.blocks, initial, 'author metadata and the mixed child forest remain exact')
    await act(async () => root.render(createElement(Harness, { key: 'reload' })))
    await act(async () => new Promise<void>(resolve => setImmediate(resolve)))
    assert.equal(authored().checked, false); assert.equal(rendered('child'), true); assert.equal(rendered('grandchild'), true)
    assert.deepEqual(ids(), initial.map(value => value.id), 'a new hook session reads the persisted personal expansion')
    assert.deepEqual(current.blocks, initial)
  })
})
