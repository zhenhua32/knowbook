import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { reopenPreparedRawCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-files'
import { parseCapsule2CompleteAssetArchiveManifest, reopenCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { readSealedCapsule2SourceInputs } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { withSettledContext4 } from './helpers/settled-context4-fixture'

test('archive4 pointer syntax never substitutes for actual base file raw bytes material and domain hashes during genuine cold owner creation',
  { concurrency: false }, () => withSettledContext4(async f => {
    const archive = f.value.assetArchive
    assert.equal(archive.version, 4); if (archive.version !== 4) throw new Error('Actual archive4 required')
    const path = join(f.original.info.recoveryDirectory, 'knowledge-complete-assets-v2', f.sourceInput.capsuleId, 'manifest.json')
    const before = await readFile(path), originalText = before.toString(), originalHash = f.value.assetArchiveHash
    assert.deepEqual(parseCapsule2CompleteAssetArchiveManifest(originalText, archive.capsuleId, originalHash), archive)
    const flip = (value: string) => (value[0] === '0' ? '1' : '0') + value.slice(1)
    for (const attack of ['raw-sha','raw-bytes','material-hash','settled-binding'] as const) {
      const changed = JSON.parse(originalText)
      if (attack === 'raw-sha') changed.baseProjection.baseManifestFile.sha256 = flip(changed.baseProjection.baseManifestFile.sha256)
      if (attack === 'raw-bytes') changed.baseProjection.baseManifestFile.bytes++
      if (attack === 'material-hash') changed.baseProjection.baseMaterialHash = flip(changed.baseProjection.baseMaterialHash)
      if (attack === 'settled-binding') {
        assert.ok(changed.contextOriginals.settledBindings.length > 0)
        changed.contextOriginals.settledBindings[0].bindingHash = flip(changed.contextOriginals.settledBindings[0].bindingHash)
        const { inventoryHash: _old, ...body } = changed.contextOriginals
        changed.contextOriginals.inventoryHash = capsuleBytesHash('knowbook.capsule4.source-merge-context-inventory.v3\0' + capsuleJson(body))
      }
      const text = capsuleJson(changed) + '\n', hash = capsuleBytesHash('knowbook.capsule2.complete-asset-archive.v4\0' + capsuleJson(changed))
      // This checks shape and exact archive bytes only; it deliberately cannot
      // certify an opaque pointer against a file it has never opened.
      const parsed = parseCapsule2CompleteAssetArchiveManifest(text, archive.capsuleId, hash)
      assert.equal(parsed.version, 4)
      const original = await reopenPreparedRawCapsuleOriginal({ profileRoot: f.sourceInput.profileRoot,
        operationId: f.sourceInput.operationId, capsuleId: f.sourceInput.capsuleId, expectedInventory: f.original.inventory })
      try {
        await writeFile(path, text)
        await assert.rejects(reopenCapsule2AssetArchive(original, hash), attack === 'settled-binding' ? /inventory不是同次genuine base\/settled分区/ : /实际base文件raw SHA\/bytes/,
          'A rehashed archive pointer must match the actual separately captured base file before minting')
      } finally { await writeFile(path, before) }
    }
    const extra = JSON.parse(originalText); extra.baseProjection.referenceProvenance = {}
    assert.throws(() => parseCapsule2CompleteAssetArchiveManifest(capsuleJson(extra) + '\n', archive.capsuleId,
      capsuleBytesHash('knowbook.capsule2.complete-asset-archive.v4\0' + capsuleJson(extra))))
    const unknown = JSON.parse(originalText); unknown.version = 5
    assert.throws(() => parseCapsule2CompleteAssetArchiveManifest(capsuleJson(unknown) + '\n', archive.capsuleId, originalHash))
    const tail = await readSealedCapsule2SourceInputs(f.source)
    assert.equal(tail.value.assetArchiveHash, originalHash); assert.equal(tail.value.materialHash, f.value.materialHash)
    assert.equal(tail.value.assetArchive.permit, false)
  }))
