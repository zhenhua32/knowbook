import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownContent } from '../src/renderer/src/components/MarkdownContent'
import { getInlineReferenceTokenAtCursor, resolveInlineReferenceTarget } from '../src/renderer/src/components/InlineContentRenderer'
import { collectMarkdownDestinations, collectMarkdownSourceLinks, rewriteMarkdownDestinations } from '../src/shared/markdownLinks'
import { collectDocumentMarkdownLinks, getMarkdownHeadingTargets, rewriteDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { parseMarkdownBlocks } from '../src/shared/markdown'
import { findWikiHeading, parseWikiReference, resolveWikiDocument } from '../src/shared/markdownWiki'

const drafts = (source: string) => parseMarkdownBlocks(source).map((block, index) => ({ ...block, id: `block-${index}` }))

test('Wiki aliases render as plain labels in paragraphs and tables; parser source maps preserve escaped pipes and literals', () => {
  const source = '[[Guide#Install|Start <now>]]\n\n| Link | Image |\n| --- | --- |\n| [[Guide#Install\\|Table label]] | ![[image.png\\|Picture]] |\n\n`[[Guide|Code]]` $[[Guide|Math]]$ \\[[Guide|Escaped]]'
  const html = renderToStaticMarkup(<MarkdownContent content={source} onReference={() => {}} />)
  assert.match(html, /Start &lt;now&gt;/)
  assert.match(html, /Table label/)
  assert.doesNotMatch(html, /<now>/)
  const blocks = drafts(source), links = collectDocumentMarkdownLinks(blocks)
  assert.deepEqual(links.map((link) => link.url), ['Guide#Install|Start <now>', 'Guide#Install|Table label', 'image.png'])
  const updated = rewriteDocumentMarkdownLinks(blocks, (link) => link.kind === 'wiki' ? link.url.replace('Guide#Install', 'Docs/Renamed#new-section') : null)
  assert.ok(updated.some((block) => block.content.includes('[[Docs/Renamed#new-section\\|Table label]]')))
  assert.ok(updated.some((block) => block.content.includes('`[[Guide|Code]]`')))
  assert.equal(getMarkdownHeadingTargets(drafts('## [[Guide|Display title]]'), 'Top')[1].text, 'Display title')
})

test('Wiki images share asset destinations while note embeds, YAML, code and image alt examples do not', () => {
  const source = '---\nexample: "![[yaml.png]]"\n---\n\n![[图片 名.png|Caption]] ![[Note]] `![[code.png]]` ![![[alt.png]]](real.png)'
  const links = collectMarkdownDestinations(source)
  assert.deepEqual(links.map((link) => link.url), ['%E5%9B%BE%E7%89%87%20%E5%90%8D.png', 'real.png'])
  assert.equal(source.slice(links[0].start, links[0].end), '图片 名.png')
  const rewritten = rewriteMarkdownDestinations(source, (link) => link.syntax === 'wiki' ? 'file:///managed/new.png' : null)
  assert.ok(rewritten.includes('![[file:///managed/new.png|Caption]]'))
  assert.ok(rewritten.includes('![[Note]] `![[code.png]]`'))
  assert.equal(collectMarkdownSourceLinks('![[Note]]').length, 0)
  assert.match(renderToStaticMarkup(<MarkdownContent content={rewritten} />), /knowbook-asset/)
  assert.equal(getInlineReferenceTokenAtCursor('`[[Guide|Code]]`', 5), null)
  assert.equal(getInlineReferenceTokenAtCursor('![[Note]]', 4), null)
})

test('Wiki document resolution shares root paths, md suffixes, aliases, current sections and legacy block IDs', () => {
  const references = [{ id: 'source', path: 'Notes/Source', title: 'Source' }, { id: 'guide', path: 'Docs/Guide', title: 'Guide' },
    { id: 'legacy', path: 'Known|Title', title: 'Known|Title' }]
  const blocks = new Map([['legacy-id', { id: 'legacy-id', content: 'Old block' }]])
  assert.deepEqual(resolveInlineReferenceTarget('guide.md|Read', references, blocks, 'source'), { type: 'document', documentId: 'guide' })
  assert.deepEqual(resolveInlineReferenceTarget('../Docs/Guide#Install|Read', references, blocks, 'source'), { type: 'cross-block', documentPath: 'Docs/Guide', blockId: 'Install' })
  assert.deepEqual(resolveInlineReferenceTarget('#Local heading|Here', references, blocks, 'source'), { type: 'cross-block', documentPath: 'Notes/Source', blockId: 'Local heading' })
  assert.deepEqual(resolveInlineReferenceTarget('legacy-id|Old block', references, blocks, 'source'), { type: 'block', documentId: 'source', blockId: 'legacy-id' })
  assert.deepEqual(resolveInlineReferenceTarget('Known|Title', references, blocks, 'source'), { type: 'document', documentId: 'legacy' })
  assert.deepEqual(resolveInlineReferenceTarget('Docs/Guide#^foreign', references, blocks, 'source'), { type: 'cross-block', documentPath: 'Docs/Guide', blockId: '^foreign' })
  assert.equal(resolveWikiDocument('../../escape', 'Source', { byPath: () => undefined, byTitle: () => [] }), null)
})

test('explicit caret fragments preserve their identity through aliases and cannot resolve as similarly named headings or local alias text', () => {
  const references = [{ id: 'source', path: 'Notes/Source', title: 'Source' }, { id: 'guide', path: 'Docs/Guide', title: 'Guide' }]
  const blocks = new Map([['foreign', { id: 'foreign', content: 'Install alias text' }], ['Install', { id: 'Install', content: 'Local block matching the alias' }]])
  const raw = 'Docs/Guide#^foreign|Install'
  const source = 'See [[' + raw + ']] here'
  assert.equal(getInlineReferenceTokenAtCursor(source, source.indexOf('foreign') + 2), raw)
  assert.deepEqual(parseWikiReference(raw), { target: 'Docs/Guide#^foreign', path: 'Docs/Guide', fragment: '^foreign', hasFragment: true, alias: 'Install' })
  assert.deepEqual(resolveInlineReferenceTarget(raw, references, blocks, 'source'),
    { type: 'cross-block', documentPath: 'Docs/Guide', blockId: '^foreign' })
  assert.deepEqual(resolveInlineReferenceTarget('Deleted/Old#^foreign|Install', references, blocks, 'source'),
    { type: 'cross-block', documentPath: 'Deleted/Old', blockId: '^foreign' })
  assert.deepEqual(resolveInlineReferenceTarget('#^foreign|Install', references, blocks, 'source'),
    { type: 'cross-block', documentPath: 'Notes/Source', blockId: '^foreign' })
  const headings = getMarkdownHeadingTargets(drafts('## foreign\n\n## ^foreign\n\n## Install'), 'Guide')
  assert.equal(findWikiHeading('^foreign', headings), undefined)
  assert.equal(findWikiHeading('^foreign', [{ text: '^foreign', slug: '^foreign' }]), undefined,
    'even an exact heading text or slug cannot claim the explicit block namespace')
  assert.equal(findWikiHeading('Install', headings)?.slug, 'install')
  assert.deepEqual(resolveInlineReferenceTarget('Docs/Guide#Install|^foreign', references, blocks, 'source'),
    { type: 'cross-block', documentPath: 'Docs/Guide', blockId: 'Install' }, 'display aliases must never replace the target fragment')
})
