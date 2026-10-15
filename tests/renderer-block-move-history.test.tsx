import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useState, type FormEvent } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlock, DocumentBlockDraft, DocumentDetail, ElectronApi, HomeData, UpdateDocumentInput } from '../src/shared/contracts'
import type { DocumentBlockMoveHistoryEntry, DocumentBlockMoveResult, MoveDocumentBlocksInput, RestoreDocumentBlockMoveInput } from '../src/shared/document-block-moves'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { getUiText } from '../src/renderer/src/i18n'
import { waitForRenderer } from './helpers/renderer-async'

type Editor = ReturnType<typeof useDocumentEditorState>
type Transition = 'move' | 'undo' | 'redo'
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const clone = <T,>(value: T): T => structuredClone(value)
const draft = (block: DocumentBlock): DocumentBlockDraft => {
  const { sortOrder: _order, ...result } = block
  return clone(result)
}
const block = (id: string, content: string, patch: Partial<DocumentBlock> = {}): DocumentBlock => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null, sortOrder: 0, ...patch })
const detail = (id: string, blocks: DocumentBlock[]): DocumentDetail => ({ id, title: id, path: id, summary: '', updatedAt: `${id}-v1`, blocks, children: [], outgoingLinks: [], backlinks: [] })

/** A deterministic IPC peer supplies whole paired acknowledgements. Native
 * database atomicity/CAS are tested separately; these tests exercise the real
 * React hook's pending state, history pointer and hydration boundaries. */
function peer(stayContent?: string) {
  const beforeSource = detail('source', [block('move', 'Move me', { type: 'todo', tags: ['keep'], highlight: 'blue' }),
    block('child', 'Child', { type: 'todo', depth: 1, parentBlockId: 'move', sortOrder: 1 }),
    block('stay', stayContent ?? 'Stay [link](#^move)', { sortOrder: 2 })])
  const beforeTarget = detail('target', [block('original-target', 'Original target')])
  const afterSource = detail('source', [block('stay', stayContent ?? 'Stay [link](../target#^move)')])
  const afterTarget = detail('target', [block('original-target', 'Original target'),
    { ...clone(beforeSource.blocks[0]), sortOrder: 1 }, { ...clone(beforeSource.blocks[1]), sortOrder: 2 }])
  const documents = new Map([['source', clone(beforeSource)], ['target', clone(beforeTarget)]])
  const versions: Record<string, string> = { source: 'source-v1', target: 'target-v1', refs: 'refs-v1' }
  const gates = new Map<Transition, ReturnType<typeof deferred>>()
  const calls = { moves: [] as MoveDocumentBlocksInput[], undos: [] as RestoreDocumentBlockMoveInput[], redos: [] as RestoreDocumentBlockMoveInput[],
    saves: [] as Array<{ documentId: string; input: UpdateDocumentInput }>, histories: [] as string[], home: 0 }
  let state: 'applied' | 'undone' | null = null, revision = 1
  const get = (id: string) => clone(documents.get(id)!)
  const pause = async (kind: Transition) => { const gate = gates.get(kind); gates.delete(kind); if (gate) await gate.promise }
  const acknowledge = (next: 'applied' | 'undone'): DocumentBlockMoveResult => {
    state = next; revision++
    const source = clone(next === 'applied' ? afterSource : beforeSource), target = clone(next === 'applied' ? afterTarget : beforeTarget)
    for (const id of Object.keys(versions)) versions[id] = `${id}-v${revision}`
    source.updatedAt = versions.source; target.updatedAt = versions.target
    documents.set('source', source); documents.set('target', target)
    return { operationId: 'paired-operation', state: next, source: clone(source), target: clone(target), movedBlockIds: ['move', 'child'],
      affectedDocumentIds: ['source', 'target', 'refs'], expectedUpdatedAtByDocument: { ...versions } }
  }
  const restore = async (kind: 'undo' | 'redo', input: RestoreDocumentBlockMoveInput) => {
    calls[kind === 'undo' ? 'undos' : 'redos'].push(clone(input))
    await pause(kind)
    assert.equal(input.operationId, 'paired-operation')
    assert.deepEqual(input.expectedUpdatedAtByDocument, versions)
    return acknowledge(kind === 'undo' ? 'undone' : 'applied')
  }
  const api: Pick<ElectronApi, 'getDocumentDetail' | 'getDocumentBlockMoveHistory' | 'getHomeData' | 'updateDocument' | 'moveDocumentBlocks' | 'undoDocumentBlockMove' | 'redoDocumentBlockMove'> = {
    getDocumentDetail: async id => documents.has(id) ? get(id) : null,
    getHomeData: async () => { calls.home++; return {} as HomeData },
    getDocumentBlockMoveHistory: async id => {
      calls.histories.push(id)
      if (!state) return null
      const entry: DocumentBlockMoveHistoryEntry = { operationId: 'paired-operation', state,
        beforeBlocks: (id === 'source' ? beforeSource : beforeTarget).blocks.map(draft),
        afterBlocks: (id === 'source' ? afterSource : afterTarget).blocks.map(draft), expectedUpdatedAtByDocument: { ...versions } }
      return clone(entry)
    },
    updateDocument: async (documentId, input) => {
      calls.saves.push({ documentId, input: clone(input) })
      assert.equal(input.expectedUpdatedAt, versions[documentId])
      const next = get(documentId)
      next.title = input.title; next.summary = input.summary
      next.blocks = input.blocks.map((value, sortOrder) => ({ ...clone(value), id: value.id!, parentBlockId: value.parentBlockId ?? null, sortOrder }))
      next.updatedAt = `${documentId}-saved-${calls.saves.length}`; versions[documentId] = next.updatedAt
      documents.set(documentId, next)
      return { requiresFullRefresh: true, document: clone(next) }
    },
    moveDocumentBlocks: async input => {
      calls.moves.push(clone(input)); await pause('move')
      assert.deepEqual(input.blockIds, ['move'])
      assert.equal(input.expectedFromUpdatedAt, versions.source); assert.equal(input.expectedToUpdatedAt, versions.target)
      return acknowledge('applied')
    },
    undoDocumentBlockMove: input => restore('undo', input), redoDocumentBlockMove: input => restore('redo', input)
  }
  return { api, calls, get, beforeSource, beforeTarget, afterSource, afterTarget, versions,
    hold(kind: Transition) { const gate = deferred(); gates.set(kind, gate); return gate },
    setApplied() { return acknowledge('applied') } }
}

