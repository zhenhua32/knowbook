import type MarkdownIt from 'markdown-it'

function webLinkLength(source: string): number {
  const domain = source.match(/^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/u)?.[0]
  if (!domain || domain.split('.').slice(-2).some((part) => part.includes('_'))) return 0
  let value = source.match(/^[^\s<>]+/)![0].replace(/[?!.,:*_~]+$/, '')
  const extraClosing = (value.match(/\)/g)?.length ?? 0) - (value.match(/\(/g)?.length ?? 0)
  if (extraClosing > 0 && value.endsWith(')')) {
    const trailing = value.match(/\)+$/)![0].length
    value = value.slice(0, -Math.min(extraClosing, trailing))
  }
  value = value.replace(/&[a-zA-Z0-9]+;$/, '')
  return value.length
}

/** GFM web autolinks, including trailing punctuation, parentheses and entities. */
export function installMarkdownAutolinks(md: InstanceType<typeof MarkdownIt>): void {
  const autolink = md.inline.ruler.__rules__.find((rule) => rule.name === 'autolink')!.fn
  md.inline.ruler.at('autolink', (state, silent) => state.linkLevel > 0 ? false : autolink(state, silent))
  md.linkify.add('www.', {
    validate: (text, pos) => webLinkLength(text.slice(pos)),
    normalize: (match) => { match.url = `http://${match.raw}` }
  })
  // Retain common local-development hosts through the existing recognizer;
  // apply GFM's path boundary rule to domain-based HTTP links.
  for (const schema of ['http:', 'https:']) {
    md.linkify.add(schema, {
      validate: (text, pos, self) => {
        if (!text.startsWith('//', pos)) return 0
        const length = webLinkLength(text.slice(pos + 2))
        if (length) return length + 2
        const re = self.re.get_http_validator()
        re.lastIndex = pos
        return re.exec(text)?.[0].length ?? 0
      }
    })
  }
  const match = md.linkify.match.bind(md.linkify)
  md.linkify.match = (text) => (match(text) ?? []).filter((link) => {
    // Bare email domains cannot contain '+'; explicit Markdown links retain
    // normal URL validation, independently of automatic link recognition.
    return link.schema !== 'mailto:' || !link.url.slice(link.url.lastIndexOf('@') + 1).includes('+')
  })
}
