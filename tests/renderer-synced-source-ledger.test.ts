import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EditorState, Prec } from '@codemirror/state'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { resolveMarkdownDocumentPath } from '../src/shared/markdownLinks'
import { markdownEngine } from '../src/shared/markdownEngine'
import { KnowbookStore } from '../src/main/database/store'
import { applySyncedGroupBindingClaims, captureSyncedGroupBindings } from '../src/main/database/synced-block-links'
import { validateSyncedGroupSnapshot } from '../src/shared/syncedBlockValidation'
import type { SyncedBindingKey, SyncedCanonicalEdit, SyncedCanonicalWire, SyncedOriginV1 } from '../src/shared/synced-blocks'
import { createMarkdownSourceSession, markdownSourceEditorText } from '../src/renderer/src/utils/markdownSourceSession'
import { createCanonicalSourceDraftWithManifest } from '../src/renderer/src/features/synced-blocks/sourceManifest'
import { openCanonicalSourceLedger, forkCanonicalSourceLedger, prepareCanonicalSourceFirstApply,
  createCanonicalSourceLedgerSession, readCanonicalSourceLedgerCandidate, readPreparedSourceFirstApply, type PreparedSourceFirstApplyFacts,
  type SourceFirstApplyLease, type SourceLedgerDraft } from '../src/renderer/src/features/synced-blocks/sourceLedger'

const block = (id: string, content: string, type = 'paragraph'): SyncedCanonicalEdit =>
  ({ id, type, content, checked: false, depth: 0, parentBlockId: null })
const origin = (): SyncedOriginV1 => ({ version: 1, documentId: 'origin', pathAtCreation: 'Folder/Source', firstInstanceId: randomUUID() })
function lease(): SourceFirstApplyLease {
  const groupId = randomUUID()
  return { scope: { groupId, hostDocumentId: 'host', windowSessionId: 'window', hostSession: {}, mountEpoch: {}, bindingEpoch: {},
    instanceId: randomUUID(), bindingVersion: randomUUID() }, expectedEditSequence: 4,
    guards: { groupId, expectedRevision: randomUUID(), expectedTopologyRevision: randomUUID() } }
}
function opening(blocks = [block('canonical', 'before [x](Target.md) after')]) {
  const base = lease(), immutableOrigin = origin(), opened = openCanonicalSourceLedger({ blocks, origin: immutableOrigin, lease: base })
  return { ...opened, base, immutableOrigin }
}
function prepare(draft: SourceLedgerDraft, base: SourceFirstApplyLease, freshId?: () => string) {
  return readPreparedSourceFirstApply(prepareCanonicalSourceFirstApply({ draft, lease: base, freshId }))
}
const keyId = (key: Readonly<SyncedBindingKey>) => JSON.stringify([key.blockId, key.from, key.to, key.raw, key.syntax])
function closure(result: PreparedSourceFirstApplyFacts, immutableOrigin: SyncedOriginV1) {
  const actual = collectDocumentMarkdownLinks([...result.blocks]).filter(link => link.kind !== 'image'
    && (link.kind === 'wiki' || resolveMarkdownDocumentPath(immutableOrigin.pathAtCreation, link.url) !== null)).map(link => ({
      blockId: result.blocks[link.blockIndex].id, from: link.start, to: link.end,
      raw: result.blocks[link.blockIndex].content.slice(link.start, link.end), syntax: link.kind === 'wiki' ? 'wiki' as const : 'markdown' as const
    }))
  assert.deepEqual(result.bindingClaims.map(claim => keyId(claim.destination)).sort(), actual.map(keyId).sort())
  assert.equal(new Set(result.bindingClaims.map(claim => keyId(claim.destination))).size, actual.length)
  for (const claim of result.bindingClaims) assert.equal(Object.hasOwn(claim, 'target'), false)
}

test('opening preserves original UTF16/CRLF bytes and exact physical keys through unchanged prepare', () => {
  const content = '\uFEFF🙂 before\r\n[x](Target.md)\r\n尾\0', value = opening([block(' 旧🙂 ', content)])
  assert.ok(!value.draft.source.includes('\r'))
  const result = prepare(value.draft, value.base)
  assert.equal(result.blocks[0].content, content)
  assert.equal(result.bindingClaims.length, 1)
  const claim = result.bindingClaims[0]
  assert.equal(claim.kind, 'continue')
  if (claim.kind !== 'continue') return
  const at = content.indexOf('Target.md')
  assert.deepEqual(claim.source, { blockId: ' 旧🙂 ', from: at, to: at + 9, raw: 'Target.md', syntax: 'markdown' })
  assert.deepEqual(claim.destination, claim.source)
  closure(result, value.immutableOrigin)
})