type Peer = ReturnType<typeof peer>
async function withEditor(backend: Peer, run: (api: {
  current: () => Editor; document: Document; input: (id: string) => HTMLTextAreaElement;
  restart: (documentId: string) => Promise<void>; focus: (id: string) => Promise<void>; messages: string[]
}) => Promise<void>, initialId = 'source') {
  const dom = new JSDOM('<input id="outside"><div id="mount"></div>', { pretendToBeVisual: true })
  // JSDOM has no focused browser window; this fixture represents a focused renderer.
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, requestAnimationFrame: (): number => 1,
    cancelAnimationFrame: () => {}, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  Object.defineProperty(dom.window, 'knowbook', { configurable: true, value: backend.api })
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  const messages: string[] = []
  let editor!: Editor, session = 0
  function Harness({ initial }: { initial: DocumentDetail }) {
    const [selected, setSelected] = useState(initial)
    editor = useDocumentEditorState({ selectedDocumentId: selected.id, selectedDocument: selected, ui: getUiText('en-US'),
      onSelectedDocumentChange: value => { if (value) setSelected(value) }, onHomeDataChange: () => {},
      onMessage: message => { if (message) messages.push(message) } })
    return createElement('div', { className: 'block-editor-list' }, editor.draftBlocks.map((value, index) => createElement('div',
      { key: value.id, className: 'block-editor-row', 'data-block-id': value.id, 'data-block-index': index }, createElement('textarea',
        { className: 'block-inline-textarea', value: value.content, onChange: () => {},
          onInput: (event: FormEvent<HTMLTextAreaElement>) => editor.updateDraftBlock(index, { content: event.currentTarget.value }) }))))
  }
  const restart = async (documentId: string) => {
    const initial = backend.get(documentId)
    await act(async () => { root.render(createElement(Harness, { key: ++session, initial })) })
    await act(async () => editor.loadDocumentIntoEditor(initial))
    await waitForRenderer(() => editor.isEditing && editor.draftTitle === initial.title, 'The restarted editor must hydrate its document')
  }
  const input = (id: string) => dom.window.document.querySelector<HTMLTextAreaElement>(`[data-block-id="${id}"] textarea`)!
  try {
    await restart(initialId)
    await run({ current: () => editor, document: dom.window.document, input, restart, messages,
      focus: async id => { await act(async () => { input(id).focus(); input(id).setSelectionRange(2, 5, 'backward') }) } })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) }
  }
}
const ids = (editor: Editor) => editor.draftBlocks.map(value => value.id)

