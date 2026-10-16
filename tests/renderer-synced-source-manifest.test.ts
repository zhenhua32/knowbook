import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { SyncedCanonicalEdit, SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import { parseMarkdownSourceStrict } from '../src/shared/markdownSource'
import { serializeMarkdownWithEmissionTrace } from '../src/shared/markdownEmissionTrace'
import { serializeSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import { createMarkdownSourceDraft, replaceMarkdownSource, replaceMarkdownSourceChanges } from '../src/renderer/src/utils/markdownSourceDraft'
import { createCanonicalSourceDraft } from '../src/renderer/src/features/synced-blocks/canonicalSource'
import { createCanonicalSourceDraftWithManifest, createMarkdownSourceDraftWithManifest, canonicalSourceDraftToBlocksWithManifest,
  reconcileMarkdownSourceDraftWithManifest, readMarkdownSourceOpeningManifest, readMarkdownSourceDraftReceipt,
  readMarkdownSourceReconciliationManifest, projectOpeningContentRange, projectOpeningSourceRange } from '../src/renderer/src/features/synced-blocks/sourceManifest'

const block = (id: string, content: string, depth = 0, parentBlockId: string | null = null): SyncedCanonicalEdit =>
  ({ id, type: 'paragraph', content, checked: false, depth, parentBlockId, tags: ['保留'], highlight: 'yellow' })

test('default Source keeps its fields and same-text pointer while the cold serializer receives original CRLF content', () => {
  const original = [block(' 旧:🙂 ', '😀\r\n[link](Target.md)')], before = structuredClone(original)
  const ordinary = createCanonicalSourceDraft(original)
  assert.deepEqual(Object.keys(ordinary).sort(), ['anchors', 'initialBlocks', 'initialSource', 'source'])
  assert.equal(replaceMarkdownSource(ordinary, { from: 0, to: 2, insert: ordinary.source.slice(0, 2) }), ordinary)
  let calls = 0
  const actual = createMarkdownSourceDraft(original, raw => {
    calls++
    assert.equal(raw, original)
    assert.equal(raw[0].content, before[0].content)
    return serializeMarkdownWithEmissionTrace(raw, { normalizeLineEndings: true })
  })
  assert.equal(calls, 1)
  assert.equal(actual.source, ordinary.source)
  assert.deepEqual(original, before)
})

test('the opening same-invocation trace composes original CRLF UTF16 content with absolute Source positions in both directions', () => {
  const content = '😀\r\n[中文](Target.md)\r\nTail', { draft, openingManifest } = createCanonicalSourceDraftWithManifest([block('raw', content)])
  const facts = readMarkdownSourceOpeningManifest(openingManifest)
  assert.equal(facts.blocks[0].content, content)
  assert.equal(facts.contentTraces[0].content, content)
  assert.equal(facts.source, draft.source)
  const from = content.indexOf('Target.md'), source = projectOpeningContentRange(openingManifest, 0, from, from + 9)
  assert.ok(source)
  assert.equal(draft.source.slice(source.from, source.to), 'Target.md')
  assert.deepEqual(projectOpeningSourceRange(openingManifest, 0, source.from, source.to), { from, to: from + 9 })
  const newline = projectOpeningContentRange(openingManifest, 0, 2, 4)
  assert.ok(newline)
  assert.equal(draft.source.slice(newline.from, newline.to), '\n')
  assert.deepEqual(projectOpeningSourceRange(openingManifest, 0, newline.from, newline.to), { from: 2, to: 4 })
  assert.equal(projectOpeningContentRange(openingManifest, 0, 2, 3), null, 'Half a CRLF is not an exact unit')
  assert.equal(projectOpeningContentRange(openingManifest, 0, 3, 4), null)
})

test('a changed tail records the actual retained multi-syntax grouping and preserves its original raw CRLF bytes', () => {
  const raw = '# Heading\r\n\r\n- Item', initial = [block(' multi ', raw), block('tail', 'Tail')]
  const { draft } = createCanonicalSourceDraftWithManifest(initial), from = draft.source.lastIndexOf('Tail')
  const candidate = replaceMarkdownSourceChanges(draft, [{ from, to: from + 4, insert: 'Tail edited' }])
  const result = canonicalSourceDraftToBlocksWithManifest(candidate, () => { throw new Error('No new IDs expected') })
  assert.equal(result.blocks[0].content, raw)
  const facts = readMarkdownSourceReconciliationManifest(result.manifest)
  assert.deepEqual(facts.outputs.map(output => output.kind), ['retained', 'syntax'])
  assert.deepEqual(facts.outputs[0].syntaxIndices, [0, 1])
  assert.deepEqual(facts.syntaxToOutput, [0, 0, 1])
  assert.equal(facts.outputs[0].anchor?.openingIndex, 0)
  assert.equal(facts.outputs[0].anchor?.blockId, ' multi ')
  assert.equal(facts.outputs[1].anchor?.openingIndex, 1)
  assert.deepEqual(facts.sortPermutation, [0, 1])
})

test('actual syntax split claims a surviving ordinary anchor once and assigns the existing allocator only once to the other output', () => {
  const { draft } = createCanonicalSourceDraftWithManifest([block('original', 'Before')]), id = randomUUID()
  const candidate = replaceMarkdownSource(draft, { from: 0, to: draft.source.length, insert: 'Same\n\nSame' })
  let births = 0
  const result = canonicalSourceDraftToBlocksWithManifest(candidate, () => { births++; return id })
  assert.equal(births, 1)
  assert.deepEqual(result.blocks.map(output => output.id), ['original', id])
  const facts = readMarkdownSourceReconciliationManifest(result.manifest)
  assert.deepEqual(facts.outputs.map(output => output.kind), ['syntax', 'syntax'])
  assert.deepEqual(facts.outputs.map(output => output.anchor?.blockId ?? null), ['original', null])
  assert.deepEqual(facts.outputs.map(output => output.syntaxIndices), [[0], [1]])
})

test('actual empty retention sorting records its push ordinal and the current syntax parent without reparenting by old ID', () => {
  const initial = [{ ...block('owner', 'Title'), type: 'callout' }, block('child', 'Child', 1, 'owner'), block('empty', '', 1, 'owner'), block('tail', 'Tail')]
  const { draft } = createCanonicalSourceDraftWithManifest(initial), from = draft.source.lastIndexOf('Tail')
  const changed = replaceMarkdownSource(draft, { from, to: from + 4, insert: 'Tail edited' })
  const result = canonicalSourceDraftToBlocksWithManifest(changed, () => { throw new Error('No new IDs expected') })
  const facts = readMarkdownSourceReconciliationManifest(result.manifest), empty = facts.outputs[2]
  assert.deepEqual(result.blocks.map(output => output.id), ['owner', 'child', 'empty', 'tail'])
  assert.equal(empty.kind, 'empty-retained')
  assert.equal(empty.anchor?.openingIndex, 2)
  assert.deepEqual(facts.sortPermutation, [0, 1, 3, 2])
  assert.deepEqual(empty.parent, { kind: 'syntax', syntaxIndex: 0, outputIndex: 0, blockId: 'owner' })
  assert.equal(result.blocks[2].parentBlockId, 'owner')
})

test('whole deletion observes the explicit frontend empty creation with no invented Source range or anchor', () => {
  const { draft } = createCanonicalSourceDraftWithManifest([block('old', 'Body')]), id = randomUUID()
  const deleted = replaceMarkdownSource(draft, { from: 0, to: draft.source.length, insert: '' })
  let births = 0
  const result = canonicalSourceDraftToBlocksWithManifest(deleted, () => { births++; return id })
  assert.equal(births, 1)
  const facts = readMarkdownSourceReconciliationManifest(result.manifest)
  assert.deepEqual(facts.outputs.map(output => output.kind), ['empty-created'])
  assert.equal(facts.outputs[0].block.id, id)
  assert.equal(facts.outputs[0].sourceRange, null)
  assert.equal(facts.outputs[0].anchor, null)
  assert.deepEqual(facts.outputs[0].parent, { kind: 'created', blockId: null })
  assert.deepEqual(facts.syntaxToOutput, [])
})

test('the actual ref output branch records its exact proof key and never claims the ordinary literal anchor', () => {
  const payload = serializeSyncedBlockPayload({ version: 1, groupId: randomUUID() }), id = randomUUID()
  const fence = '```knowbook-synced-block-v1\n' + payload + '\n```'
  const { draft } = createMarkdownSourceDraftWithManifest([block('ordinary-literal', fence)])
  const reference: SyncedStableBlockDraft = { ...block(id, payload), type: 'synced-block' }
  const result = reconcileMarkdownSourceDraftWithManifest(draft,
    { mode: 'internal-host', references: [{ key: 'actual-ref', from: 0, to: fence.length, payload }] }, { references: new Map([['actual-ref', reference]]) })
  const facts = readMarkdownSourceReconciliationManifest(result.manifest)
  assert.equal(facts.outputs[0].kind, 'ref')
  assert.equal(facts.outputs[0].referenceKey, 'actual-ref')
  assert.equal(facts.outputs[0].block.id, id)
  assert.equal(facts.outputs[0].anchor, null)
  assert.deepEqual(facts.syntaxToOutput, [0])
})

test('unchanged fast-path facts are cold retained observations and do not erase same-text replacement candidates', () => {
  const { draft } = createCanonicalSourceDraftWithManifest([block('unchanged', '[a](Target.md)')])
  const initialReceipt = readMarkdownSourceDraftReceipt(draft), raw = { from: 0, to: draft.source.length, insert: draft.source }
  const first = replaceMarkdownSourceChanges(draft, [raw]), second = replaceMarkdownSourceChanges(draft, [raw])
  assert.notEqual(first, draft)
  assert.notEqual(second, first)
  assert.equal(first.source, draft.source)
  const firstReceipt = readMarkdownSourceDraftReceipt(first), secondReceipt = readMarkdownSourceDraftReceipt(second)
  assert.deepEqual(readMarkdownSourceDraftReceipt(draft), initialReceipt)
  assert.equal(initialReceipt.revision, 0)
  assert.deepEqual(initialReceipt.rawChanges, [])
  assert.equal(firstReceipt.revision, 1)
  assert.equal(secondReceipt.revision, 1, 'Repeated filtering creates independent candidates, not two accepted edits')
  assert.notEqual(firstReceipt.token, secondReceipt.token)
  assert.deepEqual(firstReceipt.rawChanges, [raw])
  const result = canonicalSourceDraftToBlocksWithManifest(first, () => { throw new Error('No new identity expected') })
  const facts = readMarkdownSourceReconciliationManifest(result.manifest)
  assert.equal(facts.outputs[0].basis, 'opening')
  assert.equal(facts.outputs[0].kind, 'retained')
  assert.equal(facts.draftReceipt, firstReceipt)
})

test('true empty edits retain the cold before pointer and invalid raw batches cannot change its observation receipt', () => {
  const { draft } = createCanonicalSourceDraftWithManifest([block('noop', 'Body')]), before = readMarkdownSourceDraftReceipt(draft)
  assert.equal(replaceMarkdownSourceChanges(draft, []), draft)
  assert.equal(replaceMarkdownSource(draft, { from: 1, to: 1, insert: '' }), draft)
  assert.equal(replaceMarkdownSourceChanges(draft, [{ from: 1, to: 1, insert: '' }]), draft)
  for (const changes of [[{ from: Number.NaN, to: Number.NaN, insert: '' }], [{ from: 0, to: 2, insert: 'Bo' }, { from: 1, to: 3, insert: 'od' }],
    [{ from: 1, to: 1, insert: '' }, { from: 1, to: 1, insert: '' }]]) {
    assert.throws(() => replaceMarkdownSourceChanges(draft, changes))
    assert.equal(readMarkdownSourceDraftReceipt(draft), before)
  }
})

test('opaque manifests freeze only privately allocated snapshots and never freeze or modify caller blocks or draft handles', () => {
  const blocks = [block('mutable-caller', 'Body')], { draft, openingManifest } = createCanonicalSourceDraftWithManifest(blocks)
  const facts = readMarkdownSourceOpeningManifest(openingManifest)
  assert.equal(Object.isFrozen(blocks[0]), false)
  assert.equal(Object.isFrozen(blocks[0].tags), false)
  assert.equal(Object.isFrozen(draft), false)
  assert.equal(Object.isFrozen(draft.initialBlocks), true)
  assert.equal(Object.isFrozen(draft.anchors[0]), true)
  assert.ok(Object.isFrozen(facts) && Object.isFrozen(facts.blocks) && Object.isFrozen(facts.blocks[0]) && Object.isFrozen(facts.anchors[0]))
  assert.equal(Reflect.set(facts.blocks[0], 'content', 'poison'), false)
  assert.throws(() => readMarkdownSourceOpeningManifest({ ...openingManifest }))
  const result = canonicalSourceDraftToBlocksWithManifest(draft), reconciled = readMarkdownSourceReconciliationManifest(result.manifest)
  assert.ok(Object.isFrozen(reconciled.outputs) && Object.isFrozen(reconciled.outputs[0].block))
  assert.equal(Reflect.set(reconciled.outputs[0].block, 'id', 'stolen'), false)
})

test('forged drafts, copied anchors and post-capture metadata changes cannot receive reconciliation or current projection authority', () => {
  const fresh = () => createCanonicalSourceDraftWithManifest([block('receipt', 'Body')]).draft
  const original = fresh()
  assert.throws(() => canonicalSourceDraftToBlocksWithManifest({ ...original }))
  const copied = fresh()
  copied.anchors = [{ ...copied.anchors[0] }]
  assert.throws(() => readMarkdownSourceDraftReceipt(copied))
  const changed = fresh()
  assert.equal(Reflect.set(changed.initialBlocks[0], 'content', 'Poison'), false)
  changed.initialBlocks = [{ ...changed.initialBlocks[0], content: 'Poison' }]
  assert.throws(() => replaceMarkdownSource(changed, { from: 0, to: 1, insert: 'x' }))
  const extra = fresh()
  const forged = { ...extra.initialBlocks[0] }
  Reflect.set(forged, 'foreignAuthority', undefined)
  extra.initialBlocks = [forged]
  assert.throws(() => canonicalSourceDraftToBlocksWithManifest(extra))
  const anchor = fresh()
  assert.equal(Reflect.set(anchor.anchors[0], 'original', 'Different'), false)
  anchor.anchors = [{ ...anchor.anchors[0], original: 'Different' }]
  assert.throws(() => canonicalSourceDraftToBlocksWithManifest(anchor))
})

test('generic cold openings reject repeated original object occurrences while the ordinary entry keeps its established behavior', () => {
  const reused = block('reused', 'Same'), blocks = [reused, reused]
  assert.equal(createMarkdownSourceDraft(blocks).anchors.length, 2)
  assert.throws(() => createMarkdownSourceDraftWithManifest(blocks), /Repeated original block/)
  assert.equal(Object.isFrozen(reused), false)
})

test('private opening and anchor arrays reject custom iterators, symbolic properties and extra undefined fields without changing their facts', () => {
  const { draft } = createCanonicalSourceDraftWithManifest([block('safe-array', 'Body')]), before = readMarkdownSourceDraftReceipt(draft)
  const forgedIterator = function * () { yield block('foreign', 'Foreign') }
  assert.equal(Reflect.defineProperty(draft.initialBlocks, Symbol.iterator, { value: forgedIterator }), false)
  assert.equal(Reflect.defineProperty(draft.anchors, Symbol.iterator, { value: forgedIterator }), false)
  assert.equal(Reflect.set(draft.initialBlocks, 'extraAuthority', undefined), false)
  assert.equal(Reflect.set(draft.anchors, Symbol('authority'), 'foreign'), false)
  assert.equal(Reflect.setPrototypeOf(draft.initialBlocks, null), false)
  assert.equal(readMarkdownSourceDraftReceipt(draft), before)
  assert.equal(canonicalSourceDraftToBlocksWithManifest(draft).blocks[0].id, 'safe-array')
  const caller = [block('caller', 'Body')]
  Reflect.defineProperty(caller, Symbol.iterator, { value: forgedIterator })
  assert.throws(() => createCanonicalSourceDraftWithManifest(caller), /plain dense input array/)
  const extra = [block('caller', 'Body')]
  Reflect.set(extra, 'extraAuthority', undefined)
  assert.throws(() => createCanonicalSourceDraftWithManifest(extra), /plain dense input array/)
})

test('cold reconciliation invokes its own current-raw parser and rejects foreign structured parsed results as options', () => {
  const { draft } = createCanonicalSourceDraftWithManifest([block('before', 'Before')])
  const candidate = replaceMarkdownSource(draft, { from: 0, to: draft.source.length, insert: 'Actual changed' })
  const foreign = parseMarkdownSourceStrict('Foreign', { mode: 'canonical' })
  assert.throws(() => Reflect.apply(reconcileMarkdownSourceDraftWithManifest, undefined, [candidate, foreign]))
  const result = reconcileMarkdownSourceDraftWithManifest(candidate, { mode: 'canonical' })
  assert.equal(result.blocks[0].content, 'Actual changed')
  assert.equal(result.syntax.blocks[0].content, 'Actual changed')
  assert.ok(Object.isFrozen(result.syntax) && Object.isFrozen(result.syntax.blocks))
})

test('cold edits consume one data-only snapshot and reject caller getters or array methods before producing candidate facts', () => {
  const { draft } = createCanonicalSourceDraftWithManifest([block('snapshot', 'Body')]), before = readMarkdownSourceDraftReceipt(draft)
  let reads = 0
  const getter = { from: 0, to: 1, get insert() { reads++; return reads === 1 ? 'X' : 'Y' } }
  assert.throws(() => replaceMarkdownSource(draft, getter), /Invalid raw source change/)
  assert.equal(reads, 0, 'A rejected accessor is never evaluated to construct either text or a receipt')
  assert.throws(() => replaceMarkdownSourceChanges(draft, [getter]), /Invalid raw source change/)
  assert.equal(reads, 0)
  let methodCalls = 0
  const methods = [{ from: 0, to: 1, insert: 'X' }]
  Reflect.defineProperty(methods, 'toSorted', { value: () => { methodCalls++; return [] } })
  assert.throws(() => replaceMarkdownSourceChanges(draft, methods), /plain dense data array/)
  const iterable = [{ from: 0, to: 1, insert: 'X' }]
  Reflect.defineProperty(iterable, Symbol.iterator, { value: function * () { methodCalls++; yield { from: 0, to: 1, insert: 'Y' } } })
  assert.throws(() => replaceMarkdownSourceChanges(draft, iterable), /plain dense data array/)
  assert.equal(methodCalls, 0)
  assert.equal(draft.source, 'Body')
  assert.equal(readMarkdownSourceDraftReceipt(draft), before)
  const ordinary = { from: 0, to: 1, insert: 'X' }, candidate = replaceMarkdownSource(draft, ordinary)
  ordinary.insert = 'Y'
  assert.equal(candidate.source, 'Xody')
  assert.deepEqual(readMarkdownSourceDraftReceipt(candidate).rawChanges, [{ from: 0, to: 1, insert: 'X' }])
  assert.equal(Object.isFrozen(ordinary), false)
})
