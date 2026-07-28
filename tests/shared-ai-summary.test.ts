import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDocumentSummarySource } from '../src/shared/ai-summary.ts'

test('buildDocumentSummarySource includes every block when content fits', () => {
  assert.equal(
    buildDocumentSummarySource([' First block ', '', 'Last block']),
    'First block\nLast block'
  )
})

test('buildDocumentSummarySource preserves both ends of long documents', () => {
  const source = buildDocumentSummarySource([
    `START-${'a'.repeat(80)}`,
    `MIDDLE-${'b'.repeat(80)}`,
    `END-${'c'.repeat(80)}`
  ], 120)

  assert.equal(source.length, 120)
  assert.equal(source.startsWith('START-'), true)
  assert.equal(source.includes('[Middle content omitted for length]'), true)
  assert.equal(source.endsWith('c'.repeat(10)), true)
})
