import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeMarkdownWithBlockRanges, serializeMarkdownWithBlockRangesCore, type MarkdownRenderableBlock,
  type MarkdownEmissionEvent, type MarkdownSourceSerializationPolicy } from '../src/shared/markdown'
import { serializeMarkdownWithEmissionTrace, projectMarkdownEmissionContentRange as forward, projectMarkdownEmissionSourceRange as backward,
  type MarkdownEmissionContentTrace, type MarkdownEmissionTraceOptions } from '../src/shared/markdownEmissionTrace'
import { NATIVE_LITERAL_MARKER, encodeNativeLiteralText, type NativeLiteralEdit } from '../src/shared/markdownNativeText'
import { renderNativeContainerHeader } from '../src/shared/markdownContainers'
import { serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'

const block = (id: string, type: string, content: string, depth = 0, parentBlockId: string | null = null): MarkdownRenderableBlock =>
  ({ id, type, content, checked: false, depth, parentBlockId })
function render(blocks: MarkdownRenderableBlock[], options: MarkdownEmissionTraceOptions = {}) {
  const before = structuredClone(blocks), actual = serializeMarkdownWithEmissionTrace(blocks, options), { contentTraces, ...plain } = actual
  const normalized = blocks.map(block => ({ ...block, content: options.normalizeLineEndings !== false ? block.content.replace(/\r\n?/g, '\n') : block.content }))
  const { normalizeLineEndings: _normalize, ...ordinaryOptions } = options
  assert.deepEqual(plain, serializeMarkdownWithBlockRanges(normalized, ordinaryOptions), 'The observer never changes actual serializer bytes or existing shape')
  assert.deepEqual(blocks, before)
  assert.equal(contentTraces.length, blocks.length)
  contentTraces.forEach((trace, index) => { assert.equal(trace.index, index); assert.equal(trace.content, blocks[index].content); assert.equal(trace.source, actual.markdown) })
  return actual
}
function roundTrip(trace: MarkdownEmissionContentTrace, from: number, to: number, sourceFrom: number, sourceTo: number) {
  assert.deepEqual(forward(trace, from, to), { from: sourceFrom, to: sourceTo })
  assert.deepEqual(backward(trace, sourceFrom, sourceTo), { from, to })
}

test('ordinary serializer retains its original shape and opt-in traces observe the very same mixed block emission', () => {
  const blocks = [block(' 旧🧭\0 ', 'paragraph', 'same [A](Same.md)'), block('heading', 'heading-3', 'same [A](Same.md)'),
    block('list', 'numbered-list', 'same [A](Same.md)'), block('quote', 'quote', 'same [A](Same.md)')]
  const plain = serializeMarkdownWithBlockRanges(blocks)
  assert.equal(Object.hasOwn(plain, 'contentTraces'), false)
  const result = render(blocks, { normalizeLineEndings: false })
  const occurrences = result.contentTraces.map(trace => {
    const from = trace.content.indexOf('Same.md'), span = forward(trace, from, from + 7)
    assert.ok(span); assert.equal(result.markdown.slice(span.from, span.to), 'Same.md')
    roundTrip(trace, from, from + 7, span.from, span.to)
    return span.from
  })
  assert.equal(new Set(occurrences).size, blocks.length)
  assert.deepEqual(occurrences, [...occurrences].sort((a, b) => a - b))
})

test('original BOM emoji NUL and mixed CRLF/CR map through LF while complete CRLF is atomic in both directions', () => {
  const content = '\uFEFF🙂A\r\nB\rC\nD\0', result = render([block('raw', 'paragraph', content)]), trace = result.contentTraces[0]
  assert.equal(result.markdown, '\uFEFF🙂A\nB\nC\nD\0')
  assert.equal(trace.kind, 'exact')
  roundTrip(trace, 0, content.length, 0, result.markdown.length)
  roundTrip(trace, 1, 3, 1, 3)
  const cr = content.indexOf('\r\n'), lf = result.markdown.indexOf('\n')
  roundTrip(trace, cr, cr + 2, lf, lf + 1)
  assert.equal(forward(trace, cr, cr + 1), null)
  assert.equal(forward(trace, cr + 1, cr + 2), null)
  assert.equal(forward(trace, cr + 1, cr + 1), null)
  roundTrip(trace, cr, cr, lf, lf)
  roundTrip(trace, cr + 2, cr + 2, lf + 1, lf + 1)
})

test('explicit no-normalization keeps raw CRLF bytes and still rejects half-pair and interior insertion projections', () => {
  const result = render([block('literal', 'paragraph', 'A\r\nB')], { normalizeLineEndings: false }), trace = result.contentTraces[0]
  assert.equal(result.markdown, 'A\r\nB')
  roundTrip(trace, 1, 3, 1, 3)
  assert.equal(forward(trace, 1, 2), null); assert.equal(backward(trace, 1, 2), null)
  assert.equal(forward(trace, 2, 3), null); assert.equal(backward(trace, 2, 3), null)
  assert.equal(forward(trace, 2, 2), null); assert.equal(backward(trace, 2, 2), null)
})

test('actual ATX prefixes and Setext suffixes are excluded while raw heading content has exact projections', () => {
  for (const [type, content, prefix] of [['heading-1', 'A', 2], ['heading-3', 'A', 4], ['heading-6', 'A', 7],
    ['heading-1', 'A\r\nB', 0], ['heading-2', 'A ###', 0]] as const) {
    const result = render([block(type, type, content)]), trace = result.contentTraces[0], length = content.replace(/\r\n?/g, '\n').length
    roundTrip(trace, 0, content.length, prefix, prefix + length)
    if (prefix) assert.equal(backward(trace, 0, prefix), null)
    else assert.equal(backward(trace, prefix + length, result.markdown.length), null)
  }
})

test('list and task emission observes actual nesting numbering restarts marker widths and metadata prefixes', () => {
  const blocks = [{ ...block('parent', 'numbered-list', 'P'), listStart: 99, markdownFormat: { listMarker: ')' as const, listLoose: false } },
    block('nested', 'todo', '[A](Same.md)\r\n[B](Same.md)', 1, 'parent'),
    { ...block('restart', 'numbered-todo', '[A](Same.md)'), listStart: 7 }]
  for (const includeBlockMetadata of [false, true]) {
    const result = render(blocks, { includeBlockMetadata })
    for (const trace of result.contentTraces) {
      assert.equal(trace.kind, 'exact')
      for (const match of trace.content.matchAll(/Same\.md/g)) {
        const span = forward(trace, match.index, match.index + 7)
        assert.ok(span); assert.equal(result.markdown.slice(span.from, span.to), 'Same.md')
        roundTrip(trace, match.index, match.index + 7, span.from, span.to)
      }
    }
    const nested = result.contentTraces[1], cr = nested.content.indexOf('\r\n')
    const newline = forward(nested, cr, cr + 2); assert.ok(newline)
    assert.equal(result.markdown.slice(newline.from, newline.to), '\n')
    assert.equal(forward(nested, cr + 2, cr + 2), null, 'Actual continuation indentation creates a boundary gap')
    assert.equal(forward(nested, 0, nested.content.length), null)
    assert.equal(backward(nested, nested.sourceFrom, nested.sourceFrom + 1), null)
  }
})

test('quote prefixes and continuation gaps cannot be projected as content or unique zero-width points', () => {
  const result = render([block('quote', 'quote', 'A\nB')]), trace = result.contentTraces[0]
  assert.equal(result.markdown, '> A\n> B')
  roundTrip(trace, 0, 1, 2, 3); roundTrip(trace, 1, 2, 3, 4); roundTrip(trace, 2, 3, 6, 7)
  assert.equal(forward(trace, 0, 3), null)
  assert.equal(forward(trace, 2, 2), null)
  assert.equal(backward(trace, 4, 6), null); assert.equal(backward(trace, 5, 5), null)
})

test('trailing quote list and task continuation shells retain both zero-width candidates for LF and CRLF', () => {
  const formats = [['quote', '> ', '> '], ['bulleted-list', '- ', '  '], ['numbered-list', '1. ', '   '],
    ['todo', '- [ ] ', '  '], ['numbered-todo', '1. [ ] ', '   ']] as const
  for (const [type, prefix, continuation] of formats) for (const ending of ['\n', '\r\n']) for (const normalizeLineEndings of [true, false]) {
    const content = 'A' + ending, newline = normalizeLineEndings ? '\n' : ending
    const result = render([block(type, type, content)], { normalizeLineEndings }), trace = result.contentTraces[0]
    assert.equal(result.markdown, prefix + 'A' + newline + continuation)
    assert.equal(trace.kind, 'exact')
    const near = prefix.length + 1 + newline.length, far = result.markdown.length
    roundTrip(trace, 0, 1, prefix.length, prefix.length + 1)
    roundTrip(trace, 1, content.length, prefix.length + 1, near)
    roundTrip(trace, 0, content.length, prefix.length, near)
    assert.deepEqual(trace.boundaries[content.length], [near, far], 'The empty last payload must not erase the competing newline endpoint')
    assert.equal(forward(trace, content.length, content.length), null)
    for (let point = near; point <= far; point++) assert.equal(backward(trace, point, point), null)
    assert.equal(backward(trace, near, far), null)
    if (ending === '\r\n') {
      assert.equal(forward(trace, 1, 2), null); assert.equal(forward(trace, 2, 3), null); assert.equal(forward(trace, 2, 2), null)
      if (!normalizeLineEndings) {
        assert.equal(backward(trace, prefix.length + 1, prefix.length + 2), null)
        assert.equal(backward(trace, prefix.length + 2, near), null)
        assert.equal(backward(trace, prefix.length + 2, prefix.length + 2), null)
      }
    }
  }
})

test('actual fence sizes code languages math table and opaque raw syntax retain only emitted payload', () => {
  const blocks = [{ ...block('code', 'code', '````\r\n[A](Same.md)'), language: 'ts' }, block('math', 'math', 'x\r\ny'),
    block('table', 'table', '| A |\r\n| - |\r\n| [x](Same.md) |'), block('yaml', 'frontmatter', '---\r\ntitle: same\r\n---')]
  const result = render(blocks)
  for (const trace of result.contentTraces) {
    const span = forward(trace, 0, trace.content.length)
    assert.ok(span)
    assert.equal(result.markdown.slice(span.from, span.to), trace.content.replace(/\r\n?/g, '\n'))
    roundTrip(trace, 0, trace.content.length, span.from, span.to)
  }
  assert.equal(result.markdown.slice(0, 8), '`````ts\n')
  assert.equal(backward(result.contentTraces[0], 0, 5), null)
})

test('native title complete escaped closer codec is one actual atom and partial marker entity or content ranges fail closed', () => {
  for (const type of ['toggle', 'callout']) {
    const content = type === 'toggle' ? '</summary>' : '</div>', result = render([block(type, type, content)]), trace = result.contentTraces[0]
    assert.equal(trace.kind, 'exact')
    const span = forward(trace, 0, content.length); assert.ok(span)
    const encoded = NATIVE_LITERAL_MARKER + '&lt;' + content.slice(1, -1) + '&gt;'
    assert.equal(result.markdown.slice(span.from, span.to), encoded)
    roundTrip(trace, 0, content.length, span.from, span.to)
    roundTrip(trace, 0, 0, span.from, span.from); roundTrip(trace, content.length, content.length, span.to, span.to)
    assert.equal(forward(trace, 0, 1), null); assert.equal(forward(trace, 1, 1), null)
    assert.equal(backward(trace, span.from, span.from + NATIVE_LITERAL_MARKER.length), null)
    assert.equal(backward(trace, span.from + NATIVE_LITERAL_MARKER.length, span.from + NATIVE_LITERAL_MARKER.length + 4), null)
    assert.equal(backward(trace, span.from + 1, span.to), null)
    assert.equal(backward(trace, trace.sourceFrom, span.from), null)
  }
})

test('literal marker doubling maps the complete actual expansion but neither generated half can claim the original', () => {
  const result = render([block('marker', 'toggle', NATIVE_LITERAL_MARKER)]), trace = result.contentTraces[0]
  const span = forward(trace, 0, NATIVE_LITERAL_MARKER.length); assert.ok(span)
  assert.equal(result.markdown.slice(span.from, span.to), NATIVE_LITERAL_MARKER.repeat(2))
  roundTrip(trace, 0, NATIVE_LITERAL_MARKER.length, span.from, span.to)
  assert.equal(forward(trace, 0, 1), null)
  assert.equal(backward(trace, span.from, span.from + NATIVE_LITERAL_MARKER.length), null)
  assert.equal(backward(trace, span.from + NATIVE_LITERAL_MARKER.length, span.to), null)
  assert.equal(backward(trace, span.from + NATIVE_LITERAL_MARKER.length, span.from + NATIVE_LITERAL_MARKER.length), null)
})

test('native body scope projects actual encoded payload and leaves opaque code and outside content untouched', () => {
  const blocks = [block('owner', 'callout', 'Title'), block('body', 'paragraph', '</aside>\r\n[A](Same.md)', 1, 'owner'),
    block('code', 'code', '</aside>', 1, 'owner'), block('outside', 'paragraph', '</aside>')]
  const result = render(blocks), body = result.contentTraces[1], code = result.contentTraces[2], outside = result.contentTraces[3]
  const span = forward(body, 0, body.content.length); assert.ok(span)
  assert.equal(result.markdown.slice(span.from, span.to), NATIVE_LITERAL_MARKER + '&lt;/aside&gt;\n[A](Same.md)')
  roundTrip(body, 0, body.content.length, span.from, span.to)
  for (const trace of [code, outside]) {
    const literal = forward(trace, 0, trace.content.length); assert.ok(literal)
    assert.equal(result.markdown.slice(literal.from, literal.to), '</aside>')
  }
})

test('empty actual payload points are exact while layout shells dividers and omitted code bodies are explicitly unproven', () => {
  for (const type of ['paragraph', 'heading-3', 'quote', 'todo', 'toggle', 'callout']) {
    const result = render([block(type, type, '')]), trace = result.contentTraces[0], point = forward(trace, 0, 0)
    assert.equal(trace.kind, 'exact'); assert.ok(point); roundTrip(trace, 0, 0, point.from, point.to)
  }
  const blocks = [block('columns', 'columns', ''), { ...block('column', 'column', '', 1, 'columns'), markdownFormat: { columnWeight: 10000 } },
    block('inside', 'paragraph', '', 2, 'column'), block('divider', 'divider', 'not emitted'),
    { ...block('code', 'code', ''), markdownFormat: { emptyCode: true } }]
  const result = render(blocks)
  for (const index of [0, 1, 3, 4]) {
    const trace = result.contentTraces[index]
    assert.equal(trace.kind, 'unproven'); assert.equal(forward(trace, 0, 0), null)
    assert.equal(backward(trace, trace.sourceFrom, trace.sourceFrom), null)
  }
})

test('database canonicalization and custom source policy report missing body authority rather than inventing projections', () => {
  const payload = serializeDatabaseViewPayload({ version: 1, databaseId: 'database', viewId: null,
    config: { version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] }, sorts: [],
      groupBy: { fieldId: null }, visibleFieldIds: [], fieldOrder: [], columnWidths: {}, cardFieldIds: [] } })
  const result = render([block('database', 'database-view', payload)]), trace = result.contentTraces[0]
  assert.equal(trace.kind, 'unproven'); assert.equal(trace.reason, 'opaque-generated'); assert.equal(forward(trace, 0, payload.length), null)
  const policy: MarkdownSourceSerializationPolicy = { depths: blocks => blocks.map(() => 0), listMember: () => false,
    render: () => ({ markdown: 'custom', from: 0, to: 6 }) }
  const events: MarkdownEmissionEvent[] = [], blocks = [block('custom', 'paragraph', 'original')]
  const observed = serializeMarkdownWithBlockRangesCore(blocks, {}, policy, { emit: event => events.push(event) })
  assert.deepEqual(observed, serializeMarkdownWithBlockRangesCore(blocks, {}, policy))
  assert.equal(events[0].reason, 'custom-render'); assert.deepEqual(events[0].segments, [])
})

