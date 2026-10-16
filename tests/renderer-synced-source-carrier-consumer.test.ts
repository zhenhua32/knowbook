import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { EditorState } from '@codemirror/state'
import { markdownEngine } from '../src/shared/markdownEngine'
import { observeMarkdownSourceCarriers } from '../src/shared/markdownSourceCarriers'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import type { SyncedCanonicalEdit, SyncedOriginV1 } from '../src/shared/synced-blocks'
import { markdownSourceEditorText } from '../src/renderer/src/utils/markdownSourceSession'
import { openCanonicalSourceLedger, forkCanonicalSourceLedger, prepareCanonicalSourceFirstApply, readPreparedSourceFirstApply,
  readCanonicalSourceLedgerCandidate, createCanonicalSourceLedgerSession, type SourceFirstApplyLease,
  type SourceLedgerDraft, type PreparedSourceFirstApplyFacts } from '../src/renderer/src/features/synced-blocks/sourceLedger'

const origin: SyncedOriginV1 = { version: 1, documentId: 'origin', pathAtCreation: 'Folder/Host', firstInstanceId: randomUUID() }
function open(content: string) {
  const groupId = randomUUID(), lease: SourceFirstApplyLease = { expectedEditSequence: 7,
    scope: { groupId, hostDocumentId: 'host', windowSessionId: 'window', hostSession: {}, mountEpoch: {}, bindingEpoch: {},
      instanceId: randomUUID(), bindingVersion: randomUUID() },
    guards: { groupId, expectedRevision: randomUUID(), expectedTopologyRevision: randomUUID() } }
  const block: SyncedCanonicalEdit = { id: ' 旧:正文🙂 ', type: 'paragraph', content, checked: false, depth: 0,
    parentBlockId: null, tags: ['keep', '旧'], highlight: 'yellow' }
  return { ...openCanonicalSourceLedger({ blocks: [block], origin, lease }), lease, block }
}
function prepare(draft: SourceLedgerDraft, lease: SourceFirstApplyLease): PreparedSourceFirstApplyFacts {
  const result = readPreparedSourceFirstApply(prepareCanonicalSourceFirstApply({ draft, lease }))
  const links = collectDocumentMarkdownLinks([...result.blocks]).filter(link => link.kind !== 'image')
  assert.equal(result.bindingClaims.length, links.length)
  for (let index = 0; index < links.length; index++) {
    const link = links[index], key = result.bindingClaims[index].destination, block = result.blocks[link.blockIndex]
    assert.deepEqual(key, { blockId: block.id, from: link.start, to: link.end, raw: block.content.slice(link.start, link.end),
      syntax: link.kind === 'wiki' ? 'wiki' : 'markdown' })
    assert.equal('target' in result.bindingClaims[index], false)
  }
  return result
}
function edit(draft: SourceLedgerDraft, text: string, insert: string, offset = 0) {
  const from = draft.source.indexOf(text, offset)
  assert.ok(from >= 0)
  return forkCanonicalSourceLedger(draft, [{ from, to: from + text.length, insert }])
}

test('disjoint label edits retain separate duplicate-href opening keys and all original block metadata', () => {
  const value = open('before [first](Same.md) middle [second](Same.md) after'), text = value.draft.source
  const draft = forkCanonicalSourceLedger(value.draft, [{ from: text.indexOf('first'), to: text.indexOf('first') + 5, insert: '甲🙂' },
    { from: text.indexOf('second'), to: text.indexOf('second') + 6, insert: '乙' }]), result = prepare(draft, value.lease)
  assert.deepEqual(result.bindingClaims.map(claim => claim.kind), ['continue', 'continue'])
  const sources = result.bindingClaims.flatMap(claim => claim.kind === 'continue' ? [claim.source] : [])
  assert.deepEqual(sources.map(key => key.from), [value.block.content.indexOf('Same.md'), value.block.content.lastIndexOf('Same.md')])
  assert.notEqual(sources[0].from, sources[1].from)
  assert.equal(result.blocks[0].id, value.block.id); assert.deepEqual(result.blocks[0].tags, value.block.tags)
  assert.equal(result.blocks[0].highlight, value.block.highlight); assert.equal(result.blocks[0].parentBlockId, null)
})

