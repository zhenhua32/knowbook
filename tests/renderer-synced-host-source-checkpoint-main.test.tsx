import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { register } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { act, createElement } from 'react'
import { EditorView } from '@codemirror/view'
import { JSDOM } from 'jsdom'
import type { DocumentDetail, ElectronApi } from '../src/shared/contracts'
import type { SyncedStructureApplied, SyncedStructureInput } from '../src/shared/synced-blocks'
import type { SyncedHostSourceCurrent } from '../src/renderer/src/features/synced-blocks/SyncedHostSourceDialog'
import { getCanonicalInlineRuntime } from '../src/renderer/src/features/synced-blocks/inlineRuntime'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'
import { areDocumentDraftBlocksEqual } from '../src/renderer/src/utils/documentDraftComparison'
import { createSyncedHostSourceDraft } from '../src/renderer/src/features/synced-blocks/hostSource'
import { validateSyncedHostForest } from '../src/shared/syncedBlockValidation'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { SyncedHostSourceDialog } = await import('../src/renderer/src/features/synced-blocks/SyncedHostSourceDialog')
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

// GREEN CANDIDATE, UNRUN. The unchanged red baseline remains in base/tests.
// This is the actual HostSource adapter + CM + runtime + Store/session/SQL.
// Its fixed port adopts only actual Main ACKs as display state; it neither
// fabricates an ACK nor claims to cover the separate real editor hook adopter.
test('real Source Apply must checkpoint the accepted Main side before later CM input can submit under a fresh nonce',
  { concurrency: false }, t => withCanonicalSearchFixture(async f => {
    const sender = Object.freeze({ sender: randomUUID() }), originals = new Map<string, PropertyDescriptor | undefined>()
    const dom = new JSDOM('<div id="mount"></div>', { url: 'https://source.main.fixture.local', pretendToBeVisual: true })
    for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element,
      Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, Document: dom.window.Document,
      MutationObserver: dom.window.MutationObserver, DOMRect: dom.window.DOMRect, Range: dom.window.Range,
      Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value })
    }
    Object.defineProperty(dom.window.document, 'hasFocus', { value: () => true })
    Object.assign(dom.window.HTMLDialogElement.prototype, { showModal(this: HTMLDialogElement) { this.open = true }, close(this: HTMLDialogElement) { this.open = false } })
    Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() })
    const original = f.store.getDocumentDetail(f.hostId); assert.ok(original)
    let persisted: DocumentDetail = original, current: SyncedHostSourceCurrent = { hostSession: Object.freeze({}), editSequence: 1,
      host: { documentId: persisted.id, expectedPersistedUpdatedAt: persisted.updatedAt, workingBefore: { title: persisted.title,
        summary: persisted.summary, blocks: validateSyncedHostForest(persisted.blocks.map(({ sortOrder: _sort, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null }))) } } }
    let reached = deferred(), release = deferred(), settled = deferred()
    const requests: SyncedStructureInput[] = [], lookups: string[] = []
    let hold = true, loseFirstLookup = true, closes = 0, hideOnAdopt = false, hiddenCurrent = false
    const api: Pick<ElectronApi, 'openSyncedEditingSession' | 'invokeSyncedEditingSession' | 'releaseSyncedEditingSession'
      | 'onWorkspaceMutated' | 'onSyncedBlocksChanged' | 'getDocumentDetail'> = {
      openSyncedEditingSession: async input => f.store.openSyncedEditingSession(sender, input),
      releaseSyncedEditingSession: async id => f.store.releaseSyncedEditingSession(sender, id),
      getDocumentDetail: async id => f.store.getDocumentDetail(id), onWorkspaceMutated: () => () => {}, onSyncedBlocksChanged: () => () => {},
      invokeSyncedEditingSession: async request => {
        const result = f.store.invokeSyncedEditingSession(sender, request)
        if (request.method === 'getSyncedOperation') {
          lookups.push((request.input as { clientOperationId: string }).clientOperationId)
          if (loseFirstLookup) { loseFirstLookup = false; assert.ok(result && typeof result === 'object' && 'status' in result); assert.equal(result.status, 'committed'); throw Error('Transparent loss of actual original receipt lookup reply') }
        }
        if (request.method === 'applySyncedHostStructure') {
          requests.push(structuredClone(request.input as SyncedStructureInput))
          assert.ok(result && typeof result === 'object' && 'status' in result); assert.equal(result.status, 'applied')
          if (hold) { hold = false; reached.resolve(); await release.promise; throw Error('Transparent loss after the actual first Main commit') }
        }
        return structuredClone(result)
      }
    }
    Object.defineProperty(dom.window, 'knowbook', { value: api })
    const runtime = getCanonicalInlineRuntime()
    const adopt = (before: SyncedHostSourceCurrent, result: SyncedStructureApplied) => {
      assert.equal(before.hostSession, current.hostSession); assert.equal(before.editSequence, current.editSequence)
      assert.deepEqual(result.hosts[0].logicalBefore, current.host.workingBefore)
      persisted = result.hosts[0].after
      current = { ...current, editSequence: current.editSequence + 1, host: { documentId: persisted.id,
        expectedPersistedUpdatedAt: persisted.updatedAt, workingBefore: { title: persisted.title, summary: persisted.summary,
          blocks: validateSyncedHostForest(persisted.blocks.map(({ sortOrder: _sort, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null }))) } } }
      if (hideOnAdopt) hiddenCurrent = true
      return true
    }
    const host = { getCurrent: () => hiddenCurrent ? null : current, getPersisted: () => persisted, adopt, adoptHistory: adopt,
      flushHost: async () => current.host.expectedPersistedUpdatedAt === persisted.updatedAt && current.host.workingBefore.title === persisted.title
        && current.host.workingBefore.summary === persisted.summary && areDocumentDraftBlocksEqual(current.host.workingBefore.blocks, persisted.blocks),
      navigateHost: async () => false, notify: () => {}, isReady: () => true, isComposing: () => false, requiresHostSurface: () => false,
      isZh: false, selectedHostId: () => persisted.id }
    runtime.configure(host)
    const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
    const view = () => { const element = dom.window.document.querySelector<HTMLElement>('.cm-editor'); assert.ok(element); const result = EditorView.findFromDOM(element); assert.ok(result); return result }
    const applyButton = () => { const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Apply changes'); assert.ok(button); return button }
    try {
      assert.equal(await runtime.openHostSource(null), true)
      const opening = runtime.getSnapshot().dialog; assert.ok(opening && opening.kind === 'host')
      if (!opening || opening.kind !== 'host') throw Error('Actual Source opening missing')
      await act(async () => { root.render(createElement(SyncedHostSourceDialog, { sessionKey: opening.id, getCurrent: runtime.sourceCurrent,
        isCurrent: () => runtime.sourceIsCurrent(opening), opener: null, isZh: false, onLocalStateChange: opening.report,
        onClose: () => { closes++; opening.close(); root.render(null) },
        applyPrepared: async () => { throw Error('The genuine Source submission route must not fall back to the legacy boolean callback') },
        applySubmission: async submission => {
          try { return await runtime.applyHostSourceSubmission(opening, submission) } finally { settled.resolve() }
        } })) })
      const exactSource = createSyncedHostSourceDraft(opening.opening.host)
      const removed = exactSource.references.anchors.find(anchor => anchor.instanceId === f.firstInstanceId); assert.ok(removed)
      assert.equal(view().state.doc.toString(), exactSource.source)
      await act(async () => { view().dispatch({ changes: [
        { from: removed.from, to: removed.to, insert: '' },
        { from: view().state.doc.length, insert: '\n\nAccepted source A' }
      ] }) })
      await act(async () => { applyButton().click(); await reached.promise })
      assert.equal(requests.length, 1)
      const firstActual = f.store.getDocumentDetail(f.hostId); assert.ok(firstActual)
      assert.equal(firstActual.blocks.at(-1)?.content, 'Accepted source A')
      assert.equal(firstActual.blocks.some(block => block.id === f.firstInstanceId), false)
      assert.ok(firstActual.blocks.some(block => block.type === 'synced-block'), 'remaining real references keep the second Apply on the Main structure route')
      const rawSubmittedA = view().state.doc.toString()
      await act(async () => { view().dispatch({ changes: { from: view().state.doc.length, insert: ' plus retained later input' } }) })
      await act(async () => { release.resolve(); await settled.promise })
      assert.equal(closes, 0); assert.equal(view().state.doc.toString(), rawSubmittedA + ' plus retained later input')
      assert.equal(current.host.expectedPersistedUpdatedAt, original.updatedAt, 'uncertain old ACK does not publish a synthetic new baseline')
      assert.equal(requests.length, 1)
      await act(async () => { applyButton().click(); await setImmediate() })
      assert.equal(requests.length, 1, 'confirming original A while CM has later input must not resend the spent instance fence')
      assert.deepEqual(lookups, [requests[0].clientOperationId, requests[0].clientOperationId])
      assert.equal(closes, 0); assert.equal(view().state.doc.toString(), rawSubmittedA + ' plus retained later input')
      assert.equal(current.host.expectedPersistedUpdatedAt, firstActual.updatedAt)
      assert.equal(current.host.workingBefore.blocks.at(-1)?.content, 'Accepted source A')
      assert.ok(dom.window.document.querySelector('[role="alert"]')?.textContent?.includes('Later input remains'))
      const sourceAction = (label: string) => {
        const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === label)
        assert.ok(button); button.click()
      }
      await act(async () => { sourceAction('Undo') })
      assert.equal(view().state.doc.toString(), rawSubmittedA, 'the accepted A is the genuine local Source Undo floor')
      assert.deepEqual(f.store.getDocumentDetail(f.hostId), firstActual, 'local Source Undo does not mutate Main or resurrect the removed instance')
      await act(async () => { sourceAction('Redo') })
      assert.equal(view().state.doc.toString(), rawSubmittedA + ' plus retained later input')
      assert.equal(requests.length, 1)
      // The same third Apply is red before the production patch and must use
      // the private real A checkpoint afterward, with its actual new row ID.
      await act(async () => { applyButton().click(); await setImmediate() })
      assert.equal(requests.length, 2, 'later input must reach a new actual Main submission; a local dialog state change is insufficient')
      assert.notEqual(requests[1].clientOperationId, requests[0].clientOperationId)
      assert.equal(requests[1].hostsWorkingBefore[0].expectedPersistedUpdatedAt, firstActual.updatedAt)
      assert.equal(requests[1].hostsWorkingBefore[0].workingBefore.blocks.at(-1)?.content, 'Accepted source A')
      assert.equal(requests[1].hostsWorkingBefore[0].workingBefore.blocks.at(-1)?.id, firstActual.blocks.at(-1)?.id, 'the accepted A row identity survives the real checkpoint')
      assert.equal(requests[1].mode, 'host-final')
      if (requests[1].mode !== 'host-final') throw Error('Actual Source submission missing')
      assert.deepEqual(requests[1].newRefSources, [], 'accepted references are actual current P instances, not newly borrowed sources')
      assert.equal(f.store.getDocumentDetail(f.hostId)!.blocks.at(-1)?.content, 'Accepted source A plus retained later input')
      assert.equal(closes, 1)

      // Metadata checkpoint during a real Source composition cannot invent its
      // end or split the remainder of that IME input into a separate Undo item.
      reached = deferred(); release = deferred(); settled = deferred(); hold = true; loseFirstLookup = false
      const compositions: boolean[] = []
      assert.equal(await runtime.openHostSource(null), true)
      const ime = runtime.getSnapshot().dialog; assert.ok(ime && ime.kind === 'host')
      if (!ime || ime.kind !== 'host') throw Error('Actual IME Source opening missing')
      await act(async () => { root.render(createElement(SyncedHostSourceDialog, { sessionKey: ime.id, getCurrent: runtime.sourceCurrent,
        isCurrent: () => runtime.sourceIsCurrent(ime), opener: null, isZh: false, onLocalStateChange: ime.report,
        onCompositionChange: value => { compositions.push(value) }, onClose: () => { closes++; ime.close(); root.render(null) },
        applyPrepared: async () => { throw Error('No legacy source fallback') },
        applySubmission: async submission => { try { return await runtime.applyHostSourceSubmission(ime, submission) } finally { settled.resolve() } } })) })
      await act(async () => { view().dispatch({ changes: { from: view().state.doc.length, insert: ' IME submitted A' } }) })
      const imeSubmitted = view().state.doc.toString()
      await act(async () => { applyButton().click(); await reached.promise })
      await act(async () => {
        view().contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }))
        view().dispatch({ changes: { from: view().state.doc.length, insert: ' 中文' } })
      })
      await act(async () => { release.resolve(); await settled.promise })
      assert.deepEqual(compositions, [true]); assert.equal(closes, 1)
      const originalNow = Date.now, slowInput = t.mock.method(Date, 'now', () => originalNow() + 2000)
      await act(async () => {
        view().dispatch({ changes: { from: view().state.doc.length, insert: '完成' } })
        view().contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '中文完成' }))
      })
      slowInput.mock.restore()
      assert.deepEqual(compositions, [true, false])
      const completeIme = view().state.doc.toString()
      await act(async () => { sourceAction('Undo') })
      assert.equal(view().state.doc.toString(), imeSubmitted)
      await act(async () => { sourceAction('Redo') })
      assert.equal(view().state.doc.toString(), completeIme)
      await act(async () => { applyButton().click(); await setImmediate() })
      assert.equal(closes, 2); assert.equal(requests.length, 4)
      assert.ok(f.store.getDocumentDetail(f.hostId)!.blocks.at(-1)?.content.endsWith('中文完成'))

      // A genuine CM replay back before submitted A is intentionally not a
      // new permission to revive its old instance ID after Main removed it.
      reached = deferred(); release = deferred(); settled = deferred(); hold = true; loseFirstLookup = false
      assert.equal(await runtime.openHostSource(null), true)
      const boundary = runtime.getSnapshot().dialog; assert.ok(boundary && boundary.kind === 'host')
      if (!boundary || boundary.kind !== 'host') throw Error('Second actual Source opening missing')
      await act(async () => { root.render(createElement(SyncedHostSourceDialog, { sessionKey: boundary.id, getCurrent: runtime.sourceCurrent,
        isCurrent: () => runtime.sourceIsCurrent(boundary), opener: null, isZh: false, onLocalStateChange: boundary.report,
        onClose: () => { closes++; boundary.close(); root.render(null) }, applyPrepared: async () => { throw Error('No legacy source fallback') },
        applySubmission: async submission => { try { return await runtime.applyHostSourceSubmission(boundary, submission) } finally { settled.resolve() } } })) })
      const beforeBoundary = view().state.doc.toString(), boundaryDraft = createSyncedHostSourceDraft(boundary.opening.host)
      const oldReference = boundaryDraft.references.anchors.find(anchor => anchor.instanceId === f.secondInstanceId); assert.ok(oldReference)
      await act(async () => { view().dispatch({ changes: [
        { from: oldReference.from, to: oldReference.to, insert: '' },
        { from: view().state.doc.length, insert: ' boundary A' }
      ] }) })
      await act(async () => { applyButton().click(); await reached.promise })
      assert.equal(requests.length, 5)
      const committedBoundary = f.store.getDocumentDetail(f.hostId); assert.ok(committedBoundary)
      assert.equal(committedBoundary.blocks.some(block => block.id === f.secondInstanceId), false)
      await act(async () => { sourceAction('Undo') })
      assert.equal(view().state.doc.toString(), beforeBoundary)
      await act(async () => { release.resolve(); await settled.promise })
      assert.equal(closes, 2); assert.equal(view().state.doc.toString(), beforeBoundary)
      assert.ok(dom.window.document.querySelector('[role="alert"]')?.textContent?.includes('cannot safely checkpoint'))
      assert.equal(current.host.workingBefore.blocks.some(block => block.id === f.secondInstanceId), false)
      await act(async () => { applyButton().click(); await setImmediate() })
      assert.equal(requests.length, 5, 'pre-A replay never resubmits a deleted instance under new A permissions')
      assert.deepEqual(f.store.getDocumentDetail(f.hostId), committedBoundary)
      assert.equal(view().state.doc.toString(), beforeBoundary, 'blocked replay retains every CM byte for explicit recovery')
      await act(async () => { sourceAction('Cancel') })
      assert.equal(runtime.getSnapshot().dialog, null); assert.equal(closes, 3)

      // Genuine Main commit/adoption can be followed by a local view teardown.
      // Such a known receipt must not stay pinned as an unknown source write.
      hold = false; hideOnAdopt = true; hiddenCurrent = false
      assert.equal(await runtime.openHostSource(null), true)
      const lostView = runtime.getSnapshot().dialog; assert.ok(lostView && lostView.kind === 'host')
      if (!lostView || lostView.kind !== 'host') throw Error('Actual teardown Source opening missing')
      await act(async () => { root.render(createElement(SyncedHostSourceDialog, { sessionKey: lostView.id, getCurrent: runtime.sourceCurrent,
        isCurrent: () => runtime.sourceIsCurrent(lostView), opener: null, isZh: false, onLocalStateChange: lostView.report,
        onClose: () => { closes++; lostView.close(); root.render(null) }, applyPrepared: async () => { throw Error('No legacy source fallback') },
        applySubmission: submission => runtime.applyHostSourceSubmission(lostView, submission) })) })
      await act(async () => { view().dispatch({ changes: { from: view().state.doc.length, insert: ' adopted before local teardown' } }) })
      const retainedTeardownSource = view().state.doc.toString()
      await act(async () => { applyButton().click(); await setImmediate() })
      assert.equal(requests.length, 6); assert.equal(hiddenCurrent, true)
      const actualAdopted = f.store.getDocumentDetail(f.hostId); assert.ok(actualAdopted)
      assert.ok(actualAdopted.blocks.at(-1)?.content.endsWith('adopted before local teardown'))
      assert.equal(view().state.doc.toString(), retainedTeardownSource); assert.equal(closes, 3)
      await act(async () => { sourceAction('Cancel') })
      assert.equal(runtime.getSnapshot().dialog, null, 'a settled/adopted receipt cannot trap explicit Cancel behind an unknown-operation pin')
      assert.equal(closes, 4); assert.deepEqual(f.store.getDocumentDetail(f.hostId), actualAdopted)
    } finally {
      release.resolve(); await act(async () => { root.unmount() }); f.store.releaseSyncedEditingSessionsForSender(sender)
      dom.window.close()
      for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) }
    }
  }))
