import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowbookStore } from '../src/main/database/store'
import { assertSyncedStoredBindings, captureSyncedGroupBindings, maintainSyncedGroupBindings } from '../src/main/database/synced-block-links'
import { validateSyncedGroupSnapshot, SyncedValidationError } from '../src/shared/syncedBlockValidation'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import type { SyncedCanonicalWire, SyncedGroupSnapshot, SyncedLinkBinding, SyncedOriginV1 } from '../src/shared/synced-blocks'
import { unknownGroup27 } from './helpers/synced-lifecycle-fixture'

const born = '2020-01-02T03:04:05+08:00'
const paragraph = (id: string, content = 'Body'): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null })
const wire = (id: string, content: string): SyncedCanonicalWire => ({ ...paragraph(id, content), id, parentBlockId: null, createdAt: born })
function save(store: KnowbookStore, id: string, title: string, blocks: DocumentBlockDraft[] = [paragraph(randomUUID())]) {
  store.updateDocument(id, { title, summary: '', blocks }); return store.getDocumentDetail(id)!
}
function fixture(run: (value: Fixture) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-synced-links-')), store = new KnowbookStore(join(directory, 'workspace.db'))
  try {
    const parent = store.createDocument(null); save(store, parent, 'Folder')
    const source = store.createDocument(parent), target = store.createDocument(parent)
    save(store, source, 'Source', [{ ...paragraph('source-heading', 'Origin heading'), type: 'heading-1' }, paragraph('legacy:旧块', 'Old source block')])
    save(store, target, 'Target', [{ ...paragraph('target-heading-block', 'Target heading'), type: 'heading-1' }, paragraph('target-block', 'Target body')])
    const origin: SyncedOriginV1 = { version: 1, documentId: source, pathAtCreation: store.getDocumentDetail(source)!.path, firstInstanceId: randomUUID() }
    run({ store, db: store.getUnsafeDatabaseHandle(), parent, source, target, origin })
  } finally { store.destroy(); rmSync(directory, { recursive: true, force: true }) }
}
type Fixture = { store: KnowbookStore; db: ReturnType<KnowbookStore['getUnsafeDatabaseHandle']>; parent: string; source: string; target: string; origin: SyncedOriginV1 }
function snapshot(value: Fixture, blocks: SyncedCanonicalWire[], bindings = captureSyncedGroupBindings(value.db, value.origin, blocks)): SyncedGroupSnapshot {
  return validateSyncedGroupSnapshot({ groupId: randomUUID(), creationId: randomUUID(), createdAt: born,
    revision: randomUUID(), topologyRevision: randomUUID(), origin: value.origin, blocks, bindings, instances: [],
    history: { cursor: randomUUID(), undoToken: null, redoToken: null }, maxRelativeDepth: 0 })
}
const changes = (value: Fixture) => (value.db.prepare('SELECT total_changes() AS count').get() as { count: number }).count
function canonicalGroup(value: Fixture, blockId: string, createdAt: string, retained = false) {
  const id = randomUUID()
  value.db.transaction(() => {
    value.db.prepare(`INSERT INTO synced_groups(id,creation_id,created_at,origin_json,revision,topology_revision,history_cursor)
      VALUES(?,?,?,?,?,?,?)`).run(id, randomUUID(), born, JSON.stringify(value.origin), randomUUID(), randomUUID(), randomUUID())
    unknownGroup27(value.db, id, [wire(blockId, 'Canonical body')].map(block => ({ ...block, createdAt })))
    if (retained) value.db.prepare("UPDATE block_identities SET last_owner_kind='group',last_owner_id=? WHERE id=? AND state='retained'").run(id, blockId)
    value.db.prepare("INSERT INTO synced_group_blocks(id,group_id,sort_order,type,content,created_at) VALUES(?,?,0,'paragraph','Canonical body',?)")
      .run(blockId, id, createdAt)
  })()
  return id
}

test('bindings use actual whole-forest UTF16 destinations, including active reference definitions and Wiki aliases', () => fixture(value => {
  const blocks = [wire('canonical', '\uFEFF中文🙂 [normal](Target.md)\r\n[[Target|别名]]\r\n[use][ref]\r\n\r\n[ref]: Target.md#target-heading\r\n\r\n`[literal](Target.md)` ![image](asset.png) [web](https://example.com)'),
    { ...wire('literal-code', '[code](Target.md)'), type: 'code', language: 'markdown' },
    { ...wire('literal-math', '[math](Target.md)'), type: 'math' }]
  const before = changes(value), bindings = captureSyncedGroupBindings(value.db, value.origin, blocks)
  assert.equal(bindings.length, 3)
  assert.deepEqual(bindings.map(binding => binding.target), [
    { kind: 'document', id: value.target, state: 'live' }, { kind: 'document', id: value.target, state: 'live' },
    { kind: 'heading', documentId: value.target, slug: 'target-heading', state: 'live' }
  ])
  for (const binding of bindings) assert.equal(blocks.find(block => block.id === binding.blockId)!.content.slice(binding.from, binding.to), binding.raw)
  assertSyncedStoredBindings(value.db, value.origin, blocks, bindings)
  assert.equal(changes(value), before)
}))

