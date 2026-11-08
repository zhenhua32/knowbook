import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { captureQualifiedOriginalBundle } from '../../src/main/database/restore-knowledge-qualified-originals'
import { certifyCapsule2Source } from '../../src/main/database/restore-knowledge-capsule2-source-certificate'
import { captureSealedCapsule2SourceWithAssetProvenance3 } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import { prepareRootKnowledgeConservationPlan3 } from '../../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreIdentityPlan3 } from '../../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3 } from '../../src/main/database/restore-knowledge-reference3-read'
import { prepareRootRestoreWorkingAssetAuthority5 } from '../../src/main/database/restore-knowledge-working-asset-authority5'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import type { withPendingWorkingSource5 } from './working5-automatic-source-fixture'

type PendingFixture = Parameters<Parameters<typeof withPendingWorkingSource5>[0]>[0]
type WorkingFixture = Pick<PendingFixture, 'f' | 'original' | 'sourceInput' | 'digest' | 'source'>

export async function prepareWorking5AssetReferenceFixture(f: WorkingFixture, currentDb: Database.Database = f.f.B.db) {
  const profileRoot = f.original.info.profileRoot, operationId = f.sourceInput.operationId
  // Capture after the real exchange has completed. The old-format current
  // owns actual files (including the same hash); it cannot supply a W scope.
  const original = await captureAssetOriginal({ userDataRoot: profileRoot, db: currentDb })
  const current = await captureSealedCapsule2SourceWithAssetProvenance3(original.original)
  assert.equal(current.value.assetArchive.version, 2)
  assert.ok(current.value.assetArchive.tree.files.some(file => file.hash === f.digest))
  const sourceCertificate = await certifyCapsule2Source(f.source), currentCertificate = await certifyCapsule2Source(current.source)
  if (sourceCertificate.status !== 'certified-without-prior-coverage' || currentCertificate.status !== 'certified-without-prior-coverage')
    throw new Error('The real archive5 source and v2 current must have actual certificates')
  const qualified = await captureQualifiedOriginalBundle({ profileRoot, operationId, dagId: randomUUID(),
    source: sourceCertificate.source, current: currentCertificate.source })
  const knowledge = await prepareRootKnowledgeConservationPlan3(qualified.bundle)
  const identity = await prepareRootRestoreIdentityPlan3(knowledge.plan)
  const reference = await prepareRootRestoreReferencePlan3(identity.plan, { originPolicy: 'isolate-incoming', anonymousValues: 'source' })
  return { reference, qualified, current, identity }
}

export async function prepareWorking5AssetAuthorityFixture(f: WorkingFixture) {
  const inputs = await prepareWorking5AssetReferenceFixture(f)
  return { ...await prepareRootRestoreWorkingAssetAuthority5(inputs.reference.plan), ...inputs }
}
