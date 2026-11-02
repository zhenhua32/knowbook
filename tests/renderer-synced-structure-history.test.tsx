import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { act, createElement, useState, type FormEvent } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentDetail, ElectronApi } from '../src/shared/contracts'
import type { SyncedRestoreHostInput } from '../src/shared/synced-blocks'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { getUiText } from '../src/renderer/src/i18n'
import { getCanonicalInlineRuntime } from '../src/renderer/src/features/synced-blocks/inlineRuntime'
import { canonicalInlineInputLocked } from '../src/renderer/src/features/synced-blocks/inlineBridge'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'
import { applySyncedHostCommand, createRequest, created } from './helpers/synced-host-command-create-fixture'

// The transport adapter calls the actual Store with one genuine sender object.
// It does not mint Main ACKs, group snapshots, sessions or permissions. Native
// Electron IPC and mounted canonical views are separately covered by E2E.
test('actual React history crosses the real Main create boundary without losing ordinary redo, recovers only the original inverse ACK, and retains W on a changed Main token',
  { concurrency: false }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try { await withCanonicalSearchFixture(async f => {
      const sender = Object.freeze({ sender: randomUUID() }), docId = f.ordinaryDocumentId, otherId = randomUUID()
      const seed = f.store.getDocumentDetail(docId); assert.ok(seed)
      f.store.updateDocument(docId, { title: seed.title, summary: seed.summary, blocks: [...seed.blocks,
        { id: otherId, type: 'paragraph', content: 'Ordinary B before', checked: false, depth: 0, parentBlockId: null }] })
      const original = f.store.getDocumentDetail(docId); assert.ok(original)
      const selectedId = original.blocks[0].id, inverseRequests: SyncedRestoreHostInput[] = [], operationLookups: string[] = [], notices: string[] = []
      let loseInverseReply = false, loseOperationLookup = false
      const dom = new JSDOM('<div id="mount"></div>', { url: 'https://history.fixture.local', pretendToBeVisual: true })
      const originals = new Map<string, PropertyDescriptor | undefined>()
      for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
        navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
        requestAnimationFrame: (): number => 1, cancelAnimationFrame: (): void => {}, IS_REACT_ACT_ENVIRONMENT: true })) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
        Object.defineProperty(globalThis, name, { configurable: true, value })
      }
      const api: Pick<ElectronApi, 'getDocumentDetail' | 'getHomeData' | 'updateDocument' | 'openSyncedEditingSession'
        | 'invokeSyncedEditingSession' | 'releaseSyncedEditingSession' | 'onWorkspaceMutated' | 'onSyncedBlocksChanged'> = {
        getDocumentDetail: async id => f.store.getDocumentDetail(id),
        getHomeData: async () => f.store.getHomeData(f.destination),
        updateDocument: async (id, input) => { f.store.updateDocument(id, input); const document = f.store.getDocumentDetail(id); assert.ok(document); return { document, requiresFullRefresh: true } },
        openSyncedEditingSession: async input => f.store.openSyncedEditingSession(sender, input),
        releaseSyncedEditingSession: async id => f.store.releaseSyncedEditingSession(sender, id),
        invokeSyncedEditingSession: async request => {
          if (request.method === 'getSyncedOperation') operationLookups.push((request.input as { clientOperationId: string }).clientOperationId)
          if (request.method === 'getSyncedOperation' && loseOperationLookup) {
            loseOperationLookup = false; throw Error('Transparent lookup transport outage; no synthetic result')
          }
          const result = f.store.invokeSyncedEditingSession(sender, request)
          if (request.method === 'restoreSyncedHostOperation') {
            inverseRequests.push(structuredClone(request.input as SyncedRestoreHostInput))
            if (loseInverseReply) { loseInverseReply = false; assert.ok(result && typeof result === 'object' && 'status' in result); assert.equal(result.status, 'applied'); throw Error('Transparent reply loss after the actual SQL commit') }
          }
          return structuredClone(result)
        },
        // No canonical controller views are mounted in this hook harness. All
        // observed state and every mutation still come from actual Store reads.
        onWorkspaceMutated: () => () => {}, onSyncedBlocksChanged: () => () => {}
      }
      Object.defineProperty(dom.window, 'knowbook', { value: api })
      const runtime = getCanonicalInlineRuntime()
      let editor!: ReturnType<typeof useDocumentEditorState>
      function Harness() {
        const [selected, setSelected] = useState<DocumentDetail | null>(original)
        editor = useDocumentEditorState({ selectedDocumentId: docId, selectedDocument: selected, ui: getUiText('en-US'),
          onHomeDataChange: () => {}, onSelectedDocumentChange: setSelected, onMessage: message => { if (message) notices.push(message) } })
        runtime.configure({ getCurrent: () => editor.getSyncedHostEditorState(), getPersisted: () => selected,
          adopt: (before, result) => editor.adoptSyncedHostStructureResult(before, result),
          adoptHistory: (before, result) => editor.adoptSyncedHostHistoryResult(before, result),
          flushHost: () => editor.flushPendingChanges(), navigateHost: async () => false,
          notify: message => { notices.push(message) }, isReady: () => true, isComposing: () => editor.isSyncedHostComposing(),
          canStartStructure: () => !editor.isSaving, requiresHostSurface: () => false, isZh: false, selectedHostId: () => docId })
        return createElement('div', { className: 'block-editor-list' }, editor.draftBlocks.map((block, index) =>
          createElement('div', { key: block.id, className: 'block-editor-row', 'data-block-index': index, 'data-block-id': block.id },
            createElement('textarea', { value: block.content, onChange: () => {},
              onInput: (event: FormEvent<HTMLTextAreaElement>) => editor.updateDraftBlock(index, { content: event.currentTarget.value }) }))))
      }
      const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
      const body = () => structuredClone(editor.draftBlocks.map(block => ({ ...block, tags: block.tags ?? [] })))
      const input = () => dom.window.document.querySelector<HTMLTextAreaElement>('[data-block-id="' + otherId + '"] textarea')!
      const undo = async () => { await act(async () => { await editor.undoEdit(); t.mock.timers.tick(0) }) }
      const redo = async () => { await act(async () => { await editor.redoEdit(); t.mock.timers.tick(0) }) }
      try {
        await act(async () => { root.render(createElement(Harness)) })
        await act(async () => { editor.loadDocumentIntoEditor(original) })
        const before = body()
        await act(async () => { assert.equal(await runtime.commands.openCreate([selectedId], () => true, null), true) })
        await act(async () => { assert.equal(await runtime.commands.apply(), true) })
        const afterCreate = body(), instance = afterCreate.find(block => block.type === 'synced-block'); assert.ok(instance)
        assert.equal(afterCreate.some(block => block.id === selectedId), false)
        assert.equal(editor.canUndo, true)
        const token = runtime.sourceCurrent(); assert.ok(token)
        const historySession = await api.openSyncedEditingSession({ kind: 'host', hostDocumentId: docId }); assert.equal(historySession.status, 'ready')
        if (historySession.status !== 'ready') throw Error('Actual session unavailable')
        const history = await api.invokeSyncedEditingSession({ sessionId: historySession.session.sessionId,
          method: 'getSyncedHostHistory', input: { documentId: docId } }); assert.ok(history.undoToken)

        await act(async () => {
          const target = input(); target.focus(); target.setSelectionRange(target.value.length, target.value.length)
          target.dispatchEvent(new dom.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText' }))
          target.value = 'Ordinary B after'; target.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }))
        })
        await act(async () => { editor.checkpointDraft() })
        const withOrdinary = body()
        await act(async () => { assert.equal(await editor.flushPendingChanges(), true) })
        assert.equal(f.store.getDocumentDetail(docId)!.blocks.find(block => block.id === otherId)?.content, 'Ordinary B after')
        await undo(); assert.deepEqual(body(), afterCreate); assert.equal(inverseRequests.length, 0)
        await undo(); assert.deepEqual(body(), before, JSON.stringify({ notices, inverseRequests, operationLookups })); assert.equal(inverseRequests.length, 1)
        assert.equal(inverseRequests[0].historyToken, history.undoToken)
        assert.equal(f.store.getDocumentDetail(docId)!.blocks.some(block => block.id === selectedId), true)
        assert.equal(f.store.getDocumentDetail(docId)!.blocks.some(block => block.type === 'synced-block'), false)
        assert.equal(editor.canRedo, true)
        await redo(); assert.deepEqual(body(), afterCreate); assert.equal(inverseRequests.length, 2)
        assert.equal(inverseRequests[1].direction, 'redo')
        assert.ok(inverseRequests[1].groups.length, 'real retired-create lifecycle guards reach Main on Redo')
        await redo(); assert.deepEqual(body(), withOrdinary); assert.equal(inverseRequests.length, 2)

        await undo(); assert.deepEqual(body(), afterCreate)
        loseInverseReply = true; loseOperationLookup = true
        await undo()
        assert.deepEqual(body(), afterCreate, 'uncertain inverse never publishes an invented local before side')
        assert.equal(runtime.history.pending(), true); assert.equal(canonicalInlineInputLocked(), true)
        assert.equal(inverseRequests.length, 3)
        assert.equal(f.store.getDocumentDetail(docId)!.blocks.some(block => block.id === selectedId), true, 'the transparent failure happened after a real commit')
        await act(async () => { assert.equal(await editor.flushPendingChanges(), false) })
        assert.equal(await runtime.commands.openInsert(null, () => true, null), false)
        await undo()
        assert.deepEqual(body(), before); assert.equal(runtime.history.pending(), false); assert.equal(canonicalInlineInputLocked(), false)
        assert.equal(inverseRequests.length, 3, 'receipt recovery does not replay a writer whose captured instance was already removed')
        assert.deepEqual(operationLookups.slice(-2), [inverseRequests[2].clientOperationId, inverseRequests[2].clientOperationId], 'same original inverse ID is read through the actual Main receipt route')
        await redo(); assert.deepEqual(body(), afterCreate)

        // A real external create changes today's Main tail while this genuine
        // renderer opening remains unchanged. No synthetic history DTO is used.
        const external = createRequest(f.db, { documentId: docId, selectedRootIds: [otherId] })
        created(applySyncedHostCommand(f.db, external))
        const retained = body(), calls = inverseRequests.length, persisted = f.store.getDocumentDetail(docId)
        await undo()
        assert.deepEqual(body(), retained); assert.equal(inverseRequests.length, calls)
        assert.deepEqual(f.store.getDocumentDetail(docId), persisted, 'changed history token is rejected before any flush or inverse mutation')
        assert.equal(editor.canUndo, true); assert.equal(runtime.history.pending(), false)
        assert.ok(notices.some(message => message.includes('original structure acknowledgement')))
      } finally {
        await act(async () => { root.unmount() })
        f.store.releaseSyncedEditingSessionsForSender(sender)
        for (const [name, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor)
          else Reflect.deleteProperty(globalThis, name)
        }
        dom.window.close()
      }
    }) } finally { t.mock.timers.reset() }
  })