test('Wiki keeps existing case-insensitive unique titles, exact paths and origin-owned bare opaque block IDs', () => fixture(value => {
  const blocks = [wire('canonical', '[[target]] [[folder/target]] [[legacy:旧块|Old block]] [[#Origin heading]]')]
  const bindings = captureSyncedGroupBindings(value.db, value.origin, blocks)
  assert.deepEqual(bindings.map(binding => binding.target), [
    { kind: 'document', id: value.target, state: 'live' }, { kind: 'document', id: value.target, state: 'live' },
    { kind: 'block', id: 'legacy:旧块', documentId: value.source, state: 'live' },
    { kind: 'heading', documentId: value.source, slug: 'origin-heading', state: 'live' }
  ])
  const secondParent = value.store.createDocument(null); save(value.store, secondParent, 'Second Folder')
  const other = value.store.createDocument(secondParent); save(value.store, other, 'TARGET')
  const ambiguous = captureSyncedGroupBindings(value.db, value.origin, [wire('ambiguous', '[[target]]')])[0]
  assert.equal(ambiguous.target.kind, 'unresolved-url', 'Multiple matching titles must not select the first row')
  const foreign = captureSyncedGroupBindings(value.db, value.origin, [wire('foreign', '[[target-block]]')])[0]
  assert.equal(foreign.target.kind, 'unresolved-url', 'A bare opaque ID cannot claim an unrelated owner')
}))

test('bare fragments and future relative links retain immutable origin context after the source moves and its old path is reused', () => fixture(value => {
  const destination = value.store.createDocument(null); save(value.store, destination, 'Elsewhere')
  value.store.moveDocument(value.source, destination)
  const replacement = value.store.createDocument(value.parent); save(value.store, replacement, 'Source', [{ ...paragraph('replacement-heading', 'Origin heading'), type: 'heading-1' }])
  const bindings = captureSyncedGroupBindings(value.db, value.origin, [wire('canonical', '[heading](#origin-heading) [self](#) [relative](Target.md)')])
  assert.deepEqual(bindings.map(binding => binding.target), [
    { kind: 'heading', documentId: value.source, slug: 'origin-heading', state: 'live' },
    { kind: 'document', id: value.source, state: 'live' }, { kind: 'document', id: value.target, state: 'live' }
  ])
  value.store.deleteDocument(value.source)
  const missing = captureSyncedGroupBindings(value.db, value.origin, [wire('missing', '[self](#) [heading](#origin-heading)')])
  assert.deepEqual(missing.map(binding => binding.target), [
    { kind: 'document', id: value.source, state: 'missing' }, { kind: 'heading', documentId: value.source, slug: 'origin-heading', state: 'missing' }
  ])
}))

test('known document targets and captured journal state do not retarget after rename, deletion and same-path replacement', () => fixture(value => {
  const before = snapshot(value, [wire('canonical', '[old](Target.md)')]), original = before.bindings[0].target
  save(value.store, value.target, 'Renamed', value.store.getDocumentDetail(value.target)!.blocks)
  const replacement = value.store.createDocument(value.parent); save(value.store, replacement, 'Target')
  const candidate = [wire('canonical', 'prefix [old](Target.md)')]
  assert.deepEqual(maintainSyncedGroupBindings(value.db, before, candidate)[0].target, original)
  value.store.deleteDocument(value.target)
  const count = changes(value), bindings = maintainSyncedGroupBindings(value.db, before, candidate)
  assert.deepEqual(bindings[0].target, original)
  assert.notEqual((bindings[0].target as { id: string }).id, replacement)
  assert.equal(changes(value), count)
  assertSyncedStoredBindings(value.db, before.origin, before.blocks, before.bindings)
}))

test('stable block bindings survive an actual document-to-canonical transition and new links can follow an observed old route', () => fixture(value => {
  const before = snapshot(value, [wire('canonical', '[block](Target.md#^target-block)')])
  const birth = (value.db.prepare("SELECT created_at FROM blocks WHERE id='target-block'").get() as { created_at: string }).created_at
  save(value.store, value.target, 'Moved Target', value.store.getDocumentDetail(value.target)!.blocks)
  save(value.store, value.target, 'Moved Target', [paragraph('target-keep')])
  canonicalGroup(value, 'target-block', birth, true)
  const bindings = maintainSyncedGroupBindings(value.db, before, [wire('canonical', 'prefix [block](Target.md#^target-block)')])
  assert.deepEqual(bindings[0].target, before.bindings[0].target, 'History retains the captured owner hint; current owner comes from the ledger')
  const newlyCaptured = captureSyncedGroupBindings(value.db, value.origin, [wire('fresh', '[route](Target.md#^target-block) [canonical](#^target-block)')])
  assert.deepEqual(newlyCaptured.map(binding => binding.target), [
    { kind: 'block', id: 'target-block', documentId: null, state: 'live' }, { kind: 'block', id: 'target-block', documentId: null, state: 'live' }
  ])
  assert.equal((value.db.prepare("SELECT created_at FROM synced_group_blocks WHERE id='target-block'").get() as { created_at: string }).created_at, birth)
}))

