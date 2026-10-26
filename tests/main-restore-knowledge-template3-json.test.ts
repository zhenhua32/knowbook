import assert from 'node:assert/strict'
import test from 'node:test'
import { template3ContentStringRanges } from '../src/main/database/restore-knowledge-template3-json'

test('template JSON locations select the last decoded content key and leave shadowed literals and whitespace intact', () => {
  const raw = '[\r\n { "content": {"ignored":[true,null,-1.25e2,{"content":"not the block"}]}, "id":"local", "\\u0063ontent" : "effective \\"quoted\\" [x](#local)" }\r\n]\n'
  const original = JSON.parse(raw) as Array<{ content: string }>, ranges = template3ContentStringRanges(raw)
  assert.equal(ranges.length, 1)
  assert.equal(JSON.parse(raw.slice(ranges[0].from, ranges[0].to)), original[0].content)
  const replacement = 'mapped \\"value\\" 😀', range = ranges[0]
  const candidate = raw.slice(0, range.from) + JSON.stringify(replacement) + raw.slice(range.to)
  assert.deepEqual(JSON.parse(candidate), [{ ...original[0], content: replacement }])
  assert.ok(candidate.startsWith(raw.slice(0, range.from)))
  assert.ok(candidate.endsWith(raw.slice(range.to)))
  assert.ok(candidate.includes('"content": {"ignored"'))
  assert.ok(candidate.includes('"\\u0063ontent" : '))
})

test('template JSON locations skip deeply nested shadowed values without adding a manifest depth limit', () => {
  const raw = '[{"content":' + '['.repeat(5000) + 'null' + ']'.repeat(5000) + ',"content":"kept"}]'
  assert.deepEqual(JSON.parse(raw), [{ content: 'kept' }])
  const ranges = template3ContentStringRanges(raw)
  assert.equal(ranges.length, 1)
  assert.equal(raw.slice(ranges[0].from, ranges[0].to), '"kept"')
  assert.equal(raw.slice(0, ranges[0].from).includes('['.repeat(5000)), true)
})

test('equal template content values retain different block ordinal ranges and empty arrays remain empty', () => {
  const raw = JSON.stringify([{ content: 'same ] } \\" 😀', id: 'first' }, { id: 'second', content: 'same ] } \\" 😀' }])
  const ranges = template3ContentStringRanges(raw), values = JSON.parse(raw) as Array<{ content: string }>
  assert.equal(ranges.length, 2)
  assert.ok(ranges[0].to < ranges[1].from)
  assert.deepEqual(ranges.map(range => JSON.parse(raw.slice(range.from, range.to))), values.map(value => value.content))
  assert.deepEqual(template3ContentStringRanges(' \r\n []\t'), [])
})
