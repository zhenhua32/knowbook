import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { EditorState } from '@codemirror/state'
import { markdownEngine } from '../src/shared/markdownEngine'
import type { SyncedBindingKey, SyncedBlocksApi, SyncedBlocksChangedEvent, SyncedCanonicalEdit, SyncedGroupMutationResult,
  SyncedGroupSaved, SyncedGroupSnapshot, SyncedRestoreGroupInput, SyncedUpdateGroupInput } from '../src/shared/synced-blocks'
import { applySyncedGroupWithEndpoint, getSyncedWorkspaceController, readSyncedCommittedEndpoint } from '../src/renderer/src/features/synced-blocks/controller'
import { openSyncedSourceCheckpoint, prepareSourceCheckpoint, readPreparedSourceCheckpoint, applyPreparedSourceCheckpoint,
  readAcceptedSourceCheckpoint, createCanonicalSourceLedgerSession, forkCanonicalSourceLedger,
  type SourceLedgerDraft, type SourceCheckpoint, type PreparedSourceCheckpoint } from '../src/renderer/src/features/synced-blocks/sourceLedger'
import { allocateCanonicalSourceDraft, createCanonicalSourceAllocationBasis } from '../src/renderer/src/features/synced-blocks/sourceManifest'
import { canonicalSourceDraftToBlocksWithManifest } from '../src/renderer/src/features/synced-blocks/sourceManifest'
import { markdownSourceEditorText } from '../src/renderer/src/utils/markdownSourceSession'
import { syncedSnapshotGuard, type SyncedGroupBinding, type SyncedGroupScope } from '../src/renderer/src/features/synced-blocks/types'

const time = '2026-10-16T00:00:00.000Z'
const block = (id: string, content: string): SyncedCanonicalEdit => ({ id, content, type: 'paragraph', depth: 0,
  parentBlockId: null, checked: false, tags: ['保留'], highlight: 'yellow' })
const keyId = (key: SyncedBindingKey) => JSON.stringify([key.blockId, key.from, key.to, key.raw, key.syntax])
function snapshot(): SyncedGroupSnapshot {
  const instance = { instanceId: randomUUID(), hostDocumentId: 'host', bindingVersion: randomUUID(), depth: 0,
    parentBlockId: null, parentType: null }
  return { groupId: randomUUID(), creationId: randomUUID(), createdAt: time, revision: randomUUID(), topologyRevision: randomUUID(),
    blocks: [{ ...block(' __proto__:原文 ', '[A](Target.md)'), createdAt: time }],
    bindings: [{ blockId: ' __proto__:原文 ', from: 4, to: 13, raw: 'Target.md', syntax: 'markdown',
      target: { kind: 'document', id: 'original-target', state: 'live' } }],
    origin: { version: 1, documentId: 'origin', pathAtCreation: 'Folder/Host', firstInstanceId: instance.instanceId },
    instances: [instance], maxRelativeDepth: 0, history: { cursor: randomUUID(), undoToken: null, redoToken: null } }
}
/** Actual registered controller/CM state, injected Main contract only. These
 * tests do not claim production IPC, SQLite, dialogs or editor UI coverage. */
