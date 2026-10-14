import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../src/main/database/store'
import { CURRENT_DATABASE_SCHEMA_VERSION } from '../src/main/database/schema-version'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { canonicalJson, parseManifest, validSyncBlockTree, validateRecord, type SyncDocument } from '../src/main/sync/model'
import { mergeSyncDocument } from '../src/main/sync/merge'

function block(id: string, type: string, depth = 0, parentBlockId: string | null = null,
  extra: Partial<DocumentBlockDraft> = {}): DocumentBlockDraft {
  return { id, type, depth, parentBlockId, content: id, checked: false, tags: [], ...extra }
}
function nativeForest(): DocumentBlockDraft[] {
  return [block('callout', 'callout', 0, null, { content: '**Notice**', tags: ['native'], highlight: 'blue',
    markdownFormat: { calloutKind: 'warning', calloutIcon: 'book', calloutTone: 'orange' } }),
  block('paragraph', 'paragraph', 1, 'callout', { content: '正文 [link](https://example.com)' }),
  block('heading', 'heading-2', 1, 'callout'),
  block('toggle', 'toggle', 1, 'callout', { markdownFormat: { toggleDefaultOpen: false } }),
  block('code', 'code', 2, 'toggle', { content: 'const x = 1', language: 'ts', markdownFormat: { codeInfo: 'ts' } }),
  block('image', 'image', 2, 'toggle', { content: '![Alt](https://example.com/image.png)' }),
  block('table', 'table', 2, 'toggle', { content: '| A | B |\n| - | - |\n| x | y |' }),
  block('task', 'numbered-todo', 2, 'toggle', { checked: true, listStart: 7, markdownFormat: { listMarker: ')', listLoose: true } }),
  block('task-child', 'todo', 3, 'task', { checked: true, highlight: 'yellow', tags: ['child'] }),
  block('quote', 'quote', 1, 'callout'), block('outside', 'paragraph')]
}
function withStore(run: (h: { readonly store: KnowbookStore; root: string; restart(): KnowbookStore }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-native-containers-')), path = join(root, 'test.db')
  let store = new KnowbookStore(path)
  try { run({ get store() { return store }, root, restart() { store.destroy(); store = new KnowbookStore(path); return store } }) }
  finally {
    store.destroy()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('knowbook-native-containers-'))
    rmSync(root, { recursive: true, force: true })
  }
}
function create(store: KnowbookStore, title: string, blocks: DocumentBlockDraft[]) {
  const id = store.createDocument(null)
  store.updateDocument(id, { title, summary: 'Native summary', blocks })
  return id
}

test('mixed native trees retain exact identities, parent roles and formats through save, read, restart, history and trash', () => withStore(h => {
  let store = h.store
  const forest = nativeForest(), id = create(store, 'Native store', forest)
  assert.deepEqual(store.documentRecovery.readContent(id).blocks, forest)
  const db = store.getUnsafeDatabaseHandle()
  const rows = db.prepare('SELECT * FROM blocks WHERE document_id = ? ORDER BY sort_order').all(id)
  store.getDocumentDetail(id); store.getSyncRecords(); store.getExportDocuments()
  assert.deepEqual(db.prepare('SELECT * FROM blocks WHERE document_id = ? ORDER BY sort_order').all(id), rows, 'read paths must not rewrite mixed trees')
  store = h.restart()
  assert.deepEqual(store.documentRecovery.readContent(id).blocks, forest)
  store.documentRecovery.checkpoint(id, 'edit', true)
  const history = store.documentRecovery.listHistory(id)[0]
  store.updateDocument(id, { title: 'Native store', summary: 'Changed', blocks: forest.map(b => b.id === 'paragraph' ? { ...b, content: 'Changed text' } : b) })
  store.restoreDocumentHistory(id, history.id, store.getDocumentDetail(id)!.updatedAt)
  assert.deepEqual(store.documentRecovery.readContent(id).blocks, forest)
  store.deleteDocument(id)
  store = h.restart()
  assert.equal(store.documentRecovery.listTrash().some(entry => entry.id === id), true)
  store.restoreTrashedDocument(id)
  assert.deepEqual(store.documentRecovery.readContent(id).blocks, forest)
  assert.deepEqual(store.getDocumentDetail(id)!.blocks.map(({ id, type, depth, parentBlockId, markdownFormat }) => ({ id, type, depth, parentBlockId, markdownFormat })),
    forest.map(({ id, type, depth, parentBlockId, markdownFormat }) => ({ id, type, depth, parentBlockId, markdownFormat })))
}))

