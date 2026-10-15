import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state'
import { DOMSerializer } from 'prosemirror-model'
import { JSDOM, VirtualConsole } from 'jsdom'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { parseDatabaseViewPayload, serializeDatabaseViewPayload, type DatabaseViewBlockPayloadV1 } from '../src/shared/databaseViewBlock'
import { parseMarkdownBlocks, serializeBlocksToMarkdown } from '../src/shared/markdown'
import { draftBlocksToRichDoc, richBlockEntries, richDocToDraftBlocks } from '../src/renderer/src/rich-text/model'
import { richTextSchema } from '../src/renderer/src/rich-text/schema'
import { richTextSliceMarkdown } from '../src/renderer/src/rich-text/clipboard'
import { richEndpoint, richSelectionFromBookmark, richSelectionKind } from '../src/renderer/src/rich-text/positions'
import { planRichDatabaseViewInsertion } from '../src/renderer/src/rich-text/databaseViewInsertion'
import { deleteCrossColumnSelection } from '../src/renderer/src/rich-text/columnEditing'

const payload = (databaseId = 'database-A'): DatabaseViewBlockPayloadV1 => ({ version: 1, databaseId, viewId: null,
  config: createDefaultDatabaseViewConfig('table') })
const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null })
const database = (id = 'embed'): DocumentBlockDraft => ({ ...paragraph(id, serializeDatabaseViewPayload(payload())), type: 'database-view', tags: ['keep'], highlight: 'blue' })
const columns = (): DocumentBlockDraft[] => [
  { ...paragraph('group', ''), type: 'columns' },
  { ...paragraph('left', ''), type: 'column', depth: 1, parentBlockId: 'group', markdownFormat: { columnWeight: 4000 } },
  { ...paragraph('alpha', 'Alpha'), depth: 2, parentBlockId: 'left' },
  { ...database(), depth: 2, parentBlockId: 'left' },
  { ...paragraph('right', ''), type: 'column', depth: 1, parentBlockId: 'group', markdownFormat: { columnWeight: 6000 } },
  { ...paragraph('beta', 'Beta'), depth: 2, parentBlockId: 'right' }
]

test('a database view is one true leaf atom and mixed columns round-trip its exact reference and public identity', () => {
  const input = columns(), doc = draftBlocksToRichDoc(input), entry = richBlockEntries(doc).find(({ node }) => node.attrs.block.id === 'embed')!
  assert.equal(entry.node.type, richTextSchema.nodes.database_view_block)
  assert.equal(entry.node.isAtom, true); assert.equal(entry.node.isLeaf, true); assert.equal(entry.node.childCount, 0)
  assert.equal(entry.node.type.spec.selectable, true); assert.equal(entry.node.type.spec.draggable, true)
  assert.equal(entry.node.nodeSize, 1)
  assert.deepEqual(richDocToDraftBlocks(doc), input)
  assert.equal(richTextSchema.nodes.doc.createAndFill()!.firstChild!.type, richTextSchema.nodes.text_block)
})

test('invalid database payload or text-block metadata cannot be silently rendered as a source preview', () => {
  for (const patch of [{ content: '{"version":1}' }, { checked: true }, { language: 'json' }, { markdownFormat: {} }, { listStart: 1 }]) {
    assert.throws(() => draftBlocksToRichDoc([{ ...database(), ...patch }]))
  }
})

