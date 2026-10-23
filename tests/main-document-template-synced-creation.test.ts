import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { documentTemplateDate } from '../src/shared/documentTemplates'
import { isSyncedUuid, serializeSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import { getSyncedOperation } from '../src/main/database/synced-blocks-content'
import { getSyncedHostHistory } from '../src/main/database/synced-host-final'
import { readStrictHostDocument } from '../src/main/database/synced-host-document-read'
import { readRawCapsule2PhysicalGraphOwned } from '../src/main/database/restore-knowledge-capsule2-physical-raw-read'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { allTables, created, createRestoreInput, restoreSyncedHostOperation, snapshot,
  createRequest, applySyncedHostCommand, applySyncedHostFinal, request, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'

function reference(f: V3Fixture, id = 'unreserved template reference'): DocumentBlockDraft {
  return { id, type: 'synced-block', content: serializeSyncedBlockPayload({ version: 1, groupId: f.groupId }), checked: false, depth: 0 }
}
function save(f: V3Fixture, blocks: DocumentBlockDraft[] = [reference(f)]) {
  const saved = f.store.saveDocumentTemplate({ name: 'Linked template', title: 'Linked {{date}}', summary: 'For {{title}}', blocks })
  return f.store.listDocumentTemplates().find(value => value.id === saved.id)!
}
async function physical(f: V3Fixture) {
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    readRawCapsule2PhysicalGraphOwned(db)
    const history = readRawCapsule2WorkspaceHistoryOwned(db)
    assert.equal(history.certified, false); assert.equal(history.permit, false)
  })())
}

test('template creation registers a fresh reference through the actual Main writer with a complete readable receipt and no undo delta', () => withV3Fixture(async f => {
  const template = save(f), group = snapshot(f.db, f.groupId), originalAck = getSyncedOperation(f.db, { clientOperationId: f.created.operationId })
  const operations = new Set((f.db.prepare('SELECT client_operation_id AS id FROM synced_operations').all() as Array<{ id: string }>).map(row => row.id))
  const id = f.store.createDocumentFromTemplate({ templateId: template.id, parentId: null }), detail = f.store.getDocumentDetail(id)!
  const ref = detail.blocks[0], after = snapshot(f.db, f.groupId)
  assert.ok(isSyncedUuid(ref.id)); assert.notEqual(ref.id, template.blocks[0].id)
  assert.equal(ref.type, 'synced-block'); assert.equal(ref.content, template.blocks[0].content)
  const instance = after.instances.find(value => value.instanceId === ref.id)!
  assert.ok(instance); assert.equal(instance.hostDocumentId, id); assert.ok(isSyncedUuid(instance.bindingVersion))
  assert.deepEqual(after.blocks, group.blocks); assert.deepEqual(after.bindings, group.bindings)
  assert.equal(after.creationId, group.creationId); assert.equal(after.revision, group.revision)
  assert.notEqual(after.topologyRevision, group.topologyRevision)
  assert.deepEqual(after.instances.find(value => value.instanceId === f.instanceId), group.instances[0])
  const births = f.db.prepare('SELECT id,last_owner_kind,last_owner_id,state FROM block_identities WHERE id=?').get(ref.id)
  assert.deepEqual(births, { id: ref.id, last_owner_kind: 'document', last_owner_id: id, state: 'live' })
  const added = (f.db.prepare('SELECT client_operation_id AS id FROM synced_operations').all() as Array<{ id: string }>).filter(row => !operations.has(row.id))
  assert.equal(added.length, 1)
  const ack = getSyncedOperation(f.db, { clientOperationId: added[0].id })
  assert.equal(ack.status, 'committed')
  if (ack.status !== 'committed' || !('hosts' in ack.result)) throw new Error('A real host receipt is required')
  assert.equal(ack.result.status, 'applied'); assert.equal(ack.result.historyToken, null)
  assert.equal(ack.result.hosts[0].after.id, id)
  assert.deepEqual(ack.result.hosts[0].logicalBefore, readStrictHostDocument(f.db, id)!.content)
  assert.equal(getSyncedHostHistory(f.db, { documentId: id }).undoToken, null)
  assert.equal(f.store.documentRecovery.listHistory(id).length, 0)
  assert.deepEqual(getSyncedOperation(f.db, { clientOperationId: f.created.operationId }), originalAck)
  assert.deepEqual(f.store.listDocumentTemplates().find(value => value.id === template.id), template)
  await physical(f)
}))

