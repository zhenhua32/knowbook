import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { SyncedBindingKey, SyncedBindingSource, SyncedCanonicalWire, SyncedGroupSaved, SyncedGroupSnapshot,
  SyncedUpdateGroupInput } from '../src/shared/synced-blocks'
import { SyncedValidationError, isSyncedUuid } from '../src/shared/syncedBlockValidation'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'
import { captureSyncedGroupBindings } from '../src/main/database/synced-block-links'
import { captureSyncedBaselineOwner, getSyncedOperationWithOwnedLinkSource, releaseSyncedReadOwner,
  getSyncedGroupSnapshotsWithLinkSources, getSyncedOperationWithLinkSource, resolveSyncedBindingSource,
  SYNCED_BINDING_SOURCE_LIMITS } from '../src/main/database/synced-binding-sources'
import { updateSyncedBlockGroup, restoreSyncedGroupOperation } from '../src/main/database/synced-blocks-content'
import { installSyncedLifecycleSchema } from '../src/main/database/synced-lifecycle-schema'
import { createdGroup27, retireFixture27 } from './helpers/synced-lifecycle-fixture'
import { born, now, host, other, groupId, uuid, paragraph, edits, initialize, createGroup, addInstance, ordinary,
  withDatabase, withTwoClients, snapshot, restore, saved } from './helpers/synced-content-fixture'

type Owner = Extract<ReturnType<typeof captureSyncedBaselineOwner>, { status: 'ready' }>
type Committed = Extract<ReturnType<typeof getSyncedOperationWithOwnedLinkSource>, { status: 'committed' }>
const key = ({ blockId, from, to, raw, syntax }: SyncedBindingKey): SyncedBindingKey => ({ blockId, from, to, raw, syntax })

function totalChanges(db: Database.Database): number {
  return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
}
/** Include every persistent table, sqlite_sequence, schema objects and version;
 * the existing content fixture's table list intentionally predates schema 27. */
function persisted(db: Database.Database) {
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>)
    .map(({ name }) => {
      assert.match(name, /^[A-Za-z_][A-Za-z_0-9]*$/)
      const rows = db.prepare(`SELECT * FROM "${name}"`).all().map(row => canonicalSyncedPortableJson(row)).sort()
      return { name, rows }
    })
  return { schema, tables, version: db.pragma('user_version', { simple: true }) }
}
function readOnly<T>(db: Database.Database, run: () => T): T {
  const before = persisted(db), changes = totalChanges(db), transaction = db.inTransaction
  try { return run() }
  finally {
    assert.equal(totalChanges(db), changes, 'Read ownership never executes DML, even DML later rolled back')
    assert.deepEqual(persisted(db), before, 'Read ownership preserves all tables, schema objects and user_version')
    assert.equal(db.inTransaction, transaction, 'Read ownership does not leak or end a caller transaction')
  }
}
function baseline(db: Database.Database, id = groupId): Owner {
  const result = captureSyncedBaselineOwner(db, { groupId: id })
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') throw new Error('Fixture requires a real ready baseline')
  assert.ok(isSyncedUuid(result.readOwnerId), 'Main issues a UUID read owner')
  assert.ok(isSyncedUuid(result.bindingSource.ticketId), 'Main issues a UUID baseline alias even for empty sources')
  return result
}
function owned(db: Database.Database, owner: Owner, ack: SyncedGroupSaved): Committed {
  const result = getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: owner.readOwnerId, clientOperationId: ack.operationId })
  assert.equal(result.status, 'committed')
  if (result.status !== 'committed') throw new Error('Fixture requires the actual original committed ACK')
  assert.equal(result.workspaceScope, uuid(900))
  assert.deepEqual(result.result, { ...ack, replayed: true }, 'Read the original durable ACK rather than a current snapshot')
  return result
}
function firstEntry(source: SyncedBindingSource) {
  const entry = source.entries[0]
  assert.ok(entry, 'Fixture requires a real parsed link source entry')
  return entry
}
function resolveFirst(db: Database.Database, source: SyncedBindingSource) {
  return resolveSyncedBindingSource(db, source.ticketId, firstEntry(source).entryId)
}
function seed(db: Database.Database, content = '[old](Target.md)'): SyncedGroupSnapshot {
  db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Target', 'Original/Target', other)
  const before = snapshot(db), blocks = [{ ...before.blocks[0], content }]
  const bindings = captureSyncedGroupBindings(db, before.origin, blocks)
  db.prepare('UPDATE synced_group_blocks SET content=? WHERE group_id=?').run(content, groupId)
  db.prepare('UPDATE synced_groups SET bindings_json=? WHERE id=?').run(JSON.stringify(bindings), groupId)
  return snapshot(db)
}
function inputFor(db: Database.Database, content: string, id = groupId): SyncedUpdateGroupInput {
  const before = snapshot(db, id), instance = before.instances[0], blocks = [{ ...before.blocks[0], content }]
  assert.ok(instance, 'A real content writer requires its actual mounted instance')
  return { groupId: id, expectedRevision: before.revision, expectedTopologyRevision: before.topologyRevision,
    expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId,
      bindingVersion: instance.bindingVersion }, clientOperationId: randomUUID(), blocks: edits(blocks),
    bindingClaims: captureSyncedGroupBindings(db, before.origin, blocks).map(destination => ({ kind: 'new', destination: key(destination) })) }
}
function saveBody(db: Database.Database, content: string, id = groupId): SyncedGroupSaved {
  return saved(updateSyncedBlockGroup(db, inputFor(db, content, id)))
}
function copyInput(db: Database.Database, content: string, source: SyncedBindingSource): SyncedUpdateGroupInput {
  const input = inputFor(db, content), entry = firstEntry(source)
  return { ...input, bindingClaims: input.bindingClaims!.map(claim => ({ kind: 'copy', destination: claim.destination,
    source: { kind: 'ticket', ticketId: source.ticketId, entryId: entry.entryId } })) }
}
function legacy(db: Database.Database, id = groupId): SyncedBindingSource {
  const item = getSyncedGroupSnapshotsWithLinkSources(db, { groupIds: [id] }).items[0]
  assert.equal(item.status, 'ready')
  if (item.status !== 'ready') throw new Error('Fixture requires a real legacy source')
  return item.bindingSource
}
function replaceTarget(db: Database.Database): string {
  db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Renamed', 'Original/Renamed', other)
  const id = randomUUID()
  db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, 'Target', id, 'Original/Target', born, now)
  return id
}
function unavailable(db: Database.Database, owner: Owner, operation: string = randomUUID()): void {
  assert.deepEqual(getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: owner.readOwnerId, clientOperationId: operation }),
    { status: 'owner-unavailable' })
}
function install27(db: Database.Database): void {
  db.pragma('user_version=26')
  db.transaction(() => { installSyncedLifecycleSchema(db, now); db.pragma('user_version=27') })()
}
/** Legal persistent envelope, without claiming a production structure inverse. */
function reactivateFixture27(db: Database.Database, fixture: ReturnType<typeof createdGroup27>): void {
  const revision = randomUUID(), topologyRevision = randomUUID(), bindingVersion = randomUUID()
  db.transaction(() => {
    db.prepare('UPDATE synced_groups SET revision=?,topology_revision=? WHERE id=?').run(revision, topologyRevision, fixture.groupId)
    db.prepare(`UPDATE synced_group_lifecycle SET state='active',state_version=state_version+1,activation_revision=?,
      activation_topology_revision=?,activation_hash=?,activation_instances_json=?,updated_at=? WHERE group_id=?`)
      .run(revision, topologyRevision, fixture.hash, canonicalSyncedPortableJson([{ instanceId: fixture.instanceId,
        hostDocumentId: host, bindingVersion }]), now, fixture.groupId)
    const block = fixture.wire.blocks[0]
    db.prepare(`INSERT INTO synced_group_blocks(id,group_id,sort_order,type,content,checked,depth,created_at)
      VALUES(?,?,0,'paragraph',?,0,0,?)`).run(block.id, fixture.groupId, block.content, block.createdAt)
    const order = (db.prepare('SELECT coalesce(max(sort_order),-1)+1 AS n FROM blocks WHERE document_id=?').get(host) as { n: number }).n
    db.prepare(`INSERT INTO blocks(id,document_id,sort_order,type,content,checked,depth,created_at,updated_at)
      VALUES(?,?,?,'synced-block',?,0,0,?,?)`).run(fixture.instanceId, host, order,
      JSON.stringify({ version: 1, groupId: fixture.groupId }), born, now)
    db.prepare('INSERT INTO synced_instances(instance_id,group_id,host_document_id,binding_version,parent_block_id,depth) VALUES(?,?,?,?,NULL,0)')
      .run(fixture.instanceId, fixture.groupId, host, bindingVersion)
    db.prepare('DELETE FROM synced_group_retirements WHERE group_id=?').run(fixture.groupId)
  })()
  assert.equal(snapshot(db, fixture.groupId).revision, revision, 'The reactivated SQL fixture passes the actual full reader')
}

