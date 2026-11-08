import type { SyncedStableBlockDraft, SyncedPlacement } from '@shared/synced-blocks'

/** UI eligibility only. Main still validates the complete real P/W/A and parse scope. */
export function syncedCreateSelection(blocks: readonly SyncedStableBlockDraft[], ids: readonly string[]):
  { ok: true; rootIds: string[]; blockCount: number } | { ok: false; reason: 'selection' | 'nested-sync' } {
  const positions = new Map(blocks.map((block, index) => [block.id, index]))
  if (!ids.length || ids.some(id => !positions.has(id))) return { ok: false, reason: 'selection' }
  const end = (index: number) => { let next = index + 1; while (next < blocks.length && blocks[next].depth > blocks[index].depth) next++; return next }
  const roots: number[] = []
  for (const index of [...new Set(ids)].map(id => positions.get(id)!).sort((a, b) => a - b)) {
    if (!roots.length || index >= end(roots.at(-1)!)) roots.push(index)
  }
  const first = blocks[roots[0]]
  if (roots.some((index, order) => blocks[index].depth !== first.depth || blocks[index].parentBlockId !== first.parentBlockId
    || order > 0 && index !== end(roots[order - 1]))) return { ok: false, reason: 'selection' }
  const selected = blocks.slice(roots[0], end(roots.at(-1)!))
  if (selected.some(block => block.type === 'synced-block')) return { ok: false, reason: 'nested-sync' }
  return { ok: true, rootIds: roots.map(index => blocks[index].id), blockCount: selected.length }
}

export function syncedInsertionAfter(documentId: string, blocks: readonly SyncedStableBlockDraft[], anchorId: string | null): SyncedPlacement | null {
  if (anchorId === null) return { documentId, beforeBlockId: null, parentBlockId: null, depth: 0 }
  const index = blocks.findIndex(block => block.id === anchorId)
  if (index < 0) return null
  const anchor = blocks[index]; let next = index + 1
  while (next < blocks.length && blocks[next].depth > anchor.depth) next++
  const sibling = blocks[next]
  return { documentId, parentBlockId: anchor.parentBlockId, depth: anchor.depth,
    beforeBlockId: sibling?.parentBlockId === anchor.parentBlockId && sibling.depth === anchor.depth ? sibling.id : null }
}
