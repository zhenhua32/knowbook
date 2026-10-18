import assert from 'node:assert/strict'
import { previewSyncedExchangeDeletions, resolveSyncedExchangeDeletions } from '../../src/main/sync/synced-exchange'
import type { SyncedLogicalDeletionChoiceProof } from '../../src/main/sync/synced-logical-deletion-choice-model'
import type { DeletionDecisionSource } from '../../src/main/sync/synced-exchange-deletion-choice-model'
import { withTombstones, divergentUnpinnedGroup, divergentDocument, realNewReference, randomUUID, runtime,
  localPortable, encode, hash, type Fixture as Base } from './synced-deletion-choice-setup'

export * from './synced-deletion-choice-setup'
export { state, assertAbsentKnowledge, deletionProof, liveKnowledge, missingGroup } from './synced-exchange-tombstone-fixture'
export type Preview = Extract<Awaited<ReturnType<typeof previewSyncedExchangeDeletions>>, { status: 'ready' }>['preview']
export type Component = Preview['components'][number]
export type Decision = Parameters<typeof resolveSyncedExchangeDeletions>[1]['decisions'][number]
export type Fixture = Base & {
  preview: (profile?: Base['B'], previewId?: string) => ReturnType<typeof previewSyncedExchangeDeletions>
  resolve: (preview: Preview, decisions: Decision[], operationId?: string, profile?: Base['B']) => ReturnType<typeof resolveSyncedExchangeDeletions>
}
export async function withDeletionChoices(run: (f: Fixture) => Promise<void>, options: Parameters<typeof withTombstones>[1] = {}) {
  return withTombstones(async f => {
    const preview: Fixture['preview'] = (profile = f.B, previewId = randomUUID()) => f.track(previewSyncedExchangeDeletions(profile.db, { previewId, userDataRoot: profile.root, target: f.targetConfig }, runtime))
    const resolve: Fixture['resolve'] = (p, decisions, operationId = randomUUID(), profile = f.B) => f.track(resolveSyncedExchangeDeletions(profile.db, { ...f.input(operationId, profile), previewId: p.previewId, decisions }, runtime))
    await run({ ...f, preview, resolve })
  }, options)
}
export function ready(value: Awaited<ReturnType<typeof previewSyncedExchangeDeletions>>): Preview {
  assert.ok(value.status === 'ready', 'The real Main deletion preview owns a complete authenticated source')
  assert.equal(value.preview.kind, 'synced-exchange-deletion-preview'); assert.equal(value.preview.version, 1)
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.preview) && Object.isFrozen(value.preview.components), 'The public deletion preview diagnostics are readonly')
  for (const c of value.preview.components) assert.ok(Object.isFrozen(c) && Object.isFrozen(c.keys) && Object.isFrozen(c.choices) && Object.isFrozen(c.records) && Object.isFrozen(c.fixedDenials), 'Each complete deletion component owns immutable choices and source facts')
  return value.preview
}
export function component(p: Preview, key: string): Component {
  const c = p.components.find(row => row.keys.includes(key))
  assert.ok(c, 'The actual complete dependency component contains the targeted live or tombstone key')
  return c
}
export function choose(c: Component, choice: Decision['choice']): Decision {
  assert.ok(c.choices.includes(choice), 'The exact original Main preview offers this qualified whole-component deletion decision')
  return { componentId: c.componentId, choice }
}
export function groupConflict(f: Fixture) {
  const base = f.remote().records.get('group:' + f.groupId)
  assert.ok(base?.kind === 'synced-group', 'The exact common group predecessor comes from the real published portable object')
  const conflict = divergentUnpinnedGroup(f), local = localPortable(f.B).records.find(record => record.kind === 'synced-group' && record.id === conflict.id)
  assert.ok(local?.kind === 'synced-group', 'The actual changed orphan still has a current live Main source before its decision')
  return { ...conflict, base: structuredClone(base), localWire: structuredClone(local) }
}
export function docConflict(f: Fixture) {
  const base = f.remote().records.get('doc:' + f.islands[0])
  assert.ok(base?.kind === 'document', 'The true document B is the actual same-target complete portable record')
  return { ...divergentDocument(f), base: structuredClone(base) }
}
export { realNewReference }
export function receipt7(f: Fixture, operationId: string) {
  const row = f.B.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(operationId) as { client_operation_id: string; result_json: string; request_hash: string; created_at: string } | undefined
  assert.ok(row, 'The genuine completed decision has one exact finite historical operation receipt')
  const receipt = JSON.parse(row.result_json) as { version: number; request: { method: string; decisions: Decision[] }; provenance: { attemptId: string; plannerVersion: string; decisionSourceHash: string; deletions: Array<{ key: string; intentHash: string; proofHash: string; anchorId: string }> } }
  assert.equal(receipt.version, 7); assert.equal(receipt.request.method, 'resolveSyncedExchangeDeletions')
  assert.equal(receipt.provenance.plannerVersion, 'delete-choices-v1'); assert.match(receipt.provenance.decisionSourceHash, /^[a-f0-9]{64}$/)
  return { row, receipt }
}
export function proof2(f: Fixture, operationId: string, key: string) {
  const rows = f.B.db.prepare("SELECT * FROM synced_operations WHERE client_operation_id LIKE 'synced:logical-deletion:v1:%' ORDER BY client_operation_id").all() as Array<{ client_operation_id: string; result_json: string; request_hash: string; created_at: string }>
  const row = rows.find(row => (JSON.parse(row.result_json) as { key: string }).key === key)
  assert.ok(row, 'The actual explicit keep-delete transaction minted its durable exact-identity marker')
  const value = JSON.parse(row.result_json) as SyncedLogicalDeletionChoiceProof
  assert.equal(value.kind, 'synced-logical-deletion-proof'); assert.equal(value.version, 2)
  assert.equal(value.application.operationId, operationId); assert.equal(value.key, key); assert.equal(value.decision.choice, 'keep-delete')
  assert.equal(value.baseLiveHash, hash(encode(value.base))); assert.equal(value.localBeforeHash, hash(encode(value.before)))
  assert.notEqual(value.localBeforeHash, value.baseLiveHash, 'The actual changed live L is never falsely relabelled as the accurate common B')
  assert.equal(row.result_json, encode(value)); assert.equal(row.request_hash, hash(encode({ domain: 'synced.logical-deletion.apply.v2', proof: value })))
  assert.equal(row.created_at, value.application.acceptedAt)
  const anchor = f.B.db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(value.persistence.anchorId) as Record<string, unknown> | undefined
  assert.ok(anchor, 'The same owned SQL commit independently persisted the immutable denial anchor')
  assert.equal(anchor.id, row.client_operation_id); assert.equal(anchor.channel, 'logical-deletion-denial-v1')
  assert.equal(anchor.state, 'possible'); assert.equal(anchor.confirmed_at, null); assert.equal(anchor.request_hash, row.request_hash); assert.equal(anchor.publication_hash, value.tombstoneHash)
  assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_group_exposure_members WHERE attempt_id=?').all(anchor.id), [])
  const original = receipt7(f, operationId)
  assert.deepEqual(original.receipt.provenance.deletions.find(ref => ref.key === key), { key, intentHash: value.intentHash, proofHash: hash(row.result_json), anchorId: value.persistence.anchorId })
  return { markerRow: row, value, anchor, ...original }
}
export const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
export const flip = (value: string) => (value[0] === '0' ? '1' : '0') + value.slice(1)
export function execution(f: Fixture) {
  return { jobs: f.B.db.prepare("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-job%' ORDER BY key").all(),
    receipts: f.B.db.prepare("SELECT * FROM synced_operations WHERE result_json LIKE '%synced-exchange-operation%' ORDER BY client_operation_id").all() }
}
export function job7(f: Fixture, operationId: string) {
  const original = receipt7(f, operationId)
  const rows = f.B.db.prepare("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-job%' ORDER BY key").all() as Array<{ key: string; value: string; updated_at: string }>
  const row = rows.find(row => { const job = JSON.parse(row.value) as { request?: { operationId?: string }; attemptId?: string }; return job.request?.operationId === operationId && job.attemptId === original.receipt.provenance.attemptId })
  assert.ok(row, 'The successful finite receipt names the original durable job of its exact historical attempt')
  const value = JSON.parse(row.value) as { version: number; decisionSourceHash: string; decisionSource: DeletionDecisionSource; resolution: { previewId: string; previewHash: string; decisionsHash: string } }
  assert.equal(value.version, 7); assert.equal(value.decisionSourceHash, original.receipt.provenance.decisionSourceHash)
  return { ...original, jobRow: row, job: value }
}