test('read-owner inputs are closed UUID data objects and never evaluate supplied accessors', () => withDatabase(db => {
  seed(db)
  const owner = baseline(db), ack = saveBody(db, '[committed](Target.md)')
  let getterCalls = 0
  const APIs: Array<{ run: (input: unknown) => unknown; valid: Record<string, string> }> = [
    { run: input => captureSyncedBaselineOwner(db, input), valid: { groupId } },
    { run: input => getSyncedOperationWithOwnedLinkSource(db, input), valid: { readOwnerId: owner.readOwnerId, clientOperationId: ack.operationId } },
    { run: input => releaseSyncedReadOwner(db, input), valid: { readOwnerId: owner.readOwnerId } }
  ]
  readOnly(db, () => {
    for (const { run, valid } of APIs) {
      const hidden = Object.defineProperty({ ...valid }, 'hidden', { value: true, enumerable: false })
      const symbol = { ...valid, [Symbol('extra')]: true }
      const field = Object.keys(valid)[0]
      const getter = Object.defineProperty({ ...valid }, field, { enumerable: true,
        get() { getterCalls++; return valid[field] } })
      for (const input of [null, [], {}, { ...valid, [field]: 'bad' }, { ...valid, extra: true }, hidden, symbol, getter]) {
        assert.throws(() => run(input), SyncedValidationError)
      }
    }
    assert.equal(getterCalls, 0, 'Input validation rejects getters without running caller code')
    owned(db, owner, ack)
  })
}))

test('empty and missing baselines use actual snapshots and distinguish unavailable owners from unknown operations', () => withDatabase(db => {
  readOnly(db, () => {
    const expected = snapshot(db), owner = baseline(db)
    assert.equal(owner.workspaceScope, uuid(900)); assert.deepEqual(owner.snapshot, expected)
    assert.deepEqual(owner.bindingSource.entries, [])
    const missingId = randomUUID()
    assert.deepEqual(captureSyncedBaselineOwner(db, { groupId: missingId }),
      { status: 'missing', workspaceScope: uuid(900), groupId: missingId })
    assert.deepEqual(getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: owner.readOwnerId, clientOperationId: randomUUID() }),
      { status: 'unknown-operation' })
    unavailable(db, { ...owner, readOwnerId: randomUUID() })
    releaseSyncedReadOwner(db, { readOwnerId: owner.readOwnerId })
    releaseSyncedReadOwner(db, { readOwnerId: owner.readOwnerId })
    unavailable(db, owner)
  })
}))

