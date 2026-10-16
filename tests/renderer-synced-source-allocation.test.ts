import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { EditorState } from '@codemirror/state'
import { markdownEngine } from '../src/shared/markdownEngine'
import type { SyncedCanonicalEdit } from '../src/shared/synced-blocks'
import { canonicalSourceDraftToBlocks, createCanonicalSourceDraft } from '../src/renderer/src/features/synced-blocks/canonicalSource'
import { replaceMarkdownSourceChanges, type MarkdownSourceDraft } from '../src/renderer/src/utils/markdownSourceDraft'
import { createMarkdownSourceSession, markdownSourceEditorText } from '../src/renderer/src/utils/markdownSourceSession'
import { allocateCanonicalSourceDraft, canonicalSourceDraftToBlocksWithManifest, createCanonicalSourceAllocationBasis,
  createCanonicalSourceDraftWithManifest, projectSourceAllocationContentRange, projectSourceAllocationRawRange,
  readCanonicalSourceAllocation, readMarkdownSourceDraftReceipt, readMarkdownSourceReconciliationManifest,
  type MarkdownSourceAllocationBasis } from '../src/renderer/src/features/synced-blocks/sourceManifest'

const block = (id: string, content: string): SyncedCanonicalEdit => ({ id, content, type: 'paragraph', checked: false,
  depth: 0, parentBlockId: null, tags: ['保留'], highlight: 'yellow' })
const open = (blocks = [block(' __proto__:旧 ', 'Root')]) => createCanonicalSourceDraftWithManifest(blocks).draft
const edit = (draft: MarkdownSourceDraft, from: number, to: number, insert: string) => replaceMarkdownSourceChanges(draft, [{ from, to, insert }])
const replace = (draft: MarkdownSourceDraft, source: string) => edit(draft, 0, draft.source.length, source)
function allocate(draft: MarkdownSourceDraft, basis?: MarkdownSourceAllocationBasis, freshId?: () => string) {
  const allocation = allocateCanonicalSourceDraft(draft, { ...(basis ? { basis } : {}), ...(freshId ? { freshId } : {}) })
  return { allocation, facts: readCanonicalSourceAllocation(allocation), basis: createCanonicalSourceAllocationBasis(allocation) }
}
const noBirth = () => { throw new Error('An existing actual allocation must not mint another ID') }
function born() {
  const initial = open(), candidate = replace(initial, 'Root\n\nNew'), id = randomUUID()
  const first = allocate(candidate, undefined, () => id)
  return { initial, candidate, id, first }
}

test('the legacy manifest entry and allocation entry share one owned C and the unchanged three-field result shape', () => {
  const initial = open(), candidate = replace(initial, 'Root\n\nNew'), id = randomUUID()
  let count = 0
  const old = canonicalSourceDraftToBlocksWithManifest(candidate, () => { count++; return id })
  const next = allocate(candidate, undefined, noBirth)
  assert.equal(count, 1); assert.equal(next.facts.blocks, old.blocks)
  assert.equal(next.facts.reconciliationManifest, old.manifest)
  assert.deepEqual(Object.keys(old).sort(), ['blocks', 'manifest', 'syntax'])
  assert.equal(canonicalSourceDraftToBlocksWithManifest(candidate, noBirth), old)
})

test('allocation first then legacy firstApply cannot mint a second body or change its actual C receipt', () => {
  const { candidate, id, first } = born()
  const old = canonicalSourceDraftToBlocksWithManifest(candidate, noBirth)
  assert.equal(old.manifest, first.facts.reconciliationManifest)
  assert.equal(old.blocks[1].id, id); assert.equal(allocateCanonicalSourceDraft(candidate), first.allocation)
  const rows = readMarkdownSourceReconciliationManifest(old.manifest).outputs
  assert.equal(Object.hasOwn(rows[0], 'allocationAnchor'), false)
})

