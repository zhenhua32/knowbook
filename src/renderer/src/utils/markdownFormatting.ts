import { markdownEngine, parseMarkdownInline, type MarkdownEnvironment } from '@shared/markdownEngine'
import { capturedMarkdownInlineRanges } from '@shared/markdownSourceLinks'
import type { MarkdownSourceChange } from './markdownSourceDraft'
import { extractMarkdownFrontmatter } from '@shared/markdownFrontmatter'

export type MarkdownFormat = 'bold' | 'italic' | 'strike' | 'highlight' | 'code' | 'link'
export type FormattedSelection = { content: string; start: number; end: number }
type InlineFormat = { change: MarkdownSourceChange; start: number; end: number }

function applyChanges(content: string, changes: MarkdownSourceChange[]): string {
  const parts: string[] = []
  let cursor = 0
  for (let index = changes.length - 1; index >= 0; index--) {
    const change = changes[index]
    parts.push(content.slice(cursor, change.from), change.insert)
    cursor = change.to
  }
  parts.push(content.slice(cursor))
  return parts.join('')
}

export function formatMarkdownSelection(content: string, start: number, end: number, format: MarkdownFormat, linkLabel = 'Link', onChange?: (change: MarkdownSourceChange) => void): FormattedSelection {
  start = Math.max(0, Math.min(content.length, start))
  end = Math.max(start, Math.min(content.length, end))
  if (end <= (extractMarkdownFrontmatter(content)?.end ?? -1)) return { content, start, end }
  if (!/[\r\n]/.test(content.slice(start, end))) {
    const result = formatInlineSelection(content, start, end, format, linkLabel)
    if (content.slice(result.change.from, result.change.to) !== result.change.insert) onChange?.(result.change)
    return { content: applyChanges(content, [result.change]), start: result.start, end: result.end }
  }
  const env: MarkdownEnvironment = { captureSourceLinks: true, captureInlineRanges: true }
  markdownEngine.parse(content, env)
  const offsets: number[] = []
  for (let index = 0; index < content.length; index++) {
    offsets.push(index)
    if (content[index] === '\r' && content[index + 1] === '\n') index++
  }
  offsets.push(content.length)
  const ranges = capturedMarkdownInlineRanges(env).map((range) => ({ start: Math.max(start, offsets[range.start]), end: Math.min(end, offsets[range.end]) }))
    .filter((range) => range.start < range.end && content.slice(range.start, range.end).trim())
    .sort((a, b) => a.start - b.start)
  if (!ranges.length) return { content, start, end }
  // Mixed selections gain the style everywhere; a fully styled selection
  // removes it everywhere. Block syntax and literal code/math stay untouched.
  const formatted = ranges.map((range) => formatInlineSelection(content, range.start, range.end, format, linkLabel))
  const remove = formatted.map(({ change }) => change.insert.length < change.to - change.from)
  const removeAll = remove.every(Boolean)
  const changes: MarkdownSourceChange[] = []
  let selectionEnd = end, selectionStart = start
  for (let index = ranges.length - 1; index >= 0; index--) {
    const range = ranges[index]
    const result = removeAll || !remove[index] ? formatted[index] : null
    const delta = result ? result.change.insert.length - (result.change.to - result.change.from) : 0
    if (result && content.slice(result.change.from, result.change.to) !== result.change.insert) {
      changes.push(result.change)
      onChange?.(result.change)
    }
    selectionEnd = index === ranges.length - 1 ? Math.max(result?.end ?? range.end, range.end + delta) : selectionEnd + delta
    selectionStart = Math.min(range.start, result?.start ?? range.start)
    // Separate paragraphs need separate links. Select the first destination.
    if (format === 'link' && index === 0 && result) { selectionStart = result.start; selectionEnd = result.end }
  }
  return { content: applyChanges(content, changes), start: selectionStart, end: selectionEnd }
}

function formatInlineSelection(content: string, start: number, end: number, format: MarkdownFormat, linkLabel: string): InlineFormat {
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
      const width = nodes[0].token.markup.length
      const raw = text.slice(width, -width)
      // Rendered code normalizes newlines to spaces; toggling must retain the
      // original source and remove only the optional boundary padding.
      const unwrapped = /^ .* $/s.test(raw) && raw.trim() ? raw.slice(1, -1) : raw
      return { change: { from: start, to: end, insert: unwrapped }, start, end: start + unwrapped.length }
    }
  }
  if (format === 'link') {
    const label = text || linkLabel
    const replacement = `[${label}](https://)`
    return { change: { from: start, to: end, insert: replacement }, start: start + label.length + 3, end: start + replacement.length - 1 }
  }
  let marker = ({ bold: '**', italic: '*', strike: '~~', highlight: '==', code: '`' })[format]
  if (format === 'code') marker = '`'.repeat(Math.max(1, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)))
  // Only adjacent marker runs are relevant. Inspecting or rebuilding the
  // entire prefix/suffix once per paragraph makes whole-document formatting quadratic.
  let beforeStart = Math.max(0, start - marker.length - 1), afterEnd = Math.min(content.length, end + marker.length + 1)
  if (format === 'italic') {
    while (beforeStart > 0 && content[beforeStart - 1] === '*') beforeStart--
    while (afterEnd < content.length && content[afterEnd] === '*') afterEnd++
  }
  const before = content.slice(beforeStart, start), after = content.slice(end, afterEnd)
  if (format === 'code' && before.endsWith(marker + ' ') && after.startsWith(' ' + marker)) {
    return { change: { from: start - marker.length - 1, to: end + marker.length + 1, insert: text }, start: start - marker.length - 1, end: end - marker.length - 1 }
  }
  const canUnwrap = (opening: string, closing: string) => {
    if (format !== 'italic') return true
    return (opening.match(/\*+$/)?.[0].length ?? 0) % 2 === 1 && (closing.match(/^\*+/)?.[0].length ?? 0) % 2 === 1
  }
  // Selection inside an existing pair, or including the complete pair.
  if (before.endsWith(marker) && after.startsWith(marker) && canUnwrap(before, after)) {
    return { change: { from: start - marker.length, to: end + marker.length, insert: text }, start: start - marker.length, end: end - marker.length }
  }
  if (format !== 'code' && text.length >= marker.length * 2 && text.startsWith(marker) && text.endsWith(marker)
    && (format !== 'italic' || ((text.match(/^\*+/)?.[0].length ?? 0) % 2 === 1 && (text.match(/\*+$/)?.[0].length ?? 0) % 2 === 1))) {
    const unwrapped = text.slice(marker.length, -marker.length)
    return { change: { from: start, to: end, insert: unwrapped }, start, end: start + unwrapped.length }
  }
  const pad = format === 'code' && (text.startsWith('`') || text.endsWith('`') || (/^ .* $/s.test(text) && text.trim())) ? ' ' : ''
  return { change: { from: start, to: end, insert: marker + pad + text + pad + marker },
    start: start + marker.length + pad.length, end: end + marker.length + pad.length }
}

export function markdownFormatShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): MarkdownFormat | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null
  const key = event.key.toLowerCase()
  if (event.shiftKey) return ({ x: 'strike', h: 'highlight', k: 'link' } as const)[key as 'x'] ?? null
  return ({ b: 'bold', i: 'italic', e: 'code' } as const)[key as 'b'] ?? null
}
