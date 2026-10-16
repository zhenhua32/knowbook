import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { EditorState, Plugin, TextSelection, type Transaction } from 'prosemirror-state'
import { Step, StepResult, ReplaceStep, AddMarkStep, RemoveMarkStep } from 'prosemirror-transform'
import { Fragment, Mark, Schema, Slice, type Node as PMNode } from 'prosemirror-model'
import type { SyncedCanonicalEdit, SyncedOriginV1 } from '../src/shared/synced-blocks'
import { richTextSchema as schema } from '../src/renderer/src/rich-text/schema'
import { reconcileRichTextBlockIds, richBlockEntries } from '../src/renderer/src/rich-text/model'
import { richLinkOccurrence, withRichLinkOccurrence } from '../src/renderer/src/rich-text/linkProvenance'
import { beginObservedRichCapture, captureObservedRichDelta, prepareObservedRichPath,
  prepareSyncedRichProvenance, seedSyncedRichProvenance, setRichAtomAttributeIntent, setRichNewLinkIntent,
  type ObservedRichDelta, type RichObservedCapture, type RichObservedCursor } from '../src/renderer/src/rich-text/richProvenance'
import { captureRichObservedStep as captureStep, isRichObservedStepCurrent, replayRichObservedStep } from '../src/renderer/src/rich-text/richObservedStepPayload'

// Every existing fixture below uses this actual schema. Foreign-schema cases
// pass their real before schema explicitly to captureStep instead.
const captureRichObservedStep = (step: Step) => captureStep(step, schema)

const origin: SyncedOriginV1 = { version: 1, documentId: 'old host', pathAtCreation: 'Original/Host',
  firstInstanceId: '11111111-1111-4111-8111-111111111111' }
const block = (id: string, content: string): SyncedCanonicalEdit => ({ id, type: 'paragraph', content, checked: false,
  parentBlockId: null, depth: 0, tags: ['原标签'], highlight: 'yellow' })
const identity = new Plugin({ appendTransaction(transactions, _before, after) {
  if (!transactions.some(tr => tr.docChanged)) return null
  const repaired = reconcileRichTextBlockIds(after.doc)
  if (repaired === after.doc) return null
  const tr = after.tr
  for (const entry of richBlockEntries(repaired)) {
    const current = tr.doc.nodeAt(entry.pos)!
    if (JSON.stringify(current.attrs) === JSON.stringify(entry.node.attrs)) continue
    const index = tr.steps.length
    tr.setNodeMarkup(entry.pos, undefined, entry.node.attrs, entry.node.marks)
    if (current.isLeaf) setRichAtomAttributeIntent(tr, index)
  }
  return tr.docChanged ? tr : null
} })
function open(blocks = [block(' __proto__:正文 ', '[AB](Target.md)')]) {
  const seeded = seedSyncedRichProvenance(blocks, { origin })
  const editor = EditorState.create({ doc: seeded.doc, plugins: [identity] })
  return { ...seeded, editor, ...beginObservedRichCapture(seeded.state, editor) }
}
function observe(initial: ReturnType<typeof open>, tr: Transaction, before = initial.editor) {
  const result = before.applyTransaction(tr)
  const receipt = captureObservedRichDelta(initial.capture, { before, transactions: result.transactions, after: result.state })
  return { ...receipt, editor: result.state, transactions: result.transactions }
}
function prepared(initial: ReturnType<typeof open>, receipt: { cursor: RichObservedCursor; editor: EditorState }, deltas: readonly ObservedRichDelta[]) {
  return prepareObservedRichPath(initial.state, { capture: initial.capture, cursor: receipt.cursor, activeDeltas: deltas, actualAfter: receipt.editor })
}
function linkAt(doc: PMNode, pos = 1) {
  const mark = doc.nodeAt(pos)?.marks.find(mark => mark.type.name === 'link')
  assert.ok(mark); return mark
}
function assertOracle(initial: ReturnType<typeof open>, result: ReturnType<typeof observe>, deltas: readonly ObservedRichDelta[], transactions = result.transactions) {
  const expected = prepareSyncedRichProvenance(initial.state, { before: initial.editor, transactions, after: result.editor })
  const actual = prepared(initial, result, deltas)
  assert.deepEqual(actual.blocks, expected.blocks)
  assert.deepEqual(actual.bindingClaims, expected.bindingClaims)
  assert.equal(actual.hasIntent, expected.hasIntent)
  return actual
}

