import { collectMarkdownReferences, getHeadingLevel, markdownEngine } from './markdownEngine'
import { createMarkdownHeadingSlugger, markdownHtmlAnchorNames, markdownInlineText as inlineText } from './markdownHeadingText'
import { serializeBlocksToMarkdown } from './markdown'
import type { DocumentBlockDraft } from './contracts'

type HeadingBlock = Pick<DocumentBlockDraft, 'id' | 'type' | 'content'> & Partial<Pick<DocumentBlockDraft, 'depth' | 'checked'>>
// Negative heading indices address HTML anchors in the owning block, in order.
export type MarkdownAnchor = { slug: string; blockIndex: number; blockId?: string; headingIndex: number }

export function collectMarkdownAnchors(title: string, blocks: HeadingBlock[]): MarkdownAnchor[] {
  const references = collectMarkdownReferences(serializeBlocksToMarkdown(blocks))
  const parsedBlocks = blocks.map((block) => ['code', 'math', 'divider', 'frontmatter'].includes(block.type) ? []
    : markdownEngine.parse(block.content, { references: { ...references } }))
  const slug = createMarkdownHeadingSlugger(parsedBlocks.flatMap(markdownHtmlAnchorNames))
  const anchors: MarkdownAnchor[] = []
  const add = (text: string, blockIndex: number, headingIndex: number) => {
    anchors.push({ slug: slug(text), blockIndex, blockId: blocks[blockIndex]?.id, headingIndex })
  }
  add(inlineText(markdownEngine.parseInline(title, { references })[0]?.children ?? []), -1, 0)
  blocks.forEach((block, index) => {
    let htmlIndex = 0
    const htmlAnchors = (tokens: ReturnType<typeof markdownEngine.parse>) => {
      for (const token of tokens) {
        if (token.type === 'footnote_block_open') break
        const anchor = token.meta?.html && (token.attrGet('id') || token.attrGet('name'))
        if (anchor) anchors.push({ slug: String(anchor), blockIndex: index, blockId: block.id, headingIndex: -(++htmlIndex) })
        if (token.children) htmlAnchors(token.children)
      }
    }
    htmlAnchors(parsedBlocks[index])
    if (getHeadingLevel(block.type)) add(inlineText(markdownEngine.parseInline(block.content, { references })[0]?.children ?? []), index, 0)
    else if (!['code', 'math', 'divider', 'table', 'frontmatter'].includes(block.type)) {
      const tokens = parsedBlocks[index]
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