test('a heading cannot own a list child and normalization preserves its content and identity', () => withStore(h => {
  const heading = block('heading-owner', 'heading-1', 0, null, { content: 'Heading', tags: ['owner'] })
  const child = block('heading-list-child', 'numbered-todo', 0, heading.id!, {
    content: 'Preserved task', checked: true, tags: ['task'], highlight: 'blue', listStart: 7,
    markdownFormat: { listMarker: ')', listLoose: true }
  })
  const id = create(h.store, 'Heading parent normalization', [heading, child])
  const expected = [heading, { ...child, parentBlockId: null }]
  assert.deepEqual(h.store.documentRecovery.readContent(id).blocks, expected)
  assert.deepEqual(h.restart().documentRecovery.readContent(id).blocks, expected)
}))

test('a native mixed forest transfers into a toggle and preserves timestamps and paired history after restart', () => withStore(h => {
  let store = h.store
  const forest = nativeForest(), source = create(store, 'Native source', forest)
  const targetForest = [block('target', 'toggle', 0, null, { markdownFormat: { toggleDefaultOpen: true } }), block('target-child', 'paragraph', 1, 'target')]
  const target = create(store, 'Native target', targetForest)
  const before = [source, target].map(id => store.documentRecovery.readContent(id))
  const timestamps = store.getUnsafeDatabaseHandle().prepare('SELECT id,created_at FROM blocks ORDER BY id').all()
  const moved = store.moveDocumentBlocks({ fromDocumentId: source, toDocumentId: target, blockIds: ['callout'], parentBlockId: 'target',
    expectedFromUpdatedAt: store.getDocumentDetail(source)!.updatedAt, expectedToUpdatedAt: store.getDocumentDetail(target)!.updatedAt })
  assert.deepEqual(moved.movedBlockIds, forest.slice(0, -1).map(b => b.id))
  assert.deepEqual(store.documentRecovery.readContent(source).blocks, [forest.at(-1)!])
  const expected = [...targetForest, ...forest.slice(0, -1).map(b => ({ ...b, depth: b.depth + 1, parentBlockId: b.id === 'callout' ? 'target' : b.parentBlockId }))]
  assert.deepEqual(store.documentRecovery.readContent(target).blocks, expected)
  assert.deepEqual(store.getUnsafeDatabaseHandle().prepare('SELECT id,created_at FROM blocks ORDER BY id').all(), timestamps)
  store = h.restart()
  const undo = store.getDocumentBlockMoveHistory(target)!
  store.undoDocumentBlockMove({ operationId: undo.operationId, expectedUpdatedAtByDocument: undo.expectedUpdatedAtByDocument })
  assert.deepEqual([source, target].map(id => store.documentRecovery.readContent(id)), before)
  store = h.restart()
  const redo = store.getDocumentBlockMoveHistory(source)!
  store.redoDocumentBlockMove({ operationId: redo.operationId, expectedUpdatedAtByDocument: redo.expectedUpdatedAtByDocument })
  assert.deepEqual(store.documentRecovery.readContent(target).blocks, expected)
}))

test('v22 semantic migration creates one complete safety copy and leaves prior content intact', () => withStore(h => {
  let store = h.store
  const id = create(store, 'Legacy lists', [block('legacy-root', 'todo'), block('legacy-child', 'bulleted-list', 1, 'legacy-root')])
  const before = store.documentRecovery.readContent(id)
  store.getUnsafeDatabaseHandle().pragma('user_version = 22')
  store = h.restart()
  assert.equal(store.getUnsafeDatabaseHandle().pragma('user_version', { simple: true }), CURRENT_DATABASE_SCHEMA_VERSION)
  assert.deepEqual(store.documentRecovery.readContent(id), before)
  const copies = readdirSync(h.root).filter(name => name.includes(`pre-migration-v22-to-v${CURRENT_DATABASE_SCHEMA_VERSION}-`))
  assert.equal(copies.length, 1)
  const backup = new Database(join(h.root, copies[0]), { readonly: true })
  try {
    assert.equal(backup.pragma('user_version', { simple: true }), 22)
    assert.deepEqual(backup.prepare('SELECT id,type,depth,parent_block_id FROM blocks WHERE document_id = ? ORDER BY sort_order').all(id),
      store.getUnsafeDatabaseHandle().prepare('SELECT id,type,depth,parent_block_id FROM blocks WHERE document_id = ? ORDER BY sort_order').all(id))
  } finally { backup.close() }
  h.restart()
  assert.deepEqual(readdirSync(h.root).filter(name => name.includes('.pre-migration-')), copies)
}))