test('template references preserve nested column ownership, duplicate group occurrences, copied links, variables and sibling naming', () => withV3Fixture(async f => {
  const template = save(f, [
    { id: 'layout', type: 'columns', content: '', checked: false, depth: 0 },
    { id: 'column', type: 'column', content: '', checked: false, depth: 1, parentBlockId: 'layout', markdownFormat: { columnWeight: 10000 } },
    { ...reference(f, 'nested-ref'), depth: 2, parentBlockId: 'column' },
    reference(f, 'root-ref'),
    { id: 'text', type: 'paragraph', content: 'For {{title}} [[nested-ref|nested]] [root](#root-ref) [[V3 Target]]', checked: false, depth: 0, tags: ['tag\0literal'], highlight: 'blue' },
    { id: 'code', type: 'code', content: '[[nested-ref]] {{date}}', checked: false, depth: 0, language: 'typescript', markdownFormat: { codeInfo: 'typescript\0literal' } }
  ])
  const first = f.store.createDocumentFromTemplate({ templateId: template.id, parentId: f.targetId, title: 'Copy' })
  const id = f.store.createDocumentFromTemplate({ templateId: template.id, parentId: f.targetId, title: 'Copy' })
  const detail = f.store.getDocumentDetail(id)!, blocks = detail.blocks, group = snapshot(f.db, f.groupId)
  assert.equal(detail.title, 'Copy 1'); assert.equal(detail.path, 'V3 Target/Copy 1'); assert.equal(detail.summary, 'For Copy 1')
  assert.equal(blocks[1].parentBlockId, blocks[0].id); assert.equal(blocks[2].parentBlockId, blocks[1].id)
  assert.deepEqual(blocks.map(block => block.depth), [0, 1, 2, 0, 0, 0])
  assert.deepEqual(group.instances.find(value => value.instanceId === blocks[2].id)?.parentType, 'column')
  assert.equal(group.instances.filter(value => value.hostDocumentId === id).length, 2)
  assert.equal(group.instances.filter(value => value.hostDocumentId === first).length, 2)
  assert.equal(blocks[4].content, `For Copy 1 [[${blocks[2].id}|nested]] [root](#${blocks[3].id}) [[V3 Target]]`)
  assert.deepEqual(blocks[4].tags, ['tag\0literal']); assert.equal(blocks[4].highlight, 'blue')
  assert.equal(blocks[5].content, `[[nested-ref]] ${documentTemplateDate()}`)
  assert.equal(blocks[5].markdownFormat?.codeInfo, 'typescript\0literal')
  assert.ok(detail.outgoingLinks.some(link => link.id === f.targetId))
  assert.ok(f.store.getDocumentDetail(f.targetId)!.backlinks.some(link => link.id === id))
  assert.ok(blocks.every(block => !template.blocks.some(source => source.id === block.id)))
  await physical(f)
}))

test('template creation reads current Main group guards after a real canonical edit instead of freezing the saved template revision', () => withV3Fixture(async f => {
  const template = save(f), initial = snapshot(f.db, f.groupId)
  editCreatedGroup(f.db, f.groupId)
  const edited = snapshot(f.db, f.groupId)
  assert.notEqual(edited.revision, initial.revision)
  const id = f.store.createDocumentFromTemplate({ templateId: template.id, parentId: null })
  const after = snapshot(f.db, f.groupId)
  assert.equal(after.revision, edited.revision); assert.deepEqual(after.blocks, edited.blocks)
  assert.ok(after.instances.some(value => value.hostDocumentId === id))
  await physical(f)
}))

test('template creation registers multiple actual groups in one host without changing either canonical body', () => withV3Fixture(async f => {
  const source = f.store.createQuickNote({ title: 'Second group source', content: 'Second canonical paragraph' })
  const command = createRequest(f.db, { documentId: source, selectedRootIds: [f.store.getDocumentDetail(source)!.blocks[0].id] })
  created(applySyncedHostCommand(f.db, command))
  const otherGroupId = command.action.groupId, originals = [snapshot(f.db, f.groupId), snapshot(f.db, otherGroupId)]
  const template = save(f, [reference(f), { ...reference(f, 'other-ref'), content: serializeSyncedBlockPayload({ version: 1, groupId: otherGroupId }) }])
  const id = f.store.createDocumentFromTemplate({ templateId: template.id, parentId: null })
  for (const before of originals) {
    const after = snapshot(f.db, before.groupId)
    assert.deepEqual(after.blocks, before.blocks); assert.equal(after.revision, before.revision)
    assert.equal(after.instances.filter(instance => instance.hostDocumentId === id).length, 1)
    assert.notEqual(after.topologyRevision, before.topologyRevision)
  }
  await physical(f)
}))

