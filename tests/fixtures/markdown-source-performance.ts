import type { DocumentBlockDraft } from '../../src/shared/contracts'

/** Identical body and block identities for microbenchmarks and real editor input. */
export function sourceEditingBlocks(count: number): DocumentBlockDraft[] {
  return Array.from({ length: count }, (_, index) => {
    const base = { id: `source-${index}`, checked: false, depth: 0, tags: [`group-${index % 5}`] }
    if (index % 20 === 0) return { ...base, type: 'heading-2', content: `章节 ${index / 20} · Source editing` }
    if (index % 20 === 19) return { ...base, type: 'code', language: 'text', content: 'literal **value**\n[link](Target.md)\n中文🙂' }
    return { ...base, type: 'paragraph', content: `段落 ${index} ${'中英文 source editing performance. '.repeat(4)}` }
  })
}