test('outside text edits continue the uniquely mapped whole use and retain the real before receipt edge', () => {
  const value = opening(), before = readCanonicalSourceLedgerCandidate(value.draft)
  const changed = forkCanonicalSourceLedger(value.draft, [{ from: 0, to: 0, insert: '中文🙂 ' }])
  const facts = readCanonicalSourceLedgerCandidate(changed), result = prepare(changed, value.base)
  assert.equal(facts.beforeReceipt, before.receipt)
  assert.equal(facts.receipt.revision, 1)
  assert.equal(readCanonicalSourceLedgerCandidate(value.draft), before)
  assert.equal(result.bindingClaims[0].kind, 'continue')
  assert.equal(result.hasIntent, true, 'The destination Key moved even though its target continues')
  closure(result, value.immutableOrigin)
})

test('same-text destination replacement creates a new generation and new claim despite unchanged source bytes', () => {
  const value = opening(), at = value.draft.source.indexOf('Target.md')
  const changed = forkCanonicalSourceLedger(value.draft, [{ from: at, to: at + 9, insert: 'Target.md' }])
  assert.notEqual(changed, value.draft)
  assert.equal(changed.source, value.draft.source)
  const result = prepare(changed, value.base), facts = readCanonicalSourceLedgerCandidate(changed)
  assert.equal(result.bindingClaims[0].kind, 'new'); assert.equal(result.hasIntent, true)
  assert.ok(facts.fragments.some(fragment => fragment.from === at && fragment.to === at + 9 && fragment.openingFrom === null))
  closure(result, value.immutableOrigin)
})

test('same-text full markup replacement does not inherit the old target or collapse into a noop', () => {
  const value = opening([block('canonical', '[x](Target.md)')])
  const changed = forkCanonicalSourceLedger(value.draft, [{ from: 0, to: value.draft.source.length, insert: value.draft.source }])
  const result = prepare(changed, value.base)
  assert.equal(result.blocks[0].content, value.draft.initialBlocks[0].content)
  assert.equal(result.bindingClaims[0].kind, 'new'); assert.equal(result.hasIntent, true)
  assert.ok(readCanonicalSourceLedgerCandidate(changed).fragments.every(fragment => fragment.openingFrom === null))
})

test('true empty changes keep the original draft and do not allocate a ledger revision', () => {
  const value = opening(), facts = readCanonicalSourceLedgerCandidate(value.draft)
  assert.equal(forkCanonicalSourceLedger(value.draft, []), value.draft)
  assert.equal(forkCanonicalSourceLedger(value.draft, [{ from: 1, to: 1, insert: '' }]), value.draft)
  assert.equal(readCanonicalSourceLedgerCandidate(value.draft), facts)
})

test('duplicate hrefs preserve distinct opening sources through a real split and final Key change', () => {
  const content = 'one [x](Same.md) two [x](Same.md)', value = opening([block('canonical', content)])
  const boundary = content.indexOf(' two'), changed = forkCanonicalSourceLedger(value.draft, [{ from: boundary, to: boundary + 1, insert: '\n\n' }])
  const result = prepare(changed, value.base, () => randomUUID())
  assert.equal(result.blocks.length, 2)
  assert.deepEqual(result.bindingClaims.map(claim => claim.kind), ['continue', 'continue'])
  const sources = result.bindingClaims.flatMap(claim => claim.kind === 'continue' ? [keyId(claim.source)] : [])
  assert.equal(new Set(sources).size, 2)
  assert.notEqual(result.bindingClaims[0].destination.blockId, result.bindingClaims[1].destination.blockId)
  closure(result, value.immutableOrigin)
})

test('untyped insertion of a complete duplicate link is new rather than a URL-based copy', () => {
  const value = opening(), end = value.draft.source.length
  const changed = forkCanonicalSourceLedger(value.draft, [{ from: end, to: end, insert: '\n\n[new](Target.md)' }])
  const result = prepare(changed, value.base)
  assert.deepEqual(result.bindingClaims.map(claim => claim.kind), ['continue', 'new'])
  closure(result, value.immutableOrigin)
})

