import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import test from 'node:test'
import { readRawCapsule2AssetReferencesOwned, type RawCapsule2AssetReferences } from '../src/main/database/restore-knowledge-capsule2-assets-read'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { addV3Assets, withV3Fixture, snapshot, createRequest, created, applySyncedHostCommand,
  applySyncedHostFinal, request, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { editCreatedGroup, restoreCreated } from './helpers/synced-host-command-create-fixture'
import { advanceSyncedRecoveryEpoch } from '../src/main/database/synced-recovery-boundary'
import { recoveryBoundaryKey } from '../src/main/database/synced-recovery-boundary-model'

const image = (uri: string) => `![retained](<${uri}>)`
const contains = (value: RawCapsule2AssetReferences, source: string[], uri: string) => {
  const scope = value.scopes.find(scope => JSON.stringify(scope.source) === JSON.stringify(source))
  assert.ok(scope, 'The actual original SQL holder has its own complete source locator: ' + JSON.stringify(source))
  assert.ok(scope.destinations.some(item => item.uri === uri), 'The original Markdown URI remains in that exact holder: ' + uri)
}
async function observe(f: V3Fixture, check: (value: RawCapsule2AssetReferences, db: Database.Database) => void) {
  const groupBefore = snapshot(f.db, f.groupId)
  const operations = f.db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all()
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const before = readRawCapsule2ContentOwned(db), history = readRawCapsule2WorkspaceHistoryOwned(db)
    const value = readRawCapsule2AssetReferencesOwned(db)
    assert.equal(value.version, 2)
    assert.equal(value.workspaceHistoryObservationHash, history.observationHash)
    assert.equal(value.sourceContentHash, history.sourceContentHash)
    check(value, db)
    assert.deepEqual(readRawCapsule2ContentOwned(db), before)
    assert.deepEqual(readRawCapsule2WorkspaceHistoryOwned(db), history)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
    assert.equal(value.certified, false); assert.equal(value.semanticValidationComplete, false); assert.equal(value.permit, false)
    assert.equal(value.sourceFileOwnershipVerified, false); assert.equal(value.sourceFileBytesVerified, false)
    assert.ok(value.unresolved.includes('remaining-policy-held-payload-asset-scopes'))
    for (const scope of value.scopes) assert.ok(Object.isFrozen(scope) && Object.isFrozen(scope.source) && Object.isFrozen(scope.destinations))
  })())
  assert.deepEqual(snapshot(f.db, f.groupId), groupBefore)
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all(), operations)
}

test('capsule2 assets retain actual host ACK/create wire and group history after their asset disappears from every current body', () => withV3Fixture(async f => {
  const assets = await addV3Assets(f), uri = assets.attachments[0].url
  const before = snapshot(f.db, assets.groupId)
  const saved = editCreatedGroup(f.db, assets.groupId, before.blocks.map(({ createdAt: _birth, ...block }) => ({ ...block, content: 'Actual later body without an asset' })))
  await observe(f, (value, db) => {
    assert.equal(value.scopes.filter(scope => ['documents', 'synced_groups'].includes(scope.source[0]))
      .some(scope => scope.destinations.some(item => item.uri === uri)), false)
    const history = db.prepare('SELECT id FROM synced_group_history WHERE group_id=?').get(assets.groupId) as { id: string }
    contains(value, ['synced_group_history', history.id, 'before_json'], uri)
    contains(value, ['synced_host_history', assets.ack.historyToken, 'action_json', 'create', 'wire'], uri)
    contains(value, ['synced_operations', assets.ack.operationId, 'result_json', 'result', 'groups', assets.groupId], uri)
    contains(value, ['synced_operations', assets.ack.operationId, 'result_json', 'result', 'hosts', f.hostId, 'logicalBefore'], uri)
    assert.ok(value.scopes.find(scope => scope.source[0] === 'synced_operations' && scope.source[1] === saved.operationId))
  })
}))

