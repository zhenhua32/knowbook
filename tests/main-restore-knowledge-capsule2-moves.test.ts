import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import test from 'node:test'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { assertRawCapsule2MovesOwned } from '../src/main/database/restore-knowledge-capsule2-moves-read'
import { decodedCapsule2Table, withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { snapshot, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'

function document(f: V3Fixture, title: string, parent: string | null = null) {
  const id = f.store.createDocument(parent)
  f.store.updateDocument(id, { ...f.store.getDocumentDetail(id)!, title })
  return id
}
function moved(f: V3Fixture, legacy?: 'delete' | 'rename' | 'deep', title = 'Transfer source') {
  const parent = legacy ? document(f, '😀') : null
  const top = document(f, legacy ? 'A' : title, parent), target = document(f, legacy ? 'B' : 'Transfer target', parent)
  const source = legacy === 'deep' ? document(f, 'C', top) : top
  const root = randomUUID(), child = randomUUID(), kept = randomUUID()
  f.store.updateDocument(source, { title: legacy === 'deep' ? 'C' : legacy ? 'A' : title, summary: 'Original summary {{date}}', blocks: [
    { id: root, type: 'toggle', content: 'Moving root', checked: false, depth: 0, markdownFormat: { toggleDefaultOpen: true }, tags: ['tag\0literal'] },
    { id: child, type: 'code', content: 'literal {{title}}', checked: false, depth: 1, parentBlockId: root, language: 'typescript', markdownFormat: { codeInfo: 'typescript\0literal' } },
    { id: kept, type: 'paragraph', content: 'Kept body', checked: false, depth: 0 }
  ] })
  const originals = [...new Set([top, target, source])].map(id => ({ id, path: f.store.getDocumentSnapshot(id)!.path }))
  if (parent) {
    if (legacy === 'rename') f.store.updateDocument(parent, { ...f.store.getDocumentDetail(parent)!, title: 'Renamed' })
    else f.store.deleteDocument(parent)
    // Exact old SQLite substring with the original JS UTF-16 prefix offset.
    const old = f.db.prepare('UPDATE documents SET path=? || substr(?,?) WHERE id=?')
    for (const row of originals) old.run(legacy === 'rename' ? 'Renamed/' : '', row.path, '😀/'.length + 1, row.id)
  }
  const a = f.store.getDocumentDetail(source)!, b = f.store.getDocumentDetail(target)!
  const result = f.store.moveDocumentBlocks({ fromDocumentId: source, toDocumentId: target, blockIds: [root],
    expectedFromUpdatedAt: a.updatedAt, expectedToUpdatedAt: b.updatedAt })
  assert.deepEqual(result.movedBlockIds, [root, child])
  return { source, target, root, child, kept, result }
}
type Move = ReturnType<typeof moved>
function changeSide(f: V3Fixture, move: Move, key: 'before_json' | 'after_json', change: (side: Array<any>) => void) {
  const row = f.db.prepare('SELECT ' + key + ' AS value FROM document_block_moves WHERE id=?').get(move.result.operationId) as { value: string }
  const side = JSON.parse(row.value); change(side)
  f.db.prepare('UPDATE document_block_moves SET ' + key + '=? WHERE id=?').run(JSON.stringify(side), move.result.operationId)
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

for (const mode of ['delete', 'rename', 'deep'] as const) test(`capsule2 move history retains literal ${mode} paths produced by the precise former astral-prefix writer`, () => withV3Fixture(async f => {
  const move = moved(f, mode)
  const original = f.db.prepare('SELECT * FROM document_block_moves WHERE id=?').get(move.result.operationId)
  await unchanged(f, db => {
    const value = readRawCapsule2WorkspaceHistoryOwned(db)
    assert.ok(value.historyDocuments.includes(move.source)); assert.ok(value.historyBlocks.includes(move.child))
    assert.deepEqual(db.prepare('SELECT * FROM document_block_moves WHERE id=?').get(move.result.operationId), original)
    const raw = decodedCapsule2Table(readRawCapsule2ContentOwned(db), 'document_block_moves').find(row => row.id === move.result.operationId)!
    assert.equal(raw.before_json, (original as { before_json: string }).before_json)
    const before = JSON.parse(raw.before_json as string)
    assert.equal(before.find((side: any) => side.documentId === move.source).path, mode === 'delete' ? '' : mode === 'rename' ? 'Renamed/' : '/C')
    assert.equal(value.certified, false); assert.equal(value.permit, false)
  })
}))

test('capsule2 move history keeps actual 501-character and DEL titles, NUL tags/code info and unchanged full snapshots', () => withV3Fixture(async f => {
  const title = '史'.repeat(501) + '\x7f', move = moved(f, undefined, title)
  f.store.deleteDocument(move.source)
  assert.equal(f.store.documentRecovery.getTrash(move.source).document.title, title)
  await unchanged(f, db => {
    const value = readRawCapsule2WorkspaceHistoryOwned(db)
    assert.ok(value.historyDocuments.includes(move.source))
    const row = db.prepare('SELECT before_json FROM document_block_moves WHERE id=?').get(move.result.operationId) as { before_json: string }
    const source = JSON.parse(row.before_json).find((side: any) => side.documentId === move.source)
    assert.equal(source.content.title, title); assert.deepEqual(source.content.blocks[0].tags, ['tag\0literal'])
    assert.equal(source.content.blocks[1].markdownFormat.codeInfo, 'typescript\0literal')
  })
}))

test('capsule2 move history preserves frozen sides after genuine undo/redo updates the independent expected versions', () => withV3Fixture(async f => {
  const move = moved(f), before = f.db.prepare('SELECT before_json,after_json,expected_versions_json FROM document_block_moves WHERE id=?').get(move.result.operationId) as { before_json: string; after_json: string; expected_versions_json: string }
  const undo = f.store.undoDocumentBlockMove({ operationId: move.result.operationId, expectedUpdatedAtByDocument: move.result.expectedUpdatedAtByDocument })
  await unchanged(f, db => readRawCapsule2WorkspaceHistoryOwned(db))
  f.store.redoDocumentBlockMove({ operationId: move.result.operationId, expectedUpdatedAtByDocument: undo.expectedUpdatedAtByDocument })
  const after = f.db.prepare('SELECT before_json,after_json,expected_versions_json FROM document_block_moves WHERE id=?').get(move.result.operationId) as typeof before
  assert.equal(after.before_json, before.before_json); assert.equal(after.after_json, before.after_json)
  assert.notEqual(after.expected_versions_json, before.expected_versions_json)
  await unchanged(f, db => readRawCapsule2WorkspaceHistoryOwned(db))
}))

test('capsule2 move history retains genuine stale snapshots after both ordinary participants and their trash are purged', () => withV3Fixture(async f => {
  const move = moved(f)
  for (const id of [move.source, move.target]) { f.store.deleteDocument(id); f.store.documentRecovery.purge(id) }
  await unchanged(f, db => {
    const value = readRawCapsule2WorkspaceHistoryOwned(db)
    assert.ok(value.historyDocuments.includes(move.source)); assert.ok(value.historyDocuments.includes(move.target))
    assert.ok(value.historyBlocks.includes(move.root)); assert.ok(value.historyBlocks.includes(move.child))
  })
}))

test('capsule2 move history keeps the actual empty paragraph birth when moving the entire source body', () => withV3Fixture(async f => {
  const source = f.store.createQuickNote({ title: 'Whole body source', content: 'Only paragraph' }), target = f.store.createQuickNote({ title: 'Whole body target', content: 'Existing paragraph' })
  const a = f.store.getDocumentDetail(source)!, b = f.store.getDocumentDetail(target)!
  const result = f.store.moveDocumentBlocks({ fromDocumentId: source, toDocumentId: target, blockIds: [a.blocks[0].id], expectedFromUpdatedAt: a.updatedAt, expectedToUpdatedAt: b.updatedAt })
  const replacement = f.store.getDocumentDetail(source)!.blocks
  assert.equal(replacement.length, 1); assert.equal(replacement[0].content, ''); assert.notEqual(replacement[0].id, a.blocks[0].id)
  await unchanged(f, db => {
    const value = readRawCapsule2WorkspaceHistoryOwned(db)
    assert.ok(value.historyBlocks.includes(replacement[0].id)); assert.ok(value.historyBlocks.includes(result.movedBlockIds[0]))
  })
}))

test('capsule2 move history retains all three actual participants when an incoming block link is rewritten', () => withV3Fixture(async f => {
  const source = f.store.createQuickNote({ title: 'Referenced source', content: 'Move this paragraph\n\nKeep this paragraph' })
  const target = f.store.createQuickNote({ title: 'Referenced target', content: 'Target body' })
  const body = f.store.getDocumentDetail(source)!.blocks[0].id
  const incoming = f.store.createQuickNote({ title: 'Incoming source', content: `[[Referenced source#${body}]] [move](Referenced%20source.md#${body})` })
  const a = f.store.getDocumentDetail(source)!, b = f.store.getDocumentDetail(target)!
  const result = f.store.moveDocumentBlocks({ fromDocumentId: source, toDocumentId: target, blockIds: [body], expectedFromUpdatedAt: a.updatedAt, expectedToUpdatedAt: b.updatedAt })
  assert.equal(result.affectedDocumentIds.length, 3); assert.ok(result.affectedDocumentIds.includes(incoming))
  await unchanged(f, db => assert.ok(readRawCapsule2WorkspaceHistoryOwned(db).historyDocuments.includes(incoming)))
}))

test('capsule2 move history observes the original legacy path after a real undo without claiming the frozen old route is an executable current snapshot', () => withV3Fixture(async f => {
  const move = moved(f, 'delete')
  const result = f.store.undoDocumentBlockMove({ operationId: move.result.operationId, expectedUpdatedAtByDocument: move.result.expectedUpdatedAtByDocument })
  assert.equal(result.state, 'undone')
  await unchanged(f, db => readRawCapsule2WorkspaceHistoryOwned(db))
}))

test('capsule2 move assertion requires its actual readonly query-only FK transaction and never repairs the original source', () => withV3Fixture(async f => {
  moved(f)
  assert.throws(() => assertRawCapsule2MovesOwned(f.db), /readonly\/query-only\/FKON/)
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => assertRawCapsule2MovesOwned(db), /readonly\/query-only\/FKON/)
    db.transaction(() => assertRawCapsule2MovesOwned(db))()
    db.pragma('query_only=OFF')
    assert.throws(() => db.transaction(() => assertRawCapsule2MovesOwned(db))(), /readonly\/query-only\/FKON/)
    db.pragma('query_only=ON'); db.pragma('foreign_keys=OFF')
    assert.throws(() => db.transaction(() => assertRawCapsule2MovesOwned(db))(), /readonly\/query-only\/FKON/)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })
}))

