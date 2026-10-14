import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { rewriteDocumentBlockTransferLinks, type BlockTransferLinkContext } from '../src/shared/documentBlockTransferLinks'
import { parseMarkdownBlocks, serializeBlocksToMarkdown } from '../src/shared/markdown'
import { markdownEngine } from '../src/shared/markdownEngine'
import { collectDocumentMarkdownCompatibility } from '../src/shared/markdownCompatibility'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'

const block = (id: string, content: string, type = 'paragraph', depth = 0, parentBlockId: string | null = null): DocumentBlockDraft =>
  ({ id, content, type, checked: false, depth, parentBlockId })
const context = (movedIds: string[]): BlockTransferLinkContext => ({ sourcePath: 'Docs/Source', fromPath: 'Docs/Source', toPath: 'Archive/Target',
  movedIds: new Set(movedIds), bindings: new Map(), targetContent: 'Target[^note]\n\n[^note]: Wrong target note\n\n[ref]: WrongTarget.md\n\n[^knowbook-footnote-moved-1]: Reserved' })

test('native multiline titles rebase explicit and definition links and copy named-note closure with a separate top-level host', () => {
  for (const type of ['callout', 'toggle']) {
    const title = '[Direct](#keep) [Reference][ref]\r\nSecond[^note] ^[inline [Reference][ref] and nested[^note]] `literal[^note] [Reference][ref] </summary> </div>`'
    const blocks = [block('owner', title, type), block('child', 'Child [Reference][ref] and [^note]', 'paragraph', 1, 'owner'),
      block('code', '[Reference][ref] [^note] </details> </aside>', 'code', 1, 'owner'), block('host', 'Moved host'),
      block('definitions', '[ref]: ./Next.md "Original title"\n\n[^note]: Original [Reference][ref] and [local](#keep), nested[^inner].\n\n    Second **paragraph**.\n\n[^inner]: Inner [asset](assets/file.pdf) and `literal[^note]`'),
      block('keep', 'Keep source[^note]')]
    const input = context(['owner', 'child', 'code', 'host'])
    const next = rewriteDocumentBlockTransferLinks(blocks, input)
    assert.equal(next[0].content.slice(0, next[0].content.indexOf('Second')), '[Direct](../Docs/Source.md#keep) [Reference](../Docs/Next.md "Original title")\r\n')
    assert.match(next[0].content, /Second\[\^knowbook-footnote-moved-\d+\]/)
    assert.match(next[0].content, /\^\[inline \[Reference\]\(\.\.\/Docs\/Next\.md "Original title"\) and nested\[\^knowbook-footnote-moved-\d+\]\]/)
    assert.ok(next[0].content.endsWith('`literal[^note] [Reference][ref] </summary> </div>`'))
    assert.match(next[1].content, /^Child \[Reference\]\(\.\.\/Docs\/Next\.md "Original title"\) and \[\^knowbook-footnote-moved-\d+\]$/)
    assert.deepEqual(next[2], blocks[2])
    assert.deepEqual(next.slice(4), blocks.slice(4))
    assert.equal((next[3].content.match(/\[\^knowbook-footnote-moved-\d+\]:/g) ?? []).length, 2)
    const moved = next.slice(0, 4), target = [block('target', input.targetContent!), ...moved]
    const rendered = markdownEngine.render(serializeBlocksToMarkdown(target))
    assert.ok(rendered.includes('Wrong target note'))
    assert.ok(rendered.includes('Original <a href="../Docs/Next.md" title="Original title">Reference</a>'))
    assert.ok(rendered.includes('href="../Docs/Source.md#keep"'))
    assert.ok(rendered.includes('Second <strong>paragraph</strong>'))
    assert.ok(rendered.includes('href="../Docs/assets/file.pdf"'))
    assert.ok(rendered.includes('<code>literal[^note] [Reference][ref] &lt;/summary&gt; &lt;/div&gt;</code>'))
    for (const includeBlockMetadata of [false, true]) {
      let source = serializeBlocksToMarkdown(target, { includeBlockMetadata })
      for (let cycle = 0; cycle < 3; cycle++) {
        assert.equal(markdownEngine.render(source), rendered)
        const parsed = parseMarkdownBlocks(source)
        if (includeBlockMetadata) assert.deepEqual(parsed.map(value => value.id), target.map(value => value.id))
        else assert.ok(parsed.every(value => value.id === undefined))
        source = serializeBlocksToMarkdown(parsed, { includeBlockMetadata })
      }
    }
  }
})

test('native title reference uses keep private moved definition names while source uses retain the original destination', () => {
  for (const type of ['callout', 'toggle']) {
    const blocks = [block('stay', '[Source][shared]'), block('owner', '[Title][shared]\n[Collapsed][]', type),
      block('child', '[Child][shared]', 'paragraph', 1, 'owner'), block('definitions', '[shared]: ./Neighbor.md "Title"\n[Collapsed]: ./Other.md')]
    const input = context(['owner', 'child', 'definitions']); input.targetContent = '[shared]: WrongTarget.md\n[knowbook-moved-1]: Reserved'
    const next = rewriteDocumentBlockTransferLinks(blocks, input)
    assert.equal(next[0].content, '[Source](./Neighbor.md "Title")')
    assert.equal(next[1].content, '[Title][knowbook-moved-2]\n[Collapsed][knowbook-moved-3]')
    assert.equal(next[2].content, '[Child][knowbook-moved-2]')
    assert.equal(next[3].content, '[knowbook-moved-2]: ../Docs/Neighbor.md "Title"\n[knowbook-moved-3]: ../Docs/Other.md')
    const rendered = markdownEngine.render(serializeBlocksToMarkdown(next.slice(1)))
    assert.ok(rendered.includes('href="../Docs/Neighbor.md" title="Title">Title</a>'))
    assert.ok(rendered.includes('href="../Docs/Other.md">Collapsed</a>'))
  }
})

