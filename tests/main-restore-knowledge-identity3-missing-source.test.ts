import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { withContent3Fixture } from './helpers/content3-fixture'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'

test('complete original reader retains occupied historical missing maps while allocation refuses physical retained-ledger and template targets', () => {
  let sourceIds: string[] = [], occupiedTargets: string[] = []
  return withContent3Fixture(async f => {
    const { value } = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    for (let index = 0; index < sourceIds.length; index++) {
      const assignment = value.assignments.find(item => item.kind === 'block' && item.sourceId === sourceIds[index] && !item.physical)!
      assert.notEqual(assignment.targetId, occupiedTargets[index]); assert.equal(assignment.reason, 'forked-collision')
      assert.equal(assignment.state, 'missing-reservation')
      assert.equal(f.currentPacket.knowledge.restoreLineage.some(row => row.sourceId === sourceIds[index] && row.state === 'missing' && row.targetId === occupiedTargets[index]), true)
      assert.equal(f.currentPacket.source.physical.identities.some(identity => identity.id === assignment.targetId), false)
      assert.equal(f.source.db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(assignment.targetId), undefined)
    }
    assert.equal(value.permit, false)
  }, source => {
    const documentId = source.store.createDocument(null), retainedId = randomUUID()
    source.store.updateDocument(documentId, { title: 'Deleted original identity', summary: '', blocks: [
      { id: retainedId, type: 'paragraph', content: 'Must stay retained', checked: false, depth: 0, parentBlockId: null }
    ] })
    source.store.deleteDocument(documentId)
    assert.equal((source.db.prepare('SELECT state FROM block_identities WHERE id=?').get(retainedId) as { state: string }).state, 'retained')
    assert.equal(source.db.prepare('SELECT 1 FROM blocks WHERE id=?').get(retainedId), undefined)
    occupiedTargets = [source.hostBodyId, retainedId, sourceIds[0]]
    const save = source.db.prepare('INSERT INTO backup_restore_identities(lineage,kind,source_database_id,source_id,state,target_id) VALUES(?,?,?,?,?,?)')
    sourceIds.forEach((id, index) => save.run(source.catalogId, 'block', '', id, 'missing', occupiedTargets[index]))
  }, source => {
    const template = source.store.saveDocumentTemplate({ name: 'Missing source identities', title: 'Missing', summary: '', blocks:
      [0, 1, 2].map(index => ({ type: 'paragraph', content: 'Unregistered template ' + index, checked: false, depth: 0, parentBlockId: null })) })
    sourceIds = template.blocks.map(block => block.id!)
    sourceIds.forEach(id => assert.equal(source.db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(id), undefined))
  })
})
