import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeNativeLiteralText, decodeNativeLiteralText, NATIVE_LITERAL_MARKER as marker } from '../src/shared/markdownNativeText'
import { parseMarkdownBlocks, serializeBlocksToMarkdown, serializeMarkdownWithBlockRanges, type MarkdownRenderableBlock, type MarkdownBlockSourceRange, type MarkdownContainerClosingRange } from '../src/shared/markdown'
import { collectDocumentMarkdownLinks, rewriteDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { collectDocumentMarkdownCompatibility } from '../src/shared/markdownCompatibility'
import { markdownEngine } from '../src/shared/markdownEngine'
import { createMarkdownSourceDraft, replaceMarkdownSource, markdownSourceDraftToBlocks } from '../src/renderer/src/utils/markdownSourceDraft'
import { rewriteDocumentBlockTransferLinks } from '../src/shared/documentBlockTransferLinks'
import type { DocumentBlockDraft } from '../src/shared/contracts'

const block = (id: string, type: string, content: string, depth = 0, parentBlockId: string | null = null, extra: Partial<DocumentBlockDraft> = {}): DocumentBlockDraft =>
  ({ id, type, content, depth, parentBlockId, checked: false, ...extra })
const authored = marker + '&lt;/aside&gt; ' + marker.repeat(2) + '&lt;/summary&gt; \\</div> &lt;/details&gt; &amp;lt;/div&amp;gt;'
export function literalForest(): DocumentBlockDraft[] {
  return [block('owner', 'callout', '[Before](Guide.md#one) alpha</div>\n\nbeta</summary>\n</aside>\n</details>\n[After](Guide.md#two) ' + authored,
    0, null, { tags: ['owner'], highlight: 'blue', markdownFormat: { calloutKind: 'tip', calloutIcon: 'book', calloutTone: 'blue' } }),
  block('closer', 'paragraph', '</aside>', 1, 'owner', { tags: ['child'], highlight: 'yellow' }),
  block('links', 'paragraph', '[Before](Guide.md#three)\n</aside>\n[After](Guide.md#four) ' + authored, 1, 'owner'),
  block('nested', 'toggle', 'Nested</summary>\n\n[Link](Guide.md#five) ' + authored, 1, 'owner'),
  block('leaf', 'paragraph', '</details>', 2, 'nested'),
  block('code', 'code', marker + '&lt;/aside&gt;\n</aside>\n</details>', 2, 'nested', { language: 'text' }),
  block('math', 'math', marker + '&lt;/aside&gt;\n</aside>', 2, 'nested'),
  block('legacy', 'html', '<details>\n<summary>Legacy</summary>\n\n' + marker + '&lt;/aside&gt;\n</aside>\nTail\n\n</details>', 1, 'owner'),
  block('figure', 'html', '<figure><img src="image.png" alt="Alt"><figcaption>' + marker + '&lt;/aside&gt; Caption</figcaption></figure>', 1, 'owner'),
  block('after', 'paragraph', 'Outside ' + authored)]
}
const structure = (blocks: MarkdownRenderableBlock[]) => blocks.map(value => [value.type, value.content, value.depth])

test('finite native literal codec is reversible for markers, entities, backslashes and each closing spelling', () => {
  for (const raw of [authored, marker, marker.repeat(3), marker + '&lt;/aside&gt;', marker + '&lt;/unknown&gt;',
    ...['</div>', '</summary>', '</aside>', '</details>', '</ASIDE  >'].map(tag => 'alpha' + tag + '\n\nbeta'),
    'Code `' + authored + '</summary>` tail']) {
    const encoded = encodeNativeLiteralText(raw, 'title')
    assert.equal(decodeNativeLiteralText(encoded.source).content, raw)
  }
})

test('dangerous title and child closers preserve exact mixed forest, IDs, metadata and disjoint ranges for three plain and backup cycles', () => {
  const values = literalForest()
  for (const includeBlockMetadata of [false, true]) {
    let blocks: MarkdownRenderableBlock[] = values, html = ''
    for (let cycle = 0; cycle < 3; cycle++) {
      const serialized = serializeMarkdownWithBlockRanges(blocks, { includeBlockMetadata })
      assert.match(serialized.markdown, /data-knowbook-escape="literal-v1"/)
      const ranges: MarkdownBlockSourceRange[] = [], closing: MarkdownContainerClosingRange[] = []
      const parsed = parseMarkdownBlocks(serialized.markdown, ranges, closing)
      assert.deepEqual(structure(parsed), structure(values))
      assert.deepEqual(ranges, serialized.ranges); assert.deepEqual(closing, serialized.closingRanges)
      assert.ok(closing.every(close => ranges.every(range => range.endLine <= close.startLine || range.startLine >= close.endLine)))
      if (includeBlockMetadata) assert.deepEqual(parsed.map(value => [value.id, value.parentBlockId, value.tags, value.highlight, value.markdownFormat]),
        values.map(value => [value.id, value.parentBlockId, value.tags, value.highlight, value.markdownFormat]))
      else { assert.doesNotMatch(serialized.markdown, /knowbook:block|parentBlockId/); assert.ok(parsed.every(value => value.id === undefined)) }
      const rendered = markdownEngine.render(serialized.markdown)
      if (!cycle) html = rendered
      else assert.equal(rendered, html)
      blocks = parsed
    }
  }
})

test('literal source projections keep links and diagnostics exact before and after expanded text, and source edits retain identity', () => {
  const values = literalForest()
  const links = collectDocumentMarkdownLinks(values).filter(link => link.kind === 'link')
  assert.deepEqual(links.map(link => [link.blockId, values[link.blockIndex].content.slice(link.start, link.end)]),
    [['owner', 'Guide.md#one'], ['owner', 'Guide.md#two'], ['links', 'Guide.md#three'], ['links', 'Guide.md#four'], ['nested', 'Guide.md#five']])
  const rewritten = rewriteDocumentMarkdownLinks(values, link => link.kind === 'link' ? 'Moved.md#target' : null)
  assert.equal(collectDocumentMarkdownLinks(rewritten).filter(link => link.url === 'Moved.md#target').length, 5)
  assert.deepEqual(rewritten.map(value => [value.id, value.parentBlockId]), values.map(value => [value.id, value.parentBlockId]))
  const diagnostic = block('diagnostic', 'toggle', 'alpha</summary>\n\nbeta <kbd style="color:red">Ctrl</kbd> [link](Guide.md)')
  const issues = collectDocumentMarkdownCompatibility([diagnostic])
  assert.deepEqual(issues.map(issue => [issue.reason, issue.offset, issue.source]), [['html-attributes', diagnostic.content.indexOf('<kbd'), '<kbd style="color:red">']])
  const draft = createMarkdownSourceDraft(values)
  const urlAt = draft.source.indexOf('Guide.md#two'), source = replaceMarkdownSource(draft, { from: urlAt, to: urlAt + 'Guide.md#two'.length, insert: 'Edited.md#two' })
  const edited = markdownSourceDraftToBlocks(source)
  assert.deepEqual(edited.map(value => [value.id, value.parentBlockId, value.tags, value.highlight, value.markdownFormat]), values.map(value => [value.id, value.parentBlockId, value.tags, value.highlight, value.markdownFormat]))
  assert.equal(edited[0].content, values[0].content.replace('Guide.md#two', 'Edited.md#two'))
  const childFrom = draft.anchors[1].from, childTo = draft.anchors[1].to
  const changed = markdownSourceDraftToBlocks(replaceMarkdownSource(draft, { from: childFrom, to: childTo, insert: 'Edited child' }))
  assert.equal(changed[1].id, 'closer'); assert.equal(changed[1].parentBlockId, 'owner'); assert.equal(changed[1].content, 'Edited child')
})

test('native title reference and named-note transfer still uses original content offsets after literal expansion', () => {
  const values = [block('owner', 'toggle', 'alpha</summary>\n\n[Reference][r] [^n]'), block('closer', 'paragraph', '</details>', 1, 'owner'),
    block('host', 'paragraph', 'Moved host'), block('definitions', 'paragraph', '[r]: Other.md\n\n[^n]: Original note')]
  const next = rewriteDocumentBlockTransferLinks(values, { sourcePath: 'Source', fromPath: 'Source', toPath: 'Archive/Target', movedIds: new Set(['owner', 'closer', 'host']), bindings: new Map(), targetContent: '[r]: Wrong.md\n\n[^n]: Wrong note' })
  assert.match(next[0].content, /^alpha<\/summary>\n\n\[Reference\]\(\.\.\/Other\.md\) \[\^knowbook-footnote-moved-\d+\]$/)
  assert.equal(next[1].content, '</details>')
  const html = markdownEngine.render(serializeBlocksToMarkdown(next.slice(0, 3)))
  assert.ok(html.includes('Original note')); assert.ok(html.includes('href="../Other.md">Reference</a>'))
})

test('ordinary and older native source never adopts the escape marker, while source scope nesting decodes exactly once', () => {
  const content = marker + '&lt;/aside&gt;'
  assert.equal(parseMarkdownBlocks(content)[0].content, content)
  const source = '<details data-knowbook-container="toggle-v1">\n<summary>Old ' + content + '</summary>\n\n' + content + '\n\n</details>'
  const parsed = parseMarkdownBlocks(source)
  assert.equal(parsed[0].content, 'Old ' + content); assert.equal(parsed[1].content, content)
  assert.deepEqual(structure(parseMarkdownBlocks(serializeBlocksToMarkdown(parsed))), structure(parsed))
})

test('paragraph-contained code fences and legacy source preserve original marker-plus-entity text without repeated escaping', () => {
  const raw = 'Before\n\n```text\n' + authored + '\n</aside>\n```\n\nAfter'
  const values = [block('owner', 'toggle', 'Title'), block('paragraph', 'paragraph', raw, 1, 'owner')]
  let blocks: MarkdownRenderableBlock[] = values
  for (let cycle = 0; cycle < 3; cycle++) {
    const source = serializeBlocksToMarkdown(blocks, { includeBlockMetadata: true })
    blocks = parseMarkdownBlocks(source)
    assert.equal(blocks[1].content, raw); assert.equal(blocks[1].id, 'paragraph'); assert.equal(blocks[1].parentBlockId, 'owner')
  }
  let source = serializeBlocksToMarkdown(values), expected = markdownEngine.render(source)
  for (let cycle = 0; cycle < 3; cycle++) {
    const parsed = parseMarkdownBlocks(source), code = parsed.find(value => value.type === 'code')!
    assert.equal(code.content, authored + '\n</aside>')
    source = serializeBlocksToMarkdown(parsed); assert.equal(markdownEngine.render(source), expected)
  }
})
test('a complete legacy details atom retains nested explicit native escape source as bytes through three rounds', () => {
  const raw = '<details>\n<summary>Legacy</summary>\n\n<details data-knowbook-container="toggle-v1" data-knowbook-escape="literal-v1">\n<summary>Inner ' + marker + '&lt;/aside&gt;</summary>\n\n' + marker + '&lt;/aside&gt;\n\n</details>\n\n</details>'
  const values = [block('owner', 'callout', 'Owner'), block('legacy', 'html', raw, 1, 'owner')]
  for (const includeBlockMetadata of [false, true]) {
    let blocks: MarkdownRenderableBlock[] = values
    const html = markdownEngine.render(serializeBlocksToMarkdown(values))
    for (let cycle = 0; cycle < 3; cycle++) {
      const source = serializeBlocksToMarkdown(blocks, { includeBlockMetadata })
      blocks = parseMarkdownBlocks(source)
      assert.equal(blocks[1].content, raw); assert.equal(blocks[1].type, 'html'); assert.equal(blocks[1].depth, 1)
      if (includeBlockMetadata) { assert.equal(blocks[1].id, 'legacy'); assert.equal(blocks[1].parentBlockId, 'owner') }
      assert.equal(markdownEngine.render(source), html)
    }
  }
})
test('scoped marker labels retain Unicode normalization and first binding for both spellings and outer definition order', () => {
  const lower = 'İ😀Name' + marker, upper = 'İ😀NAME' + marker.toUpperCase()
  for (const order of [[lower, upper], [upper, lower]]) {
    const first = order[0] === lower ? 'lower' : 'upper'
    const definitions = order.map(label => '[' + label + ']: https://example.test/' + (label === lower ? 'lower' : 'upper')).join('\n')
    const values = [block('owner', 'toggle', '[Title][' + lower + ']'), block('child', 'paragraph', '[Child][' + upper + ']', 1, 'owner'), block('definitions', 'paragraph', definitions, 1, 'owner')]
    const html = markdownEngine.render(serializeBlocksToMarkdown(values))
    assert.equal((html.match(new RegExp('href="https://example.test/' + first + '"', 'g')) ?? []).length, 2)
    assert.equal((html.match(/<a /g) ?? []).length, 2)
    for (const includeBlockMetadata of [false, true]) {
      let source = serializeBlocksToMarkdown(values, { includeBlockMetadata })
      for (let cycle = 0; cycle < 3; cycle++) {
        assert.equal(markdownEngine.render(source), html)
        const parsed = parseMarkdownBlocks(source)
        assert.deepEqual(structure(parsed), structure(values))
        source = serializeBlocksToMarkdown(parsed, { includeBlockMetadata })
      }
    }
  }
  for (const before of [true, false]) {
    const scoped = [block('owner', 'callout', '[Title][' + lower + ']'), block('definitions', 'paragraph', '[' + lower + ']: https://example.test/native', 1, 'owner')]
    const outer = block('outer', 'paragraph', '[' + upper + ']: https://example.test/outer')
    const values = before ? [outer, ...scoped] : [...scoped, outer]
    const html = markdownEngine.render(serializeBlocksToMarkdown(values))
    assert.match(html, new RegExp('href="https://example.test/' + (before ? 'outer' : 'native') + '">Title</a>'))
  }
})

test('one- and two-marker reference labels stay distinct through native rendering, source editing and transferred definitions', () => {
  const one = 'one' + marker, two = 'one' + marker.repeat(2)
  const values = [block('owner', 'toggle', '[One][' + one + '] [Two][' + two + ']'), block('child', 'paragraph', '[Child][' + one + ']', 1, 'owner'),
    block('host', 'paragraph', 'Moved host'), block('definitions', 'paragraph', '[' + one + ']: Guide1.md "One"\n[' + two + ']: Guide2.md "Two"')]
  const html = markdownEngine.render(serializeBlocksToMarkdown(values))
  assert.equal((html.match(/href="Guide1.md"/g) ?? []).length, 2); assert.equal((html.match(/href="Guide2.md"/g) ?? []).length, 1)
  for (const before of [true, false]) {
    const native = [values[0], { ...values[3], depth: 1, parentBlockId: 'owner' }]
    const outer = block('outer-two', 'paragraph', '[' + two + ']: OuterTwo.md "Outer"')
    const scoped = before ? [outer, ...native] : [...native, outer]
    const rendered = markdownEngine.render(serializeBlocksToMarkdown(scoped))
    assert.match(rendered, /href="Guide1.md" title="One">One<\/a>/)
    assert.match(rendered, new RegExp('href="' + (before ? 'OuterTwo.md" title="Outer' : 'Guide2.md" title="Two') + '">Two</a>'))
    for (const includeBlockMetadata of [false, true]) {
      let source = serializeBlocksToMarkdown(scoped, { includeBlockMetadata })
      for (let cycle = 0; cycle < 3; cycle++) {
        assert.equal(markdownEngine.render(source), rendered)
        source = serializeBlocksToMarkdown(parseMarkdownBlocks(source), { includeBlockMetadata })
      }
    }
  }
  for (const includeBlockMetadata of [false, true]) {
    let source = serializeBlocksToMarkdown(values, { includeBlockMetadata })
    for (let cycle = 0; cycle < 3; cycle++) {
      assert.equal(markdownEngine.render(source), html)
      source = serializeBlocksToMarkdown(parseMarkdownBlocks(source), { includeBlockMetadata })
    }
  }
  const draft = createMarkdownSourceDraft(values), at = draft.source.indexOf('Guide1.md')
  const edited = markdownSourceDraftToBlocks(replaceMarkdownSource(draft, { from: at, to: at + 'Guide1.md'.length, insert: 'Edited.md' }))
  assert.deepEqual(edited.map(value => [value.id, value.parentBlockId]), values.map(value => [value.id, value.parentBlockId]))
  assert.equal((markdownEngine.render(serializeBlocksToMarkdown(edited)).match(/href="Edited.md"/g) ?? []).length, 2)
  for (const moveDefinitions of [false, true]) {
    const ids = ['owner', 'child', 'host', ...(moveDefinitions ? ['definitions'] : [])]
    const target = 'Target [Existing][' + one + ']\n\n[' + one + ']: Existing.md\n[knowbook-moved-1]: Reserved.md'
    const next = rewriteDocumentBlockTransferLinks(values, { sourcePath: 'Source', fromPath: 'Source', toPath: 'Archive/Target', movedIds: new Set(ids), bindings: new Map(), targetContent: target })
    const moved = next.filter(value => ids.includes(value.id!))
    const rendered = markdownEngine.render(target + '\n\n' + serializeBlocksToMarkdown(moved))
    assert.equal((rendered.match(/href="\.\.\/Guide1.md"/g) ?? []).length, 2)
    assert.equal((rendered.match(/href="\.\.\/Guide2.md"/g) ?? []).length, 1)
    assert.match(rendered, /href="Existing.md">Existing<\/a>/)
    if (!moveDefinitions) assert.equal(next[3].content, values[3].content)
  }
  const invalidNote = '[^n' + marker + ']'
  const notes = [block('owner', 'toggle', invalidNote), block('definition', 'paragraph', invalidNote + ': literal', 1, 'owner')]
  assert.doesNotMatch(markdownEngine.render(serializeBlocksToMarkdown(notes)), /class="footnote-ref"/)
})