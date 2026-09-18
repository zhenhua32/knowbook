import { markdownEngine, type MarkdownEnvironment, type MarkdownToken } from './markdownEngine'

export type MarkdownDestination = { start: number; end: number; url: string; kind: 'link' | 'image' | 'definition' }

/** Locate source destinations without rewriting labels, titles, code or other Markdown. */
export function collectMarkdownDestinations(source: string): MarkdownDestination[] {
  if (!source.includes('[')) return []
  const header = source.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  const headerEnd = header && /^[A-Za-z][\w-]*:/m.test(header[1]) ? header[0].length : 0
  const env: MarkdownEnvironment = { captureFootnoteSource: true }
  // Metadata values are not Markdown content. Keep line offsets while masking
  // the header so links/definitions in YAML cannot affect body rewriting.
  const renderedTokens = markdownEngine.parse(source.slice(0, headerEnd).replace(/[^\r\n]/g, ' ') + source.slice(headerEnd), env)
  const tokens = [...renderedTokens, ...(env.footnoteSourceTokens as MarkdownToken[] | undefined ?? [])]
  const allowed = new Set<string>()
  const visit = (items: MarkdownToken[]) => {
    for (const token of items) {
      const url = token.attrGet(token.type === 'image' ? 'src' : 'href')
      if (url) allowed.add(String(url))
      if (token.children) visit(token.children)
    }
  }
  visit(tokens)
  const lines = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lines.push(i + 1)
  lines.push(source.length)
  const excluded = tokens.filter((token) => ['fence', 'code_block', 'math_block', 'knowbook_metadata'].includes(token.type) && token.map)
    .map((token) => [lines[token.map![0]], lines[token.map![1]]] as const)
    .concat(headerEnd ? [[0, headerEnd] as const] : [])
    .sort((left, right) => left[0] - right[0])
  let excludedIndex = 0
  const inlineRanges = tokens.filter((token) => ['inline', 'tr_open'].includes(token.type) && token.map)
    .map((token) => [lines[token.map![0]], lines[token.map![1]]] as const)
  const tailEnds = new Map<number, number>()
  const state = new markdownEngine.inline.State(source, markdownEngine, env, [])
  const destinations: MarkdownDestination[] = []
  const whitespace = (position: number) => { while (/[ \t\r\n]/.test(source[position] ?? '') && position < source.length) position++; return position }
  for (let i = 0; i < source.length; i++) {
    while (excludedIndex < excluded.length && excluded[excludedIndex][1] <= i) excludedIndex++
    const skip = excluded[excludedIndex]
    if (skip && i >= skip[0]) { i = skip[1] - 1; continue }
    if (tailEnds.has(i)) { i = tailEnds.get(i)! - 1; continue }
    if (source[i] === '\\') { i++; continue }
    if (source[i] === '`') {
      const run = source.slice(i).match(/^`+/)![0]
      const inlineEnd = inlineRanges.find(([start, end]) => i >= start && i < end)?.[1] ?? source.length
      let end = source.indexOf(run, i + run.length)
      while (end >= 0 && (source[end - 1] === '`' || source[end + run.length] === '`')) end = source.indexOf(run, end + run.length)
      if (end >= 0 && end < inlineEnd) i = end + run.length - 1
      else i += run.length - 1
      continue
    }
    if (source[i] !== '[') continue
    const labelEnd = markdownEngine.helpers.parseLinkLabel(state, i, false)
    if (labelEnd < 0) continue
    const delimiter = source[labelEnd + 1]
    const definition = delimiter === ':' && /^(?:[ \t\r]|>|[-+*]|\d+[.)])*$/.test(source.slice(source.lastIndexOf('\n', i - 1) + 1, i))
    if (delimiter !== '(' && !definition) continue
    const start = whitespace(labelEnd + 2)
    const result = markdownEngine.helpers.parseLinkDestination(source, start, source.length)
    if (!result.ok) continue
    const url = markdownEngine.normalizeLink(result.str)
    if (!markdownEngine.validateLink(url) || (!definition && !allowed.has(url))) continue
    if (definition && env.references?.[markdownEngine.utils.normalizeReference(source.slice(i + 1, labelEnd))]?.href !== url) continue
    if (!definition) {
      let end = whitespace(result.pos)
      if (end > result.pos && source[end] !== ')') {
        const title = markdownEngine.helpers.parseLinkTitle(source, end, source.length)
        if (!title.ok) continue
        end = whitespace(title.pos)
      }
      if (source[end] !== ')') continue
      tailEnds.set(labelEnd + 1, end + 1)
    }
    const angled = source[start] === '<'
    destinations.push({ start: start + (angled ? 1 : 0), end: result.pos - (angled ? 1 : 0), url,
      kind: definition ? 'definition' : source[i - 1] === '!' ? 'image' : 'link' })
    // Keep scanning the label: a linked image has two independent destinations.
  }
  return destinations.sort((a, b) => a.start - b.start).filter((entry, index, all) => index === 0 || entry.start !== all[index - 1].start)
}

export function rewriteMarkdownDestinations(source: string, rewrite: (destination: MarkdownDestination) => string | null | undefined): string {
  const edits = collectMarkdownDestinations(source).map((destination) => ({ ...destination, replacement: rewrite(destination) }))
  for (const edit of edits.reverse()) {
    if (edit.replacement == null || edit.replacement === edit.url) continue
    const escaped = edit.replacement.replace(/[\s<>()[\]\\]/g, (char) => encodeURIComponent(char).replace('(', '%28').replace(')', '%29'))
    source = source.slice(0, edit.start) + escaped + source.slice(edit.end)
  }
  return source
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
