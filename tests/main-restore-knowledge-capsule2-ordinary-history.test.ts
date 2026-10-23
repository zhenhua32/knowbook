import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import test from 'node:test'
import type { UpdateDocumentInput } from '../src/shared/contracts'
import type { TrashedDocument } from '../src/main/database/document-recovery'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { assertRawCapsule2OrdinaryHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-ordinary-history-read'
import { validateRecord, type SyncDocument } from '../src/main/sync/model'
import { SYNCED_MAX_BLOCKS, validatePersistedHostForest, validateSyncedHostForest } from '../src/shared/syncedBlockValidation'
import { decodedCapsule2Table, withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { snapshot, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'

function saved(f: V3Fixture) {
  const parent = f.store.createDocument(null), id = f.store.createDocument(parent)
  const first = randomUUID(), second = randomUUID()
  f.store.updateDocument(id, { title: '史'.repeat(501), summary: 'Historical summary', blocks: [
    { id: first, type: 'bulleted-list', content: 'Original parent', checked: false, depth: 0, tags: ['saved'], highlight: 'yellow' },
    { id: second, type: 'code', content: 'literal knowbook-asset://missing {{template}}', checked: false, depth: 1,
      parentBlockId: first, language: 'typescript', markdownFormat: { codeInfo: 'typescript title="original"' } }
  ] })
  const column = f.store.createDocumentDatabaseColumn({ databaseId: f.catalogId, name: 'Historical values', type: 'text' })
  f.store.updateDocumentDatabaseValue({ documentId: id, columnId: column.id, value: 'literal null\0old value' })
  f.store.createDatabaseEntity({ databaseId: f.catalogId, documentId: id, title: 'Historical entity', fieldValues: { [column.id]: 'Entity original' } })
  f.store.documentRecovery.checkpoint(id, 'move', true)
  const history = (f.db.prepare('SELECT id FROM document_history WHERE document_id=? ORDER BY rowid DESC LIMIT 1').get(id) as { id: string }).id
  f.store.deleteDocument(id)
  return { id, parent, history, column: column.id, first, second }
}
type Saved = ReturnType<typeof saved>

test('persisted history forest codec keeps the complete oversized data array while live host limits and cross-boundary identity checks remain intact', () => {
  // Data-only codec regression, not an actual source, seal or certification.
  const blocks = Array.from({ length: SYNCED_MAX_BLOCKS + 1 }, (_, index) => ({ id: 'saved-' + index,
    type: 'paragraph', content: '', checked: false, depth: 0, parentBlockId: null }))
  assert.throws(() => validateSyncedHostForest(blocks))
  const checked = validatePersistedHostForest(blocks)
  assert.equal(checked.length, blocks.length)
  assert.equal(checked.at(-1)?.id, blocks.at(-1)?.id)
  blocks.at(-1)!.id = blocks[0].id
  assert.throws(() => validatePersistedHostForest(blocks), /同步块内容或结构/)
})

function history(f: V3Fixture, source: Saved, change: (value: UpdateDocumentInput) => unknown) {
  const row = f.db.prepare('SELECT content_json FROM document_history WHERE id=?').get(source.history) as { content_json: string }
  f.db.prepare('UPDATE document_history SET content_json=? WHERE id=?').run(JSON.stringify(change(JSON.parse(row.content_json))), source.history)
}
function trash(f: V3Fixture, source: Saved, change: (value: TrashedDocument) => unknown) {
  const row = f.db.prepare('SELECT snapshot_json FROM document_trash WHERE id=?').get(source.id) as { snapshot_json: string }
  f.db.prepare('UPDATE document_trash SET snapshot_json=? WHERE id=?').run(JSON.stringify(change(JSON.parse(row.snapshot_json))), source.id)
}
async function unchanged(f: V3Fixture, inspect: (db: Database.Database) => void) {
  const group = snapshot(f.db, f.groupId), ack = f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const before = readRawCapsule2ContentOwned(db)
    inspect(db)
    assert.deepEqual(readRawCapsule2ContentOwned(db), before)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })())
  assert.deepEqual(snapshot(f.db, f.groupId), group)
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId), ack)
}

