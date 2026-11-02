import assert from 'node:assert/strict'
import test from 'node:test'
import { restoreDocumentHostHistory, type DocumentHostHistoryContext } from '../src/renderer/src/utils/documentHostHistory'
import { installCanonicalInlineTransitions } from '../src/renderer/src/features/synced-blocks/inlineBridge'
import type { SyncedHostSourceCurrent } from '../src/renderer/src/features/synced-blocks/SyncedHostSourceDialog'

// Unit-only local timeline/loader guards. The registered thin port counts
// requests and returns false; it does not manufacture any Main ACK/permission.
function opening() {
  const draft = [{ id: 'ordinary', type: 'paragraph', content: 'same W', checked: false, depth: 0, parentBlockId: null }]
  const transition = Object.freeze({ documentId: 'host', operationId: 'original-op', historyToken: 'original-history' })
  const history = [{ blocks: structuredClone(draft), bookmark: null }, { blocks: draft, bookmark: null, hostStructure: transition }]
  const before: SyncedHostSourceCurrent = { hostSession: Object.freeze({}), editSequence: 4,
    host: { documentId: 'host', expectedPersistedUpdatedAt: '2026-11-02T00:00:00.000Z',
      workingBefore: { title: 'Original host', summary: '', blocks: draft } } }
  const owner = Object.freeze({}), counts = { disposed: 0, changed: 0, requests: 0, replacementFocusDisposed: 0 }
  const refs: DocumentHostHistoryContext['refs'] = [{ current: history }, { current: 1 }, { current: 7 }, { current: draft },
    { current: null }, { current: draft }, { current: null }, { current: null }, { current: true }, { current: owner },
    { current: true }, { current: true }]
  const context: DocumentHostHistoryContext = { opening: [transition, 'undo', history, 1, 7, owner, before, draft], refs,
    current: () => before, focus: { canRestore: () => true, dispose: () => { counts.disposed++ } },
    changed: () => { counts.changed++ } }
  const replacementFocus = { dispose: () => { counts.replacementFocusDisposed++ } }
  return { context, counts, replacementFocus }
}

function install(counts: { requests: number }, reply: () => Promise<boolean> = async () => false) {
  return installCanonicalInlineTransitions(Object.freeze({}), { flush: async () => true, pending: () => false,
    hostPending: () => false, navigate: async () => true, notifyBlocked: () => {}, locked: () => false,
    restoreHistory: async () => { counts.requests++; return reply() } })
}

test('cold host inverse rejects equal-text replacement W before any registered restore request', { concurrency: false }, async () => {
  const value = opening(), stop = install(value.counts), refs = value.context.refs
  try {
    refs[3].current = structuredClone(refs[3].current) // new actual array, exactly equal bytes
    assert.deepEqual(refs[3].current, value.context.opening[7])
    assert.notEqual(refs[3].current, value.context.opening[7])
    assert.equal(await restoreDocumentHostHistory(value.context), false)
    assert.equal(value.counts.requests, 0); assert.equal(refs[1].current, 1)
    assert.equal(value.counts.disposed, 1); assert.equal(refs[8].current, false)
    assert.equal(refs[9].current, null); assert.equal(refs[10].current, false)
  } finally { stop() }
})

test('stale cold session or owner releases only its original focus, including replacement while the thin port is pending',
  { concurrency: false }, async () => {
    for (const replace of ['session', 'owner'] as const) {
      const value = opening(), stop = install(value.counts), refs = value.context.refs, newOwner = Object.freeze({ replacement: true })
      try {
        if (replace === 'session') refs[2].current++
        else refs[9].current = newOwner
        const expectedOwner = refs[9].current
        assert.equal(await restoreDocumentHostHistory(value.context), false)
        assert.equal(value.counts.requests, 0); assert.equal(value.counts.disposed, 1)
        assert.equal(refs[8].current, true); assert.equal(refs[10].current, true)
        assert.equal(refs[9].current, expectedOwner); assert.equal(value.counts.changed, 0)
        assert.equal(value.counts.replacementFocusDisposed, 0)
      } finally { stop() }
    }
    const value = opening(), refs = value.context.refs, newOwner = Object.freeze({ replacement: true })
    let release!: (result: boolean) => void
    const stop = install(value.counts, () => new Promise<boolean>(resolve => { release = resolve }))
    try {
      const result = restoreDocumentHostHistory(value.context)
      assert.equal(value.counts.requests, 1)
      refs[9].current = newOwner; refs[2].current++
      release(false)
      assert.equal(await result, false); assert.equal(value.counts.disposed, 1)
      assert.equal(refs[9].current, newOwner); assert.equal(refs[8].current, true)
      assert.equal(refs[10].current, true); assert.equal(refs[1].current, 1)
      assert.equal(value.counts.changed, 0); assert.equal(value.counts.replacementFocusDisposed, 0)
    } finally { stop() }
  })
