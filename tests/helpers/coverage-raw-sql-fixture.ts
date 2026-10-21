import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { advanceSyncedRecoveryEpoch } from '../../src/main/database/synced-recovery-boundary'
import { assertSyncedRecoveryBoundaryRecords } from '../../src/main/database/synced-recovery-boundary-read'
import { recoveryBoundaryHash } from '../../src/main/database/synced-recovery-boundary-model'
import { coverageAnchorExpectation, coverageOperationId, coverageReceiptKey, coverageSettingKey,
  serializeKnowledgeRestoreReceipt, serializeSyncedKnowledgeCoverage, serializeSyncedKnowledgeCoverageLink,
  syncedKnowledgeCoverageLinkHash } from '../../src/main/database/restore-knowledge-coverage-model'
import { readRawPriorKnowledgeCoverageOwned } from '../../src/main/database/restore-knowledge-coverage-raw-read'
import { structureFixture, tupleFor, type StructureFixture } from './coverage-structure-fixture'

/** These are deliberately untrusted NEW syntax rows, not an accepted producer,
 * old ACK/proof forgery, authenticated DAG, fence, or install fixture. */
export function insertCoverageSyntax(db: Database.Database, fixture = structureFixture(), options: {
  omit?: 'coverage' | 'link' | 'receipt' | 'anchor'
  anchor?: Partial<ReturnType<typeof coverageAnchorExpectation>>
} = {}) {
  const { coverage, link, receipt } = fixture
  const anchor = { ...coverageAnchorExpectation(link), ...options.anchor }
  db.transaction(() => {
    if (options.omit !== 'coverage') db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)')
      .run(coverageSettingKey(coverage.operationId), serializeSyncedKnowledgeCoverage(coverage), coverage.acceptedAt)
    if (options.omit !== 'link') db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
      .run(coverageOperationId(link.operationId), syncedKnowledgeCoverageLinkHash(link), serializeSyncedKnowledgeCoverageLink(link), link.acceptedAt)
    if (options.omit !== 'receipt') db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)')
      .run(coverageReceiptKey(receipt.operationId), serializeKnowledgeRestoreReceipt(receipt), receipt.acceptedAt)
    if (options.omit !== 'anchor') db.prepare(`INSERT INTO synced_exposure_attempts
      (id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(anchor.id, anchor.request_hash, anchor.channel, anchor.target_fingerprint, anchor.publication_hash, anchor.state, anchor.created_at, anchor.confirmed_at)
  }).immediate()
  return { fixture, anchor }
}
export const readCoverage = (db: Database.Database) => db.transaction(() => readRawPriorKnowledgeCoverageOwned(db))()
export function sqlDefinitions(db: Database.Database) {
  return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
}
export function actualHistorySyntax(db: Database.Database, at: string): StructureFixture {
  const before = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as
    { workspace_scope: string; recovery_epoch: string }
  const input = { operationId: randomUUID(), expectedWorkspaceScope: before.workspace_scope, expectedRecoveryEpoch: before.recovery_epoch,
    workspaceScope: before.workspace_scope, recoveryEpoch: randomUUID(), documentBoundary: at, acceptedAt: at }
  const receipt = db.transaction(() => advanceSyncedRecoveryEpoch(db, input)).immediate()
  if (!receipt) throw new Error('The genuine Main V3 workspace must produce actual B/R history, not an empty declaration')
  const boundary = db.transaction(() => assertSyncedRecoveryBoundaryRecords(db))().boundaries.get(input.operationId)
  if (!boundary) throw new Error('The actual Main B must be present before any new C syntax exists')
  const coverage = structureFixture().coverage
  return tupleFor({ ...coverage, operationId: input.operationId, acceptedAt: at,
    root: { ...coverage.root, operationId: input.operationId },
    target: { workspaceScope: input.workspaceScope, recoveryEpoch: input.recoveryEpoch, documentBoundary: at },
    cut: { kind: 'synced-recovery-epoch-cut', version: 1, operationId: input.operationId, workspaceScope: input.workspaceScope,
      beforeEpoch: input.expectedRecoveryEpoch, afterEpoch: input.recoveryEpoch, documentBoundary: at, acceptedAt: at,
      boundaryHash: recoveryBoundaryHash(boundary), epochRequestHash: (db.prepare('SELECT request_hash FROM synced_operations WHERE client_operation_id=?')
        .get('synced:recovery-epoch:v1:' + input.operationId) as { request_hash: string }).request_hash } })
}
/** Exact existing SQL guard path for an ordinary UUID exposure attempt. The
 * group is created by Main; no historical ACK or proof is manufactured. */
export function ordinaryExposure(db: Database.Database, groupId: string, channel: string, attemptId: string = randomUUID()) {
  const group = db.prepare('SELECT creation_id,revision,topology_revision FROM synced_groups WHERE id=?').get(groupId) as
    { creation_id: string; revision: string; topology_revision: string }
  const at = '2047-01-02T03:04:05.006Z'
  db.transaction(() => {
    db.prepare(`INSERT INTO synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at)
      VALUES(?,?,?,?,?,'possible',?,NULL)`).run(attemptId, '1'.repeat(64), channel, '2'.repeat(64), '3'.repeat(64), at)
    db.prepare(`INSERT INTO synced_group_exposure_members(attempt_id,group_id,creation_id,revision,topology_revision,semantic_hash)
      VALUES(?,?,?,?,?,?)`).run(attemptId, groupId, group.creation_id, group.revision, group.topology_revision, '4'.repeat(64))
  }).immediate()
  return attemptId
}
