import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname } from 'node:path'
import { unionCertifiedCapsuleKnowledge, readCertifiedKnowledgeUnion } from '../src/main/database/restore-knowledge-payload-read'
import { withObservationFixture, restoreCreated, requireObserved, getSyncedCreateRestoreContext } from './helpers/synced-remote-observation-fixture'
import { captureKnowledgeOriginal, extractKnowledge } from './helpers/restore-knowledge-payload-fixture'

test('K retains a real retired remote observation and frozen create Undo evidence without reactivating the old source', () => withObservationFixture(async f => {
  const source = await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))
  const retired = restoreCreated(f.db, f.createAck, 'undo')
  await f.publish()
  const observed = requireObserved(await f.observe(f.open()))
  assert.equal(observed.groups[0].outcome, 'retired-disabled')
  const current = await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))
  const groupId = f.createAck.createdLifecycle.groupId, old = source.payload.groups.find(group => group.tuple.groupId === groupId)
  const next = current.payload.groups.find(group => group.tuple.groupId === groupId)
  assert.ok(old && next && next.retirement)
  assert.equal(next.comparisonKey, old.comparisonKey)
  assert.equal(next.lifecycle?.state, 'retired-create'); assert.equal(next.lifecycle?.exposure, 'never')
  assert.ok(current.payload.observations.some(item => item.marker.incarnation.groupId === groupId && item.marker.persistence.kind === 'retired-disabled'))
  assert.ok(current.payload.exposures.some(item => item.kind === 'retired-observation-anchor' && item.members.length === 0))
  const union = await readCertifiedKnowledgeUnion(await unionCertifiedCapsuleKnowledge([source.handle, current.handle]))
  assert.ok(union.exposureKnowledge.some(item => item.comparisonKey === old.comparisonKey && item.retiredRemoteObservation))
  assert.ok(union.groups.find(item => item.comparisonKey === old.comparisonKey)?.variants.some(item => item.value.lifecycle?.state === 'active'))
  assert.deepEqual(getSyncedCreateRestoreContext(f.db, { historyToken: retired.ack.historyToken, direction: 'redo' }),
    { status: 'unavailable', reason: 'lifecycle' }, 'Payload union never grants old create execution authority')
}))
