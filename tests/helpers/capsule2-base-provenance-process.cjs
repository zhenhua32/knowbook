// REVIEW DRAFT. Independent Electron-as-Node process; no owner/DTO crosses
// process boundaries. The only input is the persisted source locator.
;(async () => {
  const assert = require('node:assert/strict')
  const { captureReopenedSealedCapsule2Source, readSealedCapsule2Source, readSealedCapsule2SourceMaterial } = await import('../../src/main/database/restore-knowledge-capsule2-source-seal.ts')
  const { capsule2AssetReferenceProvenanceHash } = await import('../../src/main/database/restore-knowledge-capsule2-asset-provenance.ts')
  const captured = await captureReopenedSealedCapsule2Source(JSON.parse(process.argv[2])), owner = captured.source
  const info = await readSealedCapsule2Source(owner), value = await readSealedCapsule2SourceMaterial(owner)
  assert.equal(captured.value.materialHash, value.materialHash)
  assert.equal(value.assetArchive.version, 2)
  assert.equal(value.assetArchive.coverage.baseTypedScopesCaptured, true)
  assert.equal(value.assetArchive.coverage.supplementalCustomMergeScopesCaptured, false)
  assert.equal(value.assetArchive.coverage.allAssetScopesCaptured, false)
  assert.equal(value.assetArchive.coverage.installPermit, false)
  assert.equal(value.assetArchive.permit, false)
  process.stdout.write(JSON.stringify({ pid: process.pid, materialHash: value.materialHash, sourceManifestHash: info.manifestHash,
    assetArchiveHash: value.assetArchiveHash, provenanceHash: capsule2AssetReferenceProvenanceHash(value.assetArchive.referenceProvenance),
    coverage: value.assetArchive.coverage, installPermit: value.assetArchive.coverage.installPermit }))
})().catch(error => { console.error(error); process.exitCode = 1 })
