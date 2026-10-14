import type { DocumentBlockDraft } from '@shared/contracts'
import { canBlockHaveParent, canBlockNestUnder } from '@shared/blockTypes'
import { normalizeBlockDepth } from './draftBlockShape'
import { shiftDraftFragmentDepth } from './draftTreeFragment'
import { resolveDraftInsertionPlacement } from './draftTreePlacement'
import { getBlockSubtreeEndIndex, getFragmentLocalRootIds, getNormalizedParentBlockId } from './draftTreeMove'

type DraftRange = { start: number; end: number }
type DraftMovePlan = { blocks: DocumentBlockDraft[]; insertionIndex: number }

/** Parent references must follow the current ancestor stack, not an earlier closed subtree. */
export function isDraftTreeContiguous(blocks: DocumentBlockDraft[]): boolean {
  const ancestors: DocumentBlockDraft[] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    if (!block.id || seen.has(block.id) || !Number.isInteger(block.depth) || block.depth < 0 || block.depth > 6) return false
    seen.add(block.id)
    const parent = ancestors[block.depth - 1]
    const parentId = getNormalizedParentBlockId(block)
    if (block.depth === 0 ? parentId !== null
      : !parent || !canBlockNestUnder(parent.type, block.type) || parent.id !== parentId) return false
    ancestors.length = block.depth + 1
    ancestors[block.depth] = block
  }
  return true
}

/** Place complete sibling subtrees without clamping descendants or splitting a parent tree. */
export function planDraftSubtreePlacement(blocks: DocumentBlockDraft[], range: DraftRange, insertionIndex: number, requestedDepth: number): DraftMovePlan | null {
  if (range.start < 0 || range.end < range.start || range.end >= blocks.length || !isDraftTreeContiguous(blocks)) return null
  const fragment = blocks.slice(range.start, range.end + 1)
  const first = fragment[0]
  const rootIds = getFragmentLocalRootIds(fragment)
  const roots = fragment.filter(block => block.id && rootIds.has(block.id))
  if (!roots.length || roots.some(block => block.depth !== first.depth
    || getNormalizedParentBlockId(block) !== getNormalizedParentBlockId(first))) return null
  const lastRootIndex = blocks.findIndex(block => block.id === roots.at(-1)!.id)
  if (getBlockSubtreeEndIndex(blocks, lastRootIndex) !== range.end) return null
  const remaining = [...blocks]
  remaining.splice(range.start, fragment.length)
  if (insertionIndex < 0 || insertionIndex > remaining.length) return null
  const placement = resolveDraftInsertionPlacement(remaining, insertionIndex, first.type, requestedDepth)
  const appliedDelta = placement.depth - first.depth
  if (appliedDelta !== 0 && roots.some(block => !canBlockHaveParent(block.type))) return null
  if ((insertionIndex === range.start && appliedDelta === 0)
    || fragment.some(block => block.depth + appliedDelta < 0 || block.depth + appliedDelta > 6)) return null
  // Positive depth requires an active owner; a missing owner cannot become a root reorder.
  if (requestedDepth > 0) {
    const parent = remaining.find(block => block.id === placement.parentBlockId)
    if (!parent || roots.some(block => !canBlockNestUnder(parent.type, block.type))) return null
  }
  remaining.splice(insertionIndex, 0, ...shiftDraftFragmentDepth(fragment, appliedDelta, placement.parentBlockId, rootIds))
  return isDraftTreeContiguous(remaining) ? { blocks: remaining, insertionIndex } : null
}

/** Outdent after the old parent subtree; indent in place beneath the preceding sibling. */
export function planDraftBlockDepthChange(blocks: DocumentBlockDraft[], range: DraftRange, delta: number): DraftMovePlan | null {
  if (range.start < 0 || range.end < range.start || range.end >= blocks.length || !isDraftTreeContiguous(blocks)) return null
  const first = blocks[range.start]
  if (!canBlockHaveParent(first.type) || blocks.slice(range.start, range.end + 1)
    .some(block => block.depth === first.depth && !canBlockHaveParent(block.type))) return null
  const targetDepth = normalizeBlockDepth(first.type, first.depth + delta)
  if (targetDepth === first.depth) return null
  let insertionIndex = range.start
  if (targetDepth < first.depth) {
    const indexById = new Map(blocks.map((block, index) => [block.id, index]))
    let parentIndex = indexById.get(getNormalizedParentBlockId(first) ?? undefined)
    while (parentIndex !== undefined && blocks[parentIndex].depth > targetDepth) {
      parentIndex = indexById.get(getNormalizedParentBlockId(blocks[parentIndex]) ?? undefined)
    }
    if (parentIndex === undefined || blocks[parentIndex].depth !== targetDepth) return null
    insertionIndex = getBlockSubtreeEndIndex(blocks, parentIndex) - (range.end - range.start + 1) + 1
  }
  const plan = planDraftSubtreePlacement(blocks, range, insertionIndex, targetDepth)
  return plan?.blocks[insertionIndex].depth === targetDepth ? plan : null
}
