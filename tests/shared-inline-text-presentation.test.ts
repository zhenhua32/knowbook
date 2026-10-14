import assert from 'node:assert/strict'
import test from 'node:test'
import {
  INLINE_TEXT_COLORS, INLINE_TEXT_PALETTE, INLINE_TEXT_COLOR_ATTRIBUTE, INLINE_BACKGROUND_COLOR_ATTRIBUTE, INLINE_TEXT_SHELL_ATTRIBUTE,
  normalizeInlineTextColor, normalizeInlineTextPresentation, parseInlineTextPresentationAttributes,
  inlineTextPresentationTags, serializeInlineTextPresentation, parseInlineTextPresentation, inlineTextPresentationStyle,
  type InlineTextPresentation,
} from '../src/shared/inlineTextPresentation'

test('inline text colors are a finite palette with an inherited undefined default', () => {
  assert.deepEqual(INLINE_TEXT_COLORS, ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'])
  assert.equal(normalizeInlineTextColor(undefined), undefined)
  for (const color of INLINE_TEXT_COLORS) assert.equal(normalizeInlineTextColor(color), color)
  for (const value of [null, '', 'default', 'transparent', '#fff', 'BLUE', ' blue ', 'var(--custom)', 'url(javascript:alert(1))', 1, {}, [], 'red;position:fixed']) {
    assert.equal(normalizeInlineTextColor(value), null)
  }
})

test('underline, foreground and background normalize independently without arbitrary CSS', () => {
  assert.deepEqual(normalizeInlineTextPresentation({}), {})
  assert.deepEqual(normalizeInlineTextPresentation({ underline: false, textColor: undefined, backgroundColor: undefined }), {})
  assert.deepEqual(normalizeInlineTextPresentation({ underline: true, textColor: 'red', backgroundColor: 'blue' }), { underline: true, textColor: 'red', backgroundColor: 'blue' })
  assert.deepEqual(normalizeInlineTextPresentation({ textColor: 'green', style: 'position:fixed', className: 'unsafe' }), { textColor: 'green' })
  for (const value of [null, [], 'blue', { underline: 'true' }, { textColor: '#123456' }, { backgroundColor: 'red;background:url(x)' }]) {
    assert.equal(normalizeInlineTextPresentation(value), null)
  }
  const input: InlineTextPresentation = { textColor: 'pink' }, normalized = normalizeInlineTextPresentation(input)!
  normalized.textColor = 'gray'
  assert.equal(input.textColor, 'pink')
})

test('safe HTML attributes keep text and background separate and reject unrelated attrs and duplicates', () => {
  const attributes = [{ name: INLINE_TEXT_COLOR_ATTRIBUTE, value: 'red' }, { name: INLINE_BACKGROUND_COLOR_ATTRIBUTE, value: 'blue' }]
  assert.deepEqual(parseInlineTextPresentationAttributes('u', attributes), { underline: true, textColor: 'red', backgroundColor: 'blue' })
  assert.deepEqual(parseInlineTextPresentationAttributes('span', attributes), { textColor: 'red', backgroundColor: 'blue' })
  assert.deepEqual(parseInlineTextPresentationAttributes('u', []), { underline: true })
  assert.equal(parseInlineTextPresentationAttributes('span', []), null)
  assert.deepEqual(parseInlineTextPresentationAttributes('span', [{ name: INLINE_TEXT_SHELL_ATTRIBUTE, value: 'true' }]), {})
  assert.equal(parseInlineTextPresentationAttributes('u', [{ name: INLINE_TEXT_SHELL_ATTRIBUTE, value: 'true' }]), null)
  assert.equal(parseInlineTextPresentationAttributes('script', attributes), null)
  for (const invalid of [
    [{ name: 'style', value: 'color:red' }], [{ name: 'onclick', value: 'run()' }], [{ name: 'class', value: 'hidden' }],
    [{ name: INLINE_TEXT_COLOR_ATTRIBUTE, value: 'url(javascript:run())' }],
    [attributes[0], attributes[0]], [{ ...attributes[0], prefix: 'xlink' }], [{ ...attributes[0], namespace: 'http://www.w3.org/2000/svg' }],
    [{ name: INLINE_TEXT_SHELL_ATTRIBUTE, value: 'false' }], [{ name: INLINE_TEXT_SHELL_ATTRIBUTE, value: 'TRUE' }],
    [{ name: INLINE_TEXT_SHELL_ATTRIBUTE, value: 'true' }, { name: INLINE_TEXT_SHELL_ATTRIBUTE, value: 'true' }],
  ]) assert.equal(parseInlineTextPresentationAttributes('span', invalid), null)
})

test('HTML wrapper serialization uses only u/span with validated palette attrs and escaped literal text', () => {
  assert.equal(serializeInlineTextPresentation('中文 😀 <script>& "text"', { underline: true, textColor: 'purple', backgroundColor: 'yellow' }),
    '<u data-knowbook-text-color="purple" data-knowbook-background-color="yellow">中文 😀 &lt;script&gt;&amp; "text"</u>')
  assert.equal(serializeInlineTextPresentation('Plain < & >', {}), 'Plain &lt; &amp; &gt;')
  assert.equal(serializeInlineTextPresentation('Color', { textColor: 'gray' }), '<span data-knowbook-text-color="gray">Color</span>')
  assert.equal(serializeInlineTextPresentation('first\n\nsecond', { underline: true }), '<u>first&#10;&#10;second</u>')
  assert.deepEqual(inlineTextPresentationTags({ underline: true }), { open: '<u>', close: '</u>' })
  assert.deepEqual(inlineTextPresentationTags({}), { open: '', close: '' })
  assert.throws(() => serializeInlineTextPresentation('value', { textColor: 'red" onclick="run()' } as unknown as InlineTextPresentation))
  assert.throws(() => serializeInlineTextPresentation('value\0', { underline: true }))
})

test('all foreground/background pairs roundtrip with underline and preserve Unicode and line endings', () => {
  const text = '中文👩🏽‍💻 e\u0301\r\n\t<&> literal **Markdown**'
  for (const textColor of INLINE_TEXT_COLORS) for (const backgroundColor of INLINE_TEXT_COLORS) for (const underline of [false, true]) {
    const presentation = normalizeInlineTextPresentation({ textColor, backgroundColor, underline })!
    assert.deepEqual(parseInlineTextPresentation(serializeInlineTextPresentation(text, presentation)), { text, presentation })
  }
  assert.deepEqual(parseInlineTextPresentation('<u></u>'), { text: '', presentation: { underline: true } })
})

test('HTML wrapper parser requires a closed safe wrapper and keeps complex markup for a recursive parser', () => {
  for (const source of [
    '<span style="color:red">Text</span>', '<u onclick="run()">Text</u>', '<span data-knowbook-text-color="#fff">Text</span>',
    '<span data-knowbook-text-color="blue">Text', '<script>Text</script>', '<u><strong>Nested</strong></u>',
    '<u><!-- retained source -->Text</u>', '<span>Text</span><u>Other</u>', ' <u>Text</u>', '<svg><u>Text</u></svg>', '<u>Text\0</u>',
    '<span data-knowbook-text-color="red" data-knowbook-text-color="blue">Text</span>',
  ]) assert.equal(parseInlineTextPresentation(source), null, source)
  assert.deepEqual(parseInlineTextPresentation('<span data-knowbook-text-color="&#98;lue">&lt;safe&gt;</span>'),
    { text: '<safe>', presentation: { textColor: 'blue' } })
})

test('theme mappings use finite foreground/background colors and return independent render styles', () => {
  for (const color of INLINE_TEXT_COLORS) {
    const palette = INLINE_TEXT_PALETTE[color]
    for (const theme of ['light', 'dark'] as const) {
      assert.match(palette[theme].text, /^#[\da-f]{6}$/)
      assert.match(palette[theme].background, /^#[\da-f]{6}$/)
      assert.deepEqual(inlineTextPresentationStyle({ underline: true, textColor: color, backgroundColor: 'blue' }, theme), {
        textDecorationLine: 'underline', color: palette[theme].text, backgroundColor: INLINE_TEXT_PALETTE.blue[theme].background,
      })
    }
    assert.notEqual(palette.light.text, palette.dark.text)
    assert.notEqual(palette.light.background, palette.dark.background)
    assert.ok(Object.isFrozen(palette.light))
  }
  const value = { textColor: 'red' } as const, style = inlineTextPresentationStyle(value)
  style.color = '#000000'
  assert.equal(inlineTextPresentationStyle(value).color, INLINE_TEXT_PALETTE.red.light.text)
  assert.deepEqual(inlineTextPresentationStyle({}), {})
})

test('pure presentation APIs work without browser document or theme state', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, get: () => { throw new Error('DOM access is not allowed') } })
  try {
    const serialized = serializeInlineTextPresentation('SSR', { underline: true, backgroundColor: 'orange' })
    assert.deepEqual(parseInlineTextPresentation(serialized), { text: 'SSR', presentation: { underline: true, backgroundColor: 'orange' } })
    assert.deepEqual(inlineTextPresentationStyle({ backgroundColor: 'orange' }, 'dark'), { backgroundColor: INLINE_TEXT_PALETTE.orange.dark.background })
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})
