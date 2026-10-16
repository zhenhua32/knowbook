import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { EditorState, Plugin, type Transaction } from 'prosemirror-state'
import { RemoveMarkStep, ReplaceAroundStep } from 'prosemirror-transform'
import type { SyncedCanonicalEdit, SyncedOriginV1 } from '../src/shared/synced-blocks'
import { richTextSchema as schema } from '../src/renderer/src/rich-text/schema'
import { reconcileRichTextBlockIds, richBlockEntries, serializeRichTextInlineWithLinkTrace } from '../src/renderer/src/rich-text/model'
import { richLinkOccurrence, withRichLinkOccurrence } from '../src/renderer/src/rich-text/linkProvenance'
import { prepareSyncedRichProvenance, seedSyncedRichProvenance, setRichAtomAttributeIntent, setRichNewLinkIntent,
  type RichProvenanceState } from '../src/renderer/src/rich-text/richProvenance'

const origin: SyncedOriginV1 = { version: 1, documentId: ' opaque:宿主 ', pathAtCreation: 'Original/Host', firstInstanceId: '11111111-1111-4111-8111-111111111111' }
const block = (id: string, content: string): SyncedCanonicalEdit => ({ id, type: 'paragraph', content, checked: false,
  depth: 0, parentBlockId: null, tags: ['标签'], highlight: 'yellow' })

/** The same real ID repair used by the editor, applied as actual append steps.
 * Leaf correspondence is declared only for that inspected identity transaction. */
const identity = new Plugin({ appendTransaction(transactions, _before, after) {
  if (!transactions.some(transaction => transaction.docChanged)) return null
  const repaired = reconcileRichTextBlockIds(after.doc)
  if (repaired === after.doc) return null
  const entries = richBlockEntries(repaired), tr = after.tr
  for (const entry of entries) {
    const current = tr.doc.nodeAt(entry.pos)!
    if (current.attrs === entry.node.attrs || JSON.stringify(current.attrs) === JSON.stringify(entry.node.attrs)) continue
    const stepIndex = tr.steps.length
    tr.setNodeMarkup(entry.pos, undefined, entry.node.attrs, entry.node.marks)
    if (current.isLeaf) setRichAtomAttributeIntent(tr, stepIndex)
  }
  return tr.docChanged ? tr : null
} })
function open(blocks = [block(' old:正文\0 ', '[AB](Target.md)')]) {
  const seeded = seedSyncedRichProvenance(blocks, { origin })
  return { editor: EditorState.create({ doc: seeded.doc, plugins: [identity] }), provenance: seeded.state }
}
function prepare(editor: EditorState, provenance: RichProvenanceState, tr: Transaction) {
  const applied = editor.applyTransaction(tr)
  const candidate = prepareSyncedRichProvenance(provenance, { before: editor, transactions: applied.transactions, after: applied.state })
  return { ...candidate, editor: applied.state, provenance: candidate.nextState, transactions: applied.transactions }
}
function linkAt(editor: EditorState, position: number) {
  const node = editor.doc.nodeAt(position)
  assert.ok(node)
  const link = node.marks.find(mark => mark.type.name === 'link')
  assert.ok(link)
  return link
}

