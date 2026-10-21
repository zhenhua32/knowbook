import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname } from 'node:path'
import { unionCertifiedCapsuleKnowledge, readCertifiedKnowledgeUnion } from '../src/main/database/restore-knowledge-payload-read'
import { withDeletionPrimer, completed, encode, hash } from './helpers/synced-exchange-tombstone-primer-fixture'
import { captureKnowledgeOriginal, extractKnowledge } from './helpers/restore-knowledge-payload-fixture'

// Own file keeps this real multi-peer exchange within the existing file budget.
test('K unions an actual old live source with Main-accepted proof1 and retains its original receipt, job and identity supports', () => withDeletionPrimer(async f => {
  const source = await captureKnowledgeOriginal(f.B.root, dirname(f.B.file)), old = await extractKnowledge(source)
  const group = old.payload.groups.find(group => group.tuple.groupId === f.groupId)
  assert.ok(group && group.lifecycle?.state === 'active')
  f.remoteFinal(records => {
    const before = records.get('group:' + f.groupId)
    assert.ok(before?.kind === 'synced-group')
    records.set('group:' + f.groupId, { kind: 'synced-group-deleted', id: f.groupId, creationId: before.creationId,
      previousHash: hash(encode(before)), deletedAt: new Date().toISOString() })
  })
  completed(await f.exchange(), 'applied')
  const current = await extractKnowledge(await captureKnowledgeOriginal(f.B.root, dirname(f.B.file)))
  const denial = current.payload.denials.find(item => item.proof.key === 'group:' + f.groupId)
  assert.ok(denial); assert.equal(denial.proof.version, 1)
  assert.equal(denial.comparisonKey, group.comparisonKey)
  assert.equal(denial.receipt.version, 4); assert.equal(denial.job.version, 4)
  assert.ok(denial.mandatoryMaterial.some(row => row.table === 'app_settings'))
  assert.ok(denial.mandatoryMaterial.some(row => row.table === 'block_identities'))
  for (const support of denial.mandatoryMaterial)
    assert.ok(current.payload.originals.some(table => table.table === support.table && table.rows.some(row => row.rowHash === support.rowHash)))
  const union = await readCertifiedKnowledgeUnion(await unionCertifiedCapsuleKnowledge([old.handle, current.handle]))
  assert.ok(union.groups.some(item => item.comparisonKey === group.comparisonKey && item.variants.some(item => item.value.lifecycle?.state === 'active')))
  assert.ok(union.permanentDenials.some(item => item.value.proof.key === denial.proof.key))
  assert.equal(union.status, 'evidence-only', 'Old live content does not subtract the accepted permanent denial')
}))