test('owners have independent aliases while each owner reuses its own exact baseline and original noop source', () => withDatabase(db => {
  seed(db)
  const left = baseline(db), right = baseline(db), old = legacy(db), ack = saveBody(db, '[old](Target.md)')
  assert.equal(ack.status, 'noop')
  readOnly(db, () => {
    assert.notEqual(left.readOwnerId, right.readOwnerId)
    assert.equal(new Set([left.bindingSource.ticketId, right.bindingSource.ticketId, old.ticketId]).size, 3)
    assert.deepEqual(owned(db, left, ack).bindingSource, left.bindingSource)
    assert.deepEqual(owned(db, right, ack).bindingSource, right.bindingSource)
    assert.deepEqual(legacy(db), old)
    const original = resolveFirst(db, old)
    assert.deepEqual(resolveFirst(db, left.bindingSource), original)
    assert.deepEqual(resolveFirst(db, right.bindingSource), original)
  })
}))

test('release revokes exactly one owner and its aliases while preserving another owner and every legacy alias', () => withDatabase(db => {
  seed(db)
  const left = baseline(db), right = baseline(db), old = legacy(db), ack = saveBody(db, '[different](Target.md)')
  const leftOperation = owned(db, left, ack), rightOperation = owned(db, right, ack)
  const legacyOperation = getSyncedOperationWithLinkSource(db, { clientOperationId: ack.operationId })
  assert.equal(legacyOperation.status, 'committed')
  if (legacyOperation.status !== 'committed') throw new Error('Real legacy ACK fixture')
  readOnly(db, () => {
    releaseSyncedReadOwner(db, { readOwnerId: left.readOwnerId })
    releaseSyncedReadOwner(db, { readOwnerId: left.readOwnerId })
    unavailable(db, left, ack.operationId)
    for (const source of [left.bindingSource, leftOperation.bindingSource]) assert.throws(() => resolveFirst(db, source), /失效/)
    assert.deepEqual(owned(db, right, ack), rightOperation)
    assert.deepEqual(resolveFirst(db, old).target, { kind: 'document', id: other, state: 'live' })
    assert.deepEqual(resolveFirst(db, legacyOperation.bindingSource).target, ack.snapshot.bindings[0].target)
  })
}))

test('outward baseline ACK key and resolved-target mutations cannot alter retained facts or another caller DTO', () => withDatabase(db => {
  seed(db)
  const owner = baseline(db), baselineCopy = structuredClone(owner), ack = saveBody(db, '[committed](Target.md)')
  const committed = owned(db, owner, ack), committedCopy = structuredClone(committed)
  const resolved = resolveFirst(db, owner.bindingSource), resolvedCopy = structuredClone(resolved)
  owner.snapshot.blocks[0].content = 'caller changed baseline'
  owner.snapshot.bindings[0].raw = 'caller changed binding'
  owner.bindingSource.entries[0].key.raw = 'caller changed public key'
  committed.result.snapshot.blocks[0].content = 'caller changed ACK'
  committed.bindingSource.entries[0].key.from = -1
  resolved.key.raw = 'caller changed resolved key'
  assert.equal(resolved.target.kind, 'document')
  if (resolved.target.kind !== 'document') throw new Error('Mutation fixture requires its actual document target')
  resolved.target.id = 'caller changed target'
  readOnly(db, () => {
    assert.deepEqual(resolveFirst(db, baselineCopy.bindingSource), resolvedCopy)
    assert.deepEqual(owned(db, baselineCopy, ack), committedCopy)
    const again = owned(db, baselineCopy, ack)
    again.bindingSource.entries.length = 0
    assert.deepEqual(owned(db, baselineCopy, ack), committedCopy)
    const next = baseline(db)
    assert.deepEqual(next.snapshot, snapshot(db))
    assert.notEqual(next.readOwnerId, baselineCopy.readOwnerId)
  })
}))

test('two actual SQLite connections cannot use or release each other read owners and owned aliases', () => withTwoClients((a, b) => {
  seed(a)
  const ack = saveBody(a, '[committed](Target.md)'), left = baseline(a), right = baseline(b)
  readOnly(b, () => {
    unavailable(b, left, ack.operationId)
    assert.throws(() => resolveFirst(b, left.bindingSource), /失效/)
    releaseSyncedReadOwner(b, { readOwnerId: left.readOwnerId })
    owned(b, right, ack)
  })
  readOnly(a, () => {
    owned(a, left, ack)
    assert.throws(() => resolveFirst(a, right.bindingSource), /失效/)
    releaseSyncedReadOwner(a, { readOwnerId: left.readOwnerId })
  })
  readOnly(b, () => owned(b, right, ack))
}))

