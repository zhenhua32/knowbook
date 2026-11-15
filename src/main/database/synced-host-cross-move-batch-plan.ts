import { planDocumentBlockTransfer } from '../../shared/documentBlockTransfer'
import type { DocumentBlockDraft } from '../../shared/contracts'
import type { SyncedPlacement, SyncedStructureAction, SyncedStructureInput } from '../../shared/synced-blocks'
import { SyncedValidationError, validateSyncedHostForest } from '../../shared/syncedBlockValidation'
import type { HostContent } from './synced-host-document-read'

type MoveBatchAction = Extract<SyncedStructureAction, { kind: 'move-batch' }>
export type HostMoveBatchInput = Extract<SyncedStructureInput, { mode: 'command' }> & { action: MoveBatchAction }
export type CrossMoveBatchTransfer = { blockId: string; from: string; to: string }

export function isHostMoveBatchInput(input: SyncedStructureInput): input is HostMoveBatchInput {
  return input.mode === 'command' && input.action.kind === 'move-batch'
}

function invalid(message: string): never {
  throw new SyncedValidationError('forest', message)
}

function insertionPosition(blocks: DocumentBlockDraft[], target: SyncedPlacement): number {
  if (target.beforeBlockId !== null) {
    const position = blocks.findIndex(block => block.id === target.beforeBlockId && block.parentBlockId === target.parentBlockId
      && block.depth === target.depth)
    if (position < 0) return invalid('批量移动的锚点必须留在目标宿主的原父块下。')
    return position
  }
  if (target.parentBlockId === null) return blocks.length
  const parentIndex = blocks.findIndex(block => block.id === target.parentBlockId && block.depth === target.depth - 1)
  if (parentIndex < 0) return invalid('批量移动的父块必须留在目标宿主。')
  let position = parentIndex + 1
  while (position < blocks.length && blocks[position].depth >= target.depth) position++
  return position
}

/** Resolve every move against its original W, then remove all selected roots
 * before inserting any. A block moved by this batch cannot also be an anchor. */
export function planSyncedCrossMoveBatch(input: HostMoveBatchInput) {
  const before = input.hostsWorkingBefore.map(({ documentId, workingBefore }) => ({ documentId, content: workingBefore }))
  const originals = new Map(before.map(side => [side.documentId, side.content]))
  if (originals.size !== before.length) return invalid('批量移动不能重复声明完整宿主。')
  const blockOwners = new Map<string, string>()
  for (const page of before) for (const block of page.content.blocks) {
    if (blockOwners.has(block.id)) return invalid('批量移动的一个块只能属于一份原始宿主。')
    blockOwners.set(block.id, page.documentId)
  }

  const transfers = new Map<string, CrossMoveBatchTransfer>()
  const movePages = new Set<string>()
  const fragments = input.action.moves.map(({ selection, target }) => {
    const from = originals.get(selection.documentId), to = originals.get(target.documentId)
    if (!from || !to || selection.documentId === target.documentId) return invalid('跨页批量移动须声明每次不同宿主的原始草稿。')
    const parent = to.blocks.find(block => block.id === target.parentBlockId)
    if (target.parentBlockId === null ? target.depth !== 0 : !parent || target.depth !== parent.depth + 1) {
      return invalid('批量移动的目标深度与原父块不符。')
    }
    const move = planDocumentBlockTransfer({ from: from.blocks, to: to.blocks, selectedIds: selection.selectedRootIds,
      beforeBlockId: target.beforeBlockId ?? undefined, parentBlockId: target.parentBlockId, allowSyncedPlaceholders: true })
    if (!move) return invalid('批量移动只接受原宿主内连续的完整同级根。')
    movePages.add(selection.documentId)
    movePages.add(target.documentId)
    const moved = new Set(move.movedIds)
    for (const blockId of moved) {
      if (transfers.has(blockId)) return invalid('批量移动中同一块不能被移动两次。')
      transfers.set(blockId, { blockId, from: selection.documentId, to: target.documentId })
    }
    return { target, blocks: move.targetBlocks.filter(block => moved.has(block.id!)) }
  })
  if (fragments.length === 0) return invalid('批量移动须选择实际块。')

  const trees = new Map<string, DocumentBlockDraft[]>(before.map(side => [side.documentId,
    side.content.blocks.filter(block => !transfers.has(block.id))]))
  for (const { target, blocks } of fragments) {
    if ((target.parentBlockId !== null && transfers.has(target.parentBlockId))
      || (target.beforeBlockId !== null && transfers.has(target.beforeBlockId))) {
      return invalid('批量移动不能使用本次移出的父块或锚点。')
    }
    const tree = trees.get(target.documentId)!
    const position = insertionPosition(tree, target)
    trees.set(target.documentId, [...tree.slice(0, position), ...blocks, ...tree.slice(position)])
  }

  const after = before.map(({ documentId, content }) => ({ documentId,
    content: { ...content, blocks: validateSyncedHostForest(trees.get(documentId)) } satisfies HostContent }))
  return { before, after, movePages, transfers: [...transfers.values()] }
}
