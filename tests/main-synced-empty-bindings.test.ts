import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { assertSyncedStoredBindings, captureSyncedGroupBindings, maintainSyncedGroupBindings } from '../src/main/database/synced-block-links'
import { getSyncedOperation, restoreSyncedGroupOperation, updateSyncedBlockGroup } from '../src/main/database/synced-blocks-content'
import { SyncedValidationError, validateSyncedBindings } from '../src/shared/syncedBlockValidation'
import { buildSyncedPortableAssetUri, canonicalSyncedPortableJson, rewriteSyncedGroupAssets } from '../src/shared/syncedBlockPortable'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import type { SyncedGroupWire } from '../src/shared/synced-blocks'
import { edits, host, paragraph, restore, saved, snapshot, state, update, withDatabase } from './helpers/synced-content-fixture'

test('empty hrefs cover actual UTF16 parser points including titles and active definitions only', () => withDatabase(db => {
  const before = snapshot(db), content = '\uFEFF🙂 [a]() [b](<>) [c](  ) [d](<> "title")\r\n[use][ref]\r\n\r\n[ref]: <> "definition"\r\n\r\n`[code]()` ![image]() [quoted]( "title")'
  const blocks = [paragraph('destinations', content), { ...paragraph('code', '[code]()'), type: 'code', language: 'markdown' },
    { ...paragraph('math', '[math]()'), type: 'math' }]
  const bindings = captureSyncedGroupBindings(db, before.origin, blocks)
  assert.equal(bindings.length, 5)
  assert.equal(bindings.filter(binding => binding.from === binding.to).length, 5)
  const parsed = collectDocumentMarkdownLinks(blocks)
  const quoted = parsed.find(link => link.url === '%22title%22')!
  assert.ok(quoted.end > quoted.start, 'A quoted URL is nonempty; it is not an empty destination with a title')
  assert.ok(!bindings.some(binding => binding.from === quoted.start), 'An ineligible local-document URL is not bound')
  const actual = parsed.filter(link => link.kind !== 'image' && link.url === '')
  assert.equal(actual.length, bindings.length)
  for (let i = 0; i < bindings.length; i++) {
    assert.equal(bindings[i].from, actual[i].start); assert.equal(bindings[i].to, actual[i].end)
    assert.equal(content.slice(bindings[i].from, bindings[i].to), bindings[i].raw)
    if (bindings[i].raw === '') assert.deepEqual(bindings[i].target, { kind: 'document', id: host, state: 'live' })
  }
  assertSyncedStoredBindings(db, before.origin, blocks, bindings)
}))

test('empty binding shape and exact AST proof reject duplicate points, arbitrary empty substrings and hidden destinations', () => withDatabase(db => {
  const before = snapshot(db), blocks = [paragraph('body', '🙂 [self]()')]
  const bindings = captureSyncedGroupBindings(db, before.origin, blocks), empty = bindings[0]
  assert.deepEqual(validateSyncedBindings(bindings, blocks), bindings)
  for (const forged of [[empty, empty], [{ ...empty, syntax: 'wiki' }], [{ ...empty, raw: 'x' }],
    [{ ...empty, from: -1, to: -1 }], [{ ...empty, from: 1.5, to: 1.5 }]]) {
    assert.throws(() => validateSyncedBindings(forged, blocks), SyncedValidationError)
  }
  for (const point of [0, 2, empty.from - 1, empty.to + 1, blocks[0].content.length]) {
    assert.throws(() => assertSyncedStoredBindings(db, before.origin, blocks, [{ ...empty, from: point, to: point }]), SyncedValidationError)
  }
  assert.throws(() => assertSyncedStoredBindings(db, before.origin, [{ ...blocks[0], type: 'code', language: 'markdown' }], bindings), SyncedValidationError)
  const overlap = { ...empty, from: empty.from - 1, to: empty.to + 1, raw: blocks[0].content.slice(empty.from - 1, empty.to + 1) }
  assert.throws(() => validateSyncedBindings([empty, overlap], blocks), SyncedValidationError)
  assert.throws(() => assertSyncedStoredBindings(db, before.origin, blocks, []), SyncedValidationError)
}))