test('consumed direct title body, including same bytes, continues the exact old destination source', () => {
  const value = open('[x](Target.md "old title")')
  for (const insert of ['new 😀 title', 'old title']) {
    const draft = edit(value.draft, 'old title', insert), result = prepare(draft, value.lease), claim = result.bindingClaims[0]
    assert.equal(claim.kind, 'continue')
    if (claim.kind !== 'continue') throw new Error('Title must not rebind the destination')
    assert.equal(claim.source.raw, 'Target.md'); assert.equal(claim.source.from, value.block.content.indexOf('Target.md'))
    assert.notEqual(readCanonicalSourceLedgerCandidate(draft).receipt, readCanonicalSourceLedgerCandidate(value.draft).receipt)
  }
})

test('empty display and consumed empty title have certified insertion boundaries without rebinding an empty destination', () => {
  const value = open('[](<> "")'), first = value.draft.source.indexOf('[]') + 1, title = value.draft.source.indexOf('""') + 1
  const draft = forkCanonicalSourceLedger(value.draft, [{ from: first, to: first, insert: 'label' }, { from: title, to: title, insert: 'title' }])
  const result = prepare(draft, value.lease), claim = result.bindingClaims[0]
  assert.equal(claim.kind, 'continue'); assert.equal(claim.destination.raw, '')
  assert.equal(result.blocks[0].content, '[label](<> "title")')
})

test('sequential destination insertions, deletions and emptying each have a new receipt-bound generation', () => {
  const value = open('[x]()'), drafts = [value.draft]
  let draft = value.draft
  const point = draft.source.indexOf('()') + 1
  for (const change of [{ from: point, to: point, insert: 'T.md' }, { from: point + 1, to: point + 1, insert: 'a' },
    { from: point, to: point + 1, insert: 'N' }, { from: point, to: point + 5, insert: '' }]) {
    const before = readCanonicalSourceLedgerCandidate(draft)
    draft = forkCanonicalSourceLedger(draft, [change]); drafts.push(draft)
    const facts = readCanonicalSourceLedgerCandidate(draft), result = prepare(draft, value.lease)
    assert.equal(facts.beforeReceipt, before.receipt); assert.notEqual(facts.receipt.token, before.receipt.token)
    assert.equal(result.bindingClaims[0].kind, 'new'); assert.equal(result.hasIntent, true)
  }
  assert.equal(draft.source, value.draft.source)
  assert.equal(prepare(value.draft, value.lease).bindingClaims[0].kind, 'continue')
  assert.equal(prepare(drafts[1], value.lease).bindingClaims[0].destination.raw, 'T.md')
})

test('same-byte partial destination consumption is new even though same-byte display/title consumption continues', () => {
  const value = open('[label](Target.md "title")'), at = value.draft.source.indexOf('Target.md')
  const destination = forkCanonicalSourceLedger(value.draft, [{ from: at, to: at + 1, insert: 'T' }])
  assert.equal(destination.source, value.draft.source)
  assert.equal(prepare(destination, value.lease).bindingClaims[0].kind, 'new')
  assert.equal(prepare(edit(value.draft, 'label', 'label'), value.lease).bindingClaims[0].kind, 'continue')
  assert.equal(prepare(edit(value.draft, 'title', 'title'), value.lease).bindingClaims[0].kind, 'continue')
})

test('full-reference display edits change no physical definition generation or first-definition relation', () => {
  const value = open('[a][r] [b][r]\n\n[r]: Same.md\n\n[r]: Other.md'), a = value.draft.source.indexOf('[a]') + 1,
    b = value.draft.source.indexOf('[b]') + 1
  const draft = forkCanonicalSourceLedger(value.draft, [{ from: a, to: a + 1, insert: '甲' }, { from: b, to: b + 1, insert: '乙🙂' }])
  const result = prepare(draft, value.lease)
  assert.deepEqual(result.bindingClaims.map(claim => claim.kind), ['continue', 'continue'])
  assert.deepEqual(result.bindingClaims.map(claim => claim.destination.raw), ['Same.md', 'Other.md'])
  assert.equal(result.blocks.map(block => block.content).join('\n\n').includes('[甲][r] [乙🙂][r]'), true)
})

