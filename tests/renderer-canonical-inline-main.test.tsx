import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { register } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import React, { act, createElement, useSyncExternalStore } from 'react'
import { EditorView } from '@codemirror/view'
import { JSDOM } from 'jsdom'
import type { ElectronApi, DocumentDetail } from '../src/shared/contracts'
import type { SyncedBlocksChangedEvent, SyncedGroupSaved } from '../src/shared/synced-blocks'
import type { SyncedEditingMethod, SyncedEditingRequest, SyncedEditingResult } from '../src/shared/synced-editing-session'
import type { SyncedHostSourceCurrent } from '../src/renderer/src/features/synced-blocks/SyncedHostSourceDialog'
import { getUiText } from '../src/renderer/src/i18n'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { InlineSyncedProvider, useInlineHostView } = await import('../src/renderer/src/features/synced-blocks/InlineSyncedContext')
const { BlockReadingRow } = await import('../src/renderer/src/components/BlockReadingRow')
// Resolve the real lazy chunk before the scheduler-only DOM polling begins.
// Production loading is exercised by the background Electron cases.
await import('../src/renderer/src/features/synced-blocks/InlineSyncedBlock')
const { SyncedCanonicalSourceDialog } = await import('../src/renderer/src/features/synced-blocks/SyncedCanonicalSourceDialog')
const { getCanonicalInlineRuntime } = await import('../src/renderer/src/features/synced-blocks/inlineRuntime')