test('actual empty-map AddMark and RemoveMark rebase current exact keys and retain original raw bytes on return', () => {
  const initial = open(), source = JSON.stringify(initial.editor.doc.toJSON())
  const attrsPrototype = Object.getPrototypeOf(initial.editor.doc.firstChild!.attrs)
  const blockPrototype = Object.getPrototypeOf(initial.editor.doc.firstChild!.attrs.block)
  const tr = initial.editor.tr.addMark(1, 3, schema.marks.strong.create())
  let changedRanges = 0
  tr.steps[0].getMap().forEach(() => { changedRanges++ })
  assert.equal(changedRanges, 0)
  const bold = prepare(initial.editor, initial.provenance, tr)
  assert.equal(bold.bindingClaims.length, 1)
  assert.equal(bold.bindingClaims[0].kind, 'continue')
  const restored = prepare(bold.editor, bold.provenance, bold.editor.tr.removeMark(1, 3, schema.marks.strong))
  assert.equal(restored.blocks[0].content, '[AB](Target.md)')
  assert.equal(restored.blocks[0].id, ' old:正文\0 ')
  assert.deepEqual(restored.blocks[0].tags, ['标签'])
  const claim = restored.bindingClaims[0]
  assert.ok(claim.kind === 'continue')
  assert.deepEqual(claim.source, bold.bindingClaims[0].destination)
  assert.equal(JSON.stringify(initial.editor.doc.toJSON()), source, 'An independent byte snapshot detects mutations of the opening PM doc and raw attrs')
  assert.equal(Object.getPrototypeOf(initial.editor.doc.firstChild!.attrs), attrsPrototype)
  assert.equal(Object.getPrototypeOf(initial.editor.doc.firstChild!.attrs.block), blockPrototype)
})

test('actual split, appended fresh identity, accepted typing and join use current occurrence keys rather than the seed key', () => {
  const initial = open(), split = prepare(initial.editor, initial.provenance, initial.editor.tr.split(2))
  assert.equal(split.blocks.length, 2)
  assert.equal(split.blocks[0].id, ' old:正文\0 ')
  assert.notEqual(split.blocks[1].id, split.blocks[0].id)
  assert.equal(split.transactions.length, 2, 'The identity fix is a real appended transaction')
  assert.deepEqual(split.bindingClaims.map(claim => claim.kind), ['continue', 'copy'])
  const second = richBlockEntries(split.editor.doc)[1]
  const typed = prepare(split.editor, split.provenance, split.editor.tr.insert(second.pos + 1, schema.text('x', second.node.firstChild!.marks)))
  const secondClaim = typed.bindingClaims.find(claim => claim.destination.blockId === split.blocks[1].id)
  assert.ok(secondClaim?.kind === 'continue')
  assert.deepEqual(secondClaim.source, split.bindingClaims[1].destination)
  const joined = prepare(typed.editor, typed.provenance, typed.editor.tr.join(richBlockEntries(typed.editor.doc)[1].pos))
  assert.equal(joined.blocks.length, 1)
  assert.equal(joined.bindingClaims.length, 1)
  assert.equal(joined.bindingClaims[0].kind, 'continue')
  assert.ok(joined.blocks[0].content.includes('AxB'))
})

test('actual ReplaceAround retains the real gap and transfers raw carrier only across inspected unchanged inline content', () => {
  const initial = open(), entry = richBlockEntries(initial.editor.doc)[0]
  const tr = initial.editor.tr.setNodeMarkup(entry.pos, undefined, { ...entry.node.attrs,
    block: { ...entry.node.attrs.block, type: 'heading-2' } })
  assert.ok(tr.steps[0] instanceof ReplaceAroundStep)
  const changed = prepare(initial.editor, initial.provenance, tr)
  assert.equal(changed.blocks[0].type, 'heading-2')
  assert.equal(changed.blocks[0].content, '[AB](Target.md)')
  assert.equal(changed.bindingClaims[0].kind, 'continue')
})

