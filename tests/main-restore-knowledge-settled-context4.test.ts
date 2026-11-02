import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { capsuleBytesHash } from '../src/main/database/restore-knowledge-capsule-model'
import { capsule2AssetArchiveOriginalBytes3 } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { readCapsule2BaseProjection4, assertCapsule2BaseProjectionOriginal4 } from '../src/main/database/restore-knowledge-capsule2-base-projection4'
import { prepareCapsule2MergeContextOriginals4, type Capsule2MergeContextInventory4 } from '../src/main/database/restore-knowledge-capsule2-merge-contexts4'
import { createRootRestoreSupplementalAssetObserver4 } from '../src/main/database/restore-knowledge-assets4-supplement'
import { describeCapsule2AssetScopeSupplement4 } from '../src/main/database/restore-knowledge-capsule2-asset-supplement4-model'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { withSettledContext4 } from './helpers/settled-context4-fixture'

test('explicit archive4 seals the complete genuine settled document and group W before any retired spool probe and binds every supplemental holder to base originals',
  () => withSettledContext4(async fixture => {
    const archive = fixture.value.assetArchive
    assert.equal(archive.version, 4)
    if (archive.version !== 4) throw new Error('Actual explicit archive4 required')
    assert.deepEqual(fixture.spoolProbeAttempts, [])
    assert.equal(archive.coverage.supplementalCustomMergeScopesCaptured, true)
    assert.equal(archive.contextOriginals.captures.length, 0)
    assert.equal(archive.contextOriginals.files.length, 0)
    assert.equal(archive.contextOriginals.settledBindings.length, fixture.saved.jobs.length)
    const directory = join(fixture.original.info.recoveryDirectory, 'knowledge-complete-assets-v2', fixture.value.capsuleId)
    assert.deepEqual(await readdir(join(directory, 'contexts')), [])
    const baseBytes = await readFile(join(directory, 'base-provenance.json'))
    assert.equal(baseBytes.length, archive.baseProjection.baseManifestFile.bytes)
    assert.equal(capsuleBytesHash(baseBytes), archive.baseProjection.baseManifestFile.sha256)
    assert.equal(capsule2AssetArchiveOriginalBytes3(archive), archive.tree.files.reduce((n, file) => n + file.bytes, 0)
      + archive.contextOriginals.files.reduce((n, file) => n + file.bytes, 0) + baseBytes.length)
    const base = await fixture.readBase()
    assertCapsule2BaseProjectionOriginal4(base.owner, base.original)
    assert.throws(() => assertCapsule2BaseProjectionOriginal4(base.owner, fixture.original.original),
      'An independent genuine Original with identical bytes is still a different registry identity')
    await assert.rejects(Reflect.apply(readCapsule2BaseProjection4, undefined, [structuredClone(base.owner)]))
    await assert.rejects(Reflect.apply(prepareCapsule2MergeContextOriginals4, undefined,
      [fixture.original.original, { ...base.owner, skipJobs: fixture.saved.jobs.map(job => job.row.key) }]),
    'A caller skip list or cloned owner cannot decide which original spools are required')
    assert.deepEqual(base.value.sourceContent, fixture.value.source.sourceContent)
    assert.equal(base.value.settledEvidence.evidenceHash, archive.contextOriginals.settledEvidenceHash)
    for (const job of fixture.saved.jobs) {
      const actual = base.value.settledEvidence.jobs.find(value => value.jobSettingKey === job.row.key); assert.ok(actual)
      const retained: Capsule2MergeContextInventory4['settledBindings'][number] | undefined = archive.contextOriginals.settledBindings.find(value => value.jobSettingKey === job.row.key); assert.ok(retained)
      assert.equal(actual.contextHash, retained.contextHash)
      for (const item of actual.merged) {
        const expected = fixture.expectedRecords.get(item.recordKey); assert.ok(expected)
        assert.deepEqual(Buffer.from(publicationJson(item.record)), Buffer.from(publicationJson(expected)))
        assert.equal(publicationHash(publicationJson(item.record)), item.provenance.resultHash)
      }
    }
    // This pure observer receives only a fresh genuine owner read. Its exact
    // recomputation must match the already sealed archive4 descriptor.
    const observed = createRootRestoreSupplementalAssetObserver4(base.value).finish()
    assert.deepEqual(describeCapsule2AssetScopeSupplement4(observed), archive.assetScopeSupplement)
    assert.deepEqual(observed.unsupportedHolders, [])
    for (const original of fixture.saved.jobs) {
      const holders = observed.holders.filter(value => value.jobHash === publicationHash(publicationJson(original.job)))
      assert.ok(holders.some(value => value.source[0] === 'app_settings' && value.source[1] === original.row.key))
      assert.ok(holders.some(value => value.source[0] === 'synced_operations' && value.source[1] === original.job.request.operationId))
    }
    assert.ok(observed.settledPortableBindings.length > 0)
    for (const binding of observed.settledPortableBindings) {
      const scope = observed.scopes.find(value => publicationJson(value.source) === publicationJson(binding.scopeSource)); assert.ok(scope)
      assert.ok(scope.destinations.some(value => value.section === binding.section && value.from === binding.from && value.to === binding.to && value.uri === binding.portableUri))
      assert.equal(binding.baseManifestHash, archive.baseProjection.baseManifestHash)
      assert.equal(binding.settledEvidenceHash, archive.contextOriginals.settledEvidenceHash)
      assert.equal(base.value.baseProof.entries[binding.baseReferenceIndex][2], binding.aliasIndex)
      assert.equal(base.value.tree.aliases[binding.aliasIndex].hash, binding.hash)
      assert.equal(base.value.tree.aliases[binding.aliasIndex].name, binding.physicalName)
    }
    for (const gate of [archive.coverage.allAssetScopesCaptured, archive.coverage.semanticSelectionPermission,
      archive.coverage.finalAssetClosureComplete, archive.coverage.acceptedCoverage, archive.coverage.effective, archive.coverage.installPermit,
      base.value.settledEvidence.spoolSkipPermission, base.value.settledEvidence.installPermit]) assert.equal(gate, false)
  }, { group: true }))