test('real empty-map mark steps replay after all original Transaction arrays and Step fields are changed', () => {
  const initial = open(), tr = initial.editor.tr.addMark(1, 3, schema.marks.strong.create()), receipt = observe(initial, tr)
  assert.ok(receipt.delta)
  const expected = assertOracle(initial, receipt, [receipt.delta])
  const step = tr.steps[0]
  Object.defineProperty(step, 'from', { value: 999 })
  tr.steps.length = 0; tr.docs.length = 0; assert.equal(Reflect.set(tr.mapping.maps, 'length', 0), true)
  const replayed = prepared(initial, receipt, [receipt.delta])
  assert.deepEqual(replayed.blocks, expected.blocks)
  assert.deepEqual(replayed.bindingClaims, expected.bindingClaims)
  assert.equal(replayed.blocks[0].id, ' __proto__:正文 ')
  assert.ok(replayed.blocks[0].content.includes('**'))
})

test('same-body new intent is captured only from the real private witness, surviving released Transactions', () => {
  const initial = open(), mark = withRichLinkOccurrence(linkAt(initial.doc), randomUUID()), tr = initial.editor.tr.addMark(1, 3, mark)
  setRichNewLinkIntent(tr, { stepIndex: tr.steps.length - 1, from: 1, to: 3, token: richLinkOccurrence(mark)! })
  const receipt = observe(initial, tr)
  assert.ok(receipt.delta)
  tr.steps.length = 0; tr.docs.length = 0; assert.equal(Reflect.set(tr.mapping.maps, 'length', 0), true)
  const result = prepared(initial, receipt, [receipt.delta])
  assert.equal(result.blocks[0].content, '[AB](Target.md)')
  assert.equal(result.hasIntent, true)
  assert.deepEqual(result.bindingClaims.map(claim => claim.kind), ['new'])
})

test('a JSON-recreated AddMark and arbitrary transaction metadata cannot recreate a private new witness', () => {
  const initial = open(), replacement = withRichLinkOccurrence(linkAt(initial.doc), randomUUID())
  const command = initial.editor.tr.addMark(1, 3, replacement)
  const stepIndex = command.steps.findIndex(step => step instanceof AddMarkStep && step.mark === replacement && step.from === 1 && step.to === 3)
  assert.ok(stepIndex >= 0)
  setRichNewLinkIntent(command, { stepIndex, from: 1, to: 3, token: richLinkOccurrence(replacement)! })
  const recreated = Step.fromJSON(schema, command.steps[stepIndex].toJSON())
  const tr = initial.editor.tr.step(recreated).setMeta('richNewLinkIntent', { from: 1, to: 3, token: richLinkOccurrence(replacement) })
  const receipt = observe(initial, tr)
  assert.ok(receipt.delta)
  assert.equal(receipt.status, 'replayable', 'A supported payload is not a claim/lineage receipt')
  assert.throws(() => prepared(initial, receipt, [receipt.delta!]), /来源|token|link/)
})

test('real split, appended ID repair, UTF16 linked typing and join retain the complete ordered edge chain', () => {
  const initial = open(), split = observe(initial, initial.editor.tr.split(2))
  assert.ok(split.delta); assert.equal(split.transactions.length, 2)
  assertOracle(initial, split, [split.delta])
  const second = richBlockEntries(split.editor.doc)[1]
  const typed = observe(initial, split.editor.tr.insert(second.pos + 1, schema.text('😀', second.node.firstChild!.marks)), split.editor)
  assert.ok(typed.delta)
  const joined = observe(initial, typed.editor.tr.join(richBlockEntries(typed.editor.doc)[1].pos), typed.editor)
  assert.ok(joined.delta)
  const transactions = [...split.transactions, ...typed.transactions, ...joined.transactions]
  const result = assertOracle(initial, joined, [split.delta, typed.delta, joined.delta], transactions)
  assert.equal(result.blocks.length, 1)
  assert.ok(result.blocks[0].content.includes('A😀B'))
  assert.deepEqual(result.bindingClaims.map(claim => claim.kind), ['continue'])
})

