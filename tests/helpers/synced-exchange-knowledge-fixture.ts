import assert from 'node:assert/strict'
import { independentPeerReads } from './independent-peer-read-fixture'
import type Database from 'better-sqlite3'
import { previewSyncedExchangeConflicts, resolveSyncedExchangeConflicts, previewSyncedExchangeBoth, resolveSyncedExchangeBoth } from '../../src/main/sync/synced-exchange'
import { withTombstones, deleteGroup, deleteDocument, document, completed, randomUUID, runtime, state,
  assertAbsentKnowledge, deletionProof, count, snapshot, insertAck, insertCommand, applySyncedHostCommand,
  type Fixture as TombstoneFixture, type Profile } from './synced-exchange-tombstone-fixture'
import { ready, component, side, mergeDecision, editKeepingKeys } from './synced-exchange-conflict-fixture'
import { readyBoth, bothComponent, selectBoth, acceptedBoth, forkSummary } from './synced-exchange-both-fixture'
import { changeGroup, hostEdit } from './synced-exchange-fixture'

export * from './synced-exchange-tombstone-fixture'
export { ready, component, side, mergeDecision, editKeepingKeys, readyBoth, bothComponent, selectBoth, acceptedBoth, forkSummary }
export { localPortable, remoteActual, lateReceipt } from './synced-exchange-fixture'
export { readonlyRequests } from './synced-initial-incoming-fixture'
export type Preview = ReturnType<typeof ready>
export type Decision = Parameters<typeof resolveSyncedExchangeConflicts>[1]['decisions'][number]
export type BothPreview = ReturnType<typeof readyBoth>
export type BothDecision = Parameters<typeof resolveSyncedExchangeBoth>[1]['decisions'][number]
export type Denial = ReturnType<typeof captureDenial>
export type Fixture = TombstoneFixture & {
  denialKey: string; denialA: Denial; denialB: Denial
  preview: (profile?: Profile, previewId?: string) => ReturnType<typeof previewSyncedExchangeConflicts>
  resolve: (preview: Preview, decisions: Decision[], operationId?: string, profile?: Profile) => ReturnType<typeof resolveSyncedExchangeConflicts>
  previewBoth: (profile?: Profile, previewId?: string) => ReturnType<typeof previewSyncedExchangeBoth>
  resolveBoth: (preview: BothPreview, decisions: BothDecision[], operationId?: string, profile?: Profile) => ReturnType<typeof resolveSyncedExchangeBoth>
}
/** Only remote protocol inputs are authored; all local proofs and authority
 * originate in the frozen real Main/HTTP fixture and actual consumers. */
