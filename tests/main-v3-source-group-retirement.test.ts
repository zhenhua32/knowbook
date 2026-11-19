import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rawPriorCoverageRequirementsHash } from '../src/main/database/restore-knowledge-coverage-model'
import { readRestoreKnowledgeInstallProof, verifyRestoreKnowledgeInstalledDatabase, writeRestoreKnowledgeInstallProof } from '../src/main/database/restore-knowledge-install-proof'
import { clearInstalledRestoreRuntime, registerInstalledRestoreRuntime } from '../src/main/database/restore-knowledge-runtime-authority'
import { restorePaths } from '../src/main/database/restore-safety-files'
import { restoreJson } from '../src/main/database/restore-safety-model'
import { KnowbookStore } from '../src/main/database/store'
import { captureSyncedBackupV3, readSyncedBackupV3Capture } from '../src/main/database/synced-backup-v3'
import { getSyncedGroupSnapshots, listSyncedGroups } from '../src/main/database/synced-blocks-read'
import { readRawSyncedPersistentPublicationSnapshotOwned } from '../src/main/database/synced-publication-raw-read'
import { readV3SourceGroupRetirementsOwned, v3SourceGroupRetirementHash, v3SourceGroupRetirementKey, writeV3SourceGroupRetirementsOwned,
  type V3SourceGroupRetirement } from '../src/main/database/v3-source-group-retirement'
import { actualHistorySyntax, insertCoverageSyntax, readCoverage } from './helpers/coverage-raw-sql-fixture'
import { applySyncedHostCommand, applySyncedHostFinal, createRequest, freshBlock, randomUUID, request,
  sha256, snapshot, sourceGroupRetirementEvidence, withV3Fixture } from './helpers/synced-backup-v3-fixture'

