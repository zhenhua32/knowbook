import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { register } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { EditorView } from '@codemirror/view'
import { createEditorCloseBarrier, type EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { EditorRecoveryCloseReceipts } from '../src/main/editor-recovery/close-receipts'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { EDITOR_CLOSE_REQUEST_CHANNEL, type EditorCloseRequest } from '../src/shared/editor-close'
import type { ElectronApi } from '../src/shared/contracts'
import type { EditorRecoveryDraftInput, EditorRecoveryReceipt } from '../src/shared/editor-recovery-drafts'
import { validateSyncedHostForest } from '../src/shared/syncedBlockValidation'
import { getEditorRecoveryCoordinator } from '../src/renderer/src/features/editor-recovery/coordinator'
import { recoveryData } from '../src/renderer/src/features/editor-recovery/sourceSnapshots'
import { applySyncedHostSourceChanges, createSyncedHostSourceDraft, readSyncedHostSourceRecovery } from '../src/renderer/src/features/synced-blocks/hostSource'
import { getCanonicalInlineRuntime } from '../src/renderer/src/features/synced-blocks/inlineRuntime'
import type { SyncedHostSourceCurrent } from '../src/renderer/src/features/synced-blocks/SyncedHostSourceDialog'
import { allTables, withV3Fixture } from './helpers/synced-backup-v3-fixture'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { SyncedHostSourceDialog } = await import('../src/renderer/src/features/synced-blocks/SyncedHostSourceDialog')

class Contents extends EventEmitter {
  readonly id = 12
  readonly mainFrame = { processId: 102, routingId: 202, detached: false }
  request: EditorCloseRequest | null = null
  isDestroyed() { return false }
  getOSProcessId() { return 302 }
  send(channel: string, value: EditorCloseRequest) { if (channel === EDITOR_CLOSE_REQUEST_CHANNEL) this.request = value }
}
class MainWindow extends EventEmitter {
  readonly webContents = new Contents()
  closed = false
  isDestroyed() { return this.closed }
  close() {
    let blocked = false
    this.emit('close', { preventDefault() { blocked = true } })
    if (!blocked) { this.closed = true; this.emit('closed') }
  }
}

test('a cold Source with retained input blocks close until its real CodeMirror producer reports, then follows the normal dirty and clean close paths', () => withV3Fixture(async f => {
  const docId = f.store.createDocument(null), created = f.store.getDocumentDetail(docId)!
  f.store.updateDocument(docId, { expectedUpdatedAt: created.updatedAt, title: 'Ordinary retained Source', summary: created.summary,
    blocks: [{ id: randomUUID(), type: 'paragraph', content: 'Persisted B', checked: false, depth: 0, parentBlockId: null }] })
  const persisted = f.store.getDocumentDetail(docId)!
  const current: SyncedHostSourceCurrent = { hostSession: {}, editSequence: 1, host: { documentId: docId,
    expectedPersistedUpdatedAt: persisted.updatedAt, workingBefore: { title: persisted.title, summary: persisted.summary,
      blocks: validateSyncedHostForest(persisted.blocks.map(({ sortOrder: _order, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null }))) } } }
  const mainWindow = new MainWindow()
  let receipts: EditorRecoveryCloseReceipts
  const barrier = createEditorCloseBarrier({ beginShutdown() {}, setTimer: () => 1, clearTimer() {}, verifyRecoveryReceipt: (event, value) => receipts.verify(event, value) })
  barrier.registerWindow(mainWindow)
  const event: EditorCloseIpcEvent = { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame }
  const side = new EditorRecoveryDraftStore(join(f.root, 'source-mount-recovery'))
  const service = new EditorRecoveryDraftService(side, f.store, value => barrier.assertEditorMutationAllowed(value))
  receipts = new EditorRecoveryCloseReceipts(side, service, barrier)
  const original = createSyncedHostSourceDraft(current.host)
  const changed = applySyncedHostSourceChanges(original, [{ from: original.source.length, to: original.source.length, insert: ' retained C 🙂' }])
  const opened = service.open(event, { kind: 'host', documentId: docId, expectedUpdatedAt: persisted.updatedAt, openRequestId: randomUUID() })
  const draft: EditorRecoveryDraftInput = { draftSessionId: opened.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
    working: opened.base.persistedWorking, pending: [], selection: null, composing: false, importing: false,
    sources: [{ sourceId: randomUUID(), kind: 'synced-host', openingSource: original.source, acceptedSource: original.source, source: changed.source,
      selection: { anchor: changed.source.length, head: 2 }, composing: false, applying: false, importing: false,
      replayJson: JSON.stringify(recoveryData({ kind: 'knowbook-source-replay-data', version: 1, opening: original, accepted: original,
        current: changed, provenance: readSyncedHostSourceRecovery(changed) })) }] }
  const head = service.write(event, { records: [draft] }, { kind: 'background' }).records[0]
  service.releaseSender(event.sender)
  const candidate = service.read(event, { recordId: head.recordId, generation: head.generation, hash: head.hash })
  assert.equal(candidate.mode, 'editable-source-draft')
  const dom = new JSDOM('<div id="mount"></div>', { url: 'https://source-mount.fixture.local', pretendToBeVisual: true })
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window,
    Document: dom.window.Document, MutationObserver: dom.window.MutationObserver, DOMRect: dom.window.DOMRect, Range: dom.window.Range,
    Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { value: () => true })
  Object.assign(dom.window.HTMLDialogElement.prototype, { showModal(this: HTMLDialogElement) { this.open = true }, close(this: HTMLDialogElement) { this.open = false } })
  Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() })
  const writes: EditorRecoveryReceipt[] = []
  const api: Pick<ElectronApi, 'openSyncedEditingSession' | 'invokeSyncedEditingSession' | 'releaseSyncedEditingSession' | 'onWorkspaceMutated'
    | 'onSyncedBlocksChanged' | 'openEditorRecoveryDraft' | 'decideEditorRecoveryDraft' | 'writeEditorRecoveryDrafts'> = {
    openSyncedEditingSession: async input => f.store.openSyncedEditingSession(event.senderFrame!, input),
    invokeSyncedEditingSession: async input => f.store.invokeSyncedEditingSession(event.senderFrame!, input),
    releaseSyncedEditingSession: async id => f.store.releaseSyncedEditingSession(event.senderFrame!, id),
    onWorkspaceMutated: () => () => {}, onSyncedBlocksChanged: () => () => {},
    openEditorRecoveryDraft: async input => service.open(event, input),
    decideEditorRecoveryDraft: async input => service.decide(event, input.recoveryOwnerId, input.decision),
    writeEditorRecoveryDrafts: async input => {
      const receipt = input.purpose === 'close' ? receipts.seal(event, input.requestId, { records: input.records })
        : service.write(event, { records: input.records }, { kind: 'background' })
      writes.push(receipt)
      return receipt
    }
  }
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  const runtime = getCanonicalInlineRuntime()
  runtime.configure({ getCurrent: () => current, getPersisted: () => persisted, adopt: () => false, adoptHistory: () => false,
    flushHost: async () => true, navigateHost: async () => false, notify: () => {}, isReady: () => true, isComposing: () => false,
    requiresHostSurface: () => false, selectedHostId: () => docId, isZh: false })
  const { createRoot } = await import('react-dom/client'), reactRoot = createRoot(dom.window.document.getElementById('mount')!)
  const requestClose = () => {
    mainWindow.close()
    const input = mainWindow.webContents.request
    assert.ok(input); assert.equal(input.reason, 'window')
    runtime.freeze(input.requestId)
    return input.requestId
  }
  const cancelClose = (requestId: string) => {
    assert.equal(barrier.acknowledge(event, { requestId, status: 'blocked', message: 'Fixture keeps the original window for the next close attempt' }), true)
    runtime.cancelFreeze(requestId)
    assert.equal(mainWindow.closed, false)
  }
  const before = allTables(f.db), changes = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  try {
    assert.equal(await runtime.restoreRecoverySource(candidate.recoveryOwnerId, current), true)
    const dialog = runtime.getSnapshot().dialog
    assert.ok(dialog?.kind === 'host' && dialog.restored)
    assert.equal(dialog.restored.draft.source, changed.source, 'A genuine cold decision already opened the retained C before the component mounts')
    assert.equal(dom.window.document.querySelector('.cm-editor'), null)
    const unreportedId = requestClose()
    const drained = runtime.closeReady() && await runtime.flush({ shouldContinue: () => runtime.ownsClose(unreportedId) })
    const prematureReceipt = await runtime.journalClose(unreportedId).catch(() => null)
    const prematureSourceCount = prematureReceipt?.records.reduce((count, record) => count + side.read(record).draft.sources.length, 0)
    const prematureWrites = writes.length
    cancelClose(unreportedId)

    await act(async () => { reactRoot.render(createElement(SyncedHostSourceDialog, { sessionKey: dialog.id, getCurrent: runtime.sourceCurrent,
      isCurrent: () => runtime.sourceIsCurrent(dialog), opener: null, isZh: false, restored: dialog.restored, onLocalStateChange: dialog.report,
      onClose: dialog.close, applyPrepared: async () => false })) })
    const view = EditorView.findFromDOM(dom.window.document.querySelector<HTMLElement>('.cm-editor')!)
    assert.ok(view); assert.equal(view.state.doc.toString(), changed.source); assert.equal(dialog.local.dirty, true)
    const reportedId = requestClose()
    assert.equal(await runtime.flush({ shouldContinue: () => runtime.ownsClose(reportedId) }), false)
    const receipt = await runtime.journalClose(reportedId)
    assert.equal(receipt.purpose, 'close'); assert.notEqual(receipt.closeGeneration, null)
    assert.deepEqual(receipt.records.flatMap(record => side.read(record).draft.sources.map(source => source.source)), [changed.source])
    cancelClose(reportedId)

    const undo = [...dom.window.document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Undo')
    assert.ok(undo)
    await act(async () => { undo.click() })
    assert.equal(view.state.doc.toString(), original.source); assert.equal(dialog.local.dirty, false)
    const cleanId = requestClose()
    assert.equal(runtime.closeReady(), true)
    assert.equal(await runtime.flush({ shouldContinue: () => runtime.ownsClose(cleanId) }), true)
    assert.equal(barrier.acknowledge(event, { requestId: cleanId, status: 'flushed' }), true)
    assert.equal(mainWindow.closed, true)
    assert.deepEqual(allTables(f.db), before)
    assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
    assert.deepEqual({ drained, prematureWrites, prematureSourceCount }, { drained: false, prematureWrites: 0, prematureSourceCount: undefined })
  } finally {
    getEditorRecoveryCoordinator().freeze()
    await act(async () => { reactRoot.unmount() })
    for (const [name, value] of originalGlobals) { if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name) }
    dom.window.close(); service.dispose(); side.close()
  }
}))
