import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { register } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import React, { act, createElement, useState, useSyncExternalStore } from 'react'
import { EditorView } from '@codemirror/view'
import { JSDOM } from 'jsdom'
import type { DocumentDetail, ElectronApi } from '../src/shared/contracts'
import type { SyncedRestoreHostInput, SyncedStructureApplied, SyncedStructureInput } from '../src/shared/synced-blocks'
import type { SyncedEditingMethod, SyncedEditingRequest, SyncedEditingResult } from '../src/shared/synced-editing-session'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { getUiText } from '../src/renderer/src/i18n'
import { toDraftBlock } from '../src/renderer/src/utils/draftBlockShape'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { getCanonicalInlineRuntime } = await import('../src/renderer/src/features/synced-blocks/inlineRuntime')
const { SyncedHostSourceDialog } = await import('../src/renderer/src/features/synced-blocks/SyncedHostSourceDialog')
const { createSyncedHostSourceDraft } = await import('../src/renderer/src/features/synced-blocks/hostSource')
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

// The adapter calls the actual Store before holding/losing a
// transport reply. Host W is changed only by the real editor hook/shared adopter;
// there is no custom adoption implementation or fabricated successful ACK.
test('real Source checkpoints adopt A once through the editor hook, retain C only in CM, and cross both genuine Main history boundaries only after their original acknowledgements',
  { concurrency: false }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try { await withCanonicalSearchFixture(async f => {
      const sender = Object.freeze({ sender: randomUUID() }), original = f.store.getDocumentDetail(f.hostId); assert.ok(original)
      const dom = new JSDOM('<div id="mount"></div>', { url: 'https://source.real-history.fixture.local', pretendToBeVisual: true })
      const originals = new Map<string, PropertyDescriptor | undefined>()
      for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
        HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
        Element: dom.window.Element, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, Document: dom.window.Document,
        MutationObserver: dom.window.MutationObserver, DOMRect: dom.window.DOMRect, Range: dom.window.Range,
        Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value })
      }
      Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
      Object.assign(dom.window.HTMLDialogElement.prototype, { showModal(this: HTMLDialogElement) { this.open = true }, close(this: HTMLDialogElement) { this.open = false } })
      Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() })
      dom.window.HTMLElement.prototype.scrollIntoView = () => undefined
      const reached = deferred(), release = deferred()
      let settled = deferred(), loseFirstReply = true, loseFirstLookup = true
      type HeldInverse = { reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
      let heldInverse: HeldInverse | null = null
      const currentInverse = (): HeldInverse | null => heldInverse
      const writes: SyncedStructureInput[] = [], saved: SyncedStructureApplied[] = [], inverses: SyncedRestoreHostInput[] = [], lookups: string[] = []
      const sourceAdoptions: Array<{ operationId: string; accepted: boolean }> = [], historyAdoptions: string[] = [], notices: string[] = []
      async function invoke<M extends SyncedEditingMethod>(request: SyncedEditingRequest<M>): Promise<SyncedEditingResult<M>> {
        const result = f.store.invokeSyncedEditingSession(sender, request)
        if (request.method === 'getSyncedOperation') {
          lookups.push((request.input as { clientOperationId: string }).clientOperationId)
          if (loseFirstLookup) {
            loseFirstLookup = false
            assert.ok(result && typeof result === 'object' && 'status' in result); assert.equal(result.status, 'committed')
            throw Error('Lost the actual original receipt lookup reply')
          }
        }
        if (request.method === 'applySyncedHostStructure') {
          assert.ok(result && typeof result === 'object' && 'status' in result && 'hosts' in result)
          assert.equal(result.status, 'applied')
          writes.push(structuredClone(request.input as SyncedStructureInput)); saved.push(structuredClone(result) as SyncedStructureApplied)
          if (loseFirstReply) { loseFirstReply = false; reached.resolve(); await release.promise; throw Error('Lost the reply after the actual Source A commit') }
        }
        if (request.method === 'restoreSyncedHostOperation') {
          assert.ok(result && typeof result === 'object' && 'status' in result); assert.equal(result.status, 'applied')
          inverses.push(structuredClone(request.input as SyncedRestoreHostInput))
          const hold = heldInverse
          if (hold) { hold.reached.resolve(); await hold.release.promise }
        }
        return structuredClone(result)
      }
      const api: Pick<ElectronApi, 'getHomeData' | 'getDocumentDetail' | 'updateDocument' | 'onWorkspaceMutated' | 'onSyncedBlocksChanged'
        | 'openSyncedEditingSession' | 'invokeSyncedEditingSession' | 'releaseSyncedEditingSession'> = {
        getHomeData: async () => f.store.getHomeData(f.destination), getDocumentDetail: async id => f.store.getDocumentDetail(id),
        updateDocument: async (id, input) => { f.store.updateDocument(id, input); const document = f.store.getDocumentDetail(id); assert.ok(document); return { document, requiresFullRefresh: true } },
        onWorkspaceMutated: () => () => {}, onSyncedBlocksChanged: () => () => {},
        openSyncedEditingSession: async input => f.store.openSyncedEditingSession(sender, input), invokeSyncedEditingSession: invoke,
        releaseSyncedEditingSession: async id => { f.store.releaseSyncedEditingSession(sender, id) }
      }
      Object.defineProperty(dom.window, 'knowbook', { configurable: true, value: api })
      const runtime = getCanonicalInlineRuntime()
      let editor!: ReturnType<typeof useDocumentEditorState>
      function SourceOutlet() {
        const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot), dialog = state.dialog
        if (!dialog || dialog.kind !== 'host') return null
        return <SyncedHostSourceDialog sessionKey={dialog.id} getCurrent={runtime.sourceCurrent} isCurrent={() => runtime.sourceIsCurrent(dialog)}
          opener={null} isZh={false} onLocalStateChange={dialog.report} onClose={dialog.close}
          applyPrepared={async () => { throw Error('A genuine captured Source submission must not fall back to the old callback') }}
          applySubmission={async submission => { try { return await runtime.applyHostSourceSubmission(dialog, submission) } finally { settled.resolve() } }} />
      }
      function Harness() {
        const [selected, setSelected] = useState<DocumentDetail | null>(original)
        editor = useDocumentEditorState({ selectedDocumentId: original!.id, selectedDocument: selected, ui: getUiText('en-US'),
          onHomeDataChange: () => {}, onSelectedDocumentChange: setSelected, onMessage: message => { if (message) notices.push(message) } })
        runtime.configure({ getCurrent: editor.getSyncedHostEditorState, getPersisted: () => selected,
          adopt: (before, result) => {
            const accepted = editor.adoptSyncedHostStructureResult(before, result)
            sourceAdoptions.push({ operationId: result.operationId, accepted }); return accepted
          },
          adoptHistory: (before, result) => {
            const accepted = editor.adoptSyncedHostHistoryResult(before, result)
            if (accepted) historyAdoptions.push(result.operationId)
            return accepted
          },
          applyOrdinarySource: editor.applyOrdinaryMarkdownSource, flushHost: () => editor.flushPendingChanges(), navigateHost: async () => false,
          selectedHostId: () => original!.id, isReady: () => true, isComposing: editor.isSyncedHostComposing, requiresHostSurface: () => false,
          canStartStructure: () => !editor.isSaving, notify: message => { notices.push(message) }, isZh: false })
        return <><div className="block-editor-list">{editor.draftBlocks.map((block, index) =>
          <div key={block.id} className="block-editor-row" data-block-id={block.id} data-block-index={index}>
            <textarea value={block.content} onChange={() => {}} />
          </div>)}</div><SourceOutlet /></>
      }
      const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
      const drain = async () => { for (let at = 0; at < 4; at++) await act(async () => { await setImmediate() }) }
      // Hook snapshots may include an explicit undefined for optional fields.
      const expectedBody = (detail: DocumentDetail) => detail.blocks.map(toDraftBlock).map(block => ({ ...block, tags: block.tags ?? [], listStart: block.listStart, markdownFormat: block.markdownFormat }))
      const body = () => structuredClone(editor.draftBlocks.map(block => ({ ...block, tags: block.tags ?? [], listStart: block.listStart, markdownFormat: block.markdownFormat })))
      const assertHost = (detail: DocumentDetail) => {
        assert.deepEqual(body(), expectedBody(detail))
        const actual = editor.getSyncedHostEditorState(); assert.ok(actual)
        assert.equal(actual.host.expectedPersistedUpdatedAt, detail.updatedAt)
        assert.equal(actual.host.workingBefore.title, detail.title); assert.equal(actual.host.workingBefore.summary, detail.summary)
      }
      const view = () => { const element = dom.window.document.querySelector<HTMLElement>('.cm-editor'); assert.ok(element); const found = EditorView.findFromDOM(element); assert.ok(found); return found }
      const button = (text: string) => { const found = [...dom.window.document.querySelectorAll<HTMLButtonElement>('dialog button')].find(item => item.textContent === text); assert.ok(found); return found }
      const apply = async () => { settled = deferred(); await act(async () => { button('Apply changes').click(); await settled.promise }); await drain() }
      const inverse = async (direction: 'undo' | 'redo', before: DocumentDetail, after: DocumentDetail, token: string) => {
        const hold = { reached: deferred(), release: deferred() }; heldInverse = hold
        const count = inverses.length, adopted = historyAdoptions.length
        let pending!: Promise<void>
        await act(async () => {
          const action = direction === 'undo' ? editor.undoEdit() : editor.redoEdit(); assert.ok(action)
          pending = action; await hold.reached.promise
        })
        assert.equal(inverses.length, count + 1); assert.equal(inverses.at(-1)?.historyToken, token)
        assert.equal(inverses.at(-1)?.direction, direction)
        assertHost(before)
        assert.deepEqual(expectedBody(f.store.getDocumentDetail(original.id)!), expectedBody(after), 'Main has committed, while the renderer still awaits that exact receipt')
        assert.equal(historyAdoptions.length, adopted); assert.equal(editor.canUndo, false); assert.equal(editor.canRedo, false)
        await act(async () => { hold.release.resolve(); await pending; t.mock.timers.tick(0) })
        heldInverse = null; await drain()
        assert.equal(historyAdoptions.length, adopted + 1)
        assert.deepEqual(body(), expectedBody(after))
        assert.equal(runtime.history.pending(), false)
      }
      try {
        await act(async () => root.render(createElement(Harness)))
        await act(async () => editor.loadDocumentIntoEditor(original))
        assert.equal(editor.canUndo, false); assert.equal(editor.canRedo, false)
        await act(async () => assert.equal(await runtime.openHostSource(null), true)); await drain()
        const opening = runtime.getSnapshot().dialog; assert.ok(opening && opening.kind === 'host')
        if (!opening || opening.kind !== 'host') throw Error('Actual Source opening unavailable')
        const draft = createSyncedHostSourceDraft(opening.opening.host), removed = draft.references.anchors.find(anchor => anchor.instanceId === f.firstInstanceId); assert.ok(removed)
        await act(async () => view().dispatch({ changes: [{ from: removed.from, to: removed.to, insert: '' }, { from: view().state.doc.length, insert: '\n\nAccepted source A' }] }))
        const rawA = view().state.doc.toString()
        await act(async () => { button('Apply changes').click(); await reached.promise })
        const actualA = f.store.getDocumentDetail(original.id); assert.ok(actualA)
        assert.equal(actualA.blocks.some(block => block.id === f.firstInstanceId), false)
        assert.equal(actualA.blocks.at(-1)?.content, 'Accepted source A')
        assert.equal(writes.length, 1); assert.equal(sourceAdoptions.length, 0); assertHost(original)
        const rawC = rawA + ' plus retained CM C'
        await act(async () => view().dispatch({ changes: { from: view().state.doc.length, insert: ' plus retained CM C' } }))
        await act(async () => { release.resolve(); await settled.promise }); await drain()
        assertHost(original); assert.equal(view().state.doc.toString(), rawC)
        assert.equal(sourceAdoptions.length, 0, 'a lost original ACK is not adopted from local expectation')
        await apply()
        assert.equal(writes.length, 1, 'receipt retry must not replay the spent instance writer fence')
        assert.deepEqual(lookups, [writes[0].clientOperationId, writes[0].clientOperationId])
        assert.deepEqual(sourceAdoptions, [{ operationId: writes[0].clientOperationId, accepted: true }])
        assertHost(actualA); assert.equal(editor.canUndo, true)
        assert.equal(view().state.doc.toString(), rawC)
        assert.equal(editor.draftBlocks.some(block => block.content.includes('retained CM C')), false)
        await act(async () => button('Undo').click())
        assert.equal(view().state.doc.toString(), rawA); assertHost(actualA)
        await act(async () => button('Undo').click())
        assert.equal(view().state.doc.toString(), rawA, 'Source local Undo stops at genuine accepted A')
        await act(async () => button('Redo').click())
        assert.equal(view().state.doc.toString(), rawC); assertHost(actualA)
        assert.deepEqual(f.store.getDocumentDetail(original.id), actualA)
        await act(async () => { await editor.undoEdit() })
        assert.equal(inverses.length, 0, 'a retained Source draft still blocks host history')
        await apply()
        const actualC = f.store.getDocumentDetail(original.id); assert.ok(actualC)
        assert.equal(runtime.getSnapshot().dialog, null); assertHost(actualC)
        assert.equal(actualC.blocks.at(-1)?.content, 'Accepted source A plus retained CM C')
        assert.equal(writes.length, 2); assert.notEqual(writes[1].clientOperationId, writes[0].clientOperationId)
        assert.equal(writes[1].hostsWorkingBefore[0].expectedPersistedUpdatedAt, actualA.updatedAt)
        assert.equal(writes[1].hostsWorkingBefore[0].workingBefore.blocks.at(-1)?.id, actualA.blocks.at(-1)?.id)
        assert.equal(writes[1].mode, 'host-final')
        if (writes[1].mode !== 'host-final') throw Error('Expected genuine host-final Source C')
        assert.deepEqual(writes[1].newRefSources, [])
        assert.equal(sourceAdoptions.length, 2); assert.equal(sourceAdoptions.every(item => item.accepted), true)
        const tokenA = saved[0].historyToken, tokenC = saved[1].historyToken; assert.ok(tokenA && tokenC); assert.notEqual(tokenA, tokenC)
        await inverse('undo', actualC, actualA, tokenC)
        assert.equal(editor.canUndo, true); assert.equal(editor.canRedo, true)
        const afterUndoC = f.store.getDocumentDetail(original.id); assert.ok(afterUndoC)
        await inverse('undo', afterUndoC, original, tokenA)
        assert.equal(editor.canUndo, false, 'A was recorded exactly once, with no extra local or synthetic history boundary')
        assert.equal(editor.canRedo, true)
        const afterUndoA = f.store.getDocumentDetail(original.id); assert.ok(afterUndoA)
        await inverse('redo', afterUndoA, actualA, tokenA)
        assert.equal(editor.canRedo, true)
        const afterRedoA = f.store.getDocumentDetail(original.id); assert.ok(afterRedoA)
        await inverse('redo', afterRedoA, actualC, tokenC)
        assert.equal(editor.canRedo, false); assert.equal(inverses.length, 4)
        assert.equal(sourceAdoptions.length, 2); assert.equal(writes.length, 2)
      } finally {
        currentInverse()?.release.resolve(); release.resolve()
        await act(async () => root.unmount()); f.store.releaseSyncedEditingSessionsForSender(sender)
        dom.window.close()
        for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) }
      }
    }) } finally { t.mock.timers.reset() }
  })