class Api implements SyncedBlocksApi {
  readonly updates: SyncedUpdateGroupInput[] = []
  readonly operations = new Map<string, SyncedGroupSaved>()
  readonly listeners = new Set<(event: SyncedBlocksChangedEvent) => void>()
  update: (input: SyncedUpdateGroupInput) => Promise<SyncedGroupMutationResult> = async input => this.saved(input)
  constructor(public current = snapshot()) {}
  async getSyncedGroupSnapshots() { return { workspaceScope: 'workspace', items: [{ status: 'ready' as const, snapshot: structuredClone(this.current) }] } }
  async listSyncedGroups() { return { items: [], total: 0 } }
  async updateSyncedBlockGroup(input: SyncedUpdateGroupInput) { this.updates.push(structuredClone(input)); return this.update(input) }
  async getSyncedOperation({ clientOperationId }: { clientOperationId: string }) {
    const found = this.operations.get(clientOperationId)
    return found ? { status: 'committed' as const, result: { ...structuredClone(found), replayed: true } } : { status: 'unknown' as const }
  }
  async applySyncedHostStructure(): ReturnType<SyncedBlocksApi['applySyncedHostStructure']> { throw new Error('Unexpected host write') }
  async restoreSyncedGroupOperation(_input: SyncedRestoreGroupInput): ReturnType<SyncedBlocksApi['restoreSyncedGroupOperation']> { throw new Error('Unexpected history') }
  async restoreSyncedHostOperation(): ReturnType<SyncedBlocksApi['restoreSyncedHostOperation']> { throw new Error('Unexpected host history') }
  async getSyncedHostHistory() { return { cursor: 'cursor', undoToken: null, redoToken: null } }
  onSyncedBlocksChanged(listener: (event: SyncedBlocksChangedEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  saved(input: SyncedUpdateGroupInput): SyncedGroupSaved {
    assert.equal(input.expectedRevision, this.current.revision)
    const prior = this.current
    const bindings = input.bindingClaims?.map(claim => {
      assert.notEqual(claim.kind, 'copy')
      const source = claim.kind === 'continue' ? prior.bindings.find(value => keyId(value) === keyId(claim.source)) : null
      if (claim.kind === 'continue') assert.ok(source)
      return { ...claim.destination, target: source?.target ?? { kind: 'document' as const, id: 'new-target', state: 'live' as const } }
    }) ?? prior.bindings
    this.current = { ...prior, revision: randomUUID(), bindings,
      blocks: input.blocks.map(value => ({ ...value, createdAt: prior.blocks.find(old => old.id === value.id)?.createdAt ?? time })),
      history: { cursor: randomUUID(), undoToken: randomUUID(), redoToken: null } }
    const ack: SyncedGroupSaved = { status: 'saved', operationId: input.clientOperationId, snapshot: structuredClone(this.current), replayed: false }
    this.operations.set(input.clientOperationId, structuredClone(ack))
    return ack
  }
}
function scope(value: SyncedGroupSnapshot): SyncedGroupScope {
  return { owner: { kind: 'synced-group', groupId: value.groupId }, ...value.instances[0], hostSession: {}, mountEpoch: {}, bindingEpoch: {},
    windowSessionId: 'window', domNamespace: 'source', root: () => null, isCurrent: () => true }
}
async function setup() {
  const api = new Api(), workspace = getSyncedWorkspaceController(api)
  await workspace.load([api.current.groupId])
  const controller = workspace.getGroup(api.current.groupId)!, owner = scope(api.current), binding = controller.bind(owner)
  const opened = openSyncedSourceCheckpoint(binding)
  assert.ok(opened)
  const session = createCanonicalSourceLedgerSession({ draft: opened.draft })
  let state = EditorState.create({ doc: markdownSourceEditorText(opened.draft.source), extensions: session.extension })
  const edit = (from: number, to: number, insert: string) => {
    state = state.update({ changes: { from, to, insert } }).state
    return session.read(state)
  }
  const replay = (draft: SourceLedgerDraft) => {
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: markdownSourceEditorText(draft.source) },
      annotations: session.replay.of(draft) }).state
    return session.read(state)
  }
  return { api, workspace, controller, owner, binding, ...opened, edit, replay, current: () => session.read(state) }
}
function prepare(checkpoint: SourceCheckpoint, draft: SourceLedgerDraft, freshId?: () => string): PreparedSourceCheckpoint {
  const result = prepareSourceCheckpoint({ checkpoint, draft, ...(freshId ? { freshId } : {}) })
  assert.equal(result.status, 'prepared'); assert.ok(result.status === 'prepared')
  return result.preparation
}
function accept(preparation: PreparedSourceCheckpoint, transactionId = randomUUID()) {
  const result = applyPreparedSourceCheckpoint({ preparation, transactionId })
  assert.equal(result.status, 'accepted'); assert.ok(result.status === 'accepted')
  return { result, accepted: result.accepted, facts: readAcceptedSourceCheckpoint(result.accepted)! }
}
function outside(binding: SyncedGroupBinding, content: string) {
  const before = binding.getCurrent()
  return applySyncedGroupWithEndpoint(binding, { expectedEditSequence: before.editSequence, guards: syncedSnapshotGuard(before.snapshot),
    blocks: [block(before.working[0].id, content)], transactionId: randomUUID(), bookmark: null, bindingClaims: [] })
}
const noBirth = () => { throw new Error('A surviving allocated block must retain its first ID') }

