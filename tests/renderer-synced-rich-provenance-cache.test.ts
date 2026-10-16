import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { EditorState, type Transaction } from 'prosemirror-state'
import type { SyncedBindingKey, SyncedCanonicalEdit, SyncedOriginV1 } from '../src/shared/synced-blocks'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { resolveMarkdownDocumentPath } from '../src/shared/markdownLinks'
import { richTextSchema as schema } from '../src/renderer/src/rich-text/schema'
import { richBlockEntries } from '../src/renderer/src/rich-text/model'
import { richLinkOccurrence, withRichLinkOccurrence } from '../src/renderer/src/rich-text/linkProvenance'
import { prepareSyncedRichProvenance, seedSyncedRichProvenance, setRichNewLinkIntent,
  type RichProvenanceState } from '../src/renderer/src/rich-text/richProvenance'

const origin: SyncedOriginV1 = { version: 1, documentId: '旧:宿主', pathAtCreation: 'Original/Host', firstInstanceId: '11111111-1111-4111-8111-111111111111' }
const block = (id: string, content: string): SyncedCanonicalEdit => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null })
function open(blocks: SyncedCanonicalEdit[]) {
  const seed = seedSyncedRichProvenance(blocks, { origin })
  return { editor: EditorState.create({ doc: seed.doc }), provenance: seed.state }
}
const keyId = (key: SyncedBindingKey) => JSON.stringify([key.blockId, key.from, key.to, key.raw, key.syntax])
function actual(blocks: SyncedCanonicalEdit[]): SyncedBindingKey[] {
  return collectDocumentMarkdownLinks(blocks).flatMap(link => link.kind === 'image'
    || link.kind !== 'wiki' && resolveMarkdownDocumentPath(origin.pathAtCreation, link.url) === null ? [] : [{ blockId: link.blockId!,
      from: link.start, to: link.end, raw: blocks[link.blockIndex].content.slice(link.start, link.end),
      syntax: link.kind === 'wiki' ? 'wiki' as const : 'markdown' as const }])
}
function apply(editor: EditorState, provenance: RichProvenanceState, transaction: Transaction) {
  const applied = editor.applyTransaction(transaction)
  const prepared = prepareSyncedRichProvenance(provenance, { before: editor, transactions: applied.transactions, after: applied.state })
  assert.deepEqual(prepared.bindingClaims.map(claim => claim.destination), actual(prepared.blocks), 'Every accepted cache result still matches the complete real collector')
  return { ...prepared, editor: applied.state, provenance: prepared.nextState }
}

test('many unchanged actual PM nodes keep a complete closed key set across multiple accepted local edits', () => {
  const initialBlocks = Array.from({ length: 80 }, (_, index) => block(` opaque:${index} `, `Prefix [label${index}](Target${index}.md)`))
  let current = open(initialBlocks)
  let oldKeys = actual(initialBlocks)
  for (let edit = 0; edit < 4; edit++) {
    const entry = richBlockEntries(current.editor.doc)[39]
    const candidate = apply(current.editor, current.provenance, current.editor.tr.insertText('x', entry.pos + 10))
    assert.equal(candidate.bindingClaims.length, initialBlocks.length)
    assert.ok(candidate.bindingClaims.every(claim => claim.kind === 'continue'))
    for (const [index, claim] of candidate.bindingClaims.entries()) {
      assert.ok(claim.kind === 'continue')
      assert.equal(keyId(claim.source), keyId(oldKeys[index]), 'The accepted current exact key is the next source baseline')
    }
    for (const [index, entryAfter] of richBlockEntries(candidate.editor.doc).entries())
      if (index !== 39) assert.equal(entryAfter.node, richBlockEntries(current.editor.doc)[index].node)
    oldKeys = candidate.bindingClaims.map(claim => claim.destination)
    current = candidate
  }
})

