import { parseMarkdownInline } from '@shared/markdownEngine'

export type MarkdownFormat = 'bold' | 'italic' | 'strike' | 'highlight' | 'code' | 'link'
export type FormattedSelection = { content: string; start: number; end: number }

export function formatMarkdownSelection(content: string, start: number, end: number, format: MarkdownFormat, linkLabel = 'Link'): FormattedSelection {
  start = Math.max(0, Math.min(content.length, start))
  end = Math.max(start, Math.min(content.length, end))
  const selection = content.slice(start, end)
  // Whitespace outside the text must stay outside emphasis delimiters.
  if (format !== 'code' && format !== 'link' && selection.trim()) {
    start += selection.length - selection.trimStart().length
    end -= selection.length - selection.trimEnd().length
  }
  const text = content.slice(start, end)
  if (format === 'code' && text.startsWith('`')) {
    const nodes = parseMarkdownInline(text)
    if (nodes.length === 1 && nodes[0].token.type === 'code_inline') {
      const unwrapped = nodes[0].token.content
      return { content: content.slice(0, start) + unwrapped + content.slice(end), start, end: start + unwrapped.length }
    }
  }
  if (format === 'link') {
    const label = text || linkLabel
    const replacement = `[${label}](https://)`
    return { content: content.slice(0, start) + replacement + content.slice(end), start: start + label.length + 3, end: start + replacement.length - 1 }
  }
  let marker = ({ bold: '**', italic: '*', strike: '~~', highlight: '==', code: '`' })[format]
  if (format === 'code') marker = '`'.repeat(Math.max(1, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)))
  const before = content.slice(0, start), after = content.slice(end)
  if (format === 'code' && before.endsWith(marker + ' ') && after.startsWith(' ' + marker)) {
    return { content: before.slice(0, -marker.length - 1) + text + after.slice(marker.length + 1), start: start - marker.length - 1, end: end - marker.length - 1 }
  }
  const canUnwrap = (opening: string, closing: string) => {
    if (format !== 'italic') return true
    return (opening.match(/\*+$/)?.[0].length ?? 0) % 2 === 1 && (closing.match(/^\*+/)?.[0].length ?? 0) % 2 === 1
  }
  // Selection inside an existing pair, or including the complete pair.
  if (before.endsWith(marker) && after.startsWith(marker) && canUnwrap(before, after)) {
    return { content: before.slice(0, -marker.length) + text + after.slice(marker.length), start: start - marker.length, end: end - marker.length }
  }
  if (format !== 'code' && text.length >= marker.length * 2 && text.startsWith(marker) && text.endsWith(marker)
    && (format !== 'italic' || ((text.match(/^\*+/)?.[0].length ?? 0) % 2 === 1 && (text.match(/\*+$/)?.[0].length ?? 0) % 2 === 1))) {
    const unwrapped = text.slice(marker.length, -marker.length)
    return { content: before + unwrapped + after, start, end: start + unwrapped.length }
  }
  const pad = format === 'code' && (text.startsWith('`') || text.endsWith('`') || (/^ .* $/s.test(text) && text.trim())) ? ' ' : ''
  return { content: before + marker + pad + text + pad + marker + after,
    start: start + marker.length + pad.length, end: end + marker.length + pad.length }
}

export function markdownFormatShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): MarkdownFormat | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null
  const key = event.key.toLowerCase()
  if (event.shiftKey) return ({ x: 'strike', h: 'highlight', k: 'link' } as const)[key as 'x'] ?? null
  return ({ b: 'bold', i: 'italic', e: 'code' } as const)[key as 'b'] ?? null
}