test('ReplaceAround preserves its actual gap and raw carrier on the actual adopted tail', () => {
  const initial = open(), entry = richBlockEntries(initial.doc)[0]
  const receipt = observe(initial, initial.editor.tr.setNodeMarkup(entry.pos, undefined, { ...entry.node.attrs,
    block: { ...entry.node.attrs.block, type: 'heading-2' } }))
  assert.ok(receipt.delta)
  const result = assertOracle(initial, receipt, [receipt.delta])
  assert.equal(result.blocks[0].content, '[AB](Target.md)')
  assert.equal(result.blocks[0].type, 'heading-2')
  // The prepared state must own the real tail pointer, not its equal replay root.
  const tr = receipt.editor.tr.insertText('x', 2), next = receipt.editor.applyTransaction(tr)
  const again = prepareSyncedRichProvenance(result.nextState, { before: receipt.editor, transactions: next.transactions, after: next.state })
  assert.equal(again.bindingClaims[0].kind, 'continue')
})

test('actual atom ID-repair witness is copied without a historical root and reanchors to the real leaf', () => {
  const initial = open([block('definition', '[r]: Target.md'), block('other', 'Other')]), entry = richBlockEntries(initial.doc)[0]
  const tr = initial.editor.tr.setNodeMarkup(entry.pos, undefined, { ...entry.node.attrs,
    block: { ...entry.node.attrs.block, id: ' new:definition ' } })
  setRichAtomAttributeIntent(tr, 0)
  const receipt = observe(initial, tr)
  assert.ok(receipt.delta)
  const result = assertOracle(initial, receipt, [receipt.delta])
  assert.equal(result.bindingClaims[0].destination.blockId, ' new:definition ')
  tr.docs.length = 0; tr.steps.length = 0; assert.equal(Reflect.set(tr.mapping.maps, 'length', 0), true)
  assert.deepEqual(prepared(initial, receipt, [receipt.delta]).bindingClaims, result.bindingClaims)
  const other = richBlockEntries(receipt.editor.doc)[1]
  const next = receipt.editor.applyTransaction(receipt.editor.tr.insertText('x', other.pos + 1))
  assert.equal(prepareSyncedRichProvenance(result.nextState, { before: receipt.editor, transactions: next.transactions, after: next.state }).bindingClaims[0].kind, 'continue')
})

test('an unregistered same-body atom replacement cannot acquire the captured identity witness', () => {
  const initial = open([block('atom', '[[Target]]'), block('other', 'Other')]), entry = richBlockEntries(initial.doc)[0]
  const tr = initial.editor.tr.setNodeMarkup(entry.pos, undefined, { ...entry.node.attrs,
    block: { ...entry.node.attrs.block, id: 'unproven' } })
  const receipt = observe(initial, tr)
  assert.ok(receipt.delta)
  assert.throws(() => prepared(initial, receipt, [receipt.delta!]), /原子/)
})

test('a physical definition continues once and real formatted uses copy, preserving unrelated raw CRLF', () => {
  const raw = '😀\r\n[raw](Target&#46;md)\r\n'
  const initial = open([block('raw', raw), block('definition', '[r]: Target.md'), block('uses', '[one][r] [two][r]')])
  const use = richBlockEntries(initial.doc)[2]
  const receipt = observe(initial, initial.editor.tr.addMark(use.pos + 1, use.pos + 4, schema.marks.strong.create()))
  assert.ok(receipt.delta)
  const result = assertOracle(initial, receipt, [receipt.delta])
  assert.equal(result.blocks[0].content, raw)
  assert.deepEqual(result.bindingClaims.map(claim => claim.kind), ['continue', 'continue', 'copy', 'copy'])
  assert.ok(result.bindingClaims.filter(claim => claim.kind === 'copy').every(claim => claim.source.kind === 'current' && claim.source.key.blockId === 'definition'))
})

