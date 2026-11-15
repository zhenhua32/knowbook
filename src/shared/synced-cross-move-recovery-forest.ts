import type { DocumentBlockDraft } from './contracts'
import { planDocumentBlockTransfer } from './documentBlockTransfer'
import { readSingleMovedSyncedReference } from './syncedBlockValidation'

/** Use the ordinary move selection to include every physical descendant.
 * Keep the original source position for the mounted reference. */
export function readProtectedCrossMoveSubtrees<T extends DocumentBlockDraft>(forest: readonly T[], rootIds: readonly string[]) {
  const transfer = planDocumentBlockTransfer({ from: forest, to: [], selectedIds: rootIds, allowSyncedPlaceholders: true })
  if (!transfer) return undefined
  const [leaf, other] = transfer.targetBlocks.filter(block => block.type === 'synced-block')
  if (!leaf || other) return undefined
  const reference = forest.find(block => block.id === leaf.id)
  return reference && { reference, movedIds: transfer.movedIds }
}

export function readProtectedCrossMoveReference<T extends DocumentBlockDraft>(forest: readonly T[], rootIds: readonly string[]): T | undefined {
  return rootIds.length === 1 ? readSingleMovedSyncedReference(forest, rootIds[0]) : readProtectedCrossMoveSubtrees(forest, rootIds)?.reference
}
