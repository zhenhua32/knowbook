import type { DocumentBlockDraft } from '@shared/contracts'

export function findBlockSearchMatches(blocks: DocumentBlockDraft[], text: string) {
  const query = text.trim().toLocaleLowerCase()
  if (!query) return []
  return blocks.flatMap((block, index) => {
    const match = block.content.toLocaleLowerCase().indexOf(query)
    if (match < 0 && !block.type.toLocaleLowerCase().includes(query)) return []
    const start = Math.max(0, match - 36)
    const end = Math.min(block.content.length, Math.max(start + 120, match + query.length))
    return [{ index, type: block.type,
      contentPreview: `${start > 0 ? '…' : ''}${block.content.slice(start, end)}${end < block.content.length ? '…' : ''}` }]
  })
}
