import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { causeMessages, copyTreeFresh, hash, inventory, writeFresh } from './evidence.mjs'

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const handoff = JSON.parse(readFileSync(config.handoffPath, 'utf8'))
assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1')
assert.equal(process.cwd(), config.currentRoot)
assert.equal(process.env.TSX_TSCONFIG_PATH, join(config.currentRoot, 'tsconfig.test.json'))
const currentImport = path => import(pathToFileURL(join(config.currentRoot, path)).href)
// Deliberately no import from the old archive or its tests in this process.
const require = createRequire(pathToFileURL(join(config.currentRoot, 'package.json')))
const Database = require('better-sqlite3')
const { exchangeSyncedSnapshot } = await currentImport('src/main/sync/synced-exchange.ts')
const { readSyncedExchangeLocal, readSyncedExchangeReceipt } = await currentImport('src/main/database/synced-exchange-read.ts')
const { initialIncomingTargetFingerprint } = await currentImport('src/main/sync/synced-initial-incoming-model.ts')
const { readSyncedPersistentPublicationSnapshot } = await currentImport('src/main/database/synced-publication.ts')
const { mapPublicationCatalog } = await currentImport('src/main/sync/synced-publication-model.ts')
const { canonicalSyncedPortableJson, rewriteSyncedGroupAssets, rewriteSyncedPortableHostAssets, buildSyncedPortableAssetUri } = await currentImport('src/shared/syncedBlockPortable.ts')
let db = null
const open = () => {
  const next = new Database(handoff.profile.file, { fileMustExist: true })
  next.pragma('foreign_keys=ON')
  return next
}
function receiptRow() {
  return db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(handoff.operationId)
}
function settingsRow(key) {
  return db.prepare('SELECT key,value,updated_at FROM app_settings WHERE key=?').get(key)
}
function allTables() {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  return names.map(({ name }) => {
    assert.match(name, /^[a-z_0-9]+$/i)
    return { name, rows: db.prepare('SELECT * FROM "' + name + '"').all().map(row => canonicalSyncedPortableJson(row)).sort() }
  })
}
function assertOriginalFacts(settled = false) {
  assert.deepEqual(settingsRow(handoff.saved.jobRow.key), handoff.saved.jobRow, 'Current recovery never rewrites the original v1 immutable job row')
  assert.deepEqual(settingsRow(handoff.saved.headRow.key), handoff.saved.headRow, 'No unchanged remote/local sample is silently upgraded to a new attempt or planner')
  for (const row of handoff.saved.immutableSettings) assert.deepEqual(settingsRow(row.key), row, 'Every existing old immutable setting and phase prefix remains byte exact: ' + row.key)
  for (const row of handoff.saved.operations) {
    assert.deepEqual(db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(row.client_operation_id), row,
      'All already committed old ACK rows retain their exact original request/result/createdAt')
  }
  assert.deepEqual(inventory(handoff.spoolDirectory), handoff.spoolFiles, 'All original ready/inputs/manifest/job/object/asset spool files retain their raw bytes')
  for (const old of handoff.saved.attempts) {
    const current = db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(old.id)
    assert.ok(current, 'No original possible/confirmed attempt is removed')
    for (const [key, value] of Object.entries(old)) if (key !== 'state' && key !== 'confirmed_at') assert.deepEqual(current[key], value, 'Original exposure identity/hash/target/time is never laundered')
    assert.equal(current.state, settled ? 'confirmed' : old.state)
    if (old.state === 'confirmed') assert.deepEqual(current, old, 'Already confirmed original attempt facts are unchanged')
  }
  for (const member of handoff.saved.members) {
    assert.deepEqual(db.prepare('SELECT * FROM synced_group_exposure_members WHERE attempt_id=? AND group_id=?').get(member.attempt_id, member.group_id), member,
      'Original real-CAS publication membership is immutable')
  }
}
function strictLocal() {
  return db.transaction(() => readSyncedExchangeLocal(db, { request: handoff.saved.job.request,
    initialTargetFingerprint: initialIncomingTargetFingerprint(handoff.input.target) }))()
}
function actualPortable() {
  const snapshot = db.transaction(() => readSyncedPersistentPublicationSnapshot(db))()
  const localize = uri => {
    const file = fileURLToPath(uri), parts = relative(join(handoff.profile.root, 'storage', 'assets'), file).split(sep)
    assert.equal(parts.length, 4); assert.equal(parts[0], 'attachments')
    assert.match(parts[2], /^[a-f0-9]{64}$/); assert.equal(parts[1], parts[2].slice(0, 2))
    assert.equal(lstatSync(file).isFile(), true)
    assert.equal(hash(readFileSync(file)), parts[2], 'The independent SQL roundtrip oracle verifies each actual alias byte hash')
    return buildSyncedPortableAssetUri({ hash: parts[2], name: parts[3] })
  }
  const records = mapPublicationCatalog(snapshot.records, snapshot.catalogId).map(record => record.kind === 'synced-group'
    ? rewriteSyncedGroupAssets(record, localize) : record.kind === 'document' ? rewriteSyncedPortableHostAssets(record, localize) : record)
  const entries = Object.fromEntries(records.map(record => [record.kind === 'databases' ? 'databases' : record.kind === 'synced-group' ? 'group:' + record.id : 'doc:' + record.id,
    hash(Buffer.from(canonicalSyncedPortableJson(record)))]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  const dependencies = records.flatMap(record => record.kind !== 'document' ? [] : record.content.blocks.flatMap(block => block.type !== 'synced-block' ? []
    : [{ documentId: record.id, instanceId: block.id, groupId: JSON.parse(block.content).groupId,
      groupHash: entries['group:' + JSON.parse(block.content).groupId] }]))
    .sort((a, b) => a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0)
  assert.deepEqual(entries, handoff.expectedManifest.entries, 'Actual post-reopen SQL portable entries equal the exact old writer spool manifest, not a new planner prediction')
  assert.deepEqual(dependencies, handoff.expectedManifest.syncedInstances, 'Actual complete Key/instance dependencies converge to the original old writer publication')
  return { entries, dependencies, scope: snapshot.workspaceScope, recoveryEpoch: snapshot.recoveryEpoch }
}

try {
  db = open()
  assertOriginalFacts()
  // This strict read exercises genuine v1 state, stored requests, receipt,
  // archive indexes/rows and cuts in the current reader before any epoch test.
  const before = strictLocal()
  assert.ok(before.state, 'The legacy setup produces a genuine authenticated shared baseline')
  let profileBeforeReplay = null, epochMutation = null, replayBefore = null
  if (handoff.caseName === 'committed-replay') {
    const parsed = db.transaction(() => readSyncedExchangeReceipt(db, handoff.saved.job.request))()
    assert.equal(parsed.version, 1)
    assert.ok(parsed.provenance.historyArchives.length > 0 && parsed.provenance.hostHistoryCuts.length > 0,
      'The new strict reader authenticated actual old receipt/cut/archive facts before replay')
    const old = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get()
    const epoch = randomUUID()
    assert.equal(db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(epoch).changes, 1)
    epochMutation = { previous: old.recovery_epoch, next: epoch, workspaceScope: old.workspace_scope, fixtureOnly: true }
    db.close(); db = null
    profileBeforeReplay = copyTreeFresh(handoff.profile.root, join(config.evidence, 'profile-before-replay-current'))
    writeFresh(join(config.evidence, 'replay-epoch-fixture.json'), epochMutation)
    db = open(); replayBefore = allTables()
  }
  const result = await exchangeSyncedSnapshot(db, handoff.input, handoff.runtime)
  assert.equal(result.operationId, handoff.operationId)
  assert.equal(result.status, 'applied', 'All five original target operations have a genuinely applied finite result')
  if (handoff.caseName === 'committed-replay') {
    assert.deepEqual(result, { ...handoff.legacyResult, replayed: true }, 'The original v1 ACK wins before current epoch/state/remote checks')
    assert.deepEqual(receiptRow(), handoff.saved.receipt)
    assert.deepEqual(allTables(), replayBefore, 'Immutable old replay makes no SQL changes after the explicit fixture epoch change')
  } else {
    assert.equal(result.replayed, false)
    assert.equal(result.afterManifestHash, handoff.expectedManifestHash)
    const stored = receiptRow(); assert.ok(stored, 'The reopened original operation now has one committed receipt')
    const receipt = JSON.parse(stored.result_json)
    assert.equal(receipt.kind, 'synced-exchange-operation'); assert.equal(receipt.version, 1,
      'An original v1 job retains its v1 algorithm and receipt format when recovered')
    assert.deepEqual(receipt.request, handoff.saved.job.request)
    assert.deepEqual(receipt.result, result)
    assert.ok(receipt.provenance.historyArchives.length > 0 && receipt.provenance.hostHistoryCuts.length > 0,
      'Recovered original v1 plans produce authenticated real history boundaries')
    const after = strictLocal()
    assert.equal(after.state.currentOperationId, handoff.operationId)
    assert.equal(after.state.remoteWorkspaceId, handoff.expectedManifest.workspaceId)
    const prefix = 'sync.webdav.protocol5.exchange-job-phase.v1.' + handoff.operationId + '.' + handoff.saved.head.attemptId + '.'
    const phases = db.prepare('SELECT key,value,updated_at FROM app_settings WHERE substr(key,1,?)=?').all(prefix.length, prefix)
      .sort((a, b) => JSON.parse(a.value).sequence - JSON.parse(b.value).sequence)
    let previous = null
    for (const [sequence, row] of phases.entries()) {
      const fact = JSON.parse(row.value)
      assert.equal(fact.kind, 'synced-exchange-job-phase'); assert.equal(fact.version, 1)
      assert.equal(fact.sequence, sequence); assert.equal(fact.previousFactHash, previous)
      assert.equal(fact.operationId, handoff.operationId); assert.equal(fact.attemptId, handoff.saved.head.attemptId)
      assert.equal(fact.jobHash, handoff.saved.head.jobHash); assert.equal(fact.requestHash, handoff.saved.job.requestHash)
      previous = hash(Buffer.from(row.value))
    }
    assert.equal(JSON.parse(phases.at(-1).value).phase, 'settled', 'The genuine original v1 phase chain is extended to its real settled endpoint')
    assert.equal(db.prepare('SELECT state FROM synced_exposure_attempts WHERE id=?').get(handoff.saved.head.attemptId).state, 'confirmed')
    actualPortable()
  }
  assertOriginalFacts(true)
  const finalReceipt = receiptRow()
  db.close(); db = null
  let profileAfterReplay = null
  if (profileBeforeReplay) {
    profileAfterReplay = copyTreeFresh(handoff.profile.root, join(config.evidence, 'profile-after-replay-current'))
    assert.deepEqual(profileAfterReplay, profileBeforeReplay, 'Closed-profile files and SQLite sidecars remain raw-identical across historical replay')
  }
  writeFresh(join(config.evidence, 'current-result.json'), { status: 'passed', pid: process.pid,
    caseName: handoff.caseName, operationId: handoff.operationId, result, finalReceipt,
    originalV1SpoolPreserved: true, originalPhasePrefixPreserved: true,
    strictOldStateCutArchiveRead: true, epochMutation, profileBeforeReplay, profileAfterReplay,
    completedAt: new Date().toISOString() })
  process.stdout.write(JSON.stringify({ status: 'passed', caseName: handoff.caseName, operationId: handoff.operationId }) + '\n')
} catch (error) {
  if (db?.open) db.close()
  writeFresh(join(config.evidence, 'current-failure.json'), { status: 'failed', pid: process.pid,
    caseName: handoff.caseName, messages: causeMessages(error), stack: error instanceof Error ? error.stack : null, at: new Date().toISOString() })
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + '\n')
  process.exitCode = 1
}
