import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { advanceSyncedRecoveryEpoch } from '../../src/main/database/synced-recovery-boundary'
import { assertSyncedRecoveryBoundaryRecords } from '../../src/main/database/synced-recovery-boundary-read'
import { recoveryBoundaryHash } from '../../src/main/database/synced-recovery-boundary-model'
import { prepareCapsule2AssetArchive } from '../../src/main/database/restore-knowledge-capsule2-asset-archive'
import { captureSealedCapsule2SourceFromArchive } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import { captureQualifiedOriginalBundleFromReferences, type CompleteOriginalBundle } from '../../src/main/database/restore-knowledge-qualified-originals'
import { requiredReferenceRoots } from '../../src/main/database/restore-knowledge-reference-context-model'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import { insertCoverageSyntax } from './coverage-raw-sql-fixture'
import { structureFixture, tupleFor } from './coverage-structure-fixture'
import type { CoverageRootReference } from '../../src/main/database/restore-knowledge-coverage-model'
import type { V3Fixture } from './synced-backup-v3-fixture'
import type { captureMixedSource } from './mixed-required-source-fixture'
export type SourceProfile = Pick<V3Fixture, 'db' | 'userDataRoot'>

/** Deliberately untrusted C syntax referencing real original inputs, with an
 * actual Main B/R cut. No accepted-C producer or semantic Root3 is fabricated. */
export function prepareOriginalReferenceCut(f: SourceProfile, operationId: string) {
  const before = f.db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as { workspace_scope: string; recovery_epoch: string }
  const count = (f.db.prepare("SELECT count(*) AS n FROM app_settings WHERE key LIKE 'synced.recovery.history.v1.%'").get() as { n: number }).n
  const at = new Date(Date.UTC(2057, 2, 4, 5, 6, 7 + count, 8)).toISOString(), recoveryEpoch = randomUUID()
  const request = { operationId, expectedWorkspaceScope: before.workspace_scope, expectedRecoveryEpoch: before.recovery_epoch,
    workspaceScope: before.workspace_scope, recoveryEpoch, documentBoundary: at, acceptedAt: at }
  assert.ok(f.db.transaction(() => advanceSyncedRecoveryEpoch(f.db, request)).immediate())
}
export function addOriginalReferenceSyntax(f: SourceProfile, root: CoverageRootReference) {
  const operationId = root.operationId
  if (!f.db.prepare('SELECT 1 FROM app_settings WHERE key=?').get('synced.recovery.history.v1.' + operationId)) prepareOriginalReferenceCut(f, operationId)
  const boundary = f.db.transaction(() => assertSyncedRecoveryBoundaryRecords(f.db))().boundaries.get(operationId)!
  const epoch = f.db.prepare('SELECT request_hash FROM synced_operations WHERE client_operation_id=?').get('synced:recovery-epoch:v1:' + operationId) as { request_hash: string }
  const coverage = structureFixture().coverage
  insertCoverageSyntax(f.db, tupleFor({ ...coverage, operationId, root, acceptedAt: boundary.acceptedAt,
    target: { workspaceScope: boundary.workspaceScope, recoveryEpoch: boundary.afterEpoch, documentBoundary: boundary.documentBoundary },
    cut: { kind: 'synced-recovery-epoch-cut', version: 1, operationId, workspaceScope: boundary.workspaceScope,
      beforeEpoch: boundary.beforeEpoch, afterEpoch: boundary.afterEpoch, documentBoundary: boundary.documentBoundary, acceptedAt: boundary.acceptedAt,
      boundaryHash: recoveryBoundaryHash(boundary), epochRequestHash: epoch.request_hash } }))
}
export async function sealedReferenceSource(f: SourceProfile, operationId?: string) {
  const original = await captureAssetOriginal(f, operationId), archive = await prepareCapsule2AssetArchive(original.original)
  const actual = await captureSealedCapsule2SourceFromArchive(archive)
  return { original, source: actual.source, actual }
}
export async function nextQualifiedBundle(f: SourceProfile, candidates: readonly { bundle: CompleteOriginalBundle; original: CoverageRootReference }[], current: Pick<Awaited<ReturnType<typeof captureMixedSource>>, 'handle'>, operationId?: string) {
  const sealed = await sealedReferenceSource(f, operationId)
  const parents = requiredReferenceRoots(sealed.actual.value.priorCoverageRequirements).map(root => {
    const found = candidates.find(candidate => candidate.original.operationId === root.operationId && candidate.original.dagId === root.dagId && candidate.original.rootHash === root.rootHash)
    assert.ok(found, 'Every actual original SQL reference has a genuine supplied parent'); return found.bundle
  })
  const saved = await captureQualifiedOriginalBundleFromReferences({ profileRoot: sealed.actual.profileRoot, operationId: sealed.actual.value.operationId,
    dagId: randomUUID(), source: sealed.source, parents, current: current.handle })
  return { ...saved, sealed }
}