test('same-body new intent survives the unchanged fingerprint and linked typing in the same real transaction', () => {
  const initial = open(), original = linkAt(initial.editor, 1), replacement = withRichLinkOccurrence(original, randomUUID())
  const tr = initial.editor.tr.addMark(1, 3, replacement)
  setRichNewLinkIntent(tr, { stepIndex: tr.steps.length - 1, from: 1, to: 3, token: richLinkOccurrence(replacement)! })
  const sameBody = prepare(initial.editor, initial.provenance, tr)
  assert.equal(sameBody.blocks[0].content, '[AB](Target.md)')
  assert.equal(sameBody.hasIntent, true)
  assert.deepEqual(sameBody.bindingClaims.map(claim => claim.kind), ['new'])
  const nextMark = withRichLinkOccurrence(replacement, randomUUID())
  const next = sameBody.editor.tr.addMark(1, 3, nextMark)
  setRichNewLinkIntent(next, { stepIndex: next.steps.length - 1, from: 1, to: 3,
    token: richLinkOccurrence(nextMark)! })
  next.insertText('x', 2)
  const typed = prepare(sameBody.editor, sameBody.provenance, next)
  assert.equal(typed.blocks[0].content, '[AxB](Target.md)')
  assert.deepEqual(typed.bindingClaims.map(claim => claim.kind), ['new'])
})

test('a real broad RemoveMarkStep removes only its equal actual mark and retains another link within the same range', () => {
  const initial = open([block('broad', '[A](One.md)[B](Two.md)')])
  const tr = initial.editor.tr.step(new RemoveMarkStep(1, 3, linkAt(initial.editor, 1)))
  assert.equal(tr.doc.nodeAt(2)!.marks.find(mark => mark.type.name === 'link')!.attrs.href, 'Two.md')
  const changed = prepare(initial.editor, initial.provenance, tr)
  assert.equal(changed.blocks[0].content, 'A[B](Two.md)')
  assert.equal(changed.bindingClaims.length, 1)
  assert.ok(changed.bindingClaims[0].kind === 'continue')
  assert.equal(changed.bindingClaims[0].source.raw, 'Two.md')
})

test('unknown local tokens, whole-document rebuilds and false atom attribute claims reject without consuming the original provenance', () => {
  const initial = open(), before = initial.editor.doc.toJSON()
  const unknown = initial.editor.tr.addMark(1, 3, withRichLinkOccurrence(linkAt(initial.editor, 1), 'forged'))
  assert.throws(() => prepare(initial.editor, initial.provenance, unknown), /来源|token|link/)
  assert.throws(() => prepare(initial.editor, initial.provenance,
    initial.editor.tr.replaceWith(0, initial.editor.doc.content.size, initial.editor.doc.content)), /整页/)
  const atom = open([block('definition', '[r]: Target.md'), block('other', 'Other')])
  const entry = richBlockEntries(atom.editor.doc)[0], forged = atom.editor.tr.setNodeMarkup(entry.pos, undefined,
    { ...entry.node.attrs, block: { ...entry.node.attrs.block, content: '[r]: Hijack.md' } })
  assert.throws(() => setRichAtomAttributeIntent(forged, 0), /正文/)
  assert.deepEqual(initial.editor.doc.toJSON(), before)
  const valid = prepare(initial.editor, initial.provenance, initial.editor.tr.insertText('x', 2))
  assert.equal(valid.bindingClaims[0].kind, 'continue')
})

test('unproven neutral whitespace swallowed by an active writer run rejects rather than becoming new or choosing a token', () => {
  const initial = open(), tr = initial.editor.tr.insert(2, schema.text('  ', [schema.marks.strong.create()]))
  const rendered = serializeRichTextInlineWithLinkTrace(tr.doc.firstChild!)
  assert.equal(rendered.linkDestinations.length, 1)
  assert.deepEqual(rendered.linkDestinations[0].pmSpans, [{ from: 0, to: 4 }])
  assert.throws(() => prepare(initial.editor, initial.provenance, tr), /来源/)
  assert.equal(initial.editor.doc.textContent, 'AB')
})