test('broad actual RemoveMarkStep retains an unequal link and uses the shared final AST closed-set checks', () => {
  const initial = open([block('mixed', '[A](One.md)[B](Two.md)')])
  const receipt = observe(initial, initial.editor.tr.step(new RemoveMarkStep(1, 3, linkAt(initial.doc))))
  assert.ok(receipt.delta)
  const result = assertOracle(initial, receipt, [receipt.delta])
  assert.equal(result.blocks[0].content, 'A[B](Two.md)')
  assert.equal(result.bindingClaims.length, 1)
  assert.ok(result.bindingClaims[0].kind === 'continue')
  assert.equal(result.bindingClaims[0].source.raw, 'Two.md')
})

test('selection-only dispatch creates no edge and cannot move an opening source or tail boundary', () => {
  const initial = open(), receipt = observe(initial, initial.editor.tr.setSelection(TextSelection.create(initial.doc, 2)))
  assert.equal(receipt.delta, null); assert.equal(receipt.cursor, initial.cursor)
  assert.equal(prepared(initial, receipt, []).hasIntent, false)
  assert.throws(() => beginObservedRichCapture(initial.state, EditorState.create({ doc: schema.nodeFromJSON(initial.doc.toJSON()) })), /实际当前来源/)
})

test('unknown custom steps quarantine the real text tail without any claims even after same-body restoration', () => {
  class Unknown extends Step {
    apply(doc: PMNode) { return StepResult.ok(doc) }
    invert() { return this }
    map() { return this }
    toJSON() { throw new Error('Unknown steps must not be serialized') }
  }
  const initial = open(), first = observe(initial, initial.editor.tr.step(new Unknown()))
  assert.ok(first.delta); assert.equal(first.status, 'quarantined-layout')
  assert.equal(first.editor.doc, initial.doc)
  assert.throws(() => prepared(initial, first, [first.delta!]), /隔离|未知/)
  const typed = observe(initial, first.editor.tr.insertText('x', 2), first.editor)
  assert.ok(typed.delta); assert.equal(typed.editor.doc.textContent, 'AxB')
  const restored = observe(initial, typed.editor.tr.delete(2, 3), typed.editor)
  assert.ok(restored.delta); assert.ok(restored.editor.doc.eq(initial.doc))
  assert.throws(() => prepared(initial, restored, [first.delta!, typed.delta!, restored.delta!]), /隔离|未知/)
})

test('a custom step which actually changes private text keeps that actual tail while all source preparation stays quarantined', () => {
  class PrivateText extends Step {
    apply(doc: PMNode) { return StepResult.fromReplace(doc, 2, 2, new Slice(Fragment.from(schema.text('私有')), 0, 0)) }
    invert() { return this }
    map() { return this }
    toJSON() { throw new Error('Custom payload must not be serialized') }
  }
  const initial = open(), receipt = observe(initial, initial.editor.tr.step(new PrivateText()))
  assert.ok(receipt.delta)
  assert.equal(receipt.editor.doc.textContent, 'A私有B')
  assert.equal(receipt.status, 'quarantined-layout')
  assert.throws(() => prepared(initial, receipt, [receipt.delta!]), /隔离|未知/)
  assert.equal(receipt.editor.doc.textContent, 'A私有B', 'The observer neither substitutes a reconstructed body nor claims it saved this buffer')
})

test('whole-document replacement is quarantined without retaining a whole-forest edge payload', () => {
  const initial = open(), receipt = observe(initial, initial.editor.tr.replaceWith(0, initial.doc.content.size, initial.doc.content))
  assert.ok(receipt.delta); assert.equal(receipt.status, 'quarantined-layout')
  assert.throws(() => prepared(initial, receipt, [receipt.delta!]), /隔离|未知/)
})

