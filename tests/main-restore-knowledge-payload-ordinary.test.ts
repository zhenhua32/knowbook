import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { diagnoseCertifiedCapsuleKnowledge } from '../src/main/database/restore-knowledge-capsule-read'
import { captureSyncedPublicationSnapshot } from '../src/main/database/synced-publication'
import { removeSchema27ForLegacyFixture } from './helpers/schema27-legacy-fixture'
import { captureKnowledgeOriginal, extractKnowledge, originalRow, payloadTextCell, withPayloadStore } from './helpers/restore-knowledge-payload-fixture'

test('K keeps ordinary 501-character title occupancy and real unregistered template IDs without copying unrelated settings or manufacturing a ledger', () => withPayloadStore(async f => {
  const id = f.store.createDocument(null), title = '长'.repeat(501), blockId = randomUUID(), secret = 'not-K-ai-credential-' + randomUUID()
  f.store.updateDocument(id, { title, summary: '', blocks: [
    { id: blockId, type: 'paragraph', content: 'ordinary body', checked: false, depth: 0, parentBlockId: null }
  ] })
  const template = f.store.saveDocumentTemplate({ name: 'Actual unregistered template', title: 'Template', summary: '', blocks: [
    { type: 'paragraph', content: '\uFEFF模板中文与实际replacement �', checked: false, depth: 0, parentBlockId: null }
  ] })
  const row = f.db.prepare('SELECT blocks_json,CAST(blocks_json AS BLOB) AS bytes FROM document_templates WHERE id=?').get(template.id) as { blocks_json: string; bytes: Buffer }
  const templateBlock = (JSON.parse(row.blocks_json) as Array<{ id: string }>)[0].id
  assert.equal(f.db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(templateBlock), undefined)
  f.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('ai.unrelated-payload-secret', secret, '2041-01-01T00:00:00.000Z')
  const value = await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))
  assert.equal(f.store.getDocumentDetail(id)?.title, title)
  assert.ok(value.payload.occupancy.some(item => item.namespace === 'document' && item.id === id))
  assert.ok(value.payload.occupancy.some(item => item.namespace === 'block' && item.id === templateBlock && item.kind === 'template'))
  assert.equal(value.payload.identities.some(item => item.id === templateBlock), false)
  const table = value.payload.originals.find(table => table.table === 'document_templates')!
  assert.deepEqual(originalRow(value.payload, 'document_templates', template.id).cells[table.columns.indexOf('blocks_json')], ['text', row.bytes.toString('base64')])
  assert.equal(JSON.stringify(value.payload).includes(secret), false)
  const summary = await diagnoseCertifiedCapsuleKnowledge(value.handle)
  assert.equal(JSON.stringify(summary).includes(row.blocks_json), false)
  assert.equal(JSON.stringify(summary).includes(secret), false)
  assert.equal(summary.acceptedCoverage, false)
  assert.equal(f.db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(templateBlock), undefined)
  assert.ok(Object.isFrozen(value.payload.originals) && Object.isFrozen(originalRow(value.payload, 'document_templates', template.id).cells))
  assert.equal(Reflect.set(originalRow(value.payload, 'document_templates', template.id).key[0], '1', 'caller bytes'), false)
}))

test('K supports an actual ordinary schema26 original without installing schema27 lifecycle or granting a public publication capture', () => withPayloadStore(async f => {
  const id = f.store.createDocument(null), blockId = randomUUID()
  f.store.updateDocument(id, { title: 'Actual ordinary schema26 source', summary: '', blocks: [
    { id: blockId, type: 'paragraph', content: 'ordinary actual source', checked: false, depth: 0, parentBlockId: null }
  ] })
  // Existing migration-fixture seam removes only empty later tables/guards. No
  // group/ACK/observation/proof is fabricated or discarded to claim success.
  removeSchema27ForLegacyFixture(f.db); f.db.pragma('user_version=26')
  const definitions = f.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()
  const current = await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))
  assert.equal(current.payload.schemaVersion, 26); assert.equal(current.payload.lifecycleAvailability, 'not-in-schema26')
  assert.deepEqual(current.payload.denials, []); assert.deepEqual(current.payload.observations, [])
  assert.ok(current.payload.occupancy.some(item => item.id === blockId && item.kind === 'physical'))
  assert.deepEqual(originalRow(current.payload, 'blocks', blockId).key, [payloadTextCell(blockId, current.payload.encoding)])
  assert.equal(current.payload.originals.some(table => table.table === 'synced_group_lifecycle'), false)
  assert.deepEqual(captureSyncedPublicationSnapshot(f.db), { status: 'unsupported', reason: 'schema-27-required' })
  assert.deepEqual(f.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(), definitions)
}))
