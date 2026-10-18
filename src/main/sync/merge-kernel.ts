import { collectMarkdownSourceLinks } from '../../shared/markdownLinks'
import { markdownTableWidthValueRanges } from '../../shared/markdownTableLayoutRanges'
import { parseMarkdownTableNode } from '../../shared/markdownTable'
import { serializeTableColumnWidthsDirective, tableColumnWidths } from '../../shared/markdownTableLayout'
import { canonicalJson } from './model'

const MAX_TEXT_LENGTH = 32_000
const MAX_DIFF_CELLS = 1_000_000
export const MERGE_DIFF_BUDGET_CELLS = 4_000_000
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right)

type TextEdit = { from: number; to: number; insert: string[] }
export type DiffBudget = { cells: number }

/** Preserve destination identity: two edits to one URL must never create a third URL. */
function textTokens(text: string): string[] {
  const ranges = collectMarkdownSourceLinks(text).map(link => ({ from: link.start, to: link.end }))
  ranges.push(...markdownTableWidthValueRanges(text))
  for (const match of text.matchAll(/(?:knowbook-asset:\/\/|file:\/\/\/)[^\s<>()[\]"']+/g)) {
    ranges.push({ from: match.index!, to: match.index! + match[0].length })
  }
  ranges.sort((a, b) => a.from - b.from || b.to - a.to)
  const protectedRanges: typeof ranges = []
  for (const range of ranges) {
    const previous = protectedRanges.at(-1)
    if (previous && range.from < previous.to) previous.to = Math.max(previous.to, range.to)
    else protectedRanges.push({ ...range })
  }
  const result: string[] = []
  let offset = 0
  const appendText = (value: string) => {
    for (const part of segmenter.segment(value)) result.push(part.segment)
  }
  for (const range of protectedRanges) {
    appendText(text.slice(offset, range.from))
    result.push(text.slice(range.from, range.to))
    offset = range.to
  }
  appendText(text.slice(offset))
  return result
}

function editsBetween(base: string[], next: string[], budget: DiffBudget): TextEdit[] | null {
  let start = 0
  while (start < base.length && start < next.length && base[start] === next[start]) start++
  let baseEnd = base.length, nextEnd = next.length
  while (baseEnd > start && nextEnd > start && base[baseEnd - 1] === next[nextEnd - 1]) { baseEnd--; nextEnd-- }
  const left = base.slice(start, baseEnd), right = next.slice(start, nextEnd)
  if (!left.length && !right.length) return []
  if (!left.length || !right.length) {
    const edit = { from: start, to: baseEnd, insert: right }
    // Repeated runs admit multiple equally valid insertion/deletion locations.
    const changed = left.length ? left : right
    if (same(base.slice(Math.max(0, start - changed.length), start), changed)
      || same(base.slice(baseEnd, baseEnd + changed.length), changed)) return null
    return [edit]
  }
  const width = right.length + 1, cells = (left.length + 1) * width
  if (cells > MAX_DIFF_CELLS || cells > budget.cells) return null
  budget.cells -= cells
  const table = new Uint32Array(cells)
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const edits: TextEdit[] = []
  let i = 0, j = 0
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { i++; j++; continue }
    const remaining = table[i * width + j]
    if (!remaining) { edits.push({ from: start + i, to: baseEnd, insert: right.slice(j) }); break }
    let anchor: { i: number; j: number } | undefined
    // Replacement/deletion operation order can tie without making its location
    // ambiguous. Reject only when different first surviving anchors are possible.
    for (let a = i; a < left.length && table[a * width + j] === remaining; a++) {
      for (let b = j; b < right.length && table[a * width + b] === remaining; b++) {
        if (--budget.cells < 0) return null
        if (left[a] !== right[b] || table[(a + 1) * width + b + 1] !== remaining - 1) continue
        if (anchor) return null
        anchor = { i: a, j: b }
      }
    }
    if (!anchor) return null
    edits.push({ from: start + i, to: start + anchor.i, insert: right.slice(j, anchor.j) })
    i = anchor.i + 1; j = anchor.j + 1
  }
  return edits
}

function editOverlap(left: TextEdit, right: TextEdit): boolean {
  if (left.from === left.to) return left.from >= right.from && left.from <= right.to
  if (right.from === right.to) return right.from >= left.from && right.from <= left.to
  return left.from < right.to && right.from < left.to
}

function layoutText(source: string) {
  if (!source.includes('<!-- knowbook:table-widths:v1 ')) return null
  const node = parseMarkdownTableNode(source)
  if (!node) return null
  const headers = node.children.find(child => child.token.type === 'thead_open')?.children[0]?.children
    .map(cell => cell.children[0]?.token.content ?? '') ?? []
  const widths = tableColumnWidths(node.token, headers.length), map = node.token.meta?.tableLayoutMap as [number, number] | undefined
  if (!widths || !map || map[1] !== map[0] + 1) return null
  const lines = source.split('\n'), line = lines.splice(map[0], 1)[0]
  return { headers, widths, line, body: lines.join('\n') }
}

function mergeLayoutText(base: string, local: string, remote: string, budget: DiffBudget): { handled: boolean; result?: string | null } {
  const before = layoutText(base), left = layoutText(local), right = layoutText(remote)
  if (!before || !left || !right) return { handled: false }
  // Column insertion/reordering cannot be matched by array index. Competing
  // structural edits stay explicit rather than attaching a width to a new column.
  if (!same(before.headers, left.headers) || !same(before.headers, right.headers)) return { handled: true, result: null }
  const widths = before.widths.map((width, column) => {
    const a = left.widths[column], b = right.widths[column]
    return same(a, b) ? a : same(width, a) ? b : same(width, b) ? a : undefined
  })
  if (widths.some(width => width === undefined)) return { handled: true, result: null }
  const body = mergeText(before.body, left.body, right.body, budget)
  if (body === null) return { handled: true, result: null }
  const mergedTable = parseMarkdownTableNode(body)
  if (!mergedTable?.token.map) return { handled: true, result: null }
  const line = same(widths, left.widths) ? left.line : same(widths, right.widths) ? right.line
    : (before.line.match(/^[ \t]*/)?.[0] ?? '') + serializeTableColumnWidthsDirective(widths as typeof before.widths)
      + (before.line.endsWith('\r') ? '\r' : '')
  const lines = body.split('\n')
  lines.splice(mergedTable.token.map[0], 0, line)
  return { handled: true, result: lines.join('\n') }
}

export function mergeText(base: string, local: string, remote: string, budget: DiffBudget): string | null {
  if (same(local, remote)) return local
  if (same(base, local)) return remote
  if (same(base, remote)) return local
  if (Math.max(base.length, local.length, remote.length) > MAX_TEXT_LENGTH) return null
  const layout = mergeLayoutText(base, local, remote, budget)
  if (layout.handled) return layout.result ?? null
  const original = textTokens(base)
  const left = editsBetween(original, textTokens(local), budget)
  const right = editsBetween(original, textTokens(remote), budget)
  if (!left || !right) return null
  const edits = [...left]
  for (const next of right) {
    if (left.some(edit => same(edit, next))) continue
    if (left.some(edit => editOverlap(edit, next))) return null
    edits.push(next)
  }
  const result = [...original]
  for (const edit of edits.sort((a, b) => b.from - a.from || b.to - a.to)) {
    result.splice(edit.from, edit.to - edit.from, ...edit.insert)
  }
  return result.join('')
}

export interface MergeTextRange { from: number; to: number }
export type UnchangedMergeRangeProjector = (range: MergeTextRange) => MergeTextRange | null

/** Compute each block once; project ranges mandatory and unique in every optimal alignment. */
export function createUnchangedMergeRangeProjector(source: string, destination: string,
  budget: DiffBudget): UnchangedMergeRangeProjector | null {
  const valid = (range: MergeTextRange): boolean => Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to)
    && range.from >= 0 && range.to > range.from && range.to <= source.length
  if (source === destination) return range => valid(range) ? { from: range.from, to: range.to } : null
  if (Math.max(source.length, destination.length) > MAX_TEXT_LENGTH) return null
  const original = textTokens(source), next = textTokens(destination)
  const width = next.length + 1, cells = (original.length + 1) * width
  if (cells > MAX_DIFF_CELLS || cells > budget.cells) return null
  budget.cells -= cells
  const table = new Uint32Array(cells)
  for (let i = original.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      table[i * width + j] = original[i] === next[j] ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const optimum = table[0], mapped = new Int32Array(original.length)
  mapped.fill(-1)
  let prefix = new Uint32Array(width), following = new Uint32Array(width)
  for (let i = 0; i < original.length; i++) {
    let maySkip = false, destination = -1, multiple = false
    following[0] = 0
    for (let j = 0; j <= next.length; j++) {
      if (--budget.cells < 0) return null
      // Every optimal matching which omits i splits at one such boundary.
      if (prefix[j] + table[(i + 1) * width + j] === optimum) maySkip = true
      if (j === next.length) continue
      // An edge belongs to some optimal matching exactly when optimal prefix,
      // this match, and optimal suffix reach the complete optimum together.
      if (original[i] === next[j] && prefix[j] + 1 + table[(i + 1) * width + j + 1] === optimum) {
        if (destination >= 0) multiple = true
        else destination = j
      }
      following[j + 1] = original[i] === next[j] ? prefix[j] + 1
        : Math.max(prefix[j + 1], following[j])
    }
    if (!maySkip && !multiple && destination >= 0) mapped[i] = destination
    const previous = prefix; prefix = following; following = previous
  }
  const offsets = [0], destinations = [0]
  for (const token of original) offsets.push(offsets.at(-1)! + token.length)
  for (const token of next) destinations.push(destinations.at(-1)! + token.length)
  const runs: Array<{ from: number; to: number; destinationTo: number; shift: number }> = []
  let previousSource = -2, previousDestination = -2
  for (let i = 0; i < original.length; i++) {
    const j = mapped[i]
    if (j < 0) { previousSource = -2; previousDestination = -2; continue }
    const from = offsets[i], to = offsets[i + 1]
    const destinationFrom = destinations[j], destinationTo = destinations[j + 1]
    const previous = runs.at(-1)
    if (previous && previousSource + 1 === i && previousDestination + 1 === j
      && previous.to === from && previous.destinationTo === destinationFrom) {
      previous.to = to; previous.destinationTo = destinationTo
    } else runs.push({ from, to, destinationTo, shift: destinationFrom - from })
    previousSource = i; previousDestination = j
  }
  // Unrelated punctuation may be ambiguous. Only the queried range must lie
  // wholly inside mandatory tokens with one continuous destination footprint.
  if (!runs.length) return null
  return range => {
    if (!valid(range)) return null
    let low = 0, high = runs.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (runs[middle].from <= range.from) low = middle + 1
      else high = middle
    }
    const run = low ? runs[low - 1] : undefined
    if (!run || range.to > run.to) return null
    const result = { from: range.from + run.shift, to: range.to + run.shift }
    return destination.slice(result.from, result.to) === source.slice(range.from, range.to) ? result : null
  }
}

/** Computation only: a unique untouched range is not a source or mutation grant. */
export function projectUnchangedMergeRange(source: string, destination: string, range: MergeTextRange,
  budget: DiffBudget): MergeTextRange | null {
  return createUnchangedMergeRangeProjector(source, destination, budget)?.(range) ?? null
}