test('template creation refreshes pre-existing links to the new document and heading before committing its Main receipt', () => withV3Fixture(async f => {
  const source = f.store.createQuickNote({ title: 'Waiting source', content: '[[Arriving#New heading]] [new](Arriving.md#new-heading)' })
  assert.equal(f.store.getDocumentDetail(source)!.outgoingLinks.length, 0)
  const template = save(f, [{ id: 'heading', type: 'heading-1', content: 'New heading', checked: false, depth: 0 }, reference(f)])
  const id = f.store.createDocumentFromTemplate({ templateId: template.id, parentId: null, title: 'Arriving' })
  const detail = f.store.getDocumentDetail(id)!
  assert.ok(detail.backlinks.some(link => link.id === source))
  assert.ok(f.store.getDocumentDetail(source)!.outgoingLinks.some(link => link.id === id))
  assert.equal(f.store.checkDocumentLinks(source, () => null).issues.length, 0)
  const row = f.db.prepare('SELECT client_operation_id AS id FROM synced_operations ORDER BY rowid DESC LIMIT 1').get() as { id: string }
  const ack = getSyncedOperation(f.db, { clientOperationId: row.id })
  assert.equal(ack.status, 'committed')
  if (ack.status !== 'committed' || !('hosts' in ack.result)) throw new Error('A real host receipt is required')
  assert.ok(ack.result.hosts[0].after.backlinks.some(link => link.id === source))
  await physical(f)
}))

for (const [name, content] of [
  ['opaque draft', '{{title}} unresolved draft'],
  ['missing group', serializeSyncedBlockPayload({ version: 1, groupId: randomUUID() })],
  ['future payload version', JSON.stringify({ version: 2, groupId: randomUUID() })],
  ['extra payload authority', JSON.stringify({ version: 1, groupId: randomUUID(), certified: true })],
  ['duplicate payload key', '{"version":1,"version":1,"groupId":"' + randomUUID() + '"}']
] as const) test(`template creation rejects ${name} and leaves every original table and saved draft unchanged`, () => withV3Fixture(async f => {
  const template = save(f, [{ ...reference(f), content }]), before = allTables(f.db)
  assert.throws(() => f.store.createDocumentFromTemplate({ templateId: template.id, parentId: null }))
  assert.deepEqual(allTables(f.db), before)
  assert.deepEqual(f.store.listDocumentTemplates().find(value => value.id === template.id), template)
  await physical(f)
}))

test('template creation refuses a genuinely retired group without reviving its lifecycle or changing its executable history', () => withV3Fixture(async f => {
  const template = save(f)
  const undo = created(restoreSyncedHostOperation(f.db, createRestoreInput(f.db, f.created, 'undo').input))
  assert.equal(undo.createdLifecycle.state, 'retired-create')
  const before = allTables(f.db)
  assert.throws(() => f.store.createDocumentFromTemplate({ templateId: template.id, parentId: null }))
  assert.deepEqual(allTables(f.db), before)
  await physical(f)
}))