test('capsule2 assets distinguish real create journal persisted P from working W and canonical create wire', () => withV3Fixture(async f => {
  const documentId = f.store.createDocument(null), blockId = randomUUID()
  const files = await f.assets.import([{ name: 'persisted-before-create.png', bytes: Buffer.from('real persisted asset') },
    { name: 'working-before-create.png', bytes: Buffer.from('real working asset') }])
  const [p, w] = files.map(file => file.url)
  f.store.updateDocument(documentId, { title: 'P W create assets', summary: '', blocks: [
    { id: blockId, type: 'paragraph', content: image(p), checked: false, depth: 0, parentBlockId: null }
  ] })
  const input = createRequest(f.db, { documentId, selectedRootIds: [blockId], dirty(content) { content.blocks[0].content = image(w) } })
  const ack = created(applySyncedHostCommand(f.db, input))
  await observe(f, value => {
    contains(value, ['synced_host_history', ack.historyToken, 'action_json', 'persisted', documentId], p)
    contains(value, ['synced_host_history', ack.historyToken, 'before_json', documentId], w)
    contains(value, ['synced_host_history', ack.historyToken, 'action_json', 'input', 'hostsWorkingBefore', documentId], w)
    contains(value, ['synced_host_history', ack.historyToken, 'action_json', 'create', 'wire'], w)
    contains(value, ['synced_operations', ack.operationId, 'result_json', 'result', 'hosts', documentId, 'logicalBefore'], w)
  })
}))

test('capsule2 assets retain actual host-final P W and finalAfter holders after Main removes their ordinary block', () => withV3Fixture(async f => {
  const files = await f.assets.import([{ name: 'host-p.png', bytes: Buffer.from('real host persisted asset') },
    { name: 'host-w.png', bytes: Buffer.from('real host working asset') }])
  const [p, w] = files.map(file => file.url), bodyId = randomUUID()
  const prime = request(f.db, [f.hostId], (after, working) => {
    after[0].summary = image(p)
    after[0].blocks.push({ id: bodyId, type: 'paragraph', content: image(p), checked: false, depth: 0, parentBlockId: null })
    working[0].workingBefore.summary = after[0].summary
    working[0].workingBefore.blocks = structuredClone(after[0].blocks)
  })
  const primed = applySyncedHostFinal(f.db, prime)
  assert.equal(primed.status, 'applied'); if (primed.status !== 'applied') throw new Error('Real Main save required')
  assert.equal(primed.historyToken, null, 'Actual P differs from equal W/A; Main saves without manufacturing an inverse journal')
  const input = request(f.db, [f.hostId], (after, working) => {
    working[0].workingBefore.summary = image(w)
    working[0].workingBefore.blocks.find(block => block.id === bodyId)!.content = image(w)
    after[0].summary = image(w)
    after[0].blocks = after[0].blocks.filter(block => block.id !== bodyId)
  })
  const ack = applySyncedHostFinal(f.db, input)
  assert.equal(ack.status, 'applied'); if (ack.status !== 'applied') throw new Error('Real host-final required')
  assert.ok(ack.historyToken)
  await observe(f, value => {
    contains(value, ['synced_host_history', ack.historyToken!, 'action_json', 'persisted', f.hostId], p)
    contains(value, ['synced_host_history', ack.historyToken!, 'before_json', f.hostId], w)
    contains(value, ['synced_host_history', ack.historyToken!, 'after_json', f.hostId], w)
    contains(value, ['synced_host_history', ack.historyToken!, 'action_json', 'input', 'finalAfter', f.hostId], w)
    contains(value, ['synced_operations', ack.operationId, 'result_json', 'result', 'hosts', f.hostId, 'after'], w)
  })
}))

test('capsule2 assets retain genuine retired-create wire and inverse ACK when the physical group has no current snapshot', () => withV3Fixture(async f => {
  const assets = await addV3Assets(f), uri = assets.attachments[0].url
  const inverse = restoreCreated(f.db, assets.ack, 'undo').ack
  assert.equal(inverse.createdLifecycle.state, 'retired-create')
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM synced_group_blocks WHERE group_id=?').get(assets.groupId) as { n: number }).n, 0)
  await observe(f, value => {
    assert.equal(value.scopes.some(scope => scope.source[0] === 'synced_groups' && scope.source[1] === assets.groupId), false)
    contains(value, ['synced_group_retirements', assets.groupId, 'wire_json'], uri)
    contains(value, ['synced_operations', inverse.operationId, 'result_json', 'result', 'createdLifecycle', 'wire'], uri)
  })
}))

