import type { DocumentBlockDraft } from '@shared/contracts'

type DraftBlockRange = {
  start: number
  end: number
}

type TreeAwareBlock = {
  id?: string
  parentBlockId?: string | null
  depth: number
}

export function getNormalizedBlockId<TBlock extends { id?: string }>(block: TBlock | undefined): string | null {
  return block?.id?.trim() ? block.id : null
}

export function getNormalizedParentBlockId<TBlock extends { parentBlockId?: string | null }>(block: TBlock | undefined): string | null {
  return block?.parentBlockId?.trim() ? block.parentBlockId : null
}

function buildTreeAwareBlockIndexById<TBlock extends TreeAwareBlock>(blocks: TBlock[]): Map<string, number> {
  const indexById = new Map<string, number>()
  for (let index = 0; index < blocks.length; index += 1) {
    const blockId = getNormalizedBlockId(blocks[index])
    if (blockId) {
      indexById.set(blockId, index)
    }
  }
  return indexById
}

function isBlockDescendantOf<TBlock extends TreeAwareBlock>(
  rootId: string,
  blocks: TBlock[],
  candidateIndex: number,
  indexById: Map<string, number>
): boolean {
  const candidate = blocks[candidateIndex]
  if (!candidate) {
    return false
  }

  const visitedParentIds = new Set<string>()
  let currentParentId = getNormalizedParentBlockId(candidate)

  while (currentParentId) {
    if (currentParentId === rootId) {
      return true
    }

    if (visitedParentIds.has(currentParentId)) {
      return false
    }

    visitedParentIds.add(currentParentId)
    const parentIndex = indexById.get(currentParentId)
    if (parentIndex === undefined || parentIndex >= candidateIndex) {
      return false
    }

    currentParentId = getNormalizedParentBlockId(blocks[parentIndex])
  }

  return false
}

export function getBlockSubtreeEndIndex<TBlock extends TreeAwareBlock>(blocks: TBlock[], index: number) {
  const root = blocks[index]
  if (!root) {
    return index
  }

  const rootId = getNormalizedBlockId(root)
  if (!rootId) {
    let fallbackEndIndex = index
    for (let currentIndex = index + 1; currentIndex < blocks.length; currentIndex += 1) {
      if (blocks[currentIndex].depth <= root.depth) {
        break
      }

      fallbackEndIndex = currentIndex
    }

    return fallbackEndIndex
  }

  const indexById = buildTreeAwareBlockIndexById(blocks)

  let endIndex = index
  for (let currentIndex = index + 1; currentIndex < blocks.length; currentIndex += 1) {
    if (blocks[currentIndex].depth <= root.depth) {
      break
    }

    if (!isBlockDescendantOf(rootId, blocks, currentIndex, indexById)) {
      break
    }

    endIndex = currentIndex
  }

  return endIndex
}

export function getPreviousSiblingSubtreeStartIndex<TBlock extends TreeAwareBlock>(blocks: TBlock[], index: number) {
  const root = blocks[index]
  if (!root) {
    return null
  }

  const rootParentBlockId = getNormalizedParentBlockId(root)

  for (let currentIndex = index - 1; currentIndex >= 0; currentIndex -= 1) {
    if (blocks[currentIndex].depth === root.depth) {
      if (getNormalizedParentBlockId(blocks[currentIndex]) === rootParentBlockId) {
        return currentIndex
      }
      continue
    }

    if (blocks[currentIndex].depth < root.depth) {
      break
    }
  }

  return null
}

export function getNextSiblingSubtreeStartIndex<TBlock extends TreeAwareBlock>(blocks: TBlock[], index: number) {
  const root = blocks[index]
  if (!root) {
    return null
  }

  const rootParentBlockId = getNormalizedParentBlockId(root)
  const subtreeEndIndex = getBlockSubtreeEndIndex(blocks, index)
  for (let currentIndex = subtreeEndIndex + 1; currentIndex < blocks.length; currentIndex += 1) {
    if (blocks[currentIndex].depth === root.depth) {
      if (getNormalizedParentBlockId(blocks[currentIndex]) === rootParentBlockId) {
        return currentIndex
      }
      continue
    }

    if (blocks[currentIndex].depth < root.depth) {
      break
    }
  }

  return null
}

export function getFragmentLocalRootIds(blocks: DocumentBlockDraft[]): Set<string> {
  const blockIds = new Set(blocks.map((block) => getNormalizedBlockId(block)).filter((id): id is string => Boolean(id)))
  const rootIds = new Set<string>()

  for (const block of blocks) {
    const blockId = getNormalizedBlockId(block)
    if (!blockId) {
      continue
    }

    const parentBlockId = getNormalizedParentBlockId(block)
    if (!parentBlockId || !blockIds.has(parentBlockId)) {
      rootIds.add(blockId)
    }
  }

  return rootIds
}

export function moveContiguousBlockRange(
  blocks: DocumentBlockDraft[],
  range: DraftBlockRange,
  targetIndex: number
): DocumentBlockDraft[] {
  const movedBlocks = blocks.slice(range.start, range.end + 1)
  const next = [...blocks]
  next.splice(range.start, movedBlocks.length)

  const insertionIndex = range.start < targetIndex ? Math.max(0, targetIndex - movedBlocks.length + 1) : targetIndex
  next.splice(insertionIndex, 0, ...movedBlocks)
  return next
}

export function remapIndexAfterSubtreeMove(
  index: number | null,
  sourceIndex: number,
  subtreeEndIndex: number,
  insertionIndex: number
): number | null {
  if (index === null) {
    return index
  }

  const subtreeSize = subtreeEndIndex - sourceIndex + 1

  if (index >= sourceIndex && index <= subtreeEndIndex) {
    return insertionIndex + (index - sourceIndex)
  }

  if (sourceIndex < insertionIndex && index > subtreeEndIndex && index <= insertionIndex + subtreeSize - 1) {
    return index - subtreeSize
  }

  if (sourceIndex > insertionIndex && index >= insertionIndex && index < sourceIndex) {
    return index + subtreeSize
  }

  return index
}