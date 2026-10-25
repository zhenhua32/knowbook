import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { withContent3Fixture } from './helpers/content3-fixture'
import { allTables } from './helpers/synced-backup-v3-fixture'

test('actual current foreign lineage reservations cannot be bypassed by compatible physical births or an owned alias', t => {
  const foreign = randomUUID()
  return withContent3Fixture(async f => {
    const { value } = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const cases = [['document', f.source.targetId], ['block', f.source.targetBodyId], ['database', f.source.customId],
      ['column', f.source.catalogColumn.id], ['view', f.source.view.id], ['entity', f.source.entity.id]] as const
    for (const [kind, id] of cases) await t.test('foreign reservation protects the actual current ' + kind + ' target', () => {
      const original = f.sourcePacket.knowledge.occupancy.find(item => item.namespace === kind && item.id === id && item.kind === 'physical')!
      const current = f.currentPacket.knowledge.occupancy.find(item => item.namespace === kind && item.id === id && item.kind === 'physical')!
      assert.equal(original.knownBirth, current.knownBirth, 'The collision must survive the existing birth compatibility check')
      assert.equal(f.currentPacket.knowledge.restoreLineage.some(row => row.lineage === foreign && row.kind === kind && row.targetId === id), true)
      const assignment = value.assignments.find(item => item.kind === kind && item.sourceId === id && item.physical)!
      assert.notEqual(assignment.targetId, id, kind + ' must not overwrite a foreign reserved target')
      assert.equal(assignment.reason, 'forked-collision')
    })
    const catalog = value.assignments.find(item => item.kind === 'database' && item.sourceId === f.source.catalogId && item.physical)!
    assert.equal(catalog.targetId, f.source.catalogId); assert.equal(catalog.reason, 'catalog')
    assert.equal(value.permit, false)
    assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  }, source => {
    const save = source.db.prepare('INSERT INTO backup_restore_identities(lineage,kind,source_database_id,source_id,state,target_id) VALUES(?,?,?,?,?,?)')
    const targets = [['document', source.targetId], ['block', source.targetBodyId], ['database', source.customId],
      ['column', source.catalogColumn.id], ['view', source.view.id], ['entity', source.entity.id]] as const
    targets.forEach(([kind, target], index) => save.run(foreign, kind, '', randomUUID(), index % 2 ? 'missing' : 'live', target))
    // A precise owned alias does not make the other lineage disappear.
    save.run(source.catalogId, 'column', source.catalogId, source.catalogColumn.id, 'live', source.catalogColumn.id)
  })
})
