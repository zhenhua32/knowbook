import assert from 'node:assert/strict'
import { independentPeerReads } from './independent-peer-read-fixture'
import type Database from 'better-sqlite3'
import { join } from 'node:path'
import { AttachmentStore } from '../../src/main/attachments'
import { KnowbookStore } from '../../src/main/database/store'
import type { SyncedGroupWire } from '../../src/shared/synced-blocks'
import type { SyncedPortableHostRecord } from '../../src/shared/syncedBlockPortable'
import { validateSyncedProtocol5Snapshot, syncedProtocol5RecordKey, type SyncedProtocol5Record } from '../../src/main/sync/synced-protocol5-model'
import { getSyncedGroupSnapshots, listSyncedGroups } from '../../src/main/database/synced-blocks-read'
import { withIncomingFixture, accepted, receiveInitialSyncedSnapshot, seedLocalDocument, snapshot, rejected,
  type Profile } from './synced-initial-incoming-fixture'
import { exchangeSyncedSnapshot, completed, randomUUID, encode, hash, runtime, allTables, hostEdit, physical,
  changeGroup, request, applySyncedHostFinal, createRequest, created, applySyncedHostCommand, readStrictHostDocument, localPortable } from './synced-exchange-fixture'
import { command as insertCommand, insertAck } from './synced-host-command-insert-fixture'

export { completed, randomUUID, encode, hash, runtime, allTables, hostEdit, physical, changeGroup, request,
  applySyncedHostFinal, createRequest, created, applySyncedHostCommand, readStrictHostDocument, snapshot, rejected,
  getSyncedGroupSnapshots, listSyncedGroups, insertCommand, insertAck, exchangeSyncedSnapshot }
export type { Profile, SyncedGroupWire, SyncedPortableHostRecord }
export type RemoteRecords = Map<string, SyncedProtocol5Record>
type Original = Parameters<Parameters<typeof withIncomingFixture>[0]>[0]
type Options = Parameters<typeof withIncomingFixture>[1]
export type Fixture = Original & {
  S: Profile; A: Profile; B: Profile; islands: string[]; groupId: string; orphanId: string
  originalGroup: ReturnType<typeof snapshot>; originalOrphan: ReturnType<typeof snapshot>
  exchange: (profile?: Profile, operationId?: string, signal?: AbortSignal) => ReturnType<typeof exchangeSyncedSnapshot>
  remote: () => ReturnType<typeof readRemote>
  remoteFinal: (mutate: (records: RemoteRecords) => void, strict?: boolean) => ReturnType<typeof readRemote>
  reopenPeer: (profile?: Profile) => Database.Database
}

/** The only fabricated objects are explicit remote protocol inputs. All local admission, creation,
 * baselines, physical deletion and proof rows are produced by actual Main consumers. */