test('a recovery epoch changed by the other real connection invalidates old owners and cannot revive them on recapture', () => withTwoClients((a, b) => {
  seed(a)
  const ack = saveBody(a, '[committed](Target.md)'), before = baseline(a), oldLegacy = legacy(a)
  b.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
  readOnly(a, () => {
    unavailable(a, before, ack.operationId)
    assert.throws(() => resolveFirst(a, before.bindingSource), /失效/)
    assert.throws(() => resolveFirst(a, oldLegacy), /失效/)
    releaseSyncedReadOwner(a, { readOwnerId: before.readOwnerId })
    const next = baseline(a)
    assert.notEqual(next.readOwnerId, before.readOwnerId)
    assert.notEqual(next.bindingSource.ticketId, before.bindingSource.ticketId)
    assert.deepEqual(next.snapshot, before.snapshot)
    owned(a, next, ack)
    unavailable(a, before, ack.operationId)
  })
}))

test('closing reopening and replacing a real database file never carries private owners into the new connection', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-read-owner-')), file = join(root, 'live.db'), backup = join(root, 'replacement.db')
  let db: Database.Database | undefined
  try {
    db = new Database(file); initialize(db); seed(db)
    const ack = saveBody(db, '[committed](Target.md)'), first = baseline(db)
    db.close(); copyFileSync(file, backup)
    db = new Database(file); db.pragma('foreign_keys=ON')
    const reopened = db
    readOnly(reopened, () => { unavailable(reopened, first, ack.operationId); assert.throws(() => resolveFirst(reopened, first.bindingSource), /失效/) })
    const second = baseline(db)
    assert.notEqual(first.readOwnerId, second.readOwnerId)
    db.close()
    const restored = new Database(backup)
    try { restored.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID()) }
    finally { restored.close() }
    copyFileSync(backup, file)
    db = new Database(file); db.pragma('foreign_keys=ON')
    const replaced = db
    readOnly(replaced, () => {
      unavailable(replaced, first, ack.operationId); unavailable(replaced, second, ack.operationId)
      assert.throws(() => resolveFirst(replaced, second.bindingSource), /失效/)
      const next = baseline(replaced)
      assert.deepEqual(next.snapshot, first.snapshot)
      owned(replaced, next, ack)
    })
  } finally {
    if (db?.open) db.close()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('knowbook-read-owner-'), 'Only the dedicated temporary fixture directory is removed')
    rmSync(root, { recursive: true, force: true })
  }
})

test('capture and owned lookup reject caller read and write transactions without signing rolled-back receipts', () => withDatabase(db => {
  seed(db)
  const owner = baseline(db), ack = saveBody(db, '[committed](Target.md)'), before = persisted(db)
  assert.throws(() => db.transaction(() => captureSyncedBaselineOwner(db, { groupId }))(), /独占只读事务/)
  assert.throws(() => db.transaction(() => getSyncedOperationWithOwnedLinkSource(db,
    { readOwnerId: owner.readOwnerId, clientOperationId: ack.operationId }))(), /独占只读事务/)
  const fakeId = randomUUID()
  assert.throws(() => db.transaction(() => {
    db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
      .run(fakeId, 'a'.repeat(64), JSON.stringify({ ...ack, operationId: fakeId }), now)
    getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: owner.readOwnerId, clientOperationId: fakeId })
  }).immediate(), /独占只读事务/)
  assert.throws(() => db.transaction(() => {
    db.prepare('UPDATE synced_group_blocks SET content=? WHERE group_id=?').run('uncommitted', groupId)
    captureSyncedBaselineOwner(db, { groupId })
  }).immediate(), /独占只读事务/)
  assert.deepEqual(persisted(db), before)
  readOnly(db, () => {
    assert.deepEqual(getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: owner.readOwnerId, clientOperationId: fakeId }),
      { status: 'unknown-operation' })
    owned(db, owner, ack)
  })
}))

test('release is pure memory inside a writer and remains released when that writer rolls back', () => withDatabase(db => {
  seed(db)
  const left = baseline(db), right = baseline(db), old = legacy(db), before = persisted(db)
  assert.throws(() => db.transaction(() => {
    db.prepare('UPDATE documents SET title=? WHERE id=?').run('uncommitted title', other)
    readOnly(db, () => {
      releaseSyncedReadOwner(db, { readOwnerId: left.readOwnerId })
      releaseSyncedReadOwner(db, { readOwnerId: left.readOwnerId })
      assert.equal(db.inTransaction, true)
    })
    throw new Error('Fixture rollback after memory-only release')
  }).immediate(), /Fixture rollback/)
  assert.deepEqual(persisted(db), before)
  readOnly(db, () => {
    unavailable(db, left)
    assert.throws(() => resolveFirst(db, left.bindingSource), /失效/)
    assert.deepEqual(resolveFirst(db, right.bindingSource), resolveFirst(db, old))
  })
}))

test('release after the actual SQLite connection closes proves cleanup does not read the database', () => {
  const db = new Database(':memory:')
  try {
    initialize(db); seed(db)
    const owner = baseline(db)
    db.close()
    assert.doesNotThrow(() => releaseSyncedReadOwner(db, { readOwnerId: owner.readOwnerId }))
    assert.doesNotThrow(() => releaseSyncedReadOwner(db, { readOwnerId: owner.readOwnerId }))
    assert.throws(() => releaseSyncedReadOwner(db, { readOwnerId: 'invalid' }), SyncedValidationError)
  } finally { if (db.open) db.close() }
})

