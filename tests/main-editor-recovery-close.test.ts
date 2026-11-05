import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type Database from 'better-sqlite3'
import { KnowbookStore } from '../src/main/database/store'
import { createEditorCloseBarrier, type EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { EditorRecoveryCloseReceipts } from '../src/main/editor-recovery/close-receipts'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { EDITOR_CLOSE_REQUEST_CHANNEL, type EditorCloseRequest } from '../src/shared/editor-close'
import type { EditorRecoveryDraftInput } from '../src/shared/editor-recovery-drafts'

class Contents extends EventEmitter {
  readonly id = 12; readonly mainFrame = { processId: 102, routingId: 202, detached: false }
  readonly sent: Array<{ channel: string; value: unknown }> = []
  isDestroyed() { return false }
  getOSProcessId() { return 302 }
  send(channel: string, value: unknown) { this.sent.push({ channel, value }) }
}
class Window extends EventEmitter {
  readonly webContents = new Contents(); closed = false
  isDestroyed() { return this.closed }
  close() { let blocked = false; this.emit('close', { preventDefault() { blocked = true } }); if (!blocked) { this.closed = true; this.emit('closed') } }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kb-cr-close-')), main = new KnowbookStore(join(root, 'main.db')), side = new EditorRecoveryDraftStore(join(root, 'recovery'))
  const window = new Window(); let receipts: EditorRecoveryCloseReceipts; let reloads = 0
  const barrier = createEditorCloseBarrier({ beginShutdown() {}, reloadEditor() { reloads++ }, setTimer: () => 1, clearTimer() {},
    verifyRecoveryReceipt: (event, value) => receipts.verify(event, value) })
  barrier.registerWindow(window)
  const event: EditorCloseIpcEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const service = new EditorRecoveryDraftService(side, main, value => barrier.assertEditorMutationAllowed(value))
  receipts = new EditorRecoveryCloseReceipts(side, service, barrier)
  const open = (): EditorRecoveryDraftInput => {
    const id = main.createDocument(null), value = service.open(event, { openRequestId: randomUUID(), kind: 'host', documentId: id, expectedUpdatedAt: main.getDocumentDetail(id)!.updatedAt })
    return { draftSessionId: value.draftSessionId, generation: 1, expectedPreviousGeneration: 0, working: value.base.persistedWorking,
      sources: [], pending: [], selection: null, composing: false, importing: false }
  }
  const request = () => window.webContents.sent.filter(item => item.channel === EDITOR_CLOSE_REQUEST_CHANNEL).at(-1)!.value as EditorCloseRequest
  return { main, side, window, barrier, event, service, receipts, open, request, reloads: () => reloads,
    close() { service.dispose(); side.close(); main.destroy(); rmSync(root, { recursive: true, force: true }) } }
}

test('a whole-window side COMMIT and its actual nonce/frame/generation permit close while incomplete owner sets, unfinished native input and caller receipt labels do not', () => {
  const f = fixture()
  try {
    const a = f.open(), b = f.open(), raw = '未 Apply\r\n\ud800\u0000'
    a.sources = [{ sourceId: randomUUID(), kind: 'ordinary-host', openingSource: '', acceptedSource: '', source: raw,
      selection: { anchor: raw.length, head: 1 }, composing: false, applying: false, importing: false }]
    f.window.close(); const request = f.request()
    assert.equal(request.reason, 'window'); assert.equal(f.window.closed, false)
    assert.throws(() => f.receipts.seal(f.event, request.requestId, { records: [a] }), /owner closure/)
    const composing = structuredClone(a); composing.sources[0].composing = true
    assert.throws(() => f.receipts.seal(f.event, request.requestId, { records: [composing, b] }), /IME/)
    assert.equal(f.side.list({ limit: 20 }).records.length, 0)
    assert.equal(f.barrier.acknowledge(f.event, { requestId: request.requestId, status: 'draft-journaled', closeGeneration: 1, receiptId: randomUUID() }), false)
    const receipt = f.receipts.seal(f.event, request.requestId, { records: [a, b] })
    assert.deepEqual(f.side.read(receipt.records.find(item => item.draftSessionId === a.draftSessionId)!).draft.sources[0].source, raw)
    assert.equal(f.barrier.acknowledge(f.event, { requestId: request.requestId, status: 'draft-journaled', closeGeneration: receipt.closeGeneration! + 1, receiptId: receipt.receiptId }), false)
    assert.equal(f.window.closed, false)
    assert.equal(f.barrier.acknowledge(f.event, { requestId: request.requestId, status: 'draft-journaled', closeGeneration: receipt.closeGeneration!, receiptId: receipt.receiptId }), true)
    assert.equal(f.window.closed, true)
  } finally { f.close() }
})

test('controlled reload cannot borrow journal close permission and an unapplied Source remains blocked', () => {
  const f = fixture()
  try {
    f.open(); const requestId = f.barrier.requestReload(f.event)!
    assert.equal(f.request().reason, 'reload')
    assert.equal(f.barrier.captureRecovery(f.event, requestId), null)
    assert.throws(() => f.receipts.seal(f.event, requestId, { records: [] }), /actual current waiting close/)
    assert.equal(f.barrier.acknowledge(f.event, { requestId, status: 'draft-journaled', closeGeneration: 1, receiptId: randomUUID() }), false)
    assert.equal(f.reloads(), 0)
    assert.equal(f.barrier.acknowledge(f.event, { requestId, status: 'blocked', message: 'Source is not applied' }), true)
    assert.equal(f.reloads(), 0); assert.equal(f.window.closed, false)
  } finally { f.close() }
})

test('a dormant complete durable owner stays inside the Main whole-window receipt without resending its W and cancelled close receipts do not accumulate', () => {
  const f = fixture()
  try {
    const a = f.open(), b = f.open()
    if (a.working.kind === 'host') a.working.title = 'Dormant unsaved exact W'
    const first = f.service.write(f.event, { records: [a] }, { kind: 'background' }).records[0]
    const expected = { recordId: first.recordId, generation: first.generation, hash: first.hash }
    assert.throws(() => f.service.park(f.event, { draftSessionId: a.draftSessionId, expectedHead: { ...expected, hash: '0'.repeat(64) } }), /exact latest durable/)
    f.service.park(f.event, { draftSessionId: a.draftSessionId, expectedHead: expected })
    assert.deepEqual(f.service.activeDraftSessionIds(f.event), [b.draftSessionId])
    assert.deepEqual(f.service.liveDraftSessionIds(f.event), [a.draftSessionId, b.draftSessionId].sort())
    const db = (f.side as unknown as { db: Database.Database }).db
    for (let index = 0; index < 20; index++) {
      f.window.close(); const request = f.request()
      const receipt = f.receipts.seal(f.event, request.requestId, { records: [b] })
      assert.deepEqual(receipt.records.find(item => item.draftSessionId === a.draftSessionId), first)
      assert.deepEqual(f.side.read(first).draft, a)
      assert.equal((db.prepare('SELECT count(*) AS n FROM recovery_receipts').get() as { n: number }).n, 1)
      assert.equal((f.receipts as unknown as { receipts: Map<string, unknown> }).receipts.size, 1)
      assert.equal(f.barrier.acknowledge(f.event, { requestId: request.requestId, status: 'blocked', message: 'User cancelled' }), true)
      assert.equal(f.window.closed, false)
      assert.equal(f.receipts.verify(f.event, { requestId: request.requestId, status: 'draft-journaled', closeGeneration: receipt.closeGeneration!, receiptId: receipt.receiptId }), false)
    }
    assert.equal((f.receipts as unknown as { receipts: Map<string, unknown> }).receipts.size, 0)
    assert.deepEqual(f.side.read(first).draft, a, 'receipt cleanup never removes the current dormant W')
  } finally { f.close() }
})

test('old workspace durable heads cannot substitute for a producer opened in the replacement workspace', () => {
  const f = fixture()
  try {
    const a = f.open(), old = f.service.write(f.event, { records: [a] }, { kind: 'background' }).records[0]
    f.service.park(f.event, { draftSessionId: a.draftSessionId, expectedHead: { recordId: old.recordId, generation: old.generation, hash: old.hash } })
    f.main.getUnsafeDatabaseHandle().prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
    f.window.close(); const firstRequest = f.request()
    assert.throws(() => f.receipts.seal(f.event, firstRequest.requestId, { records: [] }), /old workspace drafts do not cover/)
    assert.equal(f.window.closed, false); assert.deepEqual(f.side.read(old).draft, a)
    assert.equal(f.barrier.acknowledge(f.event, { requestId: firstRequest.requestId, status: 'blocked' }), true)
    const current = f.open()
    f.window.close(); const nextRequest = f.request(), receipt = f.receipts.seal(f.event, nextRequest.requestId, { records: [current] })
    assert.deepEqual(receipt.records.map(item => item.draftSessionId).sort(), [a.draftSessionId, current.draftSessionId].sort())
    assert.equal(f.barrier.acknowledge(f.event, { requestId: nextRequest.requestId, status: 'draft-journaled', closeGeneration: receipt.closeGeneration!, receiptId: receipt.receiptId }), true)
    assert.equal(f.window.closed, true)
  } finally { f.close() }
})
