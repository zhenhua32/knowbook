import { collectMarkdownReferences, getHeadingLevel, markdownEngine } from './markdownEngine'
import { markdownHeadingSlug, markdownInlineText as inlineText } from './markdownHeadingText'
import { serializeBlocksToMarkdown } from './markdown'
import type { DocumentBlockDraft } from './contracts'

type HeadingBlock = Pick<DocumentBlockDraft, 'id' | 'type' | 'content' | 'depth' | 'checked'>
export type MarkdownAnchor = { slug: string; blockIndex: number; blockId?: string; headingIndex: number }

export function collectMarkdownAnchors(title: string, blocks: HeadingBlock[]): MarkdownAnchor[] {
  const used = new Set<string>()
  const references = collectMarkdownReferences(serializeBlocksToMarkdown(blocks))
  const anchors: MarkdownAnchor[] = []
  const add = (text: string, blockIndex: number, headingIndex: number) => {
    const slug = markdownHeadingSlug(text, used)
    anchors.push({ slug, blockIndex, blockId: blocks[blockIndex]?.id, headingIndex })
  }
  add(inlineText(markdownEngine.parseInline(title, { references })[0]?.children ?? []), -1, 0)
  blocks.forEach((block, index) => {
    if (getHeadingLevel(block.type)) add(inlineText(markdownEngine.parseInline(block.content, { references })[0]?.children ?? []), index, 0)
    else if (!['code', 'math', 'divider', 'table'].includes(block.type)) {
      const tokens = markdownEngine.parse(block.content, { references: { ...references } })
      let headingIndex = 0
      for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
        const token = tokens[tokenIndex]
        if (token.type === 'footnote_block_open') break
        if (token.type === 'heading_open') add(inlineText(tokens[tokenIndex + 1]?.children ?? []), index, headingIndex++)
      }
    }
  })
  return anchors
}