test('old prefix, omitted, duplicate, reordered, sparse and foreign edges cannot target a current tail', () => {
  const initial = open(), first = observe(initial, initial.editor.tr.insertText('x', 2))
  assert.ok(first.delta)
  const second = observe(initial, first.editor.tr.insertText('y', 3), first.editor)
  assert.ok(second.delta)
  assert.throws(() => prepared(initial, first, [first.delta!]), /最新实际 tail/)
  assert.throws(() => prepared(initial, second, [second.delta!]), /完整最新实际 tail/)
  assert.throws(() => prepared(initial, second, [first.delta!, first.delta!]), /缺边|重排|跨会话/)
  assert.throws(() => prepared(initial, second, [second.delta!, first.delta!]), /缺边|重排|跨会话/)
  const sparse = new Array<ObservedRichDelta>(2); sparse[1] = second.delta
  assert.throws(() => prepared(initial, second, sparse), /完整最新实际 tail/)
  const foreign = open(), foreignReceipt = observe(foreign, foreign.editor.tr.insertText('z', 2))
  assert.ok(foreignReceipt.delta)
  assert.throws(() => prepared(initial, second, [first.delta!, foreignReceipt.delta!]), /跨会话/)
  assertOracle(initial, second, [first.delta, second.delta], [...first.transactions, ...second.transactions])
})

test('forged handles, equal reconstructed final docs and a foreign source generation are rejected before equality grants anything', () => {
  const initial = open(), receipt = observe(initial, initial.editor.tr.insertText('x', 2))
  assert.ok(receipt.delta)
  const fakeCapture: RichObservedCapture = { id: initial.capture.id }
  assert.throws(() => captureObservedRichDelta(fakeCapture, { before: initial.editor, transactions: [], after: initial.editor }), /会话无效/)
  assert.throws(() => prepared(initial, { ...receipt, cursor: { id: receipt.cursor.id } }, [receipt.delta!]), /最新实际 tail/)
  const equal = EditorState.create({ doc: schema.nodeFromJSON(receipt.editor.doc.toJSON()) })
  assert.ok(equal.doc.eq(receipt.editor.doc))
  assert.throws(() => prepared(initial, { ...receipt, editor: equal }, [receipt.delta!]), /最新实际 tail/)
  const foreign = open()
  assert.throws(() => prepareObservedRichPath(foreign.state, { capture: initial.capture, cursor: receipt.cursor,
    activeDeltas: [receipt.delta!], actualAfter: receipt.editor }), /最新实际 tail/)
})

test('invalid transaction chains fail atomically so the original tail still accepts its real first edge', () => {
  const initial = open(), foreign = open(), tr = foreign.editor.tr.insertText('x', 2), result = foreign.editor.applyTransaction(tr)
  assert.throws(() => captureObservedRichDelta(initial.capture, { before: initial.editor, transactions: result.transactions, after: result.state }), /事务链/)
  const malformed = initial.editor.tr.insertText('x', 2), applied = initial.editor.applyTransaction(malformed)
  assert.equal(Reflect.set(malformed.mapping.maps, 'length', 0), true)
  assert.throws(() => captureObservedRichDelta(initial.capture, { before: initial.editor, transactions: [malformed], after: applied.state }), /事务链/)
  const actual = observe(initial, initial.editor.tr.insertText('y', 2))
  assert.ok(actual.delta)
  assertOracle(initial, actual, [actual.delta])
})

test('closed helper owns nested Slice attrs, Mark attrs and text, without freezing actual caller PM values', () => {
  const source = schema.nodes.source_block.create({ block: { ...block('atom', '[[Target]]'), tags: ['first'] } })
  const step = new ReplaceStep(0, 0, new Slice(Fragment.from(source), 0, 0)), payload = captureRichObservedStep(step)
  assert.ok(payload)
  assert.equal(Object.isFrozen(step), false); assert.equal(Object.isFrozen(source), false)
  assert.equal(Object.isFrozen(source.attrs.block), false)
  source.attrs.block.tags.push('late'); source.attrs.block.content = 'changed after capture'
  const initial = open(), replayed = replayRichObservedStep(payload, initial.doc)
  assert.ok(replayed)
  assert.equal(replayed.after.firstChild!.attrs.block.content, '[[Target]]')
  assert.deepEqual(replayed.after.firstChild!.attrs.block.tags, ['first'])
  const href = schema.marks.link.create({ href: 'Before.md', title: '😀' })
  const marked = new AddMarkStep(1, 3, href), closed = captureRichObservedStep(marked)
  assert.ok(closed)
  Object.defineProperty(href.attrs, 'href', { value: 'After.md' })
  assert.equal(linkAt(replayRichObservedStep(closed, initial.doc)!.after).attrs.href, 'Before.md')
})

