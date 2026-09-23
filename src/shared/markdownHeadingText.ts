import type { Token } from 'markdown-it'
import { wikiDisplayText } from './markdownWiki'

export function markdownInlineText(tokens: Token[]): string {
  return tokens.map((token) => token.children ? markdownInlineText(token.children)
    : token.type === 'wiki_link' ? wikiDisplayText(token.content)
    : ['text', 'code_inline', 'math_inline'].includes(token.type) ? token.content
    : ['softbreak', 'hardbreak'].includes(token.type) ? ' ' : '').join('')
}

export function markdownHtmlAnchorNames(tokens: Token[]): string[] {
  const names = new Set<string>()
  const visit = (items: Token[]) => {
    for (const token of items) {
      if (token.type === 'footnote_block_open') break
      const name = token.meta?.html && (token.attrGet('id') || token.attrGet('name'))
      if (name) names.add(String(name))
      if (token.children) visit(token.children)
    }
  }
  visit(tokens)
  return [...names]
}

export function createMarkdownHeadingSlugger(reserved: Iterable<string> = []): (text: string) => string {
  const used = new Set<string>(reserved), nextSuffix = new Map<string, number>()
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-')
    let slug = base, suffix = nextSuffix.get(base) ?? 1
    while (used.has(slug)) slug = `${base}-${suffix++}`
    nextSuffix.set(base, suffix)
    used.add(slug)
    return slug
  }
}