export async function withTombstones(run: (fixture: Fixture) => Promise<void>, options: Options & { onlyOrphan?: boolean } = {}) {
  return withIncomingFixture(async original => {
    let source = original
    if (options.onlyOrphan) {
      const S = original.newPristine('source-with-only-one-orphan'), store = new KnowbookStore(S.file)
      try {
        const host = store.createDocument(null), target = store.createDocument(null), other = store.createDocument(null), child = store.createDocument(host), sourceBlock = randomUUID()
        const assets = new AttachmentStore(join(S.root, 'storage', 'assets')), aliases: typeof original.aliases = []
        if (options.assets) for (const name of ['retained first.png', 'retained second.png']) {
          const bytes = Buffer.from('Actual deleted orphan asset bytes'), [item] = await assets.import([{ name, bytes }])
          aliases.push({ name: item.name, bytes, url: item.url })
        }
        for (const [id, title, blockId] of [[host, 'Only orphan origin', sourceBlock], [target, 'Independent target', randomUUID()], [other, 'Independent other', randomUUID()], [child, 'Independent child', randomUUID()]])
          store.updateDocument(id, { title, summary: '', blocks: [{ id: blockId, type: 'paragraph', content: 'Real source ordinary body' + (id === host ? aliases.map(alias => ' ![retained](<' + alias.url + '>)').join('') : ''), checked: false, depth: 0, parentBlockId: null }] })
        const command = createRequest(S.db, { documentId: host, selectedRootIds: [sourceBlock] }), ack = created(applySyncedHostCommand(S.db, command))
        const removal = request(S.db, [host], sides => { sides[0].blocks = [{ id: randomUUID(), type: 'paragraph', content: 'Explicit source paragraph after real dereference', checked: false, depth: 0, parentBlockId: null }] })
        assert.equal(applySyncedHostFinal(S.db, removal).status, 'applied')
        source = { ...original, A: S, host, target, other, child, sourceBlock, command, ack, orphanId: ack.createdLifecycle.groupId, aliases, assets }
      } finally { store.destroy() }
    }
    const S = source.A, A = source.newPristine('independent-A'), B = source.B
    const islands = [' tombstone:U:' + randomUUID(), ' tombstone:V:' + randomUUID(), ' tombstone:W:' + randomUUID()]
    for (const id of islands) seedLocalDocument(S.db, id)
    assert.ok(source.orphanId, 'The source uses a real create and explicit dereference to produce an orphan')
    const groupId = source.ack.createdLifecycle.groupId, orphanId = source.orphanId
    const originalGroup = snapshot(S.db, groupId), originalOrphan = snapshot(S.db, orphanId)
    await source.send(S)
    const received = await independentPeerReads(source.server, 'initial-receivers', [
      () => source.track(receiveInitialSyncedSnapshot(A.db, source.input(randomUUID(), A), runtime)),
      () => source.receive()
    ])
    accepted(received[0]); accepted(received[1])
    const exchange: Fixture['exchange'] = (profile = B, operationId = randomUUID(), signal) =>
      source.track(exchangeSyncedSnapshot(profile.db, source.input(operationId, profile), { ...runtime, ...(signal ? { signal } : {}) }))
    const baselines = await independentPeerReads(source.server, 'initial-baselines', [() => exchange(A), () => exchange(B)])
    completed(baselines[0], 'noop'); completed(baselines[1], 'noop')
    for (const profile of [A, B]) {
      assert.equal(count(profile.db, 'synced_instances', 'group_id', orphanId), 0)
      assert.equal(count(profile.db, 'synced_group_pins', 'group_id', orphanId), 0, 'A real initial receiver does not import the source create/removal history pins')
      assert.equal(count(profile.db, 'synced_host_history_documents', 'document_id', source.target), 0)
      assert.deepEqual(snapshot(profile.db, orphanId).blocks.map(b => [b.id, b.createdAt]), originalOrphan.blocks.map(b => [b.id, b.createdAt]))
    }
    const fixture: Fixture = { ...source, S, A, B, islands, groupId, orphanId, originalGroup, originalOrphan, exchange,
      remote: () => readRemote(source),
      remoteFinal: (mutate, strict = true) => writeRemote(source, mutate, strict),
      reopenPeer: (profile = B) => { if (profile.db.open) profile.db.close(); profile.db = source.connect(profile); return profile.db } }
    await run(fixture)
  }, { ...options, orphan: true })
}
export async function withDocumentOnlyTombstone(run: (f: Original & { S: Profile; ordinaryId: string;
  exchange: (operationId?: string) => ReturnType<typeof exchangeSyncedSnapshot>; remoteFinal: (change: (records: RemoteRecords) => void) => void }) => Promise<void>) {
  return withIncomingFixture(async original => {
    const S = original.newPristine('entirely-group-free-source'), ordinaryId = ' no group document:opaque\0: ' + randomUUID()
    seedLocalDocument(S.db, ordinaryId); seedLocalDocument(S.db, 'independent group-free survivor:' + randomUUID())
    // The public initial sender deliberately rejects zero active groups. This
    // independent protocol fixture instead projects actual group-free SQL,
    // validates its complete portable closure and serves those exact bytes.
    // It does not manufacture a local seed/receipt or claim sender support.
    const portable = localPortable(S), manifest = { version: 5 as const, workspaceId: portable.workspaceScope, entries: portable.entries, syncedInstances: portable.dependencies }
    validateSyncedProtocol5Snapshot(manifest, portable.records.map(record => ({ key: syncedProtocol5RecordKey(record), record })))
    for (const record of portable.records) {
      const key = syncedProtocol5RecordKey(record)
      original.server.files.set('/' + original.targetConfig.directory + '/objects/' + portable.entries[key] + '.json', Buffer.from(encode(record)))
    }
    original.server.files.set('/' + original.targetConfig.directory + '/manifest.json', Buffer.from(encode(manifest)))
    accepted(await original.receive())
    const exchange = (operationId: string = randomUUID()) => original.track(exchangeSyncedSnapshot(original.B.db, original.input(operationId), runtime))
    completed(await exchange(), 'noop')
    assert.equal(count(original.B.db, 'synced_groups'), 0, 'The actual protocol5 receiver has no raw group rows before the doc-only deletion')
    await run({ ...original, A: S, S, ordinaryId, exchange, remoteFinal: change => { writeRemote(original, change, true) } })
  })
}
export function count(db: Database.Database, table: string, column?: string, value?: string): number {
  assert.match(table, /^[a-z_]+$/); if (column) assert.match(column, /^[a-z_]+$/)
  return (db.prepare('SELECT count(*) AS n FROM ' + table + (column ? ' WHERE ' + column + '=?' : '')).get(...(column ? [value] : [])) as { n: number }).n
}
function readRemote(f: Original) {
  const path = '/' + f.targetConfig.directory + '/manifest.json', bytes = f.server.files.get(path)
  assert.ok(bytes, 'The actual sender or exchange produced the same-target manifest bytes')
  const manifest = JSON.parse(bytes.toString()) as { version: 5; workspaceId: string; entries: Record<string, string>; syncedInstances: Array<{ documentId: string; instanceId: string; groupId: string; groupHash: string }> }
  const records: RemoteRecords = new Map(Object.entries(manifest.entries).map(([key, digest]) => {
    const raw = f.server.files.get('/' + f.targetConfig.directory + '/objects/' + digest + '.json')
    assert.ok(raw, 'Every actual remote entry has its complete immutable object bytes'); assert.equal(hash(raw), digest)
    return [key, JSON.parse(raw.toString()) as SyncedProtocol5Record]
  }))
  return { manifest, records, bytes: Buffer.from(bytes), hash: hash(bytes) }
}
function writeRemote(f: Original, mutate: (records: RemoteRecords) => void, strict: boolean) {
  const actual = readRemote(f), records = new Map([...actual.records].map(([key, record]) => [key, structuredClone(record)]))
  mutate(records)
  const entries = Object.fromEntries([...records].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, record]) => {
    assert.equal(syncedProtocol5RecordKey(record), key); return [key, hash(encode(record))]
  }))
  const syncedInstances = [...records.values()].flatMap(record => record.kind !== 'document' ? [] : record.content.blocks.flatMap(block => {
    if (block.type !== 'synced-block') return []
    const groupId = (JSON.parse(block.content) as { groupId: string }).groupId
    return [{ documentId: record.id, instanceId: block.id, groupId, groupHash: entries['group:' + groupId] }]
  })).sort((a, b) => a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0)
  const manifest = { ...actual.manifest, entries, syncedInstances }
  if (strict) validateSyncedProtocol5Snapshot(manifest, [...records].map(([key, record]) => ({ key, record })))
  for (const [key, record] of records) f.server.files.set('/' + f.targetConfig.directory + '/objects/' + entries[key] + '.json', Buffer.from(encode(record)))
  f.server.files.set('/' + f.targetConfig.directory + '/manifest.json', Buffer.from(encode(manifest)))
  return readRemote(f)
}
export function document(records: RemoteRecords, id: string): SyncedPortableHostRecord {
  const value = records.get('doc:' + id)
  assert.ok(value?.kind === 'document', 'The remote final input starts from an actual full live document wire'); return value
}
export function group(records: RemoteRecords, id: string): SyncedGroupWire {
  const value = records.get('group:' + id)
  assert.ok(value?.kind === 'synced-group', 'The remote deletion starts from the actual complete original group wire'); return value
}
export function deleteGroup(records: RemoteRecords, id: string, previousHash?: string) {
  const before = group(records, id)
  records.set('group:' + id, { kind: 'synced-group-deleted', id, creationId: before.creationId,
    previousHash: previousHash ?? hash(encode(before)), deletedAt: new Date().toISOString() })
  return before
}
export function deleteDocument(records: RemoteRecords, id: string) { const before = document(records, id); records.set('doc:' + id, { kind: 'deleted', id }); return before }
export function removeGroupReferences(records: RemoteRecords, id: string) {
  for (const record of records.values()) if (record.kind === 'document') {
    const old = record.content.blocks, removed = new Set(old.filter(b => b.type === 'synced-block' && JSON.parse(b.content).groupId === id).map(b => b.id))
    record.content.blocks = old.filter(b => !removed.has(b.id))
    if (!record.content.blocks.length) record.content.blocks.push({ id: randomUUID(), type: 'paragraph', content: 'Explicit remote paragraph after removing a reference', checked: false, depth: 0, parentBlockId: null, tags: [] })
  }
}
export function rawGroup(db: Database.Database, id: string) {
  const value = db.prepare('SELECT * FROM synced_groups WHERE id=?').get(id) as { id: string; creation_id: string; created_at: string; origin_json: string; revision: string; topology_revision: string; history_cursor: string; history_position: number } | undefined
  assert.ok(value, 'The group raw immutable identity anchor remains physically present'); return value
}
type ProofIdentity = { before: { id: string; last_owner_kind: string; last_owner_id: string; state: string; created_at: string | null }; after: { kind: 'retained' } | { kind: 'transferred'; ownerKind: string; ownerId: string; createdAt: string } }
export type Proof = { kind: string; version: number; key: string; intentHash: string; baseLiveHash: string; tombstoneHash: string;
  before: SyncedGroupWire | SyncedPortableHostRecord; deletion: SyncedProtocol5Record; identities: ProofIdentity[];
  source: { manifestHash: string; targetFingerprint: string }; application: { operationId: string; requestHash: string; acceptedAt: string };
  persistence: { kind: string; anchorId: string }; localBefore: Record<string, unknown>; localAfter: Record<string, unknown> }
