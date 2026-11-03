import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readSyncedGroupLifecycles } from '../src/main/database/synced-lifecycle-state'
import { readSyncedBaselineMetadataCaptureOwned2 } from '../src/main/database/synced-binding-sources'
import { SYNCED_METADATA_BASELINE2_PREFIX } from '../src/main/database/synced-metadata-capture-record2'
import { withTitle2Fixture } from './helpers/metadata2-title-fixture'
import { snapshot, randomUUID, allTables } from './helpers/synced-backup-v3-fixture'
import { OrdinaryRenameRequiresTitle2 } from '../src/main/database/ordinary-title-rename-admission2'
import { hostHash } from '../src/main/database/synced-host-journal'

type OriginalRow = { client_operation_id: string; request_hash: string; result_json: string; created_at: string; original_bytes: Buffer }

test('a readonly ordinary rename hint cannot bypass a later real canonical dependency and the exact no-reference target session maintains both original typed fields', () => withTitle2Fixture(t => {
  const { store, f } = t, db = store.getUnsafeDatabaseHandle()
  const target = store.getDocumentDetail(t.childId)!
  assert.ok(target && target.blocks.length)
  assert.equal(target.blocks.some(block => block.type === 'synced-block'), false)
  const targetBlockId = target.blocks[0].id
  const targetBirth = db.prepare('SELECT created_at FROM documents WHERE id=?').get(target.id)
  const targetBlockBirth = db.prepare('SELECT id,document_id,created_at FROM blocks WHERE id=?').get(targetBlockId)
  assert.ok(targetBirth && targetBlockBirth)
  const earlyHint = store.getDocumentRenameAdmission({ documentId: target.id, expectedUpdatedAt: target.updatedAt })
  assert.equal(earlyHint.status, 'ready')
  if (earlyHint.status !== 'ready') throw new Error('The original readonly hint must be ready')
  assert.equal(earlyHint.requiresFencedTitle2, false)
  assert.equal(earlyHint.writePermit, false)

  const sourceId = store.createDocument(null), documentLinkId = randomUUID(), blockLinkId = randomUUID()
  const originalUrl = target.path.split('/').map(encodeURIComponent).join('/') + '.md'
  const ordinary = (id: string, content: string) => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null })
  store.updateDocument(sourceId, { title: 'Ordinary target rename source', summary: 'Actual published typed source', blocks: [
    ordinary(documentLinkId, '[Original ordinary document](' + originalUrl + ')'),
    ordinary(blockLinkId, '[Original ordinary block](' + originalUrl + '#^' + targetBlockId + ')')
  ] })
  const sender = Object.freeze({ frame: 'ordinary target rename original source' })
  const opened = store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: sourceId })
  assert.equal(opened.status, 'ready')
  if (opened.status !== 'ready') throw new Error('The real source host session must open')
  const source = store.getDocumentDetail(sourceId)!, groupId = randomUUID(), instanceId = randomUUID()
  const created = store.invokeSyncedEditingSession(sender, { sessionId: opened.session.sessionId, method: 'applySyncedHostStructure', input: {
    clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore: [{ documentId: sourceId,
      expectedPersistedUpdatedAt: source.updatedAt, workingBefore: { title: source.title, summary: source.summary,
        blocks: source.blocks.map(({ sortOrder: _sortOrder, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null })) } }],
    groups: [], expectedInstances: [], action: { kind: 'create', documentId: sourceId,
      selectedRootIds: [documentLinkId, blockLinkId], groupId, instanceId }
  } })
  assert.equal(created.status, 'applied')
  if (created.status !== 'applied') throw new Error('The real source group create must commit')
  assert.ok(created.historyToken)
  const original = snapshot(db, groupId)
  assert.deepEqual(original.bindings.find(item => item.blockId === documentLinkId)!.target, { kind: 'document', id: target.id, state: 'live' })
  assert.deepEqual(original.bindings.find(item => item.blockId === blockLinkId)!.target,
    { kind: 'block', id: targetBlockId, documentId: target.id, state: 'live' })
  const createOriginal = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at,CAST(result_json AS BLOB) AS original_bytes FROM synced_operations WHERE client_operation_id=?')
    .get(created.operationId) as OriginalRow
  assert.ok(createOriginal)

  // A real producer confirms publication. No lifecycle/pin/ACK SQL is forged.
  writeSyncedBackupV3(db, { userDataRoot: realpathSync(f.userDataRoot),
    destination: join(realpathSync(f.root), 'ordinary-target-published-source'), snapshotId: randomUUID() })
  assert.equal(readSyncedGroupLifecycles(db, [groupId]).get(groupId)?.exposure, 'confirmed')
  const mounted = store.openSyncedEditingSession(sender, { kind: 'instance', hostDocumentId: sourceId, instanceId, groupId })
  assert.equal(mounted.status, 'ready')
  if (mounted.status !== 'ready') throw new Error('The published original instance must open')
  const captured = store.invokeSyncedEditingSession(sender, { sessionId: mounted.session.sessionId, method: 'captureBaseline', input: { groupId } })
  assert.equal(captured.status, 'ready')
  if (captured.status !== 'ready') throw new Error('The real source point must be captured')
  const point = db.transaction(() => readSyncedBaselineMetadataCaptureOwned2(db, captured.readOwnerId))()
  assert.equal(point.status, 'captured')
  if (point.status !== 'captured') throw new Error('The genuine owner must bind its actual persisted point')
  assert.deepEqual(point.record.sources.find(item => item.wire.id === groupId)!.wire.blocks, original.blocks)
  const capturedDocument = point.record.capture.targets.find(item => item.key.blockId === documentLinkId)
  assert.ok(capturedDocument && capturedDocument.status === 'current-document')
  if (!capturedDocument || capturedDocument.status !== 'current-document') throw new Error('The original point must witness the actual ordinary target')
  assert.equal(capturedDocument.documentId, target.id)
  assert.deepEqual(db.prepare('SELECT created_at FROM documents WHERE id=?').get(capturedDocument.documentId), { created_at: capturedDocument.documentCreatedAt })
  const capturedBlock = point.record.capture.targets.find(item => item.key.blockId === blockLinkId)
  assert.ok(capturedBlock && capturedBlock.status === 'current-block')
  if (!capturedBlock || capturedBlock.status !== 'current-block') throw new Error('The point must retain the actual target block birth')
  assert.equal(capturedBlock.blockId, targetBlockId)
  assert.deepEqual(db.prepare('SELECT created_at FROM blocks WHERE id=?').get(capturedBlock.blockId), { created_at: capturedBlock.createdAt })
  assert.equal(point.record.businessOperationCommitted, false)
  assert.equal(point.record.writePermit, false)
  const pointSql = 'SELECT client_operation_id,request_hash,result_json,created_at,CAST(result_json AS BLOB) AS original_bytes FROM synced_operations WHERE substr(client_operation_id,1,?)=? ORDER BY client_operation_id'
  const originalPoint = (db.prepare(pointSql).all(SYNCED_METADATA_BASELINE2_PREFIX.length, SYNCED_METADATA_BASELINE2_PREFIX) as OriginalRow[])
    .filter(row => row.request_hash === point.record.recordHash)
  assert.equal(originalPoint.length, 1)

  // The earlier false hint preceded a real Main create/publication. The legacy
  // entry must re-read actual affected bindings in its own write transaction.
  const title = 'Renamed ordinary target 中文🙂'
  const blocks = target.blocks.map(({ sortOrder: _sortOrder, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null }))
  const beforeRefusal = allTables(db), beforeChanges = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  assert.throws(() => store.updateDocument(target.id, { expectedUpdatedAt: target.updatedAt, title, summary: target.summary, blocks }), OrdinaryRenameRequiresTitle2)
  assert.deepEqual(allTables(db), beforeRefusal)
  assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, beforeChanges)
  const hint = store.getDocumentRenameAdmission({ documentId: target.id, expectedUpdatedAt: target.updatedAt })
  assert.equal(hint.status, 'ready')
  if (hint.status !== 'ready') throw new Error('The new actual dependency must have a readonly routing result')
  assert.equal(hint.requiresFencedTitle2, true); assert.equal(hint.writePermit, false)
  assert.deepEqual(allTables(db), beforeRefusal)
  assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, beforeChanges)
  const targetSender = Object.freeze({ frame: 'only the exact ordinary target was opened' })
  const targetSession = store.openSyncedEditingSession(targetSender, { kind: 'host', hostDocumentId: target.id })
  assert.equal(targetSession.status, 'ready')
  if (targetSession.status !== 'ready') throw new Error('The genuine no-ref target host session must open')
  const nonce = randomUUID(), rawW = { title, summary: target.summary, blocks }
  const saved = store.invokeSyncedEditingSession(targetSender, { sessionId: targetSession.session.sessionId, method: 'applySyncedHostStructure', input: {
    clientOperationId: nonce, mode: 'host-final', reason: 'selection-edit', groups: [], expectedInstances: [], newRefSources: [],
    hostsWorkingBefore: [{ documentId: target.id, expectedPersistedUpdatedAt: target.updatedAt, workingBefore: rawW }],
    finalAfter: [{ documentId: target.id, ...rawW }]
  } })
  assert.equal(saved.status, 'applied')
  if (saved.status !== 'applied') throw new Error('Only an actual complete Main title ACK is accepted')
  assert.equal(saved.historyToken, null); assert.equal(saved.hosts[0].logicalBeforeHash, hostHash(rawW))
  const known = store.invokeSyncedEditingSession(targetSender, { sessionId: targetSession.session.sessionId, method: 'getSyncedOperation', input: { clientOperationId: nonce } })
  assert.equal(known.status, 'committed')
  if (known.status === 'committed') assert.equal(known.result.operationId, nonce)
  const afterTarget = store.getDocumentDetail(target.id)!
  assert.equal(afterTarget.title, title)
  assert.equal(afterTarget.blocks.some(block => block.type === 'synced-block'), false)
  assert.deepEqual(db.prepare('SELECT created_at FROM documents WHERE id=?').get(target.id), targetBirth)
  assert.deepEqual(db.prepare('SELECT id,document_id,created_at FROM blocks WHERE id=?').get(targetBlockId), targetBlockBirth)

  // A real later document occupies the exact old path. It cannot replace the
  // source point's typed document/block target or its immutable source rows.
  const occupantId = store.createDocument(f.hostId)
  store.updateDocument(occupantId, { title: target.title, summary: 'Later old-path occupant',
    blocks: [ordinary(randomUUID(), 'This new document is not the original target')] })
  assert.equal(store.getDocumentDetail(occupantId)!.path, target.path)
  assert.notEqual(occupantId, target.id)
  const after = snapshot(db, groupId)
  assert.deepEqual(after.origin, original.origin)
  assert.equal(after.creationId, original.creationId)
  assert.equal(after.createdAt, original.createdAt)
  assert.equal(after.topologyRevision, original.topologyRevision)
  assert.deepEqual(after.blocks.map(block => [block.id, block.createdAt]), original.blocks.map(block => [block.id, block.createdAt]))
  assert.deepEqual(after.bindings.map(item => item.target), original.bindings.map(item => item.target))
  for (const binding of after.bindings) assert.equal(after.blocks.find(block => block.id === binding.blockId)!.content.slice(binding.from, binding.to), binding.raw)
  assert.deepEqual(db.prepare('SELECT client_operation_id,request_hash,result_json,created_at,CAST(result_json AS BLOB) AS original_bytes FROM synced_operations WHERE client_operation_id=?')
    .get(created.operationId), createOriginal)
  assert.deepEqual(db.prepare(pointSql).all(SYNCED_METADATA_BASELINE2_PREFIX.length, SYNCED_METADATA_BASELINE2_PREFIX)
    .filter((row: unknown) => (row as OriginalRow).client_operation_id === originalPoint[0].client_operation_id), originalPoint)

  const expectedUrl = afterTarget.path.split('/').map(encodeURIComponent).join('/') + '.md'
  assert.equal(after.blocks.find(block => block.id === documentLinkId)!.content,
    '[Original ordinary document](' + expectedUrl + ')', 'The real ordinary rename must maintain the original canonical document field, not only ordinary blocks')
  assert.equal(after.blocks.find(block => block.id === blockLinkId)!.content,
    '[Original ordinary block](' + expectedUrl + '#^' + targetBlockId + ')', 'The same real target block needs its new path hint with the original stable block ID')
}))