test('a certified new use remains new through later outside typing without reseeding', () => {
  const value = opening([block('canonical', 'plain')]), end = value.draft.source.length
  const added = forkCanonicalSourceLedger(value.draft, [{ from: end, to: end, insert: ' [new](Target.md)' }])
  const typed = forkCanonicalSourceLedger(added, [{ from: 0, to: 0, insert: 'more ' }])
  assert.equal(readCanonicalSourceLedgerCandidate(typed).beforeReceipt, readCanonicalSourceLedgerCandidate(added).receipt)
  assert.equal(prepare(typed, value.base).bindingClaims[0].kind, 'new')
})

test('internal label edits keep a candidate but refuse claims without actual label/carrier facts', () => {
  const value = opening(), at = value.draft.source.indexOf('[x]') + 1
  for (const insert of ['edited', 'x']) {
    const changed = forkCanonicalSourceLedger(value.draft, [{ from: at, to: at + 1, insert }])
    assert.ok(changed.source.includes('[' + insert + ']'))
    assert.throws(() => prepare(changed, value.base), /carrier.*未生成来源声明/)
  }
  assert.ok(value.draft.source.includes('[x]'))
})

test('partial destination edits and shell rebuilding are explicit unknown rather than automatically new', () => {
  const value = opening(), at = value.draft.source.indexOf('Target.md')
  const partial = forkCanonicalSourceLedger(value.draft, [{ from: at, to: at + 1, insert: 'N' }])
  assert.throws(() => prepare(partial, value.base), /未生成来源声明/)
  const shell = value.draft.source.indexOf('[x]'), rebuilt = forkCanonicalSourceLedger(value.draft, [{ from: shell, to: shell + 1, insert: '[' }])
  assert.equal(rebuilt.source, value.draft.source)
  assert.throws(() => prepare(rebuilt, value.base), /未生成来源声明/)
})

test('a retired use cannot resurrect through surviving href bytes; explicit full replacement can certify a new birth', () => {
  const value = opening([block('canonical', '[x](Target.md)')])
  const escaped = forkCanonicalSourceLedger(value.draft, [{ from: 0, to: 0, insert: '\\' }])
  assert.equal(prepare(escaped, value.base).bindingClaims.length, 0)
  const restored = forkCanonicalSourceLedger(escaped, [{ from: 0, to: 1, insert: '' }])
  assert.throws(() => prepare(restored, value.base), /未生成来源声明/)
  const fresh = forkCanonicalSourceLedger(restored, [{ from: 0, to: restored.source.length, insert: restored.source }])
  assert.equal(prepare(fresh, value.base).bindingClaims[0].kind, 'new')
})

test('unknown table context is not automatically new and only whole-source replacement clears the conservative taint', () => {
  const value = opening([block('canonical', '| a |\n| - |\n| [x](Target.md) |', 'table')])
  assert.throws(() => prepare(value.draft, value.base), /未生成来源声明/)
  const changed = forkCanonicalSourceLedger(value.draft, [{ from: 0, to: 0, insert: 'outside\n\n' }])
  assert.throws(() => prepare(changed, value.base), /未生成来源声明/)
  const replaced = forkCanonicalSourceLedger(changed, [{ from: 0, to: changed.source.length, insert: '[fresh](Target.md)' }])
  const result = prepare(replaced, value.base)
  assert.equal(result.bindingClaims[0].kind, 'new'); closure(result, value.immutableOrigin)
})

test('inactive duplicate definitions remain separate physical keys while many reference uses add none', () => {
  const content = '[r]: Same.md\n\n[r]: Other.md\n\n[a][r] [b][r] [r]', value = opening([block('definitions', content)])
  const result = prepare(value.draft, value.base)
  assert.equal(result.bindingClaims.length, 2)
  assert.deepEqual(result.bindingClaims.map(claim => claim.destination.raw), ['Same.md', 'Other.md'])
  assert.deepEqual(result.bindingClaims.map(claim => claim.kind), ['continue', 'continue'])
  closure(result, value.immutableOrigin)
})

test('deleting first definition activates the duplicate own source without taking the deleted first target', () => {
  const first = '[r]: Same.md\n\n', content = first + '[r]: Same.md\n\n[use][r]', value = opening([block('definitions', content)])
  const changed = forkCanonicalSourceLedger(value.draft, [{ from: 0, to: first.length, insert: '' }]), result = prepare(changed, value.base)
  assert.equal(result.bindingClaims.length, 1)
  const claim = result.bindingClaims[0]
  assert.equal(claim.kind, 'continue')
  if (claim.kind === 'continue') assert.equal(claim.source.from, first.length + '[r]: '.length)
  closure(result, value.immutableOrigin)
})

