import assert from 'node:assert/strict'
import test from 'node:test'
import { withSettledWorkingSource5 } from './helpers/working5-automatic-source-fixture'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { withoutSettledSpoolProbes4 } from './helpers/settled-context4-fixture'
import { captureSealedCapsule2SourceWithSettledContextProvenance4, readSealedCapsule2SourceWorkingOriginals5 } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { parseCapsule2CompleteAssetArchiveManifest } from '../src/main/database/restore-knowledge-capsule2-asset-archive'

test('the published source4 factory retains its custom-only selector and original hash grammar beside explicit all-merge source5',
  { concurrency: false }, () => withSettledWorkingSource5(async f => {
    const original = await captureAssetOriginal({ userDataRoot: f.f.B.root, db: f.f.B.db })
    const guarded = await withoutSettledSpoolProbes4(f.spools, () => captureSealedCapsule2SourceWithSettledContextProvenance4(original.original))
    assert.deepEqual(guarded.attempts, [])
    const old = guarded.value, archive = old.value.assetArchive; assert.equal(archive.version, 4)
    if (archive.version !== 4) throw new Error('The published source4 factory must retain archive4')
    assert.equal(archive.contextOriginals.captures.some(item => item.jobSettingKey === f.row.key), false)
    assert.equal(archive.contextOriginals.settledBindings.some(item => item.jobSettingKey === f.row.key), false)
    assert.equal(archive.assetScopeSupplement.version, 2)
    assert.equal(await readSealedCapsule2SourceWorkingOriginals5(old.source), undefined)
    const hash = capsuleBytesHash('knowbook.capsule2.complete-asset-archive.v4\0' + capsuleJson(archive))
    assert.equal(hash, old.value.assetArchiveHash)
    assert.deepEqual(parseCapsule2CompleteAssetArchiveManifest(capsuleJson(archive) + '\n', archive.capsuleId, hash), archive)
    const forged = { ...archive, workingOriginals: f.working.pointer }
    const forgedHash = capsuleBytesHash('knowbook.capsule2.complete-asset-archive.v4\0' + capsuleJson(forged))
    assert.throws(() => parseCapsule2CompleteAssetArchiveManifest(capsuleJson(forged) + '\n', archive.capsuleId, forgedHash),
      'Re-signing cannot silently add a Working5 field to the strict released archive4 grammar')
    assert.ok(f.working.manifest.settledBindings.some(item => item.jobSettingKey === f.row.key))
    assert.equal(archive.coverage.allAssetScopesCaptured, false)
  }))
