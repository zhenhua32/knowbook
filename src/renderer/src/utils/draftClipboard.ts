import type { DocumentBlockDraft } from '@shared/contracts'
import { serializeBlocksToMarkdown } from '@shared/markdown'

type DraftBlockRange = { start: number; end: number }

export function serializeDraftBlockRange(blocks: DocumentBlockDraft[], range: DraftBlockRange): string {
  return serializeBlocksToMarkdown(blocks.slice(range.start, range.end + 1), { fallbackCodeLanguage: 'txt' })
}