test('same-text first-definition destination replacement emits one new claim, never one claim per use', () => {
  const value = opening([block('definitions', '[r]: Same.md\n\n[a][r] [b][r] [r]')]), at = value.draft.source.indexOf('Same.md')
  const changed = forkCanonicalSourceLedger(value.draft, [{ from: at, to: at + 7, insert: 'Same.md' }]), result = prepare(changed, value.base)
  assert.equal(result.bindingClaims.length, 1); assert.equal(result.bindingClaims[0].kind, 'new')
  closure(result, value.immutableOrigin)
})

test('an external first definition does not give its use the inactive local duplicate binding', () => {
  const value = opening([block('definitions', '[r]: https://example.com/\n\n[r]: Local.md\n\n[use][r]')]), result = prepare(value.draft, value.base)
  assert.deepEqual(result.bindingClaims.map(claim => claim.destination.raw), ['Local.md'])
  closure(result, value.immutableOrigin)
})

test('empty hrefs use a full-use point witness and continue only through outside edits', () => {
  const value = opening([block('canonical', 'before [x]() after')]), changed = forkCanonicalSourceLedger(value.draft, [{ from: 0, to: 0, insert: 'more ' }])
  const result = prepare(changed, value.base), claim = result.bindingClaims[0]
  assert.equal(claim.kind, 'continue'); assert.equal(claim.destination.from, claim.destination.to)
  assert.equal(claim.destination.raw, '')
  closure(result, value.immutableOrigin)
})

test('empty href birth requires a whole inserted use, not an empty range or merely deleted destination', () => {
  const value = opening([block('canonical', 'plain')]), end = value.draft.source.length
  const inserted = forkCanonicalSourceLedger(value.draft, [{ from: end, to: end, insert: ' [empty]()' }])
  const result = prepare(inserted, value.base)
  assert.equal(result.bindingClaims[0].kind, 'new'); assert.equal(result.bindingClaims[0].destination.raw, '')
  const zero = inserted.source.indexOf('()') + 1
  assert.equal(forkCanonicalSourceLedger(inserted, [{ from: zero, to: zero, insert: '' }]), inserted)
  const filled = forkCanonicalSourceLedger(inserted, [{ from: zero, to: zero, insert: 'Target.md' }])
  assert.equal(prepare(filled, value.base).bindingClaims[0].kind, 'new', 'Every new nonempty href byte is from the actual insertion')
  const deleted = forkCanonicalSourceLedger(filled, [{ from: zero, to: zero + 9, insert: '' }])
  assert.throws(() => prepare(deleted, value.base), /未生成来源声明/, 'An empty point is not evidence for a new empty target')
})

test('incremental href typing remains an explicit missing carrier case instead of treating mixed generations as new', () => {
  const value = opening([block('canonical', '[empty]()')]), point = value.draft.source.indexOf('()') + 1
  const first = forkCanonicalSourceLedger(value.draft, [{ from: point, to: point, insert: 'T.md' }])
  assert.equal(prepare(first, value.base).bindingClaims[0].kind, 'new')
  const second = forkCanonicalSourceLedger(first, [{ from: point + 1, to: point + 1, insert: 'a' }])
  assert.ok(second.source.includes('(Ta.md)'))
  assert.throws(() => prepare(second, value.base), /未生成来源声明/)
})

test('unchanged excluded opaque code preserves original bytes without claiming literal links', () => {
  const content = '[literal](Ignored.md)\r\nbody', value = opening([block('code', content, 'code'), block('tail', 'tail [x](Target.md)')])
  const at = value.draft.source.lastIndexOf('tail'), changed = forkCanonicalSourceLedger(value.draft, [{ from: at, to: at + 4, insert: 'edited' }])
  const result = prepare(changed, value.base)
  assert.equal(result.blocks[0].content, content)
  assert.equal(result.bindingClaims.length, 1); assert.equal(result.bindingClaims[0].destination.raw, 'Target.md')
  closure(result, value.immutableOrigin)
})

