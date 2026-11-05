import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { createEditorCloseBarrier, type EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import type { EditorRecoveryDraftInput } from '../src/shared/editor-recovery-drafts'

class Contents extends EventEmitter {
  readonly id = 12
  readonly mainFrame = { processId: 102, routingId: 202, detached: false }
  isDestroyed() { return false }
  getOSProcessId() { return 302 }
  send(_channel: string, _value: unknown) {}
}
class Window extends EventEmitter {
  readonly webContents = new Contents()
  isDestroyed() { return false }
  close() { this.emit('close', { preventDefault() {} }) }
}
function mainRows(store: KnowbookStore) {
  const db = store.getUnsafeDatabaseHandle()
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(value => {
    const { name } = value as { name: string }
    return [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()]
  })
}

test('actual Main store and frame capture their own base, preserve W in a private side store, and create a new readonly cold owner without changing canonical SQL', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-cr-main-')), file = join(root, 'main.db'), directory = join(root, 'recovery')
  let main = new KnowbookStore(file), side = new EditorRecoveryDraftStore(directory)
  const window = new Window(), barrier = createEditorCloseBarrier({ beginShutdown() {} })
  barrier.registerWindow(window)
  const event: EditorCloseIpcEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  try {
    const documentId = main.createDocument(null), detail = main.getDocumentDetail(documentId)!
    const service = new EditorRecoveryDraftService(side, main, value => barrier.assertEditorMutationAllowed(value))
    const before = mainRows(main), changes = (main.getUnsafeDatabaseHandle().prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const opened = service.open(event, { openRequestId: randomUUID(), kind: 'host', documentId, expectedUpdatedAt: detail.updatedAt })
    assert.equal(opened.base.owner.kind, 'host'); assert.equal(opened.base.persistedWorking.kind, 'host')
    const draft: EditorRecoveryDraftInput = { draftSessionId: opened.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
      working: { kind: 'host', title: 'Unsubmitted title', summary: 'Unsubmitted summary', blocks: JSON.parse(JSON.stringify(detail.blocks.map(({ sortOrder: _order, ...block }) => ({ ...block, content: 'Exact unsaved W\r\n\u0000\ud800' })))) },
      sources: [], pending: [], selection: null, composing: false, importing: false }
    const receipt = service.write(event, { records: [draft] }, { kind: 'background' }), first = receipt.records[0]
    const expected = { recordId: first.recordId, generation: first.generation, hash: first.hash }
    assert.deepEqual(mainRows(main), before)
    assert.equal((main.getUnsafeDatabaseHandle().prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
    service.releaseSender(event.sender); side.close(); main.destroy()
    main = new KnowbookStore(file); side = new EditorRecoveryDraftStore(directory)
    const cold = new EditorRecoveryDraftService(side, main, value => barrier.assertEditorMutationAllowed(value))
    const coldBefore = mainRows(main), candidate = cold.read(event, expected)
    assert.equal(candidate.mode, 'editable-ordinary-draft'); assert.equal(candidate.writePermit, false)
    assert.equal(candidate.historicalKeyLineageComplete, false); assert.deepEqual(candidate.record.draft, draft)
    const restored = cold.decide(event, candidate.recoveryOwnerId, 'restore-draft')!
    assert.deepEqual(restored.draft, draft)
    assert.deepEqual(mainRows(main), coldBefore, 'loading a draft never writes it to current canonical SQL')
    assert.equal(main.getDocumentDetail(documentId)!.title, detail.title)
    assert.throws(() => cold.decide(event, candidate.recoveryOwnerId, 'restore-draft'), /new cold recovery owner/)
    assert.throws(() => cold.read({ ...event, senderFrame: { ...window.webContents.mainFrame } }, expected), /frozen/)
  } finally { side.close(); main.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('a later real Main update makes a preserved draft review-only and no restored owner silently overwrites the new current version', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-cr-conf-')), main = new KnowbookStore(join(root, 'main.db')), side = new EditorRecoveryDraftStore(join(root, 'recovery'))
  const window = new Window(), barrier = createEditorCloseBarrier({ beginShutdown() {} }); barrier.registerWindow(window)
  const event: EditorCloseIpcEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  try {
    const documentId = main.createDocument(null), original = main.getDocumentDetail(documentId)!, service = new EditorRecoveryDraftService(side, main, value => barrier.assertEditorMutationAllowed(value))
    const opened = service.open(event, { openRequestId: randomUUID(), kind: 'host', documentId, expectedUpdatedAt: original.updatedAt })
    const draft: EditorRecoveryDraftInput = { draftSessionId: opened.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
      working: { kind: 'host', title: 'Old draft title', summary: '', blocks: JSON.parse(JSON.stringify(original.blocks.map(({ sortOrder: _order, ...block }) => block))) },
      sources: [], pending: [], selection: null, composing: false, importing: false }
    const first = service.write(event, { records: [draft] }, { kind: 'background' }).records[0]
    const expected = { recordId: first.recordId, generation: first.generation, hash: first.hash }
    main.updateDocument(documentId, { ...original, expectedUpdatedAt: original.updatedAt, title: 'Actual later current title' })
    const before = mainRows(main), changed = main.getDocumentDetail(documentId)!, candidate = service.read(event, expected)
    assert.equal(candidate.mode, 'view-only'); assert.ok(candidate.reasons.includes('base-version-changed'))
    assert.throws(() => service.decide(event, candidate.recoveryOwnerId, 'restore-draft'), /explicit review/)
    assert.deepEqual(mainRows(main), before); assert.equal(main.getDocumentDetail(documentId)!.title, changed.title)
    assert.equal(service.decide(event, candidate.recoveryOwnerId, 'keep'), null)
    assert.throws(() => service.open(event, { openRequestId: randomUUID(), kind: 'host', documentId, expectedUpdatedAt: original.updatedAt }), /birth\/CAS\/epoch/)
    assert.deepEqual(mainRows(main), before)
  } finally { side.close(); main.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('two real owners opened before the first write keep both sealed bases; clean navigation retires only an exact latest durable W and stale release cannot lose a dirty owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-cr-nav-')), main = new KnowbookStore(join(root, 'main.db')), side = new EditorRecoveryDraftStore(join(root, 'recovery'))
  const window = new Window(), barrier = createEditorCloseBarrier({ beginShutdown() {} }); barrier.registerWindow(window)
  const event: EditorCloseIpcEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  try {
    const service = new EditorRecoveryDraftService(side, main, value => barrier.assertEditorMutationAllowed(value))
    const firstId = main.createDocument(null), secondId = main.createDocument(null)
    const a = service.open(event, { openRequestId: randomUUID(), kind: 'host', documentId: firstId, expectedUpdatedAt: main.getDocumentDetail(firstId)!.updatedAt })
    const b = service.open(event, { openRequestId: randomUUID(), kind: 'host', documentId: secondId, expectedUpdatedAt: main.getDocumentDetail(secondId)!.updatedAt })
    const draft = (opened: typeof a): EditorRecoveryDraftInput => ({ draftSessionId: opened.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
      working: structuredClone(opened.base.persistedWorking), sources: [], pending: [], selection: null, composing: false, importing: false })
    const dirtyA = draft(a); assert.equal(dirtyA.working.kind, 'host')
    if (dirtyA.working.kind === 'host') dirtyA.working.title += ' local W'
    const first = service.write(event, { records: [dirtyA] }, { kind: 'background' }).records[0]
    const second = service.write(event, { records: [draft(b)] }, { kind: 'background' }).records[0]
    assert.deepEqual(side.read(second).base, b.base, 'A write GC did not delete B sealed before B first write')
    assert.throws(() => service.retireClean(event, { draftSessionId: a.draftSessionId, expectedHead: null, working: a.base.persistedWorking }), /latest durable generation/)
    assert.equal(service.retireClean(event, { draftSessionId: a.draftSessionId,
      expectedHead: { recordId: first.recordId, generation: first.generation, hash: first.hash }, working: dirtyA.working }), false)
    assert.equal(service.retireClean(event, { draftSessionId: b.draftSessionId,
      expectedHead: { recordId: second.recordId, generation: second.generation, hash: second.hash }, working: b.base.persistedWorking }), true)
    assert.deepEqual(service.liveDraftSessionIds(event), [a.draftSessionId])
    for (let index = 0; index < 30; index++) {
      const id = main.createDocument(null), opened = service.open(event, { openRequestId: randomUUID(), kind: 'host', documentId: id, expectedUpdatedAt: main.getDocumentDetail(id)!.updatedAt })
      assert.equal(service.retireClean(event, { draftSessionId: opened.draftSessionId, expectedHead: null, working: opened.base.persistedWorking }), true)
    }
    assert.deepEqual(service.liveDraftSessionIds(event), [a.draftSessionId], 'clean old visits never accumulate inaccessible close owners')
    assert.deepEqual(side.read(first).draft, dirtyA, 'dirty dormant W survives every other owner retirement')
  } finally { side.close(); main.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('a lost opening reply is recovered only by the same complete request nonce and original frame without minting a new base or consulting a later current body', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-cr-open-')), main = new KnowbookStore(join(root, 'main.db')), side = new EditorRecoveryDraftStore(join(root, 'recovery'))
  const window = new Window(), barrier = createEditorCloseBarrier({ beginShutdown() {} }); barrier.registerWindow(window)
  const event: EditorCloseIpcEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  try {
    const id = main.createDocument(null), original = main.getDocumentDetail(id)!, service = new EditorRecoveryDraftService(side, main, value => barrier.assertEditorMutationAllowed(value))
    const request = { kind: 'host' as const, documentId: id, expectedUpdatedAt: original.updatedAt, openRequestId: randomUUID() }
    const { openRequestId: _nonce, ...missingNonce } = request
    assert.throws(() => service.open(event, missingNonce), /closed fields/)
    const first = service.open(event, request)
    main.updateDocument(id, { ...original, expectedUpdatedAt: original.updatedAt, title: 'Later real current title' })
    const before = mainRows(main), replay = service.open(event, request)
    assert.deepEqual(replay, first, 'original opening reply is replayed from its original sealed base')
    assert.deepEqual(service.liveDraftSessionIds(event), [first.draftSessionId])
    assert.deepEqual(mainRows(main), before)
    assert.throws(() => service.open(event, { ...request, expectedUpdatedAt: main.getDocumentDetail(id)!.updatedAt }), /original opening nonce/)
    assert.throws(() => service.open({ ...event, senderFrame: { ...window.webContents.mainFrame } }, request), /frozen|frame/)
    assert.throws(() => service.open(event, { ...request, openRequestId: randomUUID() }), /birth\/CAS\/epoch/)
    assert.deepEqual(service.liveDraftSessionIds(event), [first.draftSessionId])
    assert.deepEqual(mainRows(main), before)
    const current = main.getDocumentDetail(id)!
    assert.equal(service.retireClean(event, { draftSessionId: first.draftSessionId, expectedHead: null,
      working: { kind: 'host', title: current.title, summary: current.summary,
        blocks: JSON.parse(JSON.stringify(current.blocks.map(({ sortOrder: _sortOrder, ...block }) => block))) } }), true)
    assert.throws(() => service.open(event, request), /original opening owner was explicitly retired/)
    assert.deepEqual(service.liveDraftSessionIds(event), [])
    assert.deepEqual(mainRows(main), before)
  } finally { side.close(); main.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('cold listing excludes actual live and dormant producers, keeps their decisions fenced, and clears only an old ordinary head independently proven already saved', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-cr-clean-')), main = new KnowbookStore(join(root, 'main.db')), side = new EditorRecoveryDraftStore(join(root, 'recovery'))
  const window = new Window(), barrier = createEditorCloseBarrier({ beginShutdown() {} }); barrier.registerWindow(window)
  const event: EditorCloseIpcEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  try {
    const id = main.createDocument(null), initial = main.getDocumentDetail(id)!, service = new EditorRecoveryDraftService(side, main, value => barrier.assertEditorMutationAllowed(value))
    const opened = service.open(event, { kind: 'host', documentId: id, expectedUpdatedAt: initial.updatedAt, openRequestId: randomUUID() })
    const draft: EditorRecoveryDraftInput = { draftSessionId: opened.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
      working: structuredClone(opened.base.persistedWorking), pending: [], sources: [], selection: null, composing: false, importing: false }
    if (draft.working.kind !== 'host') throw new Error('Actual ordinary host required')
    draft.working.title = 'Actual later saved C'
    const item = service.write(event, { records: [draft] }, { kind: 'background' }).records[0], expected = { recordId: item.recordId, generation: item.generation, hash: item.hash }
    assert.deepEqual(service.list(event, { limit: 1 }), { records: [], next: null })
    const active = service.read(event, expected)
    assert.throws(() => service.decide(event, active.recoveryOwnerId, 'discard'), /actual live or dormant/)
    assert.deepEqual(side.read(expected).draft, draft)
    service.park(event, { draftSessionId: opened.draftSessionId, expectedHead: expected })
    assert.deepEqual(service.list(event, { limit: 1 }), { records: [], next: null })
    assert.throws(() => service.decide(event, active.recoveryOwnerId, 'discard'), /actual live or dormant/)
    service.releaseSender(event.sender)
    assert.equal(service.list(event, { limit: 1 }).records.length, 1, 'an actual unsaved old W remains explicitly recoverable')
    main.updateDocument(id, { expectedUpdatedAt: initial.updatedAt, title: draft.working.title, summary: draft.working.summary, blocks: draft.working.blocks })
    const before = mainRows(main), changes = (main.getUnsafeDatabaseHandle().prepare('SELECT total_changes() AS n').get() as { n: number }).n
    assert.deepEqual(service.list(event, { limit: 1 }), { records: [], next: null })
    assert.equal(side.head(opened.draftSessionId), null, 'exact current SQL/CAS cleanup removes the already saved old ordinary head')
    assert.deepEqual(mainRows(main), before)
    assert.equal((main.getUnsafeDatabaseHandle().prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
  } finally { side.close(); main.destroy(); rmSync(root, { recursive: true, force: true }) }
})
