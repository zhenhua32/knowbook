import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import type { SyncedBlocksApi, SyncedGroupSnapshot } from '../src/shared/synced-blocks'
import type { WorkspaceSearchOccurrence } from '../src/shared/workspace-search-occurrence'
import { getSyncedWorkspaceController } from '../src/renderer/src/features/synced-blocks/controller'
import { syncedSnapshotGuard, type SyncedGroupScope } from '../src/renderer/src/features/synced-blocks/types'
import { focusExactCanonicalSearchOccurrence } from '../src/renderer/src/features/synced-blocks/inlineFocus'

const time = '2026-10-16T00:00:00.000Z'

test('inline focus uses its actual instance root and opaque NUL child; changed guards, foreign copies and dirty W cannot steal focus', { concurrency: false }, async () => {
  const dom = new JSDOM('<main><input id="foreign"><section id="first"></section><section id="second"></section></main>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const childId = ' historical canonical\0child["opaque"] ', workspaceScope = randomUUID(), recoveryEpoch = randomUUID()
  const instance = (host: string) => ({ instanceId: randomUUID(), hostDocumentId: host, bindingVersion: randomUUID(),
    parentBlockId: null, parentType: null, depth: 0 })
  const instances = [instance('first-host'), instance('second-host')]
  let saved: SyncedGroupSnapshot = { groupId: randomUUID(), creationId: randomUUID(), createdAt: time,
    revision: randomUUID(), topologyRevision: randomUUID(),
    origin: { version: 1, documentId: 'first-host', pathAtCreation: 'Original', firstInstanceId: instances[0].instanceId },
    blocks: [{ id: childId, type: 'paragraph', content: 'same canonical body', checked: false, depth: 0, parentBlockId: null, createdAt: time }],
    bindings: [], instances, maxRelativeDepth: 0, history: { cursor: randomUUID(), undoToken: null, redoToken: null } }
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected persistence contract operation') }
  // Actual controller; the injected API is a unit boundary, not a Main/SQL oracle.
  const api: SyncedBlocksApi = {
    getSyncedGroupSnapshots: async () => ({ workspaceScope, items: [{ status: 'ready', snapshot: structuredClone(saved) }] }),
    listSyncedGroups: async () => ({ items: [], total: 0 }),
    updateSyncedBlockGroup: async input => {
      saved = { ...saved, revision: randomUUID(), blocks: input.blocks.map(block => ({ ...block, createdAt: time })) }
      return { status: 'saved', operationId: input.clientOperationId, replayed: false, snapshot: structuredClone(saved) }
    },
    getSyncedOperation: async () => ({ status: 'unknown' }), restoreSyncedGroupOperation: unexpected,
    applySyncedHostStructure: unexpected, restoreSyncedHostOperation: unexpected,
    getSyncedHostHistory: unexpected, onSyncedBlocksChanged: () => () => undefined
  }
  const workspace = getSyncedWorkspaceController(api)
  let first: ReturnType<NonNullable<ReturnType<typeof workspace.getGroup>>['bind']> | undefined
  let second: typeof first
  try {
    await workspace.load([saved.groupId])
    const group = workspace.getGroup(saved.groupId)!
    const rootA = dom.window.document.getElementById('first') as HTMLElement
    const rootB = dom.window.document.getElementById('second') as HTMLElement
    rootA.dataset.syncedInstanceId = instances[0].instanceId; rootB.dataset.syncedInstanceId = instances[1].instanceId
    const rows = [rootA, rootB].map(root => {
      const row = dom.window.document.createElement('div')
      row.dataset.blockId = childId; row.textContent = 'same canonical body'; root.append(row)
      return row
    })
    const decoyRoot = dom.window.document.createElement('section'), decoy = dom.window.document.createElement('div')
    decoyRoot.dataset.syncedInstanceId = instances[1].instanceId
    decoy.dataset.blockId = childId; decoyRoot.append(decoy); rootA.prepend(decoyRoot)
    const scrolled: HTMLElement[] = []
    for (const row of [...rows, decoy]) row.scrollIntoView = () => { scrolled.push(row) }
    let live = true
    const scope = (index: number, root: HTMLElement): SyncedGroupScope => ({ owner: { kind: 'synced-group', groupId: saved.groupId },
      ...instances[index], hostSession: {}, mountEpoch: {}, bindingEpoch: {}, windowSessionId: 'fixture-window',
      domNamespace: 'fixture-' + index, root: () => root, isCurrent: () => live })
    first = group.bind(scope(0, rootA)); second = group.bind(scope(1, rootB))
    const target: WorkspaceSearchOccurrence = { version: 1, workspaceScope, recoveryEpoch,
      hostDocumentId: instances[0].hostDocumentId, hostCreatedAt: time, instanceId: instances[0].instanceId, instanceCreatedAt: time,
      bindingVersion: instances[0].bindingVersion, parentBlockId: null, depth: 0, groupId: saved.groupId, creationId: saved.creationId,
      groupCreatedAt: saved.createdAt, revision: saved.revision, topologyRevision: saved.topologyRevision,
      canonicalBlockId: childId, canonicalCreatedAt: time }
    const foreign = dom.window.document.getElementById('foreign') as HTMLInputElement
    foreign.focus()
    assert.equal(focusExactCanonicalSearchOccurrence(rootA, first, target, () => true), true)
    assert.equal(dom.window.document.activeElement, rows[0])
    assert.deepEqual(scrolled, [rows[0]], 'the earlier same-ID decoy belongs to another instance')
    assert.equal(rows[1].tabIndex, -1)
    assert.equal(rows[0].classList.contains('block-editor-row-highlighted'), true)

    foreign.focus(); scrolled.length = 0
    assert.equal(focusExactCanonicalSearchOccurrence(rootB, first, target, () => true), false, 'a genuine binding cannot lend its root')
    assert.equal(focusExactCanonicalSearchOccurrence(rootB, second, target, () => true), false, 'the same canonical child in another real instance is not this address')
    rows[0].remove()
    assert.equal(focusExactCanonicalSearchOccurrence(rootA, first, target, () => true), false, 'another nested instance must not fill a missing own row')
    rootA.append(rows[0])
    const changed: Array<Partial<WorkspaceSearchOccurrence>> = [
      { hostDocumentId: 'other-host' }, { instanceId: randomUUID() }, { bindingVersion: randomUUID() }, { groupId: randomUUID() },
      { creationId: randomUUID() }, { groupCreatedAt: '2026-10-17T00:00:00.000Z' }, { revision: randomUUID() },
      { topologyRevision: randomUUID() }, { canonicalBlockId: childId + 'other' }, { canonicalCreatedAt: '2026-10-17T00:00:00.000Z' }
    ]
    for (const patch of changed) assert.equal(focusExactCanonicalSearchOccurrence(rootA, first, { ...target, ...patch }, () => true), false, JSON.stringify(patch))
    assert.equal(focusExactCanonicalSearchOccurrence(rootA, first, target, () => false), false)
    live = false
    assert.equal(focusExactCanonicalSearchOccurrence(rootA, first, target, () => true), false)
    live = true
    rootA.setAttribute('inert', '')
    assert.equal(focusExactCanonicalSearchOccurrence(rootA, first, target, () => true), false)
    rootA.removeAttribute('inert')
    first.setComposing(true)
    assert.equal(focusExactCanonicalSearchOccurrence(rootA, first, target, () => true), false)
    first.setComposing(false)
    const state = first.getCurrent()
    assert.equal(first.apply({ expectedEditSequence: state.editSequence, guards: syncedSnapshotGuard(state.snapshot),
      blocks: state.working.map(block => ({ ...block, content: 'unsubmitted original draft' })), bookmark: null, transactionId: randomUUID() }), true)
    assert.equal(focusExactCanonicalSearchOccurrence(rootA, first, target, () => true), false)
    assert.equal(first.getCurrent().working[0].content, 'unsubmitted original draft')
    assert.equal(dom.window.document.activeElement, foreign)
    assert.equal(scrolled.length, 0)
    assert.equal(await first.flush(), true)
  } finally {
    first?.dispose(); second?.dispose(); workspace.dispose()
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
})
