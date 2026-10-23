import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { validateSyncedHostForest } from '../src/shared/syncedBlockValidation'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { assertRawCapsule2TemplatesOwned } from '../src/main/database/restore-knowledge-capsule2-templates-read'
import { decodedCapsule2Table, withCapsule2RawCopy, writeMixedOrdinary501 } from './helpers/capsule2-raw-fixture'
import { snapshot, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'

function saved(f: V3Fixture) {
  return f.store.saveDocumentTemplate({ name: 'Actual template', description: 'Original description',
    title: '  {{title}}/{{date}}\u0001  ', summary: ' Original {{title}} summary ', blocks: [
      { id: 'parent-' + randomUUID(), type: 'toggle', content: '{{title}}', checked: false, depth: 0,
        markdownFormat: { toggleDefaultOpen: true } },
      { id: 'code-' + randomUUID(), type: 'code', content: 'file:///opaque/{{date}}', checked: false, depth: 1,
        language: 'typescript', tags: ['tag\0value'], markdownFormat: { codeInfo: 'typescript\0literal' } }
    ] })
}
function changeBlocks(f: V3Fixture, key: string, change: (blocks: DocumentBlockDraft[]) => unknown) {
  const row = f.db.prepare('SELECT blocks_json FROM document_templates WHERE id=?').get(key) as { blocks_json: string }
  f.db.prepare('UPDATE document_templates SET blocks_json=? WHERE id=?').run(JSON.stringify(change(JSON.parse(row.blocks_json))), key)
}
async function unchanged(f: V3Fixture, inspect: (db: Database.Database) => void) {
  const group = snapshot(f.db, f.groupId), ack = f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const before = readRawCapsule2ContentOwned(db)
    inspect(db)
    assert.deepEqual(readRawCapsule2ContentOwned(db), before)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })())
  assert.deepEqual(snapshot(f.db, f.groupId), group)
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId), ack)
}

test('capsule2 template source preserves actual variable metadata and NUL tag/code-info strings alongside ordinary501 and genuine Main history', () => withV3Fixture(async f => {
  writeMixedOrdinary501(f)
  const template = saved(f)
  const row = f.db.prepare('SELECT * FROM document_templates WHERE id=?').get(template.id)
  await unchanged(f, db => {
    const result = readRawCapsule2WorkspaceHistoryOwned(db)
    assert.ok(template.blocks.every(block => result.unregisteredTemplateBlocks.includes(block.id!)))
    assert.deepEqual(db.prepare('SELECT * FROM document_templates WHERE id=?').get(template.id), row)
    const captured = decodedCapsule2Table(readRawCapsule2ContentOwned(db), 'document_templates').find(value => value.id === template.id)!
    assert.equal(captured.title, template.title); assert.equal(captured.summary, template.summary)
    assert.deepEqual(JSON.parse(captured.blocks_json as string), JSON.parse(JSON.stringify(template.blocks)))
    assert.equal(result.certified, false); assert.equal(result.semanticValidationComplete, false); assert.equal(result.permit, false)
  })
}))

test('capsule2 template source keeps real Store opaque synced-block drafts and unresolved database-view query variables without minting group or ledger facts', () => withV3Fixture(async f => {
  const config = createDefaultDatabaseViewConfig('table', [])
  config.query = '{{date}} literal knowbook-asset://unresolved'
  const atom = serializeDatabaseViewPayload({ version: 1, databaseId: 'future-' + randomUUID(), viewId: 'future-' + randomUUID(), config })
  const template = f.store.saveDocumentTemplate({ name: 'Opaque future draft', title: '', summary: '', blocks: [
    { id: ' opaque synced draft ', type: 'synced-block', content: '{{title}} is not group authority', checked: false, depth: 0 },
    { id: f.hostBodyId, type: 'paragraph', content: 'A reused source name is not a reservation', checked: false, depth: 0 },
    { id: 'view-' + randomUUID(), type: 'database-view', content: atom, checked: false, depth: 0 }
  ] })
  assert.throws(() => validateSyncedHostForest(template.blocks), /同步块内容或结构/)
  const identity = f.db.prepare('SELECT * FROM block_identities WHERE id=?').get(f.hostBodyId)
  await unchanged(f, db => {
    const result = readRawCapsule2WorkspaceHistoryOwned(db)
    assert.deepEqual(result.groupIds, [f.groupId])
    assert.ok(result.unregisteredTemplateBlocks.includes(' opaque synced draft '))
    assert.equal(db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(' opaque synced draft '), undefined)
    assert.deepEqual(db.prepare('SELECT * FROM block_identities WHERE id=?').get(f.hostBodyId), identity)
    assert.equal(f.store.listDocumentTemplates().find(value => value.id === template.id)?.blocks[2].content, atom)
  })
}))

