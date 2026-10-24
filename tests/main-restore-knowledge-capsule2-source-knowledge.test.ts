import assert from 'node:assert/strict'
import test from 'node:test'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { prepareCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { extractCapsule2SourceMaterial, readCapsule2SourceMaterial } from '../src/main/database/restore-knowledge-capsule2-source-material'
import { readRawCapsule2SourceKnowledgeOwned } from '../src/main/database/restore-knowledge-payload-raw-read'
import { readCertifiedDurableSqlCapsule } from '../src/main/database/restore-knowledge-capsule-read'
import { COVERAGE_ANCHOR_CHANNEL } from '../src/main/database/restore-knowledge-coverage-model'
import { restoreInventory } from '../src/main/database/restore-safety-files'
import { allTables, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { writeMixedOrdinary501, withCapsule2RawCopy, decodedCapsule2Table } from './helpers/capsule2-raw-fixture'
import { actualHistorySyntax, insertCoverageSyntax } from './helpers/coverage-raw-sql-fixture'
import { withControlledRestore, restoreKnowbookDatabase, noProcesses, KnowbookStore } from './helpers/controlled-restore-fixture'
import { readHistoricalRowLocator } from '../src/main/database/synced-history-evidence-support'

async function capture(f: Pick<V3Fixture, 'userDataRoot' | 'db'>) {
  const original = await captureAssetOriginal(f), archive = await prepareCapsule2AssetArchive(original.original)
  const material = await extractCapsule2SourceMaterial(archive), value = await readCapsule2SourceMaterial(material)
  assert.deepEqual(await restoreInventory(original.info.originalDirectory), original.inventory)
  return { original, material, value }
}

test('capsule2 source K retains actual mixed ordinary501 identities and unreserved templates without copying policy credentials', () => withV3Fixture(async f => {
  const mixed = writeMixedOrdinary501(f), secret = 'private-k-source-policy-credential-value'
  f.store.saveSetting('source-k.private-policy', secret)
  const before = allTables(f.db), { value } = await capture(f), knowledge = value.knowledge
  assert.equal(value.version, 2)
  assert.ok(knowledge.groups.some(group => group.tuple.groupId === f.groupId))
  assert.ok(knowledge.instances.some(instance => instance.instanceId === f.instanceId))
  assert.ok(knowledge.occupancy.some(item => item.namespace === 'document' && item.id === f.targetId && item.kind === 'physical'))
  for (const block of mixed.template.blocks) assert.ok(knowledge.occupancy.some(item => item.id === block.id && item.kind === 'template'))
  assert.ok(knowledge.historicalMaterial.length > 0)
  assert.equal(knowledge.sourceContentHash, value.assetArchive.sourceContentHash)
  assert.equal(knowledge.workspaceHistoryObservationHash, value.source.history.observationHash)
  assert.ok(decodedCapsule2Table(value.source.sourceContent, 'app_settings').some(row => row.value === secret))
  for (const spelling of [secret, Buffer.from(secret).toString('base64'), Buffer.from('source-k.private-policy').toString('base64')])
    assert.equal(capsuleJson(knowledge).includes(spelling), false)
  assert.equal(Reflect.set(knowledge.groups, 'length', 0), false)
  for (const key of ['certified','semanticValidationComplete','acceptedCoverage','effective','permit'] as const) assert.equal(knowledge[key], false)
  await assert.rejects(readCertifiedDurableSqlCapsule(knowledge as never), /不是Main认证/)
  assert.deepEqual(allTables(f.db), before)
}))

test('capsule2 source K binds every actual prior-C support row while keeping its anchor separate from member exposure and accepted coverage', () => withV3Fixture(async f => {
  insertCoverageSyntax(f.db, actualHistorySyntax(f.db, '2054-03-02T01:02:03.004Z'))
  const before = allTables(f.db), { value } = await capture(f), knowledge = value.knowledge
  assert.equal(knowledge.priorCoverageRequirements.entries.length, 1)
  assert.deepEqual(knowledge.priorCoverageRequirements, value.priorCoverageRequirements)
  assert.equal(knowledge.coverageMaterial.length, 4); assert.equal(knowledge.coverageAnchors.length, 1)
  assert.equal(knowledge.coverageAnchors[0].kind, 'unresolved-coverage-anchor')
  assert.equal(knowledge.coverageAnchors[0].acceptedCoverage, false)
  assert.equal(knowledge.exposures.some(row => row.attempt.channel === COVERAGE_ANCHOR_CHANNEL), false)
  assert.ok(knowledge.recoveryBoundaries.length > 0)
  const key = (row: { table: string; key: readonly unknown[]; occurrence: number; rowHash: string }) => capsuleJson([row.table,row.key,row.occurrence,row.rowHash])
  const originals = new Set(knowledge.originals.flatMap(table => table.rows.map(key)))
  for (const material of knowledge.coverageMaterial) {
    assert.equal(material.fact.evidenceClass, 'unresolved-syntax-only')
    for (const row of [material.primary,...material.supports]) assert.ok(originals.has(key(row)))
    assert.notEqual(material.fact.locator.rowHash, material.primary.rowHash, 'Original historical and typed K row domains remain distinct')
  }
  assert.equal(knowledge.certified, false); assert.equal(knowledge.effective, false); assert.equal(knowledge.permit, false)
  assert.deepEqual(allTables(f.db), before)
}))

test('capsule2 source K requery remains bound to immutable originals after the genuine live Store creates later content and history', () => withV3Fixture(async f => {
  const mixed = writeMixedOrdinary501(f), { material, value } = await capture(f), detail = f.store.getDocumentDetail(f.targetId)!
  f.store.updateDocument(f.targetId, { title:'Changed after original capture',summary:detail.summary,blocks:detail.blocks })
  const hot = await withCapsule2RawCopy(f, db => db.transaction(() => readRawCapsule2SourceKnowledgeOwned(db))())
  assert.notEqual(hot.knowledge.observationHash, value.knowledge.observationHash)
  const reread = await readCapsule2SourceMaterial(material)
  assert.deepEqual(reread.knowledge, value.knowledge)
  assert.ok(decodedCapsule2Table(reread.source.sourceContent,'documents').some(row => row.title === mixed.title))
  assert.equal(f.store.getDocumentDetail(f.targetId)!.title, 'Changed after original capture')
}))

test('capsule2 source K rejects actual writable autocommit FK-off and query-only-off connections without changing source rows', () => withV3Fixture(async f => {
  const before = allTables(f.db), expected = /readonly|只读|事务|query-only|FKON/
  assert.throws(() => f.db.transaction(() => readRawCapsule2SourceKnowledgeOwned(f.db))(), expected)
  await withCapsule2RawCopy(f, db => assert.throws(() => readRawCapsule2SourceKnowledgeOwned(db), expected))
  await withCapsule2RawCopy(f, db => { db.pragma('foreign_keys=OFF'); assert.throws(() => db.transaction(() => readRawCapsule2SourceKnowledgeOwned(db))(), expected) })
  await withCapsule2RawCopy(f, db => { db.pragma('query_only=OFF'); assert.throws(() => db.transaction(() => readRawCapsule2SourceKnowledgeOwned(db))(), expected) })
  assert.deepEqual(allTables(f.db), before)
}))

test('capsule2 source K retains an actual maintenance Receipt1 as original evidence without promoting it to prior-C or replay authority', () => withControlledRestore(async f => {
  f.sealCurrent()
  await restoreKnowbookDatabase({ userDataRoot:f.profile,backupPath:f.backup,stopProcesses:noProcesses })
  const store = new KnowbookStore(f.database), db = store.getUnsafeDatabaseHandle()
  try {
    const receipts = db.prepare("SELECT key FROM app_settings WHERE key LIKE 'database.restore.receipt.%'").all() as Array<{key:string}>
    assert.equal(receipts.length, 1)
    const before = allTables(db), { value } = await capture({ userDataRoot:f.profile,db })
    const knowledge = value.knowledge
    assert.equal(knowledge.legacyRestoreReceipts.length, 1)
    const actual = db.transaction(() => readHistoricalRowLocator(db,'app_settings',[receipts[0].key]))()
    assert.deepEqual(knowledge.legacyRestoreReceipts[0].locator, actual)
    const row = knowledge.legacyRestoreReceipts[0].source
    assert.ok(knowledge.originals.flatMap(table => table.rows).some(original => original.rowHash === row.rowHash && capsuleJson(original.key) === capsuleJson(row.key)))
    assert.deepEqual(knowledge.priorCoverageRequirements.entries, [])
    assert.deepEqual(knowledge.coverageMaterial, []); assert.deepEqual(knowledge.coverageAnchors, [])
    assert.equal(knowledge.certified, false); assert.equal(knowledge.acceptedCoverage, false); assert.equal(knowledge.permit, false)
    assert.deepEqual(allTables(db), before)
  } finally { store.destroy() }
}))