test('checkpoint opening requires the original registered binding and does not call public methods', async () => {
  const value = await setup()
  assert.equal(openSyncedSourceCheckpoint({ ...value.binding }), null)
  const original = value.binding.getCurrent
  value.binding.getCurrent = () => { throw new Error('Public getter is not authority') }
  value.binding.isCurrent = () => { throw new Error('Public callback is not authority') }
  value.binding.flush = () => { throw new Error('Opening must not flush') }
  assert.ok(openSyncedSourceCheckpoint(value.binding))
  assert.equal(value.api.updates.length, 0)
  value.binding.getCurrent = original
})

test('dirty working content can open directly without persistence or flushing', async () => {
  const value = await setup()
  assert.ok(outside(value.binding, 'local dirty').accepted)
  const opened = openSyncedSourceCheckpoint(value.binding)
  assert.ok(opened); assert.equal(opened.draft.source, 'local dirty')
  assert.equal(value.api.updates.length, 0); assert.equal(value.binding.getCurrent().dirty, true)
})

test('unchanged exact blocks and identity claims produce a strict noop', async () => {
  const value = await setup()
  assert.equal(prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: value.draft }).status, 'noop')
  assert.equal(value.binding.getCurrent().editSequence, 0); assert.equal(value.api.updates.length, 0)
})

test('same-text whole-use replacement retains new binding intent and is not a noop', async () => {
  const value = await setup(), changed = value.edit(0, value.draft.source.length, value.draft.source)
  const preparation = prepare(value.checkpoint, changed), facts = readPreparedSourceCheckpoint(preparation)
  assert.equal(facts.bindingClaims[0].kind, 'new')
  accept(preparation); assert.equal(value.binding.getCurrent().editSequence, 1)
})

test('two actual CM descendants preserve one allocated block ID and continue the exact accepted keys', async () => {
  const value = await setup(), bornId = randomUUID()
  let allocations = 0
  const first = value.edit(0, 0, '前缀 ')
  const candidate = value.edit(first.source.length, first.source.length, '\n\n[B](Target.md)')
  const preparation = prepare(value.checkpoint, candidate, () => { allocations++; return bornId })
  const facts = readPreparedSourceCheckpoint(preparation), firstAccepted = accept(preparation)
  assert.equal(allocations, 1); assert.equal(facts.blocks[1].id, bornId)
  assert.deepEqual(facts.bindingClaims.map(claim => claim.kind), ['continue', 'new'])
  const descendant = value.edit(candidate.source.length, candidate.source.length, ' 后续')
  const second = prepare(value.checkpoint, descendant, noBirth), secondFacts = readPreparedSourceCheckpoint(second)
  assert.equal(secondFacts.blocks[1].id, bornId)
  assert.deepEqual(secondFacts.bindingClaims.map(claim => claim.kind), ['continue', 'continue'])
  assert.deepEqual(secondFacts.bindingClaims.map(claim => claim.kind === 'continue' && claim.source), facts.bindingClaims.map(claim => claim.destination))
  const secondAccepted = accept(second)
  assert.notEqual(secondAccepted.facts.endpoint, firstAccepted.facts.endpoint)
  assert.equal(value.api.updates.length, 0)
})

test('single staged preparation is idempotent and rejects a different staged draft', async () => {
  const value = await setup(), candidate = value.edit(0, 0, 'prefix '), preparation = prepare(value.checkpoint, candidate)
  assert.equal(prepare(value.checkpoint, candidate, noBirth), preparation)
  const other = value.edit(candidate.source.length, candidate.source.length, '!')
  assert.equal(prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: other }).status, 'unavailable')
  accept(preparation)
  assert.ok(prepare(value.checkpoint, other, noBirth))
})

