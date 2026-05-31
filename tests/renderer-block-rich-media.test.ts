import assert from 'node:assert/strict'
import test from 'node:test'
import { extractBlockRichMedia } from '../src/renderer/src/utils/blockRichMedia.ts'

test('extractBlockRichMedia collects markdown images, markdown links, and plain urls', () => {
  const media = extractBlockRichMedia([
    '![Cover](file:///tmp/cover.png)',
    'See [Example](https://example.com/post).',
    'Source URL: https://example.com/post',
    'Another file link: file:///tmp/local-image.png'
  ].join('\n'))

  assert.deepEqual(media.images, [
    { alt: 'Cover', url: 'file:///tmp/cover.png' }
  ])
  assert.deepEqual(media.links, [
    { label: 'Example', url: 'https://example.com/post' },
    { label: 'file:///tmp/local-image.png', url: 'file:///tmp/local-image.png' }
  ])
})

test('extractBlockRichMedia ignores unsupported protocols and de-duplicates repeated urls', () => {
  const media = extractBlockRichMedia([
    '![Unsafe](javascript:alert(1))',
    '[Repeat](https://example.com/a)',
    'https://example.com/a',
    'https://example.com/a)',
    '[Local](file:///tmp/local.txt)'
  ].join('\n'))

  assert.equal(media.images.length, 0)
  assert.deepEqual(media.links, [
    { label: 'Repeat', url: 'https://example.com/a' },
    { label: 'Local', url: 'file:///tmp/local.txt' }
  ])
})