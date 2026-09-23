import type MarkdownIt from 'markdown-it'

export type WikiReference = { target: string; path: string; fragment: string; hasFragment: boolean; alias: string | null }

export function parseWikiReference(raw: string): WikiReference {
  const separator = raw.indexOf('|')
  const target = (separator < 0 ? raw : raw.slice(0, separator)).trim()
  const hash = target.indexOf('#')
  return { target, path: hash < 0 ? target : target.slice(0, hash).trim(),
    fragment: hash < 0 ? '' : target.slice(hash + 1).trim(), hasFragment: hash >= 0,
    alias: separator < 0 ? null : raw.slice(separator + 1).trim() }
}

export function wikiDisplayText(raw: string): string {
  const reference = parseWikiReference(raw)
  return reference.alias || reference.target
}

export function wikiDocumentPaths(name: string, sourcePath: string): string[] {
  if (/^[a-z][a-z\d+.-]*:/i.test(name) || /[\\\x00-\x1f]/.test(name)) return []
  if (!name) return sourcePath ? [sourcePath] : []
  const relative = /^\.\.?\//.test(name)
  const parts = relative ? sourcePath.split('/').slice(0, -1) : []
  for (const part of name.split('/')) {
    if (part === '..') { if (!parts.length) return []; parts.pop() }
    else if (part && part !== '.') parts.push(part)
  }
  const path = parts.join('/')
  return [...new Set([path, path.replace(/\.md$/i, '')])].filter(Boolean)
}

/** Root paths and unique titles share the same resolution in Main and Renderer.
 * Exact old names containing a pipe remain valid before interpreting an alias. */
export function resolveWikiDocument<T extends { path: string }>(raw: string, sourcePath: string, lookup: {
  byPath: (path: string) => T | undefined
  byTitle: (title: string) => T[]
}): { document: T; reference: WikiReference } | null {
  if (raw.includes('|') && !raw.includes('#')) {
    const legacy = lookup.byPath(raw.trim())
    if (legacy) return { document: legacy, reference: { target: raw.trim(), path: raw.trim(), fragment: '', hasFragment: false, alias: null } }
  }
  const reference = parseWikiReference(raw)
  // Old cross-block links used the last #, so paths such as C# remain valid.
  for (const [target, alias] of [[reference.target, reference.alias], [raw.trim(), null]] as const) {
    const hash = target.lastIndexOf('#'), name = target.slice(0, hash).trim()
    if (hash >= 0 && /[#|]/.test(name)) {
      const legacy = lookup.byPath(name)
      if (legacy) return { document: legacy, reference: { target, path: name, fragment: target.slice(hash + 1).trim(), hasFragment: true, alias } }
    }
  }
  if (!reference.path && !reference.hasFragment) return null
  for (const path of wikiDocumentPaths(reference.path, sourcePath)) {
    const document = lookup.byPath(path)
    if (document) return { document, reference }
  }
  if (reference.path && !reference.path.includes('/') && !/[:\\]/.test(reference.path)) {
    const candidates = lookup.byTitle(reference.path.replace(/\.md$/i, ''))
    if (candidates.length === 1) return { document: candidates[0], reference }
  }
  return null
}

export function findWikiHeading<T extends { text: string; slug: string }>(fragment: string, headings: T[]): T | undefined {
  // Generated legacy block IDs must not silently bind to a similarly named heading.
  if (/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(fragment) || fragment.startsWith('^')) return undefined
  return headings.find((heading) => heading.slug === fragment)
    ?? headings.find((heading) => heading.text.normalize('NFC').toLowerCase() === fragment.normalize('NFC').toLowerCase())
}

export function rewriteWikiReference(reference: WikiReference, path: string, fragment = reference.fragment): string {
  return path + (reference.hasFragment ? '#' + fragment : '') + (reference.alias === null ? '' : '|' + reference.alias)
}

export function installMarkdownWiki(md: InstanceType<typeof MarkdownIt>): void {
  md.inline.ruler.before('image', 'wiki_embed', (state, silent) => {
    if (silent || !state.src.startsWith('![[', state.pos)) return false
    const end = state.src.indexOf(']]', state.pos + 3)
    if (end < 0) return false
    const raw = state.src.slice(state.pos + 3, end)
    if (!raw.trim() || /[\n\[\]]/.test(raw)) return false
    const reference = parseWikiReference(raw)
    const image = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico)(?:[?#]|$)/i.test(reference.target)
      && md.validateLink(md.normalizeLink(reference.target))
    const token = state.push(image ? 'image' : 'wiki_embed', image ? 'img' : '', 0)
    token.meta = { wiki: true, wikiSource: state.src.slice(state.pos, end + 2) }
    if (image) {
      token.content = reference.alias || reference.path.split('/').at(-1) || reference.target
      token.attrs = [['src', md.normalizeLink(reference.target)], ['alt', '']]
      const text = new state.Token('text', '', 0); text.content = token.content; token.children = [text]
    } else token.content = String(token.meta.wikiSource)
    state.pos = end + 2
    return true
  })
  md.renderer.rules.wiki_embed = (tokens, index) => md.utils.escapeHtml(tokens[index].content)
}
