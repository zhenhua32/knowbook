import type { DocumentBlockDraft } from '@shared/contracts'
import { isNestableBlock, normalizeBlockDepth } from './draftBlockShape'
import { getNormalizedBlockId } from './draftTreeMove'

export function createDraftBlockId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function materializeDraftFragment(blocks: DocumentBlockDraft[], rootParentBlockId: string | null): DocumentBlockDraft[] {
  if (blocks.length === 0) {
    return blocks
  }

  const minDepth = Math.min(...blocks.map((block) => normalizeBlockDepth(block.type, block.depth)))
  const depthStack: Array<string | null> = []

  return blocks.map((block) => {
    const id = createDraftBlockId()
    const depth = normalizeBlockDepth(block.type, block.depth)
    const parentBlockId = isNestableBlock(block.type)
      ? depth === minDepth
        ? rootParentBlockId
        : depthStack[depth - 1] ?? rootParentBlockId
      : null

    depthStack.length = depth + 1
    depthStack[depth] = id

    return {
      ...block,
      id,
      checked: block.type === 'todo' ? Boolean(block.checked) : false,
      depth,
      parentBlockId
    }
  })
}

export function shiftDraftFragmentDepth(
  blocks: DocumentBlockDraft[],
  depthDelta: number,
  rootParentBlockId: string | null,
  rootIds: Set<string>
): DocumentBlockDraft[] {
  return blocks.map((block) => {
    const blockId = getNormalizedBlockId(block)
    const isRoot = blockId ? rootIds.has(blockId) : false

    if (!isNestableBlock(block.type)) {
      return isRoot
        ? {
            ...block,
            parentBlockId: null
          }
        : block
    }

    return {
      ...block,
      depth: normalizeBlockDepth(block.type, block.depth + depthDelta),
      parentBlockId: isRoot ? rootParentBlockId : block.parentBlockId ?? null
    }
  })
}