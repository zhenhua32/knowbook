import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { parseDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { parseSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import { deriveRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-model'
import { prepareRootRestoreIdentityPlan3, readRootRestoreIdentityGraphInputs3 } from '../src/main/database/restore-knowledge-identity3-read'
import { deriveRootRestoreStructureReferences3 } from '../src/main/database/restore-knowledge-structure3-model'
import { prepareRootRestoreStructureReferencePlan3, readRootRestoreStructureReferencePlan3 } from '../src/main/database/restore-knowledge-structure3-read'
import { graph3PatchTable, graph3Rows, type Graph3Inputs } from '../src/main/database/restore-knowledge-graph3-data'
import { withContent3Fixture, tamperContent3VerificationOriginals } from './helpers/content3-fixture'
import { allTables, applySyncedHostCommand, createRequest, created, freshBlock, oldChildId } from './helpers/synced-backup-v3-fixture'

test('actual complete originals rewrite physical document block and instance structure while retaining unresolved provenance and execution evidence', t => {
  const outer = randomUUID(), inner = randomUUID(), leaf = randomUUID(), viewAtom = randomUUID()
  let nestedGroup = '', nestedInstance = '', childDocument = ''
  return withContent3Fixture(async f => {
    const identity = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const prepared = await prepareRootRestoreStructureReferencePlan3(identity.plan), value = prepared.value
    const original = f.sourcePacket.source.sourceContent
    const content = { encoding: original.encoding, tables: value.tables }
    const rows = (table: string) => graph3Rows(content, table).map(row => row.value)
    const sourceRows = (table: string) => graph3Rows(original, table).map(row => row.value)
    const target = (kind: string, id: unknown) => {
      const slots = identity.value.assignments.filter(item => item.kind === kind && item.sourceId === id && item.physical)
      assert.equal(slots.length, 1)
      return slots[0].targetId
    }
    const byId = (table: string, id: string, column = 'id') => rows(table).find(row => row[column] === id)!
    await t.test('all document parents ordinary block parents and instance aliases use the same actual identity allocation', () => {
      for (const [kind, id] of [['document', f.source.hostId], ['document', childDocument], ['block', outer], ['block', nestedInstance]])
        assert.notEqual(target(kind, id), id)
      for (const row of sourceRows('documents')) {
        const mapped = byId('documents', target('document', row.id))
        assert.ok(mapped)
        assert.equal(mapped.parent_id, row.parent_id === null ? null : target('document', row.parent_id))
      }
      for (const row of sourceRows('blocks')) {
        const mapped = byId('blocks', target('block', row.id))
        assert.ok(mapped)
        assert.equal(mapped.document_id, target('document', row.document_id))
        assert.equal(mapped.parent_block_id, row.parent_block_id === null ? null : target('block', row.parent_block_id))
        if (row.type === 'synced-block') assert.equal(parseSyncedBlockPayload(String(mapped.content)).groupId,
          target('group', parseSyncedBlockPayload(String(row.content)).groupId))
      }
      const instance = byId('synced_instances', target('block', nestedInstance), 'instance_id')
      assert.equal(instance.host_document_id, target('document', f.source.hostId))
      assert.equal(instance.parent_block_id, target('block', outer))
      assert.equal(instance.group_id, target('group', nestedGroup))
      assert.equal(instance.depth, 1n)
      const hostLeaf = byId('blocks', String(instance.instance_id))
      assert.equal(hostLeaf.parent_block_id, instance.parent_block_id)
      assert.equal(hostLeaf.depth, instance.depth)
      for (const row of sourceRows('synced_group_blocks')) {
        const mapped = byId('synced_group_blocks', target('block', row.id))
        assert.equal(mapped.group_id, target('group', row.group_id))
        assert.equal(mapped.parent_block_id, row.parent_block_id === null ? null : target('block', row.parent_block_id))
      }
      for (const row of sourceRows('synced_groups')) {
        const assignment = identity.value.assignments.find(item => item.kind === 'group' && item.sourceId === row.id && item.physical)!
        assert.equal(byId('synced_groups', assignment.targetId).creation_id, assignment.targetCreationId)
      }
    })
    await t.test('database view mapping composes with structure mapping without rewriting opaque body or template-local references', () => {
      const atom = byId('blocks', target('block', viewAtom)), payload = parseDatabaseViewPayload(String(atom.content))
      assert.notEqual(target('database', f.source.customId), f.source.customId)
      assert.notEqual(target('column', f.source.customColumn.id), f.source.customColumn.id)
      assert.equal(atom.document_id, target('document', f.source.hostId))
      assert.equal(payload.databaseId, target('database', f.source.customId))
      assert.equal(payload.viewId, target('view', f.source.view.id))
      assert.deepEqual(payload.config.visibleFieldIds, [target('column', f.source.customColumn.id)])
      assert.equal(rows('blocks').some(row => row.content === f.raw), true)
      assert.deepEqual(value.tables.find(table => table.name === 'document_templates'), original.tables.find(table => table.name === 'document_templates'))
    })
    await t.test('complete rows preserve storage classes rowids paths Origin binding ranges and old execution cells', () => {
      assert.equal(value.tables.length, 12)
      const permittedChanges: Record<string, readonly string[]> = {
        documents: ['id', 'parent_id'], blocks: ['id', 'document_id', 'parent_block_id', 'content'],
        synced_groups: ['id', 'creation_id'], synced_group_blocks: ['id', 'group_id', 'parent_block_id', 'content'],
        synced_instances: ['instance_id', 'group_id', 'host_document_id', 'parent_block_id'],
        databases: ['id'], document_database_columns: ['id', 'database_id'], database_saved_views: ['id', 'database_id', 'config_json'],
        database_entities: ['id', 'database_id', 'document_id'], database_entity_values: ['entity_id', 'column_id'],
        document_database_values: ['column_id', 'document_id', 'entity_id']
      }
      for (const table of value.tables) {
        const before = original.tables.find(item => item.name === table.name)!
        assert.equal(table.role, 'content')
        assert.deepEqual(table.columns, before.columns)
        assert.deepEqual(table.primaryKey, before.primaryKey)
        assert.equal(table.rows.length, before.rows.length)
        table.rows.forEach((row, index) => {
          assert.equal(row.sourceRowId, before.rows[index].sourceRowId)
          table.columns.forEach((column, position) => {
            if (!(permittedChanges[table.name] ?? []).includes(column)) assert.deepEqual(row.cells[position], before.rows[index].cells[position])
          })
        })
      }
      const nested = byId('synced_groups', target('group', nestedGroup)), before = sourceRows('synced_groups').find(row => row.id === nestedGroup)!
      assert.notEqual(JSON.parse(String(nested.origin_json)).documentId, target('document', f.source.hostId))
      assert.equal(nested.origin_json, before.origin_json)
      assert.equal(nested.bindings_json, before.bindings_json)
      assert.ok(JSON.parse(String(nested.bindings_json)).length > 0)
      assert.equal(value.physicalStructureReferencesRewritten, true)
      assert.equal(value.physicalSyncedPayloadsRewritten, true)
      for (const flag of ['provenanceReferencesRewritten', 'linkBindingsRewritten', 'templateStructureReferencesRewritten',
        'currentRetentionMerged', 'referenceRewriteComplete', 'semanticValidationComplete', 'acceptedCoverage', 'effective', 'permit'] as const)
        assert.equal(value[flag], false)
      assert.equal(value.sourceHistoryReplayed, false)
      assert.equal(value.sourcePolicyReplayed, false)
    })
    await t.test('copied and accessor handles cannot mint an owner or execute caller getters', async () => {
      let accesses = 0
      const fake = Object.defineProperty({}, 'kind', { get() { accesses++; throw new Error('caller getter') } })
      await assert.rejects(prepareRootRestoreStructureReferencePlan3(fake as never))
      await assert.rejects(readRootRestoreStructureReferencePlan3(fake as never))
      await assert.rejects(prepareRootRestoreStructureReferencePlan3({ ...identity.plan }))
      await assert.rejects(readRootRestoreStructureReferencePlan3({ ...prepared.plan }))
      assert.equal(accesses, 0)
      assert.equal(Object.isFrozen(value.tables[0].rows), true)
      assert.deepEqual(await readRootRestoreStructureReferencePlan3(prepared.plan), value)
    })

    // These explicit model mutations are data-only negative cases. They are
    // not fabricated Main owners or evidence of an actual installed fork.
    const data = await readRootRestoreIdentityGraphInputs3(identity.plan)
    const patch = (changed: Graph3Inputs, tableName: string, transform: Parameters<typeof graph3PatchTable>[2]) => {
      const source = changed.inputs.source.source.sourceContent, index = source.tables.findIndex(table => table.name === tableName)
      Reflect.set(source.tables, index, graph3PatchTable(source.tables[index], source.encoding, transform))
    }
    await t.test('model owner birth duplicate targets and cross-owner parents cannot manufacture a coherent physical candidate', () => {
      for (const changes of [{ ownerId: f.source.targetId }, { birth: '1900-01-01T00:00:00.000Z' }]) {
        const changed = structuredClone(data)
        Object.assign(changed.value.assignments.find(item => item.kind === 'block' && item.sourceId === outer && item.physical)!, changes)
        assert.throws(() => deriveRootRestoreStructureReferences3(changed), /structure-allocation-owner-or-birth/)
      }
      const duplicate = structuredClone(data)
      Object.assign(duplicate.value.assignments.find(item => item.kind === 'document' && item.sourceId === childDocument && item.physical)!,
        { targetId: target('document', f.source.hostId) })
      assert.throws(() => deriveRootRestoreStructureReferences3(duplicate), /duplicate-target-structure-identity/)
      const ordinary = structuredClone(data)
      patch(ordinary, 'blocks', (row): Record<string, string | null | bigint> => row.id === outer ? { parent_block_id: f.source.targetBodyId } : {})
      assert.throws(() => deriveRootRestoreStructureReferences3(ordinary), /cross-owner-structure-parent/)
      const canonical = structuredClone(data)
      patch(canonical, 'synced_group_blocks', (row): Record<string, string | null | bigint> => row.id === leaf ? { parent_block_id: oldChildId } : {})
      assert.throws(() => deriveRootRestoreStructureReferences3(canonical), /cross-owner-structure-parent/)
      const instance = structuredClone(data)
      patch(instance, 'synced_instances', (row): Record<string, string | null | bigint> => row.instance_id === nestedInstance ? { depth: 0n } : {})
      assert.throws(() => deriveRootRestoreStructureReferences3(instance), /structure-instance-host-mismatch/)
    })
    await t.test('a model incarnation fork rewrites canonical parents group creation and strict host payloads together', () => {
      const changed = structuredClone(data)
      Object.assign(changed.inputs.current.knowledge.groups.find(group => group.tuple.groupId === nestedGroup)!, { comparisonKey: 'f'.repeat(64) })
      Object.assign(changed, { value: deriveRootRestoreIdentityPlan3(changed.inputs, changed.kernel) })
      const fork = deriveRootRestoreStructureReferences3(changed)
      const assigned = (kind: string, id: string) => changed.value.assignments.find(item => item.kind === kind && item.sourceId === id && item.physical)!
      const group = assigned('group', nestedGroup), root = assigned('block', inner), child = assigned('block', leaf)
      assert.notEqual(group.targetId, nestedGroup)
      assert.notEqual(group.targetCreationId, sourceRows('synced_groups').find(row => row.id === nestedGroup)!.creation_id)
      assert.notEqual(root.targetId, inner)
      assert.notEqual(child.targetId, leaf)
      const read = (table: string) => graph3Rows({ encoding: original.encoding, tables: fork.tables }, table).map(row => row.value)
      assert.equal(read('synced_groups').find(row => row.id === group.targetId)!.creation_id, group.targetCreationId)
      assert.equal(read('synced_group_blocks').find(row => row.id === child.targetId)!.parent_block_id, root.targetId)
      assert.equal(read('synced_group_blocks').find(row => row.id === root.targetId)!.group_id, group.targetId)
      const instanceId = assigned('block', nestedInstance).targetId
      assert.equal(parseSyncedBlockPayload(String(read('blocks').find(row => row.id === instanceId)!.content)).groupId, group.targetId)
      assert.equal(read('synced_instances').find(row => row.instance_id === instanceId)!.group_id, group.targetId)
      assert.equal(fork.referenceRewriteComplete, false)
      assert.equal(fork.permit, false)
    })
    await t.test('hot structure reads reject changed durable kernels and actual SQL verification originals', async () => {
      const path = join(identity.directory, 'manifest.json'), bytes = await readFile(path)
      await writeFile(path, '{}\n')
      await assert.rejects(readRootRestoreStructureReferencePlan3(prepared.plan))
      await writeFile(path, bytes)
      await tamperContent3VerificationOriginals(f.receiver.userDataRoot)
      await assert.rejects(readRootRestoreStructureReferencePlan3(prepared.plan))
    })
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  }, source => {
    const reserve = source.db.prepare('INSERT INTO backup_restore_identities(lineage,kind,source_database_id,source_id,state,target_id) VALUES(?,?,?,?,?,?)')
    for (const [kind, id] of [['document', source.hostId], ['document', childDocument], ['block', outer], ['block', nestedInstance],
      ['database', source.customId], ['column', source.customColumn.id], ['view', source.view.id]])
      reserve.run(randomUUID(), kind, '', randomUUID(), 'live', id)
  }, undefined, source => {
    childDocument = source.store.createDocument(source.hostId)
    const input = createRequest(source.db, { documentId: source.hostId, selectedRootIds: [inner], dirty(working) {
      working.blocks.push({ ...freshBlock(viewAtom, JSON.stringify({ version: 1, databaseId: source.customId, viewId: source.view.id,
        config: createDefaultDatabaseViewConfig('table', [source.customColumn.id]) })), type: 'database-view' },
      { ...freshBlock(outer, 'Outer toggle'), type: 'toggle' },
      { ...freshBlock(inner, 'Nested callout'), type: 'callout', depth: 1, parentBlockId: outer },
      { ...freshBlock(leaf, '[target](V3%20Target.md#target-heading)'), depth: 2, parentBlockId: inner })
    } })
    const result = applySyncedHostCommand(source.db, input)
    assert.equal(result.status, 'applied', JSON.stringify(result)); created(result)
    nestedGroup = input.action.groupId; nestedInstance = input.action.instanceId
    const templateRoot = randomUUID(), templateChild = randomUUID()
    source.store.saveDocumentTemplate({ name: 'Structure-local template', title: 'Local template', summary: 'Opaque template-local identifiers', blocks: [
      { id: templateRoot, type: 'toggle', content: 'template ' + outer, checked: false, depth: 0, parentBlockId: null },
      { id: templateChild, type: 'paragraph', content: 'opaque ' + nestedGroup, checked: false, depth: 1, parentBlockId: templateRoot }
    ] })
  })
})
