import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { markdownEngine, collectMarkdownReferences } from '../src/shared/markdownEngine.ts'
import { draftBlocksToRichDoc, richTextInlineFingerprint } from '../src/renderer/src/rich-text/model.ts'
import { formatSourceInlinePresentation } from '../src/renderer/src/utils/sourceInlinePresentation.ts'

const rich = (content: string) => draftBlocksToRichDoc([{ id: 'one', type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null }]).firstChild!

test('source formatting maps partial text through nested Markdown marks and preserves forward/backward selected text', () => {
  for (const source of ['**abc中文😀def** tail', '__abc中文😀def__ tail', '*abc中文😀def* tail',
    '~~**abc中文😀def**~~ tail', '[**abc中文😀def**](https://example.test "Title") tail', '`abc中文😀def` tail']) {
    const start = source.indexOf('中文'), end = start + '中文😀'.length
    for (const direction of ['forward', 'backward'] as const) {
      const underlined = formatSourceInlinePresentation(source, start, end, { kind: 'underline' }, direction)
      assert.ok(underlined, source)
      assert.equal(underlined.content.slice(underlined.start, underlined.end), '中文😀')
      assert.equal(underlined.direction, direction)
      const red = formatSourceInlinePresentation(underlined.content, underlined.start, underlined.end, { kind: 'textColor', color: 'red' }, direction)
      assert.ok(red, underlined.content)
      const blue = formatSourceInlinePresentation(red.content, red.start, red.end, { kind: 'backgroundColor', color: 'blue' }, direction)
      assert.ok(blue, red.content)
      const clear = formatSourceInlinePresentation(blue.content, blue.start, blue.end, { kind: 'textColor' }, direction)
      assert.ok(clear)
      const tree = JSDOM.fragment(markdownEngine.render(clear.content))
      assert.equal(tree.querySelector('u')?.textContent, '中文😀')
      assert.equal(tree.querySelector('[data-knowbook-text-color]'), null)
      assert.equal(tree.querySelector('[data-knowbook-background-color]')?.textContent, '中文😀')
      assert.equal(tree.querySelector('[data-knowbook-background-color]')?.getAttribute('data-knowbook-background-color'), 'blue')
      const reset = formatSourceInlinePresentation(clear.content, clear.start, clear.end, { kind: 'backgroundColor' }, direction)
      assert.ok(reset)
      const noUnderline = formatSourceInlinePresentation(reset.content, reset.start, reset.end, { kind: 'underline' }, direction)
      assert.ok(noUnderline)
      assert.equal(richTextInlineFingerprint(rich(noUnderline.content)), richTextInlineFingerprint(rich(source)), source)
    }
  }
})

test('complete source syntax and soft/hard line boundaries become semantic HTML rather than literal Markdown', () => {
  for (const source of ['__bold__ and *italic*', '**[link](https://example.test "Title")**', '`a ** b`',
    'soft\r\nline  \r\nhard', 'escaped \\*literal\\* &amp; 😀', 'https://example.test']) {
    const result = formatSourceInlinePresentation(source, 0, source.length, { kind: 'backgroundColor', color: 'yellow' })
    assert.ok(result, source)
    const original = rich(source), restored = rich(result.content)
    assert.equal(restored.type.name, 'text_block')
    const actualText = restored.textContent, expectedText = original.textContent
    assert.equal(actualText, expectedText, result.content)
    const reset = formatSourceInlinePresentation(result.content, result.start, result.end, { kind: 'backgroundColor' })
    assert.ok(reset, result.content)
    assert.equal(richTextInlineFingerprint(rich(reset.content)), richTextInlineFingerprint(original), reset.content)
  }
})

test('external reference labels retain their original link destination/title during source formatting', () => {
  const references = collectMarkdownReferences('[ref]: https://example.test/path "A title"'), source = 'Use [**label**][ref] now'
  const start = source.indexOf('label'), result = formatSourceInlinePresentation(source, start, start + 5,
    { kind: 'textColor', color: 'purple' }, 'backward', references)
  assert.ok(result)
  const tree = JSDOM.fragment(markdownEngine.render(result.content))
  assert.equal(tree.querySelector('a')?.getAttribute('href'), 'https://example.test/path')
  assert.equal(tree.querySelector('a')?.getAttribute('title'), 'A title')
  assert.equal(tree.querySelector('a strong [data-knowbook-text-color]')?.textContent, 'label')
  assert.equal(result.direction, 'backward')
})

test('unsafe syntax boundaries, source atoms, attributes, destination characters and partial surrogate pairs stay unchanged', () => {
  const cases: Array<[string, number, number]> = [
    ['**bold**', 0, 1], ['**bold**', 1, 4], ['[label](https://example.test)', 9, 14],
    ['<u data-knowbook-text-color="red">label</u>', 28, 31], ['&amp;', 1, 4], ['😀', 1, 2],
    ['```ts\nconst x = 1\n```', 8, 15], ['<script>bad</script>', 8, 11], ['first\n\nsecond', 0, 13],
    ['before $math$ after', 0, 6], ['before ![alt](image.png) after', 0, 6], ['before [[Wiki]] after', 0, 6]
  ]
  for (const [source, start, end] of cases) assert.equal(formatSourceInlinePresentation(source, start, end, { kind: 'textColor', color: 'red' }), null, `${source} ${start}:${end}`)
  for (const [start, end] of [[-1, 2], [0, 99], [1, 1], [1.5, 2], [3, 1]]) assert.equal(formatSourceInlinePresentation('text', start, end, { kind: 'underline' }), null)
})

test('source offset restoration safely selects entity-escaped punctuation and leaves adjacent formatting untouched', () => {
  const source = '**head &lt; &amp; tail** plain', start = source.indexOf('&lt;'), end = source.indexOf(' tail')
  const result = formatSourceInlinePresentation(source, start, end, { kind: 'textColor', color: 'green' })
  assert.ok(result)
  assert.equal(result.content.slice(result.start, result.end), '&lt; &amp;')
  const tree = JSDOM.fragment(markdownEngine.render(result.content))
  assert.equal(tree.querySelector('strong [data-knowbook-text-color]')?.textContent, '< &')
  assert.equal(Array.from(tree.querySelectorAll('strong')).map(element => element.textContent).join(''), 'head < & tail')
  assert.ok(tree.textContent?.endsWith(' plain\n'))
})
