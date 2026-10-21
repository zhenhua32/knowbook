import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { certifyDurableSqlCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-read'
import { exchangeJobKey, exchangeJobPhaseKey } from '../src/main/sync/synced-exchange-model'
import { unionCertifiedCapsuleKnowledge, readCertifiedKnowledgeUnion } from '../src/main/database/restore-knowledge-payload-read'
import { withDeletionChoices, groupConflict, ready, component, choose, completed, proof2, receipt7 } from './helpers/synced-deletion-choice-fixture'
import { captureKnowledgeOriginal, prepareKnowledgeOriginal, extractKnowledge, payloadTextCell } from './helpers/restore-knowledge-payload-fixture'

test('K keeps real keep-delete proof2 over its old live source after spool cleanup, but missing mandatory SQL phase never certifies', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f), source = await extractKnowledge(await captureKnowledgeOriginal(f.B.root, dirname(f.B.file)))
  const preview = ready(await f.preview()), operationId = randomUUID()
  completed(await f.resolve(preview, [choose(component(preview, conflict.key), 'keep-delete')], operationId), 'applied')
  const original = receipt7(f, operationId), proof = proof2(f, operationId, conflict.key)
  const sourceKey = exchangeJobKey(operationId, original.receipt.provenance.attemptId)
  const phaseKey = exchangeJobPhaseKey(operationId, original.receipt.provenance.attemptId, 0)
  for (const name of ['synced-exchanges-v1', 'synced-exchange-deletion-previews-v1']) {
    const path = join(f.B.root, 'storage', name)
    assert.ok(existsSync(path), 'The actual Main consumer created the removable spool')
    const canonical = await realpath(path)
    assert.equal(dirname(canonical), await realpath(join(f.B.root, 'storage')))
    await rm(canonical, { recursive: true })
  }
  const current = await extractKnowledge(await captureKnowledgeOriginal(f.B.root, dirname(f.B.file)))
  const denial = current.payload.denials.find(item => item.proof.key === conflict.key)
  assert.ok(denial); assert.equal(denial.proof.version, 2)
  assert.deepEqual(denial.proof, proof.value); assert.equal(denial.receipt.version, 7); assert.equal(denial.job.version, 7)
  for (const key of [sourceKey, phaseKey]) assert.ok(denial.mandatoryMaterial.some(row => row.table === 'app_settings'
    && JSON.stringify(row.key[0]) === JSON.stringify(payloadTextCell(key, current.payload.encoding))), 'The full mandatory job/phase is retained')
  assert.ok(current.payload.historicalMaterial.some(item => item.fact.family === 'exchange-job' && item.fact.evidenceClass === 'index-attempt-only'))
  const union = await readCertifiedKnowledgeUnion(await unionCertifiedCapsuleKnowledge([source.handle, current.handle]))
  assert.ok(source.payload.groups.some(group => group.comparisonKey === denial.comparisonKey))
  assert.ok(union.permanentDenials.some(item => item.value.source.rowHash === denial.source.rowHash))
  assert.equal(f.B.db.prepare('SELECT 1 FROM synced_group_blocks WHERE group_id=?').get(conflict.id), undefined)
  assert.equal(f.B.db.prepare('DELETE FROM app_settings WHERE key=?').run(phaseKey).changes, 1)
  const missing = await prepareKnowledgeOriginal(f.B.root, dirname(f.B.file))
  await assert.rejects(certifyDurableSqlCapsuleOriginal(missing.original), /phase|阶段|prepared|来源|job|回执|receipt/)
  assert.ok((await readCertifiedKnowledgeUnion(await unionCertifiedCapsuleKnowledge([source.handle, current.handle]))).permanentDenials.length > 0,
    'A later damaged live DB cannot erase the separately certified permanent original')
}))
