import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { certifyCapsule2Source } from '../../src/main/database/restore-knowledge-capsule2-source-certificate'
import { captureSealedCapsule2SourceWithAssetProvenance3 } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import { withPreparedRootKnowledgeInputs5, type captureRootKnowledgeConservationPlanFromCertifiedSources3 } from '../../src/main/database/restore-knowledge-root3-read'
import { withPreparedRootRestoreIdentityInputs5, type PreparedRootIdentityInputs5,
  type prepareRootRestoreIdentityPlan3 } from '../../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3 } from '../../src/main/database/restore-knowledge-reference3-read'
import { prepareRootRestoreWorkingAssetAuthority5 } from '../../src/main/database/restore-knowledge-working-asset-authority5'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import type { withPendingWorkingSource5 } from './working5-automatic-source-fixture'

type PendingFixture = Parameters<Parameters<typeof withPendingWorkingSource5>[0]>[0]
type WorkingFixture = Pick<PendingFixture, 'f' | 'original' | 'sourceInput' | 'digest' | 'source'>
type FixtureReference = {
  reference: Awaited<ReturnType<typeof prepareRootRestoreReferencePlan3>>
  qualified: Awaited<ReturnType<typeof captureRootKnowledgeConservationPlanFromCertifiedSources3>>
  current: Awaited<ReturnType<typeof captureSealedCapsule2SourceWithAssetProvenance3>>
  identity: Awaited<ReturnType<typeof prepareRootRestoreIdentityPlan3>>
}

export async function prepareWorking5AssetReferenceFixture(f: WorkingFixture, currentDb: Database.Database = f.f.B.db,
  phase?: (name: string) => void) {
  return withWorking5AssetReferenceFixture(f, currentDb, async inputs => inputs, phase)
}

export async function withWorking5AssetReferenceFixture<T>(f: WorkingFixture, currentDb: Database.Database,
  run: (inputs: FixtureReference, identityScope: PreparedRootIdentityInputs5) => Promise<T>, phase?: (name: string) => void) {
  const profileRoot = f.original.info.profileRoot, operationId = f.sourceInput.operationId
  // Capture after the real exchange has completed. The old-format current
  // owns actual files (including the same hash); it cannot supply a W scope.
  phase?.('base-current-capture-start')
  const original = await captureAssetOriginal({ userDataRoot: profileRoot, db: currentDb })
  phase?.('base-current-original-captured')
  const current = await captureSealedCapsule2SourceWithAssetProvenance3(original.original)
  phase?.('base-current-source-sealed')
  assert.equal(current.value.assetArchive.version, 2)
  assert.ok(current.value.assetArchive.tree.files.some(file => file.hash === f.digest))
  const sourceCertificate = await certifyCapsule2Source(f.source)
  phase?.('base-source-certified')
  const currentCertificate = await certifyCapsule2Source(current.source)
  phase?.('base-current-certified')
  if (sourceCertificate.status !== 'certified-without-prior-coverage' || currentCertificate.status !== 'certified-without-prior-coverage')
    throw new Error('The real archive5 source and v2 current must have actual certificates')
  return withPreparedRootKnowledgeInputs5({ profileRoot, operationId, dagId: randomUUID(),
    source: sourceCertificate.source, current: currentCertificate.source }, (qualified, scope) => {
    phase?.('base-qualified-capture-and-knowledge-prepared')
    return withPreparedRootRestoreIdentityInputs5(qualified.knowledgePlan, scope, undefined, async (identity, identityScope) => {
      phase?.('base-identity-prepared')
      const reference = await prepareRootRestoreReferencePlan3(identity.plan, { originPolicy: 'isolate-incoming', anonymousValues: 'source' }, identityScope)
      phase?.('base-reference-plan-prepared')
      return run({ reference, qualified, current, identity }, identityScope)
    })
  })
}

export async function prepareWorking5AssetAuthorityFixture(f: WorkingFixture) {
  const inputs = await prepareWorking5AssetReferenceFixture(f)
  return { ...await prepareRootRestoreWorkingAssetAuthority5(inputs.reference.plan), ...inputs }
}
