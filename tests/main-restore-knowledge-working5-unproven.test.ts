import assert from 'node:assert/strict'
import test from 'node:test'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { request, applySyncedHostFinal } from './helpers/synced-exchange-conflict-fixture'
import { proveContext4NativeSpoolRoots, proveContext4ObservedMissingSpool } from './helpers/settled-context4-native-spool-evidence'
import { withoutSettledSpoolProbes4 } from './helpers/settled-context4-fixture'
import { withSettledWorkingSource5 } from './helpers/working5-automatic-source-fixture'
import { prepareCapsule2AssetArchiveWithWorkingProvenance5, readCapsule2ArchiveWorkingOriginals5 } from '../src/main/database/restore-knowledge-capsule2-asset-archive'

test('a real later noncustom summary edit cannot make the retired automatic job skip its missing original context',
  { concurrency: false }, () => withSettledWorkingSource5(async f => {
    const edit = request(f.f.B.db, [f.documentId], sides => { sides[0].summary += '\nActual later noncustom full-W change' })
    assert.equal(applySyncedHostFinal(f.f.B.db, edit).status, 'applied')
    const original = await captureAssetOriginal({ userDataRoot: f.f.B.root, db: f.f.B.db })
    const roots = await proveContext4NativeSpoolRoots(f.f.B.root, original.info.profileRoot), names = roots.spools(f.operationId, f.job.attemptId)
    const observed = await withoutSettledSpoolProbes4([], () => prepareCapsule2AssetArchiveWithWorkingProvenance5(original.original), names.aliases)
    await proveContext4ObservedMissingSpool(roots, f.operationId, f.job.attemptId, observed.observations)
    const working = await readCapsule2ArchiveWorkingOriginals5(observed.value); assert.ok(working)
    assert.equal(working.manifest.settledBindings.some(item => item.jobSettingKey === f.row.key), false)
    const missing = working.manifest.captures.find(item => item.jobSettingKey === f.row.key); assert.ok(missing)
    assert.equal(missing.state, 'unavailable')
    if (missing.state !== 'unavailable') throw new Error('The actually missing originals remain unavailable')
    assert.ok(missing.missingFiles.includes('spool'))
    const unsupported = working.observation.unsupportedHolders.filter(item => item.jobSettingKey === f.row.key)
    assert.equal(unsupported.length, 2); assert.ok(unsupported.some(item => item.source.includes('app_settings')))
    assert.ok(unsupported.some(item => item.source.includes('synced_operations')))
    assert.equal(working.observation.mergeWorkingScopesCaptured, false)
    assert.equal(working.manifest.allAssetScopesCaptured, false); assert.equal(working.manifest.installPermit, false)
  }))
