import { isListBlockType } from './blockTypes'
import type { DocumentBlockDraft } from './contracts'

export interface DocumentBlockTransferInput {
  /** Complete persisted document trees, including folded descendants. */
  from: readonly DocumentBlockDraft[]
  to: readonly DocumentBlockDraft[]
  /** Each selected block includes its whole subtree; overlapping selections are deduplicated. */
  selectedIds: readonly string[]
  /** Insert before a direct child of parentBlockId, or a root when no parent is supplied. */
  beforeBlockId?: string
  /** Omit for root-level insertion; without beforeBlockId, append to this parent's children. */
  parentBlockId?: string | null
}

export interface DocumentBlockTransferPlan {
  sourceBlocks: DocumentBlockDraft[]
  targetBlocks: DocumentBlockDraft[]
  /** Every transferred ID in source order, including descendants. */
  movedIds: string[]
}

type TreeIndex = { byId: Map<string, number>; subtreeEnds: number[] }
const MAX_DEPTH = 6

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parentId(block: DocumentBlockDraft): string | null {
  return block.parentBlockId ?? null
}

/** Validate the active ancestor stack rather than accepting a parent in a closed subtree. */
function indexTree(blocks: readonly DocumentBlockDraft[]): TreeIndex | null {
  const byId = new Map<string, number>(), subtreeEnds: number[] = []
  const ancestors: DocumentBlockDraft[] = [], openSubtrees: number[] = []
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (!validId(block.id) || byId.has(block.id) || !Number.isInteger(block.depth)
      || block.depth < 0 || block.depth > MAX_DEPTH) return null
    const ownerId = parentId(block), owner = ancestors[block.depth - 1]
    if (block.depth === 0 ? ownerId !== null
      : !isListBlockType(block.type) || !owner || !isListBlockType(owner.type) || owner.id !== ownerId) return null
    while (openSubtrees.length && blocks[openSubtrees.at(-1)!].depth >= block.depth) {
      subtreeEnds[openSubtrees.pop()!] = index
    }
    openSubtrees.push(index)
    ancestors.length = block.depth + 1
    ancestors[block.depth] = block
    byId.set(block.id, index)
  }
  for (const index of openSubtrees) subtreeEnds[index] = blocks.length
  return { byId, subtreeEnds }
}

function cloneBlock(block: DocumentBlockDraft): DocumentBlockDraft {
  return {
    ...block,
    ...(block.tags === undefined ? {} : { tags: [...block.tags] }),
    ...(block.markdownFormat === undefined ? {} : { markdownFormat: { ...block.markdownFormat } })
  }
}

/** Plan both documents before any persistence. Invalid or ambiguous moves return
 * null without repairing IDs, clamping depth, or changing surrounding ownership.
 * Callers must commit the two results together in one storage transaction.
 */
export function planDocumentBlockTransfer(input: DocumentBlockTransferInput): DocumentBlockTransferPlan | null {
  const { from, to, selectedIds, beforeBlockId } = input
  const source = indexTree(from), target = indexTree(to)
  if (!source || !target || !selectedIds.length || [...source.byId.keys()].some(id => target.byId.has(id))) return null
  const ranges: Array<{ start: number; end: number }> = []
  for (const id of new Set(selectedIds)) {
    const start = source.byId.get(id)
    if (!validId(id) || start === undefined) return null
    ranges.push({ start, end: source.subtreeEnds[start] })
  }
  ranges.sort((first, second) => first.start - second.start)
  const start = ranges[0].start
  let end = ranges[0].end
  for (const range of ranges.slice(1)) {
    if (range.start > end) return null
    end = Math.max(end, range.end)
  }
  const fragment = from.slice(start, end), fragmentIds = new Set(fragment.map(block => block.id!))
  const roots = fragment.filter(block => !fragmentIds.has(parentId(block) ?? ''))
  const originalDepth = roots[0].depth, originalParentId = parentId(roots[0])
  if (roots.some(block => block.depth !== originalDepth || parentId(block) !== originalParentId)) return null

  const nextParentId = input.parentBlockId ?? null
  if ((nextParentId !== null && !validId(nextParentId)) || (beforeBlockId !== undefined && !validId(beforeBlockId))) return null
  const ownerIndex = nextParentId === null ? undefined : target.byId.get(nextParentId)
  const owner = ownerIndex === undefined ? undefined : to[ownerIndex]
  if (nextParentId !== null && (!owner || !isListBlockType(owner.type))) return null
  let insertionIndex = ownerIndex === undefined ? to.length : target.subtreeEnds[ownerIndex]
  if (beforeBlockId !== undefined) {
    const beforeIndex = target.byId.get(beforeBlockId)
    if (beforeIndex === undefined || parentId(to[beforeIndex]) !== nextParentId) return null
    insertionIndex = beforeIndex
  }
  const rootDepth = owner ? owner.depth + 1 : 0, depthDelta = rootDepth - originalDepth
  if (fragment.some(block => block.depth + depthDelta < 0 || block.depth + depthDelta > MAX_DEPTH
    || (block.depth + depthDelta > 0 && !isListBlockType(block.type)))) return null
  const rootIds = new Set(roots.map(block => block.id!))
  const moved = fragment.map(block => ({
    ...cloneBlock(block),
    depth: block.depth + depthDelta,
    parentBlockId: rootIds.has(block.id!) ? nextParentId : parentId(block)
  }))
  const sourceBlocks = [...from.slice(0, start), ...from.slice(end)].map(cloneBlock)
  // The insertion boundary is between direct sibling subtrees. Keeping suffix
  // depth and parent IDs intact prevents its first child being adopted by a move.
  const targetBlocks = [...to.slice(0, insertionIndex).map(cloneBlock), ...moved, ...to.slice(insertionIndex).map(cloneBlock)]
  if (!indexTree(sourceBlocks) || !indexTree(targetBlocks)) return null
  return { sourceBlocks, targetBlocks, movedIds: fragment.map(block => block.id!) }
}