test('query-only SQLite accepts ready missing unknown unavailable and release with every table and schema unchanged', () => withDatabase(db => {
  seed(db); install27(db)
  const ack = saveBody(db, '[committed](Target.md)'), noop = saveBody(db, '[committed](Target.md)')
  db.pragma('query_only=ON')
  try { readOnly(db, () => {
    const owner = baseline(db)
    const first = owned(db, owner, ack), second = owned(db, owner, noop)
    assert.deepEqual(first.bindingSource, second.bindingSource)
    assert.deepEqual(getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: owner.readOwnerId, clientOperationId: randomUUID() }),
      { status: 'unknown-operation' })
    const missingId = randomUUID()
    assert.deepEqual(captureSyncedBaselineOwner(db, { groupId: missingId }),
      { status: 'missing', workspaceScope: uuid(900), groupId: missingId })
    releaseSyncedReadOwner(db, { readOwnerId: owner.readOwnerId }); unavailable(db, owner, ack.operationId)
  }) } finally { db.pragma('query_only=OFF') }
}))

test('normal content topology binding and history changes do not turn a historical read owner into a writer lease', () => withDatabase(db => {
  seed(db)
  const owner = baseline(db), ack = saveBody(db, '[committed](Target.md)')
  saveBody(db, 'A later current revision')
  db.prepare('UPDATE synced_groups SET topology_revision=?,history_cursor=? WHERE id=?').run(randomUUID(), randomUUID(), groupId)
  db.prepare('UPDATE synced_instances SET binding_version=? WHERE group_id=?').run(randomUUID(), groupId)
  const origin = snapshot(db).origin
  db.prepare('UPDATE synced_groups SET origin_json=? WHERE id=?').run(JSON.stringify({ firstInstanceId: origin.firstInstanceId,
    pathAtCreation: origin.pathAtCreation, documentId: origin.documentId, version: origin.version }), groupId)
  readOnly(db, () => {
    owned(db, owner, ack)
    assert.deepEqual(resolveFirst(db, owner.bindingSource).target, { kind: 'document', id: other, state: 'live' })
    assert.notEqual(snapshot(db).revision, owner.snapshot.revision)
    assert.notEqual(snapshot(db).topologyRevision, owner.snapshot.topologyRevision)
  })
}))

test('immutable creation timestamp or origin replacement invalidates both lookup and an owned alias in the real copy writer', () => {
  for (const field of ['creation', 'createdAt', 'origin'] as const) withDatabase(db => {
    seed(db)
    const owner = baseline(db), old = legacy(db), ack = saveBody(db, '[old](Target.md)')
    assert.equal(ack.status, 'noop', 'The incarnation fixture has no executable history side that could reject before source resolution')
    if (field === 'creation') db.prepare('UPDATE synced_groups SET creation_id=? WHERE id=?').run(randomUUID(), groupId)
    else if (field === 'createdAt') db.prepare('UPDATE synced_groups SET created_at=? WHERE id=?').run(now, groupId)
    else db.prepare('UPDATE synced_groups SET origin_json=? WHERE id=?').run(JSON.stringify({ ...owner.snapshot.origin,
      pathAtCreation: 'Changed/Origin' }), groupId)
    readOnly(db, () => {
      unavailable(db, owner, ack.operationId)
      assert.throws(() => resolveFirst(db, owner.bindingSource), /失效/)
      assert.deepEqual(resolveFirst(db, old).target, { kind: 'document', id: other, state: 'live' })
    })
    // A rejected real copy must not persist anything or consume the original operation.
    const before = persisted(db), input = copyInput(db, '[copy](Target.md)', owner.bindingSource)
    const result = updateSyncedBlockGroup(db, input)
    assert.equal(result.status, 'invalid')
    if (result.status !== 'invalid') throw new Error('An unavailable owned alias must fail its real writer')
    assert.equal(result.code, 'binding'); assert.deepEqual(persisted(db), before)
    const fresh = baseline(db)
    assert.notEqual(fresh.readOwnerId, owner.readOwnerId)
    assert.throws(() => owned(db, fresh, ack), SyncedValidationError, 'An old ACK is not borrowed by a new incarnation owner')
  })
})

test('a disappeared group makes its owner and aliases unavailable while a legacy historical source keeps its original contract', () => withDatabase(db => {
  seed(db)
  const id = randomUUID(), block = paragraph(`orphan-${randomUUID()}`, '[orphan](Target.md)'), origin = snapshot(db).origin
  createGroup(db, id, [block], captureSyncedGroupBindings(db, origin, [block]))
  const owner = baseline(db, id), old = legacy(db, id)
  db.prepare('DELETE FROM synced_groups WHERE id=?').run(id)
  readOnly(db, () => {
    unavailable(db, owner)
    assert.throws(() => resolveFirst(db, owner.bindingSource), /失效/)
    assert.deepEqual(resolveFirst(db, old).target, { kind: 'document', id: other, state: 'live' })
    assert.deepEqual(captureSyncedBaselineOwner(db, { groupId: id }), { status: 'missing', workspaceScope: uuid(900), groupId: id })
  })
  createGroup(db, id, [block], captureSyncedGroupBindings(db, origin, [block]))
  const next = baseline(db, id)
  assert.notEqual(next.snapshot.creationId, owner.snapshot.creationId)
  assert.notEqual(next.readOwnerId, owner.readOwnerId)
  unavailable(db, owner)
}))

test('a temporary incarnation mismatch inside a rolled-back writer refuses resolution without permanently revoking the owner', () => withDatabase(db => {
  seed(db)
  const owner = baseline(db), ack = saveBody(db, '[old](Target.md)'), before = persisted(db)
  const original = resolveFirst(db, owner.bindingSource)
  assert.throws(() => db.transaction(() => {
    db.prepare('UPDATE synced_groups SET creation_id=? WHERE id=?').run(randomUUID(), groupId)
    readOnly(db, () => assert.throws(() => resolveFirst(db, owner.bindingSource), /失效/))
    throw new Error('Fixture rollback restores the same committed incarnation')
  }).immediate(), /Fixture rollback/)
  assert.deepEqual(persisted(db), before)
  readOnly(db, () => {
    assert.deepEqual(resolveFirst(db, owner.bindingSource), original)
    assert.deepEqual(owned(db, owner, ack).bindingSource, owner.bindingSource)
  })
}))

