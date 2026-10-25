import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { withContent3Fixture } from './helpers/content3-fixture'

test('complete Main identity allocation reuses exact current live and missing lineage while protecting a different physical document birth', () => {
  const missingTarget = randomUUID()
  let missingSource = '', lineage = '', columnId = '', changedDocument = ''
  return withContent3Fixture(async f => {
    const { value } = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const missing = value.assignments.find(item => item.kind === 'block' && item.sourceId === missingSource && !item.physical)!
    assert.equal(missing.targetId, missingTarget); assert.equal(missing.reason, 'lineage'); assert.equal(missing.state, 'missing-reservation')
    const column = value.assignments.find(item => item.kind === 'column' && item.sourceId === columnId && item.physical)!
    assert.equal(column.targetId, columnId); assert.equal(column.reason, 'lineage')
    const document = value.assignments.find(item => item.kind === 'document' && item.sourceId === changedDocument && item.physical)!
    assert.notEqual(document.targetId, document.sourceId); assert.equal(document.reason, 'forked-collision')
    const child = value.assignments.find(item => item.kind === 'block' && item.sourceId === f.source.targetBodyId && item.physical)!
    assert.notEqual(child.targetId, child.sourceId)
    assert.equal(value.sourceCatalogId, lineage)
    assert.equal(f.currentPacket.source.physical.identities.some(identity => identity.id === missingTarget), false)
    assert.equal(f.currentPacket.source.physical.documents.some(document => document.documentId === missingTarget), false)
  }, (source, original) => {
    lineage = source.catalogId; columnId = source.catalogColumn.id; changedDocument = source.targetId
    const known = original.knowledge.occupancy.find(item => item.namespace === 'block' && item.kind === 'template')!
    missingSource = known.id
    const save = source.db.prepare('INSERT INTO backup_restore_identities(lineage,kind,source_database_id,source_id,state,target_id) VALUES(?,?,?,?,?,?)')
    save.run(lineage, 'block', '', missingSource, 'missing', missingTarget)
    save.run(lineage, 'column', lineage, columnId, 'live', columnId)
    save.run(lineage, 'document', '', changedDocument, 'live', changedDocument)
    source.db.prepare('UPDATE documents SET created_at=? WHERE id=?').run('2080-01-02T03:04:05.000Z', changedDocument)
  })
})