test('accepted result retries retain the original endpoint even after another accepted draft', async () => {
  const value = await setup(), first = value.edit(0, 0, 'prefix '), preparation = prepare(value.checkpoint, first)
  const original = accept(preparation)
  const second = value.edit(first.source.length, first.source.length, '!')
  accept(prepare(value.checkpoint, second, noBirth))
  assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'different retry id' }), original.result)
  assert.equal(readAcceptedSourceCheckpoint(original.accepted)!.endpoint, original.facts.endpoint)
})

test('a removed opening token requires explicit history provenance when its actual CM side returns', async () => {
  const value = await setup(), removed = value.edit(0, value.draft.source.length, 'plain')
  accept(prepare(value.checkpoint, removed))
  assert.equal(value.replay(value.draft), value.draft)
  assert.equal(prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: value.draft }).status, 'needs-history-source')
})

test('a previously accepted birth cannot become new again after deletion and CM replay', async () => {
  const value = await setup(), born = value.edit(value.draft.source.length, value.draft.source.length, '\n\n[B](Other.md)')
  accept(prepare(value.checkpoint, born, () => randomUUID()))
  const removed = value.edit(born.source.indexOf('\n\n'), born.source.length, '')
  accept(prepare(value.checkpoint, removed, noBirth))
  value.replay(born)
  assert.equal(prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: born }).status, 'needs-history-source')
})

test('separate Source opening and forged checkpoint handles cannot donate candidates or preparations', async () => {
  const value = await setup(), other = openSyncedSourceCheckpoint(value.binding)!
  const candidate = forkCanonicalSourceLedger(other.draft, [{ from: 0, to: 0, insert: 'foreign ' }])
  assert.equal(prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: candidate }).status, 'unavailable')
  assert.equal(prepareSourceCheckpoint({ checkpoint: { ...value.checkpoint }, draft: value.draft }).status, 'unavailable')
  assert.equal(applyPreparedSourceCheckpoint({ preparation: { kind: 'prepared-source-checkpoint' }, transactionId: 'fake' }).status, 'unavailable')
  assert.equal(readAcceptedSourceCheckpoint({ kind: 'accepted-source-checkpoint' }), null)
})

test('working changes outside the Source checkpoint invalidate prepare and previously staged apply', async () => {
  const value = await setup(), candidate = value.edit(0, 0, 'source '), preparation = prepare(value.checkpoint, candidate)
  assert.ok(outside(value.binding, 'other accepted edit').accepted)
  assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'stale' }).status, 'unavailable')
  assert.equal(prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: candidate }).status, 'unavailable')
})

test('dispose prevents both new openings and staged acceptance', async () => {
  const value = await setup(), preparation = prepare(value.checkpoint, value.edit(0, 0, 'source '))
  value.binding.dispose()
  assert.equal(openSyncedSourceCheckpoint(value.binding), null)
  assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'disposed' }).status, 'unavailable')
})

test('scope callback disposal cannot resurrect a mount during opening', async () => {
  const value = await setup()
  value.owner.isCurrent = () => { value.binding.dispose(); return true }
  assert.equal(openSyncedSourceCheckpoint(value.binding), null)
})

test('scope callback replacement cannot report the old registered mount as live', async () => {
  const value = await setup()
  let replaced = false
  value.owner.isCurrent = () => {
    if (!replaced) { replaced = true; value.controller.bind({ ...value.owner, isCurrent: () => true }) }
    return true
  }
  assert.equal(openSyncedSourceCheckpoint(value.binding), null)
})

test('preparing rejects freshId reentry without advancing a staged side', async () => {
  const value = await setup(), candidate = value.edit(value.draft.source.length, value.draft.source.length, '\n\nNew')
  let reentered = false
  const preparation = prepare(value.checkpoint, candidate, () => {
    reentered = true
    assert.equal(prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: candidate }).status, 'unavailable')
    return randomUUID()
  })
  assert.equal(reentered, true); accept(preparation)
})

test('applying rejects synchronous subscriber reentry and returns its original accepted endpoint', async () => {
  const value = await setup(), preparation = prepare(value.checkpoint, value.edit(0, 0, 'source '))
  let count = 0
  const unsubscribe = value.binding.subscribe(() => {
    if (++count === 1) {
      assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'nested' }).status, 'unavailable')
      assert.equal(prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: value.current() }).status, 'unavailable')
      assert.ok(outside(value.binding, 'subscriber later edit').accepted)
    }
  })
  const accepted = accept(preparation)
  unsubscribe()
  assert.equal(accepted.facts.draft.source.startsWith('source '), true)
  assert.equal(value.binding.getCurrent().working[0].content, 'subscriber later edit')
  assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'retry' }), accepted.result)
})