test('capsule2 ordinary history preserves actual Store501 bodies and archived values after their parent and column are deleted', () => withV3Fixture(async f => {
  const source = saved(f)
  const originalTrash = f.store.documentRecovery.getTrash(source.id)
  f.store.deleteDocument(source.parent)
  f.store.deleteDocumentDatabaseColumn(source.column)
  await unchanged(f, db => {
    const value = readRawCapsule2WorkspaceHistoryOwned(db), raw = readRawCapsule2ContentOwned(db)
    assert.ok(value.historyBlocks.includes(source.first)); assert.ok(value.historyBlocks.includes(source.second))
    const row = decodedCapsule2Table(raw, 'document_trash').find(row => row.id === source.id)!
    assert.deepEqual(JSON.parse(row.snapshot_json as string), originalTrash)
    assert.equal(originalTrash.document.title.length, 501)
    assert.equal(originalTrash.document.parent_id, source.parent)
    assert.equal(originalTrash.values[0].column_id, source.column)
    assert.equal(originalTrash.values[0].value_text, 'literal null\0old value')
    assert.equal(value.certified, false); assert.equal(value.semanticValidationComplete, false); assert.equal(value.permit, false)
  })
}))

test('capsule2 ordinary trash retains the safe signed sort order written by actual ordinary sync', () => withV3Fixture(async f => {
  const id = f.store.createDocument(null), detail = f.store.getDocumentDetail(id)!
  const record: SyncDocument = { kind: 'document', id, parentId: null, sortOrder: Number.MIN_SAFE_INTEGER,
    createdAt: (f.db.prepare('SELECT created_at FROM documents WHERE id=?').get(id) as { created_at: string }).created_at,
    content: { title: detail.title, summary: detail.summary, blocks: detail.blocks } }
  validateRecord(record, 'doc:' + id)
  f.store.applySyncRecords([record]); f.store.deleteDocument(id)
  assert.equal(f.store.documentRecovery.getTrash(id).document.sort_order, Number.MIN_SAFE_INTEGER)
  await unchanged(f, db => assert.equal(readRawCapsule2WorkspaceHistoryOwned(db).certified, false))
}))

test('capsule2 ordinary checkpoints and trash preserve the empty literal path produced by the former astral deletion substring', () => withV3Fixture(async f => {
  const parent = f.store.createDocument(null)
  f.store.updateDocument(parent, { ...f.store.getDocumentDetail(parent)!, title: '😀' })
  const id = f.store.createDocument(parent)
  f.store.updateDocument(id, { ...f.store.getDocumentDetail(id)!, title: 'A' })
  const original = f.store.getDocumentSnapshot(id)!.path
  assert.equal(original, '😀/A')
  f.store.deleteDocument(parent)
  // Exact former SQL/JS coordinate mix, not a fabricated old Main oracle.
  f.db.prepare('UPDATE documents SET path=? || substr(?,?) WHERE id=?').run('', original, '😀/'.length + 1, id)
  f.store.documentRecovery.checkpoint(id, 'edit', true)
  f.store.deleteDocument(id)
  assert.equal(f.store.documentRecovery.getTrash(id).document.path, '')
  await unchanged(f, db => {
    readRawCapsule2WorkspaceHistoryOwned(db)
    const histories = decodedCapsule2Table(readRawCapsule2ContentOwned(db), 'document_history').filter(row => row.document_id === id)
    assert.ok(histories.some(row => row.path === ''))
  })
}))

test('capsule2 ordinary history assertion requires the actual readonly query-only FK-owned transaction', () => withV3Fixture(async f => {
  saved(f)
  assert.throws(() => assertRawCapsule2OrdinaryHistoryOwned(f.db), /来源事务/)
  assert.throws(() => f.db.transaction(() => assertRawCapsule2OrdinaryHistoryOwned(f.db))(), /来源事务/)
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => assertRawCapsule2OrdinaryHistoryOwned(db), /来源事务/)
    db.pragma('query_only=OFF')
    assert.throws(() => db.transaction(() => assertRawCapsule2OrdinaryHistoryOwned(db))(), /来源事务/)
    db.pragma('query_only=ON'); db.pragma('foreign_keys=OFF')
    assert.throws(() => db.transaction(() => assertRawCapsule2OrdinaryHistoryOwned(db))(), /来源事务/)
    db.pragma('foreign_keys=ON')
    db.transaction(() => assertRawCapsule2OrdinaryHistoryOwned(db))()
  })
}))

