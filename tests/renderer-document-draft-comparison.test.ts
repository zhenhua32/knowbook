import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts.ts'
import {
  areDocumentDraftBlocksEqual,
  normalizeComparableDocumentTitle
} from '../src/renderer/src/utils/documentDraftComparison.ts'

const baseBlock: DocumentBlockDraft = {
  id: 'block-1',
  type: 'paragraph',
  content: 'Hello',
  checked: false,
  depth: 0,
  parentBlockId: null,
  tags: ['alpha', 'beta']
}

test('document draft comparison preserves normalized title semantics', () => {
  assert.equal(normalizeComparableDocumentTitle('  Title  '), 'Title')
  assert.equal(normalizeComparableDocumentTitle('   '), 'Untitled')
})

test('document draft comparison ignores optional-field and tag-order representation differences', () => {
  assert.equal(areDocumentDraftBlocksEqual(
    [baseBlock],
    [{ ...baseBlock, parentBlockId: undefined, tags: ['beta', 'alpha'] }]
  ), true)
})

test('document draft comparison detects persisted field and ordering changes', () => {
  assert.equal(areDocumentDraftBlocksEqual([baseBlock], [{ ...baseBlock, content: 'Changed' }]), false)
  assert.equal(areDocumentDraftBlocksEqual([baseBlock], [{ ...baseBlock, language: 'typescript' }]), false)
  assert.equal(areDocumentDraftBlocksEqual([baseBlock], [{ ...baseBlock, tags: ['alpha'] }]), false)
  assert.equal(areDocumentDraftBlocksEqual(
    [baseBlock, { ...baseBlock, id: 'block-2' }],
    [{ ...baseBlock, id: 'block-2' }, baseBlock]
  ), false)
})