test('real Main sessions drive React inline and CM Source across three references without copying canonical children into host SQL; an actual epoch change preserves rejected W',
  { concurrency: false }, () => withCanonicalSearchFixture(async f => {
    const dom = new JSDOM('<div id="mount"></div>', { url: 'https://fixture.local', pretendToBeVisual: true })
    const globals = new Map<string, PropertyDescriptor | undefined>()
    for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
      Element: dom.window.Element, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, Document: dom.window.Document,
      MutationObserver: dom.window.MutationObserver, DOMRect: dom.window.DOMRect, Range: dom.window.Range,
      Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
      globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
      Object.defineProperty(globalThis, name, { configurable: true, value })
    }
    Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
    Object.assign(dom.window.HTMLDialogElement.prototype, { showModal(this: HTMLDialogElement) { this.open = true }, close(this: HTMLDialogElement) { this.open = false } })
    Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() })
    dom.window.HTMLElement.prototype.scrollIntoView = () => undefined

    // These ports call the actual Store and its private sender registry. They
    // do not synthesize an ACK, a snapshot, a session or source-read ownership.
    // Native IPC/frame admission is separately tested; this is Main + React.
    const sender = Object.freeze({ frame: 'actual-store-test-sender' })
    const changed = new Set<(event: SyncedBlocksChangedEvent) => void>(), mutations = new Set<() => void>()
    const calls: SyncedEditingRequest[] = [], failures: unknown[] = [], successfulOperations: string[] = []
    const sessions = new Set<string>()
    async function invoke<M extends SyncedEditingMethod>(input: SyncedEditingRequest<M>): Promise<SyncedEditingResult<M>> {
      calls.push(structuredClone(input) as SyncedEditingRequest)
      try {
        const result = f.store.invokeSyncedEditingSession(sender, input)
        if (result && typeof result === 'object' && 'status' in result && (result.status === 'saved' || result.status === 'noop') && 'snapshot' in result) {
          const actual = result as SyncedGroupSaved
          successfulOperations.push(actual.operationId)
          const snapshot = actual.snapshot
          const event: SyncedBlocksChangedEvent = { operationId: actual.operationId,
            changes: [{ groupId: snapshot.groupId, revision: snapshot.revision, topologyRevision: snapshot.topologyRevision, kind: 'content' }],
            affectedInstanceIds: snapshot.instances.map(instance => instance.instanceId) }
          for (const listener of changed) listener(event)
        }
        return structuredClone(result)
      } catch (error) { failures.push(error); throw error }
    }
    const api: Pick<ElectronApi, 'openSyncedEditingSession' | 'invokeSyncedEditingSession' | 'releaseSyncedEditingSession'
      | 'resolveSyncedInlineInstance' | 'resolveWorkspaceSearchOccurrence' | 'onSyncedBlocksChanged' | 'onWorkspaceMutated'
      | 'getDocumentDetail' | 'writeClipboardText'> = {
      openSyncedEditingSession: async input => {
        const result = f.store.openSyncedEditingSession(sender, input)
        if (result.status === 'ready') sessions.add(result.session.sessionId)
        return structuredClone(result)
      },
      invokeSyncedEditingSession: invoke,
      releaseSyncedEditingSession: async sessionId => { f.store.releaseSyncedEditingSession(sender, sessionId) },
      resolveSyncedInlineInstance: async input => structuredClone(f.store.resolveSyncedInlineInstance(input)),
      resolveWorkspaceSearchOccurrence: async input => structuredClone(f.store.resolveWorkspaceSearchOccurrence(input)),
      onSyncedBlocksChanged: listener => { changed.add(listener); return () => { changed.delete(listener) } },
      onWorkspaceMutated: listener => { mutations.add(listener); return () => { mutations.delete(listener) } },
      getDocumentDetail: async id => f.store.getDocumentDetail(id), writeClipboardText: async () => undefined
    }
    Object.defineProperty(dom.window, 'knowbook', { configurable: true, value: api })
    const runtime = getCanonicalInlineRuntime(), ui = getUiText('en-US'), notices: string[] = []
    const currentFor = (documentId: string): { detail: DocumentDetail; state: SyncedHostSourceCurrent } => {
      const detail = f.store.getDocumentDetail(documentId); assert.ok(detail)
      return { detail, state: { hostSession: Object.freeze({}), editSequence: 0, host: { documentId,
        expectedPersistedUpdatedAt: detail.updatedAt, workingBefore: { title: detail.title, summary: detail.summary,
          blocks: detail.blocks.map(({ sortOrder: _order, ...block }) => block) } } } }
    }
    let current = currentFor(f.hostId), displayed = [f.firstInstanceId, f.secondInstanceId]
    runtime.configure({ getCurrent: () => current.state, getPersisted: () => current.detail,
      adopt: () => { throw new Error('Canonical Source must not adopt a host structure ACK') },
      flushHost: () => runtime.flush(), navigateHost: async () => false,
      selectedHostId: () => current.state.host.documentId, notify: message => { notices.push(message) }, isZh: false })
    function SourceOutlet() {
      const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot), dialog = state.dialog
      if (!dialog) return null
      assert.equal(dialog.kind, 'canonical')
      if (dialog.kind !== 'canonical') return null
      return <SyncedCanonicalSourceDialog binding={dialog.binding} opener={dialog.opener} isZh={false}
        onLocalStateChange={dialog.report} onClose={dialog.close} />
    }
    function Surface() {
      return <><InlineSyncedProvider key={current.state.host.documentId} value={{ documentId: current.state.host.documentId,
        hostSession: current.state.hostSession, getCurrent: () => current.state, runtime, ui, isZh: false,
        onOpenDocument: () => undefined, onOpenBlock: () => undefined, onOpenAnchor: () => undefined }}>
        <HostProbe />{displayed.map((instanceId, index) => {
          const block = current.state.host.workingBefore.blocks.find(block => block.id === instanceId)
          assert.ok(block); assert.equal(block.type, 'synced-block')
          return <BlockReadingRow key={instanceId} block={block} index={index} indentPx={0} numberLabel=""
            isHighlighted={false} hasChildren={false} collapsed={false} onToggleCollapse={() => undefined}
            onNavigateReference={() => undefined} ui={ui} isZh={false} />
        })}
      </InlineSyncedProvider><SourceOutlet /></>
    }
    function HostProbe() { assert.equal(useInlineHostView()?.hostSession, current.state.hostSession); return null }
    const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
    const instance = (id: string) => [...dom.window.document.querySelectorAll<HTMLElement>('.synced-inline-instance[data-synced-instance-id]')]
      .find(element => element.dataset.syncedInstanceId === id)
    const waitFor = async (predicate: () => boolean, description: string) => {
      for (let turn = 0; turn < 100; turn++) {
        if (predicate()) return
        await act(async () => { await delay(10) })
      }
      assert.fail(`${description}\n${dom.window.document.getElementById('mount')!.innerHTML}\nMain failures: ${failures.map(String).join('\n')}\nMethods: ${calls.map(call => call.method).join(',')}`)
    }
    const click = async (within: ParentNode, label: string) => {
      const button = [...within.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === label)
      assert.ok(button, label); assert.equal(button.disabled, false)
      await act(async () => button.click())
    }
    const sourceView = () => {
      const editor = dom.window.document.querySelector<HTMLElement>('.cm-editor'); assert.ok(editor)
      const view = EditorView.findFromDOM(editor); assert.ok(view); return view
    }
    const openAndEdit = async (instanceId: string, before: string, after: string) => {
      const owner = instance(instanceId); assert.ok(owner)
      await click(owner, 'Edit source')
      await waitFor(() => dom.window.document.querySelector('.cm-editor') !== null, 'Actual canonical CM Source did not mount')
      await act(async () => {
        const view = sourceView(), source = view.state.doc.toString(), from = source.indexOf(before)
        assert.ok(from >= 0, 'Expected the genuine original canonical source text')
        view.dispatch({ changes: { from, to: from + before.length, insert: after } })
      })
      assert.equal(runtime.getSnapshot().dialog?.local.dirty, true)
      await click(dom.window.document.querySelector('dialog')!, 'Apply changes')
      await waitFor(() => runtime.getSnapshot().dialog === null, 'Actual Source Apply did not close its accepted opening')
    }
    const originalHostRows = () => f.db.prepare('SELECT * FROM blocks WHERE document_id IN (?,?) ORDER BY document_id,sort_order').all(f.hostId, f.targetId)
    const beforeHostRows = originalHostRows(), beforeCanonical = `${f.query} Quasar nebula 数`
    const committed = beforeCanonical + ' saved through actual inline CM', rejected = committed + ' retained after actual epoch change'
    const closeRequest = randomUUID()
    try {
      await act(async () => root.render(createElement(Surface)))
      await waitFor(() => displayed.every(id => instance(id)?.textContent?.includes(beforeCanonical)), 'Both real host instances must show actual canonical W')
      assert.equal(sessions.size, 1, 'The two instances use one actual Main frame session')
      assert.ok(f.childId.includes('\0'))
      assert.ok([...instance(f.firstInstanceId)!.querySelectorAll<HTMLElement>('[data-block-id]')].some(row => row.dataset.blockId === f.childId))
      assert.ok(calls.some(input => input.method === 'captureBaseline'), 'The real private source-read owner must be captured')
      await openAndEdit(f.firstInstanceId, beforeCanonical, committed)
      await waitFor(() => displayed.every(id => instance(id)?.textContent?.includes(committed)), 'Shared accepted W must mirror to the second real instance')
      let flushed = false
      await act(async () => { flushed = await runtime.flush() })
      assert.equal(flushed, true)
      assert.ok(successfulOperations.length >= 1)
      const savedRow = f.db.prepare('SELECT content FROM synced_group_blocks WHERE group_id=? AND id=?').get(f.searchGroupId, f.childId) as { content: string }
      assert.equal(savedRow.content, committed)
      assert.equal(f.db.prepare('SELECT 1 FROM blocks WHERE id=?').get(f.childId), undefined)
      assert.deepEqual(originalHostRows(), beforeHostRows, 'Canonical edits must leave every ordinary host/reference row unchanged')
      assert.equal((f.db.prepare('SELECT count(*) AS n FROM synced_instances WHERE group_id=?').get(f.searchGroupId) as { n: number }).n, 3)

      // Follow the real one-selected-host lifecycle instead of giving two
      // different documents a forged shared renderer hostSession object.
      current = currentFor(f.targetId); displayed = [f.thirdInstanceId]
      await act(async () => root.render(createElement(Surface)))
      await waitFor(() => instance(f.thirdInstanceId)?.textContent?.includes(committed) === true, 'A second genuine host must read the same committed canonical row')
      assert.equal(sessions.size, 1)
      assert.deepEqual(originalHostRows(), beforeHostRows)

      // Actual durable SQL epoch mutation, before any attempted group save.
      // There is no fake error/ACK or caller recoveryEpoch substitution.
      f.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
      await openAndEdit(f.thirdInstanceId, committed, rejected)
      await act(async () => {
        runtime.freeze(closeRequest)
        flushed = await runtime.flush({ shouldContinue: () => runtime.ownsClose(closeRequest) })
      })
      assert.equal(flushed, false)
      assert.ok(failures.some(error => /Synced editing session.*workspace epoch changed/.test(String(error))), 'The real Main transaction must reject its old session epoch')
      assert.equal((f.db.prepare('SELECT content FROM synced_group_blocks WHERE group_id=? AND id=?').get(f.searchGroupId, f.childId) as { content: string }).content, committed)
      assert.equal(runtime.pending(), true)
      assert.ok(instance(f.thirdInstanceId)?.textContent?.includes(rejected), 'The rejected actual working body remains visible in its original instance')
      assert.deepEqual(originalHostRows(), beforeHostRows)
      const rejectedWrite = calls.filter(input => input.method === 'updateSyncedBlockGroup').at(-1)
      assert.ok(rejectedWrite?.method === 'updateSyncedBlockGroup')
      assert.equal(f.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(rejectedWrite.input.clientOperationId), undefined)
      assert.equal(runtime.ownsClose(closeRequest), true, 'A failed drain must not invent successful close admission')
    } finally {
      await act(async () => { runtime.cancelFreeze(closeRequest); runtime.getSnapshot().dialog?.close(); root.unmount() })
      f.store.releaseSyncedEditingSessionsForSender(sender)
      dom.window.close()
      for (const [name, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name)
      }
    }
  }))
