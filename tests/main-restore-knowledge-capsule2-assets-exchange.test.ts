import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AttachmentStore } from '../src/main/attachments'
import { readRawCapsule2AssetReferencesOwned, type RawCapsule2AssetReferences } from '../src/main/database/restore-knowledge-capsule2-assets-read'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { withObserver2Copy } from './helpers/capsule2-observer-fixture'
import { withTombstones, deleteGroup, completed, hash } from './helpers/synced-exchange-tombstone-fixture'
import { withDeletionChoices, groupConflict, ready, component, choose, job7 } from './helpers/synced-deletion-choice-fixture'
import { withExchange, changeGroup, hostEdit } from './helpers/synced-exchange-fixture'

const image = (uri: string) => `![retained](<${uri}>)`
const portable = (bytes: Uint8Array, name: string) => `knowbook-asset://${hash(bytes)}/${encodeURIComponent(name)}`
const contains = (value: RawCapsule2AssetReferences, source: string[], uri: string) => {
  const scope = value.scopes.find(scope => JSON.stringify(scope.source) === JSON.stringify(source))
  assert.ok(scope, 'The actual original metadata body owns its exact locator: ' + JSON.stringify(source))
  assert.ok(scope.destinations.some(item => item.uri === uri), 'The exact saved Markdown URI survives in that holder: ' + uri)
}
async function observe(profile: { db: Database.Database; file: string }, check: (value: RawCapsule2AssetReferences) => void) {
  const operations = profile.db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all()
  await withObserver2Copy(profile.db, profile.file, db => db.transaction(() => {
    const before = readRawCapsule2ContentOwned(db), history = readRawCapsule2WorkspaceHistoryOwned(db)
    const value = readRawCapsule2AssetReferencesOwned(db)
    assert.equal(value.version, 3); assert.equal(value.sourceContentHash, history.sourceContentHash)
    assert.equal(value.workspaceHistoryObservationHash, history.observationHash)
    check(value)
    assert.deepEqual(readRawCapsule2ContentOwned(db), before)
    assert.deepEqual(readRawCapsule2WorkspaceHistoryOwned(db), history)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
    assert.equal(value.certified, false); assert.equal(value.semanticValidationComplete, false); assert.equal(value.permit, false)
    assert.equal(value.sourceFileOwnershipVerified, false); assert.equal(value.sourceFileBytesVerified, false)
    assert.ok(Object.isFrozen(value) && Object.isFrozen(value.scopes))
  })())
  assert.deepEqual(profile.db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all(), operations)
}

test('capsule2 assets preserve genuine proof1 and job4 before bodies after Main consumes a remote orphan tombstone', () => withTombstones(async f => {
  const uri = portable(f.aliases[0].bytes, f.aliases[0].name)
  f.remoteFinal(records => { deleteGroup(records, f.groupId) })
  const result = completed(await f.exchange(), 'applied')
  const proofs = f.B.db.prepare("SELECT client_operation_id,result_json FROM synced_operations WHERE client_operation_id LIKE 'synced:logical-deletion:v1:%'").all() as Array<{ client_operation_id: string; result_json: string }>
  assert.equal(proofs.length, 1)
  const proof = JSON.parse(proofs[0].result_json) as { version: number; application: { operationId: string } }
  assert.equal(proof.version, 1); assert.equal(proof.application.operationId, result.operationId)
  const jobs = f.B.db.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-job.v1.%'").all() as Array<{ key: string; value: string }>
  const job = jobs.find(row => JSON.parse(row.value).request.operationId === result.operationId)
  assert.ok(job); assert.equal(JSON.parse(job.value).version, 4)
  await observe(f.B, value => {
    assert.equal(value.scopes.some(scope => scope.source[0] === 'synced_groups' && scope.source[1] === f.groupId), false)
    contains(value, ['synced_operations', proofs[0].client_operation_id, 'result_json', 'before'], uri)
    contains(value, ['app_settings', job.key, 'value', 'deletions', 'group:' + f.groupId, 'before'], uri)
  })
}, { onlyOrphan: true, assets: true }))