test('capsule2 assets retain real recovery-boundary group history sides across an epoch cut and a new live content branch', () => withV3Fixture(async f => {
  const assets = await addV3Assets(f), groupId = assets.groupId
  const [next] = await f.assets.import([{ name: 'recovery next.png', bytes: Buffer.from('Actual next recovery history asset') }])
  const old = snapshot(f.db, groupId)
  editCreatedGroup(f.db, groupId, old.blocks.map(({ createdAt: _birth, ...block }) => ({ ...block, content: image(next.url) })))
  const row = f.db.prepare('SELECT id FROM synced_group_history WHERE group_id=?').get(groupId) as { id: string }
  const before = f.db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state').get() as { workspace_scope: string; recovery_epoch: string }
  const operationId = randomUUID(), acceptedAt = '2041-01-01T00:00:00.000Z'
  f.db.transaction(() => advanceSyncedRecoveryEpoch(f.db, { operationId, expectedWorkspaceScope: before.workspace_scope,
    expectedRecoveryEpoch: before.recovery_epoch, workspaceScope: before.workspace_scope, recoveryEpoch: randomUUID(),
    acceptedAt, documentBoundary: acceptedAt })).immediate()
  const current = snapshot(f.db, groupId)
  editCreatedGroup(f.db, groupId, current.blocks.map(({ createdAt: _birth, ...block }) => ({ ...block, content: 'Actual new branch without an asset' })))
  await observe(f, (value, db) => {
    assert.equal(db.prepare('SELECT 1 FROM synced_group_history WHERE id=?').get(row.id), undefined)
    const source = ['app_settings', recoveryBoundaryKey(operationId), 'value', 'groups', groupId, 'rows', row.id]
    contains(value, [...source, 'before_json'], assets.attachments[0].url)
    contains(value, [...source, 'after_json'], next.url)
  })
}))

test('capsule2 assets enumerate the actual129th canonical history row and permanent group ACK without a128-row cap', () => withV3Fixture(async f => {
  const documentId = f.store.createDocument(null), blockId = randomUUID()
  const files: Array<{ url: string }> = []
  for (let offset = 0; offset < 130; offset += 20) files.push(...await f.assets.import(
    Array.from({ length: Math.min(20, 130 - offset) }, (_, index) => ({ name: `history-${offset + index}.png`, bytes: Buffer.from('Actual same-hash historical aliases') }))))
  f.store.updateDocument(documentId, { title: 'Long real group asset history', summary: '', blocks: [
    { id: blockId, type: 'paragraph', content: image(files[0].url), checked: false, depth: 0, parentBlockId: null }
  ] })
  const input = createRequest(f.db, { documentId, selectedRootIds: [blockId] })
  created(applySyncedHostCommand(f.db, input))
  let lastOperation = ''
  for (let index = 1; index <= 129; index++) {
    const current = snapshot(f.db, input.action.groupId)
    lastOperation = editCreatedGroup(f.db, input.action.groupId, current.blocks.map(({ createdAt: _birth, ...block }) => ({ ...block, content: image(files[index].url) }))).operationId
  }
  await observe(f, (value, db) => {
    const rows = db.prepare('SELECT id FROM synced_group_history WHERE group_id=? ORDER BY position').all(input.action.groupId) as Array<{ id: string }>
    assert.equal(rows.length, 129)
    contains(value, ['synced_group_history', rows[64].id, 'before_json'], files[64].url)
    contains(value, ['synced_group_history', rows[128].id, 'after_json'], files[129].url)
    contains(value, ['synced_operations', lastOperation, 'result_json', 'snapshot'], files[129].url)
  })
}))