export async function withKnowledge(run: (f: Fixture) => Promise<void>, options: Parameters<typeof withTombstones>[1] & { denial?: 'origin' | 'orphan' | 'zero' } = {}) {
  const { denial = 'origin', ...existing } = options
  return withTombstones(async f => {
    let denialKey: string
    if (denial === 'origin') {
      for (let n = 0; n < 2; n++) insertAck(applySyncedHostCommand(f.A.db, insertCommand(f.A.db, { documentId: f.islands[0], groupId: f.groupId })))
      completed(await f.exchange(f.A), 'applied'); completed(await f.exchange(f.B), 'applied')
      denialKey = 'doc:' + f.host
      f.remoteFinal(records => { document(records, f.child).parentId = null; deleteDocument(records, f.host) })
    } else {
      denialKey = 'group:' + f.orphanId
      f.remoteFinal(records => { deleteGroup(records, f.orphanId) })
    }
    const absence = await independentPeerReads(f.server, 'knowledge-absence', [() => f.exchange(f.A), () => f.exchange(f.B)])
    completed(absence[0], 'applied'); completed(absence[1], 'applied')
    const denialA = captureDenial(f.A.db, denialKey), denialB = captureDenial(f.B.db, denialKey)
    if (denial === 'origin') for (const profile of [f.A, f.B]) {
      const live = snapshot(profile.db, f.groupId)
      assert.equal(live.origin.documentId, f.host); assert.equal(count(profile.db, 'documents', 'id', f.host), 0)
      assert.equal(live.instances.length, 2, 'Two actual surviving Main insert occurrences keep G editable after its original document is truly deleted')
      assert.ok(live.instances.every(instance => instance.hostDocumentId === f.islands[0]), 'The deleted Origin is not a phantom editable host')
    }
    if (denial === 'zero') for (const profile of [f.A, f.B]) {
      assert.deepEqual(profile.db.prepare('SELECT * FROM synced_group_blocks').all(), [])
      assert.deepEqual(profile.db.prepare('SELECT * FROM synced_instances').all(), [])
    }
    const fenced = new Set<Profile>()
    const arm = (profile: Profile) => {
      if (fenced.has(profile)) return
      assert.ok(profile === f.A || profile === f.B, 'The test fences only an actual independent peer from its real fixture')
      const original = profile === f.A ? denialA : denialB, current = captureDenial(profile.db, denialKey)
      const { baseline: _originalBaseline, ...originalFacts } = original, { baseline: _currentBaseline, ...currentFacts } = current
      assert.deepEqual(currentFacts, originalFacts, 'All original deletion facts remain exact through legitimate format4 setup exchanges')
      assert.deepEqual(current.baseline.local, original.baseline.local, 'Setup re-acceptance cannot change the original deletion operation or intent tuple')
      original.baseline = structuredClone(current.baseline)
      fenced.add(profile)
    }
    const preview: Fixture['preview'] = (profile = f.B, previewId = randomUUID()) => { arm(profile); return f.track(previewSyncedExchangeConflicts(profile.db, { previewId, userDataRoot: profile.root, target: f.targetConfig }, runtime)) }
    const resolve: Fixture['resolve'] = (p, decisions, operationId = randomUUID(), profile = f.B) => { arm(profile); return f.track(resolveSyncedExchangeConflicts(profile.db, { ...f.input(operationId, profile), previewId: p.previewId, decisions }, runtime)) }
    const previewBoth: Fixture['previewBoth'] = (profile = f.B, previewId = randomUUID()) => { arm(profile); return f.track(previewSyncedExchangeBoth(profile.db, { previewId, userDataRoot: profile.root, target: f.targetConfig }, runtime)) }
    const resolveBoth: Fixture['resolveBoth'] = (p, decisions, operationId = randomUUID(), profile = f.B) => { arm(profile); return f.track(resolveSyncedExchangeBoth(profile.db, { ...f.input(operationId, profile), previewId: p.previewId, decisions }, runtime)) }
    const fixture: Fixture = { ...f, denialKey, denialA, denialB, preview, resolve, previewBoth, resolveBoth }
    await run(fixture)
  }, { ...existing, ...(denial === 'zero' ? { onlyOrphan: true } : {}) })
}