test('prepare caches one actual reconcile allocation and rejects forged drafts, preparations and stale leases', () => {
  const value = opening([block('canonical', 'plain')]), changed = forkCanonicalSourceLedger(value.draft,
    [{ from: 0, to: value.draft.source.length, insert: '[a](One.md)\n\n[b](Two.md)' }])
  let allocations = 0
  const first = prepareCanonicalSourceFirstApply({ draft: changed, lease: value.base, freshId: () => { allocations++; return randomUUID() } })
  const again = prepareCanonicalSourceFirstApply({ draft: changed, lease: value.base, freshId: () => { throw new Error('must use cached IDs') } })
  assert.equal(first, again); assert.equal(allocations, 1)
  const result = readPreparedSourceFirstApply(first)
  assert.ok(Object.isFrozen(result.blocks) && Object.isFrozen(result.blocks[0]) && Object.isFrozen(result.bindingClaims[0].destination))
  assert.throws(() => readPreparedSourceFirstApply({ ...first }))
  assert.throws(() => prepare({ ...changed }, value.base))
  assert.throws(() => prepare(changed, { ...value.base, expectedEditSequence: value.base.expectedEditSequence + 1 }))
  assert.throws(() => prepare(changed, { ...value.base, scope: { ...value.base.scope, mountEpoch: {} } }))
  const foreign = createCanonicalSourceDraftWithManifest([block('canonical', changed.source)]).draft
  assert.throws(() => prepare(foreign, value.base))
})

test('prepare rejects input accessors before they can attach admitted A facts to an admitted B draft', () => {
  const value = opening(), a = forkCanonicalSourceLedger(value.draft, [{ from: 0, to: 0, insert: 'A ' }])
  const b = forkCanonicalSourceLedger(value.draft, [{ from: 0, to: 0, insert: 'B ' }])
  let reads = 0
  const input = { lease: value.base, get draft() { reads++; return reads < 4 ? a : b } }
  assert.throws(() => prepareCanonicalSourceFirstApply(input), /访问器/)
  assert.equal(reads, 0)
  const valid = { draft: a, lease: value.base }
  const prepared = prepareCanonicalSourceFirstApply(valid), result = readPreparedSourceFirstApply(prepared)
  assert.equal(result.draft, a); assert.equal(result.draftReceipt, readCanonicalSourceLedgerCandidate(a).receipt)
  assert.notEqual(result.draftReceipt, readCanonicalSourceLedgerCandidate(b).receipt)
  let allocations = 0
  const allocatorAccessor = { draft: a, lease: value.base, get freshId() { allocations++; return randomUUID } }
  assert.throws(() => prepareCanonicalSourceFirstApply(allocatorAccessor), /访问器/)
  assert.equal(allocations, 0)
})

test('a reconcile failure after allocating IDs is memoized and cannot retry with a different allocator', () => {
  const value = opening([block('canonical', 'plain')]), changed = forkCanonicalSourceLedger(value.draft,
    [{ from: 0, to: value.draft.source.length, insert: '[a](One.md)\n\n[b](Two.md)\n\n[c](Three.md)' }])
  const duplicate = randomUUID()
  let firstCalls = 0, retryCalls = 0, firstError: unknown, secondError: unknown
  try { prepare(changed, value.base, () => { firstCalls++; return duplicate }) } catch (error) { firstError = error }
  assert.ok(firstError); assert.equal(firstCalls, 2)
  try { prepare(changed, value.base, () => { retryCalls++; return randomUUID() }) } catch (error) { secondError = error }
  assert.equal(secondError, firstError); assert.equal(retryCalls, 0)
  assert.equal(readCanonicalSourceLedgerCandidate(changed).receipt.revision, 1)
})

test('a true empty change inside an old use does not retire it when another change edits outside', () => {
  const value = opening(), point = value.draft.source.indexOf('Target.md') + 1
  const changed = forkCanonicalSourceLedger(value.draft, [{ from: point, to: point, insert: '' }, { from: 0, to: 0, insert: 'more ' }])
  assert.equal(prepare(changed, value.base).bindingClaims[0].kind, 'continue')
  assert.equal(readCanonicalSourceLedgerCandidate(changed).receipt.rawChanges.length, 2, 'Receipt retains the actual batch even when a true noop has no survivor effect')
})

test('the ledger refuses a changed grammar and never silently reseeds a previous draft', () => {
  const value = opening(), before = markdownEngine.options.breaks
  try {
    markdownEngine.options.breaks = !before
    assert.throws(() => forkCanonicalSourceLedger(value.draft, []), /语法上下文/)
    assert.throws(() => prepare(value.draft, value.base), /语法上下文/)
  } finally { markdownEngine.options.breaks = before }
  assert.equal(prepare(value.draft, value.base).bindingClaims[0].kind, 'continue')
})

