import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarkdownBackupDocument, renderMarkdownFrontmatter, serializeBlocksToMarkdown } from '../src/shared/markdown.ts'
import { parseMarkdownTable, renderMarkdownTableHtml } from '../src/shared/markdownTable.ts'

test('renderMarkdownTableHtml escapes untrusted cell content', () => {
  const html = renderMarkdownTableHtml([
    '| Header | Other |',
    '| --- | --- |',
    '| <img src=x onerror="alert(1)"> & text | safe |'
  ].join('\n'))

  assert.ok(html)
  assert.equal(html.includes('<img'), false)
  assert.equal(html.includes('onerror="alert(1)"'), false)
  assert.equal(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; text'), true)
})

test('parseMarkdownTable rejects delimiter rows with a different column count', () => {
  assert.equal(parseMarkdownTable([
    '| Name | Status |',
    '| --- |',
    '| KnowBook | Ready |'
  ].join('\n')), null)
})

test('serializeBlocksToMarkdown renders all major block types', () => {
  const output = serializeBlocksToMarkdown([
    { type: 'heading-1', content: 'H1' },
    { type: 'heading-2', content: 'H2' },
    { type: 'todo', content: 'Task', checked: true, depth: 0 },
    { type: 'quote', content: 'line1\nline2' },
    { type: 'bulleted-list', content: 'Bullet', depth: 1 },
    { type: 'numbered-list', content: 'Number', depth: 2 },
    { type: 'divider', content: '' },
    { type: 'math', content: 'a^2+b^2=c^2' },
    { type: 'code', content: 'const a = 1', language: 'typescript' },
    { type: 'paragraph', content: 'Plain text' }
  ])

  assert.equal(
    output,
    [
      '# H1',
      '## H2',
      '- [x] Task',
      '> line1\n> line2',
      '- Bullet',
      '1. Number',
      '---',
      '$$\na^2+b^2=c^2\n$$',
      '```typescript\nconst a = 1\n```',
      'Plain text'
    ].join('\n\n')
  )
})

test('serializeBlocksToMarkdown uses fallback code language when block language is missing', () => {
  const output = serializeBlocksToMarkdown(
    [{ type: 'code', content: 'SELECT 1', language: null }],
    { fallbackCodeLanguage: 'txt' }
  )

  assert.equal(output, '```txt\nSELECT 1\n```')
})

test('serializeBlocksToMarkdown resolves depth from parentBlockId and caps excessive depth', () => {
  const output = serializeBlocksToMarkdown([
    { id: 'root', type: 'bulleted-list', content: 'Root', depth: 0 },
    { id: 'child', type: 'bulleted-list', content: 'Child', depth: 6, parentBlockId: 'root' },
    { id: 'deep', type: 'bulleted-list', content: 'Deep', depth: 99, parentBlockId: 'child' }
  ])

  assert.equal(output, '- Root\n\n  - Child\n\n    - Deep')
})

test('serializeBlocksToMarkdown ignores list depth for non-nestable blocks', () => {
  const output = serializeBlocksToMarkdown([
    { type: 'paragraph', content: 'Loose', depth: 4 },
    { type: 'quote', content: 'Q', depth: 3 }
  ])

  assert.equal(output, 'Loose\n\n> Q')
})

test('serializeBlocksToMarkdown falls back to root-level when parent references are missing', () => {
  const output = serializeBlocksToMarkdown([
    { type: 'bulleted-list', content: 'Top', depth: 0 },
    { type: 'bulleted-list', content: 'Broken parent but still nested', depth: 2, parentBlockId: 'missing' },
    { type: 'bulleted-list', content: 'Keeps nesting from stack', depth: 3 }
  ])

  assert.equal(output, '- Top\n\n- Broken parent but still nested\n\n- Keeps nesting from stack')
})

test('parseMarkdownBackupDocument round-trips frontmatter and block metadata', () => {
  const markdown = [
    renderMarkdownFrontmatter({
      id: 'doc-1',
      title: 'Roadmap: 2026',
      path: 'Root/Roadmap',
      updatedAt: '2026-05-22T00:00:00.000Z',
      summary: 'Line 1:\nLine 2'
    }),
    serializeBlocksToMarkdown([
      { id: 'root', type: 'bulleted-list', content: 'Parent', depth: 0, tags: ['alpha', 'beta'], highlight: 'Yellow' },
      { id: 'child', type: 'bulleted-list', content: 'Child', depth: 0, parentBlockId: 'root' },
      { id: 'code', type: 'code', content: 'SELECT 1', depth: 0, language: null }
    ], {
      fallbackCodeLanguage: 'txt',
      includeBlockMetadata: true
    })
  ].join('')

  const parsed = parseMarkdownBackupDocument(markdown)

  assert.deepEqual(parsed.frontmatter, {
    id: 'doc-1',
    title: 'Roadmap: 2026',
    path: 'Root/Roadmap',
    updatedAt: '2026-05-22T00:00:00.000Z',
    summary: 'Line 1:\nLine 2'
  })

  assert.deepEqual(parsed.blocks, [
    {
      id: 'root',
      type: 'bulleted-list',
      content: 'Parent',
      checked: false,
      depth: 0,
      parentBlockId: null,
      tags: ['alpha', 'beta'],
      highlight: 'yellow'
    },
    {
      id: 'child',
      type: 'bulleted-list',
      content: 'Child',
      checked: false,
      depth: 1,
      parentBlockId: 'root'
    },
    {
      id: 'code',
      type: 'code',
      content: 'SELECT 1',
      checked: false,
      depth: 0,
      parentBlockId: null,
      language: 'txt'
    }
  ])
})
