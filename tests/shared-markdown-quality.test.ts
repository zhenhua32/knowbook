import assert from 'node:assert/strict'
import test from 'node:test'
import { markdownEngine } from '../src/shared/markdownEngine.ts'
import { parseMarkdownBlocks, serializeBlocksToMarkdown } from '../src/shared/markdown.ts'
import { collectMarkdownDestinations } from '../src/shared/markdownLinks.ts'
import { getMarkdownHeadingTargets, getMarkdownHeadingRewrites } from '../src/shared/markdownLinkMaintenance.ts'
import { unclosedMath, unclosedBrackets, duplicateHeadings, largeTable, imageParagraph } from './fixtures/markdown-quality.ts'

test('large unfinished math and labels retain their text and recover when delimiters are completed', () => {
  for (const source of [unclosedMath, unclosedBrackets]) {
    const expected = markdownEngine.render(source)
    let serialized = source
    for (let round = 0; round < 3; round++) {
      serialized = serializeBlocksToMarkdown(parseMarkdownBlocks(serialized))
      assert.equal(markdownEngine.render(serialized), expected)
    }
  }
  const source = unclosedMath + '[label](Target.md)'
  assert.equal(collectMarkdownDestinations(source).length, 1)
  assert.equal(collectMarkdownDestinations(source + '$').length, 0)
  assert.match(markdownEngine.render(source + '$'), /markdown-math-inline/)
  assert.equal(collectMarkdownDestinations(source + '\n\n$end$').length, 1)
})

test('thousands of duplicate headings keep ambiguity protection and restored identities', () => {
  const original = getMarkdownHeadingTargets([{ id: 'raw', type: 'paragraph', content: duplicateHeadings }], 'Doc')
  const removed = getMarkdownHeadingTargets([{ id: 'raw', type: 'paragraph', content: duplicateHeadings.replace('## Same\n\nText 0\n\n', '') }], 'Doc')
  const changes = getMarkdownHeadingRewrites(original, removed)
  assert.equal(changes.size, 4_000)
  assert.equal(new Set(changes.values()).size, 4_000)
  for (const slug of ['same', 'same-1', 'same-3999']) assert.match(changes.get(slug)!, /^knowbook-missing-heading-/)
  assert.equal(getMarkdownHeadingRewrites(original, original).size, 0)
  const restored = getMarkdownHeadingRewrites(removed, original)
  assert.equal(restored.get(changes.get('same-3999')!), 'same-3999')
})

test('a thousand-row table preserves every destination through repeated export and import', () => {
  let source = largeTable
  for (let round = 0; round < 3; round++) {
    const links = collectMarkdownDestinations(source)
    assert.equal(links.length, 1_000)
    for (let index = 0; index < links.length; index++) {
      assert.equal(links[index].url, `Target.md#row-${index}`)
      assert.equal(source.slice(links[index].start, links[index].end), links[index].url)
    }
    source = serializeBlocksToMarkdown(parseMarkdownBlocks(source))
  }
})

test('many images in one paragraph retain independent source destinations', () => {
  const links = collectMarkdownDestinations(imageParagraph)
  assert.equal(links.length, 2_000)
  for (let index = 0; index < links.length; index++) {
    assert.equal(links[index].url, `assets/${index}.png`)
    assert.equal(imageParagraph.slice(links[index].start, links[index].end), links[index].url)
  }
})
