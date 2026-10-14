import assert from 'node:assert/strict'
import test from 'node:test'
import { editMarkdownTable, parseEditableMarkdownTable, serializeEditableMarkdownTable, type TableOperation } from '../src/shared/markdownTableEditing'
import { parseMarkdownTable, parseMarkdownTableNode } from '../src/shared/markdownTable'
import { markdownEngine } from '../src/shared/markdownEngine'

const source = '<!-- knowbook:table-widths:v1 [160,null,240] -->\n| A | B | C |\n| :-- | :-: | --: |\n| [ref][r] | `x\\|y` | 一 | hidden one |\n| 😀 | two | 三 | hidden two | extra |\n| third | four | 五 | hidden three |\n\n[r]: https://example.test/docs "Ref 中文"'
const raw = '<!-- knowbook:table-widths:v1 [160, null,240] -->\r\nA|B|C\r\n:--|:---:|---:\r\n[ref][r]|`x\\|y`|一|  ignored  \r\n😀|two|三\r\n\r\n[r]: https://example.test/docs "Ref 中文"\r\n'
const parsed = () => { const value = parseEditableMarkdownTable(source); assert.ok(value); return value }
const shape = (content: string) => { const value = parseEditableMarkdownTable(content); assert.ok(value); return value }

test('bound width directive stays outside the GFM header map and editable source surroundings', () => {
  const token = parseMarkdownTableNode(source)!.token
  assert.deepEqual(token.map, [1, 6])
  assert.deepEqual(token.meta?.tableLayoutMap, [0, 1])
  const table = parsed()
  assert.deepEqual(table.widths, [160, null, 240])
  assert.deepEqual(table.before, [])
  assert.deepEqual(table.headers, ['A', 'B', 'C'])
  assert.deepEqual(table.overflow, [['hidden one'], ['hidden two', 'extra'], ['hidden three']])
  assert.equal(serializeEditableMarkdownTable(table), source)
})

test('body rows move together with overflow and header row zero cannot move', () => {
  const before = parsed()
  const moved = editMarkdownTable(before, { kind: 'move-row', row: 1, toRow: 3 })
  assert.deepEqual(moved.headers, before.headers)
  assert.deepEqual(moved.rows, [before.rows[1], before.rows[2], before.rows[0]])
  assert.deepEqual(moved.overflow, [before.overflow[1], before.overflow[2], before.overflow[0]])
  assert.deepEqual(moved.widths, before.widths)
  assert.equal(serializeEditableMarkdownTable(editMarkdownTable(before, { kind: 'move-row', row: 0, toRow: 1 })), source)
  assert.equal(serializeEditableMarkdownTable(editMarkdownTable(before, { kind: 'move-row', row: 1, toRow: 0 })), source)
  assert.deepEqual(before.rows[0], ['[ref][r]', '`x|y`', '一'])
})

test('columns move header, alignment, cells and finite widths while retaining each row overflow', () => {
  const before = parsed()
  const moved = editMarkdownTable(before, { kind: 'move-column', column: 2, toColumn: 0 })
  assert.deepEqual(moved.headers, ['C', 'A', 'B'])
  assert.deepEqual(moved.alignments, ['right', 'left', 'center'])
  assert.deepEqual(moved.widths, [240, 160, null])
  assert.deepEqual(moved.rows[0], ['一', '[ref][r]', '`x|y`'])
  assert.deepEqual(moved.overflow, before.overflow)
  const changed = serializeEditableMarkdownTable(moved)
  assert.ok(changed.startsWith('<!-- knowbook:table-widths:v1 [240,160,null] -->\n| C | A | B |'))
  assert.equal((changed.match(/knowbook:table-widths:/g) ?? []).length, 1)
  assert.ok(changed.endsWith('[r]: https://example.test/docs "Ref 中文"'))
  assert.match(markdownEngine.render(changed), /href="https:\/\/example.test\/docs"[^>]*title="Ref 中文"/)
  assert.deepEqual(parseMarkdownTable(changed)?.widths, [240, 160, null])
})

test('column insert/delete and spreadsheet paste keep width cardinality and alignment coupled to headers', () => {
  let table = editMarkdownTable(parsed(), { kind: 'insert-column', column: 1 })
  assert.deepEqual(table.widths, [160, null, null, 240])
  assert.deepEqual(table.alignments, ['left', null, 'center', 'right'])
  table = editMarkdownTable(table, { kind: 'delete-column', column: 2 })
  assert.deepEqual(table.widths, [160, null, 240])
  assert.deepEqual(table.headers, ['A', '', 'C'])
  table = editMarkdownTable(table, { kind: 'paste', row: 0, column: 3, cells: [['New', 'Last'], ['cell', 'next']] })
  assert.deepEqual(table.widths, [160, null, 240, null, null])
  assert.deepEqual(shape(serializeEditableMarkdownTable(table)).widths, table.widths)
  assert.deepEqual(table.overflow, parsed().overflow)
})

