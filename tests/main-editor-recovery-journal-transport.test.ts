import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { createEditorCloseBarrier, type EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { EditorRecoveryCloseReceipts } from '../src/main/editor-recovery/close-receipts'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { EDITOR_CLOSE_REQUEST_CHANNEL, type EditorCloseRequest } from '../src/shared/editor-close'
import type { EditorRecoveryReceipt, ParkEditorRecoveryDraftInput, RetireEditorRecoveryDraftInput, WriteEditorRecoveryDraftsInput } from '../src/shared/editor-recovery-drafts'
import { EditorRecoveryCoordinator, type RecoveryContent } from '../src/renderer/src/features/editor-recovery/coordinator'

// Only the window/frame and IPC delivery are structural test transports. The
// coordinator, Main service, close barrier, side SQLite COMMIT and receipts are
// the actual production implementations; no Electron UI acceptance is claimed.
class Contents extends EventEmitter {
  readonly id = 63; readonly mainFrame = { processId: 163, routingId: 263, detached: false }
  readonly sent: Array<{ channel: string; value: unknown }> = []
  isDestroyed() { return false }; getOSProcessId() { return 363 }
  send(channel: string, value: unknown) { this.sent.push({ channel, value }) }
}
class Window extends EventEmitter {
  readonly webContents = new Contents(); closed = false
  isDestroyed() { return this.closed }
  close() {
    let blocked = false
    this.emit('close', { preventDefault() { blocked = true } })
    if (!blocked) { this.closed = true; this.emit('closed') }
  }
}
function mainRows(main: KnowbookStore) {
  const db = main.getUnsafeDatabaseHandle()
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(value => {
    const name = (value as { name: string }).name
    return [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()]
  })
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kb-cr-journal-transport-'))
  const main = new KnowbookStore(join(root, 'main.db')), directory = join(root, 'recovery'), side = new EditorRecoveryDraftStore(directory)
  const window = new Window(); let receipts: EditorRecoveryCloseReceipts
  const barrier = createEditorCloseBarrier({ beginShutdown() {}, setTimer: () => 1, clearTimer() {},
    verifyRecoveryReceipt: (event, value) => receipts.verify(event, value) })
  barrier.registerWindow(window)
  const event: EditorCloseIpcEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const service = new EditorRecoveryDraftService(side, main, value => barrier.assertEditorMutationAllowed(value))
  receipts = new EditorRecoveryCloseReceipts(side, service, barrier)
  const id = main.createDocument(null), opened = service.open(event, { openRequestId: randomUUID(), kind: 'host', documentId: id,
    expectedUpdatedAt: main.getDocumentDetail(id)!.updatedAt })
  assert.equal(opened.base.persistedWorking.kind, 'host')
  if (opened.base.persistedWorking.kind !== 'host' || !opened.base.persistedWorking.blocks.length) throw Error('The actual host fixture needs its original ordinary body')
  let working = structuredClone(opened.base.persistedWorking)
  working.blocks[0].content = 'Exact submitted draft A\r\n未 Apply A'
  const a = structuredClone(working), c = structuredClone(working)
  c.blocks[0].content += '\r\nLater C\u0000\ud800'
  const calls: Array<{ input: WriteEditorRecoveryDraftsInput; receipt?: EditorRecoveryReceipt }> = []
  let lost = false
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { knowbook: {
    async writeEditorRecoveryDrafts(input: WriteEditorRecoveryDraftsInput) {
      const call: typeof calls[number] = { input: structuredClone(input) }; calls.push(call)
      // The deliberate failure happens AFTER real Main returns its actual
      // durable receipt. It does not turn an uncommitted write into a success.
      const receipt = input.purpose === 'background'
        ? service.write(event, { records: input.records }, { kind: 'background' })
        : receipts.seal(event, input.requestId, { records: input.records })
      call.receipt = structuredClone(receipt)
      if (!lost) { lost = true; throw Error('Injected transport loss after the actual side COMMIT') }
      return receipt
    },
    async retireCleanEditorRecoveryDraft(input: RetireEditorRecoveryDraftInput) { return service.retireClean(event, input) },
    async parkEditorRecoveryDraft(input: ParkEditorRecoveryDraftInput) { service.park(event, input) }
  } } })
  const coordinator = new EditorRecoveryCoordinator(), identity = Object.freeze({ actualProducer: true })
  const read = (): RecoveryContent => ({ working: structuredClone(working), pending: [], selection: null, composing: false, importing: false })
  coordinator.register(identity, { kind: 'host', documentId: id }, async () => opened, read)
  const before = mainRows(main), beforeChanges = (main.getUnsafeDatabaseHandle().prepare('SELECT total_changes() AS n').get() as { n: number }).n
  const request = () => window.webContents.sent.filter(item => item.channel === EDITOR_CLOSE_REQUEST_CHANNEL).at(-1)!.value as EditorCloseRequest
  return { main, side, directory, window, event, barrier, service, coordinator, opened, calls, a, c, before, beforeChanges, request,
    typeC() { working = structuredClone(c) },
    close() {
      coordinator.freeze()
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window')
      service.dispose(); side.close(); main.destroy()
      assert.equal(dirname(resolve(root)), resolve(tmpdir()))
      assert.ok(basename(root).startsWith('kb-cr-journal-transport-'))
      rmSync(root, { recursive: true, force: true })
    }
  }
}
async function loseActualA(f: ReturnType<typeof fixture>) {
  await assert.rejects(f.coordinator.background(), /Injected transport loss after the actual side COMMIT/)
  assert.equal(f.calls.length, 1)
  const first = f.calls[0]
  assert.equal(first.input.purpose, 'background'); assert.ok(first.receipt)
  const expected = first.receipt.records[0]
  assert.equal(expected.draftSessionId, f.opened.draftSessionId); assert.equal(expected.generation, 1)
  // A second actual readonly connection proves A is already committed on disk,
  // independently of any renderer generation/fingerprint/head bookkeeping.
  const cold = new EditorRecoveryDraftStore(f.directory, { readonly: true })
  try {
    assert.deepEqual(cold.head(f.opened.draftSessionId)?.expected, { recordId: expected.recordId, generation: expected.generation, hash: expected.hash })
    assert.deepEqual(cold.read(expected).draft.working, f.a)
  } finally { cold.close() }
  assert.deepEqual(mainRows(f.main), f.before)
  assert.equal((f.main.getUnsafeDatabaseHandle().prepare('SELECT total_changes() AS n').get() as { n: number }).n, f.beforeChanges)
  return { first, expected, original: f.side.read(expected) }
}
function assertSettledAThenC(f: ReturnType<typeof fixture>, first: Awaited<ReturnType<typeof loseActualA>>, finalPurpose: 'background' | 'close') {
  assert.equal(f.calls.length, 3, 'Settle the original exact A batch, then capture C in its own next generation')
  assert.deepEqual(f.calls[1].input, first.first.input, 'An uncertain generation can only be replayed with its original complete payload')
  assert.deepEqual(f.calls[1].receipt?.records, first.first.receipt!.records, 'A replay must identify the original immutable record and hash')
  assert.equal(f.calls[2].input.purpose, finalPurpose)
  assert.equal(f.calls[2].input.records[0].generation, 2)
  assert.equal(f.calls[2].input.records[0].expectedPreviousGeneration, 1)
  assert.deepEqual(f.calls[2].input.records[0].working, f.c)
  const head = f.side.head(f.opened.draftSessionId)!
  assert.equal(head.expected.generation, 2); assert.notEqual(head.expected.recordId, first.expected.recordId)
  assert.deepEqual(head.record.draft.working, f.c)
  assert.deepEqual(mainRows(f.main), f.before)
  assert.equal((f.main.getUnsafeDatabaseHandle().prepare('SELECT total_changes() AS n').get() as { n: number }).n, f.beforeChanges)
}