test('an allocator failure stays memoized and cannot mint replacements on retry', async () => {
  const value = await setup(), candidate = value.edit(value.draft.source.length, value.draft.source.length, '\n\nNew'), failure = new Error('allocation failed')
  assert.throws(() => prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: candidate, freshId: () => { throw failure } }), error => error === failure)
  assert.throws(() => prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: candidate, freshId: noBirth }), error => error === failure)
  assert.equal(value.binding.getCurrent().editSequence, 0)
})

test('successful allocation remains fixed when an endpoint changes during freshId', async () => {
  const value = await setup(), candidate = value.edit(value.draft.source.length, value.draft.source.length, '\n\nNew')
  let count = 0
  const result = prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: candidate, freshId: () => {
    count++; outside(value.binding, 'different working side'); return randomUUID()
  } })
  assert.equal(result.status, 'unavailable'); assert.equal(count, 1)
  assert.equal(prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: candidate, freshId: noBirth }).status, 'unavailable')
})

test('accepted allocation and receipt remain immutable and reader memo keeps an observed original ACK', async () => {
  const value = await setup(), accepted = accept(prepare(value.checkpoint, value.edit(0, 0, 'source ')))
  assert.equal(accepted.facts.committed, null)
  assert.equal(await value.binding.flush(), true)
  const committed = readAcceptedSourceCheckpoint(accepted.accepted)!
  assert.ok(committed.committed)
  const ack = readSyncedCommittedEndpoint(committed.committed)!
  assert.equal(ack.ack.operationId, value.api.updates[0].clientOperationId)
  value.binding.dispose()
  assert.equal(readAcceptedSourceCheckpoint(accepted.accepted), committed)
  assert.equal(Object.isFrozen(committed), true)
  assert.equal(committed.draftReceipt, accepted.facts.draftReceipt)
})

test('disposed late first read retains local acceptance without inventing an unseen committed ACK', async () => {
  const value = await setup(), accepted = accept(prepare(value.checkpoint, value.edit(0, 0, 'source ')))
  assert.equal(await value.binding.flush(), true)
  value.binding.dispose()
  const late = readAcceptedSourceCheckpoint(accepted.accepted)!
  assert.equal(late.endpoint, accepted.facts.endpoint); assert.equal(late.committed, null)
})

test('after original ACK the next Source prepare refreshes the real revision guard without a flush of its own', async () => {
  const value = await setup(), candidate = value.edit(0, 0, 'source ')
  accept(prepare(value.checkpoint, candidate))
  assert.equal(await value.binding.flush(), true)
  const second = value.edit(candidate.source.length, candidate.source.length, '!'), preparation = prepare(value.checkpoint, second, noBirth)
  assert.equal(readPreparedSourceCheckpoint(preparation).lease.guards.expectedRevision, value.api.current.revision)
  accept(preparation); assert.equal(value.api.updates.length, 1)
  assert.equal(await value.binding.flush(), true); assert.equal(value.api.updates.length, 2)
})

test('a prepared side is refused when ACK changed its original guards before local acceptance', async () => {
  const value = await setup(), first = value.edit(0, 0, 'first ')
  accept(prepare(value.checkpoint, first))
  const second = value.edit(first.source.length, first.source.length, '!'), preparation = prepare(value.checkpoint, second, noBirth)
  assert.equal(await value.binding.flush(), true)
  assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'stale-revision' }).status, 'unavailable')
})

test('an issued allocation is an idempotent reader while an explicit basis cannot replace the first registration', async () => {
  const value = await setup(), candidate = value.edit(0, 0, 'prefix ')
  const first = allocateCanonicalSourceDraft(value.draft), basis = createCanonicalSourceAllocationBasis(first)
  const allocated = allocateCanonicalSourceDraft(candidate, { basis })
  assert.equal(allocateCanonicalSourceDraft(candidate), allocated)
  assert.equal(allocateCanonicalSourceDraft(candidate, { basis }), allocated)
  const other = value.edit(candidate.source.length, candidate.source.length, '!')
  allocateCanonicalSourceDraft(other)
  assert.throws(() => allocateCanonicalSourceDraft(other, { basis }), /first allocation basis/)
})