test('an actual unchanged source atom retains all inactive-definition and Wiki keys through explicit identity repair only', () => {
  const initial = open([block('atom', '[[Target]]'), block('other', 'Other')]), entry = richBlockEntries(initial.editor.doc)[0]
  const tr = initial.editor.tr.setNodeMarkup(entry.pos, undefined, { ...entry.node.attrs,
    block: { ...entry.node.attrs.block, id: randomUUID() } })
  setRichAtomAttributeIntent(tr, 0)
  const changed = prepare(initial.editor, initial.provenance, tr)
  assert.equal(changed.bindingClaims[0].kind, 'continue')
  assert.equal(changed.bindingClaims[0].destination.blockId, changed.blocks[0].id)
  const unproved = initial.editor.tr.replaceWith(0, entry.node.nodeSize, entry.node)
  assert.throws(() => prepare(initial.editor, initial.provenance, unproved), /原子/)
})

test('raw CRLF and entity offsets on an unrelated block survive while a definition continues once and materialized uses copy then rebase', () => {
  const raw = '😀\r\n[unchanged](Target&#46;md)\r\n'
  const initial = open([block('raw', raw), block('definition', '[r]: Target.md'), block('uses', '[one][r] [two][r]')])
  const use = richBlockEntries(initial.editor.doc)[2]
  const changed = prepare(initial.editor, initial.provenance, initial.editor.tr.addMark(use.pos + 1, use.pos + 4, schema.marks.strong.create()))
  assert.equal(changed.blocks[0].content, raw)
  const definition = changed.bindingClaims.filter(claim => claim.destination.blockId === 'definition')
  const uses = changed.bindingClaims.filter(claim => claim.destination.blockId === 'uses')
  assert.deepEqual(definition.map(claim => claim.kind), ['continue'])
  assert.deepEqual(uses.map(claim => claim.kind), ['copy', 'copy'])
  assert.ok(uses.every(claim => claim.kind === 'copy' && claim.source.kind === 'current' && claim.source.key.blockId === 'definition'))
  assert.equal(changed.blocks[2].content.includes('[r]'), false)
  const typed = prepare(changed.editor, changed.provenance, changed.editor.tr.insertText('x', use.pos + 2))
  const currentUse = typed.bindingClaims.find(claim => claim.destination.blockId === 'uses')
  assert.ok(currentUse?.kind === 'continue')
  assert.deepEqual(currentUse.source, uses[0].destination)
})

test('new same-href reference use materializes its owning block and never rebinds the still-physical definition or other use', () => {
  const initial = open([block('definition', '[r]: Target.md'), block('uses', '[one][r] [two][r]')])
  const use = richBlockEntries(initial.editor.doc)[1], mark = withRichLinkOccurrence(linkAt(initial.editor, use.pos + 1), randomUUID())
  const tr = initial.editor.tr.addMark(use.pos + 1, use.pos + 4, mark)
  setRichNewLinkIntent(tr, { stepIndex: tr.steps.length - 1, from: use.pos + 1, to: use.pos + 4, token: richLinkOccurrence(mark)! })
  const changed = prepare(initial.editor, initial.provenance, tr)
  assert.equal(changed.blocks[1].content, '[one](Target.md) [two](Target.md)')
  assert.deepEqual(changed.bindingClaims.map(claim => claim.kind), ['continue', 'new', 'copy'])
  assert.equal(changed.bindingClaims[0].destination.blockId, 'definition')
  const second = changed.bindingClaims[2]
  assert.ok(second.kind === 'copy' && second.source.kind === 'current')
  assert.equal(second.source.key.blockId, 'definition')
})

test('an actual zero-width empty destination with emoji and a title retains its current source through formatting', () => {
  const content = '[中文😀](<> "title")', initial = open([block('empty-href', content)])
  const changed = prepare(initial.editor, initial.provenance, initial.editor.tr.addMark(1, 5, schema.marks.strong.create()))
  assert.equal(changed.bindingClaims.length, 1)
  const claim = changed.bindingClaims[0]
  assert.ok(claim.kind === 'continue')
  assert.equal(claim.source.from, claim.source.to)
  assert.equal(claim.destination.from, claim.destination.to)
  assert.equal(claim.destination.raw, '')
  assert.ok(changed.blocks[0].content.includes('<> "title"'))
})