test('a lost actual side COMMIT reply settles the original complete generation before background captures later C as generation two', async () => {
  const f = fixture()
  try {
    const first = await loseActualA(f)
    f.typeC()
    await assert.doesNotReject(() => f.coordinator.background(), 'Later C must not be reassigned to the uncertain generation already containing durable A')
    f.coordinator.freeze()
    assertSettledAThenC(f, first, 'background')
  } finally { f.close() }
})

test('a genuine close settles an uncertain original side batch before capturing later C and obtains a fresh exact whole-window close receipt', async () => {
  const f = fixture()
  try {
    const first = await loseActualA(f)
    f.typeC(); f.coordinator.freeze(); f.window.close()
    const request = f.request()
    assert.equal(request.reason, 'window'); assert.equal(f.window.closed, false)
    const receipt = await f.coordinator.journalClose(request.requestId, () => !f.window.closed && f.request().requestId === request.requestId)
    assertSettledAThenC(f, first, 'close')
    assert.equal(receipt.purpose, 'close'); assert.equal(receipt.requestId, request.requestId)
    assert.ok(receipt.closeGeneration !== null)
    assert.equal(f.barrier.acknowledge(f.event, { requestId: request.requestId, status: 'draft-journaled', closeGeneration: receipt.closeGeneration, receiptId: receipt.receiptId }), true)
    assert.equal(f.window.closed, true)
  } finally { f.close() }
})