test('empty destination maintains exact origin across prefix shifts, source moves and same-path reuse', () => withDatabase(db => {
  const before = snapshot(db), blocks = [paragraph('body', '[self]()')]
  const bindings = captureSyncedGroupBindings(db, before.origin, blocks), original = { ...before, blocks, bindings }
  db.prepare('UPDATE documents SET path=? WHERE id=?').run('Moved/Source', host)
  db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), 'Replacement', 'Replacement', before.origin.pathAtCreation, before.createdAt, before.createdAt)
  const shifted = maintainSyncedGroupBindings(db, original, [paragraph('body', '🙂 prefix ' + blocks[0].content)])
  assert.deepEqual(shifted[0].target, bindings[0].target)
  assert.equal(shifted[0].from, bindings[0].from + '🙂 prefix '.length)
  assert.equal(shifted[0].to, shifted[0].from)
  assert.equal(shifted[0].raw, '')
}))

test('portable attachment rewriting preserves an adjacent empty destination as an exact parser point', () => withDatabase(db => {
  const before = snapshot(db), blocks = [paragraph('body', '![image](file:///C:/KnowBook/attachments/image.png)[self]()')]
  const input: SyncedGroupWire = { kind: 'synced-group', id: before.groupId, creationId: before.creationId,
    createdAt: before.createdAt, origin: before.origin, blocks, bindings: captureSyncedGroupBindings(db, before.origin, blocks) }
  const portable = buildSyncedPortableAssetUri({ hash: '1'.repeat(64), name: 'image.png' })
  const mapped = rewriteSyncedGroupAssets(input, () => portable)
  assert.notEqual(mapped.blocks[0].content, input.blocks[0].content)
  assert.ok(mapped.blocks[0].content.includes(portable))
  assertSyncedStoredBindings(db, mapped.origin, mapped.blocks, mapped.bindings)
  assert.equal(mapped.bindings[0].from, mapped.bindings[0].to)
  assert.equal(mapped.bindings[0].raw, '')
  assert.deepEqual(mapped.bindings[0].target, input.bindings[0].target)
}))

test('real content CAS journals empty bindings and exact Undo Redo replay without accepting forged points', () => withDatabase(db => {
  const before = snapshot(db), request = update(db, edits([{ ...before.blocks[0], content: '[self](<> "title")' }]))
  const first = saved(updateSyncedBlockGroup(db, request))
  assert.equal(first.snapshot.bindings[0].raw, '')
  assert.deepEqual(first.snapshot.bindings[0].target, { kind: 'document', id: host, state: 'live' })
  const inverse = saved(restoreSyncedGroupOperation(db, restore(db, 'undo')))
  assert.deepEqual(inverse.snapshot.bindings, before.bindings)
  const redone = saved(restoreSyncedGroupOperation(db, restore(db, 'redo')))
  assert.deepEqual(redone.snapshot.bindings, first.snapshot.bindings)
  assert.deepEqual(redone.snapshot.blocks, first.snapshot.blocks)
  const after = state(db)
  assert.deepEqual(updateSyncedBlockGroup(db, request), { ...first, replayed: true })
  assert.deepEqual(getSyncedOperation(db, { clientOperationId: request.clientOperationId }), { status: 'committed', result: { ...first, replayed: true } })
  assert.deepEqual(state(db), after)
}))

test('a journal with a forged empty point and a recomputed semantic hash still refuses real Undo atomically', () => withDatabase(db => {
  const before = snapshot(db)
  saved(updateSyncedBlockGroup(db, update(db, edits([{ ...before.blocks[0], content: '[self]()' }]))))
  saved(updateSyncedBlockGroup(db, update(db, edits([{ ...before.blocks[0], content: 'prefix [self]()' }]))))
  const undo = restore(db, 'undo')
  const row = db.prepare('SELECT before_json,before_hash FROM synced_group_history WHERE id=?').get(undo.historyToken) as
    { before_json: string; before_hash: string }
  const side = JSON.parse(row.before_json) as SyncedGroupWire
  side.bindings[0].from = 0; side.bindings[0].to = 0
  const forged = canonicalSyncedPortableJson(side), forgedHash = createHash('sha256').update(forged).digest('hex')
  db.prepare('UPDATE synced_group_history SET before_json=?,before_hash=? WHERE id=?').run(forged, forgedHash, undo.historyToken)
  const exact = state(db)
  assert.deepEqual(restoreSyncedGroupOperation(db, undo), { status: 'invalid', code: 'binding', blockingInstances: [] })
  assert.deepEqual(state(db), exact, 'A valid hash does not authorize an arbitrary source point or advance the tail')
  assert.equal(snapshot(db).history.undoToken, undo.historyToken)
  db.prepare('UPDATE synced_group_history SET before_json=?,before_hash=? WHERE id=?').run(row.before_json, row.before_hash, undo.historyToken)
  assert.equal(saved(restoreSyncedGroupOperation(db, undo)).snapshot.blocks[0].content, '[self]()')
}))