export function deletionProof(db: Database.Database, key: string) {
  const rows = db.prepare("SELECT * FROM synced_operations WHERE client_operation_id LIKE 'synced:logical-deletion:v1:%' ORDER BY client_operation_id").all() as Array<{ client_operation_id: string; request_hash: string; result_json: string; created_at: string }>
  const row = rows.find(row => (JSON.parse(row.result_json) as Proof).key === key)
  assert.ok(row, 'A genuine completed exchange persisted the stable immutable logical-deletion marker')
  const proof = JSON.parse(row.result_json) as Proof
  assert.equal(proof.kind, 'synced-logical-deletion-proof'); assert.equal(proof.version, 1); assert.equal(row.result_json, encode(proof))
  assert.equal(proof.persistence.kind, 'logical-deletion-denial'); assert.equal(proof.persistence.anchorId, row.client_operation_id)
  assert.equal(proof.baseLiveHash, hash(encode(proof.before))); assert.equal(proof.tombstoneHash, hash(encode(proof.deletion)))
  assert.equal(row.request_hash, hash(encode({ domain: 'synced.logical-deletion.apply.v1', proof })))
  assert.equal(row.created_at, proof.application.acceptedAt)
  const anchor = db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(row.client_operation_id) as Record<string, unknown> | undefined
  assert.ok(anchor, 'The actual same-transaction denial anchor exists independently of the deletable marker row')
  assert.equal(anchor.channel, 'logical-deletion-denial-v1'); assert.equal(anchor.state, 'possible'); assert.equal(anchor.confirmed_at, null)
  assert.equal(anchor.publication_hash, proof.tombstoneHash); assert.equal(anchor.request_hash, row.request_hash)
  assert.equal(count(db, 'synced_group_exposure_members', 'attempt_id', row.client_operation_id), 0)
  const receiptRow = db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(proof.application.operationId) as { result_json: string } | undefined
  assert.ok(receiptRow, 'The proof refers to its original finite public exchange receipt, not a current guessed operation')
  const receipt = JSON.parse(receiptRow.result_json) as { version: number; provenance: { deletions: Array<{ key: string; intentHash: string; proofHash: string; anchorId: string }> } }
  assert.equal(receipt.version, 4)
  assert.deepEqual(receipt.provenance.deletions.find(ref => ref.key === key), { key, intentHash: proof.intentHash, proofHash: hash(row.result_json), anchorId: row.client_operation_id })
  return { row, proof, anchor, receiptRow, receipt }
}
export function state(db: Database.Database) {
  const rows = db.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange.v1.%'").all() as Array<{ key: string; value: string }>
  assert.equal(rows.length, 1, 'The actual target has exactly one version-dispatched exchange state')
  const parsed = JSON.parse(rows[0].value) as { version: number; currentOperationId: string; baseline: Array<{ key: string; local: { kind: string; tombstoneHash?: string; deletionOperationId?: string; intentHash?: string }; remoteHash: string; commonHash: string }> }
  assert.equal(parsed.version, 2); return { ...rows[0], parsed }
}
export function assertAbsentKnowledge(db: Database.Database, key: string) {
  const saved = deletionProof(db, key), baseline = state(db).parsed.baseline.find(row => row.key === key)
  assert.ok(baseline, 'The complete per-key baseline retains deletion knowledge after physical absence')
  assert.deepEqual(baseline.local, { kind: 'absent', tombstoneHash: saved.proof.tombstoneHash, deletionOperationId: saved.proof.application.operationId, intentHash: saved.proof.intentHash })
  assert.equal(baseline.remoteHash, saved.proof.tombstoneHash); assert.equal(baseline.commonHash, saved.proof.tombstoneHash)
  return saved
}
export function missingGroup(db: Database.Database, id: string) { assert.equal(getSyncedGroupSnapshots(db, { groupIds: [id] }).items[0].status, 'missing') }
export function denied(value: unknown) {
  assert.ok(!value || typeof value !== 'object' || !('status' in value) || !['applied', 'saved', 'noop', 'ready'].includes(String(value.status)), 'A deleted target cannot produce a current successful read or write authority result')
}
export function liveKnowledge(db: Database.Database) {
  const tables = allTables(db)
  return Object.fromEntries(['documents', 'blocks', 'block_identities', 'document_block_routes', 'links', 'synced_groups', 'synced_group_blocks', 'synced_instances', 'synced_host_history', 'synced_host_history_documents', 'synced_host_history_state', 'synced_group_history', 'synced_group_pins', 'databases', 'document_database_columns', 'database_saved_views', 'database_entities', 'database_entity_values', 'document_database_values'].map(name => [name, tables[name]]))
}
