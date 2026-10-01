import type { DocumentBlockDraft } from '@shared/contracts'
import type { MarkdownDocumentModel } from '@shared/markdownDocument'
import { getHeadingLevel, markdownEngine } from '@shared/markdownEngine'
import { markdownInlineText } from '@shared/markdownHeadingText'

const comparableTitle = (text: string) => text.normalize('NFC').trim().replace(/\s+/g, ' ')

/** Use an existing opening H1 as the reading title without changing its block. */
export function matchingOpeningTitleIndex(title: string, rows: Array<{ block: DocumentBlockDraft; index: number }>,
  model?: MarkdownDocumentModel): number | null {
  for (const { block, index } of rows) {
    const nodes = model?.blockNodes[index]
    if (block.type === 'frontmatter' || block.type === 'paragraph' && (!block.content.trim() || nodes?.length === 0)) continue
    const heading = nodes?.length === 1 && nodes[0].token.type === 'heading_open' && nodes[0].token.tag === 'h1' ? nodes[0] : null
    if (nodes && !heading || !nodes && getHeadingLevel(block.type) !== 1) return null
    const text = heading ? markdownInlineText(heading.children.map(child => child.token))
      : markdownInlineText(markdownEngine.parseInline(block.content, model?.environment ?? {})[0]?.children ?? [])
    return comparableTitle(text) && comparableTitle(text) === comparableTitle(title) ? index : null
  }
  return null
}
