import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import type { EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import type { KnowbookStore } from '../src/main/database/store'
import { readStrictHostDocument } from '../src/main/database/synced-host-document-read'
import { SyncedEditingSessionRepository } from '../src/main/database/synced-editing-session'
import { withCrossMoveDraftCheck } from '../src/main/database/synced-cross-move-draft-guard'
import { MarkdownLinkIndex } from '../src/main/database/markdown-link-index'
import { readSyncedExchangeCutJournal } from '../src/main/database/synced-exchange-host-cut'
import { decodeCrossHostJournal4, decodeCrossHostJournal6, decodeCrossHostJournal7 } from '../src/main/database/synced-cross-host-journal4'
import { hostEncode, hostHash } from '../src/main/database/synced-host-journal'
import type { SyncedHostHistoryBranchRow } from '../src/main/database/synced-host-history-branch'
import type { HostMoveInput } from '../src/main/database/synced-host-move-plan'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import { command as insertReference, insertAck } from './helpers/synced-host-command-insert-fixture'
import { a, b, c, allTables, applySyncedHostCommand, bodyId, freshBlock, groupEdit, mixedForest, request, restoreInput, snapshot, withHostDatabase } from './helpers/synced-host-command-move-fixture'

function setup(db: Database.Database, nestedList = false, content = (id: string) => `Link [[Home/Host A#${id}|原文字]]`) {
  const fixture = nestedList ? (() => {
    groupEdit(db, syncedCanonicalEdits(snapshot(db).blocks).map(block => ({ ...block, type: 'bulleted-list' })))
    const owner = 'source-list-owner'
    const insert = insertReference(db, { target: { parentBlockId: owner, depth: 1 },
      dirty: working => working.blocks.push({ ...freshBlock(owner), type: 'bulleted-list' }) })
    insertAck(applySyncedHostCommand(db, insert))
    return { owner, nestedId: insert.action.instanceId }
  })() : mixedForest(db)
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run(content(fixture.nestedId), bodyId(c))
  new MarkdownLinkIndex(db).syncDocument(c)
  const move = (hosts: string[]): HostMoveInput => {
    const { clientOperationId, hostsWorkingBefore, groups, expectedInstances } = request(db, hosts)
    return { clientOperationId, hostsWorkingBefore, groups, expectedInstances, mode: 'command', action: { kind: 'move',
      selection: { documentId: a, selectedRootIds: [fixture.owner] },
      target: { documentId: b, beforeBlockId: null, parentBlockId: null, depth: 0 } } }
  }
  return { fixture, move }
}

function session(db: Database.Database, event: EditorCloseIpcEvent, side: EditorRecoveryDraftStore) {
  const store = { getUnsafeDatabaseHandle: () => db, getDocumentDetail: (id: string) => readStrictHostDocument(db, id)?.detail } as KnowbookStore
  const recovery = new EditorRecoveryDraftService(side, store, () => undefined)
  const repository = new SyncedEditingSessionRepository(db), sender = event.senderFrame!
  const open = (hostDocumentId: string) => {
    const result = repository.open(sender, { kind: 'host', hostDocumentId })
    assert.equal(result.status, 'ready')
    return result.session.sessionId
  }
  const sessionId = open(a); open(b)
  const check = <T>(run: () => T) => withCrossMoveDraftCheck(db, recovery.crossMoveDraftCheck(event), run)
  return { open, recovery, repository, sessionId, sender, check }
}

for (const nestedList of [false, true]) test(`third-page Wiki rewrite preserves ${nestedList ? 'a list projection' : 'an ordinary container'} and cold Undo of all three participants`, () => withHostDatabase((db, reopen) => {
  const directory = mkdtempSync(join(tmpdir(), 'third-link')), side = new EditorRecoveryDraftStore(directory)
  const event = { sender: {}, senderFrame: {} } as EditorCloseIpcEvent
  try {
    const { fixture, move } = setup(db, nestedList), run = session(db, event, side)
    const input = move([a, b, c]), apply = () => run.repository.invoke(run.sender, { sessionId: run.sessionId, method: 'applySyncedHostStructure', input })
    const original = allTables(db)
    const preflight = run.check(() => run.repository.invoke(run.sender, { sessionId: run.sessionId, method: 'prepareSyncedCrossHostMove', input: move([a, b]) }))
    assert.deepEqual(preflight, { status: 'ready', dependencies: [{ documentId: c, updatedAt: input.hostsWorkingBefore[2].expectedPersistedUpdatedAt }] })
    assert.throws(() => apply(), /host birth differs/)
    run.open(c)
    assert.equal(apply().status, 'conflict')
    assert.deepEqual(allTables(db), original)
    assert.throws(() => withCrossMoveDraftCheck(db, () => { throw new Error('draft source cannot be verified') }, apply), /draft source cannot be verified/)
    assert.deepEqual(allTables(db), original)
    db.exec(`CREATE TRIGGER fail_real_third_move BEFORE UPDATE ON blocks WHEN OLD.document_id=NEW.document_id
      AND hex(OLD.id)='${Buffer.from(bodyId(c)).toString('hex').toUpperCase()}'
      BEGIN SELECT RAISE(ABORT,'injected after first two participants'); END`)
    assert.throws(() => run.check(apply), /injected after first two participants/)
    db.exec('DROP TRIGGER fail_real_third_move')
    assert.deepEqual(allTables(db), original)
    const accepted = run.check(apply)
    assert.ok(accepted.status === 'applied' && accepted.historyToken, JSON.stringify(accepted))
    const reader = reopen(), token = accepted.historyToken
    const row = reader.prepare('SELECT * FROM synced_host_history WHERE id=?').get(token) as SyncedHostHistoryBranchRow
    const decoded = decodeCrossHostJournal6(row)
    assert.deepEqual(decoded.crossMove.outsideIncoming, [c]); assert.throws(() => decodeCrossHostJournal4(row))
    if (nestedList) assert.deepEqual(readStrictHostDocument(reader, b)?.content.blocks.find(block => block.id === fixture.nestedId),
      decoded.before[0].content.blocks.find(block => block.id === fixture.nestedId))
    assert.deepEqual(reader.transaction(() => readSyncedExchangeCutJournal(reader, token).documentIds)(), [a, b, c].sort())
    const appliedThird = readStrictHostDocument(reader, c)!, originalThird = decoded.persisted.find(page => page.documentId === c)!
    assert.deepEqual([...appliedThird.births], originalThird.births.map(birth => [birth.blockId, birth.createdAt]))
    assert.ok(appliedThird.content.blocks.some(block => block.content === `Link [[Home/Host B#${fixture.nestedId}|原文字]]`))
    for (const page of [a, b, c]) assert.equal(reader.prepare('SELECT history_id FROM synced_host_history_documents WHERE history_id=? AND document_id=?').get(token, page) != null, true)
    const bad = JSON.parse(row.action_json)
    const { kind: _kind, version: _version, originalHash: _hash, ...facts } = bad
    facts.persisted[2].indexedLinks[0].fragment = fixture.owner
    assert.throws(() => decodeCrossHostJournal6({ ...row, action_json: hostEncode({ ...bad, ...facts, originalHash: hostHash(facts) }) }))
    const next = session(reader, event, side); next.open(c)
    const inverse = restoreInput(reader, accepted, 'undo')
    const restore = () => next.repository.invoke(next.sender, { sessionId: next.sessionId, method: 'restoreSyncedHostOperation', input: inverse })
    assert.equal(restore().status, 'conflict')
    const open = next.recovery.open(event, { kind: 'host', documentId: c, openRequestId: randomUUID(), expectedUpdatedAt: appliedThird.detail.updatedAt })
    assert.equal(next.check(restore).status, 'conflict')
    const working = open.base.persistedWorking
    const pending = { method: 'restoreSyncedHostOperation', clientOperationId: inverse.clientOperationId,
      requestHash: hostHash({ method: 'restoreSyncedHostOperation', input: inverse }), inputJson: JSON.stringify(inverse), submittedWorking: working }
    next.recovery.write(event, { records: [{ draftSessionId: open.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
      working, sources: [], pending: [pending], selection: null, composing: false, importing: false }] }, { kind: 'background' })
    assert.equal(next.check(restore).status, 'applied')
    assert.deepEqual(readStrictHostDocument(reader, c)?.content, originalThird.content)
    if (nestedList) assert.deepEqual(readStrictHostDocument(reader, a)?.content.blocks.find(block => block.id === fixture.nestedId),
      decoded.before[0].content.blocks.find(block => block.id === fixture.nestedId))
  } finally { side.close(); rmSync(directory, { recursive: true, force: true }) }
}))

test('third-page inline Markdown and Wiki block links keep exact labels, query, fragment and unrelated bytes in v7, and stay reversible', () => withHostDatabase((db, reopen) => {
  const directory = mkdtempSync(join(tmpdir(), 'third-markdown')), side = new EditorRecoveryDraftStore(directory)
  const event = { sender: {}, senderFrame: {} } as EditorCloseIpcEvent
  const text = (owner: 'A' | 'B', id: string) => `[[Home/Host ${owner}#${id}|原文字]] and [label](Host%20${owner}.md?q=01#^${id}) plus [root](</Home/Host%20${owner}.md?tab=x#%5E${id}> "original title"). [plain](Host%20${owner}.md#${id}) and \\[[literal#${id}]]`
  try {
    const { fixture, move } = setup(db, true, id => text('A', id)), run = session(db, event, side)
    const input = move([a, b, c]); run.open(c)
    const apply = () => run.check(() => run.repository.invoke(run.sender, { sessionId: run.sessionId, method: 'applySyncedHostStructure', input }))
    const preflight = run.check(() => run.repository.invoke(run.sender, { sessionId: run.sessionId, method: 'prepareSyncedCrossHostMove', input: move([a, b]) }))
    assert.equal(preflight.status, 'ready')
    const accepted = apply()
    assert.ok(accepted.status === 'applied' && accepted.historyToken, JSON.stringify(accepted))
    const settled = run.repository.invoke(run.sender, { sessionId: run.sessionId, method: 'getSyncedOperation', input: { clientOperationId: input.clientOperationId } })
    assert.deepEqual(settled, { status: 'committed', result: { ...accepted, replayed: true } })
    const reader = reopen(), token = accepted.historyToken
    const row = reader.prepare('SELECT * FROM synced_host_history WHERE id=?').get(token) as SyncedHostHistoryBranchRow
    const decoded = decodeCrossHostJournal7(row)
    assert.deepEqual(decoded.crossMove.outsideIncoming, [c]); assert.throws(() => decodeCrossHostJournal6(row))
    assert.equal(readStrictHostDocument(reader, c)?.content.blocks[0].content, text('B', fixture.nestedId))
    const action = JSON.parse(row.action_json), third = action.persisted.find((page: { documentId: string }) => page.documentId === c)
    third.indexedLinks.find((link: { kind: string }) => link.kind === 'link').targetPath = 'Wrong/Foreign owner'
    const { kind, version, originalHash: _hash, ...facts } = action
    assert.throws(() => decodeCrossHostJournal7({ ...row, action_json: hostEncode({ kind, version, ...facts, originalHash: hostHash(facts) }) }))
    const next = session(reader, event, side); next.open(c)
    const history = next.repository.invoke(next.sender, { sessionId: next.sessionId, method: 'getSyncedCrossHostMoveHistory', input: { documentId: c } })
    assert.equal(history.find(entry => entry.direction === 'undo')?.historyToken, token)
    const restore = (direction: 'undo' | 'redo') => {
      next.open(a); next.open(b); next.open(c)
      return next.check(() => next.repository.invoke(next.sender, {
        sessionId: next.sessionId, method: 'restoreSyncedHostOperation', input: restoreInput(reader, accepted, direction) }))
    }
    assert.equal(restore('undo').status, 'applied')
    assert.equal(readStrictHostDocument(reader, c)?.content.blocks[0].content, text('A', fixture.nestedId))
    assert.equal(restore('redo').status, 'applied')
    assert.equal(readStrictHostDocument(reader, c)?.content.blocks[0].content, text('B', fixture.nestedId))
  } finally { side.close(); rmSync(directory, { recursive: true, force: true }) }
}))

test('a reference definition shared with an image cannot acquire third-page write authority', () => withHostDatabase(db => {
  const directory = mkdtempSync(join(tmpdir(), 'third-markdown-unsupported')), side = new EditorRecoveryDraftStore(directory)
  const event = { sender: {}, senderFrame: {} } as EditorCloseIpcEvent
  try {
    const { fixture, move } = setup(db), run = session(db, event, side), index = new MarkdownLinkIndex(db)
    run.open(c)
    const link = `Host%20A.md#^${fixture.nestedId}`
    for (const unsupported of [`Use [reference][original] and ![image][original]\n\n[original]: ${link}`, `[unused]: ${link}`]) {
      db.prepare("UPDATE blocks SET content=?,type='paragraph' WHERE id=?").run(`[inline](${link})\n\n${unsupported}`, bodyId(c))
      index.syncDocument(c)
      const before = allTables(db), input = move([a, b, c])
      const refused = run.check(() => run.repository.invoke(run.sender, { sessionId: run.sessionId, method: 'applySyncedHostStructure', input }))
      assert.deepEqual(refused, { status: 'unsupported', reason: 'semantic-binding' })
      assert.deepEqual(allTables(db), before)
    }
  } finally { side.close(); rmSync(directory, { recursive: true, force: true }) }
}))

test('the readonly Capsule2 workspace-history consumer opens the actual third-page Markdown original and all mappings', () => withV3Fixture(async fixture => {
  const { store, db, hostId, targetId, instanceId } = fixture, third = store.createDocument(null), thirdBlockId = randomUUID()
  store.updateDocument(third, { title: 'A third physical inbound reference', summary: '',
    blocks: [{ id: thirdBlockId, type: 'paragraph', content: `[original label](V3%20Host.md#^${instanceId})`, checked: false, depth: 0 }] })
  const side = new EditorRecoveryDraftStore(join(fixture.root, 'editor-recovery'))
  try {
    const event = { sender: {}, senderFrame: {} } as EditorCloseIpcEvent, sender = event.senderFrame!
    const recovery = new EditorRecoveryDraftService(side, store, () => undefined)
    const session = store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: hostId })
    assert.equal(session.status, 'ready')
    for (const id of [targetId, third]) assert.equal(store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: id }).status, 'ready')
    const { clientOperationId, hostsWorkingBefore, groups, expectedInstances } = request(db, [hostId, targetId, third])
    const input: HostMoveInput = { clientOperationId, hostsWorkingBefore, groups, expectedInstances, mode: 'command', action: { kind: 'move',
      selection: { documentId: hostId, selectedRootIds: [instanceId] }, target: { documentId: targetId, beforeBlockId: null, parentBlockId: null, depth: 0 } } }
    const result = withCrossMoveDraftCheck(db, recovery.crossMoveDraftCheck(event), () => store.invokeSyncedEditingSession(sender, {
      sessionId: session.session.sessionId, method: 'applySyncedHostStructure', input }))
    assert.ok(result.status === 'applied' && result.historyToken, JSON.stringify(result))
    await withCapsule2RawCopy(fixture, reader => reader.transaction(() => {
      const workspace = readRawCapsule2WorkspaceHistoryOwned(reader)
      assert.ok(workspace.historyDocuments.includes(third) && workspace.historyBlocks.includes(thirdBlockId))
      const row = reader.prepare('SELECT * FROM synced_host_history WHERE id=?').get(result.historyToken!) as SyncedHostHistoryBranchRow
      assert.deepEqual(decodeCrossHostJournal7(row).crossMove.outsideIncoming, [third])
      assert.deepEqual(readSyncedExchangeCutJournal(reader, result.historyToken!).documentIds, [hostId, targetId, third].sort())
    })())
  } finally { side.close() }
}))