test('native codec and header observer switches retain ordinary bytes and projection shape even when an observer throws', () => {
  const content = NATIVE_LITERAL_MARKER + ' </summary>', edits: NativeLiteralEdit[] = []
  const plain = encodeNativeLiteralText(content, 'title'), actual = encodeNativeLiteralText(content, 'title', edit => edits.push(edit))
  assert.deepEqual(actual, plain); assert.equal(Object.hasOwn(actual, 'atomicEdits'), false)
  assert.equal(edits.length, 2)
  assert.equal(actual.source.slice(edits[0].sourceFrom, edits[0].sourceTo), NATIVE_LITERAL_MARKER.repeat(2))
  const original = block('toggle', 'toggle', content), header = renderNativeContainerHeader(original)
  let offset = -1
  assert.equal(renderNativeContainerHeader(original, from => { offset = from }), header)
  assert.equal(header.slice(offset, offset + actual.source.length), actual.source)
  assert.throws(() => renderNativeContainerHeader(original, () => { throw new Error('observer') }), /observer/)
  assert.equal(renderNativeContainerHeader(original), header)
  assert.throws(() => serializeMarkdownWithBlockRangesCore([original], {}, undefined, { emit() { throw new Error('observer') } }), /observer/)
  assert.equal(serializeMarkdownWithBlockRanges([original]).markdown, header + '\n\n</details>')
})

test('trace facts are deeply immutable and reject invalid coordinates foreign blocks shells and source gaps', () => {
  const blocks = [block('one', 'paragraph', '[x](Same.md)'), block('two', 'paragraph', '[x](Same.md)')], result = render(blocks), trace = result.contentTraces[0]
  blocks[0].content = 'changed'
  assert.equal(trace.content, '[x](Same.md)')
  for (const value of [result.contentTraces, trace, trace.cells, trace.cells[0], trace.boundaries, trace.boundaries[0]]) assert.ok(Object.isFrozen(value))
  assert.equal(Reflect.set(trace.cells[0], 'sourceFrom', 999), false)
  assert.equal(forward(trace, -1, 1), null); assert.equal(forward(trace, 0, Infinity), null); assert.equal(forward(trace, 0.5, 1), null)
  assert.equal(backward(trace, -1, 1), null)
  const other = result.contentTraces[1], foreign = forward(other, 4, 11); assert.ok(foreign)
  assert.equal(backward(trace, foreign.from, foreign.to), null)
  assert.equal(backward(trace, trace.sourceTo, other.sourceFrom), null)
})