test('partial collapsed/shortcut combined labels and explicit selectors remain protected rather than borrowing unchanged definitions', () => {
  for (const use of ['[r][]', '[r]', '[a][r]']) {
    const value = open(use + '\n\n[r]: Same.md\n\n[q]: Same.md'), at = value.draft.source.indexOf('r')
    const draft = forkCanonicalSourceLedger(value.draft, [{ from: at, to: at + 1, insert: 'q' }])
    assert.throws(() => prepare(draft, value.lease), /reference use.*carrier.*未生成来源声明/)
    assert.equal(value.draft.source.startsWith(use), true)
  }
})

test('explicit whole-reference insertion proves a fresh use relation but does not invent physical copy/new keys', () => {
  const value = open('[a][r]\n\n[r]: One.md\n\n[q]: Two.md')
  const draft = forkCanonicalSourceLedger(value.draft, [{ from: 0, to: '[a][r]'.length, insert: '[a][q]' }])
  const result = prepare(draft, value.lease)
  assert.deepEqual(result.bindingClaims.map(claim => claim.kind), ['continue', 'continue'])
  assert.equal(result.bindingClaims.length, 2)
})

test('partial active definition destination edits birth one physical key for all uses and preserve the inactive definition source', () => {
  const value = open('[r]: Target.md\n\n[r]: Other.md\n\n[a][r] [b][r]'), at = value.draft.source.indexOf('Target.md')
  const draft = forkCanonicalSourceLedger(value.draft, [{ from: at, to: at + 1, insert: 'N' }]), result = prepare(draft, value.lease)
  assert.deepEqual(result.bindingClaims.map(claim => claim.kind), ['new', 'continue'])
  assert.deepEqual(result.bindingClaims.map(claim => claim.destination.raw), ['Narget.md', 'Other.md'])
})

test('a display edit and its own definition destination edit in one actual batch share one newly born physical key', () => {
  const value = open('[a][r]\n\n[r]: Old.md'), destination = value.draft.source.indexOf('Old.md')
  const draft = forkCanonicalSourceLedger(value.draft, [{ from: 1, to: 2, insert: 'display' },
    { from: destination, to: destination + 1, insert: 'N' }]), result = prepare(draft, value.lease)
  assert.equal(result.bindingClaims.length, 1)
  assert.equal(result.bindingClaims[0].kind, 'new')
  assert.equal(result.bindingClaims[0].destination.raw, 'Nld.md')
})

test('definition title and label edits have no permission from the actual destination-only carrier', () => {
  const value = open('[r]: Target.md "title"\n\n[a][r]')
  for (const draft of [edit(value.draft, 'title', 'other'), forkCanonicalSourceLedger(value.draft, [{ from: 1, to: 2, insert: 'q' }])])
    assert.throws(() => prepare(draft, value.lease), /未生成来源声明/)
})

test('separate actual slots may be changed together but a single change consuming shell between slots cannot continue or birth a partial destination', () => {
  const value = open('[x](Target.md "T")'), destination = value.draft.source.indexOf('Target.md'), title = value.draft.source.indexOf('"T"') + 1
  const positive = forkCanonicalSourceLedger(value.draft, [{ from: 1, to: 2, insert: 'label' },
    { from: destination, to: destination + 1, insert: 'N' }, { from: title, to: title + 1, insert: 'title' }])
  assert.equal(prepare(positive, value.lease).bindingClaims[0].kind, 'new')
  const crossing = forkCanonicalSourceLedger(value.draft, [{ from: 1, to: destination + 2, insert: 'new](Ne' }])
  assert.ok(crossing.source.includes('Nerget.md'))
  assert.throws(() => prepare(crossing, value.lease), /未生成来源声明/)
})

test('same-byte delimiter changes and destination text escaping into a new title remain unproven', () => {
  const value = open('[x](Target.md "T")')
  for (const at of [0, value.draft.source.indexOf(']'), value.draft.source.lastIndexOf(')'), value.draft.source.indexOf('"')]) {
    const draft = forkCanonicalSourceLedger(value.draft, [{ from: at, to: at + 1, insert: value.draft.source[at] }])
    assert.equal(draft.source, value.draft.source)
    assert.throws(() => prepare(draft, value.lease), /未生成来源声明/)
  }
  const bare = open('[x](Target.md)'), end = bare.draft.source.indexOf('Target.md') + 9
  const escaped = forkCanonicalSourceLedger(bare.draft, [{ from: end, to: end, insert: ' "created title"' }])
  assert.throws(() => prepare(escaped, bare.lease), /未生成来源声明/)
})

