// Actual Main fixture for a conflict-free physical candidate. Source/current
// captures preserve real identity, lifecycle and history facts; the complete
// candidate must pass the explicit conflict assertions before stage preparation.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { DocumentBlockDraft } from '../../src/shared/contracts'
import type { SyncedStableBlockDraft } from '../../src/shared/synced-blocks'
import { createDefaultDatabaseViewConfig } from '../../src/shared/database-workspace'
import { serializeSyncedBlockPayload } from '../../src/shared/syncedBlockValidation'
import { captureActualFirstRequiredSqlDag } from '../../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3 } from '../../src/main/database/restore-knowledge-root3-read'
import { tryReadCertifiedCapsule2SourceInputs } from '../../src/main/database/restore-knowledge-capsule2-source-certificate'
import { prepareRootRestoreIdentityPlan3 } from '../../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3 } from '../../src/main/database/restore-knowledge-reference3-read'
import type { Reference3Choices } from '../../src/main/database/restore-knowledge-reference3-model'
import { captureMixedSource } from './mixed-required-source-fixture'
import { withV3Fixture, createV3Fixture, allTables, randomUUID, createRequest, created, applySyncedHostCommand,
  applySyncedHostFinal, request, applied, snapshot, type V3Fixture } from './synced-backup-v3-fixture'
import { command, insertAck } from './synced-host-command-insert-fixture'

const paragraph = (id: string, content: string): SyncedStableBlockDraft => ({ id, type: 'paragraph', content,
  checked: false, depth: 0, parentBlockId: null })