test('moving a source subtree waits for whole-pair IPC and undo/redo never replay local blocks ahead of acknowledgement', async () => {
  const backend = peer()
  await withEditor(backend, async api => {
    await api.focus('move')
    const target = api.current().getBlockActionTarget(['move'])!
    const move = backend.hold('move')
    let result!: Promise<boolean>
    await act(async () => { result = api.current().moveDraftBlocksToDocument(target, 'target') })
    await waitForRenderer(() => backend.calls.moves.length === 1, 'The move IPC must start')
    assert.deepEqual(ids(api.current()), ['move', 'child', 'stay'])
    assert.equal(api.current().isBlockMoveBusy, true); assert.equal(api.current().canUndo, false)
    await act(async () => { assert.equal(await api.current().moveDraftBlocksToDocument(target, 'target'), false); api.current().undoEdit(); api.current().redoEdit(); api.current().updateDraftBlock(0, { content: 'must not race' }) })
    assert.equal(backend.calls.moves.length, 1); assert.equal(backend.calls.undos.length, 0); assert.equal(backend.calls.redos.length, 0)
    assert.equal(api.current().draftBlocks[0].content, 'Move me')
    await act(async () => { move.resolve(); assert.equal(await result, true) })
    assert.deepEqual(ids(api.current()), ['stay']); assert.equal(api.current().canUndo, true)
    assert.equal(backend.calls.saves.length, 0)
    const undo = backend.hold('undo')
    await act(async () => api.current().undoEdit())
    await waitForRenderer(() => backend.calls.undos.length === 1, 'Undo must call paired IPC')
    assert.deepEqual(ids(api.current()), ['stay']); assert.equal(api.current().isBlockMoveBusy, true)
    assert.deepEqual(backend.calls.undos[0].expectedUpdatedAtByDocument, { source: 'source-v2', target: 'target-v2', refs: 'refs-v2' })
    await act(async () => undo.resolve())
    await waitForRenderer(() => !api.current().isBlockMoveBusy && ids(api.current()).length === 3, 'Undo acknowledgement restores the source')
    assert.deepEqual(ids(api.current()), ['move', 'child', 'stay']); assert.equal(api.current().canRedo, true)
    assert.equal(api.input('move').selectionDirection, 'backward')
    assert.equal(api.current().draftBlocks[1].parentBlockId, 'move')
    const redo = backend.hold('redo')
    await act(async () => api.current().redoEdit())
    await waitForRenderer(() => backend.calls.redos.length === 1, 'Redo must call paired IPC')
    assert.deepEqual(ids(api.current()), ['move', 'child', 'stay'])
    assert.deepEqual(backend.calls.redos[0].expectedUpdatedAtByDocument, { source: 'source-v3', target: 'target-v3', refs: 'refs-v3' })
    await act(async () => redo.resolve())
    await waitForRenderer(() => !api.current().isBlockMoveBusy && ids(api.current()).length === 1, 'Redo acknowledgement removes moved blocks from the source')
    assert.deepEqual(ids(api.current()), ['stay']); assert.equal(api.current().canRedo, false)
    assert.deepEqual(backend.get('target').blocks.map(value => value.id), ['original-target', 'move', 'child'])
    assert.equal(backend.calls.saves.length, 0)
  })
})

test('CAS rejection preserves move history, draft and retry direction for both undo and redo', async () => {
  const backend = peer(); backend.setApplied()
  await withEditor(backend, async api => {
    await waitForRenderer(() => api.current().canUndo, 'Persisted paired undo must hydrate')
    const applied = clone(api.current().draftBlocks), rejectedUndo = backend.hold('undo')
    await act(async () => api.current().undoEdit())
    await waitForRenderer(() => backend.calls.undos.length === 1, 'The held undo request must start')
    await act(async () => rejectedUndo.reject(new Error('CAS: target changed')))
    await waitForRenderer(() => !api.current().isBlockMoveBusy, 'Rejected undo must release the busy lock')
    assert.deepEqual(api.current().draftBlocks, applied); assert.equal(api.current().canUndo, true); assert.equal(api.current().canRedo, false)
    assert.ok(api.messages.some(message => message.includes('CAS: target changed')))
    await act(async () => api.current().undoEdit())
    await waitForRenderer(() => !api.current().isBlockMoveBusy && api.current().canRedo, 'A second undo must retry the same paired operation')
    assert.equal(backend.calls.undos.length, 2)
    const undone = clone(api.current().draftBlocks), rejectedRedo = backend.hold('redo')
    await act(async () => api.current().redoEdit())
    await waitForRenderer(() => backend.calls.redos.length === 1, 'The held redo request must start')
    await act(async () => rejectedRedo.reject(new Error('CAS: reference document changed')))
    await waitForRenderer(() => !api.current().isBlockMoveBusy, 'Rejected redo must release the busy lock')
    assert.deepEqual(api.current().draftBlocks, undone); assert.equal(api.current().canUndo, false); assert.equal(api.current().canRedo, true)
    await act(async () => api.current().redoEdit())
    await waitForRenderer(() => !api.current().isBlockMoveBusy && api.current().canUndo, 'A second redo must retry the same paired operation')
    assert.equal(backend.calls.redos.length, 2); assert.deepEqual(ids(api.current()), ['stay'])
    assert.equal(backend.calls.saves.length, 0)
  })
})

