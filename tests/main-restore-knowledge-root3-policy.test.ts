import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { root3Fact } from '../src/main/database/restore-knowledge-root3-model'
import { captureKnowledgeOriginal } from './helpers/restore-knowledge-payload-fixture'
import { root3PlanFromActualCapsules } from './helpers/root3-plan-fixture'
import { withDeletionChoices, groupConflict, ready, component, choose, completed, proof2 } from './helpers/synced-deletion-choice-fixture'

test('complete Root3 plan preserves a real permanent keep-delete proof over the independently copied older live source', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f), source = await captureKnowledgeOriginal(f.B.root, dirname(f.B.file))
  const preview = ready(await f.preview()), operationId = randomUUID()
  completed(await f.resolve(preview, [choose(component(preview, conflict.key), 'keep-delete')], operationId), 'applied')
  const proof = proof2(f, operationId, conflict.key), current = await captureKnowledgeOriginal(f.B.root, dirname(f.B.file))
  const { value } = await root3PlanFromActualCapsules(f.B.root, source, current.capsule), plan = value.constraints
  const currentPayload = plan.payloads.find(payload => payload.witness.side === 'current')!
  const denial = currentPayload.input.knowledge.projection.denials.find(value => value.proof.key === conflict.key)!
  assert.ok(denial); assert.deepEqual(denial.proof, proof.value)
  const constraint = plan.groups.find(value => value.comparisonKey === denial.comparisonKey)!
  assert.ok(constraint); assert.equal(constraint.disposition, 'permanent-denial')
  assert.ok(constraint.groups.some(ref => plan.payloads.find(payload => payload.key === ref.payload)?.witness.side === 'source'))
  assert.ok(constraint.denials.some(ref => root3Fact(plan, ref) === denial))
  assert.ok(denial.mandatoryMaterial.length > 0); assert.equal(denial.receipt.version, 7); assert.equal(denial.job.version, 7)
  assert.equal(value.acceptedCoverage, false); assert.equal(value.effective, false); assert.equal(value.permit, false)
}))
