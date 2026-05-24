import { useCallback, useState } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'

function getNormalizedBlockId(block: DocumentBlockDraft | undefined): string | null {
  return block?.id?.trim() ? block.id : null
}

function getNormalizedParentBlockId(block: DocumentBlockDraft | undefined): string | null {
  return block?.parentBlockId?.trim() ? block.parentBlockId : null
}

function buildBlockIndexById(blocks: DocumentBlockDraft[]): Map<string, number> {
  const indexById = new Map<string, number>()
  for (let index = 0; index < blocks.length; index += 1) {
    const blockId = getNormalizedBlockId(blocks[index])
    if (blockId) {
      indexById.set(blockId, index)
    }
  }
  return indexById
}

type UseBlockCollapseStateParams = {
  draftBlocks: DocumentBlockDraft[]
  getBlockSubtreeEndIndex: (blocks: DocumentBlockDraft[], index: number) => number
}

export function useBlockCollapseState({ draftBlocks, getBlockSubtreeEndIndex }: UseBlockCollapseStateParams) {
  const [collapsedBlockIds, setCollapsedBlockIds] = useState<Set<string>>(new Set())

  const blockHasChildren = useCallback((blockIndex: number): boolean => {
    return getBlockSubtreeEndIndex(draftBlocks, blockIndex) > blockIndex
  }, [draftBlocks, getBlockSubtreeEndIndex])

  const toggleBlockCollapse = useCallback((blockId: string) => {
    setCollapsedBlockIds((previous) => {
      const nextCollapsed = new Set(previous)
      if (nextCollapsed.has(blockId)) {
        nextCollapsed.delete(blockId)
      } else {
        nextCollapsed.add(blockId)
      }
      return nextCollapsed
    })
  }, [])

  const revealBlockAncestors = useCallback((targetBlockId: string) => {
    setCollapsedBlockIds((previous) => {
      const nextCollapsedBlockIds = new Set(previous)
      const indexById = buildBlockIndexById(draftBlocks)
      const visitedParentIds = new Set<string>()
      let currentBlockId: string | null = targetBlockId

      while (currentBlockId) {
        if (visitedParentIds.has(currentBlockId)) {
          break
        }

        visitedParentIds.add(currentBlockId)
        const currentIndex = indexById.get(currentBlockId)
        if (currentIndex === undefined) {
          break
        }

        const parentBlockId = getNormalizedParentBlockId(draftBlocks[currentIndex])
        if (!parentBlockId) {
          break
        }

        nextCollapsedBlockIds.delete(parentBlockId)
        currentBlockId = parentBlockId
      }

      return nextCollapsedBlockIds
    })
  }, [draftBlocks])

  return {
    blockHasChildren,
    collapsedBlockIds,
    revealBlockAncestors,
    toggleBlockCollapse
  }
}