test('caller mutation cannot poison a returned C, manifest or later basis authority', () => {
  const { candidate, first, id } = born(), old = canonicalSourceDraftToBlocksWithManifest(candidate)
  assert.equal(Object.isFrozen(old), true); assert.equal(Object.isFrozen(old.blocks), true)
  assert.equal(Object.isFrozen(old.blocks[0].tags), true)
  assert.equal(Reflect.set(old.blocks[1], 'id', 'stolen'), false)
  assert.equal(Reflect.set(old, 'manifest', { kind: 'source-reconciliation', token: 'forged' }), false)
  const rows = readMarkdownSourceReconciliationManifest(old.manifest).outputs
  assert.equal(Reflect.set(rows[1].block, 'content', 'poison'), false)
  const descendant = edit(candidate, candidate.source.length, candidate.source.length, ' edited')
  const after = allocate(descendant, first.basis, noBirth)
  assert.equal(after.facts.blocks[1].id, id); assert.equal(after.facts.blocks[1].content, 'New edited')
  assert.throws(() => readCanonicalSourceAllocation({ kind: 'canonical-source-allocation' }))
  assert.throws(() => allocateCanonicalSourceDraft(descendant, { basis: { kind: 'source-allocation-basis' } }))
})

test('a new C identity survives descendant input without rewriting the original raw draft opening or anchors', () => {
  const { candidate, first, id } = born(), initialBlocks = candidate.initialBlocks, anchors = candidate.anchors
  const descendant = edit(candidate, candidate.source.length, candidate.source.length, ' after')
  const next = allocate(descendant, first.basis, noBirth)
  assert.deepEqual(next.facts.blocks.map(value => value.id), [' __proto__:旧 ', id])
  assert.equal(candidate.initialBlocks, initialBlocks); assert.equal(candidate.anchors, anchors)
  assert.equal(descendant.initialBlocks, initialBlocks); assert.equal(descendant.initialBlocks.some(value => value.id === id), false)
  const rows = readMarkdownSourceReconciliationManifest(next.facts.reconciliationManifest).outputs
  assert.equal(rows[1].allocationAnchor?.blockId, id)
  assert.equal(rows[1].anchor, null, 'A checkpoint row is not an invented openingIndex')
})

test('a checkpoint created after later input maps the original descendant raw edges without replaying input', () => {
  const initial = open(), a = replace(initial, 'Root\n\nNew'), b = edit(a, a.source.length, a.source.length, ' later')
  const bReceipt = readMarkdownSourceDraftReceipt(b), id = randomUUID(), first = allocate(a, undefined, () => id)
  const next = allocate(b, first.basis, noBirth)
  assert.equal(next.facts.blocks[1].id, id); assert.equal(next.facts.blocks[1].content, 'New later')
  assert.equal(readMarkdownSourceDraftReceipt(b), bReceipt)
  assert.equal(next.facts.draftReceipt, bReceipt)
})

test('first basis is immutable and a valid later basis cannot reallocate the same draft', () => {
  const { candidate, first } = born(), descendant = edit(candidate, candidate.source.length, candidate.source.length, ' later')
  const next = allocate(descendant, first.basis, noBirth)
  assert.throws(() => allocateCanonicalSourceDraft(descendant, { basis: next.basis, freshId: noBirth }), /first allocation basis/)
  assert.equal(allocateCanonicalSourceDraft(descendant, { basis: first.basis }), next.allocation)
  assert.equal(canonicalSourceDraftToBlocksWithManifest(descendant, noBirth).manifest, next.facts.reconciliationManifest)
})

test('sibling same-text drafts, copied DTOs and foreign openings cannot inherit another receipt allocation basis', () => {
  const initial = open(), left = replace(initial, 'Root\n\nNew'), right = replace(initial, 'Root\n\nNew')
  const first = allocate(left, undefined, () => randomUUID())
  assert.equal(left.source, right.source); assert.notEqual(readMarkdownSourceDraftReceipt(left), readMarkdownSourceDraftReceipt(right))
  assert.throws(() => allocateCanonicalSourceDraft(right, { basis: first.basis }), /ancestor/)
  assert.throws(() => allocateCanonicalSourceDraft({ ...left }))
  const other = replace(open(), left.source)
  assert.throws(() => allocateCanonicalSourceDraft(other, { basis: first.basis }), /another actual opening/)
  const next = allocate(right, undefined, () => randomUUID())
  assert.notEqual(first.facts.blocks[1].id, next.facts.blocks[1].id)
})

test('partial allocator failure is memoized across both cold entrypoints and never retries minted IDs', () => {
  const initial = open(), candidate = replace(initial, 'Root\n\nNew\n\nMore'), id = randomUUID(), failure = new Error('Allocator stopped')
  let calls = 0
  assert.throws(() => canonicalSourceDraftToBlocksWithManifest(candidate, () => { if (++calls === 1) return id; throw failure }), error => error === failure)
  assert.equal(calls, 2)
  assert.throws(() => allocateCanonicalSourceDraft(candidate, { freshId: () => { calls++; return randomUUID() } }), error => error === failure)
  assert.throws(() => canonicalSourceDraftToBlocksWithManifest(candidate, noBirth), error => error === failure)
  assert.equal(calls, 2)
  const sibling = replace(initial, 'Root\n\nDifferent')
  assert.throws(() => allocateCanonicalSourceDraft(sibling, { freshId: () => id }), /cannot be reissued/)
})

