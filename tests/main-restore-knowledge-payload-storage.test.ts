import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { certifyDurableSqlCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-read'
import { captureKnowledgeOriginal, prepareKnowledgeOriginal, extractKnowledge, originalRow, withPayloadStore } from './helpers/restore-knowledge-payload-fixture'

for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be'] as const)
  test('K preserves actual ' + encoding + ' TEXT bytes including literal BOM/replacement and rejects malformed original TEXT', () => withPayloadStore(async f => {
    const id = f.store.createDocument(null)
    f.store.updateDocument(id, { title: 'Actual encoded document', summary: '', blocks: [
      { id: randomUUID(), type: 'paragraph', content: '实际正文 � \uFEFF', checked: false, depth: 0, parentBlockId: null }
    ] })
    const template = f.store.saveDocumentTemplate({ name: 'Encoded original', title: '编码模板', summary: '', blocks: [
      { type: 'paragraph', content: '\uFEFF实际BOM与replacement � 中文 🧩', checked: false, depth: 0, parentBlockId: null }
    ] })
    const expected = f.db.prepare('SELECT typeof(blocks_json) AS storage,CAST(blocks_json AS BLOB) AS bytes FROM document_templates WHERE id=?')
      .get(template.id) as { storage: string; bytes: Buffer }
    const extracted = await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))
    assert.equal(extracted.payload.encoding, encoding); assert.equal(expected.storage, 'text')
    const table = extracted.payload.originals.find(table => table.table === 'document_templates')!
    const cell = originalRow(extracted.payload, 'document_templates', template.id).cells[table.columns.indexOf('blocks_json')]
    assert.deepEqual(cell, ['text', expected.bytes.toString('base64')], 'The original encoded byte sequence is retained, not a reencoded semantic JSON value')
    f.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('payload.encoding.invalid', 'legal replacement �', '2041-01-01T00:00:00.000Z')
    const bad = encoding === 'UTF-8' ? '80' : encoding === 'UTF-16le' ? '00D8' : 'D800'
    f.db.exec("UPDATE app_settings SET value=CAST(X'" + bad + "' AS TEXT) WHERE key='payload.encoding.invalid'")
    const malformed = await prepareKnowledgeOriginal(f.userDataRoot, dirname(f.file))
    await assert.rejects(certifyDurableSqlCapsuleOriginal(malformed.original), /编码|TEXT|回编码/)
  }, encoding))

test('K source references distinguish actual adjacent 64-bit SQLite integers beyond JavaScript precision while keeping ordinary body projection private', () => withPayloadStore(async f => {
  const id = f.store.createDocument(null), blockId = randomUUID()
  f.store.updateDocument(id, { title: 'Actual integer original', summary: '', blocks: [
    { id: blockId, type: 'paragraph', content: 'ordinary source', checked: false, depth: 0, parentBlockId: null }
  ] })
  f.db.prepare('UPDATE blocks SET sort_order=9223372036854775807 WHERE id=?').run(blockId)
  assert.equal((f.db.prepare('SELECT sort_order FROM blocks WHERE id=?').safeIntegers(true).get(blockId) as { sort_order: bigint }).sort_order, 9223372036854775807n)
  const first = await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))
  f.db.prepare('UPDATE blocks SET sort_order=9223372036854775806 WHERE id=?').run(blockId)
  const second = await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))
  assert.notEqual(first.payload.inventoryHash, second.payload.inventoryHash)
  const a = originalRow(first.payload, 'blocks', blockId), b = originalRow(second.payload, 'blocks', blockId)
  assert.notEqual(a.rowHash, b.rowHash, 'Full-row support preimages retain both distinct original INTEGERs')
  assert.deepEqual(a.cells, b.cells, 'The public identity projection has no sort/body field; exact omitted original bytes remain bound by rowHash and capsule inventory')
  assert.notEqual(first.payload.capsule.manifestHash, second.payload.capsule.manifestHash)
}))