const corruptions: Array<[string, (f: V3Fixture, source: Saved) => void]> = [
  ['history summary type', (f, s) => history(f, s, value => ({ ...value, summary: 7 }))],
  ['history missing block identity', (f, s) => history(f, s, value => ({ ...value, blocks: value.blocks.map(({ id: _id, ...block }) => block) }))],
  ['history duplicate block identity', (f, s) => history(f, s, value => ({ ...value, blocks: [value.blocks[0], value.blocks[0]] }))],
  ['history invalid parent forest', (f, s) => history(f, s, value => ({ ...value, blocks: [{ ...value.blocks[0], depth: 1, parentBlockId: randomUUID() }] }))],
  ['history invalid checked type', (f, s) => history(f, s, value => ({ ...value, blocks: [{ ...value.blocks[0], checked: 'false' }] }))],
  ['history incompatible format', (f, s) => history(f, s, value => ({ ...value, blocks: [{ ...value.blocks[0], markdownFormat: { codeInfo: 'wrong type' } }] }))],
  ['history invalid database-view atom', (f, s) => history(f, s, value => ({ ...value, blocks: [{ ...value.blocks[0], type: 'database-view', content: '{}' }] }))],
  ['history unknown field', (f, s) => history(f, s, value => ({ ...value, futurePermission: true }))],
  ['history metadata title disagreement', (f, s) => { f.db.prepare('UPDATE document_history SET title=? WHERE id=?').run('Wrong title', s.history) }],
  ['history unknown reason', (f, s) => { f.db.prepare('UPDATE document_history SET reason=? WHERE id=?').run('future-reason', s.history) }],
  ['history invalid timestamp', (f, s) => { f.db.prepare('UPDATE document_history SET created_at=? WHERE id=?').run('not a date', s.history) }],
  ['history blank identity', (f, s) => { f.db.prepare('UPDATE document_history SET id=? WHERE id=?').run(' ', s.history) }],
  ['trash missing snapshot values', (f, s) => trash(f, s, ({ values: _values, ...value }) => value)],
  ['trash summary disagreement', (f, s) => trash(f, s, value => ({ ...value, document: { ...value.document, summary: 'Different' } }))],
  ['trash invalid sort order', (f, s) => trash(f, s, value => ({ ...value, document: { ...value.document, sort_order: 0.5 } }))],
  ['trash self parent', (f, s) => trash(f, s, value => ({ ...value, document: { ...value.document, parent_id: s.id } }))],
  ['trash invalid saved timestamp', (f, s) => trash(f, s, value => ({ ...value, document: { ...value.document, updated_at: 'invalid' } }))],
  ['trash invalid value type', (f, s) => trash(f, s, value => ({ ...value, values: [{ ...value.values[0], value_text: 7 }] }))],
  ['trash duplicate document column', (f, s) => trash(f, s, value => ({ ...value, values: [value.values[0], value.values[0]] }))],
  ['trash duplicate entity column', (f, s) => trash(f, s, value => ({ ...value, entities: [{ ...value.entities[0], values: [value.entities[0].values[0], value.entities[0].values[0]] }] }))],
  ['trash duplicate entity identity', (f, s) => trash(f, s, value => ({ ...value, entities: [value.entities[0], value.entities[0]] }))],
  ['trash invalid entity timestamp', (f, s) => trash(f, s, value => ({ ...value, entities: [{ ...value.entities[0], created_at: 'invalid' }] }))],
  ['trash invalid entity database identity', (f, s) => trash(f, s, value => ({ ...value, entities: [{ ...value.entities[0], database_id: ' ' }] }))],
  ['trash invalid content forest', (f, s) => trash(f, s, value => ({ ...value, content: { ...value.content, blocks: [{ ...value.content.blocks[0], depth: 2 }] } }))],
  ['trash metadata path disagreement', (f, s) => { f.db.prepare('UPDATE document_trash SET path=? WHERE id=?').run('Different historical path', s.id) }],
  ['trash invalid deletion timestamp', (f, s) => { f.db.prepare('UPDATE document_trash SET deleted_at=? WHERE id=?').run('invalid', s.id) }]
]
for (const [name, corrupt] of corruptions) test('capsule2 ordinary history rejects original ' + name + ' without rewriting SQL or Main evidence', () => withV3Fixture(async f => {
  const source = saved(f)
  corrupt(f, source)
  await unchanged(f, db => assert.throws(() => readRawCapsule2WorkspaceHistoryOwned(db), /capsule2 ordinary history/))
}))
