import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarkdownBlocks, parseMarkdownBackupDocument, serializeBlocksToMarkdown, serializeMarkdownWithBlockRanges,
  type MarkdownRenderableBlock, type MarkdownBlockSourceRange, type MarkdownContainerClosingRange } from '../src/shared/markdown'
import { markdownEngine, type MarkdownNode } from '../src/shared/markdownEngine'
import { NativeMarkdownContainerError, assertNativeContainerParse } from '../src/shared/markdownContainers'
import { hasMarkdownColumnsTokens } from '../src/shared/markdownColumns'
import { parseMarkdownDocumentBlocks } from '../src/shared/markdownDocument'
import { collectDocumentMarkdownLinks, rewriteDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { collectDocumentMarkdownCompatibility } from '../src/shared/markdownCompatibility'
import { htmlClipboardToMarkdown } from '../src/shared/htmlClipboard'
import { NATIVE_LITERAL_MARKER } from '../src/shared/markdownNativeText'
import { createMarkdownSourceDraft, replaceMarkdownSource, markdownSourceDraftToBlocks } from '../src/renderer/src/utils/markdownSourceDraft'
import type { DocumentBlockDraft } from '../src/shared/contracts'

const block = (id: string, type: string, content: string, depth = 0, parentBlockId: string | null = null,
  extra: Partial<MarkdownRenderableBlock> = {}): MarkdownRenderableBlock => ({ id, type, content, depth, parentBlockId, checked: false, ...extra })
const column = (id: string, weight: number, depth = 1, owner = 'columns') => block(id, 'column', '', depth, owner, { markdownFormat: { columnWeight: weight } })
const shape = (values: MarkdownRenderableBlock[]) => values.map(value => ({ type: value.type, content: value.content,
  depth: value.depth ?? 0, checked: Boolean(value.checked), listStart: value.listStart, markdownFormat: value.markdownFormat }))
const identity = (values: MarkdownRenderableBlock[]) => values.map(value => ({ ...shape([value])[0], id: value.id,
  parentBlockId: value.parentBlockId ?? null, tags: value.tags, highlight: value.highlight }))
const walk = (nodes: MarkdownNode[]): MarkdownNode[] => nodes.flatMap(node => [node, ...walk(node.children)])
const fixture = (): MarkdownRenderableBlock[] => [
  block('columns', 'columns', '', 0, null, { tags: ['layout'], highlight: 'blue' }),
  column('left', 3700),
  block('heading', 'heading-2', 'Column heading', 2, 'left'),
  block('task', 'todo', 'Task [Reference][dest] [^note]', 2, 'left', { checked: true, markdownFormat: { listMarker: '+', listLoose: true } }),
  block('nested-list', 'numbered-list', 'Nested', 3, 'task', { listStart: 4, markdownFormat: { listMarker: ')', listLoose: false } }),
  block('toggle', 'toggle', 'Title [direct](Guide.md#heading) `</div>`', 2, 'left', { markdownFormat: { toggleDefaultOpen: false } }),
  block('literal', 'paragraph', 'Before [one](Guide.md#one)\n</section>\n</div>\nAfter [two](Guide.md#two) ' + NATIVE_LITERAL_MARKER, 3, 'toggle', { tags: ['body'], highlight: 'yellow' }),
  block('table', 'table', '<!-- knowbook:table-widths:v1 [160,null] -->\n| A | B |\n| - | - |\n| [Cell][dest] | Two |', 2, 'left'),
  block('nested-columns', 'columns', '', 2, 'left'),
  column('nested-column', 10000, 3, 'nested-columns'),
  block('callout', 'callout', 'Nested callout', 4, 'nested-column', { markdownFormat: { calloutKind: 'tip', calloutIcon: 'book', calloutTone: 'blue' } }),
  block('deep-toggle', 'toggle', 'Deep', 5, 'callout', { markdownFormat: { toggleDefaultOpen: true } }),
  block('deep-leaf', 'paragraph', 'Depth six', 6, 'deep-toggle'),
  column('right', 6300),
  block('code', 'code', '</section>\n</div>\n<section data-knowbook-container="columns-v1">', 2, 'right', { language: 'html', markdownFormat: { codeInfo: 'html' } }),
  block('math', 'math', 'x + </section>', 2, 'right'),
  block('legacy', 'html', '<details>\n<summary>Legacy</summary>\n\n</section>\n</div>\n\n</details>', 2, 'right'),
  block('definitions', 'paragraph', '[dest]: Guide.md#heading\n\n[^note]: Shared definition', 2, 'right'),
  block('after', 'paragraph', 'After columns')
]
const emptyGroup = (weights: number[]) => [block('columns', 'columns', ''), ...weights.map((weight, index) => column('column-' + index, weight))]

test('columns preserve mixed forests, nested containers, exact weights and content through three plain and backup cycles', () => {
  const original = fixture()
  for (const includeBlockMetadata of [false, true]) {
    let values = original, expectedHtml = ''
    for (let cycle = 0; cycle < 3; cycle++) {
      const source = serializeBlocksToMarkdown(values, { includeBlockMetadata })
      const restored = parseMarkdownBlocks(source)
      assert.deepEqual(shape(restored), shape(original))
      assert.equal(restored[0].content, ''); assert.equal(restored[1].content, '')
      assert.match(source, /<section data-knowbook-container="columns-v1"/)
      assert.match(source, /<div data-knowbook-container="column-v1" data-knowbook-weight="3700"/)
      const html = markdownEngine.render(source)
      if (!cycle) expectedHtml = html
      else assert.equal(html, expectedHtml)
      if (includeBlockMetadata) assert.deepEqual(identity(parseMarkdownBackupDocument(source).blocks), identity(original))
      else {
        assert.doesNotMatch(source, /knowbook:block|"id"|parentBlockId|deep-leaf|nested-column/)
        assert.ok(restored.every(value => value.id === undefined && value.parentBlockId === null))
      }
      values = restored
    }
  }
})

test('one to six empty columns are structural children without invented paragraphs, including CRLF files', () => {
  for (let count = 1; count <= 6; count++) {
    const base = Math.floor(10000 / count), weights = Array.from({ length: count }, (_, index) => base + (index < 10000 % count ? 1 : 0))
    const original = emptyGroup(weights)
    for (const includeBlockMetadata of [false, true]) {
      const source = serializeBlocksToMarkdown(original, { includeBlockMetadata }).replace(/\n/g, '\r\n')
      const restored = parseMarkdownBlocks(source)
      assert.equal(restored.length, count + 1)
      assert.deepEqual(shape(restored), shape(original))
      assert.ok(restored.every(value => value.content === ''))
    }
  }
})

test('layout opening/body/closing ranges stay disjoint and exact for nested plain and backup source', () => {
  for (const includeBlockMetadata of [false, true]) {
    const serialized = serializeMarkdownWithBlockRanges(fixture(), { includeBlockMetadata })
    const ranges: MarkdownBlockSourceRange[] = [], closing: MarkdownContainerClosingRange[] = []
    parseMarkdownBlocks(serialized.markdown, ranges, closing)
    assert.deepEqual(ranges, serialized.ranges); assert.deepEqual(closing, serialized.closingRanges)
    const lines = serialized.markdown.split('\n')
    for (const close of closing) {
      assert.match(lines.slice(close.startLine, close.endLine).join('\n'), /^<\/(?:section|div|aside|details)>$/)
      assert.ok(ranges.every(range => range.endLine <= close.startLine || range.startLine >= close.endLine))
    }
    for (const index of [0, 1, 8, 9, 13]) {
      assert.equal(ranges[index].endLine - ranges[index].startLine, includeBlockMetadata ? 2 : 1)
      assert.match(lines[ranges[index].endLine - 1], /^<(?:section|div) /)
    }
  }
})

test('columns share one references/notes/tasks parse and keep original link and diagnostic offsets after finite escrow', () => {
  const original = fixture(), model = parseMarkdownDocumentBlocks(original)
  assert.equal(walk(model.blockNodes[3]).filter(node => node.token.type === 'footnote_ref').length, 1)
  assert.ok(walk(model.blockNodes[3]).some(node => node.token.attrGet('href') === 'Guide.md#heading'))
  assert.ok(walk(model.footnotes).some(node => node.token.type === 'footnote_open'))
  assert.equal([...model.taskTargets.values()].find(value => value.blockId === 'task')?.offset, null)
  for (const index of [0, 1, 8, 9, 13]) assert.deepEqual(model.blockNodes[index], [])
  const links = collectDocumentMarkdownLinks(original).filter(link => link.kind === 'link')
  assert.ok(links.some(link => link.blockId === 'literal' && link.url === 'Guide.md#two'))
  for (const link of links) assert.equal(original[link.blockIndex].content.slice(link.start, link.end), link.url)
  const rewritten = rewriteDocumentMarkdownLinks(original, () => 'Moved.md#target')
  assert.ok(collectDocumentMarkdownLinks(rewritten).some(link => link.url === 'Moved.md#target'))
  assert.deepEqual(rewritten.map(value => [value.id, value.parentBlockId, value.markdownFormat]), original.map(value => [value.id, value.parentBlockId, value.markdownFormat]))
  const values = [...emptyGroup([10000]), block('diagnostic', 'paragraph', 'Before </section> <kbd style="color:red">Ctrl</kbd>', 2, 'column-0')]
  const findings = collectDocumentMarkdownCompatibility(values)
  assert.ok(findings.some(value => value.blockId === 'diagnostic' && value.offset === values[2].content.indexOf('<kbd') && value.source === '<kbd style="color:red">'))
})

test('columns protocol detection visits actual native grammar, never fences, inline code, legacy HTML or foreign clipboard wrappers', () => {
  const source = serializeBlocksToMarkdown(emptyGroup([5000, 5000]))
  assert.equal(hasMarkdownColumnsTokens(markdownEngine.parse(source, {})), true)
  for (const literal of ['```html\n' + source + '\n```', '`<section data-knowbook-container="columns-v1">`',
    '<section class="columns">\n<div>Plain</div>\n</section>', '<details>\n<summary>Legacy</summary>\n\n' + source + '\n\n</details>']) {
    assert.equal(hasMarkdownColumnsTokens(markdownEngine.parse(literal, {})), false)
  }
  const external = htmlClipboardToMarkdown(source.replace('>\n\n</div>', '>\n\nText\n\n</div>'))
  assert.equal(hasMarkdownColumnsTokens(markdownEngine.parse(external, {})), false)
  assert.doesNotMatch(external, /data-knowbook-container|data-knowbook-weight/)
})

test('malformed shells, orphan columns, illegal direct children and noncanonical weights fail before import or export', () => {
  const valid = serializeBlocksToMarkdown(emptyGroup([5000, 5000]))
  const only = serializeBlocksToMarkdown(emptyGroup([10000]))
  const seven = '<section data-knowbook-container="columns-v1">\n\n' + [1400, 1400, 1400, 1400, 1400, 1400, 1600]
    .map(weight => '<div data-knowbook-container="column-v1" data-knowbook-weight="' + weight + '">\n\n</div>').join('\n\n') + '\n\n</section>'
  const invalid = [
    valid.replace('columns-v1', 'columns-v99'), valid.replace('<section ', '<div ').replace('</section>', '</div>'),
    valid.replace('data-knowbook-weight="5000"', 'data-knowbook-weight="4999"'),
    ...['0', '-1', '10001', '2.5', '05000', 'NaN', '1e4'].map(weight => only.replace('data-knowbook-weight="10000"', 'data-knowbook-weight="' + weight + '"')),
    valid.replace(' data-knowbook-weight="5000"', ''), valid.replace('column-v1"', 'column-v1" onclick="evil()"'),
    valid.replace('columns-v1"', 'columns-v1" data-knowbook-container="columns-v1"'),
    valid.replace('columns-v1"', 'columns-v1" style="display:grid"'),
    valid.replace(/\n\n<div data-knowbook-container/, '\n\nUnexpected\n\n<div data-knowbook-container'),
    valid.replace('<section ', '<section\n'), valid.slice(0, valid.lastIndexOf('</section>')),
    '<div data-knowbook-container="column-v1" data-knowbook-weight="10000">\n\n</div>',
    '<section data-knowbook-container="columns-v1">\n\n</section>',
    only.replace('column-v1"', 'column-v1" data-knowbook-kind="note"'), seven
  ]
  for (const source of invalid) assert.throws(() => parseMarkdownBlocks(source), NativeMarkdownContainerError, source)
  assert.throws(() => serializeBlocksToMarkdown(emptyGroup([4000, 5000])), NativeMarkdownContainerError)
  assert.throws(() => serializeBlocksToMarkdown([block('orphan', 'column', '', 0, null, { markdownFormat: { columnWeight: 10000 } })]), NativeMarkdownContainerError)
  assert.throws(() => serializeBlocksToMarkdown([block('columns', 'columns', 'Unexpected'), column('one', 10000)]), NativeMarkdownContainerError)
  for (const source of [invalid[0], invalid[2], seven, '<section data-knowbook-container="columns-v1">\n\nText\n\n</section>']) {
    const env: Record<string, unknown> = {}
    markdownEngine.parse(source, env)
    assert.throws(() => assertNativeContainerParse(env), NativeMarkdownContainerError)
  }
})

test('backup rejects identity, parent, format and shell weight mismatches before normalization can repair them', () => {
  const source = serializeBlocksToMarkdown(emptyGroup([5000, 5000]), { includeBlockMetadata: true })
  for (const invalid of [
    source.replace('"columnWeight":5000', '"columnWeight":4999'), source.replace('"columnWeight":5000', '"columnWeight":5000.5'),
    source.replace('"columnWeight":5000', '"columnWeight":5000,"calloutKind":"tip"'),
    source.replace('"parentBlockId":"columns"', '"parentBlockId":"other"'),
    source.replace('"id":"column-1"', '"id":"column-0"'), source.replace('"depth":1', '"depth":0'),
    source.replace('"type":"column"', '"type":"toggle"'), source.replace('"columnWeight":5000', '"columnWeight":"5000"'),
    source.replace('"id":"column-0"', '"id":12'), source.replace('"id":"column-0"', '"id":" column-0 "'),
    source.replace('"parentBlockId":"columns"', '"parentBlockId":42'), source.replace('"depth":1', '"depth":"1"'),
    source.replace('"type":"column"', '"type":"column","listStart":1')
  ]) assert.throws(() => parseMarkdownBackupDocument(invalid), NativeMarkdownContainerError, invalid)
})

test('literal div and section openers do not consume native owner closers and escrow decodes exactly once', () => {
  const content = '<div class="literal">\nText\n</div>\n<section>\nMore\n</section>\n' + NATIVE_LITERAL_MARKER + '&lt;/section&gt;'
  const original = [...emptyGroup([10000]), block('body', 'paragraph', content, 2, 'column-0')]
  for (const includeBlockMetadata of [false, true]) {
    let values = original
    for (let cycle = 0; cycle < 3; cycle++) {
      values = parseMarkdownBlocks(serializeBlocksToMarkdown(values, { includeBlockMetadata }))
      assert.equal(values.length, 3)
      assert.equal(values[2].content, content)
    }
  }
})

test('source drafts preserve layout identity, empty columns and mixed parent paths when editing child content or paired weights', () => {
  const values = fixture().map(value => ({ ...value, checked: Boolean(value.checked), depth: value.depth ?? 0,
    language: value.language ?? undefined })) as DocumentBlockDraft[]
  const draft = createMarkdownSourceDraft(values)
  const at = draft.source.indexOf('Depth six')
  const edited = markdownSourceDraftToBlocks(replaceMarkdownSource(draft, { from: at, to: at + 'Depth six'.length, insert: 'Edited deep child' }))
  assert.deepEqual(edited.map(value => [value.id, value.parentBlockId, value.markdownFormat, value.tags, value.highlight]),
    values.map(value => [value.id, value.parentBlockId, value.markdownFormat, value.tags, value.highlight]))
  assert.equal(edited[12].content, 'Edited deep child')
  let weighted = draft
  for (const [before, after] of [['3700', '4000'], ['6300', '6000']]) {
    const position = weighted.source.indexOf('data-knowbook-weight="' + before + '"') + 'data-knowbook-weight="'.length
    weighted = replaceMarkdownSource(weighted, { from: position, to: position + before.length, insert: after })
  }
  const resized = markdownSourceDraftToBlocks(weighted)
  assert.deepEqual(resized.map(value => [value.id, value.parentBlockId]), values.map(value => [value.id, value.parentBlockId]))
  assert.equal(resized[1].markdownFormat?.columnWeight, 4000)
  assert.equal(resized[13].markdownFormat?.columnWeight, 6000)
  const empty = emptyGroup([5000, 5000]).map(value => ({ ...value, checked: false, depth: value.depth ?? 0 })) as DocumentBlockDraft[]
  const emptyDraft = createMarkdownSourceDraft(empty)
  const spacing = replaceMarkdownSource(emptyDraft, { from: emptyDraft.source.length, to: emptyDraft.source.length, insert: '\n' })
  assert.deepEqual(identity(markdownSourceDraftToBlocks(spacing)), identity(empty))
  const brokenAt = draft.source.indexOf('data-knowbook-weight="3700"') + 'data-knowbook-weight="'.length
  assert.throws(() => markdownSourceDraftToBlocks(replaceMarkdownSource(draft, { from: brokenAt, to: brokenAt + 4, insert: '3701' })), NativeMarkdownContainerError)
})
