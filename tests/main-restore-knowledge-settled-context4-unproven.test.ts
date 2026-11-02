import assert from 'node:assert/strict'
import test from 'node:test'
import { basename, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { withSettledPortable3 } from './helpers/settled-portable-owner-fixture'
import { withoutSettledSpoolProbes4 } from './helpers/settled-context4-fixture'
import { proveContext4NativeSpoolRoots, proveContext4ObservedMissingSpool } from './helpers/settled-context4-native-spool-evidence'
import { request, applySyncedHostFinal } from './helpers/synced-exchange-conflict-fixture'
import { materializeSyncedExchangeLocal, readSyncedExchangeLocalMaterial } from '../src/main/sync/synced-publication'
import { publicationHash, publicationJson, publicationRecordKey } from '../src/main/sync/synced-publication-model'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { reopenPreparedRawCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-files'
import { prepareCapsule2AssetArchiveWithSettledContextProvenance4, readCapsule2ArchiveSourceInputs,
  readCapsule2ArchiveBaseProjection4, parseCapsule2CompleteAssetArchiveManifest, reopenCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'

test('a legitimate noncustom host edit leaves the old settled job unproved so archive4 observes its missing spool and keeps both original holders unsupported',
  { concurrency: false }, context => withSettledPortable3(async saved => {
    const key = 'doc:' + saved.documentId, original = saved.oracleRecords.get(key); assert.ok(original?.kind === 'document')
    const merge = saved.documentJob.job.merges!.find(value => value.key === key); assert.ok(merge)
    assert.equal(publicationHash(publicationJson(original)), merge.resultHash)
    const edit = request(saved.f.B.db, [saved.documentId], sides => {
      sides[0].summary += '\nLegitimate later noncustom summary; the previous complete W is not this current record.'
    })
    assert.equal(applySyncedHostFinal(saved.f.B.db, edit).status, 'applied')
    const actualHandle = await materializeSyncedExchangeLocal(saved.f.B.db, { userDataRoot: saved.f.B.root, target: saved.f.targetConfig })
    const actual = readSyncedExchangeLocalMaterial(actualHandle); assert.ok(actual)
    const current = actual.records.find(value => publicationRecordKey(value) === key); assert.ok(current)
    assert.notEqual(publicationHash(publicationJson(current)), merge.resultHash)
    const jobRow = saved.f.B.db.prepare('SELECT value FROM app_settings WHERE key=?').get(saved.documentJob.row.key) as { value: string }
    const receiptRow = saved.f.B.db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(saved.documentJob.job.request.operationId) as { result_json: string }
    assert.equal(jobRow.value, saved.documentJob.row.value); assert.equal(receiptRow.result_json, saved.documentJob.receiptRow.result_json)
    const originalCapsule = await captureAssetOriginal({ userDataRoot: saved.f.B.root, db: saved.f.B.db })
    const spool = join(saved.f.B.root, 'storage', 'synced-exchanges-v1', saved.documentJob.job.request.operationId, saved.documentJob.job.attemptId)
    const roots = await proveContext4NativeSpoolRoots(saved.f.B.root, originalCapsule.info.profileRoot)
    const spoolNames = roots.spools(saved.documentJob.job.request.operationId, saved.documentJob.job.attemptId)
    assert.equal(spoolNames.literal, spool)
    // Observe the real missing lookup. No hook supplies fake ENOENT, bytes,
    // job choices or a completed receipt to the new producer.
    const observed = await withoutSettledSpoolProbes4([], () => prepareCapsule2AssetArchiveWithSettledContextProvenance4(originalCapsule.original), spoolNames.aliases)
    assert.ok(observed.observations.length > 0, 'Unproved whole W must remain in the exact retired spool locator set observed by the native FS hook')
    const nativeSpool = await proveContext4ObservedMissingSpool(roots, saved.documentJob.job.request.operationId, saved.documentJob.job.attemptId, observed.observations)
    context.diagnostic(JSON.stringify({ nativeSpoolRootIdentity: roots.anchor, literalProfileRoot: roots.literalProfileRoot,
      canonicalProfileRoot: roots.canonicalProfileRoot, missingOriginal: nativeSpool }))
    const inputs = await readCapsule2ArchiveSourceInputs(observed.value), archive = inputs.value.manifest, supplement = inputs.supplemental
    assert.equal(archive.version, 4)
    if (archive.version !== 4 || !supplement || supplement.version !== 2) throw new Error('Actual archive4 observer2 required')
    const base = await readCapsule2ArchiveBaseProjection4(observed.value)
    assert.equal(base.settledEvidence.jobs.some(value => value.jobSettingKey === saved.documentJob.row.key), false)
    assert.ok(base.settledEvidence.notProven.some(value => value.jobSettingKey === saved.documentJob.row.key))
    assert.equal(archive.contextOriginals.settledBindings.some(value => value.jobSettingKey === saved.documentJob.row.key), false)
    const unavailable = archive.contextOriginals.captures.find(value => value.jobSettingKey === saved.documentJob.row.key); assert.ok(unavailable)
    assert.equal(unavailable.state, 'unavailable')
    if (unavailable.state !== 'unavailable') throw new Error('The truly retired spool is unavailable')
    assert.equal(unavailable.reason, 'missing-original-context'); assert.ok(unavailable.missingFiles.includes('spool'))
    const unsupported = supplement.unsupportedHolders.filter(value => value.operationId === saved.documentJob.job.request.operationId)
    assert.equal(unsupported.length, 2)
    assert.ok(unsupported.some(value => value.source[0] === 'app_settings' && value.source[1] === saved.documentJob.row.key))
    assert.ok(unsupported.some(value => value.source[0] === 'synced_operations' && value.source[1] === saved.documentJob.job.request.operationId))
    assert.ok(unsupported.every(value => value.reason === 'genuine-original-merge-context-unavailable'))
    assert.equal(supplement.holders.some(value => value.source[0] === 'app_settings' && value.source[1] === saved.documentJob.row.key), false)
    assert.equal(archive.coverage.supplementalCustomMergeScopesCaptured, false)
    assert.equal(archive.coverage.allAssetScopesCaptured, false); assert.equal(archive.coverage.acceptedCoverage, false)
    assert.equal(archive.coverage.effective, false); assert.equal(archive.coverage.installPermit, false)
    // Re-sign both enclosing contracts. The pure codec may accept this closed
    // shape, but a genuine cold read must reconstruct the real unproved
    // partition and reject a caller's attempted replacement with a skip row.
    const forged = JSON.parse(capsuleJson(archive)), { state: _state, reason: _reason, missingFiles: _missing, fileHashes: _files, ...locator } = unavailable
    forged.contextOriginals.captures = forged.contextOriginals.captures.filter((value: {jobSettingKey: string}) => value.jobSettingKey !== unavailable.jobSettingKey)
    forged.contextOriginals.settledBindings.push({ ...locator, contextHash: '0'.repeat(64), bindingHash: '0'.repeat(64) })
    forged.contextOriginals.settledBindings.sort((a: {jobSettingKey: string}, b: {jobSettingKey: string}) => a.jobSettingKey < b.jobSettingKey ? -1 : a.jobSettingKey > b.jobSettingKey ? 1 : 0)
    const { inventoryHash: _inventory, ...body } = forged.contextOriginals
    forged.contextOriginals.inventoryHash = capsuleBytesHash('knowbook.capsule4.source-merge-context-inventory.v3\0' + capsuleJson(body))
    const text = capsuleJson(forged) + '\n', hash = capsuleBytesHash('knowbook.capsule2.complete-asset-archive.v4\0' + capsuleJson(forged))
    assert.equal(parseCapsule2CompleteAssetArchiveManifest(text, archive.capsuleId, hash).version, 4)
    const fresh = await reopenPreparedRawCapsuleOriginal({ profileRoot: originalCapsule.info.profileRoot,
      operationId: basename(originalCapsule.info.recoveryDirectory), capsuleId: archive.capsuleId, expectedInventory: originalCapsule.inventory })
    const manifestPath = join(originalCapsule.info.recoveryDirectory, 'knowledge-complete-assets-v2', archive.capsuleId, 'manifest.json'), before = await readFile(manifestPath)
    try {
      await writeFile(manifestPath, text)
      await assert.rejects(reopenCapsule2AssetArchive(fresh, hash), /inventory不是同次genuine base\/settled分区/,
        'Rehashed fake settled support must not skip the actually missing context')
    } finally { await writeFile(manifestPath, before) }
  }))
