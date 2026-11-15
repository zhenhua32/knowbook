import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import type { EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { checkCrossMoveDraftOwned, withCrossMoveDraftCheck } from '../src/main/database/synced-cross-move-draft-guard'
import { decodeCrossHostJournal7, decodeCrossHostJournal9, decodeCrossHostJournal10 } from '../src/main/database/synced-cross-host-journal4'
import { hostEncode, hostHash } from '../src/main/database/synced-host-journal'
import type { SyncedHostHistoryBranchRow } from '../src/main/database/synced-host-history-branch'
import type { HostMoveInput } from '../src/main/database/synced-host-move-plan'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { readSyncedExchangeCutJournal } from '../src/main/database/synced-exchange-host-cut'
import type { SyncedEditingMethod, SyncedEditingRequest } from '../src/shared/synced-editing-session'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { restoreInput } from './helpers/synced-host-final-fixture'
import { allTables, request, withV3Fixture } from './helpers/synced-backup-v3-fixture'

for (const [version, empty, count] of [[9, true, 1], [9, false, 2], [9, true, 2], [10, false, 1], [10, true, 2]] as const) {
  test(`v${version} commits a ${empty ? 'fully emptied' : 'nonempty'} source and ${count} real dependent page(s), with cold undo and redo`, () => withV3Fixture(async fixture => {
    const { store, db, hostId, targetId, instanceId } = fixture
    const formatLink = (index: number, title: string, moved = false) => {
      const path = encodeURIComponent(title) + '.md'
      if (version === 9) return index === 0 ? `[label](${path}?q=2#^${instanceId})` : `[[${title}#${instanceId}|原来文字]]`
      return index === 0 ? `Use [label][picked] and [picked].\n\n[picked]: <${path}?q=2#^${instanceId}> "original title"`
        : `<a title="original title" href="${path}${moved ? '?q&#61;2&#38;t&#61;3' : '?q=2&amp;t=3'}#^${instanceId}">HTML label</a>`
    }
    const dependents = Array.from({ length: count }, (_, index) => {
      const id = store.createDocument(null), blockId = randomUUID()
      store.updateDocument(id, { title: `Partner ${index}`, summary: '', blocks: [{ id: blockId, type: 'paragraph',
        content: formatLink(index, 'V3 Host'), checked: false, depth: 0 }] })
      return { id, blockId }
    })
    const side = new EditorRecoveryDraftStore(join(fixture.root, 'editor-recovery'))
    try {
      const event = { sender: {}, senderFrame: {} } as EditorCloseIpcEvent, sender = event.senderFrame!
      const recovery = new EditorRecoveryDraftService(side, store, () => undefined)
      const opened = store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: hostId })
      assert.ok(opened.status === 'ready')
      const sessionId = opened.session.sessionId
      const invoke = <M extends SyncedEditingMethod>(packet: SyncedEditingRequest<M>) => withCrossMoveDraftCheck(db, recovery.crossMoveDraftCheck(event),
        () => store.invokeSyncedEditingSession<M>(sender, packet))
      const all = [hostId, targetId, ...dependents.map(page => page.id)]
      const openAll = () => { for (const id of all) assert.equal(store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: id }).status, 'ready') }
      openAll()
      const roots = store.getDocumentDetail(hostId)!.blocks
      const move = (ids: string[]): HostMoveInput => {
        const { clientOperationId, groups, hostsWorkingBefore, expectedInstances } = request(db, ids)
        return { clientOperationId, groups, hostsWorkingBefore, expectedInstances, mode: 'command', action: { kind: 'move',
          selection: { documentId: hostId, selectedRootIds: empty ? roots.map(block => block.id) : [instanceId] },
          target: { documentId: targetId, beforeBlockId: null, parentBlockId: null, depth: 0 } } }
      }
      const input = move(all), before = allTables(db)
      const preview = invoke({ sessionId, method: 'prepareSyncedCrossHostMove', input: move(all.slice(0, 2)) })
      assert.ok(preview.status === 'ready')
      assert.deepEqual(preview.dependencies.map(page => page.documentId).sort(), all.slice(2).sort())
      const apply = (value: HostMoveInput) => invoke({ sessionId, method: 'applySyncedHostStructure', input: value })
      assert.equal(apply(move(all.slice(0, -1))).status, 'unsupported')
      assert.deepEqual(allTables(db), before)
      if (count === 2) {
        const stale = structuredClone(input); stale.hostsWorkingBefore.at(-1)!.expectedPersistedUpdatedAt = '2000-01-01T00:00:00.000Z'
        assert.equal(apply(stale).status, 'conflict')
        const protectedId = dependents[1].id, detail = store.getDocumentDetail(protectedId)!
        const owner = recovery.open(event, { kind: 'host', documentId: protectedId, openRequestId: randomUUID(), expectedUpdatedAt: detail.updatedAt })
        const draft = { draftSessionId: owner.draftSessionId, expectedPreviousGeneration: 0, generation: 1,
          working: { ...owner.base.persistedWorking, summary: 'Preserved second partner W' }, sources: [], pending: [], selection: null, composing: false, importing: false }
        const receipt = recovery.write(event, { records: [draft] }, { kind: 'background' })
        const { recordId, generation, hash } = receipt.records[0]
        const expectedHead = { recordId, generation, hash }
        recovery.park(event, { draftSessionId: owner.draftSessionId, expectedHead })
        assert.equal(apply(input).status, 'conflict')
        assert.deepEqual(allTables(db), before)
        assert.deepEqual(side.head(owner.draftSessionId)?.record.draft.working, draft.working)
        recovery.releaseSender(event.sender)
        side.decide(expectedHead, 'discard')
      }
      const applied = apply(input)
      assert.ok(applied.status === 'applied' && applied.historyToken, JSON.stringify(applied))
      const token = applied.historyToken
      const row = db.prepare('SELECT * FROM synced_host_history WHERE id=?').get(token) as SyncedHostHistoryBranchRow
      const decode = version === 9 ? decodeCrossHostJournal9 : decodeCrossHostJournal10
      const original = decode(row)
      assert.equal(Boolean(original.crossMove.sourcePlaceholder), empty)
      const after = () => dependents.map((page, index) => {
        const [block] = store.getDocumentDetail(page.id)!.blocks
        assert.equal(block.id, page.blockId)
        assert.equal(block.content, formatLink(index, 'V3 Target', true))
      })
      after()
      await withCapsule2RawCopy(fixture, reader => reader.transaction(() => {
        const closed = readRawCapsule2WorkspaceHistoryOwned(reader)
        assert.ok(dependents.every(page => closed.historyDocuments.includes(page.id) && closed.historyBlocks.includes(page.blockId)))
        const cold = reader.prepare('SELECT * FROM synced_host_history WHERE id=?').get(token) as SyncedHostHistoryBranchRow
        assert.deepEqual(decode(cold), original)
        assert.deepEqual(readSyncedExchangeCutJournal(reader, token).documentIds, [...all].sort())
        const action = JSON.parse(cold.action_json)
        if (version === 10) {
          assert.equal(action.version, 10)
          const withVersion = (previous: number) => ({ ...cold, action_json: hostEncode({ ...action, version: previous }) })
          if (count === 1) assert.throws(() => decodeCrossHostJournal7(withVersion(7)))
          else assert.throws(() => decodeCrossHostJournal9(withVersion(9)))
          const alteredAfter = structuredClone(original.after)
          alteredAfter.find(page => page.documentId === dependents[0].id)!.content.blocks[0].content += '\nextra bytes'
          assert.throws(() => decode({ ...cold, after_json: hostEncode(alteredAfter), after_hash: hostHash(alteredAfter) }))
        }
        action.crossMove.outsideIncoming.pop()
        const { kind, version: actionVersion, originalHash: _old, ...facts } = action
        assert.throws(() => decode({ ...cold, action_json: hostEncode({ kind, version: actionVersion, ...facts, originalHash: hostHash(facts) }) }))
      })())
      assert.equal(checkCrossMoveDraftOwned(db, dependents[0].id, original.before[2].content), false)
      openAll()
      const undo = invoke({ sessionId, method: 'restoreSyncedHostOperation', input: restoreInput(db, applied, 'undo') })
      assert.ok(undo.status === 'applied' && undo.historyToken === token)
      assert.deepEqual(store.getDocumentDetail(hostId)!.blocks.map(block => block.id), roots.map(block => block.id))
      for (const [index, page] of dependents.entries()) assert.equal(store.getDocumentDetail(page.id)!.blocks[0].content, formatLink(index, 'V3 Host'))
      openAll()
      const redo = invoke({ sessionId, method: 'restoreSyncedHostOperation', input: restoreInput(db, applied, 'redo') })
      assert.ok(redo.status === 'applied' && redo.historyToken === token)
      after()
      if (empty) {
        const blank = original.crossMove.sourcePlaceholder!
        assert.equal(store.getDocumentDetail(hostId)!.blocks[0].id, blank.blockId)
        assert.deepEqual(db.prepare('SELECT created_at FROM blocks WHERE id=?').get(blank.blockId), { created_at: blank.createdAt })
      }
    } finally { side.close() }
  }))
}
