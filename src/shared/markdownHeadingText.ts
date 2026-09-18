import type { Token } from 'markdown-it'

export function markdownInlineText(tokens: Token[]): string {
  return tokens.map((token) => token.children ? markdownInlineText(token.children)
    : ['text', 'code_inline', 'wiki_link', 'math_inline'].includes(token.type) ? token.content
    : ['softbreak', 'hardbreak'].includes(token.type) ? ' ' : '').join('')
}

export function createMarkdownHeadingSlugger(): (text: string) => string {
  const used = new Set<string>(), nextSuffix = new Map<string, number>()
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-')
    let slug = base, suffix = nextSuffix.get(base) ?? 1
    while (used.has(slug)) slug = `${base}-${suffix++}`
    nextSuffix.set(base, suffix)
    used.add(slug)
    return slug
  }
}