function document(blocks = nativeForest()): SyncDocument {
  return { kind: 'document', id: 'native', parentId: null, sortOrder: 0, createdAt: '2026-10-14T00:00:00Z', content: { title: 'Native', summary: '', blocks } }
}
test('sync v2 accepts valid mixed trees and rejects closed parents, list mixed children, frontmatter and invalid native formats', () => {
  const original = document()
  assert.equal(validateRecord(original, 'doc:native', 2), original)
  assert.throws(() => validateRecord(original, 'doc:native', 1), /清单版本/)
  const layoutOnly = document([block('layout', 'table', 0, null, { content: '<!-- knowbook:table-widths:v1 [160,null] -->\n| A | B |\n| --- | --- |\n| x | y |' })])
  assert.equal(validateRecord(layoutOnly, 'doc:native', 2), layoutOnly)
  assert.throws(() => validateRecord(layoutOnly, 'doc:native', 1), /清单版本/)
  const paragraphLayout = document([{ ...layoutOnly.content.blocks[0], type: 'paragraph' }])
  assert.throws(() => validateRecord(paragraphLayout, 'doc:native', 1), /清单版本/)
  const literalLayout = document([{ ...layoutOnly.content.blocks[0], type: 'code' }])
  assert.equal(validateRecord(literalLayout, 'doc:native', 1), literalLayout, 'a fenced code example does not use the layout grammar')
  for (const bad of [
    [block('old', 'callout'), block('next', 'callout'), block('late', 'paragraph', 1, 'old')],
    [block('list', 'todo'), block('text', 'paragraph', 1, 'list')],
    [block('owner', 'toggle'), block('front', 'frontmatter', 1, 'owner')],
    [block('owner', 'callout', 0, null, { markdownFormat: { calloutKind: 'unknown' } as never })],
    [block('owner', 'toggle', 0, null, { markdownFormat: { toggleDefaultOpen: 'false' } as never })],
    [block('owner', 'toggle', 0, null, { markdownFormat: { calloutKind: 'note' } })]
  ]) {
    assert.equal(validSyncBlockTree(bad), false)
    assert.throws(() => validateRecord(document(bad), 'doc:native', 2), /格式/)
  }
  for (const version of [1, 2]) assert.equal(parseManifest(Buffer.from(canonicalJson({ version, workspaceId: 'workspace', entries: {} }))).version, version)
  assert.throws(() => parseManifest(Buffer.from(canonicalJson({ version: 3, workspaceId: 'workspace', entries: {} }))), /清单/)
})

test('three-way merge preserves native metadata and body changes while refusing inactive parent choices', () => {
  const base = document(), left = structuredClone(base), right = structuredClone(base)
  left.content.blocks[0].markdownFormat = { ...left.content.blocks[0].markdownFormat, calloutTone: 'blue' }
  right.content.blocks[1].content = 'Remote body'
  const merged = mergeSyncDocument(base, left, right)
  assert.deepEqual(merged.unresolved, [])
  assert.equal(merged.document.content.blocks[0].markdownFormat?.calloutTone, 'blue')
  assert.equal(merged.document.content.blocks[1].content, 'Remote body')
  assert.deepEqual(merged.document.content.blocks.map(b => [b.id, b.depth, b.parentBlockId]), base.content.blocks.map(b => [b.id, b.depth, b.parentBlockId]))
  right.content.blocks.push(block('late', 'paragraph', 1, 'callout'))
  const rejected = mergeSyncDocument(base, left, right, { blocks: { choice: 'remote' } })
  assert.deepEqual(rejected.unresolved.map(part => part.id), ['blocks'])
  assert.deepEqual(rejected.document.content.blocks, left.content.blocks)
})

test('same-column width edits conflict as authored values instead of synthesizing a third width', () => {
  const source = '<!-- knowbook:table-widths:v1 [160,null,240] -->\n| A | B | C |\n| --- | --- | --- |\n| first | middle | last |'
  const base = document([block('table', 'table', 0, null, { content: source })])
  const left = structuredClone(base), right = structuredClone(base)
  left.content.blocks[0].content = source.replace('[160,null,240]', '[260,null,240]')
  right.content.blocks[0].content = source.replace('[160,null,240]', '[161,null,240]')
  const conflict = mergeSyncDocument(base, left, right)
  assert.deepEqual(conflict.unresolved.map(part => part.id), ['block:table:content'])
  assert.equal(conflict.document.content.blocks[0].content, left.content.blocks[0].content)
  for (const choice of ['local', 'remote'] as const) {
    const selected = mergeSyncDocument(base, left, right, { 'block:table:content': { choice } })
    assert.deepEqual(selected.unresolved, [])
    assert.equal(selected.document.content.blocks[0].content, (choice === 'local' ? left : right).content.blocks[0].content)
  }
  right.content.blocks[0].content = source.replace('[160,null,240]', '[160,null,300]').replace('last', 'Remote cell')
  const combined = mergeSyncDocument(base, left, right)
  assert.deepEqual(combined.unresolved, [])
  assert.equal(combined.document.content.blocks[0].content, source.replace('[160,null,240]', '[260,null,300]').replace('last', 'Remote cell'))
  left.content.blocks[0].content = source.replace('[160,null,240]', '[240,160,null]').replace('| A | B | C |', '| C | A | B |')
  right.content.blocks[0].content = source.replace('[160,null,240]', '[260,null,240]')
  const reordered = mergeSyncDocument(base, left, right)
  assert.deepEqual(reordered.unresolved.map(part => part.id), ['block:table:content'], 'a width edit cannot silently follow an index across a competing column reorder')
})