test('closed children, empty fragments, marks and default attrs are independent without mutating any shared singleton', () => {
  const OwnedFragment = Fragment as unknown as { new(content: readonly PMNode[]): Fragment }
  const ownEmptyChildren: PMNode[] = [], ownEmpty = new OwnedFragment(ownEmptyChildren), ownMarks: Mark[] = []
  const source = schema.nodes.source_block.create({ block: block('atom', '[[Target]]') })
  // All mutations in this test target values owned by this fixture, never
  // Fragment.empty, Mark.none, schema defaults or any prototype.
  Object.defineProperty(source, 'content', { value: ownEmpty })
  Object.defineProperty(source, 'marks', { value: ownMarks })
  const defaults = schema.nodes.hard_break.create().attrs, sharedEmpty = Fragment.empty, sharedMarks = Mark.none
  const defaultBytes = JSON.stringify(defaults), emptySize = sharedEmpty.size, emptyCount = sharedEmpty.childCount, markCount = sharedMarks.length
  const children = [source, schema.nodes.text_block.create({ block: block('break-owner', '') }, schema.nodes.hard_break.create())]
  const inserted = new OwnedFragment(children), step = new ReplaceStep(0, 0, new Slice(inserted, 0, 0))
  const payload = captureRichObservedStep(step)
  assert.ok(payload)
  const initial = open(), first = replayRichObservedStep(payload, initial.doc)
  assert.ok(first && first.step instanceof ReplaceStep)
  const copy = first.step.slice.content
  assert.notEqual(copy, inserted); assert.notEqual(copy.content, children)
  assert.notEqual(copy.firstChild!.content, ownEmpty); assert.notEqual(copy.firstChild!.content, sharedEmpty)
  assert.notEqual(copy.firstChild!.marks, ownMarks); assert.notEqual(copy.firstChild!.marks, sharedMarks)
  assert.notEqual(copy.child(1).firstChild!.attrs, defaults)
  ownEmptyChildren.push(schema.text('late'))
  Object.defineProperty(ownEmpty, 'size', { value: 4 })
  ownMarks.push(schema.marks.strong.create())
  children.push(schema.text('late outer child'))
  source.attrs.block.content = 'late body'
  const second = replayRichObservedStep(payload, initial.doc)
  assert.ok(second && second.step instanceof ReplaceStep)
  assert.equal(second.step.slice.content.childCount, 2)
  assert.equal(second.step.slice.content.firstChild!.content.size, 0)
  assert.equal(second.step.slice.content.firstChild!.marks.length, 0)
  assert.equal(second.step.slice.content.firstChild!.attrs.block.content, '[[Target]]')
  assert.equal(Fragment.empty, sharedEmpty); assert.equal(Mark.none, sharedMarks)
  assert.equal(sharedEmpty.size, emptySize); assert.equal(sharedEmpty.childCount, emptyCount); assert.equal(sharedMarks.length, markCount)
  assert.equal(JSON.stringify(defaults), defaultBytes)
  assert.equal(Object.isFrozen(defaults), false)
})

test('getter, cyclic, sparse and function-valued attrs cannot be retained as hidden Step payload references', () => {
  let getterCalls = 0
  const unsafe = [
    Object.defineProperty({}, 'value', { enumerable: true, get() { getterCalls++; return 'unsafe' } }),
    (() => { const value: { self?: unknown } = {}; value.self = value; return value })(),
    new Array(1),
    { callback: () => open().doc }
  ]
  for (const value of unsafe) {
    const node = schema.nodes.source_block.create({ block: { ...block('atom', '[[Target]]'), unsafe: value } })
    assert.equal(captureRichObservedStep(new ReplaceStep(0, 0, new Slice(Fragment.from(node), 0, 0))), null)
    assert.equal(Object.isFrozen(node), false)
  }
  assert.equal(getterCalls, 0)
})

