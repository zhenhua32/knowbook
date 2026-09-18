import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarkdownBlocks } from '../src/shared/markdown.ts'
import { collectMarkdownDestinations, collectMarkdownSourceLinks, rewriteMarkdownDestinations } from '../src/shared/markdownLinks.ts'
import { collectDocumentMarkdownLinks, getMarkdownHeadingTargets, getMarkdownHeadingRewrites, rewriteDocumentMarkdownLinks, rewriteLocalMarkdownLink } from '../src/shared/markdownLinkMaintenance.ts'

test('document links map to precise block source ranges across lists, quotes, tables and footnotes', () => {
  const source = '# [Heading](Next.md#one)\n\n- [ ] [Task](Next.md#two)\n  - [Nested](Next.md#three)\n\n> [!note] Work\n> [Quote](Next.md#four)\n\n| A |\n| - |\n| [Cell](Next.md#five) |\n\nText[^n]\n\n[^n]: [Footnote](Next.md#six)\n\n[ref]: Next.md#seven\n\n`[Code](Next.md#eight)`\n\n```md\n[Code](Next.md#nine)\n```'
  const blocks = parseMarkdownBlocks(source).map((block, index) => ({ ...block, id: String(index) }))
  const links = collectDocumentMarkdownLinks(blocks)
  assert.equal(links.length, 7)
  for (const link of links) assert.equal(blocks[link.blockIndex].content.slice(link.start, link.end), link.url)
  const rewritten = rewriteDocumentMarkdownLinks(blocks, ({ url }) => url.replace('Next.md', 'Other.md'))
  assert.equal(collectDocumentMarkdownLinks(rewritten).filter(({ url }) => url.startsWith('Other.md')).length, 7)
  assert.ok(rewritten.some((block) => block.content.includes('`[Code](Next.md#eight)`')))
  assert.ok(rewritten.some((block) => block.type === 'code' && block.content.includes('Next.md#nine')))
  assert.deepEqual(rewritten.map((block) => block.id), blocks.map((block) => block.id))
})

test('heading rewrites preserve duplicate identities, title reservations and undo of a removed heading', () => {
  const before = [{ id: 'first', type: 'heading-2', content: '**安装**' }, { id: 'second', type: 'heading-2', content: '安装' }]
  const original = getMarkdownHeadingTargets(before, '安装')
  assert.deepEqual(original.map((heading) => heading.slug), ['安装', '安装-1', '安装-2'])
  const changed = getMarkdownHeadingTargets([{ ...before[0], content: '开始' }, before[1]], '目录')
  const rename = getMarkdownHeadingRewrites(original, changed)
  assert.equal(rename.get('安装'), '目录')
  assert.equal(rename.get('安装-1'), '开始')
  assert.equal(rename.get('安装-2'), '安装')
  const removed = getMarkdownHeadingTargets([before[1]], '安装')
  const deletion = getMarkdownHeadingRewrites(original, removed)
  const missing = deletion.get('安装-1')!
  assert.match(missing, /^knowbook-missing-heading-/)
  assert.equal(deletion.get('安装-2'), '安装-1')
  assert.equal(getMarkdownHeadingRewrites(removed, original).get(missing), '安装-1')
  assert.equal(getMarkdownHeadingRewrites(original, original).size, 0)
})

test('path maintenance preserves anchors, queries, absolute roots and unresolved relative destinations', () => {
  const changes = new Map([
    ['Docs/Next', { before: 'Docs/Next', after: 'Archive/新 章', headings: new Map([['old', '新章节']]) }],
    ['Docs/Start', { before: 'Docs/Start', after: 'Other/Start' }]
  ])
  assert.equal(rewriteLocalMarkdownLink('Next.md?mode=%23raw#old', 'Docs/Start', 'Other/Start', changes), '../Archive/%E6%96%B0%20%E7%AB%A0.md?mode=%23raw#' + encodeURIComponent('新章节'))
  assert.equal(rewriteLocalMarkdownLink('/Docs/Next.md#keep', 'Docs/Start', 'Other/Start', changes), '/Archive/%E6%96%B0%20%E7%AB%A0.md#keep')
  assert.equal(rewriteLocalMarkdownLink('Missing.md#lost', 'Docs/Start', 'Other/Start', changes), '../Docs/Missing.md#lost')
  assert.equal(rewriteLocalMarkdownLink('#local', 'Docs/Start', 'Other/Start', changes), null)
  assert.equal(rewriteLocalMarkdownLink('/Stable.md#same', 'Docs/Start', 'Other/Start', changes), null)
  assert.equal(rewriteLocalMarkdownLink('https://example.com/Next.md', 'Docs/Start', 'Other/Start', changes), null)
})

