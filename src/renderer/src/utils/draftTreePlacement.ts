import type { DocumentBlockDraft } from '@shared/contracts'
import { getActiveUiText } from '../i18n'
import { normalizeBlockDepth } from './draftBlockShape'
import { getBlockSubtreeEndIndex, getNormalizedBlockId } from './draftTreeMove'

export function resolveDraftBlockRelationship(
  type: string,
  requestedDepth: number,
  requestedParentBlockId: string | null | undefined,
  id: string,
  resolvedDepthById: Map<string, number>,
  depthStack: Array<string | null>
) {
  const trimmedParentBlockId = requestedParentBlockId?.trim() ? requestedParentBlockId : null
  const explicitParentDepth = trimmedParentBlockId && trimmedParentBlockId !== id ? resolvedDepthById.get(trimmedParentBlockId) : undefined

  if (explicitParentDepth !== undefined) {
    const explicitDepth = normalizeBlockDepth(type, explicitParentDepth + 1)
    if (explicitDepth > explicitParentDepth) {
      return {
        depth: explicitDepth,
        parentBlockId: trimmedParentBlockId
      }
    }
  }

  let depth = normalizeBlockDepth(type, requestedDepth)
  while (depth > 0 && !depthStack[depth - 1]) {
    depth -= 1
  }

  return {
    depth,
    parentBlockId: depth > 0 ? depthStack[depth - 1] ?? null : null
  }
}

function getBlockTreeText(type: string, content: string): string {
  if (type === 'divider') {
    return getActiveUiText().horizontalDivider
  }

  const normalizedContent = content.trim()
  if (!normalizedContent) {
    return getActiveUiText().emptyBlock
  }

  return normalizedContent.length > 72 ? `${normalizedContent.slice(0, 72)}...` : normalizedContent
}

export function resolveDraftInsertionPlacement(
  blocks: DocumentBlockDraft[],
  insertionIndex: number,
  type: string,
  requestedDepth: number
): { depth: number; parentBlockId: string | null; parentText: string | null } {
  const resolvedDepthById = new Map<string, number>()
  const depthStack: Array<string | null> = []
  const textById = new Map<string, string>()
  const boundedInsertionIndex = Math.max(0, Math.min(insertionIndex, blocks.length))

  for (let index = 0; index < boundedInsertionIndex; index += 1) {
    const block = blocks[index]
    const id = getNormalizedBlockId(block) ?? `__insertion-context-${index}`
    const { depth, parentBlockId } = resolveDraftBlockRelationship(
      block.type,
      block.depth,
      block.parentBlockId,
      id,
      resolvedDepthById,
      depthStack
    )

    depthStack.length = depth + 1
    depthStack[depth] = id
    resolvedDepthById.set(id, depth)
    textById.set(id, getBlockTreeText(block.type, block.content))
  }

  const placement = resolveDraftBlockRelationship(type, requestedDepth, null, '__insertion-candidate__', resolvedDepthById, depthStack)

  return {
    ...placement,
    parentText: placement.parentBlockId ? textById.get(placement.parentBlockId) ?? null : null
  }
}

export function getBlockDropPreview(
  blocks: DocumentBlockDraft[],
  sourceIndex: number,
  targetIndex: number,
  targetDepth: number | null
): { positionLabel: string; effectiveDepth: number; parentText: string | null } | null {
  const subtreeEndIndex = getBlockSubtreeEndIndex(blocks, sourceIndex)
  if (targetIndex >= sourceIndex && targetIndex <= subtreeEndIndex) {
    return null
  }

  const movedBlocks = blocks.slice(sourceIndex, subtreeEndIndex + 1)
  const rootBlock = movedBlocks[0]
  if (!rootBlock) {
    return null
  }

  const remainingBlocks = [...blocks]
  remainingBlocks.splice(sourceIndex, movedBlocks.length)

  const insertionIndex = sourceIndex < targetIndex ? Math.max(0, targetIndex - movedBlocks.length + 1) : targetIndex
  const placement = resolveDraftInsertionPlacement(
    remainingBlocks,
    insertionIndex,
    rootBlock.type,
    targetDepth === null ? rootBlock.depth : targetDepth
  )

  return {
    positionLabel: sourceIndex < targetIndex ? 'Drop after' : 'Drop before',
    effectiveDepth: placement.depth,
    parentText: placement.parentText
  }
}