test('capsule2 template source reads all 10000 real saved blocks through the last original identity', () => withV3Fixture(async f => {
  const template = f.store.saveDocumentTemplate({ name: 'Actual complete 10000-block draft', title: '', summary: '',
    blocks: Array.from({ length: 10000 }, (_, index) => ({ id: 'template-edge-' + index, type: 'paragraph', content: '', checked: false, depth: 0 })) })
  await unchanged(f, db => {
    const result = readRawCapsule2WorkspaceHistoryOwned(db)
    assert.ok(result.unregisteredTemplateBlocks.includes(template.blocks.at(-1)!.id!))
    const row = db.prepare('SELECT blocks_json FROM document_templates WHERE id=?').get(template.id) as { blocks_json: string }
    assert.equal(JSON.parse(row.blocks_json).length, 10000)
  })
}))

test('capsule2 template source preserves real column ownership around an opaque draft placeholder', () => withV3Fixture(async f => {
  const template = f.store.saveDocumentTemplate({ name: 'Actual column draft', title: '.', summary: '', blocks: [
    { id: 'layout', type: 'columns', content: '', checked: false, depth: 0 },
    { id: 'column', type: 'column', content: '', checked: false, depth: 1, parentBlockId: 'layout', markdownFormat: { columnWeight: 10000 } },
    { id: 'opaque-inner', type: 'synced-block', content: '{{title}}', checked: false, depth: 2, parentBlockId: 'column' }
  ] })
  await unchanged(f, db => {
    const result = readRawCapsule2WorkspaceHistoryOwned(db)
    assert.ok(result.unregisteredTemplateBlocks.includes('opaque-inner'))
    const row = db.prepare('SELECT blocks_json FROM document_templates WHERE id=?').get(template.id) as { blocks_json: string }
    assert.deepEqual(JSON.parse(row.blocks_json), JSON.parse(JSON.stringify(template.blocks)))
  })
}))

test('capsule2 template assertion requires a real readonly query-only FK-owned source transaction', () => withV3Fixture(async f => {
  saved(f)
  assert.throws(() => assertRawCapsule2TemplatesOwned(f.db), /来源事务/)
  assert.throws(() => f.db.transaction(() => assertRawCapsule2TemplatesOwned(f.db))(), /来源事务/)
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => assertRawCapsule2TemplatesOwned(db), /来源事务/)
    db.pragma('query_only=OFF')
    assert.throws(() => db.transaction(() => assertRawCapsule2TemplatesOwned(db))(), /来源事务/)
    db.pragma('query_only=ON'); db.pragma('foreign_keys=OFF')
    assert.throws(() => db.transaction(() => assertRawCapsule2TemplatesOwned(db))(), /来源事务/)
    db.pragma('foreign_keys=ON')
    db.transaction(() => assertRawCapsule2TemplatesOwned(db))()
  })
}))