test('capsule2 assets preserve actual proof2 B/L and all four job7 decision-source body sets without scanning code or opaque metadata', () => withDeletionChoices(async f => {
  const baseUri = portable(f.aliases[0].bytes, f.aliases[0].name)
  const localBytes = Buffer.from('Actual divergent L asset bytes'), remoteBytes = Buffer.from('Actual independent remote document asset bytes')
  const [localAsset] = await new AttachmentStore(join(f.B.root, 'storage', 'assets')).import([{ name: 'local decision.png', bytes: localBytes }])
  const [remoteAsset] = await new AttachmentStore(join(f.A.root, 'storage', 'assets')).import([{ name: 'remote decision.png', bytes: remoteBytes }])
  const localUri = portable(localBytes, localAsset.name), remoteUri = portable(remoteBytes, remoteAsset.name)
  const opaqueUri = 'file:///never/decision-code.png'
  changeGroup(f.B.db, f.groupId, blocks => {
    blocks.push({ id: randomUUID(), type: 'paragraph', content: image(localAsset.url), checked: false, depth: 0, parentBlockId: null, createdAt: blocks[0].createdAt })
    blocks.push({ id: randomUUID(), type: 'code', content: image(opaqueUri), checked: false, depth: 0, parentBlockId: null, createdAt: blocks[0].createdAt, language: 'markdown' })
  })
  hostEdit(f.A.db, f.islands[0], image(remoteAsset.url)); completed(await f.exchange(f.A), 'applied')
  const conflict = groupConflict(f), preview = ready(await f.preview()), operationId = randomUUID()
  completed(await f.resolve(preview, [choose(component(preview, conflict.key), 'keep-delete')], operationId), 'applied')
  const savedJob = job7(f, operationId)
  const proofRows = f.B.db.prepare("SELECT client_operation_id,result_json FROM synced_operations WHERE client_operation_id LIKE 'synced:logical-deletion:v1:%'").all() as Array<{ client_operation_id: string; result_json: string }>
  const proof = proofRows.find(row => JSON.parse(row.result_json).application.operationId === operationId)
  assert.ok(proof); assert.equal(JSON.parse(proof.result_json).version, 2)
  f.B.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('custom.opaque.decision-data', image(opaqueUri), new Date().toISOString())
  await observe(f.B, value => {
    const source = ['app_settings', savedJob.jobRow.key, 'value']
    contains(value, ['synced_operations', proof.client_operation_id, 'result_json', 'base'], baseUri)
    contains(value, ['synced_operations', proof.client_operation_id, 'result_json', 'before'], localUri)
    contains(value, [...source, 'deletions', conflict.key, 'base'], baseUri)
    contains(value, [...source, 'deletions', conflict.key, 'before'], localUri)
    for (const part of ['localPhysical', 'localKnowledge']) contains(value, [...source, 'decisionSource', part, 'records', conflict.key, 'record'], localUri)
    contains(value, [...source, 'decisionSource', 'remote', 'records', 'doc:' + f.islands[0], 'record'], remoteUri)
    contains(value, [...source, 'decisionSource', 'baseRecords', conflict.key, 'record'], baseUri)
    assert.equal(value.scopes.some(scope => scope.destinations.some(item => item.uri === opaqueUri)), false)
  })
}, { assets: true }))

test('capsule2 assets preserve original exchange-archived group before/after bodies and refuse a corrupted saved side without repairing it', () => withExchange(async f => {
  const groupId = f.ack.createdLifecycle.groupId
  const first = await new AttachmentStore(join(f.B.root, 'storage', 'assets')).import([{ name: 'archived before.png', bytes: Buffer.from('Actual B branch asset') }])
  changeGroup(f.B.db, groupId, blocks => { blocks[0].content += ' ' + image(first[0].url) })
  completed(await f.exchange(f.B), 'applied'); completed(await f.exchange(f.A), 'applied')
  changeGroup(f.A.db, groupId, blocks => { blocks[0].content = 'Actual remote replacement without old assets' })
  completed(await f.exchange(f.A), 'applied'); const received = completed(await f.exchange(f.B), 'applied')
  const archives = f.B.db.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-history-row.v1.%' ORDER BY key").all() as Array<{ key: string; value: string }>
  const archive = archives.find(row => JSON.parse(row.value).operationId === received.operationId)
  assert.ok(archive, 'The actual remote replacement archives the receiver\'s original complete history row')
  const sourceHash = hash(f.aliases[0].bytes)
  const sourceUri = pathToFileURL(join(f.B.root, 'storage', 'assets', 'attachments', sourceHash.slice(0, 2), sourceHash, f.aliases[0].name)).href
  await observe(f.B, value => {
    contains(value, ['app_settings', archive.key, 'value', 'row', 'before_json'], sourceUri)
    contains(value, ['app_settings', archive.key, 'value', 'row', 'after_json'], first[0].url)
  })
  const changed = JSON.parse(archive.value) as { row: { after_json: string } }
  changed.row.after_json += ' '
  const corrupt = JSON.stringify(changed)
  assert.equal(f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(corrupt, archive.key).changes, 1)
  await withObserver2Copy(f.B.db, f.B.file, db => {
    assert.throws(() => db.transaction(() => readRawCapsule2AssetReferencesOwned(db))(), /history|hash|历史|归档|规范|字节|来源/)
    assert.equal((db.prepare('SELECT value FROM app_settings WHERE key=?').get(archive.key) as { value: string }).value, corrupt)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })
}, { assets: true }))