test('custom subclasses, getter-bearing Step fields and extra closure fields are quarantined without invoking getters', () => {
  class Custom extends AddMarkStep {}
  assert.equal(captureRichObservedStep(new Custom(1, 3, schema.marks.strong.create())), null)
  const accessor = new AddMarkStep(1, 3, schema.marks.strong.create())
  Object.defineProperty(accessor, 'from', { get() { throw new Error('Getter must not execute') } })
  assert.equal(captureRichObservedStep(accessor), null)
  const closure = new AddMarkStep(1, 3, schema.marks.strong.create())
  Object.defineProperty(closure, 'secret', { value: () => open().doc })
  assert.equal(captureRichObservedStep(closure), null)
})

test('a known payload cannot emit claims if the real tail mark/attrs are mutated after capture', () => {
  const initial = open(), replacement = withRichLinkOccurrence(linkAt(initial.doc), randomUUID()), tr = initial.editor.tr.addMark(1, 3, replacement)
  const stepIndex = tr.steps.findIndex(step => step instanceof AddMarkStep && step.mark === replacement && step.from === 1 && step.to === 3)
  assert.ok(stepIndex >= 0)
  setRichNewLinkIntent(tr, { stepIndex, from: 1, to: 3, token: richLinkOccurrence(replacement)! })
  const receipt = observe(initial, tr)
  assert.ok(receipt.delta)
  Object.defineProperty(replacement.attrs, 'href', { value: 'Mutated.md' })
  assert.throws(() => prepared(initial, receipt, [receipt.delta!]), /最终状态|tail/)
})

test('captured formatting and closed insertion keep hardbreak and empty destination/title UTF16 geometry exact', () => {
  const initial = open([block('empty', '[中😀](<> "title")')])
  const receipt = observe(initial, initial.editor.tr.addMark(1, 4, schema.marks.strong.create()))
  assert.ok(receipt.delta)
  const result = assertOracle(initial, receipt, [receipt.delta])
  assert.equal(result.bindingClaims[0].destination.from, result.bindingClaims[0].destination.to)
  assert.equal(result.bindingClaims[0].destination.raw, '')
  const linked = schema.text('😀', initial.doc.firstChild!.firstChild!.marks)
  const payload = captureRichObservedStep(new ReplaceStep(2, 2, new Slice(Fragment.fromArray([linked, schema.nodes.hard_break.create()]), 0, 0)))
  assert.ok(payload)
  assert.ok(replayRichObservedStep(payload, initial.doc))
})

test('a real AddMarkStep with a fake type carrying a root/closure is quarantined and cannot gain authority by name/rank changes', () => {
  const initial = open(), genuine = schema.marks.strong
  const fake = Object.create(Object.getPrototypeOf(genuine)) as typeof genuine
  Object.defineProperties(fake, Object.getOwnPropertyDescriptors(genuine))
  Object.defineProperty(fake, 'oldDoc', { value: initial.doc })
  Object.defineProperty(fake, 'hiddenRoot', { value: () => initial.doc })
  const OwnedMark = Mark as unknown as { new(type: Mark['type'], attrs: Mark['attrs']): Mark }
  const mark = new OwnedMark(fake, Object.create(null)), tr = initial.editor.tr.step(new AddMarkStep(1, 3, mark))
  assert.ok(tr.doc.firstChild!.firstChild!.marks.some(value => value.type === fake), 'The fake type really reached an actual PM result')
  const receipt = observe(initial, tr)
  assert.ok(receipt.delta); assert.equal(receipt.status, 'quarantined-layout')
  Object.defineProperty(fake, 'name', { value: 'em' })
  Object.defineProperty(fake, 'rank', { value: 999 })
  assert.throws(() => prepared(initial, receipt, [receipt.delta!]), /隔离|未知/)
  assert.equal(schema.marks.strong.name, 'strong'); assert.equal(schema.marks.strong, genuine)
})

