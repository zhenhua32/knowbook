import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentDetail, ElectronApi } from '../src/shared/contracts'
import type { SyncedEditingMethod, SyncedEditingRequest, SyncedEditingResult } from '../src/shared/synced-editing-session'
import type { SyncedStructureApplied, SyncedStructureInput } from '../src/shared/synced-blocks'
import { serializeSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import { getCanonicalInlineRuntime } from '../src/renderer/src/features/synced-blocks/inlineRuntime'
import { canApplyCanonicalHostDraftChange, canonicalInlineInputLocked, hasCanonicalHostSavePending, beginCanonicalInlineAsyncEdit, waitForCanonicalInlineUnlock } from '../src/renderer/src/features/synced-blocks/inlineBridge'
import type { SyncedHostSourceCurrent } from '../src/renderer/src/features/synced-blocks/SyncedHostSourceDialog'

const time = '2026-10-16T00:00:00.000Z'

test('inline runtime preserves an uncertain original nonce/W, blocks local Source edits and retires cancelled close continuations', { concurrency: false }, async () => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const session = { sessionId: randomUUID(), workspaceScope: randomUUID(), recoveryEpoch: randomUUID() }
  let offeredSession = session
  let current: SyncedHostSourceCurrent = { hostSession: {}, editSequence: 1, host: { documentId: 'host', expectedPersistedUpdatedAt: time,
    workingBefore: { title: 'Host title', summary: 'Host summary', blocks: [{ id: 'ordinary-child', type: 'paragraph', content: 'original W',
      checked: false, depth: 0, parentBlockId: null }] } } }
  const original = structuredClone(current.host), writes: SyncedStructureInput[] = [], requests: SyncedEditingRequest[] = []
  const released: string[] = [], notices: string[] = [], closeRequests: string[] = []
  let after: DocumentDetail | undefined
  const persisted: DocumentDetail = { id: current.host.documentId, ...current.host.workingBefore, path: 'Host title', updatedAt: time,
    blocks: current.host.workingBefore.blocks.map((block, sortOrder) => ({ ...block, sortOrder })), children: [], outgoingLinks: [], backlinks: [] }
  async function invoke<M extends SyncedEditingMethod>(request: SyncedEditingRequest<M>): Promise<SyncedEditingResult<M>> {
    requests.push(structuredClone(request) as SyncedEditingRequest)
    assert.equal(request.sessionId, session.sessionId, 'all actual calls must retain the original Main-issued opaque session')
    let result: unknown
    if (request.method === 'getSyncedGroupSnapshots') result = { workspaceScope: session.workspaceScope, items: [] }
    else if (request.method === 'getSyncedOperation') result = { status: 'unknown' }
    else if (request.method === 'applySyncedHostStructure') {
      const input = request.input as SyncedStructureInput
      writes.push(structuredClone(input))
      if (writes.length === 1) throw new Error('contract reply lost after original submission')
      const submitted = input.hostsWorkingBefore[0]
      after = { id: submitted.documentId, ...submitted.workingBefore, path: 'Host title', updatedAt: '2026-10-16T00:00:01.000Z',
        blocks: submitted.workingBefore.blocks.map((block, sortOrder) => ({ ...block, sortOrder })), children: [], outgoingLinks: [], backlinks: [] }
      result = { status: 'applied', operationId: input.clientOperationId, replayed: true, historyToken: randomUUID(),
        hosts: [{ documentId: submitted.documentId, logicalBefore: submitted.workingBefore, logicalBeforeHash: 'a'.repeat(64), after }],
        groups: [], affectedInstanceIds: [], blockIdMap: [] } satisfies SyncedStructureApplied
    } else throw new Error('Unexpected Main contract method: ' + request.method)
    return result as SyncedEditingResult<M>
  }
  // An injected renderer contract boundary, not proof of Main IPC/SQL acceptance.
  const api: Pick<ElectronApi, 'onSyncedBlocksChanged' | 'onWorkspaceMutated' | 'openSyncedEditingSession'
    | 'invokeSyncedEditingSession' | 'releaseSyncedEditingSession'> = {
    onSyncedBlocksChanged: () => () => undefined, onWorkspaceMutated: () => () => undefined,
    openSyncedEditingSession: async input => {
      assert.equal(input.kind, 'host'); assert.equal(input.hostDocumentId, current.host.documentId)
      return { status: 'ready', session: structuredClone(offeredSession), host: { documentId: current.host.documentId, createdAt: time } }
    },
    invokeSyncedEditingSession: invoke,
    releaseSyncedEditingSession: async id => { released.push(id) }
  }
  Object.defineProperty(dom.window, 'knowbook', { configurable: true, value: api })
  const runtime = getCanonicalInlineRuntime()
  runtime.configure({ getCurrent: () => current, getPersisted: () => after ?? persisted,
    adopt: () => { throw new Error('No host adoption requested by this unit') },
    adoptHistory: () => { throw new Error('No host history adoption requested by this unit') },
    flushHost: async () => true, navigateHost: async () => false, notify: message => { notices.push(message) },
    selectedHostId: () => current.host.documentId, isZh: false })
  try {
    await assert.rejects(runtime.saveHostWorking(current), /reply lost/)
    assert.equal(runtime.hostSavePending(current.hostSession), true)
    assert.equal(hasCanonicalHostSavePending(), true)
    current = { ...current, editSequence: 2, host: { ...current.host, workingBefore: { ...current.host.workingBefore,
      blocks: current.host.workingBefore.blocks.map(block => ({ ...block, content: 'newer unsent W' })) } } }
    const oldAck = await runtime.saveHostWorking(current)
    assert.equal(writes.length, 2)
    assert.equal(writes[0].clientOperationId, writes[1].clientOperationId, 'lost reply retries the immutable original nonce')
    assert.deepEqual(writes[0].hostsWorkingBefore, [original])
    assert.deepEqual(writes[1].hostsWorkingBefore, [original], 'newer W cannot be submitted under the old nonce')
    assert.deepEqual(oldAck.submitted.host, original)
    assert.equal(oldAck.result.hosts[0].after, after)
    assert.equal(current.host.workingBefore.blocks[0].content, 'newer unsent W', 'the old ACK does not overwrite a newer local host body')
    assert.equal(runtime.hostSavePending(current.hostSession), false)
    assert.equal(hasCanonicalHostSavePending(), false)

    assert.equal(runtime.closeReady(), false, 'an empty controller registry is not an initialized editor flush proof')
    const originalPort = { getCurrent: () => current, getPersisted: () => after ?? persisted,
      adopt: () => false, adoptHistory: () => false, flushHost: async () => true, navigateHost: async () => false,
      selectedHostId: () => current.host.documentId, notify: (message: string) => { notices.push(message) }, isZh: false }
    let initialized = false
    runtime.configure({ ...originalPort, isReady: () => initialized, requiresHostSurface: () => true })
    assert.equal(runtime.closeReady(), false)
    initialized = true
    assert.equal(runtime.closeReady(), false, 'the actual current document surface has not registered')
    const fakeSurface = runtime.registerHostSurface({}, {})
    assert.equal(runtime.closeReady(), false); fakeSurface()
    const removeSurface = runtime.registerHostSurface(current.hostSession, {})
    assert.equal(runtime.closeReady(), true)
    initialized = false; assert.equal(runtime.closeReady(), false)
    initialized = true; removeSurface(); assert.equal(runtime.closeReady(), false)
    const incompleteSurface = runtime.registerHostSurface(current.hostSession, {}, ['not-an-actual-mounted-instance'])
    assert.equal(runtime.closeReady(), false, 'a visible declared instance cannot be skipped by an empty actual binding registry')
    incompleteSurface()
    runtime.configure(originalPort)

    const finishAttachment = beginCanonicalInlineAsyncEdit(); assert.ok(finishAttachment)
    assert.equal(await runtime.flush({ purpose: 'document-navigation' }), true,
      'a real document transition may retire the original attachment view while keeping its marker')
    const attachmentClose = randomUUID(); closeRequests.push(attachmentClose)
    const beforeAttachmentClose = requests.length
    runtime.freeze(attachmentClose)
    assert.equal(await runtime.flush({ purpose: 'document-navigation' }), false,
      'navigation is never a bypass of the actual close lock')
    assert.equal(await runtime.flush({ shouldContinue: () => runtime.ownsClose(attachmentClose) }), false)
    let resumed = false
    const originalAttachmentCallback = waitForCanonicalInlineUnlock().then(() => { resumed = true })
    await Promise.resolve(); assert.equal(resumed, false, 'the original callback cannot create W behind an ACKed input lock')
    assert.equal(requests.length, beforeAttachmentClose, 'pending local insertion cannot manufacture a persistence flush')
    runtime.cancelFreeze(attachmentClose); await originalAttachmentCallback; finishAttachment()
    assert.equal(resumed, true)

    assert.equal(await runtime.openHostSource(null), true)
    const dialog = runtime.getSnapshot().dialog
    assert.ok(dialog?.kind === 'host')
    assert.equal(dialog.opening.hostSession, current.hostSession)
    dialog.report({ dirty: true, composing: true, applying: false, importing: false })
    assert.equal(runtime.pending(), true)
    const before = current.host.workingBefore.blocks
    const newReference: DocumentBlockDraft = { id: randomUUID(), type: 'synced-block', checked: false, depth: 0, parentBlockId: null,
      content: serializeSyncedBlockPayload({ version: 1, groupId: randomUUID() }) }
    assert.equal(canApplyCanonicalHostDraftChange(before, before.map(block => ({ ...block, content: 'ordinary independent text' }))), true)
    assert.equal(canApplyCanonicalHostDraftChange(before, [...before, newReference]), false)
    const callsBeforeBlock = requests.length
    const firstClose = randomUUID()
    closeRequests.push(firstClose)
    runtime.freeze(firstClose)
    assert.equal(canonicalInlineInputLocked(), true)
    assert.equal(canApplyCanonicalHostDraftChange(before, before), false)
    assert.equal(await runtime.flush({ shouldContinue: () => runtime.ownsClose(firstClose) }), false)
    assert.equal(requests.length, callsBeforeBlock, 'dirty/IME Source may not become a fake Main flush')
    runtime.cancelFreeze(randomUUID())
    assert.equal(runtime.ownsClose(firstClose), true)
    runtime.cancelFreeze(firstClose)
    assert.equal(runtime.isLocked(), false)
    assert.equal(dialog.local.dirty, true)
    assert.equal(dialog.local.composing, true, 'cancellation does not invent compositionend or discard local Source W')

    dialog.report({ dirty: false, composing: false, applying: true, importing: false })
    const waitingClose = randomUUID()
    closeRequests.push(waitingClose)
    runtime.freeze(waitingClose)
    const waiting = runtime.flush({ shouldContinue: () => runtime.ownsClose(waitingClose) })
    runtime.cancelFreeze(waitingClose)
    dialog.report({ dirty: false, composing: false, applying: false, importing: false })
    assert.equal(await waiting, false, 'late Apply completion cannot revive a cancelled close continuation')
    const finalClose = randomUUID()
    closeRequests.push(finalClose)
    runtime.freeze(finalClose)
    assert.equal(await runtime.flush({ shouldContinue: () => runtime.ownsClose(finalClose) }), true)
    assert.equal(runtime.ownsClose(finalClose), true, 'a successful drain remains frozen until Main closes or explicitly cancels')
    runtime.cancelFreeze(finalClose)
    dialog.close()
    assert.equal(runtime.getSnapshot().dialog, null)
    assert.ok(notices.length > 0)

    offeredSession = { sessionId: randomUUID(), workspaceScope: randomUUID(), recoveryEpoch: randomUUID() }
    const callsBeforeEpochChange = requests.length
    await assert.rejects(runtime.openHostSource(null), /workspace changed/)
    assert.deepEqual(released, [offeredSession.sessionId], 'a new frame/epoch token cannot replace an old draft session')
    assert.equal(requests.length, callsBeforeEpochChange)
    assert.equal(current.host.workingBefore.blocks[0].content, 'newer unsent W')
  } finally {
    for (const requestId of closeRequests) runtime.cancelFreeze(requestId)
    runtime.getSnapshot().dialog?.close()
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
})
