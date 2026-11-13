import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { lstat, readFile, realpath, rename } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { exchangeJobHash } from '../src/main/sync/synced-exchange-model'
import { pendingLocalComponentHash5, type PendingLocalComponentLocator5 } from '../src/main/database/restore-knowledge-pending-local-selection5'
import { prepareRootRestoreReferenceWithPendingLocal5 } from '../src/main/database/restore-knowledge-reference3-read'
import { prepareRootRestoreSqlAssetStage5 } from '../src/main/database/restore-knowledge-sql-asset-stage5'
import { referenceContextObjectPath } from '../src/main/database/restore-knowledge-reference-context-model'
import { allTables, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { prepareWorking5AssetReferenceFixture } from './helpers/working5-asset-authority-fixture'
import { withPendingWorkingSource5 } from './helpers/working5-automatic-source-fixture'

const tracePath = process.env.KNOWBOOK_PENDING_STAGE5_TEST_TRACE
function phase(name: string) {
  if (tracePath) appendFileSync(tracePath, JSON.stringify({ actor: 'parent', pid: process.pid, time: new Date().toISOString(),
    elapsedMs: Math.round(performance.now()), phase: name }) + '\n')
}

test('pending Reference3 v2 reopens in an independent process and reads exact SQL and staged assets', { concurrency: false }, () => {
  phase('fixture-start')
  return withPendingWorkingSource5(f => withV3Fixture(async receiver => {
    phase('fixture-ready')
    const sourceBefore = allTables(f.f.B.db), currentBefore = allTables(receiver.db)
    phase('base-reference-prepare-start')
    const { reference, qualified, identity } = await prepareWorking5AssetReferenceFixture(f, receiver.db, phase)
    phase('base-reference-prepared')
    const recordKey = 'doc:' + f.documentId
    const record = f.working.records.find(row => row.jobSettingKey === f.row.key && row.recordKey === recordKey)
    const scope = f.working.observation.scopes.find(row => row.jobSettingKey === f.row.key && row.recordKey === recordKey)
    if (!record || !('replayedLocalFinal' in record) || !scope) throw new Error('Expected the genuine pending job record')
    const { entry, component, planHash } = record.replayedLocalFinal
    assert.ok(entry); assert.ok(component)
    assert.deepEqual(component.keys, [recordKey])
    if (entry.record.kind !== 'document') throw new Error('Expected the real local document')
    const finalContent = entry.record.content.blocks.find(block => block.id === f.definitionId)?.content
    assert.ok(finalContent)
    const choice: PendingLocalComponentLocator5 = { kind: 'restore-pending-local-component', version: 1, side: 'source',
      archiveHash: f.value.assetArchiveHash, workingManifestHash: f.working.manifestHash, operationId: f.operationId,
      attemptId: f.job.attemptId, jobHash: exchangeJobHash(f.job), contextHash: scope.contextHash, planHash,
      componentHash: pendingLocalComponentHash5(component), recordKey, localFinalHash: entry.hash }
    phase('pending-reference-prepare-start')
    const prepared = await prepareRootRestoreReferenceWithPendingLocal5(reference.plan, choice)
    phase('pending-reference-prepared')
    const pending = prepared.value.candidate.pendingLocalBody
    assert.ok(pending)
    const manifest = JSON.parse(await readFile(join(prepared.directory, 'manifest.json'), 'utf8'))
    assert.equal(manifest.version, 2)
    assert.deepEqual(manifest.pendingSelection, choice)
    assert.equal(manifest.pendingCellProofHash, pending.proofHash)
    assert.equal(manifest.pendingBaseCandidateHash, reference.value.candidate.checkedCanonicalCandidateHash)
    phase('combined-stage-prepare-start')
    const stage = await prepareRootRestoreSqlAssetStage5(prepared.plan)
    phase('combined-stage-prepared')
    assert.equal(stage.assets.value.version, 4)
    assert.equal(stage.assets.value.pendingOccurrences, 2)
    assert.equal(stage.value.installPermit, false)
    assert.equal(stage.value.portableAssetsInstalled, false)
    const assets = stage.assets.value.selected.filter(asset => asset.context?.kind === 'pending-working-content')
    assert.equal(assets.length, 2)
    assert.ok(assets.every(asset => asset.hash === f.digest && asset.targetRowId === pending.targetRowId && asset.sourceRef.side === 'source'))
    const file = stage.assets.value.files.find(file => file.sha256 === f.digest)
    assert.ok(file)
    assert.deepEqual(await readFile(join(stage.assets.directory, referenceContextObjectPath(file.frame, file.path))), f.bytes)

    // Move the early SQL capsule out of its original address. The qualified
    // mount is a sibling and remains complete. The child receives only locators.
    const root = await realpath(f.f.folder), sourceCapsule = await realpath(f.original.info.capsuleDirectory)
    const local = relative(root, sourceCapsule)
    assert.ok(local && !local.startsWith('..') && !isAbsolute(local))
    assert.equal((await lstat(f.original.info.capsuleDirectory)).isSymbolicLink(), false)
    const retired = sourceCapsule + '-retired'
    await assert.rejects(lstat(retired), { code: 'ENOENT' })
    await rename(sourceCapsule, retired)
    phase('source-capsule-retired')
    phase('cold-process-launch')
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', resolve('tests/helpers/pending-local-stage5-process.cjs'), JSON.stringify({
        qualifiedLocator: { profileRoot: f.original.info.profileRoot, operationId: f.sourceInput.operationId, mountId: qualified.mountId,
          expectedDescriptorHash: qualified.descriptorHash },
        identityLocator: { planId: identity.planId, expectedManifestHash: identity.manifestHash },
        referenceLocator: { planId: prepared.planId, expectedManifestHash: prepared.manifestHash },
        stageLocator: { stageId: stage.stageId, expectedManifestHash: stage.manifestHash },
        expected: { proofHash: pending.proofHash, candidateHash: prepared.value.candidate.checkedCanonicalCandidateHash,
          physicalHash: stage.value.physicalObservationHash, assetHash: stage.value.assetSelectionHash,
          content: finalContent, blobHash: f.digest, bytes: f.bytes.toString('base64') }
      })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000 })
    phase('cold-process-exited')
    const observed = JSON.parse(stdout)
    assert.notEqual(observed.pid, process.pid)
    assert.equal(observed.stageHash, stage.manifestHash)
    assert.equal(observed.proofHash, pending.proofHash)
    assert.deepEqual(allTables(f.f.B.db), sourceBefore)
    assert.deepEqual(allTables(receiver.db), currentBefore)
    phase('assertions-completed')
  }), { singleDocumentComponent: true })
})
