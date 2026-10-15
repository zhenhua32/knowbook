import type { Token } from 'markdown-it'
import { nativeMarkdownContainer } from './markdownContainers'

/** Detect only structural shells visited by the shared Markdown grammar.
 * Fences, inline code and unmarked HTML never create these tokens. */
export function hasMarkdownColumnsTokens(tokens: readonly Token[]): boolean {
  let legacyDepth = 0
  for (const token of tokens) {
    if (token.type === 'html_details_open' || token.type === 'html_figure_open') { legacyDepth++; continue }
    if (token.type === 'html_details_close' || token.type === 'html_figure_close') { legacyDepth--; continue }
    if (legacyDepth > 0) continue
    const type = nativeMarkdownContainer(token)?.type
    if (type === 'columns' || type === 'column' || token.children !== null && hasMarkdownColumnsTokens(token.children)) return true
  }
  return false
}
