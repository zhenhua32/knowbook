import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DocumentTreeNode } from '../src/shared/contracts.ts'
import { DocumentTree } from '../src/renderer/src/components/DocumentTree.tsx'

test('DocumentTree bounds the rendered rows for a large workspace', () => {
  const nodes: DocumentTreeNode[] = Array.from({ length: 10_000 }, (_, index) => ({
    id: `document-${index}`,
    title: `Document ${index}`,
    path: `Document ${index}`,
    updatedAt: '2026-08-12T00:00:00.000Z',
    children: []
  }))
  const markup = renderToStaticMarkup(
    <DocumentTree
      nodes={nodes}
      selectedDocumentId={null}
      onSelect={() => undefined}
      onOpenContextMenu={() => undefined}
      draggingDocumentId={null}
      dragOverDocumentId={null}
      onDragStart={() => undefined}
      onDragEnd={() => undefined}
      onDragOverNode={() => undefined}
      onDropOnNode={async () => undefined}
    />
  )

  assert.equal((markup.match(/class="tree-node tree-node-virtual"/g) ?? []).length, 28)
  assert.match(markup, /Document 0/)
  assert.doesNotMatch(markup, /Document 9999/)
  assert.match(markup, /height:360000px/)
})
