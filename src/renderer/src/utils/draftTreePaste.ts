import type { DocumentBlockDraft } from '@shared/contracts'
import { isNestableBlock } from './draftBlockShape'
import { isDraftTreeContiguous } from './draftTreeDepthChange'
import { materializeDraftFragment } from './draftTreeFragment'
import { getBlockSubtreeEndIndex, getNormalizedParentBlockId } from './draftTreeMove'
import { reparentOrphanedBlocksAfterRangeDeletion } from './draftTreePlacement'
import { promoteDraftBlockChildren } from './draftTreeTextEditing'

type DraftRange = { start: number; end: number }

/** A standalone text block exits the enclosing list for all later pasted roots. */
export function materializePastedDraftFragment(parsed: DocumentBlockDraft[], template: DocumentBlockDraft): DocumentBlockDraft[] | null {
  const fragment: DocumentBlockDraft[] = []
  let rootDepth = template.depth
  for (let start = 0; start < parsed.length;) {
    const root = parsed[start]
    let end = start + 1
    while (end < parsed.length && parsed[end].depth > root.depth) end++
    if (!isNestableBlock(root.type)) rootDepth = 0
    const subtree = parsed.slice(start, end).map(block => ({
      ...block, depth: isNestableBlock(block.type) ? block.depth - root.depth + rootDepth : 0
    }))
    // Keep the source as text instead of silently clamping away nested levels.
    if (subtree.some(block => block.depth > 6 || block.depth < 0)) return null
    fragment.push(...materializeDraftFragment(subtree, rootDepth > 0 ? getNormalizedParentBlockId(template) : null))
    start = end
  }
  return fragment
}

/** Replace text in one parent, or replace an entire selected range, atomically. */
export function planDraftBlockPaste(
  blocks: DocumentBlockDraft[], range: DraftRange, pasted: DocumentBlockDraft[], preserveChildren: boolean
): { blocks: DocumentBlockDraft[]; focusIndex: number } | null {
  if (!pasted.length || range.start < 0 || range.end < range.start || range.end >= blocks.length) return null
  const current = blocks[range.start]
  const fragment = pasted.map(block => ({ ...block }))
  let next: DocumentBlockDraft[]
  if (preserveChildren) {
    const generatedId = fragment[0].id
    fragment[0] = { ...fragment[0], id: current.id, tags: current.tags, highlight: current.highlight }
    for (const block of fragment) if (block.parentBlockId === generatedId) block.parentBlockId = current.id
    const subtreeEnd = getBlockSubtreeEndIndex(blocks, range.start)
    const source = !isNestableBlock(fragment[0].type)
      ? promoteDraftBlockChildren(blocks, range.start)
      : current.depth > 0 && fragment.some(block => block.depth === 0)
        ? promoteDraftBlockChildren(blocks, subtreeEnd) : blocks
    const firstSubtreeEnd = getBlockSubtreeEndIndex(fragment, 0)
    next = [...source.slice(0, range.start), ...fragment.slice(0, firstSubtreeEnd + 1),
      ...source.slice(range.start + 1, subtreeEnd + 1), ...fragment.slice(firstSubtreeEnd + 1), ...source.slice(subtreeEnd + 1)]
  } else {
    // A visible parent-plus-child selection may leave later children outside
    // the range. Promote them rather than adopting them into the pasted root.
    let remaining = reparentOrphanedBlocksAfterRangeDeletion(blocks, range.start, range.end)
    if (current.depth > 0 && fragment.some(block => block.depth === 0)) {
      remaining = promoteDraftBlockChildren(remaining, range.start - 1)
    }
    next = [...remaining.slice(0, range.start), ...fragment, ...remaining.slice(range.start)]
  }
  if (!isDraftTreeContiguous(next)) return null
  return { blocks: next, focusIndex: next.findIndex(block => block.id === fragment.at(-1)!.id) }
}
