import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { KnowbookStore } from '../src/main/database/store'
import { type SyncDocument, type SyncRecord } from '../src/main/sync/model'
import { markdownEngine } from '../src/shared/markdownEngine'
import type { DocumentBlockDraft } from '../src/shared/contracts'

const block = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null })
function create(store: KnowbookStore, title: string, blocks: DocumentBlockDraft[]) {
  const id = store.createDocument(null); store.updateDocument(id, { title, summary: title + ' summary', blocks }); return id
}
function fixture(run: (a: KnowbookStore, b: KnowbookStore) => void) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-sync-block-moves-'))
  const a = new KnowbookStore(join(root, 'a.db')), b = new KnowbookStore(join(root, 'b.db'))
  for (const store of [a, b]) for (const document of store.getAllDocumentSnapshots().reverse()) store.deleteDocument(document.id)
  try { run(a, b) } finally {
    a.destroy(); b.destroy()
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('knowbook-sync-block-moves-'))
    rmSync(root, { recursive: true, force: true })
  }
}
function seed(a: KnowbookStore, b: KnowbookStore) {
  const source = create(a, 'Source', [block('move-id', '[out](Neighbor.md) [[#^keep-id]]'), block('keep-id', 'Keep')])
  const target = create(a, 'Target', [block('target-id', 'Target body')])
  const incoming = create(a, 'Incoming', [block('incoming-id', '[moved](Source.md#^move-id) [[Source#^move-id]] [stay](Source.md#^keep-id)')])
  create(a, 'Neighbor', [block('neighbor-id', 'Neighbor body')])
  b.applySyncRecords([...a.getSyncRecords().values()])
  return { source, target, incoming }
}
function moved(a: KnowbookStore, ids: ReturnType<typeof seed>) {
  return a.moveDocumentBlocks({ fromDocumentId: ids.source, toDocumentId: ids.target, blockIds: ['move-id'],
    expectedFromUpdatedAt: a.getDocumentDetail(ids.source)!.updatedAt, expectedToUpdatedAt: a.getDocumentDetail(ids.target)!.updatedAt })
}
function state(store: KnowbookStore) {
  const db = store.getUnsafeDatabaseHandle()
  return Object.fromEntries(['documents', 'blocks', 'document_history', 'document_trash', 'document_block_routes', 'document_block_moves',
    'markdown_link_sources', 'links', 'app_settings'].map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
}
function record(store: KnowbookStore, id: string) { return store.getSyncRecords().get('doc:' + id)! as SyncDocument }

test('two real stores receive complete moved IDs in either order without timestamp, old route, or index loss', () => {
  for (const targetFirst of [true, false]) fixture((a, b) => {
    const ids = seed(a, b), createdAt = (b.getUnsafeDatabaseHandle().prepare('SELECT created_at FROM blocks WHERE id = ?').get('move-id') as { created_at: string }).created_at
    const late = create(b, 'Late reader', [block('late-id', '[old](Source.md#%5Emove-id) [[Source#^move-id]]')])
    moved(a, ids)
    const owners = targetFirst ? [ids.target, ids.source] : [ids.source, ids.target]
    b.applySyncRecords([...owners, ids.incoming].map(id => record(a, id)))
    assert.equal(b.getBlockReference('Source', '^move-id')!.documentId, ids.target)
    assert.equal(b.getBlockReference('WrongPath', '^move-id'), null)
    assert.deepEqual(b.getDocumentDetail(ids.target)!.blocks.map(value => value.id), a.getDocumentDetail(ids.target)!.blocks.map(value => value.id))
    assert.equal((b.getUnsafeDatabaseHandle().prepare('SELECT created_at FROM blocks WHERE id = ?').get('move-id') as { created_at: string }).created_at, createdAt)
    assert.deepEqual(b.checkDocumentLinks(late, () => null).issues, [])
    assert.ok(b.getDocumentDetail(late)!.outgoingLinks.some(value => value.id === ids.target))
    assert.equal((b.getUnsafeDatabaseHandle().prepare('SELECT COUNT(*) AS count FROM markdown_link_sources WHERE source_block_id = ?').get('move-id') as { count: number }).count, 2)
    assert.ok(b.documentRecovery.listHistory(ids.source).some(value => value.reason === 'restore'))
    assert.ok(b.documentRecovery.listHistory(ids.target).some(value => value.reason === 'restore'))
    // Existing routes survive a second transfer and still follow the real owner.
    a.moveDocumentBlocks({ fromDocumentId: ids.target, toDocumentId: ids.source, blockIds: ['move-id'],
      expectedFromUpdatedAt: a.getDocumentDetail(ids.target)!.updatedAt, expectedToUpdatedAt: a.getDocumentDetail(ids.source)!.updatedAt })
    b.applySyncRecords([record(a, ids.source), record(a, ids.target), record(a, ids.incoming)])
    assert.equal(b.getBlockReference('Target', '^move-id')!.documentId, ids.source)
    assert.equal(b.getBlockReference('Source', '^move-id')!.documentId, ids.source)
    assert.deepEqual(b.checkDocumentLinks(late, () => null).issues, [])
  })
})

test('remote source deletion archives its full old content before transferring IDs and preserves observed aliases', () => fixture((a, b) => {
  const ids = seed(a, b), original = b.documentRecovery.readContent(ids.source)
  const createdAt = (b.getUnsafeDatabaseHandle().prepare('SELECT created_at FROM blocks WHERE id = ?').get('move-id') as { created_at: string }).created_at
  const late = create(b, 'Late reader', [block('late-id', '[old](Source.md#^move-id) [[Source#^move-id]]')])
  moved(a, ids); a.deleteDocument(ids.source)
  b.applySyncRecords([record(a, ids.target), { kind: 'deleted', id: ids.source }, record(a, ids.incoming)])
  assert.equal(b.getDocumentSnapshot(ids.source), null)
  assert.equal(b.getBlockReference('Source', '^move-id')!.documentId, ids.target)
  assert.deepEqual(b.checkDocumentLinks(late, () => null).issues, [])
  assert.equal((b.getUnsafeDatabaseHandle().prepare('SELECT created_at FROM blocks WHERE id = ?').get('move-id') as { created_at: string }).created_at, createdAt)
  const trash = b.documentRecovery.listTrash().find(value => value.id === ids.source)!
  assert.ok(trash)
  assert.deepEqual(b.documentRecovery.getTrash(ids.source).content, original)
}))

test('partial conflict batches, duplicate global IDs and post-transfer failures roll back data, history, routes and cursor together', () => fixture((a, b) => {
  const ids = seed(a, b); moved(a, ids)
  const target = record(a, ids.target), source = record(a, ids.source)
  const before = state(b)
  const attempts: SyncRecord[][] = [
    [target], // source may have an unresolved conflict; do not partially steal its block.
    [source, { ...target, content: { ...target.content, blocks: [...target.content.blocks, block('keep-id', 'duplicate')] } }],
    [source, source, target],
    [source, { kind: 'deleted', id: source.id }, target]
  ]
  for (const records of attempts) {
    assert.throws(() => b.runInTransaction(() => { b.saveSetting('sync-test-cursor', 'must rollback'); b.applySyncRecords(records) }), /同步批次/)
    assert.deepEqual(state(b), before)
  }
  const db = b.getUnsafeDatabaseHandle()
  db.prepare("CREATE TEMP TRIGGER reject_received_move BEFORE UPDATE OF updated_at ON documents WHEN NEW.id = '" + ids.target
    + "' BEGIN SELECT RAISE(ABORT, 'injected received move failure'); END").run()
  assert.throws(() => b.runInTransaction(() => { b.saveSetting('sync-test-cursor', 'must rollback'); b.applySyncRecords([target, source]) }), /injected received move failure/)
  assert.deepEqual(state(b), before)
  db.exec('DROP TRIGGER reject_received_move')
  b.runInTransaction(() => { b.applySyncRecords([target, source]); b.saveSetting('sync-test-cursor', 'accepted') })
  assert.equal(b.getSettingPublic('sync-test-cursor'), 'accepted')
  assert.equal(b.getBlockReference('Source', '^move-id')!.documentId, ids.target)
}))

test('real store footnote move preserves rendered closures and metadata with paired undo while unsafe source containers reject without writes', () => fixture((a) => {
  const source = create(a, 'Notes', [block('note-use', 'Use[^n]'), block('note-definition', '[^n]: **Original** [link][r], child[^child]\n\n    - list\n\n[^child]: Child\n\n[r]: Neighbor.md')])
  const target = create(a, 'Target notes', [block('existing-note', 'Target[^n]\n\n[^n]: Target definition')])
  const originalSource = a.documentRecovery.readContent(source), originalTarget = a.documentRecovery.readContent(target)
  const move = a.moveDocumentBlocks({ fromDocumentId: source, toDocumentId: target, blockIds: ['note-use'],
    expectedFromUpdatedAt: a.getDocumentDetail(source)!.updatedAt, expectedToUpdatedAt: a.getDocumentDetail(target)!.updatedAt })
  const html = markdownEngine.render(move.target.blocks.map(value => value.content).join('\n\n'))
  assert.ok(html.includes('<strong>Original</strong>'))
  assert.ok(html.includes('Target definition'))
  assert.ok(html.includes('Child'))
  assert.ok(html.includes('<li>list</li>'))
  a.undoDocumentBlockMove({ operationId: move.operationId, expectedUpdatedAtByDocument: move.expectedUpdatedAtByDocument })
  assert.deepEqual(a.documentRecovery.readContent(source), originalSource)
  assert.deepEqual(a.documentRecovery.readContent(target), originalTarget)
  const unsafe = create(a, 'Unsafe note', [{ ...block('unsafe-use', 'Use[^n]'), type: 'todo' }, block('unsafe-definition', '[^n]: Original')])
  const before = state(a)
  assert.throws(() => a.moveDocumentBlocks({ fromDocumentId: unsafe, toDocumentId: target, blockIds: ['unsafe-use'],
    expectedFromUpdatedAt: a.getDocumentDetail(unsafe)!.updatedAt, expectedToUpdatedAt: a.getDocumentDetail(target)!.updatedAt }), /脚注定义.*未移动任何块/)
  assert.deepEqual(state(a), before)
}))