test('a disappeared use cannot recover by inverse text editing while real CM replay restores the exact original generation', () => {
  const value = open('[x](Target.md)'), escaped = forkCanonicalSourceLedger(value.draft, [{ from: 0, to: 0, insert: '\\' }])
  assert.equal(prepare(escaped, value.lease).bindingClaims.length, 0)
  const manual = forkCanonicalSourceLedger(escaped, [{ from: 0, to: 1, insert: '' }])
  assert.throws(() => prepare(manual, value.lease), /未生成来源声明/)
  const session = createCanonicalSourceLedgerSession({ draft: value.draft }), initial = EditorState.create({
    doc: markdownSourceEditorText(value.draft.source), extensions: session.extension })
  const at = initial.doc.toString().indexOf('Target.md'), next = initial.update({ changes: { from: at, to: at + 1, insert: 'N' } }).state
  const changedDraft = session.read(next), changedFacts = readCanonicalSourceLedgerCandidate(changedDraft)
  assert.equal(prepare(changedDraft, value.lease).bindingClaims[0].kind, 'new')
  const undo = next.update({ changes: { from: 0, to: next.doc.length, insert: initial.doc.toString() }, annotations: session.replay.of(value.draft) }).state
  assert.equal(session.read(undo), value.draft); assert.equal(prepare(session.read(undo), value.lease).bindingClaims[0].kind, 'continue')
  const redo = undo.update({ changes: { from: 0, to: undo.doc.length, insert: next.doc.toString() }, annotations: session.replay.of(changedDraft) }).state
  assert.equal(session.read(redo), changedDraft)
  assert.equal(readCanonicalSourceLedgerCandidate(session.read(redo)), changedFacts)
  assert.equal(prepare(session.read(redo), value.lease).bindingClaims[0].kind, 'new')
})

test('a nonadjacent fallback title trial never becomes an editable direct title slot', () => {
  const value = open('[x](<u> ""X[r]\n\n[r]: Target.md'), point = value.draft.source.indexOf('""') + 1
  const draft = forkCanonicalSourceLedger(value.draft, [{ from: point, to: point, insert: 'not a title' }])
  assert.throws(() => prepare(draft, value.lease), /reference use.*carrier.*未生成来源声明/)
})

test('a partial destination that destroys its actual grammar cannot recover a generation by later inverse text edits', () => {
  const value = open('[x](Target.md)'), point = value.draft.source.indexOf('Target.md')
  const broken = forkCanonicalSourceLedger(value.draft, [{ from: point, to: point + 1, insert: '(' }])
  assert.throws(() => prepare(broken, value.lease), /语法消失.*未生成来源声明/)
  const restored = forkCanonicalSourceLedger(broken, [{ from: point, to: point + 1, insert: 'T' }])
  assert.equal(restored.source, value.draft.source)
  assert.throws(() => prepare(restored, value.lease), /未生成来源声明/)
})

test('label content escaping into fresh nested link syntax cannot hide the lost outer role behind a full inserted href', () => {
  const value = open('[x](Target.md)'), draft = edit(value.draft, 'x', 'new](Other.md) [y')
  assert.throws(() => prepare(draft, value.lease), /逸出|未生成来源声明/)
})

test('original CRLF/opaque identity is the old-key authority when an unrelated raw offset shift and label change use strict output traces', () => {
  const value = open('prefix🙂\r\n[x](Target.md) suffix'), label = value.draft.source.indexOf('[x]') + 1
  const draft = forkCanonicalSourceLedger(value.draft, [{ from: 0, to: 0, insert: '中文 ' }, { from: label, to: label + 1, insert: 'label' }])
  const result = prepare(draft, value.lease), claim = result.bindingClaims[0]
  assert.equal(claim.kind, 'continue')
  if (claim.kind !== 'continue') throw new Error('Expected original exact raw key')
  assert.equal(claim.source.blockId, value.block.id); assert.equal(claim.source.from, value.block.content.indexOf('Target.md'))
  assert.equal(result.blocks[0].id, value.block.id); assert.deepEqual(result.blocks[0].tags, value.block.tags)
})