test('native title undefined notes stay literal and native children never become new named-definition copy hosts', () => {
  for (const type of ['callout', 'toggle']) {
    const input = context(['owner', 'child'])
    const literal = [block('owner', 'Undefined[^note] and `literal[^note]`', type), block('child', 'Child', 'paragraph', 1, 'owner')]
    const escaped = rewriteDocumentBlockTransferLinks(literal, input)
    assert.equal(escaped[0].content, 'Undefined\\[^note] and `literal[^note]`')
    const unsafe = [...literal.map(value => value.id === 'owner' ? { ...value, content: 'Title[^n]' } : value), block('definition', '[^n]: Source definition')]
    const before = structuredClone(unsafe)
    assert.throws(() => rewriteDocumentBlockTransferLinks(unsafe, input), /脚注定义.*未移动任何块/)
    assert.deepEqual(unsafe, before)
    const childDefinition = [block('owner', 'Title[^n]', type), block('definition', '[^n]: Child definition', 'paragraph', 1, 'owner'), block('host', 'Moved host')]
    assert.throws(() => rewriteDocumentBlockTransferLinks(childDefinition, context(['owner', 'host'])), /脚注定义.*未移动任何块/)
  }
})
test('native titles preserve exact compatibility and link coordinates without duplicating child diagnostics or widening HTML support', () => {
  for (const type of ['callout', 'toggle']) {
    const title = '<u>Supported</u> <span data-knowbook-text-color="blue">Blue</span>\nUnsafe <kbd style="color:red">Ctrl</kbd> <a href="Guide.md#^block" onclick="evil()">Guide</a> `literal <kbd style="color:red">Ctrl</kbd>`'
    const child = 'Child <kbd class="unsupported">Key</kbd>'
    const blocks = [block('owner', title, type), block('child', child, 'paragraph', 1, 'owner')]
    const before = structuredClone(blocks), issues = collectDocumentMarkdownCompatibility(blocks)
    assert.deepEqual(issues.map(issue => [issue.reason, issue.blockId, issue.offset, issue.source]), [
      ['html-attributes', 'owner', title.indexOf('<kbd style='), '<kbd style="color:red">'],
      ['html-attributes', 'owner', title.indexOf('<a href='), '<a href="Guide.md#^block" onclick="evil()">'],
      ['html-attributes', 'child', child.indexOf('<kbd class='), '<kbd class="unsupported">']
    ])
    const links = collectDocumentMarkdownLinks(blocks)
    assert.deepEqual(links.map(link => [link.blockId, title.slice(link.start, link.end)]), [['owner', 'Guide.md#^block']])
    const rendered = markdownEngine.render(serializeBlocksToMarkdown(blocks))
    assert.doesNotMatch(rendered, /<[a-z][^>]*(?:style=|onclick=|class="unsupported")/i)
    assert.match(rendered, /<u>Supported<\/u>/)
    assert.match(rendered, /data-knowbook-text-color="blue"/)
    assert.deepEqual(blocks, before)
  }
})
test('legacy advanced quote titles inside native mixed children keep source definitions instead of binding target names', () => {
  const blocks = [block('owner', 'Toggle owner', 'toggle'),
    block('quote', '[!TIP]- Title [Ref][ref] [^note]\n\nBody `[Ref][ref] [^note]`', 'quote', 1, 'owner'),
    block('host', 'Moved top-level host'), block('definitions', '[ref]: ./Other.md "Original"\n\n[^note]: Original note')]
  const input = context(['owner', 'quote', 'host'])
  input.targetContent = 'Existing [Ref][ref] [^note]\n\n[ref]: WrongTarget.md\n\n[^note]: Wrong target note'
  const next = rewriteDocumentBlockTransferLinks(blocks, input)
  assert.match(next[1].content, /^\[!TIP\]- Title \[Ref\]\(\.\.\/Docs\/Other\.md "Original"\) \[\^knowbook-footnote-moved-\d+\]\n\nBody `\[Ref\]\[ref\] \[\^note\]`$/)
  const rendered = markdownEngine.render(serializeBlocksToMarkdown([block('target', input.targetContent), ...next.slice(0, 3)]))
  assert.match(rendered, /<details class="markdown-callout" data-callout="tip"><summary>Title <a href="\.\.\/Docs\/Other\.md" title="Original">Ref<\/a>/)
  assert.ok(rendered.includes('Original note') && rendered.includes('Wrong target note'))
  assert.ok(rendered.includes('href="WrongTarget.md">Ref</a>'))
  assert.ok(rendered.includes('<code>[Ref][ref] [^note]</code>'))
  assert.deepEqual(next[3], blocks[3])
  assert.throws(() => rewriteDocumentBlockTransferLinks(blocks, context(['owner', 'quote'])), /脚注定义.*未移动任何块/)
})