test('a freshId callback cannot reenter either cold entrypoint to allocate the same real draft twice', () => {
  const candidate = replace(open(), 'Root\n\nNew'), id = randomUUID()
  let calls = 0, rejected = 0
  const first = allocate(candidate, undefined, () => {
    calls++
    assert.throws(() => canonicalSourceDraftToBlocksWithManifest(candidate, () => { calls++; return randomUUID() }), /already being allocated/); rejected++
    assert.throws(() => allocateCanonicalSourceDraft(candidate), /already being allocated/); rejected++
    return id
  })
  assert.equal(calls, 1); assert.equal(rejected, 2); assert.equal(first.facts.blocks[1].id, id)
})

test('an actual parser callback reentry cannot create a second allocation and the installed rule is restored', () => {
  const candidate = replace(open(), 'Root\n\nNew'), rule = markdownEngine.core.ruler.__rules__.find(value => value.name === 'inline')!
  const original = rule.fn
  let entered = 0
  markdownEngine.core.ruler.at('inline', state => {
    original(state)
    if (state.src === candidate.source && !entered) {
      entered++
      assert.throws(() => allocateCanonicalSourceDraft(candidate), /already being allocated/)
    }
  })
  try { assert.equal(allocate(candidate, undefined, () => randomUUID()).facts.blocks.length, 2); assert.equal(entered, 1) }
  finally { markdownEngine.core.ruler.at('inline', original) }
  assert.equal(rule.fn, original)
})

test('real CodeMirror replay retains its original raw draft and allocated IDs across private Undo and Redo', () => {
  const initial = open(), opening = readMarkdownSourceDraftReceipt(initial).opening
  const session = createMarkdownSourceSession({ draft: initial, replaceChanges: (draft, changes) => replaceMarkdownSourceChanges(draft, [...changes]),
    validateDraft: draft => { assert.equal(readMarkdownSourceDraftReceipt(draft).opening, opening) } })
  let state = EditorState.create({ doc: markdownSourceEditorText(initial.source), extensions: session.extension })
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: 'Root\n\nNew' } }).state
  const a = session.read(state), first = allocate(a, undefined, () => randomUUID()), id = first.facts.blocks[1].id
  state = state.update({ changes: { from: state.doc.length, insert: ' later' } }).state
  const b = session.read(state), second = allocate(b, first.basis, noBirth)
  assert.equal(second.facts.blocks[1].id, id)
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: markdownSourceEditorText(a.source) }, annotations: session.replay.of(a) }).state
  assert.equal(session.read(state), a); assert.equal(allocateCanonicalSourceDraft(a), first.allocation)
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: markdownSourceEditorText(b.source) }, annotations: session.replay.of(b) }).state
  assert.equal(session.read(state), b); assert.equal(allocateCanonicalSourceDraft(b), second.allocation)
  assert.equal(readCanonicalSourceAllocation(second.allocation).blocks[1].id, id)
})

test('same-text raw replacement gets a distinct receipt and memo without erasing an existing block identity', () => {
  const { candidate, first, id } = born(), same = replace(candidate, candidate.source)
  assert.notEqual(same, candidate); assert.equal(same.source, candidate.source)
  const next = allocate(same, first.basis, noBirth)
  assert.notEqual(next.allocation, first.allocation)
  assert.notEqual(next.facts.draftReceipt, first.facts.draftReceipt)
  assert.equal(next.facts.blocks[1].id, id)
  // No link claim is produced here: same raw does not assert equal link intent.
  assert.equal(Object.hasOwn(next.facts, 'bindingClaims'), false)
})

