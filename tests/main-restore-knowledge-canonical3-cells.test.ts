import assert from 'node:assert/strict'
import test from 'node:test'
import { collectSyncedBindingOccurrences } from '../src/main/sync/synced-binding-occurrences'
import { transformCanonical3Cell, rewriteCanonical3OriginJson } from '../src/main/database/restore-knowledge-canonical3-cells'
import type { SyncedCanonicalWire } from '../src/shared/synced-blocks'

const origin = { version: 1 as const, documentId: 'source-document', pathAtCreation: 'Folder/Original',
  firstInstanceId: '00000000-0000-4000-8000-000000000001' }
const block = (content: string): SyncedCanonicalWire => ({ id: 'canonical', type: 'paragraph', content,
  checked: false, depth: 0, parentBlockId: null, createdAt: '2026-01-01T00:00:00.000Z' })
const keys = (content: string) => collectSyncedBindingOccurrences(origin, [block(content)]).map(({ url: _url, ...key }) => key)

test('canonical3 exact parser keys permit an empty destination and preserve every CRLF HTML and duplicate range', () => {
  const original = '😀 [empty]()\r\n[one](Old.md) <a href="Old.md">two</a> [three](Old.md)'
  const parsed = keys(original)
  assert.equal(parsed.length, 4)
  assert.equal(parsed[0].from, parsed[0].to); assert.equal(parsed[0].raw, '')
  assert.deepEqual(parsed.slice(1).map(key => key.from), [...original.matchAll(/Old\.md/g)].map(match => match.index))
  assert.ok(parsed.slice(1).every(key => key.raw === 'Old.md'))
  const changes = parsed.map((key, index) => ({ key, after: '#^reserved-' + index }))
  const result = transformCanonical3Cell(original, parsed, changes, 'UTF-16be')
  assert.equal(result.text, '😀 [empty](#^reserved-0)\r\n[one](#^reserved-1) <a href="#^reserved-2">two</a> [three](#^reserved-3)')
  assert.deepEqual(keys(result.text), parsed.map(result.project))
  const one = transformCanonical3Cell(original, parsed, [changes[0]], 'UTF-8')
  assert.deepEqual(keys(one.text), parsed.map(one.project), 'An empty insertion shifts every later physical occurrence exactly once')
})

test('canonical3 rejects an unparsed insertion duplicate point overlap accessors and unsupported target encoding', () => {
  const original = '[empty]() [one](Old.md)', parsed = keys(original)
  const unparsed = { ...parsed[0], from: 0, to: 0 }
  assert.throws(() => transformCanonical3Cell(original, parsed, [{ key: unparsed, after: 'invented' }], 'UTF-8'), /unproved/)
  assert.throws(() => transformCanonical3Cell(original, [...parsed, parsed[0]], [], 'UTF-8'), /parser-key|duplicate/)
  assert.throws(() => transformCanonical3Cell(original, parsed, [{ key: parsed[0], after: 'a' }, { key: parsed[0], after: 'b' }], 'UTF-8'), /overlapping/)
  assert.throws(() => transformCanonical3Cell(original, parsed, [], 'unknown'), /encoding/)
  let reads = 0
  assert.throws(() => transformCanonical3Cell(original, parsed, [{ key: parsed[0], get after() { reads++; return 'a' } }], 'UTF-8'))
  assert.equal(reads, 0)
})

test('canonical3 Origin patches only its two identity string literals and retains escaped path and formatting', () => {
  const original = '{\r\n "firstInstanceId" : "00000000-0000-4000-8000-000000000001", "pathAtCreation": "Folder/\\u539f\\u6587",\n "version": 1, "document\\u0049d" : "source-document"\n}'
  const next = { ...origin, pathAtCreation: 'Folder/原文', documentId: 'missing-document',
    firstInstanceId: '00000000-0000-4000-8000-000000000002' }
  const result = rewriteCanonical3OriginJson(original, next)
  assert.equal(result.changes.length, 2)
  assert.equal(result.text, original.replace('00000000-0000-4000-8000-000000000001', next.firstInstanceId)
    .replace('"source-document"', '"missing-document"'))
  assert.deepEqual(JSON.parse(result.text), next)
  assert.throws(() => rewriteCanonical3OriginJson(original, { ...next, pathAtCreation: 'New/Path' }), /origin-path-must-stay-literal/)
})