test('real CM same-before candidates and a later rejecting filter never advance the accepted ledger', () => {
  const value = opening(), candidates: SourceLedgerDraft[] = []
  const session = createMarkdownSourceSession({ draft: value.draft, replaceChanges: (before, changes) => {
    const next = forkCanonicalSourceLedger(before, changes); candidates.push(next); return next
  } })
  const state = EditorState.create({ doc: markdownSourceEditorText(value.draft.source), extensions: [Prec.lowest(session.extension),
    // CodeMirror executes transaction filters in reverse facet order.
    Prec.highest(EditorState.transactionFilter.of(transaction => transaction.newDoc.toString().startsWith('denied') ? [] : transaction))] })
  const first = state.update({ changes: { from: 0, insert: 'first ' } }), second = state.update({ changes: { from: 0, insert: 'second ' } })
  assert.equal(session.read(state), value.draft)
  const a = session.read(first.state), b = session.read(second.state)
  assert.notEqual(a, b)
  assert.equal(readCanonicalSourceLedgerCandidate(a).receipt.revision, 1)
  assert.equal(readCanonicalSourceLedgerCandidate(b).receipt.revision, 1)
  const count = candidates.length, denied = state.update({ changes: { from: 0, insert: 'denied ' }, selection: { anchor: 7 } })
  assert.ok(candidates.length > count, 'The real first filter computed a disposable candidate')
  assert.equal(session.read(denied.state), value.draft)
  assert.equal(denied.state.doc.toString(), state.doc.toString())
  assert.equal(denied.state.selection.main.anchor, state.selection.main.anchor)
  assert.equal(readCanonicalSourceLedgerCandidate(value.draft).receipt.revision, 0)
})

test('real CM same-text replacement and replay restore exact old generations without another raw edit', () => {
  const value = opening(), session = createCanonicalSourceLedgerSession({ draft: value.draft })
  const state = EditorState.create({ doc: markdownSourceEditorText(value.draft.source), extensions: session.extension }), at = state.doc.toString().indexOf('Target.md')
  const changed = state.update({ changes: { from: at, to: at + 9, insert: 'Target.md' } }).state
  assert.equal(prepare(session.read(changed), value.base).bindingClaims[0].kind, 'new')
  const replayed = changed.update({ annotations: session.replay.of(value.draft) }).state
  assert.equal(session.read(replayed), value.draft)
  assert.equal(prepare(session.read(replayed), value.base).bindingClaims[0].kind, 'continue')
})

test('the cold real CM adapter rejects forged and other admitted opening replays before accepting text or selection', () => {
  const value = opening(), errors: unknown[] = [], session = createCanonicalSourceLedgerSession({ draft: value.draft, onError: error => errors.push(error) })
  const state = EditorState.create({ doc: markdownSourceEditorText(value.draft.source), selection: { anchor: 1 }, extensions: session.extension })
  const other = opening().draft
  for (const foreign of [{ ...value.draft }, other]) {
    const denied = state.update({ annotations: session.replay.of(foreign), selection: { anchor: 7 } })
    assert.equal(denied.state.doc.toString(), state.doc.toString())
    assert.equal(denied.state.selection.main.anchor, 1)
    assert.equal(session.read(denied.state), value.draft)
  }
  assert.equal(errors.length, 2)
  assert.equal(readCanonicalSourceLedgerCandidate(value.draft).receipt.revision, 0)
  const edited = state.update({ changes: { from: 0, insert: 'same opening ' } }).state
  const restored = edited.update({ changes: { from: 0, to: 'same opening '.length, insert: '' }, annotations: session.replay.of(value.draft) }).state
  assert.equal(session.read(restored), value.draft)
  assert.equal(errors.length, 2)
})

