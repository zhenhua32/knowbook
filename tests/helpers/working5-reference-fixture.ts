// Real C-syntax/reference-domain fixture. This prepares original inputs only;
// it never fabricates an accepted-C or final semantic coverage capability.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { capsuleBytesHash } from '../../src/main/database/restore-knowledge-capsule-model'
import { capsule2AssetArchiveOriginalBytes3 } from '../../src/main/database/restore-knowledge-capsule2-asset-archive'
import type { WorkingOriginalsPointer5 } from '../../src/main/database/restore-knowledge-capsule5-working-model'
import { captureSealedCapsule2SourceWithAssetProvenance3 } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import { certifyCapsule2Source } from '../../src/main/database/restore-knowledge-capsule2-source-certificate'
import { captureQualifiedOriginalBundle } from '../../src/main/database/restore-knowledge-qualified-originals'
import type { CompleteOriginalPackage } from '../../src/main/database/restore-knowledge-original-input-types'
import { requiredReferenceRoots } from '../../src/main/database/restore-knowledge-reference-context-model'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import { addOriginalReferenceSyntax } from './qualified-originals-fixture'
import { withSettledWorkingSource5, captureSettledWorkingSource5 } from './working5-settled-source-fixture'

async function prepare(f: Parameters<Parameters<typeof withSettledWorkingSource5>[0]>[0]) {
  const profileRoot = f.original.info.profileRoot, profile = { userDataRoot: profileRoot, db: f.saved.f.B.db }
  const currentOriginal = await captureAssetOriginal(profile), current = await captureSealedCapsule2SourceWithAssetProvenance3(currentOriginal.original)
  const sourceCertificate = await certifyCapsule2Source(f.source), currentCertificate = await certifyCapsule2Source(current.source)
  assert.equal(sourceCertificate.status, 'certified-without-prior-coverage'); assert.equal(currentCertificate.status, 'certified-without-prior-coverage')
  if (sourceCertificate.status !== 'certified-without-prior-coverage' || currentCertificate.status !== 'certified-without-prior-coverage') throw new Error('Two genuine first-generation original sources required')
  const parent = await captureQualifiedOriginalBundle({ profileRoot, operationId: f.sourceInput.operationId, dagId: randomUUID(),
    source: sourceCertificate.source, current: currentCertificate.source })
  assert.equal(parent.value.node.parents.length, 0)
  // The existing helper performs a real Main epoch cut and inserts deliberately
  // untrusted C syntax with that exact boundary and real parent locator.
  addOriginalReferenceSyntax(profile, parent.value.root)
  const next = await captureSettledWorkingSource5(f.saved)
  assert.deepEqual(next.spoolProbeAttempts, [])
  const roots = requiredReferenceRoots(next.value.priorCoverageRequirements)
  assert.equal(roots.length, 1); assert.deepEqual(roots[0], parent.value.root)
  assert.equal(next.value.assetArchive.version, 5)
  if (next.value.assetArchive.version !== 5) throw new Error('Actual next archive5 required')
  assert.deepEqual(next.working.manifest.files, [])
  assert.equal(next.value.assetArchive.coverage.mergedWorkingScopesCaptured, true)
  const sourceManagedBytes = capsule2AssetArchiveOriginalBytes3(next.value.assetArchive)
  const currentManagedBytes = capsule2AssetArchiveOriginalBytes3(current.value.assetArchive)
  const expectedManagedBytes = sourceManagedBytes + currentManagedBytes + parent.value.managedOriginalBytes
  return { f, profileRoot, profile, current, currentCertificate, parent, next, sourceManagedBytes, currentManagedBytes, expectedManagedBytes }
}
export type Working5References = Awaited<ReturnType<typeof prepare>>
export function withWorking5References(run: (value: Working5References) => Promise<void>) {
  return withSettledWorkingSource5(async f => run(await prepare(f)))
}
export async function assertReferenceBaseFiles5(f: Working5References, actual: CompleteOriginalPackage) {
  const sourceArchive = f.next.value.assetArchive, parentArchive = f.f.value.assetArchive
  assert.equal(sourceArchive.version, 5); assert.equal(parentArchive.version, 5)
  if (sourceArchive.version !== 5 || parentArchive.version !== 5) throw new Error('Actual source/parent archive5 required')
  const ownBase = `catalog/backups/database-restore/${f.next.sourceInput.operationId}/knowledge-complete-assets-v2/${f.next.sourceInput.capsuleId}/base-provenance.json`
  const parentBase = `catalog/backups/database-restore/${f.f.sourceInput.operationId}/knowledge-complete-assets-v2/${f.f.sourceInput.capsuleId}/base-provenance.json`
  const own = actual.files.filter(file => !file.frame.length && file.path === ownBase)
  const ancestor = actual.files.filter(file => file.frame.length > 0 && file.path === parentBase)
  assert.equal(own.length, 1); assert.equal(ancestor.length, 1, 'The actual reference context transports the independent parent base original')
  for (const [file, manifest] of [[own[0], sourceArchive.baseProjection], [ancestor[0], parentArchive.baseProjection]] as const) {
    assert.equal(file.bytes, manifest.baseManifestFile.bytes); assert.equal(file.sha256, manifest.baseManifestFile.sha256)
    assert.equal(capsuleBytesHash(await readFile(file.sourcePath)), file.sha256)
  }
  for (const [file, frame] of [[own[0], []], [ancestor[0], ancestor[0].frame]] as const) {
    const contexts = file.path.slice(0, -'base-provenance.json'.length) + 'contexts'
    assert.ok(actual.directories.some(dir => JSON.stringify(dir.frame) === JSON.stringify(frame) && dir.path === contexts), 'Working context directories survive each exact original domain')
    const manifest:WorkingOriginalsPointer5=file===own[0]?sourceArchive.workingOriginals:parentArchive.workingOriginals
    const members=actual.files.filter(value=>JSON.stringify(value.frame)===JSON.stringify(frame)&&value.path.startsWith(contexts+'/'))
    assert.equal(members.length,1,'The settled working index is a real original even without binary captures')
    assert.equal(members[0].path,contexts+'/manifest.json');assert.equal(members[0].bytes,manifest.manifestFile.bytes);assert.equal(members[0].sha256,manifest.manifestFile.sha256)
    assert.equal(capsuleBytesHash(await readFile(members[0].sourcePath)),manifest.manifestFile.sha256)
    assert.ok(actual.directories.some(dir=>JSON.stringify(dir.frame)===JSON.stringify(frame)&&dir.path===contexts+'/files'))
  }
  assert.equal(actual.original.managedOriginalBytes, f.expectedManagedBytes)
}
