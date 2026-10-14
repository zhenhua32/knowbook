import type { DocumentBlockDraft } from '@shared/contracts'
import { canBlockNestUnder } from '@shared/blockTypes'
import { isDraftTreeContiguous } from './draftTreeDepthChange'
import { getNormalizedParentBlockId } from './draftTreeMove'

/** Resolve a whole conversion against the authored and current ancestor chains.
 * A linear pass keeps large multi-block conversions independent of block count
 * times selection size, while preserving every unselected complete subtree.
 */
export function prepareDraftBlockTypeChanges(blocks: DocumentBlockDraft[], ids: readonly string[], type: string): DocumentBlockDraft[] {
  if (!isDraftTreeContiguous(blocks)) return [...blocks]
  const selected = new Set(ids)
  const originalById = new Map(blocks.map(block => [block.id!, block]))
  const convertedType = (block: DocumentBlockDraft) => selected.has(block.id!) ? type : block.type
  const losesChildren = new Set<string>()
  for (const child of blocks) {
    const parent = child.parentBlockId ? originalById.get(child.parentBlockId) : undefined
    if (parent && selected.has(parent.id!) && !canBlockNestUnder(convertedType(parent), convertedType(child))) losesChildren.add(parent.id!)
  }
  const resolved = new Map<string, DocumentBlockDraft>()
  const ancestors: string[] = []
  return blocks.map(block => {
    const nextType = convertedType(block)
    let parentId = getNormalizedParentBlockId(block)
    let parent: DocumentBlockDraft | undefined
    while (parentId) {
      const candidate = resolved.get(parentId)
      if (candidate && ancestors[candidate.depth] === parentId && !losesChildren.has(parentId)
        && canBlockNestUnder(candidate.type, nextType)) { parent = candidate; break }
      parentId = getNormalizedParentBlockId(originalById.get(parentId))
    }
    const depth = parent ? parent.depth + 1 : 0
    const next = nextType === block.type && depth === block.depth && (parent?.id ?? null) === (block.parentBlockId ?? null)
      ? block : { ...block, type: nextType, depth, parentBlockId: parent?.id ?? null }
    ancestors.length = depth + 1
    ancestors[depth] = block.id!
    resolved.set(block.id!, next)
    return next
  })
}

export function prepareDraftBlockTypeChange(blocks: DocumentBlockDraft[], index: number, type: string): DocumentBlockDraft[] {
  const id = blocks[index]?.id
  return id ? prepareDraftBlockTypeChanges(blocks, [id], type) : [...blocks]
}

/** A text block cannot own children, but it can remain inside a container. */
export function promoteDraftBlockChildren(blocks: DocumentBlockDraft[], index: number): DocumentBlockDraft[] {
  const next = prepareDraftBlockTypeChange(blocks, index, 'paragraph')
  if (blocks[index]) next[index] = blocks[index]
  return next
}