for (const [name, sql] of [
  ['instance registry', `CREATE TRIGGER reject_linked_template BEFORE INSERT ON synced_instances
    WHEN NEW.host_document_id NOT IN (SELECT host_document_id FROM synced_instances)
    BEGIN SELECT RAISE(ABORT, 'Forced template registry failure'); END`],
  ['Main receipt', `CREATE TRIGGER reject_linked_template BEFORE INSERT ON synced_operations
    BEGIN SELECT RAISE(ABORT, 'Forced template receipt failure'); END`],
  ['reference refresh', `CREATE TRIGGER reject_linked_template BEFORE INSERT ON links
    WHEN (SELECT title FROM documents WHERE id=NEW.source_document_id) = 'Waiting source'
    BEGIN SELECT RAISE(ABORT, 'Forced template reference refresh failure'); END`]
] as const) test(`template ${name} failure rolls back the document, all blocks, identities, topology and history atomically`, () => withV3Fixture(async f => {
  f.store.createQuickNote({ title: 'Waiting source', content: '[[Linked ' + documentTemplateDate() + ']]' })
  const template = save(f, [{ id: 'body', type: 'paragraph', content: 'Before reference', checked: false, depth: 0 }, reference(f)])
  f.db.exec(sql)
  const before = allTables(f.db)
  assert.throws(() => f.store.createDocumentFromTemplate({ templateId: template.id, parentId: null }), /Forced template/)
  assert.deepEqual(allTables(f.db), before)
  f.db.exec('DROP TRIGGER reject_linked_template')
  const id = f.store.createDocumentFromTemplate({ templateId: template.id, parentId: null })
  assert.ok(snapshot(f.db, f.groupId).instances.some(value => value.hostDocumentId === id))
  await physical(f)
}))

test('template reference creation preserves the real outer transaction boundary', () => withV3Fixture(f => {
  const template = save(f), before = allTables(f.db)
  assert.throws(() => f.db.transaction(() => f.store.createDocumentFromTemplate({ templateId: template.id, parentId: null }))(), /外层 IMMEDIATE/)
  assert.deepEqual(allTables(f.db), before)
}))

test('template reference creation refuses disabled foreign keys and a missing parent without leaving partial rows', () => withV3Fixture(f => {
  const template = save(f), before = allTables(f.db)
  assert.throws(() => f.store.createDocumentFromTemplate({ templateId: template.id, parentId: 'missing parent' }), /Parent document not found/)
  assert.deepEqual(allTables(f.db), before)
  f.db.pragma('foreign_keys=OFF')
  try {
    assert.throws(() => f.store.createDocumentFromTemplate({ templateId: template.id, parentId: null }), /SQLite 外键/)
    assert.deepEqual(allTables(f.db), before)
  } finally { f.db.pragma('foreign_keys=ON') }
}))

test('the public Main host method still refuses an existing host heading rewrite without acquiring template creation authority', () => withV3Fixture(f => {
  const id = f.store.createQuickNote({ content: 'Existing ordinary body' })
  const input = request(f.db, [id], (after, before) => {
    before[0].workingBefore.blocks.push({ id: randomUUID(), type: 'heading-1', content: 'New heading', checked: false, depth: 0, parentBlockId: null })
    after[0].blocks = structuredClone(before[0].workingBefore.blocks)
  })
  const before = allTables(f.db)
  assert.deepEqual(applySyncedHostFinal(f.db, input), { status: 'unsupported', reason: 'heading-rewrite' })
  assert.deepEqual(allTables(f.db), before)
}))

test('template creation materializes all 10000 saved blocks including the final registered reference', () => withV3Fixture(async f => {
  const template = save(f, [
    ...Array.from({ length: 9999 }, (_, i) => ({ id: 'template-' + i, type: 'paragraph', content: String(i), checked: false, depth: 0 })),
    reference(f, 'final-reference')
  ])
  const id = f.store.createDocumentFromTemplate({ templateId: template.id, parentId: null })
  const blocks = f.store.getDocumentDetail(id)!.blocks
  assert.equal(blocks.length, 10000); assert.equal(blocks[9998].content, '9998')
  assert.equal(blocks[9999].type, 'synced-block')
  assert.ok(snapshot(f.db, f.groupId).instances.some(value => value.instanceId === blocks[9999].id && value.hostDocumentId === id))
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM block_identities WHERE last_owner_kind='document' AND last_owner_id=? AND state='live'").get(id) as { n: number }).n, 10000)
  await physical(f)
}))

test('quick note Markdown cannot turn a pasted synced fence into a registered internal reference', () => withV3Fixture(async f => {
  const before = snapshot(f.db, f.groupId), operations = f.db.prepare('SELECT * FROM synced_operations').all()
  const id = f.store.createQuickNote({ content: '```knowbook-synced-block-v1\n' + reference(f).content + '\n```' })
  assert.equal(f.store.getDocumentDetail(id)!.blocks[0].type, 'code')
  assert.deepEqual(snapshot(f.db, f.groupId), before)
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_operations').all(), operations)
  await physical(f)
}))