test('first opt-in registration cannot replace a C previously allocated against the real null basis', async () => {
  const value = await setup(), candidate = value.edit(0, 0, 'prefix ')
  const basis = createCanonicalSourceAllocationBasis(allocateCanonicalSourceDraft(value.draft))
  canonicalSourceDraftToBlocksWithManifest(candidate)
  assert.throws(() => allocateCanonicalSourceDraft(candidate, { basis }), /first allocation basis/)
  assert.ok(allocateCanonicalSourceDraft(candidate))
})

test('the last grammar callout must revalidate the actual draft receipt after successful C geometry', async () => {
  let armed = false, candidate: SourceLedgerDraft | undefined
  const options = markdownEngine.options as Record<string, unknown>, field = '__checkpoint_receipt_test__'
  Object.defineProperty(options, field, { configurable: true, enumerable: true, get() {
    if (armed && candidate) { armed = false; candidate.source += 'unobserved mutation' }
    return false
  } })
  try {
    const value = await setup()
    candidate = value.edit(value.draft.source.length, value.draft.source.length, '\n\nNew')
    assert.throws(() => prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: candidate!, freshId: () => {
      armed = true; return randomUUID()
    } }), /receipt/)
    assert.equal(armed, false); assert.equal(value.binding.getCurrent().editSequence, 0)
  } finally { delete options[field] }
})

test('the final scope callout cannot smuggle a changed draft past its allocation receipt', async () => {
  const value = await setup(), candidate = value.edit(value.draft.source.length, value.draft.source.length, '\n\nNew')
  let armed = false
  value.owner.isCurrent = () => {
    if (armed) { armed = false; candidate.source += 'unobserved mutation' }
    return true
  }
  assert.throws(() => prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: candidate, freshId: () => {
    armed = true; return randomUUID()
  } }), /receipt/)
  assert.equal(armed, false); assert.equal(value.binding.getCurrent().editSequence, 0)
})

test('parser configuration changes refuse a prepared draft without accepting content', async () => {
  const value = await setup(), candidate = value.edit(0, 0, 'prefix '), original = markdownEngine.options.breaks
  try {
    markdownEngine.options.breaks = !original
    assert.throws(() => prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: candidate }), /语法上下文/)
  } finally { markdownEngine.options.breaks = original }
  assert.equal(value.binding.getCurrent().editSequence, 0)
})

test('closed prepare and apply inputs reject accessors without evaluating them', async () => {
  const value = await setup()
  let calls = 0
  const input = Object.defineProperty({ checkpoint: value.checkpoint }, 'draft', { enumerable: true, get: () => { calls++; return value.draft } })
  assert.throws(() => prepareSourceCheckpoint(input as { checkpoint: SourceCheckpoint; draft: SourceLedgerDraft }), /访问器/)
  const preparation = prepare(value.checkpoint, value.edit(0, 0, 'prefix '))
  const apply = Object.defineProperty({ preparation }, 'transactionId', { enumerable: true, get: () => { calls++; return 'bad' } })
  assert.throws(() => applyPreparedSourceCheckpoint(apply as { preparation: PreparedSourceCheckpoint; transactionId: string }), /访问器/)
  assert.equal(calls, 0)
})

test('Apply rechecks Source grammar after controller scope callbacks finish', async () => {
  const value = await setup(), preparation = prepare(value.checkpoint, value.edit(0, 0, 'prefix '))
  const original = markdownEngine.options.breaks
  let calls = 0
  value.owner.isCurrent = () => { calls++; markdownEngine.options.breaks = !original; return true }
  try {
    assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'scope-changes-grammar' }).status, 'unavailable')
    assert.ok(calls > 0)
    assert.equal(value.binding.getCurrent().editSequence, 0)
  } finally { markdownEngine.options.breaks = original }
})