export function captureDenial(db: Database.Database, key: string) {
  const original = assertAbsentKnowledge(db, key), baseline = state(db).parsed.baseline.find(row => row.key === key)
  assert.ok(baseline, 'The actual accepted tombstone has its full original per-key absent baseline')
  const receipt = db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(original.proof.application.operationId)
  const identities = original.proof.identities.map(item => db.prepare('SELECT * FROM block_identities WHERE id=?').get(item.before.id))
  return structuredClone({ key, baseline, marker: original.row, anchor: original.anchor, receipt, identities, tombstoneHash: original.proof.tombstoneHash })
}
export function unchangedDenial(f: Fixture, profile = f.B, expected = profile === f.A ? f.denialA : f.denialB) {
  assert.deepEqual(captureDenial(profile.db, f.denialKey), expected, 'From before the first manual API, live selection preserves the complete captured absence baseline and every original deletion fact without refreshing the expectation')
  unchangedDenialFacts(f, profile, expected)
}
export function unchangedDenialFacts(f: Fixture, profile = f.B, expected = profile === f.A ? f.denialA : f.denialB) {
  const { baseline: _expectedBaseline, ...expectedFacts } = expected, { baseline: _actualBaseline, ...actualFacts } = captureDenial(profile.db, f.denialKey)
  assert.deepEqual(actualFacts, expectedFacts, 'An explicitly subsequent format4 exchange may re-accept absence but cannot change the original marker anchor receipt or retained identities')
  assert.equal(f.remote().manifest.entries[f.denialKey], expected.tombstoneHash, 'The exact original remote tombstone is carried, not recreated or replaced')
  const proof = deletionProof(profile.db, f.denialKey)
  if (f.denialKey.startsWith('doc:')) assert.equal(count(profile.db, 'documents', 'id', f.denialKey.slice(4)), 0)
  else assert.equal((profile.db.prepare('SELECT count(*) AS n FROM synced_group_blocks WHERE group_id=?').get(f.denialKey.slice(6)) as { n: number }).n, 0)
  assert.equal(proof.receipt.version, 4, 'The deletion remains authenticated by its original format4 producer, never a live selector receipt')
}
export async function divergeGroup(f: Fixture, links = false) {
  const id = f.groupId, base = links ? 'base overlap ' + snapshot(f.A.db, id).blocks[0].content : 'alpha middle omega'
  const edit = (profile: Profile, text: string) => links ? editKeepingKeys(profile, id, blocks => { blocks[0].content = text })
    : changeGroup(profile.db, id, blocks => { blocks[0].content = text })
  edit(f.A, base); completed(await f.exchange(f.A), 'applied'); completed(await f.exchange(f.B), 'applied')
  const actualBase = snapshot(f.B.db, id)
  edit(f.A, 'REMOTE overlap ' + base); completed(await f.exchange(f.A), 'applied'); edit(f.B, 'LOCAL overlap ' + base)
  return { id, key: 'group:' + id, base: actualBase, local: snapshot(f.B.db, id), remote: snapshot(f.A.db, id) }
}
export async function divergeDocument(f: Fixture, id = f.islands[1]) {
  hostEdit(f.A.db, id, 'alpha ordinary middle omega'); completed(await f.exchange(f.A), 'applied'); completed(await f.exchange(f.B), 'applied')
  hostEdit(f.A.db, id, 'REMOTE ordinary overlapping body'); completed(await f.exchange(f.A), 'applied'); hostEdit(f.B.db, id, 'LOCAL ordinary overlapping body')
  return { id, key: 'doc:' + id }
}
export function execution(db: Database.Database) {
  return { receipts: db.prepare("SELECT * FROM synced_operations WHERE result_json LIKE '%synced-exchange-operation%' ORDER BY client_operation_id").all(),
    jobs: db.prepare("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-job%' ORDER BY key").all() }
}
export function storedReceipt(db: Database.Database, operationId: string, version: 5 | 6) {
  const row = db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(operationId) as { client_operation_id: string; request_hash: string; result_json: string; created_at: string } | undefined
  assert.ok(row, 'The actual successful live selector persists its finite historical receipt')
  const value = JSON.parse(row.result_json) as { version: number; provenance: { attemptId: string; knowledgeHash: string; plannerVersion: string; deletions?: unknown; accepted: Array<{ key: string; local: { kind: string } }>; merges: unknown[] }; result: { acceptedAt: string } }
  assert.equal(value.version, version); assert.match(value.provenance.knowledgeHash, /^[a-f0-9]{64}$/)
  assert.equal(value.provenance.plannerVersion, version === 5 ? 'knowledge-conflicts-v1' : 'knowledge-forks-v1')
  assert.equal(Object.hasOwn(value.provenance, 'deletions'), false, 'A live selector cannot mint or re-sign logical deletion authority')
  return { row, value }
}
export function jobForReceipt(db: Database.Database, operationId: string, attemptId: string) {
  const rows = db.prepare("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-job%' ORDER BY key").all() as Array<{ key: string; value: string; updated_at: string }>
  const row = rows.find(row => { const value = JSON.parse(row.value) as { kind?: string; request?: { operationId?: string }; attemptId?: string }; return value.kind === 'synced-exchange-job' && value.request?.operationId === operationId && value.attemptId === attemptId })
  assert.ok(row, 'The original finite receipt names an actual immutable job from its exact historical attempt')
  return row
}
export const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
export const flip = (value: string) => (value[0] === '0' ? '1' : '0') + value.slice(1)