test('real CM edits and replay keep mixed raw CRLF and UTF16 bytes in the descendant allocation path', () => {
  const initial = open(), raw = edit(initial, initial.source.length, initial.source.length, '\r\n\r\nNew🙂\r\ncontinued')
  const first = allocate(raw, undefined, () => randomUUID()), id = first.facts.blocks[1].id
  const session = createMarkdownSourceSession({ draft: raw, replaceChanges: (draft, changes) => replaceMarkdownSourceChanges(draft, [...changes]),
    validateDraft: draft => { assert.equal(readMarkdownSourceDraftReceipt(draft).opening, readMarkdownSourceDraftReceipt(raw).opening) } })
  let state = EditorState.create({ doc: markdownSourceEditorText(raw.source), extensions: session.extension })
  state = state.update({ changes: { from: state.doc.length, insert: '!' } }).state
  const next = session.read(state), allocation = allocate(next, first.basis, noBirth)
  assert.equal(next.source, raw.source + '!'); assert.ok(next.source.includes('🙂\r\ncontinued!'))
  assert.equal(allocation.facts.blocks[1].id, id)
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: markdownSourceEditorText(raw.source) }, annotations: session.replay.of(raw) }).state
  assert.equal(session.read(state), raw); assert.equal(allocateCanonicalSourceDraft(raw), first.allocation)
})

test('actual split and join reuse the same walker and claim each source identity at most once', () => {
  const { candidate, first, id } = born(), split = edit(candidate, candidate.source.length, candidate.source.length, '\n\nSecond'), secondId = randomUUID()
  const second = allocate(split, first.basis, () => secondId)
  assert.deepEqual(second.facts.blocks.map(value => value.id), [' __proto__:旧 ', id, secondId])
  const separator = split.source.lastIndexOf('\n\n'), joined = edit(split, separator, separator + 2, ' ')
  const final = allocate(joined, second.basis, noBirth)
  assert.deepEqual(final.facts.blocks.map(value => value.id), [' __proto__:旧 ', id])
  assert.equal(final.facts.blocks[1].content, 'New Second')
})

test('disjoint original-coordinate formatting maps allocation anchors without mutating changes or opening metadata', () => {
  const { candidate, first, id } = born(), at = candidate.source.indexOf('New')
  const changes = [{ from: at + 3, to: at + 3, insert: '**' }, { from: at, to: at, insert: '**' }], before = structuredClone(changes)
  const formatted = replaceMarkdownSourceChanges(candidate, changes), next = allocate(formatted, first.basis, noBirth)
  assert.equal(next.facts.blocks[1].id, id); assert.equal(next.facts.blocks[1].content, '**New**')
  assert.deepEqual(next.facts.blocks[0].tags, ['保留']); assert.equal(next.facts.blocks[0].highlight, 'yellow')
  assert.deepEqual(changes, before)
})

test('allocation projections preserve original UTF16 CRLF units through retained raw and reject half-CRLF claims', () => {
  const raw = 'a🙂\r\nb', initial = open([block(' old:正文 ', raw), block('tail', 'Tail')]), first = allocate(initial)
  const span = projectSourceAllocationContentRange(first.basis, 0, 3, 5)
  assert.ok(span); assert.equal(initial.source.slice(span.from, span.to), '\n')
  assert.deepEqual(projectSourceAllocationRawRange(first.basis, 0, span.from, span.to), { from: 3, to: 5 })
  assert.equal(projectSourceAllocationContentRange(first.basis, 0, 3, 4), null)
  const at = initial.source.lastIndexOf('Tail'), next = allocate(edit(initial, at, at + 4, 'Tail edited'), first.basis, noBirth)
  assert.equal(next.facts.blocks[0].content, raw); assert.equal(next.facts.blocks[0].id, ' old:正文 ')
  const moved = projectSourceAllocationContentRange(next.basis, 0, 3, 5)
  assert.ok(moved); assert.deepEqual(projectSourceAllocationRawRange(next.basis, 0, moved.from, moved.to), { from: 3, to: 5 })
})

test('native containers and column forests preserve actual IDs weights metadata and parsed parent relationships', () => {
  const blocks: SyncedCanonicalEdit[] = [
    { ...block('columns', ''), type: 'columns' },
    { ...block('left', ''), type: 'column', depth: 1, parentBlockId: 'columns', markdownFormat: { columnWeight: 4000 } },
    { ...block(' left:🙂 ', 'Left'), depth: 2, parentBlockId: 'left' },
    { ...block('right', ''), type: 'column', depth: 1, parentBlockId: 'columns', markdownFormat: { columnWeight: 6000 } },
    { ...block('right-child', 'Right'), depth: 2, parentBlockId: 'right' }, block('tail', 'Tail')
  ]
  const initial = open(blocks), first = allocate(initial), at = initial.source.lastIndexOf('Tail')
  const next = allocate(edit(initial, at, at + 4, 'Tail edited'), first.basis, noBirth)
  assert.deepEqual(next.facts.blocks.map(value => [value.id, value.parentBlockId, value.depth]), blocks.map(value => [value.id, value.parentBlockId, value.depth]))
  assert.equal(next.facts.blocks[1].markdownFormat?.columnWeight, 4000); assert.equal(next.facts.blocks[3].markdownFormat?.columnWeight, 6000)
  assert.deepEqual(next.facts.blocks[2].tags, ['保留'])
})

