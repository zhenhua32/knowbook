import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readBackupV3Archive } from '../src/main/backup/v3-reader'
import { TITLE2_HEADING_SCOPE, TITLE2_SECTION_SCOPE } from '../src/main/database/synced-host-title2-codec'
import { readTitle2OriginalOperationOwned } from '../src/main/database/synced-host-title2-read'
import { assertRawSyncedHistoricalEvidenceOwned } from '../src/main/database/synced-operation-history-read'
import { OrdinaryRenameRequiresTitle2 } from '../src/main/database/ordinary-title-rename-admission2'
import { withTitle2Fixture } from './helpers/metadata2-title-fixture'
import { restoreInput } from './helpers/synced-host-final-fixture'
import { command as insertRequest } from './helpers/synced-host-command-insert-fixture'
import { allTables, createRequest, freshBlock, randomUUID, request, snapshot } from './helpers/synced-backup-v3-fixture'

test('a real title change, undo and redo retain the original title and ordinary heading occurrences when their slugs collide', () => withTitle2Fixture(t => {
  const { store, f, sender } = t, db = store.getUnsafeDatabaseHandle()
  const sourceId = store.createDocument(null), titleLink = randomUUID()
  store.updateDocument(sourceId, { title: 'Canonical title anchor source', summary: '', blocks: [
    freshBlock(titleLink, '[title](V3%20Target.md#v3-target)')
  ] })
  const source = store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: sourceId })
  assert.equal(source.status, 'ready')
  if (source.status !== 'ready') throw new Error('Actual title source host must open')
  const create = createRequest(db, { documentId: sourceId, selectedRootIds: [titleLink] })
  const result = store.invokeSyncedEditingSession(sender, { sessionId: source.session.sessionId, method: 'applySyncedHostStructure', input: create })
  assert.equal(result.status, 'applied')
  writeSyncedBackupV3(db, { userDataRoot: realpathSync(f.userDataRoot),
    destination: join(realpathSync(f.root), 'published-title-anchor'), snapshotId: randomUUID() })
  const titleGroup = create.action.groupId, originalTitle = snapshot(db, titleGroup), originalSection = snapshot(db, f.groupId)
  const target = store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: f.targetId })
  assert.equal(target.status, 'ready')
  if (target.status !== 'ready') throw new Error('Actual anchor target host must open')
  const sessionId = target.session.sessionId
  const input = request(db, [f.targetId], after => { after[0].title = 'Target heading' })
  const saved = store.invokeSyncedEditingSession(sender, { sessionId, method: 'applySyncedHostStructure', input })
  assert.equal(saved.status, 'applied')
  if (saved.status !== 'applied') throw new Error('Actual heading maintenance ACK required')

  const checkBindings = (documentPath: string, titleSlug: string, sectionSlug: string) => {
    const title = snapshot(db, titleGroup), section = snapshot(db, f.groupId)
    assert.deepEqual(title.bindings[0].target, { kind: 'heading', documentId: f.targetId, slug: titleSlug, state: 'live' })
    assert.deepEqual(section.bindings[0].target, { kind: 'heading', documentId: f.targetId, slug: sectionSlug, state: 'live' })
    assert.equal(title.bindings[0].raw, `${documentPath}.md#${titleSlug}`)
    assert.equal(section.bindings[0].raw, `${documentPath}.md#${sectionSlug}`)
    assert.deepEqual(title.origin, originalTitle.origin)
    assert.deepEqual(section.origin, originalSection.origin)
    assert.deepEqual(title.blocks.map(block => [block.id, block.createdAt]), originalTitle.blocks.map(block => [block.id, block.createdAt]))
    assert.deepEqual(section.blocks.map(block => [block.id, block.createdAt]), originalSection.blocks.map(block => [block.id, block.createdAt]))
  }
  checkBindings('Target%20heading', 'target-heading', 'target-heading-1')
  const cold = f.connect(), original = cold.transaction(() => readTitle2OriginalOperationOwned(cold, saved.operationId))()
  assert.equal(original?.companion.scope, TITLE2_HEADING_SCOPE)
  assert.equal(original?.materials.find(item => item.group.groupId === titleGroup)?.sourcePoint.capture.targets[0].status, 'current-heading')
  assert.deepEqual(original?.envelope.result, saved)

  const undone = store.invokeSyncedEditingSession(sender, { sessionId, method: 'restoreSyncedHostOperation', input: restoreInput(db, saved, 'undo') })
  assert.equal(undone.status, 'applied')
  checkBindings('V3%20Target', 'v3-target', 'target-heading')
  const redone = store.invokeSyncedEditingSession(sender, { sessionId, method: 'restoreSyncedHostOperation', input: restoreInput(db, saved, 'redo') })
  assert.equal(redone.status, 'applied')
  checkBindings('Target%20heading', 'target-heading', 'target-heading-1')

  const draft = request(db, [f.targetId], (after, before) => {
    before[0].workingBefore.title = after[0].title = 'Saved from header'
  })
  const flushed = store.invokeSyncedEditingSession(sender, { sessionId, method: 'applySyncedHostStructure', input: draft })
  assert.equal(flushed.status, 'applied')
  if (flushed.status !== 'applied') throw new Error('A normal dirty header save must commit')
  assert.equal(flushed.historyToken, null, 'The normal dirty W=A save must not introduce a synthetic Undo action')
  checkBindings('Saved%20from%20header', 'saved-from-header', 'target-heading')

  const detail = store.getDocumentDetail(f.targetId)!
  store.updateDocument(f.targetId, { title: detail.title, summary: detail.summary,
    blocks: detail.blocks.map(({ sortOrder: _sortOrder, ...block }) => ({ ...block, id: randomUUID() })) })
  const beforeRefusal = allTables(db)
  const replacement = request(db, [f.targetId], after => { after[0].title = 'Must retain the original anchor' })
  const refused = store.invokeSyncedEditingSession(sender, { sessionId, method: 'applySyncedHostStructure', input: replacement })
  assert.equal(refused.status, 'unsupported')
  if (refused.status !== 'unsupported') throw new Error('A new heading with the same slug cannot replace the retained occurrence')
  assert.match(refused.reason, /heading.*persisted birth/)
  assert.deepEqual(allTables(db), beforeRefusal)
}))

