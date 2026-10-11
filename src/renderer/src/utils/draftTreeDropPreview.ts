import type { DocumentBlockDraft } from '@shared/contracts'
import { getActiveUiText } from '../i18n'
import { planDraftSubtreePlacement } from './draftTreeDepthChange'
import { getBlockSubtreeEndIndex } from './draftTreeMove'
import { getBlockTreeText } from './draftTreePlacement'

export function getBlockDropPreview(
  blocks: DocumentBlockDraft[], sourceIndex: number, targetIndex: number, targetDepth: number | null,
  sourceRange = { start: sourceIndex, end: getBlockSubtreeEndIndex(blocks, sourceIndex) }
): { positionLabel: string; effectiveDepth: number; parentText: string | null } | null {
  if (targetIndex < 0 || targetIndex >= blocks.length || (targetIndex >= sourceRange.start && targetIndex <= sourceRange.end)) return null
  const rootBlock = blocks[sourceRange.start]
  if (!rootBlock) return null
  const insertionIndex = sourceRange.start < targetIndex ? targetIndex - (sourceRange.end - sourceRange.start + 1) + 1 : targetIndex
  const plan = planDraftSubtreePlacement(blocks, sourceRange, insertionIndex, targetDepth ?? rootBlock.depth)
  if (!plan) return null
  const movedRoot = plan.blocks[insertionIndex]
  const parent = plan.blocks.find(block => block.id === movedRoot.parentBlockId)
  return {
    positionLabel: sourceRange.start < targetIndex ? getActiveUiText().dropAfterLabel : getActiveUiText().dropBeforeLabel,
    effectiveDepth: movedRoot.depth,
    parentText: parent ? getBlockTreeText(parent.type, parent.content) : null
  }
}