test('a V3 retirement hides only its proven group, retains block births, and checks the sealed witness offline', () => withV3Fixture(async f => {
  const { db, store } = f
  const documentId = store.createDocument(null), blockId = randomUUID()
  store.updateDocument(documentId, { title: 'Imported page', summary: '',
    blocks: [freshBlock(blockId, 'Retiring [target](V3%20Target.md#target-heading)')] })
  const create = createRequest(db, { documentId, selectedRootIds: [blockId] }), groupId = create.action.groupId
  assert.equal(applySyncedHostCommand(db, create).status, 'applied')
  const removal = request(db, [documentId], ([host]) => { host.blocks = [freshBlock(randomUUID(), 'Live page')] })
  assert.equal(applySyncedHostFinal(db, removal).status, 'applied')
  const original = snapshot(db, groupId)
  assert.equal(original.bindings[0]?.target.kind, 'heading')
  assert.equal(original.instances.length, 0)
  const coverage = actualHistorySyntax(db, '2048-01-02T03:04:05.006Z')
  insertCoverageSyntax(db, coverage)
  const sourceGroupId = randomUUID(), sourceCreationId = randomUUID()
  const group = { kind: 'synced-group' as const, id: groupId, creationId: original.creationId, createdAt: original.createdAt,
    origin: original.origin, bindings: original.bindings, blocks: original.blocks }
  const evidence = restoreJson(sourceGroupRetirementEvidence({ ...group, id: sourceGroupId, creationId: sourceCreationId }))
  const retirement: V3SourceGroupRetirement = {
    kind: 'v3-source-group-retirement', version: 1, operationId: coverage.coverage.operationId,
    group, sourceGroupId, sourceCreationId, sourceSnapshotId: randomUUID(), successorSnapshotId: randomUUID(),
    publicationHeadHash: 'a'.repeat(64), remoteEvidenceHash: sha256(evidence)
  }
  const body = db.prepare('SELECT * FROM synced_group_blocks WHERE group_id=?').get(groupId) as Record<string, unknown>
  db.transaction(() => {
    db.prepare('DELETE FROM synced_group_blocks WHERE group_id=?').run(groupId)
    writeV3SourceGroupRetirementsOwned(db, [retirement])
  }).immediate()
  assert.equal(db.prepare('SELECT state FROM block_identities WHERE id=?').pluck().get(blockId), 'retained')
  assert.deepEqual(db.transaction(() => readV3SourceGroupRetirementsOwned(db))().get(groupId), retirement)
  assert.equal(getSyncedGroupSnapshots(db, { groupIds: [groupId, f.groupId] }).items[0].status, 'missing')
  assert.deepEqual(listSyncedGroups(db, { query: '', limit: 1, offset: 0 }).items.map(item => item.groupId), [f.groupId])
  assert.equal(listSyncedGroups(db, { query: '', limit: 1, offset: 1 }).total, 1)
  const publication = db.transaction(() => readRawSyncedPersistentPublicationSnapshotOwned(db))()
  assert.deepEqual(publication.groups.map(item => item.wire.id), [f.groupId])
  const key = v3SourceGroupRetirementKey(groupId)
  assert.throws(db.transaction(() => {
    db.prepare('DELETE FROM app_settings WHERE key=?').run(key)
    getSyncedGroupSnapshots(db, { groupIds: [groupId] })
  }), /同步块内容或结构无效/)
  assert.throws(db.transaction(() => {
    db.prepare("UPDATE synced_groups SET bindings_json='[]' WHERE id=?").run(groupId)
    readV3SourceGroupRetirementsOwned(db)
  }), /原物理组头/)
  assert.throws(db.transaction(() => {
    const columns = Object.keys(body)
    db.prepare(`INSERT INTO synced_group_blocks(${columns.join(',')}) VALUES(${columns.map(column => '@' + column).join(',')})`).run(body)
    readV3SourceGroupRetirementsOwned(db)
  }), /仍有正文/)

  const requirements = readCoverage(db), operationId = retirement.operationId
  const paths = restorePaths(f.userDataRoot, operationId), witness = join(paths.recovery, `v3-source-tombstone-${groupId}.json`)
  await mkdir(paths.recovery, { recursive: true })
  await writeFile(witness, evidence)
  const proof = {
    operationId, mountId: randomUUID(), descriptorHash: 'a'.repeat(64), coverage: requirements.entries[0],
    planHash: coverage.coverage.planHash, rootMaterialHash: coverage.coverage.rootMaterialHash,
    requirementsHash: rawPriorCoverageRequirementsHash(requirements), identity: { planId: randomUUID(), expectedManifestHash: '1'.repeat(64) },
    reference: { planId: randomUUID(), expectedManifestHash: '2'.repeat(64) },
    sourceArchive: { snapshotId: retirement.successorSnapshotId, inventoryHash: '3'.repeat(64) },
    retirements: [{ groupId, sourceGroupId, sourceCreationId, recordHash: v3SourceGroupRetirementHash(retirement), remoteEvidenceHash: retirement.remoteEvidenceHash }]
  }
  await assert.rejects(writeRestoreKnowledgeInstallProof(f.userDataRoot, { ...proof, retirements: [...proof.retirements, ...proof.retirements] }), /严格排序且无重复/)
  const proofHash = await writeRestoreKnowledgeInstallProof(f.userDataRoot, proof)
  f.close()
  const verified = await verifyRestoreKnowledgeInstalledDatabase(f.userDataRoot, operationId, proofHash, 'steady')
  assert.equal(verified.coverage.operationId, operationId)
  registerInstalledRestoreRuntime(f.file, { ...verified.coverage.target, requirements: verified.requirements, operationId })
  try {
    const reopened = KnowbookStore.openCanonicalRuntime(f.file)
    try {
      const captured = readSyncedBackupV3Capture(captureSyncedBackupV3(reopened.getUnsafeDatabaseHandle()))
      assert.deepEqual(captured?.groups.map(item => item.wire.id), [f.groupId])
    } finally { reopened.destroy() }
  } finally { clearInstalledRestoreRuntime(f.file) }
  await writeFile(witness, Buffer.concat([await readFile(witness), Buffer.from('!')]))
  await assert.rejects(readRestoreKnowledgeInstallProof(f.userDataRoot, operationId, proofHash), /实际封存的 WebDAV 退场原件变化/)
}))