test('same-creation retirement and reactivation preserve the original ACK read owner while new retired baseline capture is missing', () => withDatabase(db => {
  install27(db)
  const fixture = createdGroup27(db), owner = baseline(db, fixture.groupId)
  const ack = saveBody(db, fixture.wire.blocks[0].content, fixture.groupId)
  assert.equal(ack.status, 'noop', 'A real noop ACK keeps the unpublished activation CAS suitable for the legal retirement fixture')
  const original = owned(db, owner, ack)
  retireFixture27(db, fixture)
  readOnly(db, () => {
    assert.deepEqual(captureSyncedBaselineOwner(db, { groupId: fixture.groupId }),
      { status: 'missing', workspaceScope: uuid(900), groupId: fixture.groupId })
    assert.deepEqual(owned(db, owner, ack), original)
    assert.deepEqual(original.bindingSource.entries, [])
  })
  reactivateFixture27(db, fixture)
  readOnly(db, () => {
    assert.deepEqual(owned(db, owner, ack), original)
    const next = baseline(db, fixture.groupId)
    assert.notEqual(next.snapshot.revision, owner.snapshot.revision)
    assert.notEqual(next.snapshot.topologyRevision, owner.snapshot.topologyRevision)
    assert.notEqual(next.readOwnerId, owner.readOwnerId)
  })
}))

test('exposure and lifecycle state-version changes preserve the same historical owner without granting structural write authority', () => withDatabase(db => {
  install27(db)
  const fixture = createdGroup27(db), owner = baseline(db, fixture.groupId), ack = saveBody(db, fixture.wire.blocks[0].content, fixture.groupId)
  const attempt = randomUUID(), current = snapshot(db, fixture.groupId)
  db.transaction(() => {
    db.prepare(`INSERT INTO synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at)
      VALUES(?,?,?, ?,?,'possible',?,NULL)`).run(attempt, 'a'.repeat(64), 'fixture-export', 'b'.repeat(64), 'c'.repeat(64), now)
    db.prepare(`INSERT INTO synced_group_exposure_members(attempt_id,group_id,creation_id,revision,topology_revision,semantic_hash)
      VALUES(?,?,?,?,?,?)`).run(attempt, fixture.groupId, fixture.creationId, current.revision, current.topologyRevision, fixture.hash)
  })()
  assert.deepEqual(db.prepare('SELECT exposure_state,state_version FROM synced_group_lifecycle WHERE group_id=?').get(fixture.groupId),
    { exposure_state: 'possible', state_version: 2 })
  readOnly(db, () => owned(db, owner, ack))
  db.prepare("UPDATE synced_exposure_attempts SET state='confirmed',confirmed_at=? WHERE id=?").run(now, attempt)
  readOnly(db, () => owned(db, owner, ack))
}))

test('trimmed executable history and identical URL keys rebound to another target never replace the original owned ACK source', () => withDatabase(db => {
  seed(db)
  const owner = baseline(db), ack = saveBody(db, '[same](Target.md)'), token = ack.snapshot.history.undoToken
  assert.ok(token, 'A real saved content operation has executable undo history')
  saved(restoreSyncedGroupOperation(db, restore(db, 'undo')))
  saveBody(db, 'Fresh branch removes executable redo')
  assert.equal(db.prepare('SELECT 1 FROM synced_group_history WHERE id=?').get(token), undefined)
  const replacement = replaceTarget(db), currentAck = saveBody(db, '[same](Target.md)')
  assert.deepEqual(currentAck.snapshot.blocks, ack.snapshot.blocks)
  assert.deepEqual(currentAck.snapshot.bindings[0].target, { kind: 'document', id: replacement, state: 'live' })
  const source = readOnly(db, () => owned(db, owner, ack))
  assert.deepEqual(resolveFirst(db, source.bindingSource).target, ack.snapshot.bindings[0].target)
  const copied = saved(updateSyncedBlockGroup(db, copyInput(db, '[same](Target.md)', source.bindingSource)))
  assert.deepEqual(copied.snapshot.bindings[0].target, ack.snapshot.bindings[0].target)
  readOnly(db, () => owned(db, owner, ack))
}))

test('deleted document and retained block targets remain exact historical facts rather than current URL resolutions', () => {
  for (const kind of ['document', 'block'] as const) withDatabase(db => {
    const opaque = ' retained:旧块 ', href = kind === 'document' ? 'Target.md' : 'Target.md#^%20retained%3A旧块%20'
    if (kind === 'block') ordinary(db, opaque, { owner: other, type: 'paragraph' })
    seed(db, `[old](${href})`)
    const owner = baseline(db), ack = saveBody(db, `[committed](${href})`)
    replaceTarget(db)
    if (kind === 'block') db.prepare('DELETE FROM blocks WHERE id=?').run(opaque)
    else db.prepare('DELETE FROM documents WHERE id=?').run(other)
    const source = readOnly(db, () => owned(db, owner, ack))
    assert.deepEqual(resolveFirst(db, source.bindingSource).target, ack.snapshot.bindings[0].target)
    const beforeIdentities = db.prepare('SELECT * FROM block_identities ORDER BY id').all()
    const copied = saved(updateSyncedBlockGroup(db, copyInput(db, `prefix [copy](${href})`, source.bindingSource)))
    assert.deepEqual(copied.snapshot.bindings[0].target, ack.snapshot.bindings[0].target)
    assert.deepEqual(db.prepare('SELECT * FROM block_identities ORDER BY id').all(), beforeIdentities)
  })
})

