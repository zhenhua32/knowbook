// Strict version/factory boundaries using actual native originals.
import assert from 'node:assert/strict'
import test from 'node:test'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { prepareCapsule2AssetArchive, prepareCapsule2AssetArchiveWithProvenance3, readCapsule2AssetArchive,
  parseCapsule2CompleteAssetArchiveManifest } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { captureSealedCapsule2SourceWithContextProvenance3, readSealedCapsule2SourceMaterial } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { withV3Fixture, allTables } from './helpers/synced-backup-v3-fixture'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'

test('explicit genuine archive3 factory never upgrades existing archive1 or base archive2 bytes proof versions or coverage',
  { concurrency: false }, () => withV3Fixture(async f => {
    const [asset] = await f.assets.import([{ name: 'actual-version-boundary.png', bytes: Buffer.from('native version boundary bytes') }])
    const id = f.store.createDocument(null)
    f.store.updateDocument(id, { title: 'Strict producer versions', summary: `![real](<${asset.url}>)`, blocks: [] })
    const sourceSql = allTables(f.db)
    const firstOriginal = await captureAssetOriginal(f), firstOwner = await prepareCapsule2AssetArchive(firstOriginal.original), first = await readCapsule2AssetArchive(firstOwner)
    const secondOriginal = await captureAssetOriginal(f), secondOwner = await prepareCapsule2AssetArchiveWithProvenance3(secondOriginal.original), second = await readCapsule2AssetArchive(secondOwner)
    assert.equal(first.manifest.version, 1); assert.equal(second.manifest.version, 2)
    if (first.manifest.version !== 1 || second.manifest.version !== 2) throw new Error('Real old producer factories retain their original formats')
    const firstCanonical = capsuleJson(first.manifest), secondCanonical = capsuleJson(second.manifest)
    assert.equal('coverage' in first.manifest, false); assert.equal('referenceProvenance' in first.manifest, false)
    assert.equal(second.manifest.referenceProvenance.version, 1)
    assert.equal(second.manifest.coverage.supplementalCustomMergeScopesCaptured, false)
    assert.equal('assetScopeSupplement' in second.manifest, false); assert.equal('contextOriginals' in second.manifest, false)
    const thirdOriginal = await captureAssetOriginal(f), third = await captureSealedCapsule2SourceWithContextProvenance3(thirdOriginal.original)
    const value = await readSealedCapsule2SourceMaterial(third.source), archive = value.assetArchive
    assert.equal(archive.version, 3)
    if (archive.version !== 3) throw new Error('Only explicit new factory selects archive3')
    assert.equal(archive.referenceProvenance.version, 2); assert.equal(archive.contextOriginals.version, 2)
    assert.deepEqual(archive.contextOriginals.captures, []); assert.deepEqual(archive.contextOriginals.files, [])
    assert.equal(archive.assetScopeSupplement.scopeCount, 0); assert.equal(archive.assetScopeSupplement.unsupportedHolders.count, 0)
    assert.equal(archive.coverage.allAssetScopesCaptured, false); assert.equal(archive.coverage.finalAssetClosureComplete, false)
    assert.equal(archive.coverage.installPermit, false); assert.equal(archive.permit, false)
    const firstAgain = await readCapsule2AssetArchive(firstOwner), secondAgain = await readCapsule2AssetArchive(secondOwner)
    assert.equal(capsuleJson(firstAgain.manifest), firstCanonical); assert.equal(firstAgain.manifestHash, first.manifestHash)
    assert.equal(capsuleJson(secondAgain.manifest), secondCanonical); assert.equal(secondAgain.manifestHash, second.manifestHash)
    // Even a recomputed valid outer hash cannot smuggle new-version fields
    // into a strict old grammar. This is codec input, never an owner DTO.
    const illegalOld = { ...first.manifest, coverage: archive.coverage, contextOriginals: archive.contextOriginals }
    const illegalBase = { ...second.manifest, contextOriginals: archive.contextOriginals, assetScopeSupplement: archive.assetScopeSupplement }
    assert.throws(() => parseCapsule2CompleteAssetArchiveManifest(capsuleJson(illegalOld) + '\n', first.manifest.capsuleId,
      capsuleBytesHash('knowbook.capsule2.complete-asset-archive.v1\0' + capsuleJson(illegalOld))))
    assert.throws(() => parseCapsule2CompleteAssetArchiveManifest(capsuleJson(illegalBase) + '\n', second.manifest.capsuleId,
      capsuleBytesHash('knowbook.capsule2.complete-asset-archive.v2\0' + capsuleJson(illegalBase))))
    assert.deepEqual(allTables(f.db), sourceSql)
    assert.equal(third.info.manifest.sourceMaterialHash, value.materialHash)
  }))