test('a genuine type from a foreign schema still quarantines after a real AddMark apply in the current document', () => {
  const initial = open(), foreign = new Schema({ nodes: schema.spec.nodes, marks: schema.spec.marks })
  const mark = foreign.marks.strong.create(), tr = initial.editor.tr.step(new AddMarkStep(1, 3, mark))
  assert.ok(tr.doc.firstChild!.firstChild!.marks.some(value => value.type === foreign.marks.strong))
  const receipt = observe(initial, tr)
  assert.ok(receipt.delta); assert.equal(receipt.status, 'quarantined-layout')
  assert.throws(() => prepared(initial, receipt, [receipt.delta!]), /隔离|未知/)
})

test('fake and foreign NodeTypes cannot enter a closed Slice even when node fields and visible source bytes match', () => {
  const initial = open(), genuine = schema.nodes.source_block
  const fake = Object.create(Object.getPrototypeOf(genuine)) as typeof genuine
  Object.defineProperties(fake, Object.getOwnPropertyDescriptors(genuine))
  Object.defineProperty(fake, 'oldDoc', { value: initial.doc })
  const OwnedNode = (initial.doc.constructor as unknown) as { new(type: PMNode['type'], attrs: PMNode['attrs'], content: Fragment, marks: readonly Mark[]): PMNode }
  const source = schema.nodes.source_block.create({ block: block('atom', '[[Target]]') })
  const counterfeit = new OwnedNode(fake, source.attrs, source.content, source.marks)
  const foreign = new Schema({ nodes: schema.spec.nodes, marks: schema.spec.marks })
  for (const node of [counterfeit, foreign.nodes.source_block.create({ block: block('atom', '[[Target]]') })]) {
    assert.equal(captureStep(new ReplaceStep(0, 0, new Slice(Fragment.from(node), 0, 0)), initial.doc.type.schema), null)
  }
})

test('authentic isolated schema/type semantic mutation after capture fails closed without freezing shared metadata', () => {
  const cases = [
    (isolated: Schema) => {
      const rank = Object.getOwnPropertyDescriptor(isolated.marks.strong, 'rank')
      assert.ok(rank && 'value' in rank && typeof rank.value === 'number')
      Object.defineProperty(isolated.marks.strong, 'rank', { value: rank.value + 100 })
    },
    (isolated: Schema) => Object.defineProperty(isolated.marks.strong, 'name', { value: 'em' }),
    (isolated: Schema) => Object.defineProperty(isolated.marks, 'strong', { value: isolated.marks.em }),
    (isolated: Schema) => Object.defineProperty(isolated.marks.strong.spec, 'inclusive', { value: false }),
    (isolated: Schema) => Object.defineProperty(isolated, 'topNodeType', { value: isolated.nodes.text_block })
  ]
  for (const mutate of cases) {
    // Clone specs as well: spec is otherwise shared by Schema constructors.
    // Each mutation is confined to this test-owned schema, never richTextSchema.
    const nodes = Object.fromEntries(Object.entries(schema.nodes).map(([name, type]) => [name, { ...type.spec }]))
    const marks = Object.fromEntries(Object.entries(schema.marks).map(([name, type]) => [name, { ...type.spec }]))
    const isolated = new Schema({ nodes, marks }), initial = open(), doc = isolated.nodeFromJSON(initial.doc.toJSON())
    const payload = captureStep(new AddMarkStep(1, 3, isolated.marks.strong.create()), doc.type.schema)
    assert.ok(payload); assert.ok(replayRichObservedStep(payload, doc))
    assert.equal(Object.isFrozen(isolated), false); assert.equal(Object.isFrozen(isolated.marks.strong), false)
    isolated.cached.localComputation = { value: 1 }
    assert.equal(isRichObservedStepCurrent(payload, isolated), true, 'Documented computation caches do not alter semantic authority')
    mutate(isolated)
    assert.equal(isRichObservedStepCurrent(payload, isolated), false)
    assert.equal(replayRichObservedStep(payload, doc), null)
  }
  assert.equal(schema.marks.strong.name, 'strong')
})