test('new actual local links and same-body new intent cannot reuse the cached previous destination inventory', () => {
  const initial = open([block('intent', '[old](Target.md) plain')])
  const mark = withRichLinkOccurrence(schema.marks.link.create({ href: 'Added.md' }), randomUUID())
  const transaction = initial.editor.tr.addMark(5, 10, mark)
  setRichNewLinkIntent(transaction, { stepIndex: transaction.steps.length - 1, from: 5, to: 10, token: richLinkOccurrence(mark)! })
  const added = apply(initial.editor, initial.provenance, transaction)
  assert.deepEqual(added.bindingClaims.map(claim => claim.kind), ['continue', 'new'])
  assert.deepEqual(added.bindingClaims.map(claim => claim.destination.raw), ['Target.md', 'Added.md'])
  const renewed = withRichLinkOccurrence(added.editor.doc.nodeAt(1)!.marks.find(item => item.type.name === 'link')!, randomUUID())
  const sameBody = added.editor.tr.addMark(1, 4, renewed)
  setRichNewLinkIntent(sameBody, { stepIndex: sameBody.steps.length - 1, from: 1, to: 4, token: richLinkOccurrence(renewed)! })
  const candidate = apply(added.editor, added.provenance, sameBody)
  assert.deepEqual(candidate.blocks, added.blocks)
  assert.deepEqual(candidate.bindingClaims.map(claim => claim.kind), ['new', 'continue'])
  assert.equal(candidate.hasIntent, true)
})

test('reference environments retain full-collector closure when an actual use is materialized and then accepted again', () => {
  const initial = open([block('definition', '[r]: Target.md\r\n[r]: Ignored.md'), block('uses', '[one][r] [two][r]'),
    block('unchanged', '[direct](Direct.md)')])
  const use = richBlockEntries(initial.editor.doc)[1]
  const materialized = apply(initial.editor, initial.provenance, initial.editor.tr.addMark(use.pos + 1, use.pos + 4, schema.marks.strong.create()))
  assert.deepEqual(materialized.bindingClaims.map(claim => claim.kind), ['continue', 'continue', 'copy', 'copy', 'continue'])
  const next = apply(materialized.editor, materialized.provenance, materialized.editor.tr.insertText('x', use.pos + 2))
  assert.ok(next.bindingClaims.every(claim => claim.kind === 'continue'))
  assert.equal(next.blocks[0].content, '[r]: Target.md\r\n[r]: Ignored.md')
})

test('an external reseed is a distinct runtime authority even for equal bodies, and a rejected candidate does not consume the prior cache', () => {
  const blocks = [block('generation', '[old](Target.md)')], first = open(blocks), external = open(structuredClone(blocks))
  assert.notEqual(first.provenance.generation, external.provenance.generation)
  const rejected = first.editor.applyTransaction(first.editor.tr.addMark(1, 4,
    withRichLinkOccurrence(first.editor.doc.nodeAt(1)!.marks.find(item => item.type.name === 'link')!, 'unknown-external')))
  assert.throws(() => prepareSyncedRichProvenance(first.provenance, { before: first.editor, transactions: rejected.transactions, after: rejected.state }), /来源|token|link/)
  assert.throws(() => prepareSyncedRichProvenance(first.provenance, { before: external.editor, transactions: [], after: external.editor }), /世代/)
  const accepted = apply(first.editor, first.provenance, first.editor.tr.insertText('x', 2))
  assert.equal(accepted.bindingClaims[0].kind, 'continue')
})

test('cached fingerprint and inventory facts never bypass strict candidate shape or unproven source-atom rejection', () => {
  const initial = open([block('strict', '[old](Target.md)'), block('other', 'Other')]), original = JSON.stringify(initial.editor.doc.toJSON())
  const entry = richBlockEntries(initial.editor.doc)[0]
  const badMetadata = initial.editor.tr.setNodeMarkup(entry.pos, undefined, { ...entry.node.attrs,
    block: { ...entry.node.attrs.block, injectedAuthority: 'forbidden' } })
  const bad = initial.editor.applyTransaction(badMetadata)
  assert.throws(() => prepareSyncedRichProvenance(initial.provenance, { before: initial.editor, transactions: bad.transactions, after: bad.state }))
  assert.equal(JSON.stringify(initial.editor.doc.toJSON()), original)
  const atom = schema.nodes.source_block.create({ block: block('unproven', '[[Target]]') })
  const unknown = initial.editor.applyTransaction(initial.editor.tr.insert(initial.editor.doc.content.size, atom))
  assert.throws(() => prepareSyncedRichProvenance(initial.provenance, { before: initial.editor, transactions: unknown.transactions, after: unknown.state }), /原子/)
  const valid = apply(initial.editor, initial.provenance, initial.editor.tr.addMark(1, 4, schema.marks.strong.create()))
  assert.equal(valid.bindingClaims.length, 1)
})
