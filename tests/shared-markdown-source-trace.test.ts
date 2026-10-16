import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarkdownBlocks, serializeBlocksToMarkdown } from '../src/shared/markdown'
import { parseMarkdownSourceStrict, parseMarkdownSourceStrictWithTrace } from '../src/shared/markdownSource'
import { markdownEngine } from '../src/shared/markdownEngine'
import { collectMarkdownSourceLinks } from '../src/shared/markdownLinks'
import { projectMarkdownSourceContentRange, projectMarkdownSourceRawRange, type MarkdownSourceContentTrace } from '../src/shared/markdownSourceTrace'
import { NATIVE_LITERAL_MARKER } from '../src/shared/markdownNativeText'
import { serializeSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import { serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'

function parse(source: string) {
  const actual = parseMarkdownSourceStrictWithTrace(source, { mode: 'canonical' })
  const { contentTraces, ...syntax } = actual
  assert.deepEqual(syntax, parseMarkdownSourceStrict(source, { mode: 'canonical' }), 'tracing never changes parser emission')
  assert.equal(contentTraces.length, syntax.blocks.length)
  contentTraces.forEach((trace, index) => {
    assert.equal(trace.index, index); assert.equal(trace.content, syntax.blocks[index].content)
    assert.equal(trace.starts.length, trace.content.length); assert.equal(trace.ends.length, trace.content.length)
    assert.equal(trace.boundaries.length, trace.content.length + 1)
  })
  return actual
}
function roundTrip(trace: MarkdownSourceContentTrace, rawFrom: number, rawTo: number, from: number, to: number) {
  assert.deepEqual(projectMarkdownSourceRawRange(trace, rawFrom, rawTo), { from, to })
  assert.deepEqual(projectMarkdownSourceContentRange(trace, from, to), { from: rawFrom, to: rawTo })
}

test('emission traces preserve raw BOM, mixed CRLF/CR and UTF-16 emoji offsets without matching repeated destinations', () => {
  const source = '\uFEFF🧭 [One](Same.md)\r\nThen [Two](Same.md)\r\n\r\n🙂 [Three](Same.md)\rTail'
  const result = parse(source)
  assert.deepEqual(result.blocks.map(block => block.content), ['🧭 [One](Same.md)\nThen [Two](Same.md)', '🙂 [Three](Same.md)\nTail'])
  const rawLinks = collectMarkdownSourceLinks(source.slice(1)).map(link => ({ ...link, start: link.start + 1, end: link.end + 1 }))
  assert.equal(rawLinks.length, 3)
  const positions = [result.blocks[0].content.indexOf('Same.md'), result.blocks[0].content.lastIndexOf('Same.md'), result.blocks[1].content.indexOf('Same.md')]
  rawLinks.forEach((link, index) => roundTrip(result.contentTraces[index < 2 ? 0 : 1], link.start, link.end, positions[index], positions[index] + 7))
  const first = result.contentTraces[0], newline = first.content.indexOf('\n'), rawCR = source.indexOf('\r\n')
  roundTrip(first, rawCR, rawCR + 2, newline, newline + 1)
  assert.equal(projectMarkdownSourceRawRange(first, rawCR + 1, rawCR + 2), null, 'half of CRLF cannot claim the emitted newline')
  assert.equal(projectMarkdownSourceRawRange(first, 0, 1), null, 'the BOM is outside emitted content')
  roundTrip(first, 1, 3, 0, 2)
})

test('ATX and multiline Setext headings map actual stripped markers, ASCII whitespace and closing hashes', () => {
  const source = '  ##\t🧭 [A](Guide.md)  ###\t\r\n\r\nFirst [B](Other.md)\r\nsecond\r\n===\r\n\r\n#\t\u00a0keep\u00a0'
  const result = parse(source)
  assert.deepEqual(result.blocks.map(block => [block.type, block.content]), [
    ['heading-2', '🧭 [A](Guide.md)'], ['heading-1', 'First [B](Other.md)\nsecond'], ['heading-1', '\u00a0keep\u00a0']
  ])
  for (const [index, raw] of [[0, 'Guide.md'], [1, 'Other.md'], [2, '\u00a0keep\u00a0']] as const) {
    const from = source.indexOf(raw), at = result.blocks[index].content.indexOf(raw)
    roundTrip(result.contentTraces[index], from, from + raw.length, at, at + raw.length)
  }
  assert.equal(projectMarkdownSourceRawRange(result.contentTraces[0], 0, 4), null)
  const hashes = source.indexOf('###')
  assert.equal(projectMarkdownSourceRawRange(result.contentTraces[0], hashes, hashes + 3), null)
})

test('simple tasks, numbered children and lazy list continuations use rule-time indentation positions', () => {
  const source = '- [x] 🧭 [A](Same.md)\r\n  continuation [B](Same.md)\r\n\r\n  3. [ ] [C](Child.md)\r\n- [D](Last.md)'
  const result = parse(source)
  assert.deepEqual(result.blocks.map(block => [block.type, block.depth, block.parentIndex]), [
    ['todo', 0, null], ['numbered-todo', 1, 0], ['bulleted-list', 0, null]
  ])
  const rawLinks = collectMarkdownSourceLinks(source)
  for (const [ordinal, owner] of [0, 0, 1, 2].entries()) {
    const link = rawLinks[ordinal], trace = result.contentTraces[owner]
    const projected = projectMarkdownSourceRawRange(trace, link.start, link.end)
    assert.ok(projected)
    assert.equal(trace.content.slice(projected.from, projected.to), source.slice(link.start, link.end))
    assert.deepEqual(projectMarkdownSourceContentRange(trace, projected.from, projected.to), { from: link.start, to: link.end })
  }
  assert.equal(projectMarkdownSourceRawRange(result.contentTraces[0], 0, 6), null, 'task/list markers are outside the editable body')
  const across = projectMarkdownSourceContentRange(result.contentTraces[0], 0, result.blocks[0].content.length)
  assert.equal(across, null, 'a raw range cannot silently bridge removed continuation indentation')
})

test('complex list blocks retain definitions and multiline bodies without claiming nested structural shells', () => {
  const source = '- First [link][ref]\r\n\r\n  [ref]: Guide.md "Title"\r\n\r\n  extra [B](Second.md)\r\n\r\n  ```ts\r\n  literal [C](Ignored.md)\r\n  ```'
  const result = parse(source)
  assert.equal(result.blocks.length, 1)
  assert.equal(result.blocks[0].type, 'bulleted-list')
  for (const word of ['Guide.md', 'Second.md', 'Ignored.md']) {
    const from = source.indexOf(word), at = result.blocks[0].content.indexOf(word)
    roundTrip(result.contentTraces[0], from, from + word.length, at, at + word.length)
  }
  assert.equal(projectMarkdownSourceRawRange(result.contentTraces[0], 0, source.length), null)
})

test('quote markers, tabs and synthetic continuation protection never acquire invented source characters', () => {
  const source = '> foo `\r\n===\r\n`\r\n> [Link](Guide.md)'
  const result = parse(source), trace = result.contentTraces[0]
  assert.equal(result.blocks[0].type, 'quote')
  const from = source.indexOf('Guide.md'), at = trace.content.indexOf('Guide.md')
  roundTrip(trace, from, from + 8, at, at + 8)
  assert.ok(trace.starts.some(position => position === null), 'joining/escaping a lazy continuation records generated text')
  for (let index = 0; index < trace.content.length; index++) if (trace.starts[index] === null) {
    assert.equal(projectMarkdownSourceContentRange(trace, index, index + 1), null)
  }
  assert.equal(projectMarkdownSourceRawRange(trace, 0, 2), null)
  const tabbed = parse('-\t[A](Tab.md)\n\t- [B](Child.md)')
  for (const [index, word] of [[0, 'Tab.md'], [1, 'Child.md']] as const) {
    const raw = '-\t[A](Tab.md)\n\t- [B](Child.md)', rawFrom = raw.indexOf(word), contentFrom = tabbed.blocks[index].content.indexOf(word)
    roundTrip(tabbed.contentTraces[index], rawFrom, rawFrom + word.length, contentFrom, contentFrom + word.length)
  }
})

test('native titles and deeply scoped bodies follow real finite decoding and reject marker gaps or partial entities', () => {
  const marker = NATIVE_LITERAL_MARKER
  const source = [
    '<aside data-knowbook-container="callout-v1" data-knowbook-escape="literal-v1">',
    '<div data-knowbook-title="true">🧭 [Title](Title.md) ' + marker + '&lt;/aside&gt;</div>', '',
    '<details data-knowbook-container="toggle-v1" data-knowbook-escape="literal-v1" open>',
    '<summary>Inner [Link](Inner.md)</summary>', '',
    '[Body](Body.md)', marker + '&lt;/details&gt;', '[After](After.md)', '', '</details>', '', '</aside>'
  ].join('\r\n')
  const result = parse(source)
  assert.deepEqual(result.blocks.map(block => [block.type, block.depth, block.parentIndex]), [
    ['callout', 0, null], ['toggle', 1, 0], ['paragraph', 2, 1]
  ])
  for (const [index, word] of [[0, 'Title.md'], [1, 'Inner.md'], [2, 'Body.md'], [2, 'After.md']] as const) {
    const from = source.indexOf(word), at = result.blocks[index].content.indexOf(word)
    roundTrip(result.contentTraces[index], from, from + word.length, at, at + word.length)
  }
  const entity = source.indexOf('&lt;'), decoded = result.blocks[0].content.indexOf('</aside>')
  roundTrip(result.contentTraces[0], entity, entity + 4, decoded, decoded + 1)
  assert.equal(projectMarkdownSourceRawRange(result.contentTraces[0], entity + 1, entity + 4), null)
  assert.equal(projectMarkdownSourceContentRange(result.contentTraces[0], 0, decoded + 1), null)
  assert.equal(projectMarkdownSourceRawRange(result.contentTraces[0], entity - marker.length, entity), null)
  assert.equal(projectMarkdownSourceRawRange(result.contentTraces[2], source.lastIndexOf('</details>'), source.lastIndexOf('</details>') + 10), null)
})

test('native decoding is disabled in code/math and complete legacy HTML while raw table layout remains exact', () => {
  const blocks = [
    { type: 'callout', content: 'Title', depth: 0 },
    { type: 'code', content: NATIVE_LITERAL_MARKER + '&lt;/aside&gt;\n🧭 raw', language: 'ts', depth: 1 },
    { type: 'math', content: NATIVE_LITERAL_MARKER + '&lt;/aside&gt;', depth: 1 },
    { type: 'html', content: '<details>\n<summary>Legacy</summary>\n\n' + NATIVE_LITERAL_MARKER + '&lt;/aside&gt;\n\n</details>', depth: 1 },
    { type: 'table', content: '<!-- knowbook:table-widths:v1 [160,null] -->\n| A | B |\n| - | - |\n| [Cell](Cell.md) | 🧭 |', depth: 1 }
  ]
  const raw = serializeBlocksToMarkdown(blocks).replace(/\n/g, '\r\n'), result = parse(raw)
  assert.deepEqual(result.blocks.map(block => block.type), ['callout', 'code', 'math', 'html', 'table'])
  assert.equal(result.blocks[1].content, blocks[1].content)
  assert.equal(result.blocks[2].content, blocks[2].content)
  assert.equal(result.blocks[3].content, blocks[3].content)
  const at = result.blocks[4].content.indexOf('Cell.md'), from = raw.indexOf('Cell.md')
  roundTrip(result.contentTraces[4], from, from + 7, at, at + 7)
})

test('code bodies and math components use actual getLines slices, including empty code and frontmatter', () => {
  const source = '---\r\ntitle: "🧭 [Y](Y.md)"\r\n---\r\n\r\n  ```ts title=sample\r\n  [Code](Code.md)\r\n  ```\r\n\r\n    [Indent](Indent.md)\r\n\r\n$$first\r\nmiddle\r\nlast$$\r\n\r\n```\r\n```'
  const result = parse(source)
  assert.deepEqual(result.blocks.map(block => block.type), ['frontmatter', 'code', 'code', 'math', 'code'])
  for (const [index, word] of [[0, 'Y.md'], [1, 'Code.md'], [2, 'Indent.md'], [3, 'middle']] as const) {
    const from = source.indexOf(word), at = result.blocks[index].content.indexOf(word)
    roundTrip(result.contentTraces[index], from, from + word.length, at, at + word.length)
  }
  assert.equal(result.blocks[4].content, '')
  const empty = result.contentTraces[4], close = source.lastIndexOf('```')
  roundTrip(empty, close, close, 0, 0)
  assert.equal(projectMarkdownSourceRawRange(empty, close + 1, close + 1), null)
})

test('frontmatter traces actual NUL normalization with exact BOM, CRLF and closing whitespace source boundaries', () => {
  for (const newline of ['\n', '\r\n']) {
    const source = '\uFEFF---' + newline + 'title: "A\0B"' + newline
      + 'summary: "🧭 [opaque](Same.md)"' + newline + '---  \t' + newline + newline + '[Visible](Same.md)'
    const ordinary = parseMarkdownSourceStrict(source, { mode: 'canonical' }), result = parse(source)
    assert.deepEqual(result.blocks.map(block => block.type), ['frontmatter', 'paragraph'])
    const trace = result.contentTraces[0]
    assert.equal(trace.content, '---\ntitle: "A\uFFFDB"\nsummary: "🧭 [opaque](Same.md)"\n---  \t')
    const rawNul = source.indexOf('\0'), replacement = trace.content.indexOf('\uFFFD')
    roundTrip(trace, rawNul, rawNul + 1, replacement, replacement + 1)
    roundTrip(trace, 1, 4, 0, 3)
    assert.equal(projectMarkdownSourceRawRange(trace, 0, 1), null, 'the removed BOM does not become header content')
    const rawNewline = source.indexOf(newline), contentNewline = trace.content.indexOf('\n')
    roundTrip(trace, rawNewline, rawNewline + newline.length, contentNewline, contentNewline + 1)
    if (newline.length === 2) assert.equal(projectMarkdownSourceRawRange(trace, rawNewline + 1, rawNewline + 2), null)
    const rawClosing = source.indexOf('---  \t'), contentClosing = trace.content.lastIndexOf('---  \t')
    roundTrip(trace, rawClosing, rawClosing + 6, contentClosing, contentClosing + 6)
    const rawDestination = source.indexOf('Same.md'), contentDestination = trace.content.indexOf('Same.md')
    roundTrip(trace, rawDestination, rawDestination + 7, contentDestination, contentDestination + 7)
    assert.equal(projectMarkdownSourceRawRange(trace, source.lastIndexOf('Same.md'), source.lastIndexOf('Same.md') + 7), null,
      'a repeated destination in another emitted block cannot acquire this header provenance')
    assert.deepEqual(parseMarkdownSourceStrict(source, { mode: 'canonical' }), ordinary, 'ordinary parsing keeps its original emission and shape')
    assert.equal(ordinary.blocks[0].content, trace.content)
    assert.equal(Object.hasOwn(ordinary, 'contentTraces'), false)
  }
})

test('actual empty Markdown hrefs and empty native titles have precise bidirectional zero-width boundaries', () => {
  const source = '# [Empty]() [Angled](<> "title")\r\n\r\n<details data-knowbook-container="toggle-v1" open>\r\n<summary></summary>\r\n\r\nBody\r\n\r\n</details>\r\n\r\n---'
  const result = parse(source), heading = result.contentTraces[0], title = result.contentTraces[1]
  for (const point of [source.indexOf('()') + 1, source.indexOf('<>') + 1]) {
    roundTrip(heading, point, point, point - 2, point - 2)
  }
  const titlePoint = source.indexOf('</summary>')
  roundTrip(title, titlePoint, titlePoint, 0, 0)
  assert.equal(projectMarkdownSourceContentRange(result.contentTraces.at(-1)!, 0, 0), null, 'a divider has no editable empty body')
  assert.equal(projectMarkdownSourceRawRange(title, source.indexOf('<summary>'), source.indexOf('<summary>')), null)
})

test('protected list references map only the actual opaque JSON body and keep source ordering', () => {
  const payload = serializeSyncedBlockPayload({ version: 1, groupId: '11111111-1111-4111-8111-111111111111' })
  const source = '- Parent\r\n  - ```knowbook-synced-block-v1\r\n    ' + payload + '\r\n    ```\r\n- After'
  const from = source.indexOf('```'), to = source.lastIndexOf('```') + 3
  const options = { mode: 'internal-host' as const, references: [{ key: 'ref-key', from, to, payload }] }
  const actual = parseMarkdownSourceStrictWithTrace(source, options), { contentTraces, ...syntax } = actual
  assert.deepEqual(syntax, parseMarkdownSourceStrict(source, options))
  assert.deepEqual(actual.blocks.map(block => [block.type, block.depth, block.parentIndex]), [
    ['bulleted-list', 0, null], ['synced-block', 1, 0], ['bulleted-list', 0, null]
  ])
  const body = source.indexOf(payload)
  roundTrip(contentTraces[1], body, body + payload.length, 0, payload.length)
  assert.equal(projectMarkdownSourceRawRange(contentTraces[1], from, from + 3), null)
})

test('canonical database JSON traces exactly; noncanonical JSON is explicitly opaque-generated without changing parser semantics', () => {
  const payload = serializeDatabaseViewPayload({ version: 1, databaseId: 'database', viewId: null,
    config: { version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] }, sorts: [],
      groupBy: { fieldId: null }, visibleFieldIds: [], fieldOrder: [], columnWidths: {}, cardFieldIds: [] } })
  const source = '```knowbook-database-view-v1\r\n' + payload + '\r\n```'
  const result = parse(source), body = source.indexOf(payload)
  roundTrip(result.contentTraces[0], body, body + payload.length, 0, payload.length)
  const changed = source.replace(payload, JSON.stringify(JSON.parse(payload), null, 2)), state = markdownEngine.block.State
  const rules = markdownEngine.block.ruler.__rules__.map(rule => rule.fn)
  assert.equal(parseMarkdownSourceStrict(changed, { mode: 'canonical' }).blocks[0].content, payload)
  const opaque = parse(changed).contentTraces[0]
  assert.equal(opaque.kind, 'opaque-generated'); assert.equal(opaque.content, payload)
  assert.ok(opaque.starts.every(point => point === null)); assert.ok(opaque.ends.every(point => point === null))
  assert.equal(projectMarkdownSourceContentRange(opaque, 0, 0), null)
  assert.equal(projectMarkdownSourceContentRange(opaque, 0, payload.length), null)
  assert.equal(projectMarkdownSourceRawRange(opaque, body, body), null)
  assert.equal(markdownEngine.block.State, state)
  assert.deepEqual(markdownEngine.block.ruler.__rules__.map(rule => rule.fn), rules)
  assert.deepEqual(parseMarkdownBlocks(source).map(block => block.content), [payload])
})