test('link collection excludes literal math, code, link labels and definition titles even with matching real links elsewhere', () => {
  const source = '[[Target]] [real](Target.md)\n\n`[[Target]] [code](Target.md)`\n\n$[[Target]]+[math](Target.md)$\n\n\\([[Target]]+[bracket](Target.md)\\)\n\n[[[Target]]](https://example.com)\n\n[ref]: Target.md "[[Target]]"\n\n[Use][ref]'
  const links = collectMarkdownSourceLinks(source)
  assert.equal(links.filter((link) => link.kind === 'wiki').length, 1)
  assert.equal(links.filter((link) => link.url === 'Target.md').length, 2)
  assert.equal(collectMarkdownDestinations(source).some((link) => (link.kind as string) === 'wiki'), false)
})

test('autolink attachments become portable Markdown links while literal and nested copies stay unchanged', () => {
  const url = 'file:///managed/report.pdf'
  const source = `<${url}>\n\n\`<${url}>\` $<${url}>$\n\n[<${url}>](https://example.com)\n\n<user@example.com>`
  const destinations = collectMarkdownDestinations(source)
  assert.deepEqual(destinations.map((link) => link.url), [url, 'https://example.com', 'mailto:user@example.com'])
  const rewritten = rewriteMarkdownDestinations(source, (link) => link.url === url ? './assets/report.pdf' : null)
  assert.ok(rewritten.startsWith(`[${url}](./assets/report.pdf)`))
  assert.ok(rewritten.includes(`\`<${url}>\` $<${url}>$`))
  assert.ok(rewritten.includes(`[<${url}>](https://example.com)`))
})

test('empty heading slugs do not redirect document-top links and colliding missing markers remain recoverable', () => {
  const changes = new Map([['Doc', { before: 'Doc', after: 'New', headings: new Map([['', 'new']]) }]])
  assert.equal(rewriteLocalMarkdownLink('Doc.md', 'Source', 'Source', changes), 'New.md')
  assert.equal(rewriteLocalMarkdownLink('Doc.md#', 'Source', 'Source', changes), 'New.md#')
  const heading = { id: 'original', type: 'heading-2', content: 'Name' }
  const original = getMarkdownHeadingTargets([heading], 'Doc')
  const removed = getMarkdownHeadingTargets([], 'Doc')
  const marker = getMarkdownHeadingRewrites(original, removed).get('name')!
  const collision = { id: 'collision', type: 'heading-2', content: marker }
  const both = getMarkdownHeadingTargets([heading, collision], 'Doc'), onlyCollision = getMarkdownHeadingTargets([collision], 'Doc')
  const missing = getMarkdownHeadingRewrites(both, onlyCollision).get('name')!
  assert.equal(missing, marker + '-missing')
  assert.equal(getMarkdownHeadingRewrites(onlyCollision, both).get(missing), 'name')
})

test('removing an indistinguishable duplicate inside one raw block reports ambiguity instead of choosing a survivor', () => {
  const before = getMarkdownHeadingTargets([{ id: 'raw', type: 'paragraph', content: '## Same\n\nFirst\n\n## Same\n\nSecond' }], 'Doc')
  const after = getMarkdownHeadingTargets([{ id: 'raw', type: 'paragraph', content: '## Same\n\nSecond' }], 'Doc')
  const changes = getMarkdownHeadingRewrites(before, after)
  assert.match(changes.get('same')!, /^knowbook-missing-heading-/)
  assert.match(changes.get('same-1')!, /^knowbook-missing-heading-/)
})