test('Apply rechecks the actual draft after a late registered controller scope callback changes it', async () => {
  const value = await setup(), candidate = value.edit(0, 0, 'prefix '), preparation = prepare(value.checkpoint, candidate)
  let calls = 0
  value.owner.isCurrent = () => {
    if (++calls === 4) candidate.source += 'unobserved controller callback'
    return true
  }
  assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'scope-changes-prepared-draft' }).status, 'unavailable')
  assert.ok(calls >= 4)
  assert.equal(value.binding.getCurrent().editSequence, 0)
})

test('prepare closes grammar again after its last scope callback', async () => {
  const options = markdownEngine.options as Record<string, unknown>, field = '__checkpoint_last_scope_test__'
  const original = markdownEngine.options.breaks
  let grammarCalls = 0, armed = false, changed = false
  Object.defineProperty(options, field, { configurable: true, enumerable: true, get() {
    if (++grammarCalls >= 3) armed = true
    return false
  } })
  try {
    const value = await setup(), candidate = value.edit(0, 0, 'prefix ')
    grammarCalls = 0; armed = false
    value.owner.isCurrent = () => {
      if (armed) { changed = true; markdownEngine.options.breaks = !original }
      return true
    }
    assert.equal(prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: candidate }).status, 'unavailable')
    assert.equal(changed, true)
    assert.equal(value.binding.getCurrent().editSequence, 0)
  } finally { markdownEngine.options.breaks = original; delete options[field] }
})

test('final Source grammar validation may dispose the binding and still cannot authorize acceptance', async () => {
  const options = markdownEngine.options as Record<string, unknown>, field = '__checkpoint_final_validator_test__'
  let armed = false, disposed = false, binding: SyncedGroupBinding | undefined
  Object.defineProperty(options, field, { configurable: true, enumerable: true, get() {
    if (armed && binding && !disposed) { disposed = true; binding.dispose() }
    return false
  } })
  try {
    const value = await setup(), preparation = prepare(value.checkpoint, value.edit(0, 0, 'prefix '))
    binding = value.binding
    let calls = 0
    value.owner.isCurrent = () => { if (++calls >= 4) armed = true; return true }
    assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'final-grammar-dispose' }).status, 'unavailable')
    assert.equal(disposed, true)
    assert.equal(value.binding.getCurrent().editSequence, 0)
  } finally { delete options[field] }
})

test('prepare rejects a scope hostSession changed by its final grammar validator without publication', async () => {
  const options = markdownEngine.options as Record<string, unknown>, field = '__checkpoint_final_prepare_scope_test__'
  let grammarCalls = 0, changed = false, owner: SyncedGroupScope | undefined
  Object.defineProperty(options, field, { configurable: true, enumerable: true, get() {
    if (++grammarCalls === 6 && owner) { changed = true; owner.hostSession = {} }
    return false
  } })
  try {
    const value = await setup(), candidate = value.edit(0, 0, 'prefix ')
    owner = value.owner; grammarCalls = 0
    assert.equal(prepareSourceCheckpoint({ checkpoint: value.checkpoint, draft: candidate }).status, 'unavailable')
    assert.equal(changed, true)
    assert.equal(value.binding.getCurrent().editSequence, 0)
  } finally { delete options[field] }
})

test('Apply rejects a scope bindingEpoch changed by its final grammar validator without publication', async () => {
  const options = markdownEngine.options as Record<string, unknown>, field = '__checkpoint_final_apply_scope_test__'
  let armed = false, changed = false, owner: SyncedGroupScope | undefined
  Object.defineProperty(options, field, { configurable: true, enumerable: true, get() {
    if (armed && owner && !changed) { changed = true; owner.bindingEpoch = {} }
    return false
  } })
  try {
    const value = await setup(), preparation = prepare(value.checkpoint, value.edit(0, 0, 'prefix '))
    owner = value.owner
    let calls = 0
    owner.isCurrent = () => { if (++calls >= 4) armed = true; return true }
    assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'final-grammar-changes-binding-epoch' }).status, 'unavailable')
    assert.equal(changed, true)
    assert.equal(value.binding.getCurrent().editSequence, 0)
  } finally { delete options[field] }
})