test('real PM leaf and parent textContent serialize nested database atoms as standalone source without changing their ownership', () => {
  const input = columns(), doc = draftBlocksToRichDoc(input)
  const entry = richBlockEntries(doc).find(({ node }) => node.attrs.block.id === 'embed')!
  const before = structuredClone(entry.node.attrs.block)
  assert.throws(() => serializeBlocksToMarkdown([before]), 'the complete-forest codec must still reject missing owning column shells')
  const source = entry.node.textContent
  assert.match(source, /```knowbook-database-view-v1/)
  assert.deepEqual(parseDatabaseViewPayload(parseMarkdownBlocks(source)[0].content), payload())
  assert.ok(doc.textContent.includes(source), 'parent textContent must invoke the actual PM leafText callback safely')
  assert.ok(doc.textBetween(0, doc.content.size).includes(source))
  assert.deepEqual(entry.node.attrs.block, before)
  assert.deepEqual(richDocToDraftBlocks(doc), input)
})

test('real DOMSerializer and EditorView clipboard and dragstart serialize a nested database leaf without changing its forest', async () => {
  const errors: Error[] = [], virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => { errors.push(error) })
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true, virtualConsole })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const rect = new dom.window.DOMRect(0, 0, 800, 200)
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => rect
  dom.window.HTMLElement.prototype.getClientRects = () => [rect] as unknown as DOMRectList
  dom.window.Range.prototype.getBoundingClientRect = () => rect
  dom.window.Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList
  let view: import('prosemirror-view').EditorView | undefined
  try {
    const input = columns(), doc = draftBlocksToRichDoc(input)
    const entry = richBlockEntries(doc).find(({ node }) => node.attrs.block.id === 'embed')!
    const attrs = entry.node.attrs, attrsPrototype = Object.getPrototypeOf(attrs), attrsKeys = Reflect.ownKeys(attrs)
    const attrsSnapshot = structuredClone({ ...attrs })
    const nodeDOM = DOMSerializer.fromSchema(richTextSchema).serializeNode(entry.node, { document: dom.window.document })
    assert.ok(nodeDOM instanceof dom.window.HTMLElement)
    assert.equal(nodeDOM.dataset.blockId, 'embed')
    assert.equal(nodeDOM.dataset.blockDepth, '2')
    assert.deepEqual(parseDatabaseViewPayload(nodeDOM.querySelector('code')!.textContent!), payload())

    const { EditorView } = await import('prosemirror-view')
    view = new EditorView(dom.window.document.getElementById('mount')!, {
      state: EditorState.create({ doc, selection: NodeSelection.create(doc, entry.pos) })
    })
    const serialized = view.serializeForClipboard(view.state.selection.content())
    assert.match(serialized.text, /```knowbook-database-view-v1/)
    assert.deepEqual(parseDatabaseViewPayload(parseMarkdownBlocks(serialized.text)[0].content), payload())
    assert.equal(serialized.dom.querySelector<HTMLElement>('[data-block-id="embed"]')!.dataset.blockDepth, '2')

    const dragged = view.dom.querySelector<HTMLElement>('[data-block-id="embed"]')!
    Object.defineProperty(dom.window.document, 'elementFromPoint', { configurable: true, value: () => dragged })
    const data = new Map<string, string>()
    const transfer = { files: [], effectAllowed: 'none', clearData: () => data.clear(),
      setData: (type: string, value: string) => { data.set(type, value) }, getData: (type: string) => data.get(type) ?? '' }
    const event = new dom.window.MouseEvent('dragstart', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    dragged.dispatchEvent(event)
    assert.equal(transfer.effectAllowed, 'copyMove', 'the actual PM dragstart handler must finish')
    assert.match(data.get('text/html')!, /data-pm-slice=/)
    assert.deepEqual(parseDatabaseViewPayload(parseMarkdownBlocks(data.get('text/plain')!)[0].content), payload())
    assert.equal(entry.node.attrs, attrs, 'serialization must retain the actual PM attribute object')
    assert.equal(Object.getPrototypeOf(entry.node.attrs), attrsPrototype)
    assert.deepEqual(Reflect.ownKeys(entry.node.attrs), attrsKeys)
    assert.deepEqual({ ...entry.node.attrs }, attrsSnapshot)
    assert.deepEqual(richDocToDraftBlocks(view.state.doc), input)
    assert.deepEqual(errors, [])
  } finally {
    view?.destroy()
    dom.window.close()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('whole-atom Markdown clipboard keeps the real source reference without copying rendered database rows or host IDs', () => {
  const doc = draftBlocksToRichDoc([database()]), selection = NodeSelection.create(doc, 0)
  const markdown = richTextSliceMarkdown(selection.content())
  assert.match(markdown, /```knowbook-database-view-v1/)
  assert.equal(markdown.includes('embed'), false)
  const pasted = parseMarkdownBlocks(markdown)
  assert.equal(pasted.length, 1); assert.equal(pasted[0].type, 'database-view')
  assert.deepEqual(parseDatabaseViewPayload(pasted[0].content), payload())
  assert.equal(pasted[0].id, undefined)
})

test('a database atom NodeSelection bookmark restores the selected atom after a sibling insertion', () => {
  const doc = draftBlocksToRichDoc([paragraph('before', 'Before'), database(), paragraph('after', 'After')])
  const position = richBlockEntries(doc)[1].pos, selection = NodeSelection.create(doc, position)
  const bookmark = { anchor: richEndpoint(doc, selection.anchor), head: richEndpoint(doc, selection.head), kind: richSelectionKind(selection) }
  const next = draftBlocksToRichDoc([paragraph('new', 'New'), ...richDocToDraftBlocks(doc)])
  const restored = richSelectionFromBookmark(next, bookmark)
  assert.ok(restored instanceof NodeSelection)
  assert.equal(restored.node.attrs.block.id, 'embed')
})

for (const command of ['', '/database']) test(`confirmed database picker replaces ${command ? 'a slash' : 'an empty'} host in its real column without inventing a paragraph`, () => {
  const input = columns().filter(block => block.id !== 'embed')
  input[2] = { ...input[2], content: command, tags: ['public-link'], highlight: 'yellow' }
  const doc = draftBlocksToRichDoc(input), position = richBlockEntries(doc)[2].pos + 1
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, position + command.length) })
  const tr = planRichDatabaseViewInsertion(state, payload(), Boolean(command))!
  assert.ok(tr)
  const blocks = richDocToDraftBlocks(tr.doc), inserted = blocks.find(block => block.id === 'alpha')!
  assert.equal(inserted.type, 'database-view'); assert.equal(inserted.depth, 2); assert.equal(inserted.parentBlockId, 'left')
  assert.deepEqual(inserted.tags, ['public-link']); assert.equal(inserted.highlight, 'yellow')
  assert.equal(blocks.length, input.length)
  assert.equal(blocks.filter(block => block.parentBlockId === 'left').length, 1)
  assert.ok(tr.selection instanceof NodeSelection); assert.equal(tr.selection.node.attrs.block.id, 'alpha')
})

test('picker insertion at a text caret preserves both text halves and reconciles their independent block identities', () => {
  const doc = draftBlocksToRichDoc([paragraph('host', '中文Alpha')])
  const tr = planRichDatabaseViewInsertion(EditorState.create({ doc, selection: TextSelection.create(doc, 3) }), payload())!
  const blocks = richDocToDraftBlocks(tr.doc)
  assert.deepEqual(blocks.map(block => block.type), ['paragraph', 'database-view', 'paragraph'])
  assert.equal(blocks[0].content, '中文'); assert.equal(blocks[0].id, 'host'); assert.equal(blocks[2].content, 'Alpha')
  assert.equal(new Set(blocks.map(block => block.id)).size, 3)
  assert.ok(tr.selection instanceof NodeSelection)
})

test('whole-atom Delete removes only the selected reference and keeps the neighboring text blocks', () => {
  const input = [paragraph('before', 'Before'), database(), paragraph('after', 'After')], doc = draftBlocksToRichDoc(input)
  const state = EditorState.create({ doc, selection: NodeSelection.create(doc, richBlockEntries(doc)[1].pos) })
  const blocks = richDocToDraftBlocks(state.tr.deleteSelection().doc)
  assert.deepEqual(blocks.map(block => block.id), ['before', 'after'])
})

test('a cross-column text deletion removes covered database atoms while preserving both column shells and exact weights', () => {
  const doc = draftBlocksToRichDoc(columns()), entries = richBlockEntries(doc)
  const from = entries.find(entry => entry.node.attrs.block.id === 'alpha')!.pos + 2
  const to = entries.find(entry => entry.node.attrs.block.id === 'beta')!.pos + 3
  const tr = deleteCrossColumnSelection(EditorState.create({ doc, selection: TextSelection.create(doc, from, to) }))!
  const blocks = richDocToDraftBlocks(tr.doc)
  assert.equal(blocks.some(block => block.id === 'embed'), false)
  assert.deepEqual(blocks.filter(block => block.type === 'column').map(block => block.markdownFormat!.columnWeight), [4000, 6000])
  assert.equal(blocks.find(block => block.id === 'alpha')!.content, 'A')
  assert.equal(blocks.find(block => block.id === 'beta')!.content, 'ta')
})
