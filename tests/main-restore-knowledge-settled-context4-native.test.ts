import assert from 'node:assert/strict'
import test from 'node:test'
import { open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseSyncedPortableAssetUri } from '../src/shared/syncedBlockPortable'
import { createRootRestoreSupplementalAssetObserver4 } from '../src/main/database/restore-knowledge-assets4-supplement'
import { describeCapsule2AssetScopeSupplement4 } from '../src/main/database/restore-knowledge-capsule2-asset-supplement4-model'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { captureSettledContext4 } from './helpers/settled-context4-fixture'
import { withSettledPortable3, object, array } from './helpers/settled-portable-owner-fixture'
import { editKeepingKeys, snapshot, randomUUID } from './helpers/synced-exchange-conflict-fixture'
import { restoreSyncedGroupOperation } from '../src/main/database/synced-blocks-content'
import { deriveRoot3SettledWorkingEvidence3 } from '../src/main/database/restore-knowledge-assets3-context'
import { deriveCapsule2SettledPortableEvidence3 } from '../src/main/database/restore-knowledge-assets3-settled-portable-derive'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'

const groupWire = (value: ReturnType<typeof snapshot>) => ({ kind: 'synced-group' as const, id: value.groupId, creationId: value.creationId,
  createdAt: value.createdAt, origin: value.origin, bindings: value.bindings, blocks: value.blocks })

