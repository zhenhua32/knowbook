import { collectMarkdownReferences, getHeadingLevel, markdownEngine, type MarkdownToken } from './markdownEngine'
import { serializeBlocksToMarkdown } from './markdown'
import type { DocumentBlockDraft } from './contracts'

type HeadingBlock = Pick<DocumentBlockDraft, 'id' | 'type' | 'content' | 'depth' | 'checked'>
export type MarkdownAnchor = { slug: string; blockIndex: number; blockId?: string; headingIndex: number }

function inlineText(tokens: MarkdownToken[]): string {
  return tokens.map((token) => token.children ? inlineText(token.children)
    : ['text', 'code_inline', 'wiki_link'].includes(token.type) ? token.content
    : ['softbreak', 'hardbreak'].includes(token.type) ? ' ' : '').join('')
}

export function collectMarkdownAnchors(title: string, blocks: HeadingBlock[]): MarkdownAnchor[] {
  const used = new Set<string>()
  const references = collectMarkdownReferences(serializeBlocksToMarkdown(blocks))
  const anchors: MarkdownAnchor[] = []
  const add = (text: string, blockIndex: number, headingIndex: number) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-')
    let slug = base
    for (let suffix = 1; used.has(slug); suffix++) slug = `${base}-${suffix}`
    used.add(slug)
    anchors.push({ slug, blockIndex, blockId: blocks[blockIndex]?.id, headingIndex })
  }
  add(inlineText(markdownEngine.parseInline(title, { references })[0]?.children ?? []), -1, 0)
  blocks.forEach((block, index) => {
    if (getHeadingLevel(block.type)) add(inlineText(markdownEngine.parseInline(block.content, { references })[0]?.children ?? []), index, 0)
    else if (!['code', 'math', 'divider', 'table'].includes(block.type)) {
      const tokens = markdownEngine.parse(block.content, { references: { ...references } })
      let headingIndex = 0
      tokens.forEach((token, tokenIndex) => {
        if (token.type === 'heading_open') add(inlineText(tokens[tokenIndex + 1]?.children ?? []), index, headingIndex++)
      })
    }
  })
  return anchors
}