function document(f: V3Fixture, title: string, blocks: DocumentBlockDraft[]) {
  const id = f.store.createDocument(null)
  f.store.updateDocument(id, { title, summary: '', blocks })
  return id
}
function sourceCases(f: V3Fixture) {
  const linkedId = randomUUID(), linkedSurvivorId = randomUUID(), blockUrl = '/V3%20Target.md#^' + f.targetBodyId
  const linked = '😀 [one](' + blockUrl + ')\r\n<a href="' + blockUrl + '">same target</a>'
  const linkedHostId = document(f, 'Stage Linked "Origin"', [paragraph(linkedSurvivorId, 'Ordinary linked-host survivor'), paragraph(linkedId, linked)])
  const linkedCreate = createRequest(f.db, { documentId: linkedHostId, selectedRootIds: [linkedId] })
  created(applySyncedHostCommand(f.db, linkedCreate))
  const linkedInsert = command(f.db, { documentId: linkedHostId, groupId: linkedCreate.action.groupId })
  insertAck(applySyncedHostCommand(f.db, linkedInsert))
  const linkedGroup = snapshot(f.db, linkedCreate.action.groupId)
  assert.equal(linkedGroup.blocks.find(block => block.id === linkedId)!.content, linked)
  assert.equal(linkedGroup.instances.length, 2)
  assert.ok(linkedGroup.bindings.some(binding => binding.target.kind === 'block' && binding.target.id === f.targetBodyId))
  const sourceLinkedHostBlockCount = (f.db.prepare('SELECT count(*) AS n FROM blocks WHERE document_id=?').get(linkedHostId) as { n: number }).n
  assert.equal(sourceLinkedHostBlockCount, 3, 'The source host contains the ordinary survivor and two actual synced references')
  assert.equal((f.db.prepare('SELECT block_count FROM documents WHERE id=?').get(linkedHostId) as { block_count: number }).block_count, sourceLinkedHostBlockCount)

  const orphanBodyId = randomUUID(), orphanSurvivorId = randomUUID()
  const orphanHostId = document(f, 'Stage Active Orphan', [paragraph(orphanSurvivorId, 'The host remains a nonempty ordinary document'),
    paragraph(orphanBodyId, '[target](/V3%20Target.md)')])
  const orphanCreate = createRequest(f.db, { documentId: orphanHostId, selectedRootIds: [orphanBodyId] })
  created(applySyncedHostCommand(f.db, orphanCreate))
  const remove = request(f.db, [orphanHostId], (after, before) => {
    before[0].workingBefore.blocks = before[0].workingBefore.blocks.filter(block => block.id !== orphanCreate.action.instanceId)
    after[0].blocks = structuredClone(before[0].workingBefore.blocks)
  })
  applied(applySyncedHostFinal(f.db, remove))
  const orphanGroup = snapshot(f.db, orphanCreate.action.groupId)
  assert.equal(orphanGroup.instances.length, 0)
  assert.equal(orphanGroup.blocks.find(block => block.id === orphanBodyId)!.content, '[target](/V3%20Target.md)')

  // Separate ordinary document: do not rename the bound target or force a
  // canonical heading/path transition merely to exercise the native domain.
  const longTitle = '知'.repeat(501), longBodyId = randomUUID()
  const longDocumentId = document(f, longTitle, [paragraph(longBodyId, 'Native Root3 ordinary title boundary')])
  const template = f.store.saveDocumentTemplate({ name: 'Stage canonical template', title: 'Template-local draft',
    summary: 'The local block ID must not be treated as physical canonical identity',
    blocks: [{ ...paragraph(linkedId, serializeSyncedBlockPayload({ version: 1, groupId: linkedCreate.action.groupId })), type: 'synced-block' }] })
  // A separate real database keeps the name-swap case independent from the
  // native integer-ordering fixture, whose exact SQL integers no Main edit
  // should round through a JavaScript Number after capture.
  const swappedViewDatabase = f.store.createDatabase({ name: 'Stage View Swap Database', description: 'Two legal view names exchange across source and current' })
  const sourceSwapViews = ['Stage Swap A', 'Stage Swap B'].map(name => {
    const view = f.store.createDatabaseSavedView({ databaseId: swappedViewDatabase.id, name,
      config: createDefaultDatabaseViewConfig('table', []) })
    return { id: view.id, name: view.name }
  })
  for (const view of sourceSwapViews) assert.deepEqual(f.db.prepare('SELECT id,name FROM database_saved_views WHERE id=?').get(view.id), view)
  const swappedEntityColumn = f.store.createDocumentDatabaseColumn({ databaseId: swappedViewDatabase.id, name: 'Stage entity swap field', type: 'text' })
  const sourceSwapEntities = [longDocumentId, orphanHostId].map((documentId, index) => {
    const entity = f.store.createDatabaseEntity({ databaseId: swappedViewDatabase.id, title: 'Stage Swap Entity ' + index,
      documentId, fieldValues: { [swappedEntityColumn.id]: 'Original field value ' + index } })
    return { id: entity.id, document_id: documentId }
  })
  for (const entity of sourceSwapEntities)
    assert.deepEqual(f.db.prepare('SELECT id,document_id FROM database_entities WHERE id=?').get(entity.id), entity)
  const sourceSwapEntityValues = f.db.prepare('SELECT CAST(_rowid_ AS TEXT) AS rowid,entity_id,column_id,value_text,updated_at FROM database_entity_values WHERE column_id=? ORDER BY entity_id')
    .all(swappedEntityColumn.id) as Array<{ rowid: string; entity_id: string; column_id: string; value_text: string; updated_at: string }>
  assert.equal(sourceSwapEntityValues.length, 2)
  const originalOriginJson = (f.db.prepare('SELECT origin_json FROM synced_groups WHERE id=?').get(linkedCreate.action.groupId) as {
    origin_json: string
  }).origin_json
  return { linkedId, linked, linkedHostId, linkedSurvivorId, sourceLinkedHostBlockCount, blockUrl, linkedGroup,
    linkedGroupId: linkedCreate.action.groupId, linkedInstanceIds: [linkedCreate.action.instanceId, linkedInsert.action.instanceId], originalOriginJson,
    orphanBodyId, orphanSurvivorId, orphanHostId, orphanGroup, orphanGroupId: orphanCreate.action.groupId,
    orphanFormerInstanceId: orphanCreate.action.instanceId, longTitle, longBodyId, longDocumentId, template,
    swappedViewDatabaseId: swappedViewDatabase.id, sourceSwapViews, sourceSwapEntities, sourceSwapEntityValues,
    swappedEntityColumnId: swappedEntityColumn.id }
}
function currentCases(f: V3Fixture, source: ReturnType<typeof sourceCases>) {
  const [viewA, viewB] = source.sourceSwapViews
  f.store.updateDatabaseSavedView({ viewId: viewA.id, name: 'Stage Swap Temporary' })
  f.store.updateDatabaseSavedView({ viewId: viewB.id, name: viewA.name })
  f.store.updateDatabaseSavedView({ viewId: viewA.id, name: viewB.name })
  const currentSwapViews = [{ id: viewA.id, name: viewB.name }, { id: viewB.id, name: viewA.name }]
  for (const view of currentSwapViews) assert.deepEqual(f.db.prepare('SELECT id,name FROM database_saved_views WHERE id=?').get(view.id), view)
  assert.equal(f.db.prepare('SELECT 1 FROM database_saved_views WHERE database_id=? AND name=?')
    .get(source.swappedViewDatabaseId, 'Stage Swap Temporary'), undefined)
  const [entityA, entityB] = source.sourceSwapEntities
  f.store.updateDatabaseEntity({ entityId: entityA.id, documentId: null })
  f.store.updateDatabaseEntity({ entityId: entityB.id, documentId: entityA.document_id })
  f.store.updateDatabaseEntity({ entityId: entityA.id, documentId: entityB.document_id })
  const currentSwapEntities = [{ id: entityA.id, document_id: entityB.document_id }, { id: entityB.id, document_id: entityA.document_id }]
  for (const entity of currentSwapEntities)
    assert.deepEqual(f.db.prepare('SELECT id,document_id FROM database_entities WHERE id=?').get(entity.id), entity)
  assert.deepEqual(f.db.prepare('SELECT CAST(_rowid_ AS TEXT) AS rowid,entity_id,column_id,value_text,updated_at FROM database_entity_values WHERE column_id=? ORDER BY entity_id')
    .all(source.swappedEntityColumnId), source.sourceSwapEntityValues, 'The real rebinding leaves both existing entity field occurrences intact')
  const currentOnlyBlockId = randomUUID()
  const append = request(f.db, [source.linkedHostId], after => {
    after[0].blocks.push(paragraph(currentOnlyBlockId, 'Current-only ordinary block removed by the source host selection'))
  })
  const appendAck = applied(applySyncedHostFinal(f.db, append))
  assert.equal(appendAck.status, 'applied')
  assert.ok(appendAck.historyToken, 'The additional ordinary block must have genuine Main host-final history')
  const currentOnlyBlockBirth = (f.db.prepare('SELECT created_at FROM blocks WHERE id=? AND document_id=?')
    .get(currentOnlyBlockId, source.linkedHostId) as { created_at: string }).created_at
  const currentOnlyBlockLedger = f.db.prepare('SELECT id,last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id=?')
    .get(currentOnlyBlockId) as { id: string; last_owner_kind: string; last_owner_id: string; state: string; created_at: string }
  assert.deepEqual(currentOnlyBlockLedger, { id: currentOnlyBlockId, last_owner_kind: 'document', last_owner_id: source.linkedHostId,
    state: 'live', created_at: currentOnlyBlockBirth })
  const currentLinkedHostBlockCount = (f.db.prepare('SELECT count(*) AS n FROM blocks WHERE document_id=?').get(source.linkedHostId) as { n: number }).n
  assert.equal(currentLinkedHostBlockCount, 4)
  assert.equal(currentLinkedHostBlockCount, source.sourceLinkedHostBlockCount + 1)
  assert.equal((f.db.prepare('SELECT block_count FROM documents WHERE id=?').get(source.linkedHostId) as { block_count: number }).block_count, currentLinkedHostBlockCount)
  const externalBodyId = randomUUID()
  const externalHostId = document(f, 'Stage Retained External Host', [paragraph(externalBodyId, 'Current-only host and ordinary content')])
  const insert = command(f.db, { documentId: externalHostId, groupId: source.linkedGroupId })
  insertAck(applySyncedHostCommand(f.db, insert))
  const currentLinkedGroup = snapshot(f.db, source.linkedGroupId)
  assert.equal(currentLinkedGroup.instances.length, 3)
  assert.ok(currentLinkedGroup.instances.some(instance => instance.instanceId === insert.action.instanceId && instance.hostDocumentId === externalHostId))
  return { externalHostId, externalBodyId, externalInstanceId: insert.action.instanceId, currentLinkedGroup,
    currentOnlyBlockId, currentOnlyBlockBirth, currentOnlyBlockLedger, currentLinkedHostBlockCount, currentSwapViews, currentSwapEntities }
}