test('actual empty-created raw document alone has a dedicated slot and keeps its new ID after typing', () => {
  const initial = open(), empty = replace(initial, ''), id = randomUUID(), first = allocate(empty, undefined, () => id)
  assert.equal(readMarkdownSourceReconciliationManifest(first.facts.reconciliationManifest).outputs[0].sourceRange, null)
  assert.deepEqual(projectSourceAllocationContentRange(first.basis, 0, 0, 0), { from: 0, to: 0 })
  const typed = edit(empty, 0, 0, '汉🙂'), next = allocate(typed, first.basis, noBirth)
  assert.equal(next.facts.blocks[0].id, id); assert.equal(next.facts.blocks[0].content, '汉🙂')
})

test('nonempty whitespace null-range C remains blocked for allocation basis while the ordinary path keeps its old behavior', () => {
  const initial = open(), whitespace = replace(initial, ' \n\t '), id = randomUUID()
  let calls = 0
  const old = canonicalSourceDraftToBlocksWithManifest(whitespace, () => { calls++; return id })
  assert.equal(old.blocks[0].id, id); assert.equal(old.blocks[0].content, '')
  assert.throws(() => allocateCanonicalSourceDraft(whitespace, { freshId: noBirth }), /no proven empty-document slot/)
  assert.throws(() => allocateCanonicalSourceDraft(whitespace), /no proven empty-document slot/)
  assert.equal(calls, 1)
  const ordinaryDraft = replace(createCanonicalSourceDraft([block('ordinary', 'Root')]), ' \n\t ')
  const ordinary = canonicalSourceDraftToBlocks(ordinaryDraft, () => randomUUID())
  assert.equal(ordinary.length, 1); assert.equal(ordinary[0].content, '')
})

test('invalid option capabilities or accessors cannot execute the allocator or poison a later valid allocation', () => {
  const candidate = replace(open(), 'Root\n\nNew')
  let calls = 0
  const accessor = Object.defineProperty({}, 'freshId', { enumerable: true, get: () => { calls++; return () => randomUUID() } })
  assert.throws(() => allocateCanonicalSourceDraft(candidate, accessor), /closed own data/)
  assert.throws(() => allocateCanonicalSourceDraft(candidate, { basis: { kind: 'source-allocation-basis' } }), /Unknown/)
  assert.equal(calls, 0)
  const valid = allocate(candidate, undefined, () => { calls++; return randomUUID() })
  assert.equal(calls, 1); assert.equal(valid.facts.blocks.length, 2)
})

test('new syntax and later retained syntax have exact bidirectional payload-to-raw projections for repeated destinations', () => {
  const initial = open(), raw = replace(initial, 'Root\n\n[a](Target.md) and [b](Target.md)')
  const first = allocate(raw, undefined, () => randomUUID()), content = first.facts.blocks[1].content
  const offsets = [content.indexOf('Target.md'), content.lastIndexOf('Target.md')]
  assert.notEqual(offsets[0], offsets[1])
  for (const from of offsets) {
    const span = projectSourceAllocationContentRange(first.basis, 1, from, from + 9)
    assert.ok(span); assert.equal(raw.source.slice(span.from, span.to), 'Target.md')
    assert.deepEqual(projectSourceAllocationRawRange(first.basis, 1, span.from, span.to), { from, to: from + 9 })
  }
  const tail = edit(raw, 0, 4, 'Root changed'), second = allocate(tail, first.basis, noBirth)
  assert.equal(second.facts.blocks[1].id, first.facts.blocks[1].id)
  for (const from of offsets) {
    const span = projectSourceAllocationContentRange(second.basis, 1, from, from + 9)
    assert.ok(span); assert.equal(tail.source.slice(span.from, span.to), 'Target.md')
    assert.deepEqual(projectSourceAllocationRawRange(second.basis, 1, span.from, span.to), { from, to: from + 9 })
  }
})