test('a retained known block stays bound while unknown paths and unknown block IDs stay unresolved without inventing reservations', () => fixture(value => {
  const before = snapshot(value, [wire('canonical', '[known](Target.md#^target-block) [unknown](Missing.md) [unknown-id](Target.md#^not-yet-known)')])
  save(value.store, value.target, 'Target', [paragraph('target-keep')])
  const replacement = value.store.createDocument(value.parent); save(value.store, replacement, 'Missing')
  const count = changes(value), bindings = maintainSyncedGroupBindings(value.db, before, [wire('canonical', 'prefix ' + before.blocks[0].content)])
  assert.deepEqual(bindings.map(binding => binding.target), before.bindings.map(binding => binding.target))
  assert.equal(bindings[0].target.kind, 'block')
  assert.equal(bindings[1].target.kind, 'unresolved-url')
  assert.equal(bindings[2].target.kind, 'unresolved-url')
  assert.equal(value.db.prepare("SELECT 1 FROM block_identities WHERE id='not-yet-known'").get(), undefined)
  assert.equal(changes(value), count)
}))

test('split, join, duplicate and edits surrounding an existing destination reject without guessing its old target', () => fixture(value => {
  const before = snapshot(value, [wire('canonical', 'before [old](Target.md) after')]), count = changes(value)
  const candidates = [
    [wire('canonical', 'changed-before [old](Target.md) changed-after')],
    [wire('canonical', 'before '), wire('fresh', '[old](Target.md) after')],
    [wire('canonical', before.blocks[0].content + ' [copy](Target.md)')]
  ]
  for (const candidate of candidates) assert.throws(() => maintainSyncedGroupBindings(value.db, before, candidate), SyncedValidationError)
  const repeated = snapshot(value, [wire('a', '[one](Target.md)'), wire('b', '[two](Target.md)')])
  repeated.bindings[1].target = { kind: 'document', id: value.source, state: 'live' }
  assert.throws(() => maintainSyncedGroupBindings(value.db, repeated, [wire('joined', '[one](Target.md) [two](Target.md)')]), SyncedValidationError)
  assert.equal(changes(value), count)
  assert.equal(value.db.inTransaction, false)
}))

test('new destinations resolve only inside genuinely new text, while deletion and single-span shifts retain exact old identities', () => fixture(value => {
  const other = value.store.createDocument(value.parent); save(value.store, other, 'Other')
  const before = snapshot(value, [wire('canonical', '[old](Target.md)')])
  const after = [wire('canonical', '[new](Other.md) ' + before.blocks[0].content)]
  assert.deepEqual(maintainSyncedGroupBindings(value.db, before, after).map(binding => binding.target), [
    { kind: 'document', id: other, state: 'live' }, before.bindings[0].target
  ])
  assert.deepEqual(maintainSyncedGroupBindings(value.db, before, [wire('canonical', 'Removed')]), [])
  const literal = snapshot(value, [{ ...wire('literal', '[link](Target.md)'), type: 'code', language: 'markdown' }])
  assert.throws(() => maintainSyncedGroupBindings(value.db, literal, [wire('literal', literal.blocks[0].content)]), /实际新文字范围/)
}))

test('stored bindings must cover exact parser ranges rather than matching arbitrary equal URL text', () => fixture(value => {
  const blocks = [wire('canonical', 'Target.md [real](Target.md)')], bindings = captureSyncedGroupBindings(value.db, value.origin, blocks)
  const count = changes(value)
  assert.throws(() => assertSyncedStoredBindings(value.db, value.origin, blocks, []), /覆盖/)
  assert.throws(() => assertSyncedStoredBindings(value.db, value.origin, blocks, [{ ...bindings[0], from: 0, to: 9, raw: 'Target.md' }]), /语法/)
  assert.throws(() => assertSyncedStoredBindings(value.db, value.origin, blocks, [{ ...bindings[0], syntax: 'wiki' }]), /语法/)
  const forged: SyncedLinkBinding = { ...bindings[0], target: { kind: 'block', id: 'not-reserved', documentId: value.source, state: 'missing' } }
  assert.throws(() => assertSyncedStoredBindings(value.db, value.origin, blocks, [forged]), /保留身份/)
  assert.equal(changes(value), count)
}))

test('actual empty local hrefs bind their exact parser point to immutable origin', () => fixture(value => {
  for (const content of ['[self]()', '[self](<>)']) {
    const blocks = [wire('empty', content)], bindings = captureSyncedGroupBindings(value.db, value.origin, blocks)
    assert.equal(bindings.length, 1)
    assert.equal(bindings[0].from, bindings[0].to)
    assert.equal(bindings[0].raw, '')
    assert.deepEqual(bindings[0].target, { kind: 'document', id: value.source, state: 'live' })
    assertSyncedStoredBindings(value.db, value.origin, blocks, bindings)
  }
}))
