import type { DocumentBlockDraft } from '@shared/contracts'
import { canBlockNestUnder } from '@shared/blockTypes'
import { serializeDatabaseViewPayload, type DatabaseViewBlockPayloadV1 } from '@shared/databaseViewBlock'
import { getBlockSubtreeEndIndex } from './draftTreeMove'
import { removeSlashCommand } from './editorAssist'
import { normalizeDraftBlocks } from './draftTreeNormalization'

export function planDatabaseViewInsertion(blocks: DocumentBlockDraft[], anchorId: string | undefined,
  payload: DatabaseViewBlockPayloadV1, slash?: { start: number; cursor: number }): { blocks: DocumentBlockDraft[]; id: string } | null {
  const content = serializeDatabaseViewPayload(payload)
  const index = anchorId ? blocks.findIndex(block => block.id === anchorId) : blocks.length - 1
  if (anchorId && index < 0) return null
  const anchor = blocks[index]
  const remainder = anchor && slash ? removeSlashCommand(anchor.content, slash.start, slash.cursor).content : anchor?.content
  if (anchor?.type === 'paragraph' && remainder === '' && getBlockSubtreeEndIndex(blocks, index) === index) {
    const next = blocks.map((block, at) => at === index ? { id: block.id, tags: block.tags, highlight: block.highlight,
      type: 'database-view', content, checked: false, depth: block.depth, parentBlockId: block.parentBlockId ?? null } : block)
    return { blocks: normalizeDraftBlocks(next), id: anchor.id! }
  }
  let branch = index, parent = anchor?.parentBlockId ?? null
  const byId = new Map(blocks.map((block, at) => [block.id, at]))
  while (parent) {
    const at = byId.get(parent)
    if (at === undefined) return null
    if (canBlockNestUnder(blocks[at].type, 'database-view')) break
    branch = at; parent = blocks[at].parentBlockId ?? null
  }
  const depth = parent ? blocks[byId.get(parent)!].depth + 1 : 0
  if (depth > 6) return null
  const id = crypto.randomUUID(), next = [...blocks]
  if (anchor && slash && remainder !== anchor.content) next[index] = { ...anchor, content: remainder! }
  next.splice(branch < 0 ? 0 : getBlockSubtreeEndIndex(blocks, branch) + 1, 0,
    { id, type: 'database-view', content, checked: false, depth, parentBlockId: parent })
  return { blocks: normalizeDraftBlocks(next), id }
}
