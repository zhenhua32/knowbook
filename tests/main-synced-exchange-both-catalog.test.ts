import assert from 'node:assert/strict'
import test from 'node:test'
import { withBothCatalog, renameBody } from './helpers/synced-exchange-both-catalog-fixture'
import { readyBoth, bothComponent, selectBoth, acceptedBoth, forkSummary, completed, readStrictHostDocument,
  localPortable, remoteActual, stateRow, converged } from './helpers/synced-exchange-both-fixture'
type Entity = { id: string; database_id: string; document_id: string | null; title: string; created_at: string }
type Value = { entity_id: string; column_id: string; value_text: string | null }
type Direct = { document_id: string; column_id: string; entity_id: string | null; value_text: string | null }

test('actual both clones all real document memberships and direct values while authored entity titles and database definitions stay exact', () => withBothCatalog(async f => {
  renameBody(f.sourceStore, f.alpha, 'REMOTE catalog document', 'REMOTE ordinary catalog body'); completed(await f.exchange(f.A), 'applied')
  renameBody(f.localStore, f.alpha, 'LOCAL catalog document', 'LOCAL ordinary catalog body')
  const source = f.B.db.prepare('SELECT id,database_id,document_id,title,created_at FROM database_entities WHERE document_id=? ORDER BY id').all(f.alpha) as Entity[]
  const direct = f.B.db.prepare('SELECT document_id,column_id,entity_id,value_text FROM document_database_values WHERE document_id=? ORDER BY column_id').all(f.alpha) as Direct[]
  const values = f.B.db.prepare('SELECT entity_id,column_id,value_text FROM database_entity_values WHERE entity_id IN(SELECT id FROM database_entities WHERE document_id=?) ORDER BY entity_id,column_id').all(f.alpha) as Value[]
  const definitions = f.B.db.prepare('SELECT id,database_id,name,type,options_json,sort_order,created_at FROM document_database_columns ORDER BY id').all()
  const entityCount = (f.B.db.prepare('SELECT count(*) AS n FROM database_entities').get() as { n: number }).n
  assert.equal(source.length, 3); assert.equal(new Set(source.map(row => row.database_id)).size, 3)
  assert.equal(direct.length, 2)
  assert.equal(direct.find(row => row.column_id === f.nullableColumn)?.value_text, null, 'The source contains the exact approved legal historical NULL row')
  assert.equal(direct.some(row => row.column_id === f.missingColumn), false, 'The public Main null update leaves a missing row, not an implicit value to heal')
  const p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'doc:' + f.alpha), destination = c.copyDocuments.find(doc => doc.sourceDocumentId === f.alpha)
  assert.ok(destination, 'The local document fork destination is displayed before acceptance')
  assert.equal(destination.sourceTitle, 'LOCAL catalog document')
  assert.deepEqual(c.entities.map(row => ({ sourceEntityId: row.sourceEntityId, title: row.title })).sort((a, b) => a.sourceEntityId < b.sourceEntityId ? -1 : 1),
    source.map(row => ({ sourceEntityId: row.id, title: row.title })), 'Preview displays every original independent entity title without following the new document title')
  const result = acceptedBoth(await f.resolveBoth(p, [selectBoth(c)])), summary = forkSummary(result, c.componentId), copied = summary.documents.find(doc => doc.sourceDocumentId === f.alpha)
  assert.ok(copied, 'The installed actual copy is tied to the original document source')
  assert.equal(copied.documentId, destination.documentId); assert.equal(readStrictHostDocument(f.B.db, copied.documentId).detail.title, destination.title)
  const actual = f.B.db.prepare('SELECT id,database_id,document_id,title,created_at FROM database_entities WHERE document_id=? ORDER BY id').all(copied.documentId) as Entity[]
  assert.equal(actual.length, source.length)
  assert.equal((f.B.db.prepare('SELECT count(*) AS n FROM database_entities').get() as { n: number }).n, entityCount + source.length, 'No implicit default entity or unrelated standalone entity is added')
  for (const original of source) {
    const mapping = summary.entities.find(row => row.sourceEntityId === original.id), shown = c.entities.find(row => row.sourceEntityId === original.id)
    assert.ok(mapping && shown, 'Every real source membership has one displayed and accepted fresh identity')
    assert.equal(mapping.entityId, shown.entityId); assert.notEqual(mapping.entityId, original.id)
    const row = actual.find(row => row.id === mapping.entityId)
    assert.ok(row, 'The independent actual SQL query finds the fresh linked entity')
    assert.equal(row.document_id, copied.documentId); assert.equal(row.database_id, original.database_id); assert.equal(row.title, original.title)
    assert.ok(Number.isFinite(Date.parse(row.created_at)), 'The Main allocation assigns a real new entity birth')
    assert.deepEqual(f.B.db.prepare('SELECT column_id,value_text FROM database_entity_values WHERE entity_id=? ORDER BY column_id').all(row.id),
      values.filter(value => value.entity_id === original.id).map(({ entity_id: _old, ...value }) => value))
  }
  assert.deepEqual(f.B.db.prepare('SELECT document_id,column_id,entity_id,value_text FROM document_database_values WHERE document_id=? ORDER BY column_id').all(copied.documentId),
    direct.map(row => ({ ...row, document_id: copied.documentId })), 'Direct values are typed-remapped without parsing scalar strings containing the old ID')
  assert.deepEqual(f.B.db.prepare('SELECT id,database_id,name,type,options_json,sort_order,created_at FROM document_database_columns ORDER BY id').all(), definitions)
  assert.equal((f.B.db.prepare('SELECT count(*) AS n FROM database_entities WHERE id=?').get(f.standalone) as { n: number }).n, 1)
  assert.equal(readStrictHostDocument(f.B.db, f.alpha).detail.title, 'REMOTE catalog document')
  assert.equal(readStrictHostDocument(f.B.db, copied.documentId).detail.blocks[0].content, 'LOCAL ordinary catalog body')
  completed(await f.exchange(f.A), 'applied'); converged(f)
}))

test('actual both exposes a catalog blocker instead of dropping local membership values after remote column-option replacement', () => withBothCatalog(async f => {
  renameBody(f.sourceStore, f.alpha, 'REMOTE incompatible catalog document', 'REMOTE catalog branch')
  f.sourceStore.updateDocumentDatabaseColumnOptions({ columnId: f.customColumns[0], options: ['right-only'] })
  completed(await f.exchange(f.A), 'applied')
  renameBody(f.localStore, f.alpha, 'LOCAL incompatible catalog document', 'LOCAL catalog branch')
  const before = localPortable(f.B).entries, baseline = stateRow(f.B.db).value, remote = remoteActual(f).bytes
  const p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'doc:' + f.alpha)
  assert.equal(c.reason, 'catalog'); assert.deepEqual(c.choices, [])
  assert.deepEqual(localPortable(f.B).entries, before); assert.equal(stateRow(f.B.db).value, baseline); assert.deepEqual(remoteActual(f).bytes, remote)
  assert.ok((f.B.db.prepare('SELECT value_text FROM database_entity_values WHERE column_id=?').all(f.customColumns[0]) as Array<{ value_text: string | null }>).some(row => row.value_text?.includes('first')), 'The blocked preview never prunes the actual local original value')
}))
