import type { DocumentBlockDraft } from './contracts'

/** Text AI operates on a selected owner's complete subtree. Database view
 * payloads are references and must never be submitted or replaced as prose. */
export function canAiEditBlockText(blocks: readonly DocumentBlockDraft[], range = { start: 0, end: blocks.length - 1 }): boolean {
  if (range.start < 0 || range.end < range.start || range.end >= blocks.length) return false
  let end = range.end
  let depth = Infinity
  for (let index = range.start; index <= end; index++) depth = Math.min(depth, blocks[index].depth ?? 0)
  while (end + 1 < blocks.length && (blocks[end + 1].depth ?? 0) > depth) end++
  for (let index = range.start; index <= end; index++) if (blocks[index].type.trim() === 'database-view') return false
  return true
}
