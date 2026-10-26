import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import { prepareRootRestoreIdentityPlan3, readRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3 } from '../src/main/database/restore-knowledge-reference3-read'
import { parseSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { withReference3PolicyForkFixture } from './helpers/reference3-policy-fixture'
import { withCanonical3Fixture } from './helpers/canonical3-fixture'
import { allTables } from './helpers/synced-backup-v3-fixture'

type Value = Awaited<ReturnType<typeof prepareRootRestoreReferencePlan3>>['value']
function rows(value: Value, name: string) {
  const table = value.candidate.tables.find(table => table.name === name)!
  return table.rows.map(row => ({ row, value: Object.fromEntries(table.columns.map((column, index) => {
    const cell = row.cells[index]
    return [column, cell[0] === 'null' ? null : cell[0] === 'text' ? graph3Text(cell, table.encoding)
      : cell[0] === 'integer' ? BigInt(cell[1]) : cell[0] === 'real-ieee754-le' ? Buffer.from(cell[1], 'hex').readDoubleLE() : Buffer.from(cell[1], 'base64')]
  })) as Record<string, unknown> }))
}

test('independent Main same-ID group births remain distinct and every incoming instance follows the complete reference fork', () =>
  withReference3PolicyForkFixture(async f => {
    const base = await prepareRootRestoreIdentityPlan3(f.captured.knowledgePlan)
    const baseBytes = await readFile(join(base.directory, 'manifest.json'))
    const prepared = await prepareRootRestoreReferencePlan3(base.plan), { allocation, candidate } = prepared.value
    const slot = (kind: string, id: string) => allocation.assignments.find(item => item.physical && item.kind === kind && item.sourceId === id)!
    const baseFree = base.value.assignments.find(item => item.physical && item.kind === 'block' && item.sourceId === f.freeInstanceId)!
    assert.equal(baseFree.targetId, f.freeInstanceId, 'The original allocator really has a free incoming instance slot')
    const group = slot('group', f.ids.groupId)
    const baseGroup = base.value.assignments.find(item => item.physical && item.kind === 'group' && item.sourceId === f.ids.groupId)!
    assert.notEqual(group.targetId, f.ids.groupId)
    assert.notEqual(group.targetId, baseGroup.targetId, 'Origin relocation has its own allocation rather than altering the old durable plan')
    assert.notEqual(group.targetCreationId, f.sourceGroup.creationId)
    assert.notEqual(group.targetCreationId, f.currentGroup.creationId)
    assert.notEqual(group.targetCreationId, baseGroup.targetCreationId)
    assert.equal(group.reason, 'origin-relocation-group-fork')
    const root = slot('block', f.ids.rootId), child = slot('block', f.ids.childId)
    for (const item of [root, child, slot('block', f.ids.instanceId), slot('block', f.freeInstanceId)]) assert.notEqual(item.targetId, item.sourceId)
    assert.equal(slot('block', f.freeInstanceId).reason, 'origin-relocation-instance-fork')
    assert.equal(slot('block', f.ids.instanceId).birth, f.sourceFirstBirth)
    assert.notEqual(slot('block', f.ids.instanceId).birth, f.currentFirstBirth)
    const canonical = rows(prepared.value, 'synced_group_blocks')
    assert.equal(canonical.find(entry => entry.value.id === root.targetId)!.value.group_id, group.targetId)
    const descendant = canonical.find(entry => entry.value.id === child.targetId)!.value
    assert.equal(descendant.group_id, group.targetId); assert.equal(descendant.parent_block_id, root.targetId)
    const targetDocumentId = slot('document', f.source.targetId).targetId
    const longDocument = rows(prepared.value, 'documents').find(entry => entry.value.id === targetDocumentId)!
    assert.equal(longDocument.row.sourceRef.side, 'source')
    assert.equal(longDocument.value.title, f.longTitle)
    assert.equal(String(longDocument.value.title).length, 501)
    assert.ok(candidate.projectedBudgets.some(budget => budget.documentId === targetDocumentId && budget.blocks > 0 && budget.bytes > 0),
      'The native Root3 projection measures the actual 501-character document without applying the V3 title500 gate')
    const template = rows(prepared.value, 'document_templates').find(entry => entry.value.id === f.template.id)!
    const templateBlocks = JSON.parse(String(template.value.blocks_json)) as DocumentBlockDraft[]
    assert.equal(templateBlocks.length, 1)
    assert.equal(templateBlocks[0].type, 'synced-block')
    assert.equal(templateBlocks[0].id, f.ids.childId)
    assert.notEqual(templateBlocks[0].id, child.targetId, 'A template-local spelling is not a physical canonical identity')
    assert.equal(templateBlocks[0].parentBlockId, null)
    assert.equal(parseSyncedBlockPayload(templateBlocks[0].content).groupId, group.targetId)
    for (const id of [f.ids.instanceId, f.freeInstanceId]) {
      const target = slot('block', id).targetId
      const registry = rows(prepared.value, 'synced_instances').find(entry => entry.value.instance_id === target)!
      const leaf = rows(prepared.value, 'blocks').find(entry => entry.value.id === target)!
      assert.equal(registry.value.group_id, group.targetId)
      assert.equal(registry.value.host_document_id, slot('document', f.source.hostId).targetId)
      assert.equal(parseSyncedBlockPayload(String(leaf.value.content)).groupId, group.targetId)
    }
    const headers = rows(prepared.value, 'synced_groups'), currentHeader = headers.find(entry => entry.value.id === f.ids.groupId)!
    assert.equal(currentHeader.row.sourceRef.side, 'current')
    assert.equal(currentHeader.value.creation_id, f.currentGroup.creationId)
    assert.equal(currentHeader.value.created_at, f.currentGroup.createdAt)
    assert.equal(currentHeader.value.origin_json, f.currentRaw.origin_json)
    assert.equal(currentHeader.value.bindings_json, f.currentRaw.bindings_json)
    const retainedWire = candidate.activeGroupWires.find(wire => wire.id === f.ids.groupId)!
    assert.deepEqual(retainedWire.origin, f.currentGroup.origin)
    assert.deepEqual(retainedWire.bindings, f.currentGroup.bindings)
    assert.deepEqual(retainedWire.blocks, f.currentGroup.blocks)
    const currentInstance = rows(prepared.value, 'synced_instances').find(entry => entry.value.instance_id === f.ids.instanceId)!
    assert.equal(currentInstance.row.sourceRef.side, 'current')
    assert.equal(currentInstance.value.group_id, f.ids.groupId)
    const sourceOrigin = allocation.origins.find(origin => origin.side === 'source' && origin.sourceGroupId === f.ids.groupId)!
    assert.equal(sourceOrigin.documentProof, 'qualified-missing')
    assert.notEqual(sourceOrigin.origin.documentId, f.source.hostId)
    assert.notEqual(sourceOrigin.origin.documentId, slot('document', f.source.hostId).targetId)
    assert.notEqual(sourceOrigin.origin.documentId, f.current.hostId)
    assert.equal(rows(prepared.value, 'documents').some(entry => entry.value.id === sourceOrigin.origin.documentId), false)
    assert.equal(sourceOrigin.firstInstanceProof, 'proved-historical-birth')
    assert.equal(sourceOrigin.firstInstanceKnownBirth, f.sourceFirstBirth)
    assert.equal(sourceOrigin.origin.firstInstanceId, slot('block', f.ids.instanceId).targetId)
    const currentOrigin = allocation.origins.find(origin => origin.side === 'current' && origin.sourceGroupId === f.ids.groupId)!
    assert.equal(currentOrigin.originPolicy, 'retained-current')
    assert.deepEqual(currentOrigin.origin, f.currentGroup.origin)
    const sourceTargets = allocation.bindingTargets.filter(target => target.side === 'source' && target.sourceGroupId === f.ids.groupId)
    assert.ok(sourceTargets.length > 0)
    for (const target of sourceTargets) {
      assert.equal(target.proofKind, 'qualified-missing')
      assert.equal(target.target.kind, 'block')
      if (target.target.kind === 'block') {
        assert.equal(target.target.state, 'missing'); assert.equal(target.target.documentId, null)
        assert.notEqual(target.target.id, f.source.targetBodyId)
        assert.notEqual(target.target.id, f.current.targetBodyId)
      }
    }
    assert.equal(allocation.baseIdentityAllocationHash, base.value.allocationHash)
    assert.notEqual(allocation.derivedReferenceAllocationHash, base.value.allocationHash)
    assert.deepEqual(await readFile(join(base.directory, 'manifest.json')), baseBytes)
    assert.equal(candidate.referenceRewriteComplete, false); assert.equal(candidate.permit, false)
    assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.current.db), f.beforeCurrent)
  }))