test('third-page preserved producer and its parked durable head both deny a real rewrite without DML', () => withHostDatabase(db => {
  const directory = mkdtempSync(join(tmpdir(), 'third-draft')), side = new EditorRecoveryDraftStore(directory)
  const event = { sender: {}, senderFrame: {} } as EditorCloseIpcEvent
  try {
    const { move } = setup(db), run = session(db, event, side)
    run.open(c)
    const input = move([a, b, c]), before = allTables(db)
    const open = run.recovery.open(event, { kind: 'host', documentId: c, openRequestId: randomUUID(), expectedUpdatedAt: input.hostsWorkingBefore[2].expectedPersistedUpdatedAt })
    const apply = () => run.check(() => run.repository.invoke(run.sender, { sessionId: run.sessionId, method: 'applySyncedHostStructure', input }))
    assert.equal(apply().status, 'conflict')
    const original = open.base.persistedWorking
    assert.equal(original.kind, 'host')
    const draft = { draftSessionId: open.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
      working: { ...original, summary: 'An unsubmitted partner draft' }, sources: [], pending: [], selection: null, composing: false, importing: false }
    const receipt = run.recovery.write(event, { records: [draft] }, { kind: 'background' })
    const { recordId, generation, hash } = receipt.records[0]
    run.recovery.park(event, { draftSessionId: open.draftSessionId, expectedHead: { recordId, generation, hash } })
    assert.equal(apply().status, 'conflict')
    assert.deepEqual(allTables(db), before)
    assert.equal(side.head(open.draftSessionId)?.record.draft.working.kind, 'host')
    assert.deepEqual(side.head(open.draftSessionId)?.record.draft.working, draft.working)
  } finally { side.close(); rmSync(directory, { recursive: true, force: true }) }
}))