test('an actual committed operation for a different group is rejected without publishing or damaging either owner', () => withDatabase(db => {
  seed(db)
  const owner = baseline(db), ownAck = saveBody(db, '[own](Target.md)'), secondId = randomUUID()
  createGroup(db, secondId, [paragraph(`second-${randomUUID()}`)])
  addInstance(db, randomUUID(), secondId)
  const second = baseline(db, secondId), wrong = saveBody(db, 'Another real committed group', secondId)
  readOnly(db, () => {
    assert.throws(() => getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: owner.readOwnerId,
      clientOperationId: wrong.operationId }), SyncedValidationError)
    owned(db, owner, ownAck); owned(db, second, wrong)
    assert.deepEqual(resolveFirst(db, owner.bindingSource).target, { kind: 'document', id: other, state: 'live' })
  })
}))

test('well-formed ACKs for another creation timestamp or canonical origin strictly fail owner binding', () => {
  const mutations: Array<(ack: SyncedGroupSaved) => SyncedGroupSaved> = [
    ack => ({ ...ack, snapshot: { ...ack.snapshot, creationId: randomUUID() } }),
    ack => ({ ...ack, snapshot: { ...ack.snapshot, createdAt: now } }),
    ack => ({ ...ack, snapshot: { ...ack.snapshot, origin: { ...ack.snapshot.origin, pathAtCreation: 'Other/Origin' } } })
  ]
  for (const mutate of mutations) withDatabase(db => {
    seed(db)
    const owner = baseline(db), ack = saveBody(db, '[committed](Target.md)')
    db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(JSON.stringify(mutate(ack)), ack.operationId)
    readOnly(db, () => {
      assert.throws(() => getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: owner.readOwnerId,
        clientOperationId: ack.operationId }), SyncedValidationError)
      assert.deepEqual(resolveFirst(db, owner.bindingSource).target, { kind: 'document', id: other, state: 'live' })
    })
    db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(JSON.stringify(ack), ack.operationId)
    readOnly(db, () => owned(db, owner, ack))
  })
})

test('bad ACK envelopes hashes AST bindings and ledger coverage cannot create an owned alias', () => {
  const mutations: Array<(ack: SyncedGroupSaved) => unknown> = [
    ack => ({ ...ack, replayed: true }), ack => ({ ...ack, operationId: randomUUID() }), ack => ({ ...ack, extra: true }),
    ack => ({ ...ack, snapshot: { ...ack.snapshot, revision: 'not-uuid' } }),
    ack => ({ status: 'applied', operationId: ack.operationId, snapshot: ack.snapshot, replayed: false }),
    ack => ({ ...ack, snapshot: { ...ack.snapshot, bindings: [] } }),
    ack => ({ ...ack, snapshot: { ...ack.snapshot, bindings: [...ack.snapshot.bindings, ...ack.snapshot.bindings] } }),
    ack => ({ ...ack, snapshot: { ...ack.snapshot, bindings: ack.snapshot.bindings.map(binding => ({ ...binding,
      target: { kind: 'block', id: 'never-in-ledger', documentId: null, state: 'live' } })) } })
  ]
  for (const mutate of mutations) withDatabase(db => {
    seed(db)
    const owner = baseline(db), ack = saveBody(db, '[committed](Target.md)')
    db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(JSON.stringify(mutate(ack)), ack.operationId)
    readOnly(db, () => {
      assert.throws(() => getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: owner.readOwnerId, clientOperationId: ack.operationId }))
      assert.deepEqual(resolveFirst(db, owner.bindingSource).target, { kind: 'document', id: other, state: 'live' })
    })
  })
  for (const field of ['hash', 'json'] as const) withDatabase(db => {
    seed(db)
    const owner = baseline(db), ack = saveBody(db, '[committed](Target.md)')
    if (field === 'hash') db.prepare('UPDATE synced_operations SET request_hash=? WHERE client_operation_id=?').run('bad', ack.operationId)
    else {
      db.pragma('ignore_check_constraints=ON')
      try { db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run('{', ack.operationId) }
      finally { db.pragma('ignore_check_constraints=OFF') }
    }
    readOnly(db, () => {
      assert.throws(() => getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: owner.readOwnerId, clientOperationId: ack.operationId }), /收据损坏/)
      resolveFirst(db, owner.bindingSource)
    })
  })
})

test('the original 256 slots count owners plus aliases with no eviction and permit existing source reuse at full capacity', () => withDatabase(db => {
  assert.deepEqual(SYNCED_BINDING_SOURCE_LIMITS, { tickets: 256, bytes: 32 * 1024 * 1024 })
  const ack = saveBody(db, snapshot(db).blocks[0].content)
  readOnly(db, () => {
    const owners = Array.from({ length: 128 }, () => baseline(db))
    assert.throws(() => baseline(db), /容量已满/)
    const first = owners[0], last = owners.at(-1)!
    assert.deepEqual(owned(db, first, ack).bindingSource, first.bindingSource)
    assert.deepEqual(owned(db, last, ack).bindingSource, last.bindingSource)
    const missingId = randomUUID()
    assert.deepEqual(captureSyncedBaselineOwner(db, { groupId: missingId }),
      { status: 'missing', workspaceScope: uuid(900), groupId: missingId })
    assert.deepEqual(getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: first.readOwnerId, clientOperationId: randomUUID() }),
      { status: 'unknown-operation' })
    releaseSyncedReadOwner(db, { readOwnerId: first.readOwnerId })
    const next = baseline(db)
    assert.notEqual(next.readOwnerId, first.readOwnerId)
    assert.throws(() => baseline(db), /容量已满/)
    owned(db, last, ack); unavailable(db, first, ack.operationId)
  })
}))