test('normal parses retain their shape/rules, and failed traced parsing restores every observer without partial results', () => {
  const source = 'Plain [A](Guide.md)', state = markdownEngine.block.State
  const rules = markdownEngine.block.ruler.__rules__.map(rule => rule.fn)
  const plain = parseMarkdownSourceStrict(source, { mode: 'canonical' })
  assert.equal(Object.hasOwn(plain, 'contentTraces'), false)
  parse(source)
  assert.equal(markdownEngine.block.State, state)
  assert.deepEqual(markdownEngine.block.ruler.__rules__.map(rule => rule.fn), rules)
  const malformed = '<aside data-knowbook-container="callout-v1">\n<div data-knowbook-title="true">Missing closer</div>'
  assert.throws(() => parseMarkdownSourceStrictWithTrace(malformed, { mode: 'canonical' }))
  assert.equal(markdownEngine.block.State, state)
  assert.deepEqual(markdownEngine.block.ruler.__rules__.map(rule => rule.fn), rules)
  assert.deepEqual(parseMarkdownSourceStrict(source, { mode: 'canonical' }), plain)
})

test('actual emission traces and their list are deeply immutable, so cached zero-width projections cannot become stale', () => {
  const source = '# [Empty]()', result = parseMarkdownSourceStrictWithTrace(source, { mode: 'canonical' })
  const trace = result.contentTraces[0], rawPoint = source.indexOf('()') + 1, contentPoint = rawPoint - 2
  roundTrip(trace, rawPoint, rawPoint, contentPoint, contentPoint)
  assert.ok(Object.isFrozen(result.contentTraces)); assert.ok(Object.isFrozen(trace))
  assert.ok(Object.isFrozen(trace.starts)); assert.ok(Object.isFrozen(trace.ends)); assert.ok(Object.isFrozen(trace.boundaries))
  assert.ok(trace.boundaries.every(points => Object.isFrozen(points)))
  assert.equal(Reflect.set(trace, 'kind', 'opaque-generated'), false)
  assert.equal(Reflect.set(trace, 'index', 99), false)
  assert.equal(Reflect.set(trace, 'content', 'Different body'), false)
  assert.equal(Reflect.set(trace, 'starts', []), false)
  assert.equal(Reflect.set(trace, 'ends', []), false)
  assert.equal(Reflect.set(trace, 'boundaries', trace.boundaries.map(points => points.map(point => point + 10))), false)
  assert.equal(Reflect.set(trace.starts, contentPoint, 99), false)
  assert.equal(Reflect.set(trace.ends, contentPoint - 1, 99), false)
  assert.equal(Reflect.set(trace.boundaries, contentPoint, [99]), false)
  assert.equal(Reflect.set(trace.boundaries[contentPoint], 0, 99), false)
  assert.throws(() => Reflect.apply(Array.prototype.push, result.contentTraces, [trace]), TypeError)
  assert.throws(() => Reflect.apply(Array.prototype.push, trace.starts, [99]), TypeError)
  assert.throws(() => Reflect.apply(Array.prototype.push, trace.boundaries[contentPoint], [99]), TypeError)
  roundTrip(trace, rawPoint, rawPoint, contentPoint, contentPoint)
  const at = trace.content.indexOf('Empty'), rawAt = source.indexOf('Empty')
  roundTrip(trace, rawAt, rawAt + 5, at, at + 5)
})
