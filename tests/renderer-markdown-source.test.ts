import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarkdownBlocks, type MarkdownBlockSourceRange } from '../src/shared/markdown'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { createMarkdownSourceDraft, markdownSourceChange, markdownSourceDraftToBlocks, replaceMarkdownSource } from '../src/renderer/src/utils/markdownSourceDraft'
import { formatMarkdownSelection } from '../src/renderer/src/utils/markdownFormatting'
import { normalizeDraftBlocks, validateBlockTreeStructure } from '../src/renderer/src/utils/draftTreeNormalization'

const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0, tags: [id], highlight: 'yellow' })

test('source parsing reports separate ranges for list parents, children and reference definitions', () => {
  const source = '# Title\n\n- Parent\n  - Child\n\n[ref]: https://example.com\n\nTail'
  const ranges: MarkdownBlockSourceRange[] = []
  const blocks = parseMarkdownBlocks(source, ranges)
  assert.deepEqual(blocks, parseMarkdownBlocks(source))
  assert.deepEqual(ranges.map(r => source.split('\n').slice(r.startLine, r.endLine).join('\n')),
    ['# Title', '- Parent', '  - Child', '[ref]: https://example.com', 'Tail'])
})

test('source no-op and untouched multiline groups retain all existing metadata', () => {
  const blocks = [paragraph('multi', 'First\n\nSecond'), paragraph('last', 'Last')]
  const draft = createMarkdownSourceDraft(blocks)
  assert.equal(markdownSourceDraftToBlocks(draft), blocks)
  const next = replaceMarkdownSource(draft, { from: draft.source.length, to: draft.source.length, insert: ' edited' })
  const result = markdownSourceDraftToBlocks(next)
  assert.equal(result.length, 2)
  assert.equal(result[0].content, blocks[0].content)
  assert.deepEqual(result.map(b => [b.id, b.tags, b.highlight]), blocks.map(b => [b.id, b.tags, b.highlight]))
  assert.equal(result[1].content, 'Last edited')
})

test('inserting and deleting duplicate paragraphs retains the correct surviving identity', () => {
  let draft = createMarkdownSourceDraft([paragraph('one', 'Same'), paragraph('two', 'Same'), paragraph('three', 'Tail')])
  const inserted = 'Same\n\n' + draft.source
  draft = replaceMarkdownSource(draft, markdownSourceChange(draft.source, inserted, 0))
  assert.deepEqual(markdownSourceDraftToBlocks(draft).map(b => b.id), [undefined, 'one', 'two', 'three'])
  draft = replaceMarkdownSource(draft, { from: 6, to: 12, insert: '' })
  assert.deepEqual(markdownSourceDraftToBlocks(draft).map(b => b.id), [undefined, 'two', 'three'])
})

test('cross-block formatting retains identities, annotations and literal block contents', () => {
  const blocks = [paragraph('one', 'First 中文🙂.'), { ...paragraph('code', 'literal **value**'), type: 'code', language: 'text' },
    paragraph('two', 'Second 日本語한글.')]
  let draft = createMarkdownSourceDraft(blocks)
  const result = formatMarkdownSelection(draft.source, 0, draft.source.length, 'bold', 'Link', change => { draft = replaceMarkdownSource(draft, change) })
  assert.equal(draft.source, result.content)
  const parsed = markdownSourceDraftToBlocks(draft)
  assert.deepEqual(parsed.map(b => b.id), ['one', 'code', 'two'])
  assert.deepEqual(parsed.map(b => b.tags), blocks.map(b => b.tags))
  assert.equal(parsed[0].content, '**First 中文🙂.**')
  assert.equal(parsed[1].content, 'literal **value**')
  assert.equal(parsed[2].content, '**Second 日本語한글.**')
})

test('replacing a selected duplicate range retains the first replaced identity, not a matching suffix', () => {
  const base = createMarkdownSourceDraft([paragraph('one', 'Same'), paragraph('two', 'Same'), paragraph('three', 'Tail')])
  const draft = replaceMarkdownSource(base, markdownSourceChange(base.source, 'Same\n\nTail', 0, 12))
  assert.deepEqual(markdownSourceDraftToBlocks(draft).map(b => b.id), ['one', 'three'])
})

test('source splits and merges have unique identities and retain only surviving block metadata', () => {
  const base = createMarkdownSourceDraft([paragraph('one', 'Alpha Beta'), paragraph('two', 'Gamma')])
  const split = replaceMarkdownSource(base, { from: 5, to: 6, insert: '\n\n' })
  assert.deepEqual(markdownSourceDraftToBlocks(split).map(b => b.id), ['one', undefined, 'two'])
  const merge = replaceMarkdownSource(base, { from: 10, to: 12, insert: ' ' })
  const merged = markdownSourceDraftToBlocks(merge)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'one')
  assert.equal(merged[0].content, 'Alpha Beta Gamma')
  const replaced = replaceMarkdownSource(base, { from: 0, to: base.source.length, insert: '# Replacement' })
  assert.deepEqual(markdownSourceDraftToBlocks(replaced).map(b => b.id), ['one'])
})

test('source indentation rebuilds parents without carrying stale relationships', () => {
  const blocks = normalizeDraftBlocks(parseMarkdownBlocks('- Parent\n  - Child\n- Sibling').map((b, i) => ({ ...b, id: `list-${i}`, checked: false, depth: b.depth ?? 0, language: b.language ?? undefined })))
  let draft = createMarkdownSourceDraft(blocks)
  const from = draft.source.indexOf('  - Child')
  draft = replaceMarkdownSource(draft, { from, to: from + 2, insert: '' })
  const result = normalizeDraftBlocks(markdownSourceDraftToBlocks(draft))
  assert.deepEqual(result.map(b => b.id), blocks.map(b => b.id))
  assert.equal(result[1].parentBlockId, null)
  assert.equal(result[1].depth, 0)
  assert.equal(validateBlockTreeStructure(result).valid, true)
})

test('pasted source metadata cannot assign a foreign or duplicate block identity', () => {
  const base = createMarkdownSourceDraft([paragraph('existing', 'Safe')])
  const draft = replaceMarkdownSource(base, { from: base.source.length, to: base.source.length,
    insert: '\n\n<!-- knowbook:block {"type":"paragraph","id":"foreign","tags":["injected"]} -->\nNew' })
  const result = markdownSourceDraftToBlocks(draft)
  assert.deepEqual(result.map(b => b.id), ['existing', undefined])
  assert.equal(result[1].tags, undefined)
})

test('source edits preserve untouched mixed Markdown groups and blank block identities', () => {
  const blocks = [paragraph('mixed', '# Heading\n\n- Item'), paragraph('blank', ''), paragraph('last', 'Last')]
  const base = createMarkdownSourceDraft(blocks)
  const draft = replaceMarkdownSource(base, { from: base.source.length, to: base.source.length, insert: ' edit' })
  const result = markdownSourceDraftToBlocks(draft)
  assert.deepEqual(result.map(b => b.id), ['mixed', 'blank', 'last'])
  assert.equal(result[0].content, blocks[0].content)
  assert.equal(result[0].type, 'paragraph')
  const empty = createMarkdownSourceDraft([paragraph('empty', '')])
  assert.equal(markdownSourceDraftToBlocks(replaceMarkdownSource(empty, { from: 0, to: 0, insert: 'Written' }))[0].id, 'empty')
})
