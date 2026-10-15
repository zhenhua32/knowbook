import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { register } from 'node:module'
import { act, createElement } from 'react'
import { EditorView } from '@codemirror/view'
import { JSDOM } from 'jsdom'
import type { SyncedBlocksApi, SyncedCanonicalEdit, SyncedGroupSnapshot, SyncedUpdateGroupInput } from '../src/shared/synced-blocks'
import { getSyncedWorkspaceController } from '../src/renderer/src/features/synced-blocks/controller'
import { syncedSnapshotGuard, type SyncedGroupBinding, type SyncedGroupScope } from '../src/renderer/src/features/synced-blocks/types'
import { isSyncedUuid } from '../src/shared/syncedBlockValidation'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { SyncedCanonicalSourceDialog } = await import('../src/renderer/src/features/synced-blocks/SyncedCanonicalSourceDialog')

const time = '2026-10-16T00:00:00.000Z', childId = ' __proto__:共享正文 '
const paragraph = (content: string): SyncedCanonicalEdit => ({ id: childId, type: 'paragraph', content,
  checked: false, depth: 0, parentBlockId: null, tags: ['preserved'], highlight: 'yellow' })

type Fixture = {
  document: Document
  window: JSDOM['window']
  bindings: SyncedGroupBinding[]
  attempts: number[]
  updates: SyncedUpdateGroupInput[]
  closed: number[]
  view: () => EditorView
  open: (index?: number) => Promise<void>
  click: (label: string) => Promise<void>
  edit: (source: string) => Promise<void>
  otherEdit: (content: string) => Promise<void>
  changeTopology: () => Promise<void>
}

/** Uses the real shared controller and real CM dialog. The injected API is a
 * persistence contract fixture, not a Main/SQLite or collaboration acceptance. */