test('cold session options are captured once as own data and caller mutation cannot replace its private root validator', () => {
  const value = opening()
  let reads = 0
  assert.throws(() => createCanonicalSourceLedgerSession({ get draft() { reads++; return value.draft } }), /访问器/)
  assert.equal(reads, 0)
  const errors: unknown[] = [], options = { draft: value.draft, isCurrent: () => true, onError: (error: unknown) => errors.push(error) }
  const session = createCanonicalSourceLedgerSession(options)
  options.draft = opening().draft; options.isCurrent = () => false; options.onError = () => { throw new Error('mutable caller option was reread') }
  const state = EditorState.create({ doc: markdownSourceEditorText(value.draft.source), extensions: session.extension })
  const edited = state.update({ changes: { from: 0, insert: 'accepted ' } }).state
  assert.ok(session.read(edited).source.startsWith('accepted '))
  const denied = edited.update({ annotations: session.replay.of(options.draft) }).state
  assert.equal(session.read(denied), session.read(edited)); assert.equal(errors.length, 1)
})

test('cold session isCurrent callback receiver cannot replace its private root validator', () => {
  const value = opening(), other = opening().draft, receivers: unknown[] = [], errors: unknown[] = []
  const session = createCanonicalSourceLedgerSession({ draft: value.draft,
    isCurrent: function(this: { validateDraft?: (draft: SourceLedgerDraft) => void } | undefined) {
      receivers.push(this)
      if (this) this.validateDraft = () => {}
      return true
    }, onError: error => errors.push(error) })
  const state = EditorState.create({ doc: markdownSourceEditorText(value.draft.source), selection: { anchor: 1 }, extensions: session.extension })
  for (const foreign of [other, { ...value.draft }]) {
    const denied = state.update({ annotations: session.replay.of(foreign), selection: { anchor: 7 } })
    assert.equal(session.read(denied.state), value.draft, 'The caller receiver must not be able to disable the actual root validator')
    assert.equal(denied.state.doc.toString(), state.doc.toString())
    assert.equal(denied.state.selection.main.anchor, 1)
  }
  assert.equal(errors.length, 2)
  assert.deepEqual(receivers, [undefined, undefined])
})

test('cold session onError callback receiver cannot disable later replay validation', () => {
  const value = opening(), other = opening().draft, receivers: unknown[] = [], errors: unknown[] = []
  const session = createCanonicalSourceLedgerSession({ draft: value.draft,
    onError: function(this: { validateDraft?: (draft: SourceLedgerDraft) => void } | undefined, error: unknown) {
      receivers.push(this); errors.push(error)
      if (this) this.validateDraft = () => {}
    } })
  const state = EditorState.create({ doc: markdownSourceEditorText(value.draft.source), selection: { anchor: 1 }, extensions: session.extension })
  for (const foreign of [{ ...value.draft }, other]) {
    const denied = state.update({ annotations: session.replay.of(foreign), selection: { anchor: 7 } })
    assert.equal(session.read(denied.state), value.draft, 'The first rejected replay must not let onError admit a later opening')
    assert.equal(denied.state.doc.toString(), state.doc.toString())
    assert.equal(denied.state.selection.main.anchor, 1)
  }
  assert.equal(errors.length, 2)
  assert.deepEqual(receivers, [undefined, undefined])
})

test('the optional generic validation port runs once for opening and once before a candidate is cached', () => {
  const draft = { source: 'plain' }, validations: object[] = []
  const session = createMarkdownSourceSession({ draft, replaceChanges: (before, changes) => {
    assert.equal(changes.length, 1); return { source: 'edited ' + before.source }
  }, validateDraft: value => { validations.push(value) } })
  const state = EditorState.create({ doc: draft.source, extensions: session.extension })
  assert.deepEqual(validations, [draft])
  const next = state.update({ changes: { from: 0, insert: 'edited ' } }).state
  assert.equal(validations.length, 2)
  assert.equal(validations[1], session.read(next)); assert.equal(session.read(next), session.read(next))
  assert.equal(validations.length, 2)
  const moved = next.update({ selection: { anchor: 1 } }).state
  assert.equal(session.read(moved), session.read(next)); assert.equal(validations.length, 2)
})

test('real CM sequential specs, selection-only and distinct transactions consume exact before receipts', () => {
  const value = opening(), calls: SourceLedgerDraft[] = []
  const session = createMarkdownSourceSession({ draft: value.draft, replaceChanges: (before, changes) => {
    const next = forkCanonicalSourceLedger(before, changes); calls.push(next); return next
  } })
  const state = EditorState.create({ doc: markdownSourceEditorText(value.draft.source), extensions: session.extension })
  const moved = state.update({ selection: { anchor: 1 } }).state
  assert.equal(calls.length, 0); assert.equal(session.read(moved), value.draft)
  const first = moved.update({ changes: { from: 0, insert: 'A' } }, { changes: { from: 1, insert: 'B' }, sequential: true }).state
  const second = first.update({ changes: { from: 0, insert: 'C' } }).state
  assert.ok(session.read(second).source.startsWith('CABbefore'))
  assert.equal(readCanonicalSourceLedgerCandidate(session.read(second)).beforeReceipt, readCanonicalSourceLedgerCandidate(session.read(first)).receipt)
  assert.equal(calls.length, 2)
  closure(prepare(session.read(second), value.base), value.immutableOrigin)
})