for (const withReference of [true, false]) test(`a fenced body heading save ${withReference ? 'with' : 'without'} a host reference maintains its original anchor and rejects mixed drafts`, () => withTitle2Fixture(t => {
  const { store, f, sender } = t, db = store.getUnsafeDatabaseHandle()
  const ordinarySource = store.createDocument(null), ordinaryLink = randomUUID()
  store.updateDocument(ordinarySource, { title: 'Ordinary section anchor source', summary: '', blocks: [
    freshBlock(ordinaryLink, '[section](V3%20Target.md#target-heading) [title](V3%20Target.md#v3-target)')
  ] })
  const openTarget = () => {
    const target = store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: f.targetId })
    assert.equal(target.status, 'ready')
    if (target.status !== 'ready') throw new Error('Actual section anchor target host must open')
    return target.session.sessionId
  }
  let sessionId = openTarget()
  const invoke = (input: ReturnType<typeof request> | ReturnType<typeof insertRequest>) =>
    store.invokeSyncedEditingSession(sender, { sessionId, method: 'applySyncedHostStructure', input })
  if (withReference) {
    assert.equal(invoke(insertRequest(db, { documentId: f.targetId, groupId: t.groupId })).status, 'applied')
    sessionId = openTarget()
  }
  const originalGroup = snapshot(db, f.groupId)
  const headingBirth = () => (db.prepare('SELECT created_at FROM blocks WHERE id=?').get(f.targetBodyId) as { created_at: string }).created_at
  const originalBirth = headingBirth()
  const rename = (heading: string) => request(db, [f.targetId], (after, before) => {
    for (const blocks of [before[0].workingBefore.blocks, after[0].blocks]) blocks.find(block => block.id === f.targetBodyId)!.content = heading
  })
  const changed = rename('V3 Target')
  if (!withReference) {
    const { expectedPersistedUpdatedAt: expectedUpdatedAt, workingBefore } = changed.hostsWorkingBefore[0]
    const hint = (headingSlugs: string[]) => {
      const result = store.getDocumentRenameAdmission({ documentId: f.targetId, expectedUpdatedAt, headingSlugs })
      assert.equal(result.status, 'ready')
      if (result.status !== 'ready') throw new Error('A current section hint must be available')
      assert.equal(result.writePermit, false)
      return result.requiresFencedTitle2
    }
    assert.equal(hint(['v3-target']), false)
    const beforeGuard = allTables(db)
    assert.throws(() => store.updateDocument(f.targetId, { ...workingBefore, expectedUpdatedAt }), OrdinaryRenameRequiresTitle2)
    assert.deepEqual(allTables(db), beforeGuard)
    assert.equal(hint(['target-heading']), true)
  }
  const saved = invoke(changed)
  assert.equal(saved.status, 'applied', JSON.stringify(saved))
  if (saved.status !== 'applied') throw new Error('Actual section maintenance ACK required')
  assert.equal(saved.historyToken, null)
  assert.equal(saved.hosts[0].after.title, 'V3 Target')
  assert.equal(saved.hosts[0].after.blocks.find(block => block.id === f.targetBodyId)?.content, 'V3 Target')
  assert.equal(headingBirth(), originalBirth)
  const checkLinks = (slug: string) => {
    const group = snapshot(db, f.groupId)
    assert.deepEqual(group.bindings[0].target, { kind: 'heading', documentId: f.targetId, slug, state: 'live' })
    assert.equal(group.bindings[0].raw, `V3%20Target.md#${slug}`)
    assert.equal(store.getDocumentDetail(ordinarySource)?.blocks[0].content, `[section](V3%20Target.md#${slug}) [title](V3%20Target.md#v3-target)`)
    assert.deepEqual(group.blocks.map(block => [block.id, block.createdAt]), originalGroup.blocks.map(block => [block.id, block.createdAt]))
  }
  checkLinks('v3-target-1')
  const destination = join(realpathSync(f.root), 'published-after-section-heading')
  writeSyncedBackupV3(db, { userDataRoot: realpathSync(f.userDataRoot), destination, snapshotId: randomUUID() })
  const archive = readBackupV3Archive(destination)
  assert.equal(archive.groups.find(group => group.wire.id === f.groupId)?.wire.bindings[0].raw, 'V3%20Target.md#v3-target-1')
  assert.deepEqual(invoke(changed), { ...saved, replayed: true })

  const mixed = rename('Mixed section')
  const extra = freshBlock(randomUUID(), 'Unrelated dirty body edit')
  mixed.hostsWorkingBefore[0].workingBefore.blocks.push(extra)
  mixed.finalAfter[0].blocks.push(extra)
  const beforeMixed = allTables(db)
  assert.equal(invoke(mixed).status, 'unsupported')
  assert.deepEqual(allTables(db), beforeMixed)
  checkLinks('v3-target-1')

  const reversed = invoke(rename('Target heading'))
  assert.equal(reversed.status, 'applied', JSON.stringify(reversed))
  checkLinks('target-heading')
  assert.equal(headingBirth(), originalBirth)
  if (reversed.status !== 'applied') throw new Error('The original heading save must reverse through an actual second save')
  store.releaseAllSyncedEditingSessions(); store.destroy(); f.close()
  const cold = new Database(f.file, { readonly: true, fileMustExist: true })
  try {
    cold.pragma('foreign_keys=ON'); cold.pragma('query_only=ON')
    const read = (id: string) => cold.transaction(() => readTitle2OriginalOperationOwned(cold, id))()
    const original = read(saved.operationId)
    assert.equal(original?.companion.scope, TITLE2_SECTION_SCOPE)
    assert.deepEqual(original?.companion.sectionEdit, { blockId: f.targetBodyId, createdAt: originalBirth, before: 'Target heading', after: 'V3 Target' })
    assert.deepEqual(original?.envelope.result, saved)
    assert.deepEqual(read(reversed.operationId)?.envelope.result, reversed)
    const facts = cold.transaction(() => assertRawSyncedHistoricalEvidenceOwned(cold))()
    assert.ok(facts.facts.some(fact => fact.family === 'metadata2-title-operation' && fact.locator.key[0] === saved.operationId))
  } finally { cold.close() }
}))
