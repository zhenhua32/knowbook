import { markdownEngine, type MarkdownEnvironment } from './markdownEngine'
import { capturedMarkdownSourceLinks, type MarkdownDestination, type MarkdownSourceLink } from './markdownSourceLinks'
import { extractMarkdownFrontmatter } from './markdownFrontmatter'
export type { MarkdownDestination, MarkdownSourceLink } from './markdownSourceLinks'

/** Locate source destinations without rewriting labels, titles, code or other Markdown. */
export function collectMarkdownDestinations(source: string): MarkdownDestination[] {
  return collectMarkdownSourceLinks(source, false) as MarkdownDestination[]
}

export function collectMarkdownSourceLinks(source: string, includeWiki = true): MarkdownSourceLink[] {
  if (!source.includes('[') && !source.includes('<') && !/file:/i.test(source)) return []
  const headerEnd = extractMarkdownFrontmatter(source)?.end ?? 0
  const env: MarkdownEnvironment = { captureSourceLinks: true }
  // Metadata values are not Markdown content. Keep offsets while masking YAML.
  markdownEngine.parse(source.slice(0, headerEnd).replace(/[^\r\n]/g, ' ') + source.slice(headerEnd), env)
  // markdown-it normalizes CRLF/CR before parsing; edits address the original
  // source, including its existing line endings and UTF-16 character positions.
  const offsets: number[] = []
  for (let index = 0; index < source.length; index++) {
    offsets.push(index)
    if (source[index] === '\r' && source[index + 1] === '\n') index++
  }
  offsets.push(source.length)
  return capturedMarkdownSourceLinks(env).filter((link) => includeWiki || link.kind !== 'wiki')
    .map((link) => ({ ...link, start: offsets[link.start], end: offsets[link.end] }))
    .sort((a, b) => a.start - b.start)
}

export function rewriteMarkdownDestinations(source: string, rewrite: (destination: MarkdownDestination) => string | null | undefined): string {
  const edits = collectMarkdownDestinations(source).map((destination) => ({ ...destination, replacement: rewrite(destination) }))
  for (const edit of edits.reverse()) {
    if (edit.replacement == null || edit.replacement === edit.url) continue
    const escaped = escapeMarkdownDestination(edit.replacement, edit.syntax)
    if (edit.kind === 'autolink') {
      // Relative destinations are not valid inside <...>; retain the visible
      // label while converting the exported/imported URL to a normal link.
      const label = source.slice(edit.start, edit.end).replace(/[\\\[\]]/g, '\\$&')
      const brackets = edit.syntax === 'bare' ? 0 : 1
      source = source.slice(0, edit.start - brackets) + `[${label}](${escaped})` + source.slice(edit.end + brackets)
    } else source = source.slice(0, edit.start) + escaped + source.slice(edit.end)
  }
  return source
}

export function escapeMarkdownDestination(url: string, syntax?: 'html' | 'bare' | 'wiki'): string {
  return syntax === 'html' ? url.replace(/[\s"'&<>=`|]/g, (char) => `&#${char.charCodeAt(0)};`)
    : url.replace(syntax === 'wiki' ? /[\s<>[\]\\|]/g : /[\s<>()[\]\\]/g, (char) => encodeURIComponent(char).replace('(', '%28').replace(')', '%29'))
}

export function parseLocalMarkdownUrl(url: string): { path: string; fragment: string; suffix: string } | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//') || url.includes('\\')) return null
  const match = url.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/)
  if (!match) return null
  try {
    const path = decodeURIComponent(match[1])
    if (/[\x00-\x1f\\]/.test(path) || /^[a-z]:/i.test(path)) return null
    return { path, fragment: decodeURIComponent((match[3] ?? '').slice(1)), suffix: (match[2] ?? '') + (match[3] ?? '') }
  } catch { return null }
}

/** Paths use the Markdown file's directory, including for documents created in-app. */
export function resolveMarkdownDocumentPath(documentPath: string, url: string): { path: string; fragment: string } | null {
  const local = parseLocalMarkdownUrl(url)
  if (!local) return null
  if (!local.path) return { path: documentPath, fragment: local.fragment }
  if (!/\.md$/i.test(local.path)) return null
  const parts = local.path.startsWith('/') ? [] : documentPath.split('/').slice(0, -1)
  for (const part of local.path.replace(/\.md$/i, '').split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop() }
    else if (part && part !== '.') parts.push(part)
  }
  return parts.length ? { path: parts.join('/'), fragment: local.fragment } : null
}

export function relativeMarkdownPath(fromFile: string, toFile: string): string {
  const from = fromFile.split('/').slice(0, -1)
  const to = toFile.split('/')
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift() }
  return [...from.map(() => '..'), ...to.map((part) => encodeURIComponent(part))].join('/') || './'
}