test('real CM maps mixed raw CRLF/CR and surrogate boundaries once before the ledger consumes its receipt', () => {
  const value = opening(), mixed = forkCanonicalSourceLedger(value.draft, [{ from: 0, to: 0, insert: '\uFEFF🙂\r\nA\rB\n\n' }])
  const session = createMarkdownSourceSession({ draft: mixed, replaceChanges: forkCanonicalSourceLedger })
  const state = EditorState.create({ doc: markdownSourceEditorText(mixed.source), extensions: session.extension })
  const lineBreak = state.doc.toString().indexOf('\n')
  const changed = state.update({ changes: [{ from: lineBreak, to: lineBreak + 1, insert: '' }, { from: 1, to: 3, insert: '汉字🙂' }] }).state
  const accepted = session.read(changed), facts = readCanonicalSourceLedgerCandidate(accepted)
  assert.deepEqual(facts.receipt.rawChanges, [{ from: 1, to: 5, insert: '汉字🙂' }])
  assert.ok(accepted.source.startsWith('\uFEFF汉字🙂A\rB\n\n'))
  assert.equal(facts.beforeReceipt, readCanonicalSourceLedgerCandidate(mixed).receipt)
  closure(prepare(accepted, value.base), value.immutableOrigin)
})

test('real SQLite binding authority preserves renamed continue targets and resolves same-text new against the replacement path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-source-ledger-')), store = new KnowbookStore(join(directory, 'workspace.db'))
  const save = (id: string, title: string) => store.updateDocument(id, { title, summary: '', blocks: [block(randomUUID(), 'body')] })
  try {
    const folder = store.createDocument(null); save(folder, 'Folder')
    const source = store.createDocument(folder), oldTarget = store.createDocument(folder)
    save(source, 'Source'); save(oldTarget, 'Target')
    const immutableOrigin: SyncedOriginV1 = { version: 1, documentId: source, pathAtCreation: store.getDocumentDetail(source)!.path, firstInstanceId: randomUUID() }
    const base = lease(), blocks = [block('canonical', 'before [x](Target.md) after')], createdAt = '2020-01-02T03:04:05+08:00'
    const wire: SyncedCanonicalWire[] = blocks.map(block => ({ ...block, createdAt })), db = store.getUnsafeDatabaseHandle()
    const snapshot = validateSyncedGroupSnapshot({ groupId: base.scope.groupId, creationId: randomUUID(), createdAt,
      revision: base.guards.expectedRevision, topologyRevision: base.guards.expectedTopologyRevision, origin: immutableOrigin,
      blocks: wire, bindings: captureSyncedGroupBindings(db, immutableOrigin, wire), instances: [], maxRelativeDepth: 0,
      history: { cursor: randomUUID(), undoToken: null, redoToken: null } })
    save(oldTarget, 'Renamed')
    const replacement = store.createDocument(folder); save(replacement, 'Target')
    const value = openCanonicalSourceLedger({ blocks, origin: immutableOrigin, lease: base })
    const continued = prepare(forkCanonicalSourceLedger(value.draft, [{ from: 0, to: 0, insert: 'more ' }]), base)
    const continuedBindings = applySyncedGroupBindingClaims(db, snapshot, continued.blocks.map(block => ({ ...block, createdAt })), continued.bindingClaims)
    assert.deepEqual(continuedBindings[0].target, { kind: 'document', id: oldTarget, state: 'live' })
    const at = value.draft.source.indexOf('Target.md'), changed = prepare(forkCanonicalSourceLedger(value.draft,
      [{ from: at, to: at + 9, insert: 'Target.md' }]), base)
    const newBindings = applySyncedGroupBindingClaims(db, snapshot, changed.blocks.map(block => ({ ...block, createdAt })), changed.bindingClaims)
    assert.deepEqual(newBindings[0].target, { kind: 'document', id: replacement, state: 'live' })
  } finally { store.destroy(); rmSync(directory, { recursive: true, force: true }) }
})
