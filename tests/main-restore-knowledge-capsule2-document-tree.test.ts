import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import test from 'node:test'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2PhysicalGraphOwned } from '../src/main/database/restore-knowledge-capsule2-physical-raw-read'
import { validateRecord, type SyncDocument } from '../src/main/sync/model'
import { withCapsule2RawCopy, writeMixedOrdinary501 } from './helpers/capsule2-raw-fixture'
import { snapshot, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'

function document(f: V3Fixture, title: string, parentId: string | null = null) {
  const id = f.store.createDocument(parentId)
  f.store.updateDocument(id, { ...f.store.getDocumentDetail(id)!, title })
  return id
}

async function unchangedSource(f: V3Fixture, inspect: (db: Database.Database) => void) {
  const group = snapshot(f.db, f.groupId)
  const ack = f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const before = readRawCapsule2ContentOwned(db)
    inspect(db)
    assert.deepEqual(readRawCapsule2ContentOwned(db), before)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })())
  assert.deepEqual(snapshot(f.db, f.groupId), group)
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId), ack)
}

test('capsule2 document tree keeps actual case-distinct promoted siblings, ordinary501 and signed order with complete original parent identities', () => withV3Fixture(async f => {
  const { title } = writeMixedOrdinary501(f)
  const top = document(f, 'Promotion parent')
  const lower = document(f, 'case', top), lowerChild = document(f, 'Child', lower)
  const upper = document(f, 'Case'), upperChild = document(f, 'Child', upper)
  f.store.deleteDocument(top)
  // Saving either promoted case sibling again legitimately invokes the live
  // writer's NOCASE collision rule. Put signed order on another real document.
  const ordered = document(f, 'Signed ordinary order'), detail = f.store.getDocumentDetail(ordered)!
  const record: SyncDocument = { kind: 'document', id: ordered, parentId: null, sortOrder: -7,
    createdAt: (f.db.prepare('SELECT created_at FROM documents WHERE id=?').get(ordered) as { created_at: string }).created_at,
    content: { title: detail.title, summary: detail.summary, blocks: detail.blocks } }
  validateRecord(record, 'doc:' + ordered)
  f.store.applySyncRecords([record])
  await unchangedSource(f, db => {
    const value = readRawCapsule2PhysicalGraphOwned(db)
    assert.equal(value.documents.find(row => row.documentId === f.targetId)?.title, title)
    assert.deepEqual([lower, upper].map(id => value.documents.find(row => row.documentId === id)?.title), ['case', 'Case'])
    assert.deepEqual([lowerChild, upperChild].map(id => value.documents.find(row => row.documentId === id)?.parentId), [lower, upper])
    assert.equal(value.documents.find(row => row.documentId === ordered)?.sortOrder, -7)
    assert.deepEqual(value.documents.map(row => row.documentId), (db.prepare('SELECT id FROM documents ORDER BY id').all() as Array<{ id: string }>).map(row => row.id))
    assert.equal(value.certified, false); assert.equal(value.semanticValidationComplete, false)
  })
}))

test('capsule2 tree preserves literal empty, duplicate and noncanonical paths produced by the former astral-prefix SQL without healing source', () => withV3Fixture(async f => {
  const root = document(f, '😀'), first = document(f, 'A', root), second = document(f, 'B', root)
  const deep = document(f, 'C', first)
  const oldPrefix = '😀/'
  const originals = [first, second, deep].map(id => ({ id, path: f.store.getDocumentSnapshot(id)!.path }))
  f.store.deleteDocument(root)
  // Reproduce precisely the former deletion writer's SQLite substring with a
  // JS UTF-16 prefix offset. The current Store supplies the actual deletion,
  // parent promotion, history, retained identities and original block routes.
  const legacy = f.db.prepare('UPDATE documents SET path=? || substr(?,?) WHERE id=?')
  for (const row of originals) legacy.run('', row.path, oldPrefix.length + 1, row.id)
  assert.deepEqual([first, second, deep].map(id => (f.db.prepare('SELECT path FROM documents WHERE id=?').get(id) as { path: string }).path), ['', '', '/C'])
  await unchangedSource(f, db => {
    const value = readRawCapsule2PhysicalGraphOwned(db)
    assert.deepEqual([first, second, deep].map(id => {
      const row = value.documents.find(row => row.documentId === id)!
      return [row.path, row.parentId]
    }), [['', null], ['', null], ['/C', first]])
  })
}))

test('capsule2 document tree accepts a complete 1025-level hierarchy produced by ordinary sync without applying block or wire depth limits', () => withV3Fixture(async f => {
  const records: SyncDocument[] = []
  for (let index = 0; index < 1025; index++) {
    const record: SyncDocument = { kind: 'document', id: randomUUID(), parentId: records.at(-1)?.id ?? null,
      sortOrder: -(index + 1), createdAt: '2026-01-02T03:04:05.006Z',
      content: { title: 'a', summary: '', blocks: [{ id: randomUUID(), type: 'paragraph', content: 'Ordinary deep source', checked: false, depth: 0, parentBlockId: null }] } }
    validateRecord(record, 'doc:' + record.id)
    records.push(record)
  }
  f.store.applySyncRecords(records)
  await unchangedSource(f, db => {
    const value = readRawCapsule2PhysicalGraphOwned(db), byId = new Map(value.documents.map(row => [row.documentId, row]))
    for (const record of records) {
      const row = byId.get(record.id)!
      assert.equal(row.parentId, record.parentId); assert.equal(row.sortOrder, record.sortOrder)
    }
    assert.equal(byId.get(records.at(-1)!.id)?.path, Array(1025).fill('a').join('/'))
  })
}))

for (const cycle of ['self', 'detached-pair'] as const) {
  test(`capsule2 source rejects a ${cycle} document parent cycle outside its valid Main group without modifying SQL`, () => withV3Fixture(async f => {
    const first = document(f, 'First'), second = document(f, 'Second')
    f.db.prepare('UPDATE documents SET parent_id=? WHERE id=?').run(cycle === 'self' ? first : second, first)
    if (cycle === 'detached-pair') f.db.prepare('UPDATE documents SET parent_id=? WHERE id=?').run(first, second)
    assert.deepEqual(f.db.pragma('foreign_key_check'), [])
    await unchangedSource(f, db => assert.throws(() => readRawCapsule2PhysicalGraphOwned(db), /文档.*父.*环/))
  }))
}

test('capsule2 source rejects exact duplicate sibling titles while their stored paths and block owners remain distinct', () => withV3Fixture(async f => {
  const parent = document(f, 'Parent'), first = document(f, 'First', parent), second = document(f, 'Second', parent)
  f.db.prepare('UPDATE documents SET title=? WHERE id=?').run('First', second)
  assert.notEqual(f.store.getDocumentSnapshot(first)?.path, f.store.getDocumentSnapshot(second)?.path)
  await unchangedSource(f, db => assert.throws(() => readRawCapsule2PhysicalGraphOwned(db), /文档.*同级.*标题/))
}))

for (const title of ['', ' spaced ', '.', '..', 'slash/name', 'back\\name', 'control\nname']) {
  test(`capsule2 source refuses invalid stored ordinary title ${JSON.stringify(title)} instead of normalizing it`, () => withV3Fixture(async f => {
    const id = document(f, 'Original')
    f.db.prepare('UPDATE documents SET title=? WHERE id=?').run(title, id)
    await unchangedSource(f, db => assert.throws(() => readRawCapsule2PhysicalGraphOwned(db), /文档.*标题/))
  }))
}
