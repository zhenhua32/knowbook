import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareRootRestoreContentPlan3, readRootRestoreContentPlan3 } from '../src/main/database/restore-knowledge-content3-read'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { captureMixedRootKnowledgeConservationPlan3 } from '../src/main/database/restore-knowledge-root3-read'
import { withContent3Fixture, tamperContent3VerificationOriginals } from './helpers/content3-fixture'
import { allTables, randomUUID } from './helpers/synced-backup-v3-fixture'

test('complete content planning rejects fake handles and accessors before property access', async () => {
  let touched = 0
  const fake = Object.defineProperty({}, 'kind', { get() { touched++; throw new Error('must not run') } })
  await assert.rejects(prepareRootRestoreContentPlan3(fake as never), /句柄/)
  await assert.rejects(readRootRestoreContentPlan3(fake as never), /句柄/)
  await assert.rejects(prepareRootRestoreContentPlan3({ kind: 'main-complete-qualified-knowledge-plan' }), /句柄/)
  await assert.rejects(readRootRestoreContentPlan3({ kind: 'main-root-restore-content-plan' }), /句柄/)
  assert.equal(touched, 0)
})

test('Main content plan selects every exact incoming business table, binds both complete sources, and never installs policy or execution history', () => withContent3Fixture(async f => {
  const prepared = await prepareRootRestoreContentPlan3(f.saved.knowledgePlan), value = prepared.value
  assert.deepEqual(value.candidateTables, f.sourcePacket.source.sourceContent.tables.filter(table => table.role === 'content'))
  assert.equal(value.candidateTables.length, 12)
  assert.notDeepEqual(value.candidateTables, f.currentPacket.source.sourceContent.tables.filter(table => table.role === 'content'))
  const decode = (name: string, column: string) => {
    const table = value.candidateTables.find(table => table.name === name)!
    return table.rows.flatMap(row => { const cell = row.cells[table.columns.indexOf(column)]; return cell[0] === 'text' ? [Buffer.from(cell[1], 'base64').toString('utf8')] : [] })
  }
  assert.ok(decode('documents', 'title').includes(f.ordinary.title))
  assert.ok(decode('blocks', 'content').includes(f.raw))
  assert.equal(decode('blocks', 'content').includes('Different current business body'), false)
  assert.equal(capsuleJson(value.candidateTables).includes(Buffer.from('source-private-key-must-never-be-in-business-candidate').toString('base64')), false)
  assert.equal(capsuleJson(value.candidateTables).includes(Buffer.from('current-key-is-retained-policy-only').toString('base64')), false)
  for (const [side, packet] of [['source', f.sourcePacket], ['current', f.currentPacket]] as const) {
    const dispositions = value.dispositions.filter(item => item.side === side)
    assert.deepEqual(dispositions.map(item => item.table), packet.source.sourceContent.tables.map(table => table.name))
    for (const table of packet.source.sourceContent.tables) {
      const disposition = dispositions.find(item => item.table === table.name)!
      assert.equal(disposition.originalTableHash, capsuleBytesHash('knowbook.restore.content3.original-table.v1\0' + capsuleJson(table)))
      assert.equal(disposition.selectedAsIncomingContent, side === 'source' && table.role === 'content')
      if (table.role === 'policy-unresolved') assert.equal(disposition.action, 'preserve-current-policy-no-source-replay')
      if (table.role === 'execution-history-evidence') assert.equal(disposition.action, 'retain-evidence-and-establish-fresh-cut')
      if (table.role === 'identity-evidence') assert.equal(disposition.action, 'merge-qualified-identity-evidence')
      if (table.role === 'derived') assert.equal(disposition.action, 'rebuild')
    }
    assert.deepEqual(value.derivedTables.filter(item => item.side === side).map(item => item.table), packet.source.sourceContent.derivedTablesNotRepeated)
  }
  assert.equal(value.sourceMaterialHash, f.sourcePacket.materialHash); assert.equal(value.currentMaterialHash, f.currentPacket.materialHash)
  assert.equal(value.sourceAssetArchiveHash, f.sourcePacket.assetArchiveHash); assert.equal(value.currentAssetArchiveHash, f.currentPacket.assetArchiveHash)
  assert.notEqual(value.selectionHash, value.conservationHash)
  assert.equal(value.originalInputClosureAuthenticated, true)
  for (const flag of ['sourcePolicyReplayAllowed', 'semanticValidationComplete', 'acceptedCoverage', 'effective', 'permit'] as const) assert.equal(value[flag], false)
  assert.equal(Object.isFrozen(value.candidateTables[0].rows), true)
  await assert.rejects(readRootRestoreContentPlan3(structuredClone(prepared.plan)), /句柄/)
  await assert.rejects(prepareRootRestoreContentPlan3(f.saved.knowledgeValue as never), /句柄/)
  assert.deepEqual(await readRootRestoreContentPlan3(prepared.plan), value)
  await tamperContent3VerificationOriginals(f.receiver.userDataRoot)
  await assert.rejects(readRootRestoreContentPlan3(prepared.plan))
  // A new Main capture must use the intact immutable copied package, not the
  // previous hot reader's modified verification SQL or a saved candidate DTO.
  const fresh = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: f.receiver.userDataRoot,
    operationId: randomUUID(), sourceDirectory: f.saved.originalPackage.directory })
  assert.deepEqual((await prepareRootRestoreContentPlan3(fresh.knowledgePlan)).value, value)
  assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
}))
