// REVIEW DRAFT. No owner/value packet crosses the process boundary.
;(async () => {
  const assert = require('node:assert/strict')
  const { captureReopenedSealedCapsule2Source, readSealedCapsule2Source, readSealedCapsule2SourceMaterial } = await import('../../src/main/database/restore-knowledge-capsule2-source-seal.ts')
  const { capsule2AssetReferenceProvenance2Hash } = await import('../../src/main/database/restore-knowledge-capsule2-asset-provenance.ts')
  const captured = await captureReopenedSealedCapsule2Source(JSON.parse(process.argv[2]))
  const info = await readSealedCapsule2Source(captured.source), value = await readSealedCapsule2SourceMaterial(captured.source), archive = value.assetArchive
  assert.equal(archive.version, 3)
  assert.equal(archive.referenceProvenance.version, 2); assert.equal(archive.contextOriginals.version, 2)
  assert.equal(archive.contextOriginals.captures.length, 1); assert.equal(archive.contextOriginals.captures[0].state, 'captured')
  assert.equal(archive.assetScopeSupplement.unsupportedHolders.count, 0)
  assert.equal(archive.coverage.supplementalCustomMergeScopesCaptured, true)
  assert.equal(archive.coverage.allAssetScopesCaptured, false)
  assert.equal(archive.coverage.finalAssetClosureComplete, false); assert.equal(archive.coverage.installPermit, false)
  assert.equal(archive.permit, false); assert.equal(captured.value.materialHash, value.materialHash)
  process.stdout.write(JSON.stringify({ pid: process.pid, materialHash: value.materialHash, sourceManifestHash: info.manifestHash,
    assetArchiveHash: value.assetArchiveHash, provenanceHash: capsule2AssetReferenceProvenance2Hash(archive.referenceProvenance),
    contextInventoryHash: archive.contextOriginals.inventoryHash, supplementalObservationHash: archive.assetScopeSupplement.observationHash,
    contextFiles: archive.contextOriginals.files, coverage: archive.coverage }))
})().catch(error => { console.error(error); process.exitCode = 1 })