test('archive4 preserves actual NTFS logical portable names that differ from physical aliases without inventing a matching Proof2 alias',
  { skip: process.platform !== 'win32' }, () => withSettledPortable3(async saved => {
    const groupId = saved.groupId; assert.ok(groupId)
    const groupKey = 'group:' + groupId, expectedGroup = saved.oracleRecords.get(groupKey); assert.ok(expectedGroup)
    if (expectedGroup.kind !== 'synced-group') throw new Error('Actual complete Main portable group required')
    const originalJob = saved.jobs.find(value => value.job.merges?.some(merge => merge.key === groupKey)); assert.ok(originalJob)
    const groupMerge = originalJob.job.merges!.find(value => value.key === groupKey); assert.ok(groupMerge)
    assert.equal(publicationHash(publicationJson(expectedGroup)), groupMerge.resultHash)
    const nativeBefore = snapshot(saved.f.B.db, groupId), nativeGroup = groupWire(nativeBefore)
    assert.notEqual(publicationHash(publicationJson(nativeGroup)), groupMerge.resultHash)
    assert.equal(nativeBefore.blocks.some(block => block.type === 'database-view'), false,
      'This case isolates asset spelling and does not send a catalog sentinel to the local writer')
    // A real portable local edit followed by real Undo leaves one authentic
    // history row with portable after_json and native before_json/current.
    const portableEdit = editKeepingKeys(saved.f.B, groupId, blocks => {
      for (const block of blocks) { const source = expectedGroup.blocks.find(value => value.id === block.id); assert.ok(source); block.content = source.content }
    })
    if (portableEdit.status !== 'saved') throw new Error('Real portable group edit must be saved')
    assert.equal(publicationJson(groupWire(portableEdit.snapshot)), publicationJson(expectedGroup))
    const historyToken = portableEdit.snapshot.history.undoToken; assert.ok(historyToken)
    const historyRow = saved.f.B.db.prepare('SELECT before_json,after_json,before_hash,after_hash FROM synced_group_history WHERE id=? AND group_id=?')
      .get(historyToken, groupId) as {before_json: string; after_json: string; before_hash: string; after_hash: string}
    assert.ok(historyRow); assert.equal(publicationJson(JSON.parse(historyRow.before_json)), publicationJson(nativeGroup))
    assert.equal(publicationJson(JSON.parse(historyRow.after_json)), publicationJson(expectedGroup)); assert.equal(historyRow.after_hash, groupMerge.resultHash)
    const instance = portableEdit.snapshot.instances[0]; assert.ok(instance)
    const undone = restoreSyncedGroupOperation(saved.f.B.db, { clientOperationId: randomUUID(), groupId,
      expectedRevision: portableEdit.snapshot.revision, expectedTopologyRevision: portableEdit.snapshot.topologyRevision,
      expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion },
      expectedHistoryCursor: portableEdit.snapshot.history.cursor, historyToken, direction: 'undo' })
    if (undone.status !== 'saved') throw new Error('Real Undo must restore the exact native group')
    assert.equal(publicationJson(groupWire(undone.snapshot)), publicationJson(nativeGroup)); assert.equal(undone.snapshot.history.redoToken, historyToken)
    assert.equal((saved.f.B.db.prepare('SELECT after_json FROM synced_group_history WHERE id=?').get(historyToken) as {after_json: string}).after_json, historyRow.after_json)
    const fixture = await captureSettledContext4(saved)
    const archive = fixture.value.assetArchive
    if (archive.version !== 4) throw new Error('Actual archive4 required')
    assert.deepEqual(fixture.spoolProbeAttempts, [])
    assert.equal(archive.coverage.supplementalCustomMergeScopesCaptured, true)
    const base = await fixture.readBase(), observed = createRootRestoreSupplementalAssetObserver4(base.value).finish()
    const legacy = deriveRoot3SettledWorkingEvidence3(fixture.value.source.sourceContent).get(originalJob.row.key); assert.ok(legacy)
    const legacySource = array(object(legacy.binding).sources).map(object).find(value => value.recordKey === groupKey); assert.ok(legacySource)
    assert.deepEqual(legacySource.source, ['synced_group_history', historyToken, 'after_json'])
    assert.equal('portableProjection' in legacySource, false, 'Published raw settled witness semantics stay unchanged')
    assert.equal(publicationJson(legacy.merged.find(value => value.recordKey === groupKey)!.record), publicationJson(expectedGroup))
    const defaultInput = { source: base.value.source,
      referenceCapture: { version: 2 as const, sourceContentHash: base.value.commitment.sourceContentHash,
        workspaceHistoryObservationHash: base.value.commitment.workspaceHistoryObservationHash,
        assetReferencesObservationHash: base.value.commitment.assetReferencesObservationHash, referenceUris: base.value.referenceUris,
        tree: base.value.tree, referenceProvenance: base.value.baseProof },
      binding: { baseProjectionManifestHash: base.value.commitment.baseManifestHash, baseProjectionMaterialHash: base.value.commitment.baseMaterialHash } }
    const oldDefault = deriveCapsule2SettledPortableEvidence3(defaultInput), oldExplicit = deriveCapsule2SettledPortableEvidence3(defaultInput, { preferProjectedCandidate: false })
    assert.deepEqual(oldDefault, oldExplicit); assert.equal(oldDefault.evidenceHash, oldExplicit.evidenceHash)
    const oldGroup = oldDefault.jobs.find(value => value.jobSettingKey === originalJob.row.key); assert.ok(oldGroup)
    assert.equal('portableProjection' in array(object(oldGroup.binding).sources).map(object).find(value => value.recordKey === groupKey)!, false)
    assert.deepEqual(base.value.settledEvidence, deriveCapsule2SettledPortableEvidence3(defaultInput, { preferProjectedCandidate: true }))
    const groupMappings = observed.settledPortableBindings.filter(value => value.recordKey === groupKey && value.hash === saved.digest
      && value.logicalName === saved.logicalName && value.logicalName !== value.physicalName)
    assert.ok(groupMappings.length > 0, 'Only the explicit Base4 route prefers complete genuine projected W support over equal-hash raw history')
    const nativeScopeHash = capsuleBytesHash('knowbook.capsule2.asset-scope-content.v1\0' + capsuleJson({ summary: '', blocks: nativeGroup.blocks }))
    for (const mapping of groupMappings) {
      assert.equal(mapping.resultHash, groupMerge.resultHash); assert.equal(mapping.originalScopeContentHash, nativeScopeHash)
      const scope = base.value.baseAssets.scopes.find(value => publicationJson(value.source) === publicationJson(mapping.originalScopeSource)); assert.ok(scope)
      assert.equal(scope.contentHash, nativeScopeHash); assert.ok(scope.destinations.some(value => value.uri === mapping.sourceUri))
      const entry = base.value.baseProof.entries[mapping.baseReferenceIndex]; assert.equal(entry[1], 'file'); assert.equal(entry[2], mapping.aliasIndex)
    }
    assert.deepEqual(describeCapsule2AssetScopeSupplement4(observed), archive.assetScopeSupplement)
    const mismatched = observed.settledPortableBindings.filter(value => value.hash === fixture.saved.digest && value.logicalName !== value.physicalName)
    assert.ok(mismatched.some(value => value.logicalName === fixture.saved.logicalName),
      'The lower-case long-name scenario runs even when this volume has no 8.3 aliases')
    const canonical = await open(new URL(fixture.saved.physical.url), 'r')
    try {
      const expected = await canonical.stat({ bigint: true })
      for (const mapping of mismatched) {
        const fd = await open(fileURLToPath(mapping.sourceUri), 'r')
        try { const actual = await fd.stat({ bigint: true }); assert.equal(actual.dev, expected.dev); assert.equal(actual.ino, expected.ino) }
        finally { await fd.close() }
        const portable = parseSyncedPortableAssetUri(mapping.portableUri)
        assert.equal(portable.name, mapping.logicalName)
        assert.equal(archive.tree.aliases.some(alias => alias.hash === mapping.hash && alias.name === mapping.logicalName), false)
        const index = [...new Set([...archive.referenceUris, ...archive.assetScopeSupplement.referenceUris])].sort().indexOf(mapping.portableUri)
        assert.ok(index >= 0)
        assert.equal(archive.referenceProvenance.entries[index][1], 'unresolved',
          'Strict Proof2 is retained; only the separately bound scope/W proof supplies this actual logical alias')
      }
    } finally { await canonical.close() }
    for (const job of base.value.settledEvidence.jobs) for (const item of job.merged) {
      assert.equal(publicationJson(item.record), publicationJson(fixture.expectedRecords.get(item.recordKey)))
      assert.equal(publicationHash(publicationJson(item.record)), item.provenance.resultHash)
    }
  }, { nativeAliases: true, group: true, catalog: false }))
