import assert from 'node:assert/strict'
import test from 'node:test'
import { basename } from 'node:path'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreStructureReferencePlan3 } from '../src/main/database/restore-knowledge-structure3-read'
import { captureActualFirstRequiredSqlDag } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3 } from '../src/main/database/restore-knowledge-root3-read'
import { graph3Rows } from '../src/main/database/restore-knowledge-graph3-data'
import { parseSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import { captureMixedSource } from './helpers/mixed-required-source-fixture'
import { withV3Fixture, allTables, randomUUID, createRequest, created, freshBlock, applySyncedHostCommand } from './helpers/synced-backup-v3-fixture'

test('independent real Main group incarnations fork every canonical parent child and host payload consistently', () =>
  withV3Fixture(source => withV3Fixture(async current => {
    const root = randomUUID(), child = randomUUID(), groupId = randomUUID()
    const leftRequest = createRequest(source.db, { documentId: source.hostId, groupId, selectedRootIds: [root], dirty(working) {
      working.blocks.push({ ...freshBlock(root, 'Nested canonical root'), type: 'callout' },
        { ...freshBlock(child, 'Nested canonical child'), depth: 1, parentBlockId: root })
    } })
    const leftAck = created(applySyncedHostCommand(source.db, leftRequest))
    const rightRequest = createRequest(current.db, { documentId: current.hostId, groupId, selectedRootIds: [current.hostBodyId] })
    const rightAck = created(applySyncedHostCommand(current.db, rightRequest))
    assert.notEqual(leftAck.createdLifecycle.creationId, rightAck.createdLifecycle.creationId)
    const left = await captureMixedSource(source, 2)
    // Both immutable original owners live in one fixed catalog. The current
    // SQL is a real independent Store; the helper backs it up into that catalog.
    // This fixture has no managed file URLs requiring a second asset root.
    const right = await captureMixedSource({ ...current, userDataRoot: source.userDataRoot }, 2)
    const dag = await captureActualFirstRequiredSqlDag({ profileRoot: source.userDataRoot,
      operationId: basename(left.original.info.recoveryDirectory), dagId: randomUUID(), source: left.handle, current: right.handle })
    const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
    const captured = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: current.userDataRoot,
      operationId: randomUUID(), sourceDirectory: exported.directory })
    const beforeSource = allTables(source.db), beforeCurrent = allTables(current.db)
    const identity = await prepareRootRestoreIdentityPlan3(captured.knowledgePlan)
    const { value } = await prepareRootRestoreStructureReferencePlan3(identity.plan)
    const rows = (name: string) => graph3Rows({ tables: value.tables, encoding: 'UTF-8' }, name).map(row => row.value)
    const slot = (kind: string, id: string) => identity.value.assignments.find(item => item.kind === kind && item.sourceId === id && item.physical)!
    const group = slot('group', groupId), mappedRoot = slot('block', root), mappedChild = slot('block', child)
    assert.equal(group.requiresExplicitForkDecision, true)
    assert.notEqual(group.targetId, groupId)
    assert.notEqual(group.targetCreationId, leftAck.createdLifecycle.creationId)
    for (const item of [mappedRoot, mappedChild]) assert.notEqual(item.targetId, item.sourceId)
    // The independent current has no occupant at this host instance ID. Its
    // free identity may stay; the group reference must still follow the fork.
    assert.equal(slot('block', leftRequest.action.instanceId).reason, 'preserved-free')
    const header = rows('synced_groups').find(row => row.id === group.targetId)!
    assert.equal(header.creation_id, group.targetCreationId)
    const parent = rows('synced_group_blocks').find(row => row.id === mappedRoot.targetId)!
    const descendant = rows('synced_group_blocks').find(row => row.id === mappedChild.targetId)!
    assert.equal(parent.group_id, group.targetId); assert.equal(parent.parent_block_id, null)
    assert.equal(descendant.group_id, group.targetId); assert.equal(descendant.parent_block_id, mappedRoot.targetId)
    const instanceId = slot('block', leftRequest.action.instanceId).targetId
    const instance = rows('synced_instances').find(row => row.instance_id === instanceId)!
    const leaf = rows('blocks').find(row => row.id === instanceId)!
    assert.equal(instance.group_id, group.targetId)
    assert.equal(instance.host_document_id, slot('document', source.hostId).targetId)
    assert.equal(leaf.document_id, instance.host_document_id)
    assert.equal(parseSyncedBlockPayload(String(leaf.content)).groupId, group.targetId)
    const originalHeader = source.db.prepare('SELECT origin_json,bindings_json FROM synced_groups WHERE id=?').get(groupId) as { origin_json: string; bindings_json: string }
    assert.equal(header.origin_json, originalHeader.origin_json)
    assert.equal(header.bindings_json, originalHeader.bindings_json)
    assert.equal(value.provenanceReferencesRewritten, false); assert.equal(value.linkBindingsRewritten, false)
    assert.equal(value.referenceRewriteComplete, false); assert.equal(value.permit, false)
    assert.deepEqual(allTables(source.db), beforeSource); assert.deepEqual(allTables(current.db), beforeCurrent)
  })))
