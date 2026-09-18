import type { Token } from 'markdown-it'

export function markdownInlineText(tokens: Token[]): string {
  return tokens.map((token) => token.children ? markdownInlineText(token.children)
    : ['text', 'code_inline', 'wiki_link', 'math_inline'].includes(token.type) ? token.content
    : ['softbreak', 'hardbreak'].includes(token.type) ? ' ' : '').join('')
}

export function markdownHeadingSlug(text: string, used: Set<string>): string {
  const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-')
  let slug = base
  for (let suffix = 1; used.has(slug); suffix++) slug = `${base}-${suffix}`
  used.add(slug)
  return slug
}