test('fresh source and target editor sessions hydrate the persisted pair and can undo/redo from either document', async () => {
  const backend = peer(); backend.setApplied()
  await withEditor(backend, async api => {
    await waitForRenderer(() => api.current().canUndo, 'Source restart must expose paired undo')
    await api.restart('target')
    await waitForRenderer(() => api.current().canUndo, 'Target restart must expose paired undo')
    assert.deepEqual(ids(api.current()), ['original-target', 'move', 'child'])
    await act(async () => api.current().undoEdit())
    await waitForRenderer(() => !api.current().isBlockMoveBusy && api.current().canRedo, 'Target undo must restore both documents')
    assert.deepEqual(ids(api.current()), ['original-target']); assert.deepEqual(backend.get('source').blocks.map(value => value.id), ['move', 'child', 'stay'])
    await api.restart('source')
    await waitForRenderer(() => api.current().canRedo, 'Source restart after paired undo must expose redo')
    assert.deepEqual(ids(api.current()), ['move', 'child', 'stay'])
    await act(async () => api.current().redoEdit())
    await waitForRenderer(() => !api.current().isBlockMoveBusy && api.current().canUndo, 'Source redo must restore the applied pair')
    await api.restart('target')
    await waitForRenderer(() => api.current().canUndo, 'Target restart after redo must again expose undo')
    assert.deepEqual(ids(api.current()), ['original-target', 'move', 'child'])
    assert.equal(backend.calls.undos.length, 1); assert.equal(backend.calls.redos.length, 1)
  })
})

test('a delayed paired-history acknowledgement cannot replace a newer local draft or its undo scope', async () => {
  const backend = peer(); backend.setApplied()
  const read = backend.api.getDocumentBlockMoveHistory, gate = deferred()
  backend.api.getDocumentBlockMoveHistory = async id => { const entry = await read(id); await gate.promise; return entry }
  await withEditor(backend, async api => {
    await act(async () => {
      api.current().updateDraftBlock(0, { content: 'Typed while the paired history was loading' })
      api.current().checkpointDraft()
      gate.resolve()
    })
    assert.equal(api.current().draftBlocks[0].content, 'Typed while the paired history was loading')
    await act(async () => api.current().undoEdit())
    assert.deepEqual(ids(api.current()), ['stay'])
    assert.equal(api.current().draftBlocks[0].content, backend.afterSource.blocks[0].content)
    assert.equal(api.current().canUndo, false)
    assert.equal(backend.calls.undos.length, 0)
  })
})

test('a committed move refreshes the workspace without writing its acknowledgement into a replacement editor session', async () => {
  const backend = peer()
  await withEditor(backend, async api => {
    const gate = backend.hold('move')
    let moved!: Promise<boolean>
    await act(async () => { moved = api.current().moveDraftBlocksToDocument(api.current().getBlockActionTarget(['move'])!, 'target') })
    await waitForRenderer(() => backend.calls.moves.length === 1, 'The held move must reach IPC')
    await api.restart('target')
    await act(async () => { gate.resolve(); assert.equal(await moved, false) })
    assert.deepEqual(ids(api.current()), ['original-target'])
    assert.equal(api.current().draftTitle, 'target')
    assert.equal(api.current().canUndo, false)
    assert.equal(backend.calls.home, 1)
    assert.deepEqual(backend.get('target').blocks.map(value => value.id), ['original-target', 'move', 'child'])
  })
})