async function withSource(run: (fixture: Fixture) => Promise<void>) {
  const dom = new JSDOM('<button id="opener-a">Source A</button><button id="opener-b">Source B</button><div id="mount"></div>',
    { url: 'https://fixture.local', pretendToBeVisual: true })
  const globals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element,
    Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, Document: dom.window.Document,
    MutationObserver: dom.window.MutationObserver, DOMRect: dom.window.DOMRect, Range: dom.window.Range,
    Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
  Object.assign(dom.window.HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) { this.open = true }, close(this: HTMLDialogElement) { this.open = false }
  })
  Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() })

  let saved: SyncedGroupSnapshot = {
    groupId: randomUUID(), creationId: randomUUID(), createdAt: time, revision: randomUUID(), topologyRevision: randomUUID(),
    origin: { version: 1, documentId: 'origin', pathAtCreation: 'Home/Original', firstInstanceId: randomUUID() }, bindings: [],
    blocks: [{ ...paragraph('initial body'), createdAt: time }], maxRelativeDepth: 0,
    instances: ['host-a', 'host-b'].map(hostDocumentId => ({ hostDocumentId, instanceId: randomUUID(), bindingVersion: randomUUID(),
      depth: 0, parentBlockId: null, parentType: null })),
    history: { cursor: randomUUID(), undoToken: null, redoToken: null }
  }
  saved.origin.firstInstanceId = saved.instances[0].instanceId
  const updates: SyncedUpdateGroupInput[] = [], closed: number[] = [], attempts = [0, 0], workspaceScope = randomUUID()
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected persistence or structure operation') }
  const api: SyncedBlocksApi = {
    getSyncedGroupSnapshots: async () => ({ workspaceScope, items: [{ status: 'ready', snapshot: structuredClone(saved) }] }),
    listSyncedGroups: unexpected,
    updateSyncedBlockGroup: async input => {
      updates.push(input)
      assert.equal(input.expectedRevision, saved.revision)
      assert.equal(input.expectedTopologyRevision, saved.topologyRevision)
      const creationTimes = new Map(saved.blocks.map(block => [block.id, block.createdAt]))
      saved = { ...saved, revision: randomUUID(), blocks: input.blocks.map(block => ({ ...block, createdAt: creationTimes.get(block.id) ?? time })),
        maxRelativeDepth: Math.max(...input.blocks.map(block => block.depth)), history: { cursor: randomUUID(), undoToken: randomUUID(), redoToken: null } }
      return { status: 'saved', operationId: input.clientOperationId, replayed: false, snapshot: structuredClone(saved) }
    },
    getSyncedOperation: unexpected, applySyncedHostStructure: unexpected, restoreSyncedGroupOperation: unexpected,
    restoreSyncedHostOperation: unexpected, getSyncedHostHistory: unexpected, onSyncedBlocksChanged: () => () => {}
  }
  const workspace = getSyncedWorkspaceController(api)
  await workspace.load([saved.groupId])
  const controller = workspace.getGroup(saved.groupId)!
  let alive = true
  const bindings = saved.instances.map((instance, index) => {
    const scope: SyncedGroupScope = { ...instance, owner: { kind: 'synced-group', groupId: saved.groupId },
      windowSessionId: randomUUID(), hostSession: {}, mountEpoch: {}, bindingEpoch: {},
      domNamespace: JSON.stringify(['canonical-source-test', instance.instanceId]), root: () => dom.window.document.querySelector('dialog'), isCurrent: () => alive }
    const binding = controller.bind(scope), apply = binding.apply
    binding.apply = input => { attempts[index]++; return apply(input) }
    return binding
  })
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  const open = async (index = 0) => { await act(async () => root.render(createElement(SyncedCanonicalSourceDialog, {
    binding: bindings[index], isZh: false, opener: dom.window.document.getElementById(index ? 'opener-b' : 'opener-a'),
    onClose: () => { closed.push(index); root.render(null) }
  }))) }
  const view = () => {
    const element = dom.window.document.querySelector<HTMLElement>('.cm-editor'); assert.ok(element)
    const result = EditorView.findFromDOM(element); assert.ok(result); return result
  }
  const click = async (label: string) => {
    const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === label)
    assert.ok(button, label); await act(async () => button.click())
  }
  try {
    await run({ document: dom.window.document, window: dom.window, bindings, attempts, updates, closed, open, view, click,
      edit: async source => { await act(async () => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: source } })) },
      otherEdit: async content => { await act(async () => {
        const current = bindings[1].getCurrent()
        assert.equal(bindings[1].apply({ expectedEditSequence: current.editSequence, guards: syncedSnapshotGuard(current.snapshot),
          blocks: [paragraph(content)], bookmark: null, transactionId: randomUUID() }), true)
      }) },
      changeTopology: async () => {
        saved = { ...saved, topologyRevision: randomUUID() }
        await act(async () => workspace.load([saved.groupId]))
      } })
  } finally {
    await act(async () => { root.unmount(); alive = false; for (const binding of bindings) binding.dispose() })
    // A deliberately unresolved real IME lease is retained by the controller;
    // teardown does not fabricate compositionend to make dispose succeed.
    workspace.dispose(); dom.window.close()
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('accepted canonical Source Apply creates one real group history step and no independent writer', async () => {
  await withSource(async api => {
    const original = api.bindings[0].getCurrent().working
    await api.open(); await api.edit('updated body'); await api.click('Apply changes')
    assert.deepEqual(api.closed, [0]); assert.equal(api.document.querySelector('dialog'), null)
    assert.deepEqual(api.attempts, [1, 0]); assert.equal(api.updates.length, 0)
    const accepted = api.bindings[0].getCurrent()
    assert.equal(accepted.working[0].content, 'updated body'); assert.equal(accepted.working[0].id, childId)
    assert.deepEqual(accepted.working[0].tags, ['preserved']); assert.equal(accepted.canUndo, true)
    assert.equal(await api.bindings[0].undo(), true)
    assert.deepEqual(api.bindings[0].getCurrent().working, original)
    assert.equal(api.bindings[0].getCurrent().canUndo, false, 'A single Undo consumes the entire Source Apply')
    assert.equal(await api.bindings[0].redo(), true)
    assert.equal(api.bindings[0].getCurrent().working[0].content, 'updated body')
    assert.equal(await api.bindings[0].flush(), true)
    assert.equal(api.updates.length, 1)
    assert.equal(api.updates[0].blocks[0].content, 'updated body')
  })
})

test('untouched Source is a no-op even after another instance edits and cannot overwrite its newer body', async () => {
  await withSource(async api => {
    await api.open(); await api.otherEdit('newer shared body')
    const newer = api.bindings[0].getCurrent()
    assert.equal(api.view().state.doc.toString(), 'initial body')
    await api.click('Apply changes')
    assert.deepEqual(api.closed, [0]); assert.deepEqual(api.attempts, [0, 1])
    assert.equal(api.bindings[0].getCurrent(), newer)
    assert.equal(api.bindings[0].getCurrent().working[0].content, 'newer shared body')
    assert.equal(api.updates.length, 0)
    assert.equal(await api.bindings[1].undo(), true)
    assert.equal(api.bindings[1].getCurrent().canUndo, false)
  })
})

test('stale editSequence and independent topology CAS both retain the real CM draft without a group Apply', async () => {
  await withSource(async api => {
    await api.open(); await api.edit('retained local source'); await api.otherEdit('other accepted body')
    const before = api.bindings[0].getCurrent()
    await api.click('Apply changes')
    assert.deepEqual(api.closed, []); assert.equal(api.view().state.doc.toString(), 'retained local source')
    assert.equal(api.bindings[0].getCurrent(), before); assert.deepEqual(api.attempts, [0, 1])
    assert.ok(api.document.querySelector('[role="alert"]')?.textContent?.includes('Your source is retained'))
    await api.click('Cancel'); await api.open(); await api.edit('retained topology source')
    const sequence = api.bindings[0].getCurrent().editSequence, revision = api.bindings[0].getCurrent().snapshot.revision
    await api.changeTopology()
    const changed = api.bindings[0].getCurrent()
    assert.equal(changed.editSequence, sequence); assert.equal(changed.snapshot.revision, revision)
    await api.click('Apply changes')
    assert.deepEqual(api.closed, [0]); assert.equal(api.view().state.doc.toString(), 'retained topology source')
    assert.equal(api.bindings[0].getCurrent(), changed); assert.deepEqual(api.attempts, [0, 1]); assert.equal(api.updates.length, 0)
    assert.ok(api.document.querySelector('[role="alert"]')?.textContent?.includes('Your source is retained'))
  })
})

test('deleting all source explicitly accepts one fresh real paragraph and group Undo restores the original forest', async () => {
  await withSource(async api => {
    const before = api.bindings[0].getCurrent().working
    await api.open(); await api.edit(''); await api.click('Apply changes')
    const blocks = api.bindings[0].getCurrent().working
    assert.equal(blocks.length, 1); assert.equal(isSyncedUuid(blocks[0].id), true); assert.notEqual(blocks[0].id, childId)
    assert.deepEqual({ ...blocks[0], id: 'fresh' }, { id: 'fresh', type: 'paragraph', content: '', checked: false, depth: 0, parentBlockId: null })
    assert.deepEqual(api.attempts, [1, 0]); assert.equal(api.updates.length, 0)
    assert.equal(await api.bindings[0].undo(), true)
    assert.deepEqual(api.bindings[0].getCurrent().working, before)
    assert.equal(api.bindings[0].getCurrent().canUndo, false)
  })
})

test('switching the actual binding remounts Source while retaining the old IME lease and only ends the new mount naturally', async () => {
  await withSource(async api => {
    await api.otherEdit('dirty before opening'); await api.open()
    const firstView = api.view(), firstId = api.bindings[0].scope.instanceId, secondId = api.bindings[1].scope.instanceId
    await act(async () => firstView.contentDOM.dispatchEvent(new api.window.CompositionEvent('compositionstart', { bubbles: true })))
    assert.deepEqual(api.bindings[0].getCurrent().composingInstanceIds, [firstId])
    await api.open(1)
    assert.notEqual(api.view(), firstView); assert.equal(api.view().contentDOM.getAttribute('aria-label'), 'Shared body Markdown source')
    assert.equal(api.view().state.doc.toString(), 'dirty before opening')
    assert.deepEqual(api.bindings[1].getCurrent().composingInstanceIds, [firstId])
    assert.equal(await api.bindings[1].flush(), false); assert.equal(api.updates.length, 0)
    await act(async () => api.view().contentDOM.dispatchEvent(new api.window.CompositionEvent('compositionstart', { bubbles: true })))
    assert.deepEqual(new Set(api.bindings[1].getCurrent().composingInstanceIds), new Set([firstId, secondId]))
    await act(async () => api.view().contentDOM.dispatchEvent(new api.window.CompositionEvent('compositionend', { bubbles: true })))
    assert.deepEqual(api.bindings[1].getCurrent().composingInstanceIds, [firstId])
    await api.click('Cancel'); assert.deepEqual(api.closed, [1])
    assert.equal(api.bindings[0].getCurrent().working[0].content, 'dirty before opening')
    assert.equal(await api.bindings[0].flush(), false); assert.equal(api.updates.length, 0)
  })
})
