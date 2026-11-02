import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React, { act, createElement, useState, useSyncExternalStore } from 'react'
import { JSDOM } from 'jsdom'
import { EditorView } from '@codemirror/view'
import type { DocumentDetail, ElectronApi } from '../src/shared/contracts'
import type { SyncedEditingMethod, SyncedEditingRequest, SyncedEditingResult } from '../src/shared/synced-editing-session'
import { useAppShellState } from '../src/renderer/src/hooks/useAppShellState'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { useDocumentNavigationState } from '../src/renderer/src/hooks/useDocumentNavigationState'
import { getUiText } from '../src/renderer/src/i18n'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { getCanonicalInlineRuntime } = await import('../src/renderer/src/features/synced-blocks/inlineRuntime')
const { SyncedHostSourceDialog } = await import('../src/renderer/src/features/synced-blocks/SyncedHostSourceDialog')

test('real React page changes preserve failed ordinary W without saving, while document changes, actual Source CM, IME and an unknown genuine Main receipt keep their boundaries',
  { concurrency: false }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try { await withCanonicalSearchFixture(async f => {
      const original = f.store.getDocumentDetail(f.ordinaryDocumentId); assert.ok(original)
      const dom = new JSDOM('<div id="mount"></div>', { url: 'https://page-purpose.fixture.local', pretendToBeVisual: true })
      const globals = new Map<string, PropertyDescriptor | undefined>()
      for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
        HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
        Element: dom.window.Element, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, Document: dom.window.Document,
        MutationObserver: dom.window.MutationObserver, DOMRect: dom.window.DOMRect, Range: dom.window.Range,
        Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
        globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
      }
      Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
      Object.assign(dom.window.HTMLDialogElement.prototype, { showModal(this: HTMLDialogElement) { this.open = true }, close(this: HTMLDialogElement) { this.open = false } })
      Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() })
      dom.window.HTMLElement.prototype.scrollIntoView = () => undefined
      const sender = Object.freeze({ frame: 'page-purpose-real-main' })
      const home: Awaited<ReturnType<ElectronApi['getPluginHomeData']>> = {
        pluginDashboardCards: [], pluginDocumentActions: [], pluginUiContributions: [],
        pluginV2Installations: [], systemPluginInstallRequests: [], systemPlugins: []
      }
      let writes = 0, hostFlushes = 0, loseWriteReply = false, loseLookupReply = false
      const calls: SyncedEditingRequest[] = [], notices: string[] = []
      async function invoke<M extends SyncedEditingMethod>(input: SyncedEditingRequest<M>): Promise<SyncedEditingResult<M>> {
        calls.push(structuredClone(input) as SyncedEditingRequest)
        const result = f.store.invokeSyncedEditingSession(sender, input)
        if (input.method === 'applySyncedHostStructure' && loseWriteReply) { loseWriteReply = false; throw Error('Reply lost after actual Main result') }
        if (input.method === 'getSyncedOperation' && loseLookupReply) { loseLookupReply = false; throw Error('Lookup reply lost after actual Main read') }
        return structuredClone(result)
      }
      const api: Pick<ElectronApi, 'getHomeData' | 'getPluginHomeData' | 'getSetting' | 'saveSetting' | 'updateDocument' | 'getDocumentDetail'
        | 'onWorkspaceMutated' | 'onPluginsMutated' | 'onSyncedBlocksChanged' | 'openSyncedEditingSession'
        | 'invokeSyncedEditingSession' | 'releaseSyncedEditingSession'> = {
        getHomeData: async () => f.store.getHomeData(f.destination), getPluginHomeData: async () => home,
        getSetting: async key => key === 'pinned_documents' ? '[]' : null, saveSetting: async () => undefined,
        getDocumentDetail: async id => f.store.getDocumentDetail(id),
        updateDocument: async (id, input) => {
          writes++; f.store.updateDocument(id, input)
          const document = f.store.getDocumentDetail(id); assert.ok(document)
          return { document, requiresFullRefresh: true }
        },
        onWorkspaceMutated: () => () => undefined, onPluginsMutated: () => () => undefined, onSyncedBlocksChanged: () => () => undefined,
        openSyncedEditingSession: async input => structuredClone(f.store.openSyncedEditingSession(sender, input)),
        invokeSyncedEditingSession: invoke, releaseSyncedEditingSession: async id => { f.store.releaseSyncedEditingSession(sender, id) }
      }
      Object.defineProperty(dom.window, 'knowbook', { configurable: true, value: api })
      const runtime = getCanonicalInlineRuntime()
      let shell!: ReturnType<typeof useAppShellState>, editor!: ReturnType<typeof useDocumentEditorState>, navigation!: ReturnType<typeof useDocumentNavigationState>
      function SourceOutlet() {
        const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot), dialog = state.dialog
        if (!dialog) return null
        assert.equal(dialog.kind, 'host')
        if (dialog.kind !== 'host') return null
        return <SyncedHostSourceDialog sessionKey={dialog.id} getCurrent={runtime.sourceCurrent} isCurrent={() => runtime.sourceIsCurrent(dialog)}
          opener={null} isZh={false} applyPrepared={prepared => runtime.applyHostSource(dialog, prepared)}
          onLocalStateChange={dialog.report} onClose={dialog.close} />
      }
      function Harness() {
        const [selected, setSelected] = useState<DocumentDetail | null>(original)
        shell = useAppShellState()
        editor = useDocumentEditorState({ selectedDocumentId: original!.id, selectedDocument: selected, ui: getUiText('en-US'),
          onHomeDataChange: shell.setHomeData, onSelectedDocumentChange: setSelected, onMessage: message => { if (message) notices.push(message) } })
        navigation = useDocumentNavigationState({ onActivePageChange: shell.setActivePage,
          onBeforeOpenDocument: () => editor.flushPendingChanges() })
        runtime.configure({ getCurrent: editor.getSyncedHostEditorState, getPersisted: () => selected,
          adopt: editor.adoptSyncedHostStructureResult, adoptHistory: editor.adoptSyncedHostHistoryResult,
          applyOrdinarySource: editor.applyOrdinaryMarkdownSource, isComposing: editor.isSyncedHostComposing, isReady: () => true,
          flushHost: () => { hostFlushes++; return editor.flushPendingChanges() }, navigateHost: async () => false,
          selectedHostId: () => original!.id, notify: message => { notices.push(message) }, isZh: false })
        return <><output id="page">{shell.activePage}</output>
          {shell.activePage === 'documents' ? <div className="block-editor-list">{editor.draftBlocks.map((block, index) =>
            <div key={block.id} className="block-editor-row" data-block-id={block.id} data-block-index={index}>
              <textarea value={block.content} onChange={() => {}} onInput={event => editor.updateDraftBlock(index, { content: event.currentTarget.value })} />
            </div>)}</div> : <section className={'page-' + shell.activePage}>Shared hook W remains mounted</section>}
          <SourceOutlet /></>
      }
      const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
      const settle = async () => { for (let turn = 0; turn < 20; turn++) await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)) }) }
      const choose = async (page: Parameters<typeof shell.setActivePage>[0], expected: string) => {
        await act(async () => shell.setActivePage(page)); await settle(); assert.equal(shell.activePage, expected)
      }
      const retained = original.blocks[0].content + ' retained ordinary W', physical = () => f.store.getDocumentDetail(original.id)!.blocks[0].content
      try {
        await act(async () => root.render(createElement(Harness)))
        await act(async () => { editor.loadDocumentIntoEditor(original); navigation.setSelectedDocumentId(original.id) })
        await settle()
        await act(async () => editor.updateDraftBlock(0, { content: retained }))
        f.db.pragma('query_only=ON') // Actual Main SQLite refuses the original write, no synthetic ACK.
        await act(async () => assert.equal(await editor.flushPendingChanges(), false))
        const failedWrites = writes
        assert.ok(failedWrites > 0); assert.equal(physical(), original.blocks[0].content)
        await choose('settings', 'settings')
        assert.equal(editor.draftBlocks[0].content, retained); assert.equal(writes, failedWrites); assert.equal(hostFlushes, 0)
        await choose('ai', 'ai')
        assert.equal(physical(), original.blocks[0].content, 'Opening AI itself must preserve the old unpersisted-source precondition')
        await act(async () => assert.equal(await navigation.selectDocumentContext(f.targetId), false))
        assert.equal(navigation.selectedDocumentId, original.id); assert.equal(editor.draftBlocks[0].content, retained)
        await choose('documents', 'documents')
        assert.equal(dom.window.document.querySelector('textarea')!.value, retained)

        const input = dom.window.document.querySelector('textarea')!
        await act(async () => input.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true })))
        assert.equal(editor.isSyncedHostComposing(), true)
        await choose('settings', 'documents')
        await act(async () => input.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true })))
        assert.equal(editor.isSyncedHostComposing(), false)
        f.db.pragma('query_only=OFF')
        await act(async () => assert.equal(await editor.flushPendingChanges(), true))
        assert.equal(physical(), retained)
        await act(async () => assert.equal(await runtime.openHostSource(null), true)); await settle()
        const source = dom.window.document.querySelector<HTMLElement>('.cm-editor'); assert.ok(source)
        const view = EditorView.findFromDOM(source); assert.ok(view)
        const sourceW = view.state.doc.toString() + '\n\nretained actual CM draft'
        await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\nretained actual CM draft' } }))
        assert.equal(runtime.getSnapshot().dialog?.local.dirty, true)
        await choose('settings', 'documents')
        assert.equal(EditorView.findFromDOM(source), view); assert.equal(view.state.doc.toString(), sourceW)
        const cancel = [...dom.window.document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Cancel')!
        await act(async () => cancel.click()); assert.equal(runtime.getSnapshot().dialog, null)

        loseWriteReply = true; loseLookupReply = true
        await act(async () => { await assert.rejects(runtime.saveHostWorking(editor.getSyncedHostEditorState()!), /Lookup reply lost/) })
        assert.equal(runtime.hostSavePending(editor.getSyncedHostEditorState()!.hostSession), true)
        const beforePageCalls = calls.length
        await choose('settings', 'documents')
        assert.equal(calls.length, beforePageCalls, 'A page jump cannot silently settle an uncertain Main request')
        await act(async () => { await runtime.saveHostWorking(editor.getSyncedHostEditorState()!) })
        assert.equal(runtime.hostSavePending(editor.getSyncedHostEditorState()!.hostSession), false)
        await choose('settings', 'settings')
        assert.equal(editor.draftBlocks[0].content, retained); assert.equal(physical(), retained)
      } finally {
        f.db.pragma('query_only=OFF')
        await act(async () => root.unmount()); f.store.releaseSyncedEditingSessionsForSender(sender)
        dom.window.close()
        for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
      }
    }) } finally { t.mock.timers.reset() }
  })