test('role helper context is part of the opening generation and cannot be silently changed before an edit or prepare', () => {
  const value = open('[x](Target.md "T")'), title = markdownEngine.helpers.parseLinkTitle
  try {
    markdownEngine.helpers.parseLinkTitle = (source, from, max, previous) => title(source, from, max, previous)
    assert.throws(() => forkCanonicalSourceLedger(value.draft, []), /语法上下文/)
    assert.throws(() => prepare(value.draft, value.lease), /语法上下文/)
  } finally { markdownEngine.helpers.parseLinkTitle = title }
  assert.equal(prepare(value.draft, value.lease).bindingClaims[0].kind, 'continue')
})

test('a raw CRLF created inside a display may survive but cannot later be consumed at half its atomic boundary', () => {
  const value = open('[label](Target.md)'), at = value.draft.source.indexOf('label') + 2
  const multiline = forkCanonicalSourceLedger(value.draft, [{ from: at, to: at, insert: '\r\n' }])
  assert.equal(prepare(multiline, value.lease).bindingClaims[0].kind, 'continue')
  const half = multiline.source.indexOf('\r\n') + 1
  const broken = forkCanonicalSourceLedger(multiline, [{ from: half, to: half + 1, insert: '\n' }])
  assert.equal(broken.source, multiline.source)
  assert.throws(() => prepare(broken, value.lease), /未生成来源声明/)
})

test('a same-byte edit inside a native codec atomic group cannot borrow its surrounding display role', () => {
  const context = open('unused'), root: SyncedCanonicalEdit = { ...context.block, type: 'toggle', content: '[label </summary>](Target.md)' }
  const child: SyncedCanonicalEdit = { id: 'child', type: 'paragraph', content: 'body', checked: false, depth: 1, parentBlockId: root.id }
  const opened = openCanonicalSourceLedger({ blocks: [root, child], origin, lease: context.lease })
  const role = observeMarkdownSourceCarriers(opened.draft.source).carriers[0]
  assert.ok(role.complete && role.display)
  const slot = role.display.span, singleton = new Set(slot.projection.boundaries.filter(points => points.length === 1).map(points => points[0]))
  let interior: number | undefined
  for (let at = slot.from + 1; at < slot.to; at++) if (!singleton.has(at)) { interior = at; break }
  assert.notEqual(interior, undefined, 'The actual finite codec must contain an indivisible raw interior')
  if (interior === undefined) throw new Error('Missing native codec interior')
  const draft = forkCanonicalSourceLedger(opened.draft, [{ from: interior, to: interior + 1, insert: opened.draft.source[interior] }])
  assert.equal(draft.source, opened.draft.source)
  assert.throws(() => prepare(draft, context.lease), /未生成来源声明/)
})


test('independent whole-destination birth permits same-batch protected edits but cannot erase an earlier taint', () => {
  const value = open('[r]: Target.md "title"\n\n[a][r]')
  const destination = value.draft.source.indexOf('Target.md'), title = value.draft.source.indexOf('title')
  assert.ok(destination >= 0 && title >= 0)
  const titleChange = { from: title, to: title + 'title'.length, insert: 'other' }
  const partial = forkCanonicalSourceLedger(value.draft, [
    { from: destination, to: destination + 1, insert: 'N' }, titleChange])
  assert.throws(() => prepare(partial, value.lease), /未生成来源声明/,
    'A partial href has no independent birth when the declaration title protection is consumed')

  const whole = forkCanonicalSourceLedger(value.draft, [
    { from: destination, to: destination + 'Target.md'.length, insert: 'New.md' }, titleChange])
  const result = prepare(whole, value.lease)
  assert.equal(result.bindingClaims.length, 1)
  assert.equal(result.bindingClaims[0].kind, 'new', 'The entire authored destination has one actual insertion witness')
  assert.equal(result.bindingClaims[0].destination.raw, 'New.md')
  assert.ok(result.blocks.map(block => block.content).join('\n\n').includes('"other"'))

  const tainted = forkCanonicalSourceLedger(value.draft, [titleChange])
  assert.throws(() => prepare(tainted, value.lease), /未生成来源声明/)
  assert.ok(readCanonicalSourceLedgerCandidate(tainted).uncertainReason)
  const later = edit(tainted, 'Target.md', 'New.md')
  assert.ok(readCanonicalSourceLedgerCandidate(later).uncertainReason,
    'A later local whole href is not the original whole-source replacement that can clear an earlier taint')
  assert.throws(() => prepare(later, value.lease), /未生成来源声明/)
})
