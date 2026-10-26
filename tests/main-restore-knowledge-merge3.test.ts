import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { graph3Encode, graph3Rows, graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import { prepareRootRestoreIdentityPlan3, readRootRestoreIdentityGraphInputs3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreMergedContentPlan3, readRootRestoreMergedContentPlan3 } from '../src/main/database/restore-knowledge-merge3-read'
import { checkMerge3NativeStorage3 } from '../src/main/database/restore-knowledge-merge3-native'
import { MERGE3_CONTENT_TABLES, type Merge3ContentTable, type Merge3OriginalRowRef } from '../src/main/database/restore-knowledge-merge3-storage'
import { allTables } from './helpers/synced-backup-v3-fixture'
import { tamperContent3VerificationOriginals } from './helpers/content3-fixture'
import { withMerge3Fixture, type Merge3Fixture } from './helpers/merge3-fixture'

type Value = Awaited<ReturnType<typeof prepareRootRestoreMergedContentPlan3>>['value']
function rows(value: Value, name: Merge3ContentTable) {
  const table = value.tables.find(table => table.name === name)!
  assert.ok(table)
  return table.rows.map(row => ({ row, table, values: Object.fromEntries(table.columns.map((column, index) => {
    const cell = row.cells[index]
    return [column, cell[0] === 'null' ? null : cell[0] === 'text' ? graph3Text(cell, table.encoding)
      : cell[0] === 'integer' ? BigInt(cell[1]) : cell[0] === 'real-ieee754-le' ? Buffer.from(cell[1], 'hex').readDoubleLE() : Buffer.from(cell[1], 'base64')]
  })) as Record<string, unknown> }))
}
function originals(f: Merge3Fixture, side: 'source' | 'current', name: Merge3ContentTable) {
  return graph3Rows((side === 'source' ? f.sourcePacket : f.currentPacket).source.sourceContent, name)
}
const anonymous = (value: Value) => rows(value, 'document_database_values')
  .filter(entry => entry.values.document_id === null && entry.values.entity_id === null)
const refKey = (ref: Merge3OriginalRowRef) => capsuleJson([ref.side, ref.table, ref.sourceRowId])

test('actual Main merged content preserves complete source forests current-only families original occurrences and private preview ownership', t => withMerge3Fixture(async f => {
  const identity = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
  const unresolved = await prepareRootRestoreMergedContentPlan3(identity.plan)
  const mutableChoice: { anonymousValues: 'source' | 'current' | 'unresolved' } = { anonymousValues: 'source' }
  const source = await prepareRootRestoreMergedContentPlan3(identity.plan, mutableChoice)
  mutableChoice.anonymousValues = 'current'
  const current = await prepareRootRestoreMergedContentPlan3(identity.plan, { anonymousValues: 'current' })
  const actual = await readRootRestoreIdentityGraphInputs3(identity.plan), value = source.value, c = f.merge
  const mapped = (kind: 'document' | 'block' | 'group', id: string) => {
    const assignments = identity.value.assignments.filter(item => item.kind === kind && item.sourceId === id && item.physical)
    assert.equal(assignments.length, 1); return assignments[0].targetId
  }
  function checkRef(ref: Merge3OriginalRowRef, name: Merge3ContentTable) {
    assert.equal(ref.table, name)
    const packet = ref.side === 'source' ? f.sourcePacket : f.currentPacket
    const table = packet.source.sourceContent.tables.find(table => table.name === name)!
    const original = table.rows.find(row => row.sourceRowId === ref.sourceRowId)
    assert.ok(original)
    const payloads = actual.inputs.knowledge.constraints.payloads.filter(payload => !payload.witness.domain.length && payload.witness.side === ref.side)
    assert.equal(payloads.length, 1); assert.equal(ref.payload, payloads[0].key)
    assert.equal(ref.materialHash, actual.inputs[ref.side].materialHash)
    assert.deepEqual(ref.witness, payloads[0].witness)
    assert.equal(ref.originalRowHash, capsuleBytesHash('knowbook.restore.merge3.original-row.v1\0' + capsuleJson({
      table: name, columns: table.columns, primaryKey: table.primaryKey, encoding: packet.source.sourceContent.encoding,
      sourceRowId: original.sourceRowId, cells: original.cells
    })))
    return original
  }

  await t.test('all twelve selected tables retain complete typed original refs dispositions and target rowid provenance', () => {
    assert.deepEqual(value.tables.map(table => table.name), [...MERGE3_CONTENT_TABLES])
    assert.equal(value.storage.length, 12)
    for (const table of value.tables) {
      const storage = value.storage.find(item => item.name === table.name)!
      const expected = (['source', 'current'] as const).flatMap(side => originals(f, side, table.name)
        .map(entry => capsuleJson([side, table.name, entry.original.sourceRowId])))
      assert.deepEqual(storage.dispositions.map(item => refKey(item.sourceRef)).sort(), expected.sort())
      assert.equal(new Set(storage.dispositions.map(item => item.rowKey)).size, expected.length)
      assert.deepEqual(table.rows.map(row => row.key).sort(), storage.dispositions.filter(item => item.status === 'selected').map(item => item.rowKey).sort())
      assert.equal(new Set(table.rows.map(row => row.targetRowId)).size, table.rows.length)
      for (const disposition of storage.dispositions) checkRef(disposition.sourceRef, table.name)
      for (const row of table.rows) {
        const original = checkRef(row.sourceRef, table.name)
        assert.ok(BigInt(row.targetRowId) >= -(2n ** 63n) && BigInt(row.targetRowId) < 2n ** 63n)
        if (row.sourceRef.side === 'current') {
          assert.equal(row.targetRowId, row.sourceRef.sourceRowId)
          if (table.name !== 'documents') assert.deepEqual(row.cells, original.cells)
        }
        if (row.replaces) {
          assert.equal(row.sourceRef.side, 'source'); assert.equal(row.replaces.side, 'current')
          checkRef(row.replaces, table.name); assert.equal(row.targetRowId, row.replaces.sourceRowId)
        }
      }
    }
    assert.match(value.mergedContentHash, /^[0-9a-f]{64}$/); assert.match(value.checkedMergeHash, /^[0-9a-f]{64}$/)
    assert.equal(value.candidateConflictFree, true); assert.deepEqual(value.conflicts, [])
    assert.equal(value.nativeStorageChecks.engine, 'SQLite'); assert.equal(value.nativeStorageChecks.foreignKeysValidated, false)
    for (const flag of ['referenceRewriteComplete', 'semanticValidationComplete', 'acceptedCoverage', 'effective', 'permit'] as const)
      assert.equal(value[flag], false)
  })

  await t.test('the entire selected host forest comes from source while replaced current children keep their original dispositions', () => {
    const host = mapped('document', f.source.hostId), selected = rows(value, 'blocks').filter(entry => entry.values.document_id === host)
    const incoming = originals(f, 'source', 'blocks').filter(entry => entry.value.document_id === f.source.hostId)
    assert.deepEqual(selected.map(entry => entry.values.id).sort(), incoming.map(entry => mapped('block', String(entry.value.id))).sort())
    for (const id of [c.currentParentBlockId, c.currentChildBlockId]) {
      assert.equal(rows(value, 'blocks').some(entry => entry.values.id === id), false)
      const original = originals(f, 'current', 'blocks').find(entry => entry.value.id === id)!
      const disposition = value.storage.find(table => table.name === 'blocks')!.dispositions
        .find(item => item.sourceRef.side === 'current' && item.sourceRef.sourceRowId === original.original.sourceRowId)!
      assert.equal(disposition.status, 'replaced')
      assert.ok(value.removedCurrentRows.some(ref => refKey(ref) === refKey(disposition.sourceRef)))
    }
    assert.equal(rows(value, 'blocks').find(entry => entry.values.id === mapped('block', f.source.targetBodyId))!.values.content, f.raw)
  })

  await t.test('current-only documents descendants and exact retained slugs survive the final whole document layout', () => {
    const documents = rows(value, 'documents'), host = documents.find(entry => entry.values.id === mapped('document', f.source.targetId))!
    assert.equal(host.values.title, c.sourceTitle)
    for (const id of [c.retainedDocumentId, c.retainedChildId, c.retainedDescendantId, c.orphanHostId]) {
      const selected = documents.find(entry => entry.values.id === id)!, original = originals(f, 'current', 'documents').find(entry => entry.value.id === id)!
      assert.equal(selected.row.sourceRef.side, 'current'); assert.equal(selected.values.slug, original.value.slug)
      const parent = selected.values.parent_id === null ? null : documents.find(entry => entry.values.id === selected.values.parent_id)!
      assert.equal(selected.values.path, parent === null ? selected.values.title : String(parent.values.path) + '/' + String(selected.values.title))
      assert.equal(selected.values.block_count, BigInt(rows(value, 'blocks').filter(entry => entry.values.document_id === id).length))
    }
    const descendant = documents.find(entry => entry.values.id === c.retainedDescendantId)!
    assert.equal(descendant.values.path, c.sourceTitle + '/Retained descendant')
    assert.notEqual(descendant.values.path, originals(f, 'current', 'documents').find(entry => entry.value.id === c.retainedDescendantId)!.value.path)
    assert.equal(host.values.child_count, 1n)
    for (const id of [c.retainedBodyId, c.retainedChildBodyId, c.retainedDescendantBodyId])
      assert.equal(rows(value, 'blocks').find(entry => entry.values.id === id)!.row.sourceRef.side, 'current')
    assert.ok(value.layout.changes.some(change => change.targetDocumentId === c.retainedDescendantId && change.column === 'path'))
  })

  await t.test('source canonical forests close over retained external Main instances and genuine current orphan groups', () => {
    const group = mapped('group', f.source.groupId), canonical = rows(value, 'synced_group_blocks').filter(entry => entry.values.group_id === group)
    const incoming = originals(f, 'source', 'synced_group_blocks').filter(entry => entry.value.group_id === f.source.groupId)
    assert.deepEqual(canonical.map(entry => entry.values.id).sort(), incoming.map(entry => mapped('block', String(entry.value.id))).sort())
    assert.equal(rows(value, 'synced_group_blocks').some(entry => entry.values.id === c.currentCanonicalBlockId), false)
    for (const entry of canonical) {
      assert.equal(entry.row.sourceRef.side, 'source')
      assert.equal(entry.values.content, incoming.find(item => mapped('block', String(item.value.id)) === entry.values.id)!.value.content)
    }
    const external = rows(value, 'synced_instances').find(entry => entry.values.instance_id === c.externalInstanceId)!
    assert.equal(external.row.sourceRef.side, 'current'); assert.equal(external.values.host_document_id, c.retainedDocumentId)
    assert.equal(external.values.group_id, group)
    assert.equal(rows(value, 'synced_groups').find(entry => entry.values.id === c.orphanGroupId)!.row.sourceRef.side, 'current')
    assert.equal(rows(value, 'synced_group_blocks').find(entry => entry.values.id === c.orphanCanonicalBlockId)!.row.sourceRef.side, 'current')
    assert.equal(rows(value, 'synced_instances').some(entry => entry.values.group_id === c.orphanGroupId), false)
    const groups = new Set(rows(value, 'synced_groups').map(entry => entry.values.id)), instances = rows(value, 'synced_instances')
    const refs = rows(value, 'blocks').filter(entry => entry.values.type === 'synced-block')
    assert.deepEqual(refs.map(entry => entry.values.id).sort(), instances.map(entry => entry.values.instance_id).sort())
    for (const instance of instances) {
      assert.ok(groups.has(instance.values.group_id))
      const block = refs.find(entry => entry.values.id === instance.values.instance_id)!
      assert.equal(block.values.document_id, instance.values.host_document_id)
      assert.equal(JSON.parse(String(block.values.content)).groupId, instance.values.group_id)
    }
    assert.equal(value.physical.originalGroupActivityPreserved, true)
  })

  await t.test('same-workspace same-birth templates replace exactly and current-only catalog definitions values and templates remain', () => {
    const template = rows(value, 'document_templates').find(entry => entry.values.id === c.sharedTemplateId)!
    assert.equal(template.row.sourceRef.side, 'source'); assert.ok(template.row.replaces)
    const oldSource = originals(f, 'source', 'document_templates').find(entry => entry.value.id === c.sharedTemplateId)!
    const oldCurrent = originals(f, 'current', 'document_templates').find(entry => entry.value.id === c.sharedTemplateId)!
    assert.equal(oldSource.value.created_at, oldCurrent.value.created_at)
    assert.notEqual(oldSource.value.title, oldCurrent.value.title); assert.equal(template.values.title, oldSource.value.title)
    for (const [name, id] of [['document_templates', c.currentTemplateId], ['databases', c.currentDatabaseId],
      ['document_database_columns', c.currentColumnId], ['database_entities', c.currentEntityId],
      ['database_saved_views', c.currentViewId], ['database_saved_views', c.currentSharedDatabaseViewId]] as const)
      assert.equal(rows(value, name).find(entry => entry.values.id === id)!.row.sourceRef.side, 'current')
    assert.equal(rows(value, 'database_entity_values').find(entry => entry.values.entity_id === c.currentEntityId)!.values.value_text, 'Retained entity value')
    assert.equal(rows(value, 'document_database_values').find(entry => entry.values.document_id === c.retainedDocumentId)!.values.value_text, 'Retained current document value')
  })

  await t.test('anonymous NULL-key value collections remain separate occurrences and require one finite whole-family choice', () => {
    const conflict = unresolved.value.conflicts.find(conflict => conflict.code === 'anonymous-value-collections-require-explicit-whole-choice')!
    assert.ok(conflict); assert.equal(conflict.rowKeys.length, 4); assert.equal(new Set(conflict.rowKeys).size, 4)
    assert.equal(unresolved.value.candidateConflictFree, false)
    for (const [candidate, side, rowIds] of [[unresolved.value, 'current', c.currentAnonymousRowIds],
      [source.value, 'source', c.sourceAnonymousRowIds], [current.value, 'current', c.currentAnonymousRowIds]] as const) {
      const selected = anonymous(candidate)
      assert.equal(selected.length, 2)
      assert.deepEqual(selected.map(entry => entry.row.sourceRef.sourceRowId).sort(), [...rowIds].sort())
      for (const entry of selected) assert.equal(entry.row.sourceRef.side, side)
      assert.deepEqual(selected[0].row.cells, selected[1].row.cells)
      assert.notEqual(selected[0].row.sourceRef.sourceRowId, selected[1].row.sourceRef.sourceRowId)
    }
    assert.equal(current.value.candidateConflictFree, true)
    assert.equal(source.value.conflicts.some(conflict => conflict.code === 'anonymous-value-collections-require-explicit-whole-choice'), false)
    assert.notEqual(source.value.checkedMergeHash, current.value.checkedMergeHash)
    assert.notEqual(source.value.mergedContentHash, current.value.mergedContentHash)
  })

  await t.test('a separate candidate DTO native NOCASE probe reports every conflicting row without claiming Main authentication', () => {
    // This is a deliberate pure candidate mutation for the native comparator,
    // never a source original or a DTO passed to the Main owner factory.
    const original = rows(value, 'database_saved_views').find(entry => entry.values.id === f.source.view.id)!
    const extra = rows(value, 'database_saved_views').find(entry => entry.values.id === c.currentSharedDatabaseViewId)!
    assert.equal(original.values.database_id, extra.values.database_id)
    const changed = value.tables.map(table => table.name !== 'database_saved_views' ? table : { ...table,
      rows: table.rows.map(row => row.key !== extra.row.key ? row : { ...row, cells: row.cells.map((cell, index) =>
        table.columns[index] === 'name' ? graph3Encode(String(original.values.name).toUpperCase(), table.encoding) : cell) }) })
    const native = checkMerge3NativeStorage3(changed)
    const conflict = native.conflicts.find(item => item.code === 'native-nocase-saved-view-name-duplicate')!
    assert.ok(conflict); assert.deepEqual([...conflict.rowKeys].sort(), [original.row.key, extra.row.key].sort())
    assert.equal(native.sourceSqlRead, false); assert.equal(native.permit, false)
  })

  await t.test('private owners freeze finite choices reject copied or getter inputs and reauthenticate hot kernel and verification SQL', async () => {
    let touched = 0
    const fake = Object.defineProperty({}, 'kind', { get() { touched++; throw new Error('caller owner getter') } })
    const choice = Object.defineProperty({}, 'anonymousValues', { enumerable: true, get() { touched++; throw new Error('caller choice getter') } })
    await assert.rejects(prepareRootRestoreMergedContentPlan3(fake as never))
    await assert.rejects(prepareRootRestoreMergedContentPlan3({ ...identity.plan }))
    await assert.rejects(readRootRestoreMergedContentPlan3(fake as never))
    await assert.rejects(readRootRestoreMergedContentPlan3({ ...source.plan }))
    await assert.rejects(readRootRestoreMergedContentPlan3(source.value as never))
    await assert.rejects(prepareRootRestoreMergedContentPlan3(identity.plan, choice as never))
    await assert.rejects(prepareRootRestoreMergedContentPlan3(identity.plan, { anonymousValues: 'both' } as never))
    await assert.rejects(prepareRootRestoreMergedContentPlan3(identity.plan, { anonymousValues: 'source', callback: () => null } as never))
    assert.equal(touched, 0); assert.equal(source.value.choices.anonymousValues, 'source')
    assert.equal(Object.isFrozen(source.value.tables[0].rows), true)
    assert.deepEqual(await readRootRestoreMergedContentPlan3(source.plan), source.value)
    const manifestPath = join(identity.directory, 'manifest.json'), manifest = await readFile(manifestPath)
    await writeFile(manifestPath, '{}\n')
    await assert.rejects(readRootRestoreMergedContentPlan3(source.plan))
    await writeFile(manifestPath, manifest)
    assert.deepEqual(await readRootRestoreMergedContentPlan3(source.plan), source.value)
    await tamperContent3VerificationOriginals(f.receiver.userDataRoot)
    await assert.rejects(readRootRestoreMergedContentPlan3(source.plan))
  })
  assert.deepEqual(allTables(f.source.db), f.beforeSource)
  assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
}))
