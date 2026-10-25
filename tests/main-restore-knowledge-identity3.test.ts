import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareRootRestoreIdentityPlan3, readRootRestoreIdentityPlan3, reopenRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { readRootKnowledgeConservationContent3 } from '../src/main/database/restore-knowledge-root3-read'
import { deriveRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-model'
import { withContent3Fixture, tamperContent3VerificationOriginals } from './helpers/content3-fixture'
import { allTables } from './helpers/synced-backup-v3-fixture'

test('durable identity planner rejects fake copied and accessor handles without evaluating caller selectors or entropy', async () => {
  let touched = 0
  const fake = Object.defineProperty({}, 'kind', { get() { touched++; throw new Error('must not run') } })
  await assert.rejects(prepareRootRestoreIdentityPlan3(fake as never), /句柄/)
  await assert.rejects(readRootRestoreIdentityPlan3(fake as never), /句柄/)
  await assert.rejects(reopenRootRestoreIdentityPlan3(fake as never, fake as never), /句柄/)
  await assert.rejects(prepareRootRestoreIdentityPlan3({ kind: 'main-complete-qualified-knowledge-plan' }), /句柄/)
  assert.equal(touched, 0)
})

test('actual Main identity plan preallocates every original occupancy fact with shared block-instance slots missing reservations and fresh execution guards', t => withContent3Fixture(async f => {
  const prepared = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan), value = prepared.value
  const allFacts = value.assignments.flatMap(item => item.facts).sort((a, b) => a - b)
  assert.deepEqual(allFacts, f.sourcePacket.knowledge.occupancy.map((_, index) => index))
  assert.equal(new Set(value.assignments.map(item => JSON.stringify([item.kind, item.targetId]))).size, value.assignments.length)
  for (const instance of f.sourcePacket.knowledge.instances) {
    const assignments = value.assignments.filter(item => item.sourceId === instance.instanceId && item.physical)
    assert.equal(assignments.length, 1); assert.equal(assignments[0].kind, 'block')
    assert.deepEqual([...assignments[0].roles].sort(), ['block', 'instance'])
  }
  const currentUsed = new Set(f.currentPacket.knowledge.occupancy.map(item => JSON.stringify([item.namespace === 'instance' ? 'block' : item.namespace, item.id])))
  const missing = value.assignments.filter(item => item.state === 'missing-reservation')
  assert.ok(missing.length > 0)
  for (const item of missing) assert.equal(currentUsed.has(JSON.stringify([item.kind, item.targetId])), false)
  assert.equal(value.targetCatalogId, f.source.store.getDatabases().find(database => database.kind === 'document-catalog')!.id)
  const oldGuards = new Set([f.sourcePacket, f.currentPacket].flatMap(packet => [packet.knowledge.recoveryEpoch,
    ...packet.knowledge.groups.flatMap(group => [group.guards.revision, group.guards.topologyRevision, group.guards.historyCursor]),
    ...packet.knowledge.instances.map(instance => instance.bindingVersion), ...packet.knowledge.hostStates.map(state => state.cursor)]))
  const guards = [value.execution.recoveryEpoch, ...value.execution.groups.flatMap(group => [group.revision, group.topologyRevision, group.historyCursor]),
    ...value.execution.instances.map(instance => instance.bindingVersion), ...value.execution.hosts.map(host => host.historyCursor)]
  assert.equal(new Set(guards).size, guards.length)
  for (const guard of guards) { assert.match(guard, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/); assert.equal(oldGuards.has(guard), false) }
  for (const group of value.execution.groups) { assert.equal(group.historyPosition, 0); assert.equal(group.activationAuthorized, false) }
  assert.equal(value.execution.workspaceScope, f.currentPacket.knowledge.workspaceScope)
  assert.equal(value.execution.sourceOperationsReplayAllowed, false); assert.equal(value.execution.transactionCutStillRequired, true)
  for (const flag of ['referenceRewriteComplete','semanticValidationComplete','acceptedCoverage','effective','permit'] as const) assert.equal(value[flag], false)
  assert.equal(Object.isFrozen(value.assignments[0].facts), true)
  await assert.rejects(readRootRestoreIdentityPlan3(structuredClone(prepared.plan)), /句柄/)
  assert.deepEqual(await readRootRestoreIdentityPlan3(prepared.plan), value)
  assert.deepEqual((await reopenRootRestoreIdentityPlan3(f.saved.knowledgePlan, { planId: prepared.planId, expectedManifestHash: prepared.manifestHash })).value, value)
  const actual = await readRootKnowledgeConservationContent3(f.saved.knowledgePlan)
  const kernel = { seed: '00'.repeat(32), preparedAt: '2090-01-01T00:00:00.000Z' }
  await t.test('an unknown-birth physical reference cannot fabricate a second live document when retained generations differ', () => {
    const changed = structuredClone(actual), occupancy = changed.source.knowledge.occupancy
    const physical = occupancy.find(item => item.namespace === 'document' && item.id === f.source.hostId && item.source.table === 'documents')!
    Reflect.set(occupancy, occupancy.length, { ...physical, kind: 'history', knownBirth: '2000-01-01T00:00:00.000Z' })
    const planned = deriveRootRestoreIdentityPlan3(changed, kernel)
    const slots = planned.assignments.filter(item => item.kind === 'document' && item.sourceId === f.source.hostId)
    assert.equal(slots.filter(item => item.physical).length, 1)
    assert.ok(slots.some(item => item.birth === null && item.ambiguous && item.state === 'missing-reservation'))
    assert.equal(planned.execution.hosts.find(host => host.sourceDocumentId === f.source.hostId)!.targetDocumentId, slots.find(item => item.physical)!.targetId)
  })
  await t.test('a different group incarnation forks every physical canonical child and requires an explicit fork decision', () => {
    const changed = structuredClone(actual), group = changed.current.knowledge.groups.find(group => group.tuple.groupId === f.source.groupId)!
    Object.assign(group, { comparisonKey: 'f'.repeat(64) })
    const planned = deriveRootRestoreIdentityPlan3(changed, kernel)
    const mappedGroup = planned.assignments.find(item => item.kind === 'group' && item.sourceId === f.source.groupId && item.physical)!
    assert.notEqual(mappedGroup.targetId, mappedGroup.sourceId); assert.equal(mappedGroup.requiresExplicitForkDecision, true)
    assert.notEqual(mappedGroup.targetCreationId, f.sourcePacket.knowledge.groups.find(group => group.tuple.groupId === f.source.groupId)!.tuple.creationId)
    const children = planned.assignments.filter(item => item.kind === 'block' && item.physical && item.ownerKind === 'group' && item.ownerId === f.source.groupId)
    assert.ok(children.length); for (const child of children) assert.notEqual(child.sourceId, child.targetId)
    for (const instance of actual.source.knowledge.instances.filter(instance => instance.groupId === f.source.groupId)) {
      const assignment = planned.assignments.find(item => item.kind === 'block' && item.sourceId === instance.instanceId && item.physical)!
      assert.notEqual(assignment.targetId, instance.instanceId)
    }
  })
  await t.test('a retained journal token cannot become a freshly generated execution guard even outside current headers', () => {
    const first = deriveRootRestoreIdentityPlan3(actual, kernel), changed = structuredClone(actual)
    const payload = changed.knowledge.constraints.payloads[0].input.knowledge.projection
    const table = payload.originals.find(table => table.disclosure === 'complete-evidence-rows' && table.rows.length)!
    const row = table.rows[0], index = row.cells.findIndex(cell => cell[0] === 'text')
    assert.ok(index >= 0)
    const bytes = Buffer.from(JSON.stringify({ oldCursor: first.execution.recoveryEpoch }), payload.encoding === 'UTF-8' ? 'utf8' : 'utf16le')
    if (payload.encoding === 'UTF-16be') bytes.swap16()
    Reflect.set(row.cells, index, ['text', bytes.toString('base64')])
    const second = deriveRootRestoreIdentityPlan3(changed, kernel)
    assert.notEqual(second.execution.recoveryEpoch, first.execution.recoveryEpoch)
    assert.equal(second.permit, false)
  })
  const manifestPath = join(prepared.directory, 'manifest.json'), manifest = await readFile(manifestPath)
  await writeFile(manifestPath, Buffer.alloc(8193, 32))
  await assert.rejects(readRootRestoreIdentityPlan3(prepared.plan))
  await writeFile(manifestPath, manifest)
  assert.deepEqual(await readRootRestoreIdentityPlan3(prepared.plan), value)
  await tamperContent3VerificationOriginals(f.receiver.userDataRoot)
  await assert.rejects(readRootRestoreIdentityPlan3(prepared.plan))
  assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
}))
