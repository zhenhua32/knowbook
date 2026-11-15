import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'
import type { EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { withCrossMoveDraftCheck } from '../src/main/database/synced-cross-move-draft-guard'
import { decodeCrossHostJournal8, decodeCrossHostJournal12 } from '../src/main/database/synced-cross-host-journal4'
import type { HostMoveBatchInput } from '../src/main/database/synced-host-cross-move-batch-plan'
import { hostEncode, hostHash } from '../src/main/database/synced-host-journal'
import type { SyncedHostHistoryBranchRow } from '../src/main/database/synced-host-history-branch'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { readSyncedExchangeCutJournal } from '../src/main/database/synced-exchange-host-cut'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import type { SyncedEditingMethod, SyncedEditingRequest } from '../src/shared/synced-editing-session'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { restoreInput } from './helpers/synced-host-final-fixture'
import { allTables, applySyncedHostCommand, createRequest, request, snapshot, withV3Fixture } from './helpers/synced-backup-v3-fixture'

test('the actual batch preflight discovers every external inbound page and commits both rewrites with one cold inverse', () => withV3Fixture(async fixture => {
  const { store, db, hostId: a, targetId: b, instanceId } = fixture
  const paragraph = (content: string) => ({ id: randomUUID(), type: 'paragraph' as const, content, checked: false, depth: 0 })
  const create = (title: string, blocks: ReturnType<typeof paragraph>[]) => {
    const id = store.createDocument(null)
    store.updateDocument(id, { title, summary: '', blocks })
    return id
  }
  const ordinary = paragraph('Second actual moved block'), bDetail = store.getDocumentDetail(b)!
  store.updateDocument(b, { title: bDetail.title, summary: bDetail.summary, blocks: [...bDetail.blocks, ordinary] })
  const c = create('Third Destination', [paragraph('Existing destination')])
  const compound = (first: string, second: string) => `Keep [one](<${encodeURIComponent(first)}.md?q=01#^${instanceId}> "title") and [[${second}#${ordinary.id}|two]]`
  const secondLink = (title: string) => `Another [two](/${encodeURIComponent(title)}.md?tab=x#%5E${ordinary.id})`
  const definition = (title: string) => `[paired]: <${encodeURIComponent(title)}.md#^${ordinary.id}> "retained definition title"`
  const html = (title: string, moved: boolean) => `<a href="${encodeURIComponent(title)}.md${moved ? '?q&#61;1&#38;mode&#61;2' : '?q=1&amp;mode=2'}#^${instanceId}">shared local target</a>`
  const body = paragraph('Independent canonical group'), mixed = paragraph(compound('V3 Host', 'V3 Target'))
  const d = create('Outside with a stationary reference', [mixed, body]), e = create('Outside ordinary link', [paragraph(secondLink('V3 Target')),
    paragraph('Use [two via definition][paired].'), paragraph(definition('V3 Target')), paragraph(html('V3 Host', false))])
  const summaryId = create('Literal summary only', [paragraph('Unrelated body')])
  const summary = compound('V3 Host', 'V3 Target'), summaryPage = store.getDocumentDetail(summaryId)!
  store.updateDocument(summaryId, { title: summaryPage.title, summary, blocks: summaryPage.blocks })
  const group = createRequest(db, { documentId: d, selectedRootIds: [body.id] })
  assert.equal(applySyncedHostCommand(db, group).status, 'applied')
  const stationary = () => ({ group: snapshot(db, group.action.groupId),
    instance: db.prepare('SELECT * FROM synced_instances WHERE instance_id=?').get(group.action.instanceId),
    block: db.prepare('SELECT * FROM blocks WHERE id=?').get(group.action.instanceId) })
  const binding = stationary()
  const side = new EditorRecoveryDraftStore(join(fixture.root, 'editor-recovery'))
  try {
    const event = { sender: {}, senderFrame: {} } as EditorCloseIpcEvent, sender = event.senderFrame!
    const recovery = new EditorRecoveryDraftService(side, store, () => undefined)
    const open = (id: string) => {
      const result = store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: id })
      assert.ok(result.status === 'ready')
      return result.session.sessionId
    }
    const sessionId = open(a), direct = [a, b, c], all = [...direct, d, e]
    for (const id of direct.slice(1)) open(id)
    const invoke = <M extends SyncedEditingMethod>(packet: SyncedEditingRequest<M>) => withCrossMoveDraftCheck(db, recovery.crossMoveDraftCheck(event),
      () => store.invokeSyncedEditingSession<M>(sender, packet))
    const make = (ids: string[]): HostMoveBatchInput => {
      const { clientOperationId, groups, expectedInstances, hostsWorkingBefore } = request(db, ids)
      return { clientOperationId, groups, expectedInstances, hostsWorkingBefore, mode: 'command', action: { kind: 'move-batch', moves: [
        { selection: { documentId: a, selectedRootIds: [instanceId] }, target: { documentId: b, beforeBlockId: null, parentBlockId: null, depth: 0 } },
        { selection: { documentId: b, selectedRootIds: [ordinary.id] }, target: { documentId: c, beforeBlockId: null, parentBlockId: null, depth: 0 } }
      ] } }
    }
    const prepare = () => invoke({ sessionId, method: 'prepareSyncedCrossHostMove', input: make(direct) })
    const apply = (input: HostMoveBatchInput) => invoke({ sessionId, method: 'applySyncedHostStructure', input })
    const get = (id: string) => store.getDocumentDetail(id)!
    const exactDependencies = [d, e].sort().map(documentId => ({ documentId, updatedAt: get(documentId).updatedAt }))
    const original = allTables(db)
    assert.deepEqual(prepare(), { status: 'ready', dependencies: exactDependencies })
    assert.deepEqual(allTables(db), original)
    open(d); open(e)
    assert.equal(apply(make([...direct, d])).status, 'unsupported')
    assert.deepEqual(allTables(db), original)

    const owner = recovery.open(event, { kind: 'host', documentId: d, openRequestId: randomUUID(), expectedUpdatedAt: get(d).updatedAt })
    const draft = { draftSessionId: owner.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
      working: { ...owner.base.persistedWorking, summary: 'External W stays parked' }, sources: [], pending: [], selection: null, composing: false, importing: false }
    const { recordId, generation, hash } = recovery.write(event, { records: [draft] }, { kind: 'background' }).records[0]
    const expectedHead = { recordId, generation, hash }
    recovery.park(event, { draftSessionId: owner.draftSessionId, expectedHead })
    assert.equal(prepare().status, 'unsupported')
    assert.equal(apply(make(all)).status, 'conflict')
    assert.deepEqual(allTables(db), original)
    assert.deepEqual(side.head(owner.draftSessionId)?.record.draft.working, draft.working)
    recovery.releaseSender(event.sender); side.decide(expectedHead, 'discard')

    const input = make(all)
    db.exec(`CREATE TEMP TRIGGER fail_v12_last_page BEFORE UPDATE ON documents
      WHEN hex(OLD.id)='${Buffer.from(e).toString('hex')}' COLLATE NOCASE
      BEGIN SELECT RAISE(ABORT,'last v12 dependent did not commit'); END`)
    try { assert.throws(() => apply(input), /last v12 dependent did not commit/) }
    finally { db.exec('DROP TRIGGER fail_v12_last_page') }
    assert.deepEqual(allTables(db), original)

    const applied = apply(input)
    assert.ok(applied.status === 'applied' && applied.historyToken, JSON.stringify(applied))
    const token = applied.historyToken
    const assertLinks = (first: string, second: string) => {
      assert.equal(get(d).blocks[0].content, compound(first, second))
      assert.equal(get(e).blocks[0].content, secondLink(second))
      assert.equal(get(e).blocks[2].content, definition(second))
      assert.equal(get(e).blocks[3].content, html(first, first !== 'V3 Host'))
      assert.equal(get(summaryId).summary, summary)
      assert.deepEqual(stationary(), binding)
    }
    assertLinks('V3 Target', 'Third Destination')
    await withCapsule2RawCopy(fixture, reader => reader.transaction(() => {
      const state = readRawCapsule2WorkspaceHistoryOwned(reader)
      assert.ok([d, e].every(id => state.historyDocuments.includes(id)))
      const row = reader.prepare('SELECT * FROM synced_host_history WHERE id=?').get(token) as SyncedHostHistoryBranchRow
      assert.deepEqual(readSyncedExchangeCutJournal(reader, token).documentIds, [...all].sort())
      const proof = decodeCrossHostJournal12(row), packet = JSON.parse(row.action_json)
      assert.deepEqual(proof.crossMove.outsideIncoming, [d, e].sort())
      assert.throws(() => decodeCrossHostJournal8({ ...row, action_json: hostEncode({ ...packet, version: 8 }) }))
      packet.crossMove.outsideIncoming.pop()
      const { kind, version, originalHash: _prior, ...facts } = packet
      assert.throws(() => decodeCrossHostJournal12({ ...row, action_json: hostEncode({ kind, version, ...facts, originalHash: hostHash(facts) }) }))
      const forged = structuredClone(proof.after)
      forged.find(page => page.documentId === d)!.content.blocks[0].content += ' unexpected raw bytes'
      assert.throws(() => decodeCrossHostJournal12({ ...row, after_json: hostEncode(forged), after_hash: hostHash(forged) }))
    })())
    for (const direction of ['undo', 'redo'] as const) {
      for (const id of all) open(id)
      const history = invoke({ sessionId, method: 'getSyncedCrossHostMoveHistory', input: { documentId: d } })
      assert.equal(history.find(item => item.direction === direction)?.historyToken, token)
      const result = invoke({ sessionId, method: 'restoreSyncedHostOperation', input: restoreInput(db, applied, direction) })
      assert.ok(result.status === 'applied' && result.historyToken === token, JSON.stringify(result))
      if (direction === 'undo') assertLinks('V3 Host', 'V3 Target')
      else assertLinks('V3 Target', 'Third Destination')
    }
  } finally { side.close() }
}))
