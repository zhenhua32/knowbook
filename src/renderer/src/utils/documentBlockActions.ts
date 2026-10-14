import type { DocumentBlockDraft } from '@shared/contracts'
import { isTaskBlockType } from '@shared/blockTypes'
import { isNestableBlock, normalizeBlockDepth } from './draftBlockShape'
import { promoteDraftBlockChildren } from './draftTreeTextEditing'
import { getBlockSubtreeEndIndex } from './draftTreeMove'
import { materializeDraftFragment } from './draftTreeFragment'
import { normalizeDraftBlocks, validateBlockTreeStructure } from './draftTreeNormalization'

export function blockActionRoots(blocks: DocumentBlockDraft[], ids: readonly string[]): string[] | null {
  if (!ids.length || !validateBlockTreeStructure(blocks).valid) return null
  const byId = new Map(blocks.map((block, index) => [block.id, index])), selected = new Set(ids)
  if (ids.some(id => !byId.has(id))) return null
  return blocks.filter(block => {
    if (!block.id || !selected.has(block.id)) return false
    let parent = block.parentBlockId
    while (parent) {
      if (selected.has(parent)) return false
      parent = blocks[byId.get(parent)!]?.parentBlockId
    }
    return true
  }).map(block => block.id!)
}

export function planBlockAction(blocks: DocumentBlockDraft[], ids: readonly string[], action: 'convert' | 'duplicate' | 'delete',
  type?: string): DocumentBlockDraft[] | null {
  const roots = blockActionRoots(blocks, ids)
  if (!roots) return null
  let next: DocumentBlockDraft[] = blocks.map(block => ({ ...block, tags: block.tags && [...block.tags],
    markdownFormat: block.markdownFormat && { ...block.markdownFormat } }))
  if (action === 'convert') {
    if (!type) return null
    // Only explicitly selected rows change type. Hidden descendants keep their
    // own type; losing a list owner promotes their complete valid subtree.
    for (const id of [...new Set(ids)].sort((a,b) => blocks.findIndex(block => block.id === b) - blocks.findIndex(block => block.id === a))) {
      const index = next.findIndex(block => block.id === id), current = next[index]
      if (current.type === type) continue
      if (isNestableBlock(current.type) && !isNestableBlock(type)) next = promoteDraftBlockChildren(next, index)
      const value = next[index]
      next[index] = { ...value, type, content: type === 'divider' ? '' : value.content,
        checked: isTaskBlockType(type) ? value.checked : false, depth: normalizeBlockDepth(type, value.depth),
        parentBlockId: isNestableBlock(type) ? value.parentBlockId : null }
    }
    next = normalizeDraftBlocks(next)
  } else {
    for (const id of [...roots].reverse()) {
      const index = next.findIndex(block => block.id === id), end = getBlockSubtreeEndIndex(next, index)
      if (action === 'delete') next.splice(index, end - index + 1)
      else {
        const fragment = materializeDraftFragment(next.slice(index, end + 1), next[index].parentBlockId ?? null)
        next.splice(end + 1, 0, ...fragment)
      }
    }
  }
  return validateBlockTreeStructure(next).valid ? next : null
}