test('the explicit exact-current-tuple policy keeps current Origin bytes without upgrading incoming typed hints or mutating the old identity owner', () =>
  withCanonical3Fixture(async f => {
    const base = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const baseBytes = await readFile(join(base.directory, 'manifest.json'))
    const prepared = await prepareRootRestoreReferencePlan3(base.plan, {
      originPolicy: 'preserve-exact-current-tuple', anonymousValues: 'source'
    })
    const { allocation, candidate } = prepared.value
    assert.equal(allocation.forcedGroupForks.length, 0)
    for (const sourceGroup of f.sourcePacket.knowledge.groups) {
      const currentGroup = f.currentPacket.knowledge.groups.find(group => group.comparisonKey === sourceGroup.comparisonKey)!
      assert.ok(currentGroup, 'The real evolving Store preserved the exact immutable tuple')
      const sourceOrigin = allocation.origins.find(origin => origin.side === 'source' && origin.sourceGroupId === sourceGroup.tuple.groupId)!
      assert.equal(sourceOrigin.originPolicy, 'retained-current')
      assert.equal(sourceOrigin.documentProof, 'current-domain-preserved')
      assert.equal(sourceOrigin.targetGroupId, currentGroup.tuple.groupId)
      assert.equal(sourceOrigin.targetCreationId, currentGroup.tuple.creationId)
      assert.deepEqual(sourceOrigin.origin, currentGroup.tuple.origin)
      const header = rows(prepared.value, 'synced_groups').find(entry => entry.value.id === currentGroup.tuple.groupId)!
      assert.equal(header.value.origin_json, currentGroup.originalOriginJson)
    }
    const currentExtra = rows(prepared.value, 'synced_instances').find(entry => entry.value.instance_id === f.cases.externalInstanceId)!
    assert.equal(currentExtra.row.sourceRef.side, 'current')
    assert.equal(currentExtra.value.group_id, f.cases.groupId)
    const incomingTyped = allocation.bindingTargets.filter(target => target.side === 'source' && target.originalTarget.kind !== 'unresolved-url')
    assert.ok(incomingTyped.length > 0)
    for (const target of incomingTyped) {
      assert.equal(target.proofKind, 'qualified-missing', 'Reusing Origin is not historical target-birth proof')
      assert.ok('state' in target.target && target.target.state === 'missing')
    }
    assert.equal(allocation.baseIdentityAllocationHash, base.value.allocationHash)
    assert.notEqual(allocation.derivedReferenceAllocationHash, base.value.allocationHash)
    assert.deepEqual(await readRootRestoreIdentityPlan3(base.plan), base.value)
    assert.deepEqual(await readFile(join(base.directory, 'manifest.json')), baseBytes)
    assert.equal(allocation.execution.finalCurrentRetainedCutComplete, false)
    assert.equal(candidate.materialization.actualLifecycleRowsReady, false)
    assert.equal(candidate.referenceRewriteComplete, false); assert.equal(candidate.permit, false)
    assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  }))