test('IME composition blocks stale-target moves and paired history replay without mutating either document', async () => {
  const backend = peer()
  await withEditor(backend, async api => {
    await api.focus('move')
    const target = api.current().getBlockActionTarget(['move'])!
    await act(async () => api.input('move').dispatchEvent(new api.document.defaultView!.CompositionEvent('compositionstart', { bubbles: true })))
    assert.equal(api.current().getBlockActionTarget(['move']), null)
    await act(async () => assert.equal(await api.current().moveDraftBlocksToDocument(target, 'target'), false))
    assert.equal(backend.calls.moves.length, 0); assert.deepEqual(ids(api.current()), ['move', 'child', 'stay'])
    await act(async () => api.input('move').dispatchEvent(new api.document.defaultView!.CompositionEvent('compositionend', { bubbles: true })))
    await act(async () => assert.equal(await api.current().moveDraftBlocksToDocument(api.current().getBlockActionTarget(['move'])!, 'target'), true))
    await api.focus('stay')
    const before = clone(api.current().draftBlocks)
    await act(async () => api.input('stay').dispatchEvent(new api.document.defaultView!.CompositionEvent('compositionstart', { bubbles: true })))
    await act(async () => { api.current().undoEdit(); api.current().redoEdit() })
    assert.equal(backend.calls.undos.length, 0); assert.equal(backend.calls.redos.length, 0)
    assert.deepEqual(api.current().draftBlocks, before)
    await act(async () => api.input('stay').dispatchEvent(new api.document.defaultView!.CompositionEvent('compositionend', { bubbles: true })))
    await act(async () => api.current().undoEdit())
    await waitForRenderer(() => !api.current().isBlockMoveBusy && ids(api.current()).length === 3, 'History must resume after composition ends')
    assert.equal(backend.calls.undos.length, 1)
  })
})

for (const transition of ['undo', 'redo'] as const) {
  for (const interruption of ['window-blur-return', 'foreign-focus-return'] as const) {
    test(`held paired ${transition} restores data without reclaiming focus or selection after ${interruption}`, async () => {
      // Keep the focused textarea's content unchanged across the pair. Updating
      // a textarea value itself resets its native selection independently of focus restoration.
      const backend = peer('Stable focus target')
      await withEditor(backend, async api => {
        await api.focus('move')
        await act(async () => assert.equal(await api.current().moveDraftBlocksToDocument(api.current().getBlockActionTarget(['move'])!, 'target'), true))
        if (transition === 'redo') {
          await api.focus('stay')
          await act(async () => api.current().undoEdit())
          await waitForRenderer(() => !api.current().isBlockMoveBusy && api.current().canRedo, 'Prepare the undone pair for a held redo')
        }
        await api.focus('stay')
        const active = api.input('stay')
        await act(async () => active.setSelectionRange(1, 4, 'forward'))
        const gate = backend.hold(transition)
        await act(async () => transition === 'undo' ? api.current().undoEdit() : api.current().redoEdit())
        const calls = transition === 'undo' ? backend.calls.undos : backend.calls.redos
        await waitForRenderer(() => calls.length === 1, `The paired ${transition} must wait for its held acknowledgement`)
        assert.equal(api.current().isBlockMoveBusy, true)
        const pendingIds = transition === 'undo' ? ['stay'] : ['move', 'child', 'stay']
        assert.deepEqual(ids(api.current()), pendingIds)
        const owner = api.document.defaultView!
        await act(async () => {
          if (interruption === 'window-blur-return') {
            owner.dispatchEvent(new owner.Event('blur'))
            owner.dispatchEvent(new owner.Event('focus'))
          } else {
            const outside = api.document.getElementById('outside') as HTMLInputElement
            outside.focus()
            active.focus()
          }
          active.setSelectionRange(1, 4, 'forward')
        })
        assert.equal(api.document.activeElement, active)
        assert.equal(api.document.hasFocus(), true, 'Returning to the renderer must not renew the old gesture permission')
        await act(async () => gate.resolve())
        const restoredIds = transition === 'undo' ? ['move', 'child', 'stay'] : ['stay']
        await waitForRenderer(() => !api.current().isBlockMoveBusy && ids(api.current()).length === restoredIds.length, `The held ${transition} must still restore its complete paired data`)
        assert.deepEqual(ids(api.current()), restoredIds)
        assert.deepEqual(backend.get('source').blocks.map(value => value.id), restoredIds)
        assert.deepEqual(backend.get('target').blocks.map(value => value.id), transition === 'undo' ? ['original-target'] : ['original-target', 'move', 'child'])
        assert.equal(api.current().canUndo, transition === 'redo')
        assert.equal(api.current().canRedo, transition === 'undo')
        assert.equal(api.document.activeElement, active, 'Paired acknowledgement must not focus the historical block')
        assert.equal(api.input('stay'), active)
        assert.deepEqual([active.selectionStart, active.selectionEnd, active.selectionDirection], [1, 4, 'forward'])
        assert.equal(backend.calls.saves.length, 0)
      })
    })
  }
}
