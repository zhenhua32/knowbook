import assert from 'node:assert/strict'
import test from 'node:test'
import { exchangeJobHash } from '../src/main/sync/synced-exchange-model'
import { graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import { pendingLocalComponentHash5, type PendingLocalComponentLocator5 } from '../src/main/database/restore-knowledge-pending-local-selection5'
import { previewRootRestorePendingLocalBody5 } from '../src/main/database/restore-knowledge-reference3-read'
import { allTables, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { prepareWorking5AssetReferenceFixture } from './helpers/working5-asset-authority-fixture'
import { withPendingWorkingSource5 } from './helpers/working5-automatic-source-fixture'

test('the explicit pending component preview changes only its selected native paragraph cell', { concurrency: false }, () =>
  withPendingWorkingSource5(f => withV3Fixture(async receiver => {
    const sourceBefore = allTables(f.f.B.db), currentBefore = allTables(receiver.db)
    const { reference } = await prepareWorking5AssetReferenceFixture(f, receiver.db)
    const original = reference.value.candidate
    assert.deepEqual(original.conflicts, [])

    function locator(documentId: string): PendingLocalComponentLocator5 {
      const recordKey = 'doc:' + documentId
      const found = f.working.records.find(value => value.jobSettingKey === f.row.key && value.recordKey === recordKey)
      const scope = f.working.observation.scopes.find(value => value.jobSettingKey === f.row.key && value.recordKey === recordKey)
      if (!found || !('replayedLocalFinal' in found) || !scope) throw new Error('Expected a captured pending job record')
      const { component, entry, planHash } = found.replayedLocalFinal
      assert.ok(component); assert.ok(entry)
      assert.deepEqual(component.keys, [recordKey])
      return { kind: 'restore-pending-local-component', version: 1, side: 'source', archiveHash: f.value.assetArchiveHash,
        workingManifestHash: f.working.manifestHash, operationId: f.operationId, attemptId: f.job.attemptId, jobHash: exchangeJobHash(f.job),
        contextHash: scope.contextHash, planHash, componentHash: pendingLocalComponentHash5(component), recordKey, localFinalHash: entry.hash }
    }

    const selected = locator(f.documentId), preview = await previewRootRestorePendingLocalBody5(reference.plan, selected)
    const { candidate } = preview, proof = candidate.pendingLocalBody
    assert.ok(proof)
    assert.equal(preview.originalCandidateHash, original.checkedCanonicalCandidateHash)
    assert.notEqual(candidate.checkedCanonicalCandidateHash, preview.originalCandidateHash)
    assert.equal(candidate.tables.length, 12)
    assert.equal(candidate.permit, false)
    assert.equal(proof.originalBlockId, f.definitionId)
    assert.equal(proof.originalDocumentId, f.documentId)
    assert.equal(proof.sourceRef.table, 'blocks')
    assert.ok(proof.assets.length > 0 && proof.assets.every(asset => asset.uri === f.portable && asset.hash === f.digest && asset.bytes === f.bytes.length))
    const diffs: Array<{ table: string; column: string; targetRowId: string }> = []
    for (const [index, table] of original.tables.entries()) {
      const effective = candidate.tables[index]
      assert.deepEqual({ ...table, rows: [] }, { ...effective, rows: [] })
      assert.equal(effective.rows.length, table.rows.length)
      for (const [rowIndex, row] of table.rows.entries()) {
        const final = effective.rows[rowIndex]
        assert.deepEqual({ ...row, cells: [] }, { ...final, cells: [] })
        for (const [columnIndex, before] of row.cells.entries()) {
          const after = final.cells[columnIndex]
          if (before.length === after.length && before.every((value, field) => value === after[field])) continue
          diffs.push({ table: table.name, column: table.columns[columnIndex], targetRowId: row.targetRowId })
          assert.ok(graph3Text(after, table.encoding).includes(f.portable))
        }
      }
    }
    assert.deepEqual(diffs, [{ table: 'blocks', column: 'content', targetRowId: proof.targetRowId }])
    assert.ok(f.remoteOnlyDocumentId)
    await assert.rejects(previewRootRestorePendingLocalBody5(reference.plan, locator(f.remoteOnlyDocumentId)), /pending-local-component-local-final/)
    await assert.rejects(previewRootRestorePendingLocalBody5(reference.plan, { ...selected, contextHash: '0'.repeat(64) }), /pending-local-component-original-asset-scope/)
    assert.deepEqual(allTables(f.f.B.db), sourceBefore)
    assert.deepEqual(allTables(receiver.db), currentBefore)
  }), { includeRemoteOnlyMerge: true, singleDocumentComponent: true }))
