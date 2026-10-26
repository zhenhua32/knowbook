import { escapeMarkdownDestination, parseLocalMarkdownUrl, relativeMarkdownPath } from '../../shared/markdownLinks'
import { parseWikiReference } from '../../shared/markdownWiki'
import { graph3Conflict } from './restore-knowledge-graph3-data'
import { assertMerge3JsonBudget } from './restore-knowledge-merge3-storage'

export type Navigation3FinalTarget = { kind: 'document' | 'block' | 'heading'; documentId: string; documentPath: string;
  blockId?: string; headingKey?: string; slug?: string }
export interface Navigation3TextEdit { from: number; to: number; before: string; after: string }
export interface Navigation3Destination {
  key: { from: number; to: number; raw: string; syntax: 'wiki' | 'markdown' }
  url: string; grammar: { kind: string; syntax: 'html' | 'bare' | 'wiki' | null }
}

/** Only the destination span changes. The caller must prove its original row,
 * target identity and complete parse scope; this formatter grants none of them. */
export function renderNavigation3Destination(link: Navigation3Destination, host: { documentId: string; path: string },
  target: Navigation3FinalTarget): { replacement: string; url: string } | { reason: string } {
  if (link.grammar.kind === 'autolink') return { reason: 'autolink-shape-requires-explicit-rewrite' }
  const fragment = target.kind === 'block' ? target.blockId === undefined ? undefined : '^' + target.blockId
    : target.kind === 'heading' ? target.slug : null
  if (fragment === undefined) return graph3Conflict('navigation-final-target-missing-fragment', target)
  if (link.key.syntax === 'wiki') {
    const reference = parseWikiReference(link.url)
    // Wiki paths are literal, unlike percent-decoded Markdown paths. A spelling
    // containing reserved separators requires a separately proven legacy parse.
    if (/[#|\[\]\r\n]/.test(target.documentPath) || fragment !== null && /[|\[\]\r\n]/.test(fragment))
      return { reason: 'wiki-target-needs-legacy-path-disambiguation' }
    const tail = reference.alias === null ? '' : link.url.slice(link.url.indexOf('|'))
    const path = !reference.path && host.documentId === target.documentId ? '' : target.documentPath
    const url = path + (fragment !== null ? '#' + fragment : reference.hasFragment ? '#' : '') + tail
    return { url, replacement: url === link.url ? link.key.raw : link.key.raw.includes('\\|') ? url.replace(/\|/g, '\\|') : url }
  }
  const original = parseLocalMarkdownUrl(link.url)
  if (!original) return { reason: 'not-a-local-markdown-destination' }
  const path = !original.path && host.documentId === target.documentId ? '' : original.path.startsWith('/')
    ? '/' + target.documentPath.split('/').map(encodeURIComponent).join('/') + '.md'
    : relativeMarkdownPath(host.path + '.md', target.documentPath + '.md')
  const query = original.suffix.split('#', 1)[0]
  const suffix = fragment !== null ? '#' + (fragment.startsWith('^') ? '^' + encodeURIComponent(fragment.slice(1)) : encodeURIComponent(fragment))
    : original.suffix.includes('#') ? '#' : ''
  const url = path + query + suffix
  return { url, replacement: url === link.url ? link.key.raw : escapeMarkdownDestination(url, link.grammar.syntax ?? undefined) }
}

/** Ranges use original UTF-16 positions, including CRLF. Sorting, complete raw
 * comparisons and overlap rejection happen before any string is changed. */
export function applyNavigation3TextEdits(original: string, input: readonly Navigation3TextEdit[]): string {
  assertMerge3JsonBudget({ original, edits: input })
  const edits = [...input].sort((a, b) => a.from - b.from || a.to - b.to)
  let end = 0, finalLength = original.length
  for (const edit of edits) {
    if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to) || edit.from < end || edit.to <= edit.from
      || edit.to > original.length || original.slice(edit.from, edit.to) !== edit.before)
      return graph3Conflict('navigation-edit-original-range', edit)
    end = edit.to; finalLength += edit.after.length - (edit.to - edit.from)
    if (!Number.isSafeInteger(finalLength)) return graph3Conflict('navigation-edit-text-budget', null)
  }
  // Check the finite output before concatenation; target encoding and the
  // complete twelve-table aggregate are checked again by the model.
  if (finalLength > 64 * 1024 * 1024) return graph3Conflict('navigation-edit-text-budget', null)
  const pieces: string[] = []; let offset = 0
  for (const edit of edits) { pieces.push(original.slice(offset, edit.from), edit.after); offset = edit.to }
  pieces.push(original.slice(offset))
  return pieces.join('')
}

/** Project an entire old destination/definition range through declared edits.
 * A partially overlapping edit has no valid source-range proof. */
export function projectNavigation3Range(from: number, to: number, edits: readonly Navigation3TextEdit[]) {
  return createNavigation3RangeProjection(edits)(from, to)
}

/** One local prefix index per cell keeps every later range projection O(log n).
 * This contains only this call's edits, never saved SQL/provenance state. */
export function createNavigation3RangeProjection(input: readonly Navigation3TextEdit[]) {
  const edits = [...input].sort((a, b) => a.from - b.from || a.to - b.to), prefix = [0]
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]
    if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to) || edit.from < 0 || edit.to <= edit.from
      || i > 0 && edit.from < edits[i - 1].to) return graph3Conflict('navigation-projection-overlapping-edits', null)
    prefix.push(prefix[i] + edit.after.length - (edit.to - edit.from))
  }
  const countEndingAt = (position: number) => {
    let low = 0, high = edits.length
    while (low < high) { const middle = (low + high) >>> 1; if (edits[middle].to <= position) low = middle + 1; else high = middle }
    return low
  }
  return (from: number, to: number) => {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) return null
    const before = countEndingAt(from), through = countEndingAt(to)
    if (edits[before] && edits[before].from < from || edits[through] && edits[through].from < to) return null
    return { from: from + prefix[before], to: to + prefix[through] }
  }
}