test('capsule2 move assertion rejects an unknown original table column even on an owned readonly connection', () => withV3Fixture(async f => {
  moved(f)
  f.db.exec('ALTER TABLE document_block_moves ADD COLUMN future TEXT')
  await withCapsule2RawCopy(f, db => assert.throws(() => db.transaction(() => assertRawCapsule2MovesOwned(db))(), /列闭集/))
}))

const corruptions: Array<[string, (f: V3Fixture, move: Move) => void]> = [
  ['BLOB creation time', (f, m) => f.db.prepare('UPDATE document_block_moves SET created_at=? WHERE id=?').run(Buffer.from('2026-01-01T00:00:00.000Z'), m.result.operationId)],
  ['BLOB update time', (f, m) => f.db.prepare('UPDATE document_block_moves SET updated_at=? WHERE id=?').run(Buffer.from('2026-01-01T00:00:00.000Z'), m.result.operationId)],
  ['reversed moved order', (f, m) => f.db.prepare('UPDATE document_block_moves SET moved_ids_json=? WHERE id=?').run(JSON.stringify([m.child, m.root]), m.result.operationId)],
  ['undeclared owner transfer', (f, m) => changeSide(f, m, 'after_json', side => {
    const a = side.find(value => value.documentId === m.source), b = side.find(value => value.documentId === m.target)
    const kept = a.content.blocks.find((block: any) => block.id === m.kept)
    a.content.blocks = a.content.blocks.filter((block: any) => block.id !== m.kept); b.content.blocks.push(kept)
  })],
  ['undeclared identity deletion', (f, m) => changeSide(f, m, 'after_json', side => {
    const a = side.find(value => value.documentId === m.source)
    a.content.blocks = a.content.blocks.filter((block: any) => block.id !== m.kept)
  })],
  ['unrelated identity birth', (f, m) => changeSide(f, m, 'after_json', side => {
    const a = side.find(value => value.documentId === m.source)
    a.content.blocks.push({ ...a.content.blocks[0], id: randomUUID() })
  })],
  ['missing participant', (f, m) => changeSide(f, m, 'before_json', side => side.splice(side.findIndex(value => value.documentId === m.target), 1))],
  ['duplicate participant', (f, m) => changeSide(f, m, 'after_json', side => side.push(structuredClone(side[0])))],
  ['extra side property', (f, m) => changeSide(f, m, 'before_json', side => { side[0].future = true })],
  ['extra body property', (f, m) => changeSide(f, m, 'before_json', side => { side[0].content.future = true })],
  ['nontext path', (f, m) => changeSide(f, m, 'before_json', side => { side[0].path = 3 })],
  ['nontext title', (f, m) => changeSide(f, m, 'before_json', side => { side[0].content.title = 3 })],
  ['NUL title', (f, m) => changeSide(f, m, 'before_json', side => { side[0].content.title = 'bad\0title' })],
  ['nontext summary', (f, m) => changeSide(f, m, 'after_json', side => { side[0].content.summary = 3 })],
  ['invalid side timestamp', (f, m) => changeSide(f, m, 'before_json', side => { side[0].updatedAt = 'not a date' })],
  ['duplicate block identity', (f, m) => changeSide(f, m, 'before_json', side => { side[0].content.blocks.push(structuredClone(side[0].content.blocks[0])) })],
  ['invalid parent forest', (f, m) => changeSide(f, m, 'before_json', side => { side[0].content.blocks[0].parentBlockId = m.child })],
  ['incomplete version map', (f, m) => f.db.prepare("UPDATE document_block_moves SET expected_versions_json='{}' WHERE id=?").run(m.result.operationId)],
  ['unknown version participant', (f, m) => f.db.prepare('UPDATE document_block_moves SET expected_versions_json=? WHERE id=?').run(JSON.stringify({ [randomUUID()]: '2026-01-01T00:00:00.000Z' }), m.result.operationId)]
]
for (const [name, change] of corruptions) test(`capsule2 move history rejects original ${name} without rewriting any source or Main ACK`, () => withV3Fixture(async f => {
  const move = moved(f); change(f, move)
  await unchanged(f, db => assert.throws(() => readRawCapsule2WorkspaceHistoryOwned(db)))
}))

test('capsule2 move history inspects every actual row through corruption of the final sorted member beyond 128 moves', () => withV3Fixture(async f => {
  const move = moved(f); let result = move.result
  for (let i = 1; i < 129; i++) {
    const from = i % 2 ? move.target : move.source, to = i % 2 ? move.source : move.target
    const a = f.store.getDocumentDetail(from)!, b = f.store.getDocumentDetail(to)!
    result = f.store.moveDocumentBlocks({ fromDocumentId: from, toDocumentId: to, blockIds: [move.root], expectedFromUpdatedAt: a.updatedAt, expectedToUpdatedAt: b.updatedAt })
  }
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM document_block_moves').get() as { n: number }).n, 129)
  await unchanged(f, db => readRawCapsule2WorkspaceHistoryOwned(db))
  const last = f.db.prepare('SELECT id FROM document_block_moves ORDER BY id DESC LIMIT 1').get() as { id: string }
  f.db.prepare('UPDATE document_block_moves SET created_at=? WHERE id=?').run(Buffer.from('2026-01-01T00:00:00.000Z'), last.id)
  await unchanged(f, db => assert.throws(() => readRawCapsule2WorkspaceHistoryOwned(db)))
}))
