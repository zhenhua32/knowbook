import assert from 'node:assert/strict'
import test from 'node:test'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { diagnoseCapsule2RawContent, validateCapsule2RawContent } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { readInitialIncomingWorkspace } from '../src/main/database/synced-initial-incoming-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { decodedCapsule2Table, withCapsule2RawCopy, writeMixedOrdinary501 } from './helpers/capsule2-raw-fixture'

test('capsule2 raw content keeps a real mixed ordinary501 and Main group source without changing the public wire500 rule', () => withV3Fixture(async f => {
  const { title, template } = writeMixedOrdinary501(f)
  f.store.saveSetting('ai.apiKey', 'capsule2-private-test-secret')
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => readRawCapsule2ContentOwned(db), /owned事务/)
    const before = db.prepare('SELECT total_changes() AS count').get()
    assert.throws(() => db.transaction(() => readInitialIncomingWorkspace(db))(), /文档标题无效/)
    const raw = db.transaction(() => readRawCapsule2ContentOwned(db))()
    assert.equal(decodedCapsule2Table(raw, 'documents').find(row => row.id === f.targetId)?.title, title)
    assert.equal(decodedCapsule2Table(raw, 'synced_groups').length, 1)
    assert.equal(decodedCapsule2Table(raw, 'document_templates').find(row => row.id === template.id)?.blocks_json,
      (db.prepare('SELECT blocks_json FROM document_templates WHERE id=?').get(template.id) as { blocks_json: string }).blocks_json)
    assert.ok(decodedCapsule2Table(raw, 'synced_operations').length > 0)
    assert.equal(raw.semanticValidationComplete, false); assert.equal(raw.certified, false)
    const diagnostic = JSON.stringify(diagnoseCapsule2RawContent(raw))
    assert.equal(diagnostic.includes('capsule2-private-test-secret'), false)
    assert.equal(diagnostic.includes(title), false)
    assert.throws(() => validateCapsule2RawContent({ ...raw, certified: true }), /非授权状态/)
    assert.deepEqual(db.prepare('SELECT total_changes() AS count').get(), before)
  })
}))

test('capsule2 raw content preserves actual ordinary history rowid order and all NULL-composite-PK occurrences as unvalidated storage', () => withV3Fixture(async f => {
  const { title } = writeMixedOrdinary501(f)
  f.store.documentRecovery.checkpoint(f.targetId, 'edit', true)
  const detail = f.store.getDocumentDetail(f.targetId); assert.ok(detail)
  f.store.updateDocument(f.targetId, { title, summary: 'A real later ordinary summary', blocks: detail.blocks })
  f.store.documentRecovery.checkpoint(f.targetId, 'edit', true)
  // Legal SQLite legacy storage shape, deliberately not claimed to have a
  // valid semantic owner. Raw preparation must retain it for the later owner.
  const insert = f.db.prepare('INSERT INTO document_database_values(document_id,column_id,value_text,updated_at,entity_id) VALUES(NULL,?,?,?,NULL)')
  insert.run(f.catalogColumn.id, 'legacy A', '2048-01-02T03:04:05.000Z')
  insert.run(f.catalogColumn.id, 'legacy B', '2048-01-02T03:04:05.000Z')
  await withCapsule2RawCopy(f, db => {
    const raw = db.transaction(() => readRawCapsule2ContentOwned(db))(), history = raw.tables.find(table => table.name === 'document_history'); assert.ok(history)
    const actual = db.prepare('SELECT rowid FROM document_history ORDER BY rowid').safeIntegers(true).all() as Array<{ rowid: bigint }>
    assert.deepEqual(history.rows.map(row => row.sourceRowId), actual.map(row => row.rowid.toString()))
    const values = decodedCapsule2Table(raw, 'document_database_values').filter(row => row.document_id === null && row.entity_id === null)
    assert.deepEqual(values.map(row => row.value_text), ['legacy A', 'legacy B'])
    assert.equal(raw.state, 'raw-storage-only'); assert.equal(raw.semanticValidationComplete, false)
  })
}))

test('capsule2 raw content rejects unknown ordinary columns and preserves the unsupported source instead of silently pruning it', () => withV3Fixture(async f => {
  writeMixedOrdinary501(f)
  f.db.exec('ALTER TABLE documents ADD COLUMN future_content TEXT')
  f.db.prepare('UPDATE documents SET future_content=? WHERE id=?').run('must not disappear', f.targetId)
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => db.transaction(() => readRawCapsule2ContentOwned(db))(), /未知.*普通列/)
    assert.equal((db.prepare('SELECT future_content FROM documents WHERE id=?').get(f.targetId) as { future_content: string }).future_content, 'must not disappear')
  })
}))
