import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDocumentMarkdown, getDocumentMarkdownFileName } from '../src/renderer/src/utils/documentMarkdown.ts'

test('buildDocumentMarkdown includes a title and serialized block tree', () => {
  assert.equal(buildDocumentMarkdown({
    title: 'Plan',
    blocks: [
      { type: 'heading-2', content: 'Milestone', checked: false, depth: 0, parentBlockId: null },
      { type: 'todo', content: 'Ship', checked: true, depth: 1, parentBlockId: 'missing' }
    ]
  }), '# Plan\n\n## Milestone\n\n- [x] Ship')
})

test('buildDocumentMarkdown and filename generation have safe empty fallbacks', () => {
  assert.equal(buildDocumentMarkdown({ title: 'Empty', blocks: [] }), '# Empty\n')
  assert.equal(getDocumentMarkdownFileName({ path: 'Home/Project Plan', title: 'Ignored' }), 'Project Plan.md')
  assert.equal(getDocumentMarkdownFileName({ path: '', title: 'Fallback' }), 'Fallback.md')
  assert.equal(getDocumentMarkdownFileName({ path: '', title: '' }), 'document.md')
})
