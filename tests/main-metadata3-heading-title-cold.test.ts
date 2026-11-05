// Independent cold consumers read the original Main title action.
import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../src/main/database/store'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { headingTitle3OriginalsFromRaw } from '../src/main/database/restore-knowledge-heading-title3-original'
import { readHeadingTitle3OriginalSnapshotOwned } from '../src/main/database/synced-heading-title3-read'
import { graph3Rows, graph3Text, RestoreGraph3Conflict } from '../src/main/database/restore-knowledge-graph3-data'
import { deriveRoot3SettledWorkingEvidence3 } from '../src/main/database/restore-knowledge-assets3-context'
import { deriveRoot5SettledWorkingEvidence5 } from '../src/main/database/restore-knowledge-assets5-working-context'
import { deriveRootRestoreProvenanceSources3 } from '../src/main/database/restore-knowledge-provenance3-model'
import { prepareRootRestoreIdentityPlan3, readRootRestoreIdentityGraphInputs3 } from '../src/main/database/restore-knowledge-identity3-read'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { exchangeJobPrefix, parseExchangeStored, validateExchangeJob } from '../src/main/sync/synced-exchange-model'
import { validateHostCreateOperationAck } from '../src/main/database/synced-host-operation-receipt'
import { historicalMetadataLocator } from '../src/main/database/synced-history-evidence-support'
import { createRequest, freshBlock, randomUUID } from './helpers/synced-backup-v3-fixture'
import { request, restoreInput } from './helpers/synced-host-final-fixture'
import { withConflicts, completed, ready, component, mergeDecision, editKeepingKeys } from './helpers/synced-exchange-conflict-fixture'
import { withContent3Fixture } from './helpers/content3-fixture'
import type { SyncedStructureApplied } from '../src/shared/synced-blocks'
import type { SyncedEditingHostResult } from '../src/shared/synced-editing-session'

/** Genuine create → published → new title business event. No direct SQL birth,
 * metadata, ACK or exposure fixture is used to enter the positive domain. */
function createActualTitle3(store: KnowbookStore, profileRoot: string, inverse = false) {
  const db = store.getUnsafeDatabaseHandle(), hostId = store.createDocument(null), targetId = store.createDocument(null)
  const headingId = randomUUID(), linkId = randomUUID(), suffix = randomUUID(), targetTitle = 'Cold title target ' + suffix
  store.updateDocument(hostId, { title: 'Cold title host ' + suffix, summary: '', blocks: [freshBlock(randomUUID(), 'Ordinary source')] })
  store.updateDocument(targetId, { title: targetTitle, summary: '', blocks: [{ ...freshBlock(headingId, 'Cold exact heading'), type: 'heading-1' }] })
  const sender = Object.freeze({ frame: 'genuine title3 cold producer' })
  const opened = store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: hostId })
  assert.equal(opened.status, 'ready'); if (opened.status !== 'ready') throw Error('Actual source session required')
  const createInput = createRequest(db, { documentId: hostId, selectedRootIds: [linkId], dirty(working) {
    working.blocks.push(freshBlock(linkId, '[exact heading](' + encodeURIComponent(targetTitle) + '.md#cold-exact-heading)'))
  } })
  const birth = validateHostCreateOperationAck(store.invokeSyncedEditingSession(sender,
    { sessionId: opened.session.sessionId, method: 'applySyncedHostStructure', input: createInput }), createInput.clientOperationId)
  const groupId = birth.createdLifecycle.groupId
  assert.equal(JSON.parse((db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?')
    .get(birth.operationId) as { result_json: string }).result_json).kind, 'synced-host-create-heading-birth-operation')
  const canonicalRoot = realpathSync(profileRoot)
  writeSyncedBackupV3(db, { userDataRoot: canonicalRoot, destination: join(canonicalRoot, 'title3-publication-' + randomUUID()), snapshotId: randomUUID() })
  const targetSession = store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: targetId })
  assert.equal(targetSession.status, 'ready'); if (targetSession.status !== 'ready') throw Error('Actual target session required')
  const input = request(db, [targetId], after => { after[0].title = targetTitle + ' renamed' })
  const saved = store.invokeSyncedEditingSession(sender, { sessionId: targetSession.session.sessionId, method: 'applySyncedHostStructure', input })
  assert.equal(saved.status, 'applied'); if (saved.status !== 'applied') throw Error('The actual title business event must commit')
  assert.ok(saved.historyToken, 'The cold case includes a genuine W→A history action')
  let latest: SyncedStructureApplied = saved
  if (inverse) for (const direction of ['undo', 'redo'] as const) {
    const restored: SyncedEditingHostResult = store.invokeSyncedEditingSession(sender, { sessionId: targetSession.session.sessionId,
      method: 'restoreSyncedHostOperation', input: restoreInput(db, saved, direction) })
    assert.equal(restored.status, 'applied'); if (restored.status !== 'applied') throw Error('Genuine title inverse must commit')
    latest = restored
  }
  for (const operationId of [saved.operationId, latest.operationId]) assert.equal(JSON.parse((db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?')
    .get(operationId) as { result_json: string }).result_json).kind, 'synced-host-heading-title-metadata3-operation')
  const group = latest.groups.find(group => group.groupId === groupId); assert.ok(group)
  const wire = { kind: 'synced-group' as const, id: groupId, creationId: group.creationId, createdAt: group.createdAt,
    origin: group.origin, bindings: group.bindings, blocks: group.blocks }
  return { birth, saved, latest, groupId, linkId, wire, text: wire.blocks.find(block => block.id === linkId)!.content }
}

