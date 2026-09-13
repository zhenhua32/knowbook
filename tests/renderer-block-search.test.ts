import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts.ts'
import { findBlockSearchMatches } from '../src/renderer/src/utils/blockSearch.ts'

test('long-document search keeps original indices and shows text around a late match', () => {
  const blocks: DocumentBlockDraft[] = Array.from({ length: 2000 }, (_, index) => ({
    type: 'paragraph', content: index === 1800 ? `${'很长的前文。'.repeat(100)}Target 内容` : '其他内容', checked: false, depth: 0
  }))
  const matches = findBlockSearchMatches(blocks, ' target ')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].index, 1800)
  assert.match(matches[0].contentPreview, /^….*Target 内容$/)
  assert.ok(matches[0].contentPreview.length < 130)
  assert.deepEqual(findBlockSearchMatches(blocks, '   '), [])
})

test('search handles type matches, Chinese and repeated block object references', () => {
  const block: DocumentBlockDraft = { type: 'code', content: '中文片段', checked: false, depth: 0 }
  assert.deepEqual(findBlockSearchMatches([block, block], '中文').map((match) => match.index), [0, 1])
  assert.deepEqual(findBlockSearchMatches([block], 'CODE').map((match) => match.index), [0])
  assert.deepEqual(findBlockSearchMatches([block], 'missing'), [])
})