export type Stage3NativeEdges = { readonly encoding: 'UTF-16le' | 'UTF-16be' }
/** Fixed native storage fixtures only: Main still creates all identity, birth,
 * lifecycle and journal facts. These SQL edits alter only technical rowids,
 * saved-view ordering integers and legal ownerless nullable value occurrences. */
function nativeCases(f: V3Fixture, options: Stage3NativeEdges) {
  assert.equal(f.db.pragma('encoding', { simple: true }), options.encoding)
  const secondView = f.store.createDatabaseSavedView({ databaseId: f.customId, name: 'Stage UTF16 中文 second view',
    config: createDefaultDatabaseViewConfig('table', [f.customColumn.id]) })
  const stamp = (f.db.prepare('SELECT updated_at FROM document_database_values WHERE document_id=? AND column_id=?')
    .get(f.hostId, f.catalogColumn.id) as { updated_at: string }).updated_at
  const views = [{ id: f.view.id, rowid: '9223372036854775807', sortOrder: '9007199254740992' },
    { id: secondView.id, rowid: '-1', sortOrder: '9007199254740993' }] as const
  const anonymousSourceRowIds = ['-2', '-1'] as const
  f.db.transaction(() => {
    const update = f.db.prepare('UPDATE database_saved_views SET _rowid_=?,sort_order=? WHERE id=?')
    for (const view of views) assert.equal(update.run(BigInt(view.rowid), BigInt(view.sortOrder), view.id).changes, 1)
    const insert = f.db.prepare('INSERT INTO document_database_values(_rowid_,document_id,column_id,value_text,updated_at,entity_id) VALUES(?,NULL,?,NULL,?,NULL)')
    for (const rowid of anonymousSourceRowIds) insert.run(BigInt(rowid), f.catalogColumn.id, stamp)
  }).immediate()
  assert.deepEqual(f.db.prepare('SELECT id,CAST(_rowid_ AS TEXT) AS rowid,CAST(sort_order AS TEXT) AS sortOrder FROM database_saved_views WHERE database_id=? ORDER BY sort_order,_rowid_')
    .all(f.customId), views)
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM document_database_values WHERE document_id IS NULL AND entity_id IS NULL AND column_id=? AND value_text IS NULL')
    .get(f.catalogColumn.id) as { n: number }).n, 2)
  return { encoding: options.encoding, views, anonymousSourceRowIds, anonymousColumnId: f.catalogColumn.id, anonymousUpdatedAt: stamp }
}
async function withEncodedStage3Source(options: Stage3NativeEdges, run: (source: V3Fixture) => Promise<void>) {
  assert.ok(options.encoding === 'UTF-16le' || options.encoding === 'UTF-16be')
  const root = mkdtempSync(join(tmpdir(), 'knowbook-stage3-native-')), file = join(root, 'profile', 'storage', 'knowbook.db')
  let initial: Database.Database | undefined, source: V3Fixture | undefined
  try {
    mkdirSync(dirname(file), { recursive: true })
    initial = new Database(file)
    initial.pragma("encoding='" + options.encoding + "'")
    initial.exec('CREATE TABLE stage3_encoding_anchor(value TEXT); DROP TABLE stage3_encoding_anchor')
    assert.equal(initial.pragma('encoding', { simple: true }), options.encoding)
    initial.close(); initial = undefined
    source = createV3Fixture(root)
    assert.equal(source.db.pragma('encoding', { simple: true }), options.encoding)
    assert.equal(source.db.prepare("SELECT 1 FROM sqlite_master WHERE name='stage3_encoding_anchor'").get(), undefined)
    await run(source)
  } finally {
    initial?.close(); source?.close()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('knowbook-stage3-native-'))
    rmSync(root, { recursive: true, force: true })
  }
}
export async function withStage3Fixture(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>, phase: (name: string) => void = () => {},
  choices: Reference3Choices = { originPolicy: 'isolate-incoming', anonymousValues: 'source' }, nativeEdges?: Stage3NativeEdges) {
  const consume = (source: V3Fixture) => withV3Fixture(async receiver => run(await setup(source, receiver, phase, choices, nativeEdges)))
  if (nativeEdges) await withEncodedStage3Source(nativeEdges, consume)
  else await withV3Fixture(consume)
}
async function setup(source: V3Fixture, receiver: V3Fixture, phase: (name: string) => void, choices: Reference3Choices, nativeOptions?: Stage3NativeEdges) {
  const before = sourceCases(source); phase('source-main-cases-ready')
  const nativeEdges = nativeOptions ? nativeCases(source, nativeOptions) : undefined
  const left = await captureMixedSource(source, 2)
  const sourcePacket = (await tryReadCertifiedCapsule2SourceInputs(left.handle))!.value
  phase('source-captured')
  const after = currentCases(source, before)
  const right = await captureMixedSource(source, 2)
  const currentPacket = (await tryReadCertifiedCapsule2SourceInputs(right.handle))!.value
  phase('current-captured')
  const dag = await captureActualFirstRequiredSqlDag({ profileRoot: source.userDataRoot,
    operationId: basename(left.original.info.recoveryDirectory), dagId: randomUUID(), source: left.handle, current: right.handle })
  const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
  const saved = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: receiver.userDataRoot,
    operationId: randomUUID(), sourceDirectory: exported.directory })
  phase('knowledge-captured')
  const base = await prepareRootRestoreIdentityPlan3(saved.knowledgePlan)
  const prepared = await prepareRootRestoreReferencePlan3(base.plan, choices)
  assert.deepEqual(prepared.value.candidate.conflicts, [], 'This must remain a clean actual Main fixture; do not waive conflicts to let a stage writer run')
  assert.equal(prepared.value.candidate.candidateConflictFree, true)
  assert.equal(prepared.value.candidate.materialization.actualStageLedgerWritten, false)
  assert.equal(prepared.value.candidate.referenceRewriteComplete, false)
  assert.equal(prepared.value.candidate.permit, false)
  phase('conflict-free-reference-prepared')
  return { source, receiver, left, right, sourcePacket, currentPacket, dag, exported, saved, base, prepared,
    cases: { ...before, ...after }, nativeEdges, beforeSource: allTables(source.db), beforeReceiver: allTables(receiver.db) }
}
