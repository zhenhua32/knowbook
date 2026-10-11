import type { DocumentBlockDraft } from '@shared/contracts'

/** Keep descendants when their root becomes a text block that cannot parent a list. */
export function promoteDraftBlockChildren(blocks: DocumentBlockDraft[], index: number): DocumentBlockDraft[] {
  const next = [...blocks]
  if (!blocks[index]) return next

  // A paragraph starts a new root. Trailing siblings of a nested list item
  // must also leave the enclosing list, rather than pointing across that root.
  let promotedRootDepth = Infinity
  for (let cursor = index + 1; cursor < blocks.length && blocks[cursor].depth > 0; cursor += 1) {
    const block = blocks[cursor]
    if (block.depth <= promotedRootDepth) {
      promotedRootDepth = block.depth
      next[cursor] = { ...block, depth: 0, parentBlockId: null }
    } else {
      next[cursor] = { ...block, depth: block.depth - promotedRootDepth }
    }
  }
  return next
}