test('a two-slot owner reservation at 255 is atomic and release returns only its actual aliases to the shared budget', () => withDatabase(db => {
  seed(db)
  const ack = saveBody(db, '[original operation](Target.md)')
  saveBody(db, 'Current empty source')
  readOnly(db, () => {
    const keeper = legacy(db), owners = Array.from({ length: 127 }, () => baseline(db))
    assert.throws(() => baseline(db), /容量已满/, 'One free slot cannot publish half of a new baseline owner')
    const original = owned(db, owners[0], ack)
    assert.throws(() => getSyncedOperationWithLinkSource(db, { clientOperationId: ack.operationId }), /容量已满/)
    assert.deepEqual(owned(db, owners[0], ack), original, 'A failed reservation consumed no slot and same-owner reuse works when full')
    assert.deepEqual(legacy(db), keeper)
    releaseSyncedReadOwner(db, { readOwnerId: owners[0].readOwnerId })
    baseline(db)
    const finalSlot = getSyncedOperationWithLinkSource(db, { clientOperationId: ack.operationId })
    assert.equal(finalSlot.status, 'committed')
    assert.throws(() => baseline(db), /容量已满/)
    assert.deepEqual(legacy(db), keeper)
    assert.deepEqual(getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: owners[1].readOwnerId, clientOperationId: randomUUID() }),
      { status: 'unknown-operation' })
    assert.throws(() => resolveFirst(db, original.bindingSource), /失效/)
  })
}))

test('a legacy multi-source batch and owned reservations share all-or-none capacity without displacing existing owners', () => withDatabase(db => {
  const ids = Array.from({ length: 3 }, () => randomUUID())
  ids.forEach((id, index) => createGroup(db, id, [paragraph(`batch-${index}`)]))
  const ack = saveBody(db, snapshot(db).blocks[0].content)
  readOnly(db, () => {
    const owners = Array.from({ length: 127 }, () => baseline(db))
    assert.throws(() => getSyncedGroupSnapshotsWithLinkSources(db, { groupIds: ids }), /容量已满/)
    const final = getSyncedGroupSnapshotsWithLinkSources(db, { groupIds: ids.slice(0, 2) })
    assert.deepEqual(getSyncedGroupSnapshotsWithLinkSources(db, { groupIds: ids.slice(0, 2) }), final)
    assert.throws(() => legacy(db, ids[2]), /容量已满/)
    assert.deepEqual(owned(db, owners[0], ack).bindingSource, owners[0].bindingSource)
    assert.deepEqual(owned(db, owners.at(-1)!, ack).bindingSource, owners.at(-1)!.bindingSource)
  })
}))

test('the actual 32 MiB budget fails atomically releases payloads and leaves every prior owner and legacy source intact', () => withDatabase(db => {
  seed(db)
  const keeper = baseline(db), old = legacy(db), origin = snapshot(db).origin, tail = 'x'.repeat(500_000)
  // Each distinct 500k URL retains its parsed key, URL, unresolved target path
  // and public alias key; 24 real sources exceed 32 MiB before 256 slots.
  const ids = Array.from({ length: 24 }, () => randomUUID())
  db.transaction(() => ids.forEach((id, index) => {
    const blocks: SyncedCanonicalWire[] = [paragraph(`large-owner-${index}`, `[large](Missing-${tail}-${index}.md)`)]
    createGroup(db, id, blocks, captureSyncedGroupBindings(db, origin, blocks))
  }))()
  readOnly(db, () => {
    const large: Owner[] = []
    let rejected: string | undefined
    for (const id of ids) {
      try { large.push(baseline(db, id)) }
      catch (error) {
        assert.ok(error instanceof SyncedValidationError, 'Real byte exhaustion is a binding validation failure')
        assert.match(error.message, /容量已满/)
        rejected = id; break
      }
    }
    assert.ok(rejected, 'Large real link sources reach the unchanged 32 MiB budget')
    assert.ok(large.length > 0 && 3 + large.length * 2 < 256, 'The failure happens before the original slot budget')
    for (const owner of large) assert.deepEqual(resolveFirst(db, owner.bindingSource).key, firstEntry(owner.bindingSource).key)
    assert.deepEqual(resolveFirst(db, keeper.bindingSource), resolveFirst(db, old))
    for (const owner of large) releaseSyncedReadOwner(db, { readOwnerId: owner.readOwnerId })
    const retried = baseline(db, rejected)
    resolveFirst(db, retried.bindingSource)
    releaseSyncedReadOwner(db, { readOwnerId: retried.readOwnerId })
    // Three keeper slots + 126 new owner/alias pairs = 255; the last legacy
    // alias fills 256. Failed large captures left no half-owner or alias.
    const small = Array.from({ length: 126 }, () => baseline(db))
    const final = legacy(db, ids[0])
    resolveFirst(db, final)
    assert.throws(() => baseline(db), /容量已满/)
    assert.deepEqual(resolveFirst(db, keeper.bindingSource), resolveFirst(db, old))
    releaseSyncedReadOwner(db, { readOwnerId: small[0].readOwnerId })
    baseline(db)
    assert.throws(() => baseline(db), /容量已满/)
  })
}))
