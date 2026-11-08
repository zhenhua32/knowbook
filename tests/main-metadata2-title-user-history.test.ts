import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { KnowbookStore } from '../src/main/database/store'
import { readTitle2OriginalOperationOwned } from '../src/main/database/synced-host-title2-read'
import { TITLE2_USER_HISTORY_SCOPE } from '../src/main/database/synced-host-title2-codec'
import { assertRawSyncedHistoricalEvidenceOwned } from '../src/main/database/synced-operation-history-read'
import { snapshot } from './helpers/synced-backup-v3-fixture'
import { withTitle2Fixture } from './helpers/metadata2-title-fixture'

test('title maintenance preserves original canonical history across cold editing, undo, redo and branch pruning', () => withTitle2Fixture(t => {
  const live = (store: KnowbookStore) => snapshot(store.getUnsafeDatabaseHandle(), t.groupId)
  function commands(store: KnowbookStore) {
    const original = live(store).instances.find(instance => instance.hostDocumentId === t.observerId)!
    const sender = Object.freeze({ frame: 'real group history view' })
    const opened = store.openSyncedEditingSession(sender, { kind: 'instance', hostDocumentId: t.observerId, instanceId: original.instanceId, groupId: t.groupId })
    assert.ok(opened.status === 'ready')
    const guard = () => {
      const before = live(store), instance = before.instances.find(item => item.instanceId === original.instanceId)!
      return { before, input: { clientOperationId: randomUUID(), groupId: t.groupId, expectedRevision: before.revision,
        expectedTopologyRevision: before.topologyRevision, expectedInstanceBinding: {
          instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion } } }
    }
    return {
      edit(suffix: string) {
        const { before, input } = guard()
        const result = store.invokeSyncedEditingSession(sender, { sessionId: opened.session.sessionId, method: 'updateSyncedBlockGroup', input: {
          ...input, blocks: before.blocks.map(({ createdAt: _createdAt, ...block }) => ({ ...block, content: block.content + suffix })) } })
        assert.ok(result.status === 'saved', JSON.stringify(result)); return result
      },
      history(direction: 'undo' | 'redo') {
        const { before, input } = guard(), historyToken = direction === 'undo' ? before.history.undoToken : before.history.redoToken
        assert.ok(historyToken)
        const result = store.invokeSyncedEditingSession(sender, { sessionId: opened.session.sessionId, method: 'restoreSyncedGroupOperation', input: {
          ...input, expectedHistoryCursor: before.history.cursor, historyToken, direction } })
        assert.ok(result.status === 'saved', JSON.stringify(result)); return result.snapshot
      }
    }
  }
  const initial = commands(t.store), db = t.store.getUnsafeDatabaseHandle()
  const first = initial.edit(' first'), second = initial.edit(' second'), before = initial.history('undo')
  const history = () => db.prepare('SELECT * FROM synced_group_history WHERE group_id=? ORDER BY position').all(t.groupId)
  const original = history(), input = t.titleInput('Renamed in place', 'Renamed in place'), renamed = t.apply(input)
  assert.equal(renamed.historyToken, null)
  assert.deepEqual(history(), original)
  assert.deepEqual(live(t.store).history, before.history)
  const packet = db.transaction(() => readTitle2OriginalOperationOwned(db, input.clientOperationId))()!
  assert.equal(packet.companion.scope, TITLE2_USER_HISTORY_SCOPE)
  assert.deepEqual(packet.companion.groups.find(group => group.groupId === t.groupId)?.userHistory?.rows.map(row => row.original), original)

  let cold = KnowbookStore.openCanonicalRuntime(t.f.file)
  try {
    const editing = commands(cold)
    const text = (suffix: string) => `[canonical owner](Renamed%20in%20place.md)${suffix}`
    assert.equal(editing.history('undo').blocks[0].content, text(''))
    assert.equal(editing.history('redo').blocks[0].content, text(' first'))
    assert.equal(editing.history('redo').blocks[0].content, text(' first second'))
    assert.equal(editing.history('undo').blocks[0].content, text(' first'))
    const branch = editing.edit(' new')
    assert.equal(branch.snapshot.blocks[0].content, text(' first new'))
    assert.equal(branch.snapshot.history.redoToken, null)
    assert.equal(db.prepare('SELECT 1 FROM synced_group_history WHERE id=?').get(second.snapshot.history.undoToken), undefined)
    assert.deepEqual(history()[0], original[0])
    assert.equal(editing.history('undo').blocks[0].content, text(' first'))
    assert.equal(live(cold).history.undoToken, first.snapshot.history.undoToken)
    assert.equal(editing.history('undo').blocks[0].content, text(''))
    assert.equal(editing.history('redo').blocks[0].content, text(' first'))
    assert.equal(editing.history('redo').blocks[0].content, text(' first new'))
    const reopenedDb = cold.getUnsafeDatabaseHandle()
    assert.deepEqual(reopenedDb.transaction(() => readTitle2OriginalOperationOwned(reopenedDb, input.clientOperationId))(), packet)
    assert.ok(reopenedDb.transaction(() => assertRawSyncedHistoricalEvidenceOwned(reopenedDb))().facts.some(fact =>
      fact.family === 'metadata2-title-operation' && fact.locator.key.includes(input.clientOperationId)))

    const mixedHistory = history(), mixedCursor = live(cold).history
    const secondRename = t.titleInput('Second projected name', 'Second projected name')
    assert.equal(t.apply(secondRename).historyToken, null)
    assert.deepEqual(history(), mixedHistory, 'The original pre-rename and new post-rename rows keep their different raw paths')
    assert.deepEqual(live(cold).history, mixedCursor)
    const secondPacket = reopenedDb.transaction(() => readTitle2OriginalOperationOwned(reopenedDb, secondRename.clientOperationId))()!
    assert.deepEqual(secondPacket.materials.find(item => item.group.groupId === t.groupId)?.group.userHistory?.previous,
      { operationId: input.clientOperationId, companionHash: packet.companion.companionHash })
    assert.equal(editing.history('undo').blocks[0].content, '[canonical owner](Second%20projected%20name.md) first')

    const thirdRename = t.titleInput('Third projected name', 'Third projected name')
    assert.equal(t.apply(thirdRename).historyToken, null)
    assert.deepEqual(history(), mixedHistory)
    const thirdPacket = reopenedDb.transaction(() => readTitle2OriginalOperationOwned(reopenedDb, thirdRename.clientOperationId))()!
    assert.equal(thirdPacket.materials.find(item => item.group.groupId === t.groupId)?.userHistoryDepth, 3)
    cold.destroy(); t.store.destroy(); t.f.close()
    cold = KnowbookStore.openCanonicalRuntime(t.f.file)
    const current = commands(cold), coldDb = cold.getUnsafeDatabaseHandle(), thirdText = '[canonical owner](Third%20projected%20name.md)'
    assert.equal(current.history('undo').blocks[0].content, thirdText)
    assert.equal(current.history('redo').blocks[0].content, thirdText + ' first')
    assert.equal(current.history('redo').blocks[0].content, thirdText + ' first new')
    assert.equal(current.edit(' latest').snapshot.blocks[0].content, thirdText + ' first new latest')
    assert.deepEqual(coldDb.transaction(() => readTitle2OriginalOperationOwned(coldDb, input.clientOperationId))(), packet)
    assert.deepEqual(coldDb.transaction(() => readTitle2OriginalOperationOwned(coldDb, secondRename.clientOperationId))(), secondPacket)
    assert.deepEqual(coldDb.transaction(() => readTitle2OriginalOperationOwned(coldDb, thirdRename.clientOperationId))(), thirdPacket)
  } finally { if(cold.getUnsafeDatabaseHandle().open)cold.destroy() }
}))