test('column width adds one bound directive and accepts finite endpoints or null independently', () => {
  const plain = shape('| A | B |\n| - | - |\n| x | y |')
  let table = editMarkdownTable(plain, { kind: 'column-width', column: 1, width: 1200 })
  assert.deepEqual(table.widths, [null, 1200])
  table = editMarkdownTable(table, { kind: 'column-width', column: 0, width: 120 })
  assert.deepEqual(table.widths, [120, 1200])
  table = editMarkdownTable(table, { kind: 'column-width', column: 1, width: null })
  const output = serializeEditableMarkdownTable(table)
  assert.ok(output.startsWith('<!-- knowbook:table-widths:v1 [120,null] -->\n| A | B |'))
  assert.equal((output.match(/knowbook:table-widths:/g) ?? []).length, 1)
  assert.deepEqual(shape(output).widths, [120, null])
})

test('invalid and no-op edits retain original noncanonical CRLF source byte for byte', () => {
  const table = shape(raw)
  const operations: TableOperation[] = [
    { kind: 'move-row', row: 0, toRow: 1 }, { kind: 'move-row', row: 1, toRow: 0 },
    { kind: 'move-row', row: 1, toRow: 1 }, { kind: 'move-row', row: 1.5, toRow: 2 },
    { kind: 'move-column', column: 0, toColumn: 0 }, { kind: 'move-column', column: 0, toColumn: 3 },
    { kind: 'move-column', column: -1, toColumn: 1 }, { kind: 'move-column', column: 0.5, toColumn: 1 },
    ...[119, 1201, 160.5, NaN, Infinity].map(width => ({ kind: 'column-width' as const, column: 0, width })),
    { kind: 'column-width', column: 0, width: 160 }, { kind: 'column-width', column: 1, width: null },
    { kind: 'cell', row: 1, column: 0, value: '[ref][r]' }, { kind: 'align', column: 0, alignment: 'left' },
    { kind: 'insert-row', row: -1 }, { kind: 'insert-row', row: 0 }, { kind: 'insert-column', column: 8 },
    { kind: 'delete-row', row: 0 }, { kind: 'delete-column', column: 8 },
    { kind: 'paste', row: 0, column: 0, cells: [] }
  ]
  for (const operation of operations) {
    const next = editMarkdownTable(table, operation)
    assert.equal(next, table, JSON.stringify(operation))
    assert.equal(serializeEditableMarkdownTable(next), raw, JSON.stringify(operation))
  }
  let reverted = editMarkdownTable(table, { kind: 'move-row', row: 1, toRow: 2 })
  reverted = editMarkdownTable(reverted, { kind: 'move-row', row: 2, toRow: 1 })
  assert.equal(serializeEditableMarkdownTable(reverted), raw)
})

test('width, row and column changes retain the exact model through three parse/serialize round trips', () => {
  let table = editMarkdownTable(parsed(), { kind: 'move-row', row: 3, toRow: 1 })
  table = editMarkdownTable(table, { kind: 'move-column', column: 0, toColumn: 2 })
  table = editMarkdownTable(table, { kind: 'column-width', column: 0, width: 333 })
  const expected = JSON.parse(JSON.stringify(table))
  let content = serializeEditableMarkdownTable(table)
  for (let round = 0; round < 3; round++) {
    table = shape(content)
    assert.deepEqual(table, expected)
    const next = serializeEditableMarkdownTable(table)
    assert.equal(next, content)
    const token = parseMarkdownTableNode(next)!.token
    assert.deepEqual(token.map, [1, 6])
    assert.deepEqual(token.meta?.tableLayoutMap, [0, 1])
    content = next
  }
})

test('unbound duplicate, invalid and unknown width directives never become editable metadata', () => {
  const body = '| A | B |\n| - | - |\n| x | y |'
  for (const prefix of [
    '<!-- knowbook:table-widths:v2 [160,null] -->',
    '<!-- knowbook:table-widths:v1 [119,null] -->',
    '<!-- knowbook:table-widths:v1 [160] -->',
    '<!-- knowbook:table-widths:v1 [160,null] -->\n<!-- knowbook:table-widths:v1 [160,null] -->'
  ]) assert.equal(parseEditableMarkdownTable(prefix + '\n' + body), null)
})
