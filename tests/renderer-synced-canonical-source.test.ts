import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { SyncedCanonicalEdit, SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import { parseMarkdownSourceStrict } from '../src/shared/markdown'
import { serializeSyncedBlockPayload, SyncedValidationError, validateSyncedCanonicalEdit } from '../src/shared/syncedBlockValidation'
import { createCanonicalSourceDraft, canonicalSourceDraftToBlocks, reconcileMarkdownSourceDraft } from '../src/renderer/src/features/synced-blocks/canonicalSource'
import { createMarkdownSourceDraft, replaceMarkdownSourceChanges, type MarkdownSourceDraft } from '../src/renderer/src/utils/markdownSourceDraft'

const paragraph = (id: string, content: string, depth = 0, parentBlockId: string | null = null): SyncedCanonicalEdit =>
  ({ id, type: 'paragraph', content, checked: false, depth, parentBlockId, tags: ['保留'], highlight: 'yellow' })
const replace = (draft: MarkdownSourceDraft, from: number, to: number, insert: string) =>
  replaceMarkdownSourceChanges(draft, [{ from, to, insert }])
const replaceText = (draft: MarkdownSourceDraft, before: string, after: string) => {
  const from = draft.source.indexOf(before)
  assert.ok(from >= 0, before)
  return replace(draft, from, from + before.length, after)
}

test('canonical source creation rejects raw invalid forests without repairing or mutating their input', () => {
  for (const blocks of [[], [paragraph('child', 'Body', 1, 'missing')],
    [paragraph('one', 'Body'), paragraph('one', 'Other')], [paragraph('deep', 'Body', 7)]]) {
    const before = structuredClone(blocks)
    assert.throws(() => createCanonicalSourceDraft(blocks), SyncedValidationError)
    assert.deepEqual(blocks, before)
  }
})

test('canonical source no-op preserves opaque identity bytes, metadata and code aliases', () => {
  const blocks = [paragraph(' 旧:中文🙂 ', 'Body'), { ...paragraph('__proto__', 'const value = 1'), type: 'code',
    language: 'ts', markdownFormat: { codeInfo: 'ts title=sample' } }]
  const draft = createCanonicalSourceDraft(blocks), before = structuredClone(draft)
  assert.deepEqual(canonicalSourceDraftToBlocks(draft, () => { throw new Error('No new identity expected') }), blocks)
  assert.deepEqual(draft, before)
  assert.notEqual(draft.initialBlocks, blocks, 'the strict opening snapshot owns its own block objects')
})

test('editing another block preserves untouched multi-paragraph, mixed Markdown and empty block grouping', () => {
  const blocks = [paragraph(' multi ', 'First\r\n\r\nSecond'), paragraph('__proto__', '# Heading\n\n- Item'),
    paragraph('empty', ''), paragraph('constructor', 'Last')]
  const draft = replaceText(createCanonicalSourceDraft(blocks), 'Last', 'Last edited')
  const result = canonicalSourceDraftToBlocks(draft, () => { throw new Error('Existing identities must survive') })
  assert.equal(result.length, 4)
  assert.deepEqual(result.slice(0, 3), blocks.slice(0, 3))
  assert.deepEqual(result[3], { ...blocks[3], content: 'Last edited' })
})

test('inserting and removing duplicate source text retains the precise surviving anchors once', () => {
  let draft = createCanonicalSourceDraft([paragraph(' one ', 'Same'), paragraph('two', 'Same'), paragraph('tail', 'Tail')])
  draft = replace(draft, 0, 0, 'Same\n\n')
  const insertedId = randomUUID()
  let result = canonicalSourceDraftToBlocks(draft, () => insertedId)
  assert.deepEqual(result.map(block => block.id), [insertedId, ' one ', 'two', 'tail'])
  assert.equal(result[0].tags, undefined)
  draft = replace(draft, 6, 12, '')
  result = canonicalSourceDraftToBlocks(draft, () => insertedId)
  assert.deepEqual(result.map(block => block.id), [insertedId, 'two', 'tail'])
  assert.deepEqual(result[2].tags, ['保留'])
})

test('split and merge consume a surviving old identity once and never merge annotations', () => {
  const initial = [paragraph('first', 'Alpha Beta'), { ...paragraph('second', 'Gamma'), tags: ['另一块'], highlight: 'blue' }]
  const base = createCanonicalSourceDraft(initial), id = randomUUID()
  const split = canonicalSourceDraftToBlocks(replace(base, 5, 6, '\n\n'), () => id)
  assert.deepEqual(split.map(block => [block.id, block.content]), [['first', 'Alpha'], [id, 'Beta'], ['second', 'Gamma']])
  assert.equal(split[1].tags, undefined)
  const merged = canonicalSourceDraftToBlocks(replace(base, 10, 12, ' '))
  assert.deepEqual(merged, [{ ...initial[0], content: 'Alpha Beta Gamma' }])
})

test('new identities must be UUIDs and cannot collide with any opening identity, including a removed block', () => {
  const oldId = randomUUID(), initial = [paragraph(oldId, 'Alpha Beta')]
  const split = replace(createCanonicalSourceDraft(initial), 5, 6, '\n\n'), before = structuredClone(split)
  for (const fresh of [oldId, 'new-but-not-a-uuid']) {
    assert.throws(() => canonicalSourceDraftToBlocks(split, () => fresh), error =>
      error instanceof SyncedValidationError && error.code === 'identity')
    assert.deepEqual(split, before)
  }
  const blank = replace(createCanonicalSourceDraft(initial), 0, 'Alpha Beta'.length, '')
  assert.throws(() => canonicalSourceDraftToBlocks(blank, () => oldId), SyncedValidationError)
  const three = replace(createCanonicalSourceDraft([paragraph('old', 'Alpha Beta Gamma')]), 5, 6, '\n\n')
  const four = replaceText(three, 'Beta Gamma', 'Beta\n\nGamma'), reused = randomUUID()
  assert.throws(() => canonicalSourceDraftToBlocks(four, () => reused), SyncedValidationError)
})

test('foreign metadata cannot claim identity, parent, type, tags or a canonical reference binding', () => {
  const base = createCanonicalSourceDraft([paragraph('safe', 'Safe')]), groupId = randomUUID()
  const metadata = '<!-- knowbook:block {"type":"synced-block","id":"foreign","depth":6,"parentBlockId":"safe","tags":["injected"],"highlight":"red"} -->'
  const literal = ['```knowbook-synced-block-v99', serializeSyncedBlockPayload({ version: 1, groupId }), '```'].join('\n')
  const draft = replace(base, base.source.length, base.source.length, '\n\n' + metadata + '\n' + literal)
  const id = randomUUID(), result = canonicalSourceDraftToBlocks(draft, () => id)
  assert.deepEqual(result.map(block => [block.id, block.type, block.depth, block.parentBlockId]), [['safe', 'paragraph', 0, null], [id, 'code', 0, null]])
  assert.equal(result[1].content, serializeSyncedBlockPayload({ version: 1, groupId }))
  assert.equal(result[1].tags, undefined)
  assert.equal(result[1].highlight, undefined)
})

test('changed code bodies preserve original language aliases and the entire unchanged info string', () => {
  const initial = [{ ...paragraph(' code ', 'const x = 1'), type: 'code', language: 'ts', markdownFormat: { codeInfo: 'ts title=sample' } }]
  const base = createCanonicalSourceDraft(initial)
  const body = canonicalSourceDraftToBlocks(replaceText(base, 'const x = 1', 'const x = 2'))[0]
  assert.deepEqual(body, { ...initial[0], content: 'const x = 2' })
  const info = canonicalSourceDraftToBlocks(replaceText(base, 'ts title=sample', 'py title=next'))[0]
  assert.equal(info.id, initial[0].id)
  assert.equal(info.language, 'python')
  assert.deepEqual(info.markdownFormat, { codeInfo: 'py title=next' })
  assert.deepEqual(info.tags, initial[0].tags)
})

test('source form changes remove obsolete code metadata and derive new language and format from syntax', () => {
  const code = { ...paragraph('same', 'let x = 1'), type: 'code', language: 'js', markdownFormat: { codeInfo: 'js title=old' } }
  const base = createCanonicalSourceDraft([code])
  const prose = canonicalSourceDraftToBlocks(replace(base, 0, base.source.length, 'Prose'))[0]
  assert.deepEqual(prose, paragraph('same', 'Prose'))
  const text = createCanonicalSourceDraft([paragraph('same', 'Prose')])
  const fenced = canonicalSourceDraftToBlocks(replace(text, 0, text.source.length, '```py title=new\nprint(1)\n```'))[0]
  assert.equal(fenced.id, 'same'); assert.equal(fenced.type, 'code'); assert.equal(fenced.language, 'python')
  assert.deepEqual(fenced.markdownFormat, { codeInfo: 'py title=new' })
})

test('empty-code flags and omitted toggle defaults follow the edited syntax without losing local annotations', () => {
  const emptyCode = { ...paragraph('empty-code', ''), type: 'code', language: 'ts', markdownFormat: { codeInfo: 'ts title=empty', emptyCode: true } }
  const codeDraft = createCanonicalSourceDraft([emptyCode]), bodyAt = codeDraft.source.indexOf('\n') + 1
  const written = canonicalSourceDraftToBlocks(replace(codeDraft, bodyAt, bodyAt, 'const x = 1\n'))[0]
  assert.equal(written.id, emptyCode.id); assert.equal(written.language, 'ts')
  assert.equal(written.content, 'const x = 1')
  assert.deepEqual(written.markdownFormat, { codeInfo: 'ts title=empty' })
  const toggle = { ...paragraph('toggle', 'OldTitle'), type: 'toggle' }
  const changed = canonicalSourceDraftToBlocks(replaceText(createCanonicalSourceDraft([toggle]), 'OldTitle', 'NewTitle'))[0]
  assert.deepEqual(changed, { ...toggle, content: 'NewTitle' })
})

test('adding and removing native shells rebuilds the surviving child parent from current syntax', () => {
  const child = paragraph(' child ', 'UniqueBody')
  const owner = { ...paragraph('owner', 'Title'), type: 'callout' }
  const wrapped = createCanonicalSourceDraft([owner, { ...child, depth: 1, parentBlockId: owner.id }])
  const at = wrapped.source.indexOf(child.content), prefix = wrapped.source.slice(0, at), suffix = wrapped.source.slice(at + child.content.length)
  const bare = createCanonicalSourceDraft([child]), newOwner = randomUUID()
  const inside = canonicalSourceDraftToBlocks(replaceMarkdownSourceChanges(bare, [
    { from: 0, to: 0, insert: prefix }, { from: bare.source.length, to: bare.source.length, insert: suffix }
  ]), () => newOwner)
  assert.equal(inside[0].id, newOwner); assert.equal(inside[0].type, 'callout')
  assert.deepEqual(inside[1], { ...child, depth: 1, parentBlockId: newOwner })
  const outside = canonicalSourceDraftToBlocks(replaceMarkdownSourceChanges(wrapped, [
    { from: 0, to: at, insert: '' }, { from: at + child.content.length, to: wrapped.source.length, insert: '' }
  ]))
  assert.deepEqual(outside, [child])
})

test('an untouched Markdown grouping cannot swallow a closing shell that becomes structural after an outside edit', () => {
  const initial = [paragraph('group', 'Body\n\n</details>'), paragraph('tail', 'Tail')]
  const template = createCanonicalSourceDraft([{ ...paragraph('template', 'Title'), type: 'toggle' }, paragraph('body', 'Body', 1, 'template')])
  const prefix = template.source.slice(0, template.source.indexOf('Body')), ownerId = randomUUID()
  const draft = replace(createCanonicalSourceDraft(initial), 0, 0, prefix)
  const result = canonicalSourceDraftToBlocks(draft, () => ownerId)
  assert.deepEqual(result.map(block => [block.id, block.type, block.content, block.depth, block.parentBlockId]), [
    [ownerId, 'toggle', 'Title', 0, null], ['group', 'paragraph', 'Body', 1, ownerId], ['tail', 'paragraph', 'Tail', 0, null]
  ])
})

test('empty paragraph anchors survive within the current native scope without inventing empty-column content', () => {
  const owner = { ...paragraph('toggle', 'Title'), type: 'toggle' }, empty = paragraph('empty', '', 1, owner.id)
  const initial = [owner, empty, paragraph('tail', 'Tail')]
  const result = canonicalSourceDraftToBlocks(replaceText(createCanonicalSourceDraft(initial), 'Tail', 'Tail edit'))
  assert.deepEqual(result[1], empty)
  const columns: SyncedCanonicalEdit[] = [{ ...paragraph('columns', ''), type: 'columns' },
    { ...paragraph('column', '', 1, 'columns'), type: 'column', markdownFormat: { columnWeight: 10000 } }, paragraph('tail', 'Tail')]
  const edited = canonicalSourceDraftToBlocks(replaceText(createCanonicalSourceDraft(columns), 'Tail', 'Tail edit'))
  assert.equal(edited.length, 3)
  assert.deepEqual(edited.slice(0, 2), columns.slice(0, 2))
})

test('deleting the complete canonical source explicitly replaces it with one fresh real empty paragraph', () => {
  const base = createCanonicalSourceDraft([paragraph('old', 'Body')]), draft = replace(base, 0, base.source.length, ''), id = randomUUID()
  const before = structuredClone(draft), result = canonicalSourceDraftToBlocks(draft, () => id)
  assert.deepEqual(result, [{ id, type: 'paragraph', content: '', checked: false, depth: 0, parentBlockId: null }])
  assert.deepEqual(draft, before)
  assert.deepEqual(validateSyncedCanonicalEdit(result), result)
  assert.deepEqual(reconcileMarkdownSourceDraft(draft, parseMarkdownSourceStrict(draft.source, { mode: 'canonical' })), [],
    'the shared mapper does not decide canonical emptiness for host callers')
})

test('over-depth syntax fails atomically without repairing parent relationships or consuming fresh identities', () => {
  const base = createCanonicalSourceDraft([paragraph('original', 'Body')])
  const source = Array.from({ length: 8 }, (_, index) => '  '.repeat(index) + '- Level ' + index).join('\n')
  const changed = replace(base, 0, base.source.length, source), before = structuredClone(changed)
  assert.throws(() => canonicalSourceDraftToBlocks(changed, () => { throw new Error('Do not assign identities to invalid syntax') }), /six levels/)
  assert.deepEqual(changed, before)
})

test('raw UTF-16 anchors keep repeated bodies and native escaped text attached after BOM and CRLF edits', () => {
  const initial = [{ ...paragraph('owner', 'Title'), type: 'callout' }, paragraph(' first ', '🧭 Same\n</aside>', 1, 'owner'),
    paragraph('constructor', '🧭 Same', 1, 'owner'), paragraph('tail', 'Tail')]
  const base = createCanonicalSourceDraft(initial), changes = [...base.source.matchAll(/\n/g)].map(match =>
    ({ from: match.index, to: match.index + 1, insert: '\r\n' }))
  changes.push({ from: 0, to: 0, insert: '\uFEFF' })
  const raw = replaceMarkdownSourceChanges(base, changes)
  const changed = replaceText(raw, 'Tail', 'Tail 日本語🙂')
  const result = canonicalSourceDraftToBlocks(changed)
  assert.deepEqual(result.map(block => [block.id, block.depth, block.parentBlockId, block.tags, block.highlight]),
    initial.map(block => [block.id, block.depth, block.parentBlockId, block.tags, block.highlight]))
  assert.equal(result[1].content, initial[1].content)
  assert.equal(result[2].content, initial[2].content)
})

test('shared reconciliation resolves reference keys exactly and never lets ordinary grouping swallow a reference', () => {
  const groupId = randomUUID(), id = randomUUID(), payload = serializeSyncedBlockPayload({ version: 1, groupId })
  const fence = '```knowbook-synced-block-v1\n' + payload + '\n```'
  const draft = createMarkdownSourceDraft([paragraph('ordinary', fence)])
  const syntax = parseMarkdownSourceStrict(draft.source, { mode: 'internal-host', references: [{ key: 'ref', from: 0, to: fence.length, payload }] })
  const reference: SyncedStableBlockDraft = { ...paragraph(id, payload), type: 'synced-block' }
  const before = structuredClone(draft)
  assert.deepEqual(reconcileMarkdownSourceDraft(draft, syntax, { references: new Map([['ref', reference]]) }), [reference])
  assert.throws(() => reconcileMarkdownSourceDraft(draft, syntax), SyncedValidationError)
  assert.throws(() => reconcileMarkdownSourceDraft(draft, syntax, { references: new Map([['other', reference]]) }), SyncedValidationError)
  assert.throws(() => reconcileMarkdownSourceDraft(draft, syntax, { references: new Map([['ref', { ...reference, content: '{}' }]]) }), SyncedValidationError)
  assert.deepEqual(draft, before)
})

test('shared reconciliation reserves reference IDs before fresh ordinary blocks and derives their current syntax parent', () => {
  const id = randomUUID(), payload = serializeSyncedBlockPayload({ version: 1, groupId: randomUUID() })
  const fence = '```knowbook-synced-block-v1\n' + payload + '\n```'
  const draft = createMarkdownSourceDraft([paragraph('ordinary', 'Original')])
  const changed = replace(draft, draft.source.length, draft.source.length, '\n\n' + fence + '\n\nNew')
  const from = changed.source.indexOf('```'), syntax = parseMarkdownSourceStrict(changed.source,
    { mode: 'internal-host', references: [{ key: 'ref', from, to: from + fence.length, payload }] })
  const reference: SyncedStableBlockDraft = { ...paragraph(id, payload, 1, 'old-parent'), type: 'synced-block' }
  assert.throws(() => reconcileMarkdownSourceDraft(changed, syntax, { references: new Map([['ref', reference]]), freshId: () => id }), SyncedValidationError)
  const result = reconcileMarkdownSourceDraft(changed, syntax, { references: new Map([['ref', reference]]), freshId: randomUUID })
  assert.equal(result[1].id, id); assert.equal(result[1].depth, 0); assert.equal(result[1].parentBlockId, null)
})
