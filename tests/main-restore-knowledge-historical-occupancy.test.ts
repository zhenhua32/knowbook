import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { installSyncedBlockSchema } from '../src/main/database/synced-schema'
import { unionCertifiedCapsuleKnowledge, readCertifiedKnowledgeUnion } from '../src/main/database/restore-knowledge-payload-read'
import { captureKnowledgeOriginal, extractKnowledge, withPayloadStore } from './helpers/restore-knowledge-payload-fixture'

/** Prepared before the fix. These are real ordinary SQL source checkpoints
 * accepted by the existing legacy migration adapter, never forged sync ACKs,
 * proof rows, certificate DTOs or a caller-created NULL ledger. */
test('K keeps every known legacy historical block birth despite a migration-derived NULL ledger and compares complete per-original birth sets', () => withPayloadStore(async f => {
  const owner = f.store.createDocument(null), blockId = 'legacy:known-birth:' + randomUUID()
  const detail = f.store.getDocumentDetail(owner)
  assert.ok(detail)
  const births = ['2001-01-01T00:00:00.000Z', '2002-01-01T00:00:00.000Z', '2003-01-01T00:00:00.000Z'] as const
  const checkpointTime = '2041-01-01T00:00:00.000Z'
  const insert = f.db.prepare(`INSERT INTO document_history(id,document_id,title,path,created_at,reason,content_json)
    VALUES(?,?,?,?,?,?,?)`)
  const checkpoint = (field: 'createdAt' | 'created_at', birth: string): void => {
    insert.run(randomUUID(), owner, detail.title, detail.path, checkpointTime, 'edit', JSON.stringify({
      title: detail.title, summary: '', blocks: [{ id: blockId, type: 'paragraph', content: 'Supported legacy ordinary checkpoint',
        checked: false, depth: 0, parentBlockId: null, [field]: birth }]
    }))
  }
  checkpoint('createdAt', births[0]); checkpoint('created_at', births[1])
  assert.equal(f.db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(blockId), undefined)
  f.db.transaction(() => installSyncedBlockSchema(f.db))()
  assert.deepEqual(f.db.prepare('SELECT state,created_at FROM block_identities WHERE id=?').get(blockId),
    { state: 'retained', created_at: null }, 'The real migration keeps multiple known historical births unknown in its single retained ledger slot')
  const first = await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))
  const historical = first.payload.occupancy.filter(item => item.namespace === 'block' && item.id === blockId && item.kind === 'history')
  assert.deepEqual(historical.map(item => ({ ownerKind: item.ownerKind, ownerId: item.ownerId, birth: item.knownBirth }))
    .sort((a, b) => String(a.birth).localeCompare(String(b.birth))), [
      { ownerKind: 'document', ownerId: owner, birth: births[0] }, { ownerKind: 'document', ownerId: owner, birth: births[1] }
    ], 'Both original birth spellings remain positive history evidence; the NULL ledger does not erase either')
  assert.ok(first.payload.occupancy.some(item => item.id === blockId && item.kind === 'ledger' && item.knownBirth === null))
  checkpoint('createdAt', births[2])
  f.db.transaction(() => installSyncedBlockSchema(f.db))()
  assert.deepEqual(f.db.prepare('SELECT state,created_at FROM block_identities WHERE id=?').get(blockId), { state: 'retained', created_at: null })
  const second = await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))
  const union = await readCertifiedKnowledgeUnion(await unionCertifiedCapsuleKnowledge([first.handle, second.handle]))
  const field = union.mappingAmbiguities.find(item => item.namespace === 'block' && item.id === blockId)?.fields.find(item => item.field === 'known-birth')
  assert.ok(field, 'Different complete known-birth sets require a mapping-plan candidate, never a fabricated contradiction or permission')
  assert.deepEqual(new Set(field.alternatives.map(item => JSON.stringify(item.knownValues))),
    new Set([JSON.stringify(births.slice(0, 2)), JSON.stringify(births)]))
  assert.equal(second.payload.occupancy.some(item => item.id === blockId && item.knownBirth === checkpointTime), false,
    'Checkpoint time is never substituted for an original block birth')
}))

test('K keeps a real Store trash document birth and cascaded archived entity ID, database owner and birth as historical occupancy', () => withPayloadStore(async f => {
  const documentId = f.store.createDocument(null)
  const database = f.store.createDatabase({ name: 'Actual archive occupancy database' })
  const entity = f.store.createDatabaseEntity({ databaseId: database.id, documentId, title: 'Actual archived entity' })
  const document = f.db.prepare('SELECT id,created_at FROM documents WHERE id=?').get(documentId) as { id: string; created_at: string }
  const originalEntity = f.db.prepare('SELECT id,database_id,created_at FROM database_entities WHERE id=?').get(entity.id) as
    { id: string; database_id: string; created_at: string }
  f.store.deleteDocument(documentId)
  assert.equal(f.db.prepare('SELECT 1 FROM documents WHERE id=?').get(documentId), undefined)
  assert.equal(f.db.prepare('SELECT 1 FROM database_entities WHERE id=?').get(entity.id), undefined, 'The real document FK cascade removes the current entity')
  const row = f.db.prepare('SELECT snapshot_json FROM document_trash WHERE id=?').get(documentId) as { snapshot_json: string }
  const snapshot = JSON.parse(row.snapshot_json) as { document: { id: string; created_at: string };
    entities: Array<{ id: string; database_id: string; created_at: string }> }
  assert.equal(snapshot.document.id, documentId); assert.equal(snapshot.document.created_at, document.created_at)
  assert.ok(snapshot.entities.some(item => item.id === originalEntity.id && item.database_id === originalEntity.database_id && item.created_at === originalEntity.created_at))
  const extracted = await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))
  assert.ok(extracted.payload.occupancy.some(item => item.namespace === 'document' && item.id === documentId
    && item.kind === 'history' && item.knownBirth === document.created_at && item.source.table === 'document_trash'),
    'The real archived document birth remains known after the physical document disappears')
  assert.ok(extracted.payload.occupancy.some(item => item.namespace === 'entity' && item.id === entity.id && item.kind === 'history'
    && item.ownerKind === 'database' && item.ownerId === database.id && item.knownBirth === originalEntity.created_at && item.source.table === 'document_trash'),
    'A cascaded entity retains its exact archived ID, database owner and birth')
  assert.ok(extracted.payload.occupancy.some(item => item.namespace === 'database' && item.id === database.id && item.kind === 'history'
    && item.knownBirth === null && item.source.table === 'document_trash'), 'The archived entity names its database but does not invent that database birth')
  assert.equal(extracted.payload.occupancy.some(item => item.namespace === 'entity' && item.id === entity.id && item.kind === 'physical'), false)
  assert.equal((f.db.prepare('SELECT snapshot_json FROM document_trash WHERE id=?').get(documentId) as { snapshot_json: string }).snapshot_json, row.snapshot_json,
    'Reading K leaves the actual complete ordinary archive bytes unchanged')
}))