const corruptions: Array<[string, (f: V3Fixture, key: string) => void]> = [
  ['missing block identity', (f, key) => changeBlocks(f, key, blocks => blocks.map(({ id: _id, ...block }) => block))],
  ['missing content', (f, key) => changeBlocks(f, key, blocks => blocks.map(({ content: _content, ...block }) => block))],
  ['duplicate block identity', (f, key) => changeBlocks(f, key, blocks => [blocks[0], blocks[0]])],
  ['broken ancestor relation', (f, key) => changeBlocks(f, key, blocks => [blocks[0], { ...blocks[1], parentBlockId: 'missing' }])],
  ['fractional depth', (f, key) => changeBlocks(f, key, blocks => [{ ...blocks[0], depth: 0.5 }])],
  ['nonboolean checked', (f, key) => changeBlocks(f, key, blocks => [{ ...blocks[0], checked: 'false' }])],
  ['incompatible markdown format', (f, key) => changeBlocks(f, key, blocks => [{ ...blocks[0], markdownFormat: { codeInfo: 'wrong role' } }])],
  ['noncode language', (f, key) => changeBlocks(f, key, blocks => [{ ...blocks[0], language: 'typescript' }])],
  ['duplicate normalized tags', (f, key) => changeBlocks(f, key, blocks => [{ ...blocks[0], tags: ['same', 'same'] }])],
  ['unknown block field', (f, key) => changeBlocks(f, key, blocks => [{ ...blocks[0], futurePermission: true }])],
  ['invalid database-view atom', (f, key) => changeBlocks(f, key, blocks => [{ ...blocks[0], type: 'database-view', content: '{}', markdownFormat: undefined }])],
  ['deferred synced placeholder under a list', (f, key) => changeBlocks(f, key, blocks => [{ ...blocks[0], type: 'bulleted-list', markdownFormat: undefined },
    { id: randomUUID(), type: 'synced-block', content: JSON.stringify({ version: 1, groupId: randomUUID() }), checked: false, depth: 1, parentBlockId: blocks[0].id }])],
  ['invalid created time', (f, key) => { f.db.prepare('UPDATE document_templates SET created_at=? WHERE id=?').run('invalid', key) }],
  ['blank template name', (f, key) => { f.db.prepare('UPDATE document_templates SET name=? WHERE id=?').run(' ', key) }],
  ['untrimmed description', (f, key) => { f.db.prepare('UPDATE document_templates SET description=? WHERE id=?').run(' untrimmed ', key) }],
  ['oversized actual template title', (f, key) => { f.db.prepare('UPDATE document_templates SET title=? WHERE id=?').run('x'.repeat(501), key) }],
  ['NUL metadata', (f, key) => { f.db.prepare('UPDATE document_templates SET summary=? WHERE id=?').run('bad\0metadata', key) }],
  ['non-TEXT summary cell', (f, key) => { f.db.prepare('UPDATE document_templates SET summary=? WHERE id=?').run(Buffer.from('blob'), key) }],
  ['missing template identity', (f, key) => { f.db.prepare('UPDATE document_templates SET id=NULL WHERE id=?').run(key) }],
  ['NUL block text', (f, key) => changeBlocks(f, key, blocks => [{ ...blocks[0], content: 'bad\0content' }])],
  ['incomplete column weight total', (f, key) => changeBlocks(f, key, () => [
    { id: 'layout', type: 'columns', content: '', checked: false, depth: 0, parentBlockId: null },
    { id: 'column', type: 'column', content: '', checked: false, depth: 1, parentBlockId: 'layout', markdownFormat: { columnWeight: 5000 } }
  ])]
]
for (const [name, corrupt] of corruptions) test('capsule2 template source rejects original ' + name + ' without rewriting raw SQL or Main evidence', () => withV3Fixture(async f => {
  const template = saved(f)
  corrupt(f, template.id)
  await unchanged(f, db => assert.throws(() => readRawCapsule2WorkspaceHistoryOwned(db), /capsule2 template/))
}))

test('capsule2 template source checks the complete table beyond 128 real saved rows', () => withV3Fixture(async f => {
  for (let index = 0; index < 129; index++) saved(f)
  const last = f.db.prepare('SELECT id FROM document_templates ORDER BY id DESC LIMIT 1').get() as { id: string }
  f.db.prepare('UPDATE document_templates SET created_at=? WHERE id=?').run('invalid-last-row', last.id)
  await unchanged(f, db => assert.throws(() => readRawCapsule2WorkspaceHistoryOwned(db), /capsule2 template/))
}))