test('cold assets3 and Working5 consume the actual title3 ACK group of a real custom merge and refuse its missing exact companion', () => withConflicts(async f => {
  const store = KnowbookStore.openCanonicalRuntime(f.B.file)
  const actual = (() => { try { return createActualTitle3(store, f.B.root) } finally { store.destroy() } })()
  completed(await f.exchange(f.B), 'applied'); completed(await f.exchange(f.A), 'applied')
  editKeepingKeys(f.A, actual.groupId, blocks => { blocks[0].content = 'REMOTE overlap ' + blocks[0].content })
  completed(await f.exchange(f.A), 'applied')
  editKeepingKeys(f.B, actual.groupId, blocks => { blocks[0].content = 'LOCAL overlap ' + blocks[0].content })
  const preview = ready(await f.preview()), key = 'group:' + actual.groupId
  const decision = mergeDecision(component(preview, key), part => {
    assert.equal(part.field, 'block-content'); assert.equal(part.canEditText, true)
    return { choice: 'custom', text: actual.text }
  })
  const operationId = randomUUID(); completed(await f.resolve(preview, [decision], operationId), 'applied')
  const prefix = exchangeJobPrefix(operationId), jobs = f.B.db.prepare('SELECT key,value FROM app_settings WHERE substr(key,1,?)=?')
    .all(prefix.length, prefix) as Array<{ key: string; value: string }>
  assert.equal(jobs.length, 1)
  const job = validateExchangeJob(parseExchangeStored(jobs[0].value)); assert.equal(job.version, 2)
  const merge = job.merges?.find(value => value.key === key); assert.ok(merge)
  assert.equal(merge.resultHash, publicationHash(publicationJson(actual.wire)))
  const file = join(f.folder, 'title3-cold-' + randomUUID() + '.db'); await f.B.db.backup(file)
  const cold = new Database(file, { readonly: true, fileMustExist: true })
  try {
    cold.pragma('foreign_keys=ON'); cold.pragma('query_only=ON')
    const raw = cold.transaction(() => readRawCapsule2ContentOwned(cold))()
    const original = headingTitle3OriginalsFromRaw(raw)(actual.saved.operationId)
    const owned = cold.transaction(() => readHeadingTitle3OriginalSnapshotOwned(cold))().originals.get(actual.saved.operationId)
    assert.ok(owned)
    assert.deepEqual(original.envelope, owned.original.envelope)
    assert.deepEqual(original.supports.map(value => publicationJson(value)).sort(), owned.supports.map(value => publicationJson(value)).sort(), 'Main and full-packet support closures agree exactly')
    assert.equal(original.writePermit, false); assert.equal(original.currentHeadingMutationAuthorized, false)
    for (const derive of [deriveRoot3SettledWorkingEvidence3, deriveRoot5SettledWorkingEvidence5]) {
      const settled = derive(raw).get(jobs[0].key); assert.ok(settled)
      const selected = settled.merged.find(value => value.recordKey === key); assert.ok(selected)
      assert.equal(publicationJson(selected.record), publicationJson(actual.wire))
    }
    const companion = original.supports.findIndex(locator => publicationJson(locator) === publicationJson(historicalMetadataLocator(original.metadata)))
    assert.ok(companion >= 0)
    const support = original.supportSources[companion]
    const missing = { ...raw, tables: raw.tables.map(table => table.name === 'app_settings'
      ? { ...table, rows: table.rows.filter(row => row !== support.original) } : table) }
    assert.equal(graph3Rows(missing, 'app_settings').some(row => row.value.key === original.metadata.key), false)
    for (const derive of [deriveRoot3SettledWorkingEvidence3, deriveRoot5SettledWorkingEvidence5]) assert.throws(() => derive(missing), /Heading title3 original packet invalid: original support missing\/duplicate: app_settings/)
    assert.deepEqual(cold.transaction(() => readRawCapsule2ContentOwned(cold))(), raw)
    assert.equal((cold.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  } finally { cold.close() }
}))

test('the genuine cold provenance consumer authenticates title3 restore initial supports and refuses omission of one original point', async () => {
  let actual: ReturnType<typeof createActualTitle3> | undefined
  await withContent3Fixture(async f => {
    assert.ok(actual)
    const identity = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan), data = await readRootRestoreIdentityGraphInputs3(identity.plan)
    const value = deriveRootRestoreProvenanceSources3(data), origin = value.origins.find(row => row.tuple.groupId === actual!.groupId)
    assert.ok(origin); assert.equal(origin.firstInstance.status, 'proved-birth')
    assert.equal(origin.firstInstance.sourceId, actual.birth.createdLifecycle.origin.firstInstanceId)
    assert.equal(origin.document.status, 'unresolved'); assert.equal(value.acceptedCoverage, false); assert.equal(value.effective, false); assert.equal(value.permit, false)
    const materials = data.inputs.source.knowledge.historicalMaterial.filter(material => material.fact.family === 'heading-title-transition'
      && material.fact.locator.key[0] === actual!.latest.operationId)
    assert.equal(materials.length, 1)
    const points = materials[0].supports.filter(reference => reference.table === 'synced_operations')
    assert.ok(points.length >= 4, 'Restore material retains its actual initial business operation, predecessor and full before/after points')
    const removed = points.find(reference => reference.key[0]?.[0] === 'text'
      && graph3Text(reference.key[0], data.inputs.source.knowledge.encoding).startsWith('synced.metadata2.read-baseline:'))
    assert.ok(removed)
    const bad = structuredClone(data), selected = bad.inputs.source.knowledge.historicalMaterial.find(material => material.fact.family === 'heading-title-transition'
      && material.fact.locator.key[0] === actual!.latest.operationId)!
    Reflect.set(selected, 'supports', selected.supports.filter(reference => publicationJson(reference) !== publicationJson(removed)))
    assert.throws(() => deriveRootRestoreProvenanceSources3(bad), (error: unknown) => {
      assert.ok(error instanceof RestoreGraph3Conflict)
      assert.equal(error.code, 'provenance-heading-title3-invalid-original-closure')
      return true
    })
  }, undefined, undefined, source => { actual = createActualTitle3(source.store, source.userDataRoot, true) })
})
