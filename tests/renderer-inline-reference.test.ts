import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getInlineReferenceTokenAtCursor,
  resolveInlineReferenceTarget
} from '../src/renderer/src/components/InlineContentRenderer.tsx'

test('getInlineReferenceTokenAtCursor returns token when cursor is inside a reference', () => {
  const content = 'See [[Home/Product#spec-block]] for details.'
  const cursorPosition = content.indexOf('Product') + 3

  assert.equal(getInlineReferenceTokenAtCursor(content, cursorPosition), 'Home/Product#spec-block')
})

test('resolveInlineReferenceTarget resolves document, same-document block, and cross-document block references', () => {
  const references = [
    { id: 'doc-home', title: 'Home', path: 'Home' },
    { id: 'doc-product', title: 'Product Specs', path: 'Home/Product' }
  ]
  const blockReferences = new Map([
    ['intro-block', { id: 'intro-block', content: 'Introduction section' }],
    ['spec-block', { id: 'spec-block', content: 'Specification details' }]
  ])

  assert.deepEqual(
    resolveInlineReferenceTarget('Home/Product', references, blockReferences, 'doc-home'),
    { type: 'document', documentId: 'doc-product' }
  )

  assert.deepEqual(
    resolveInlineReferenceTarget('intro-block', references, blockReferences, 'doc-home'),
    { type: 'block', documentId: 'doc-home', blockId: 'intro-block' }
  )

  assert.deepEqual(
    resolveInlineReferenceTarget('Home/Product#spec-block', references, blockReferences, 'doc-home'),
    { type: 'cross-block', documentPath: 'Home/Product', blockId: 'spec-block' }
  )
})