import { serializeMarkdownWithBlockRangesCore, type MarkdownEmissionEvent, type MarkdownRenderableBlock,
  type MarkdownSerializationCoreResult } from './markdown'

export interface MarkdownEmissionCell {
  /** An original raw UTF-16 unit, or a complete CRLF pair. */
  readonly from: number
  readonly to: number
  readonly sourceFrom: number | null
  readonly sourceTo: number | null
}
export interface MarkdownEmissionContentTrace {
  readonly index: number
  readonly kind: 'exact' | 'unproven'
  readonly reason?: string
  /** Original canonical content, before optional LF normalization. */
  readonly content: string
  /** Exact output from this one actual serializer invocation. */
  readonly source: string
  readonly sourceFrom: number
  readonly sourceTo: number
  readonly cells: readonly MarkdownEmissionCell[]
  readonly boundaries: readonly (readonly number[])[]
}
export interface MarkdownEmissionTraceOptions {
  /** Source openings use LF. false observes the ordinary serializer bytes. */
  normalizeLineEndings?: boolean
  fallbackCodeLanguage?: string
  includeBlockMetadata?: boolean
}
export interface MarkdownEmissionTracedResult extends MarkdownSerializationCoreResult {
  readonly contentTraces: readonly MarkdownEmissionContentTrace[]
}
type Range = { from: number; to: number }
type Unit = { from: number; to: number; normalizedFrom: number; normalizedTo: number }
const unique = (values: readonly number[]) => [...new Set(values)]
function units(content: string, normalize: boolean): Unit[] {
  const result: Unit[] = []
  let normalizedAt = 0
  for (let from = 0; from < content.length;) {
    const to = content[from] === '\r' && content[from + 1] === '\n' ? from + 2 : from + 1
    const width = normalize && content[from] === '\r' ? 1 : to - from
    result.push({ from, to, normalizedFrom: normalizedAt, normalizedTo: normalizedAt + width })
    normalizedAt += width; from = to
  }
  return result
}
function segmentPoints(event: MarkdownEmissionEvent, point: number): number[] {
  let low = 0, high = event.segments.length
  while (low < high) {
    const middle = (low + high) >>> 1, segment = event.segments[middle]
    if (segment.to < point) low = middle + 1
    else high = middle
  }
  const candidates: number[] = []
  for (let index = low; index < event.segments.length && event.segments[index].from <= point; index++) {
    const segment = event.segments[index]
    candidates.push(segment.sourceFrom + point - segment.from)
  }
  return unique(candidates)
}
function segmentRange(event: MarkdownEmissionEvent, from: number, to: number): Range | null {
  if (from === to) {
    const points = segmentPoints(event, from)
    return points.length === 1 ? { from: points[0], to: points[0] } : null
  }
  let low = 0, high = event.segments.length
  while (low < high) {
    const middle = (low + high) >>> 1, segment = event.segments[middle]
    if (segment.to <= from) low = middle + 1
    else high = middle
  }
  let at = from, start: number | undefined, end: number | undefined
  for (let index = low; index < event.segments.length; index++) {
    const segment = event.segments[index]
    if (segment.from >= to) break
    if (segment.to <= at) continue
    if (segment.from > at) return null
    const first = segment.sourceFrom + at - segment.from, last = segment.sourceFrom + Math.min(to, segment.to) - segment.from
    if (end !== undefined && end !== first) return null
    start ??= first; end = last; at = Math.min(to, segment.to)
    if (at === to) return { from: start, to: end }
  }
  return null
}
function buildTrace(index: number, content: string, normalized: string, source: string, event: MarkdownEmissionEvent | undefined,
  normalize: boolean): MarkdownEmissionContentTrace {
  const cells: MarkdownEmissionCell[] = [], boundaries = Array.from({ length: content.length + 1 }, () => [] as number[])
  let reason = event?.reason ?? (!event ? 'missing-emission' : undefined)
  const encoded = event?.projection?.source ?? normalized
  if (event && (event.index !== index || event.content !== normalized || event.projection && event.projection.content !== normalized
    || !Number.isSafeInteger(event.from) || !Number.isSafeInteger(event.to) || event.from < 0 || event.to < event.from || event.to > source.length)) reason = 'emission-input-mismatch'
  if (event && !reason) for (const segment of event.segments) {
    if (!Number.isSafeInteger(segment.from) || !Number.isSafeInteger(segment.to) || segment.from < 0 || segment.to < segment.from || segment.to > encoded.length
      || !Number.isSafeInteger(segment.sourceFrom) || !Number.isSafeInteger(segment.sourceTo) || segment.sourceFrom < event.from || segment.sourceTo > event.to
      || segment.sourceTo - segment.sourceFrom !== segment.to - segment.from
      || encoded.slice(segment.from, segment.to) !== source.slice(segment.sourceFrom, segment.sourceTo)) { reason = 'emission-segment-mismatch'; break }
  }
  const originalUnits = units(content, normalize), atoms = new Map(event?.atomicEdits?.map(edit => [edit.from, edit]))
  for (let index = 0; index < originalUnits.length; index++) {
    const first = originalUnits[index], atom = atoms.get(first.normalizedFrom)
    let unit = first
    if (atom) {
      while (originalUnits[index].normalizedTo < atom.to && index + 1 < originalUnits.length) index++
      const last = originalUnits[index]
      if (last.normalizedTo !== atom.to) reason = 'atomic-edit-boundary'
      unit = { ...first, to: last.to, normalizedTo: last.normalizedTo }
    }
    const from = atom?.sourceFrom ?? event?.projection?.starts?.[unit.normalizedFrom] ?? unit.normalizedFrom
    const to = atom?.sourceTo ?? event?.projection?.ends?.[unit.normalizedTo - 1] ?? unit.normalizedTo
    const span = event && !reason ? segmentRange(event, from, to) : null
    cells.push(Object.freeze({ from: unit.from, to: unit.to, sourceFrom: span?.from ?? null, sourceTo: span?.to ?? null }))
    if (span) { boundaries[unit.from].push(span.from); boundaries[unit.to].push(span.to) }
  }
  if (event && !reason) {
    // An empty continuation payload can add a second actual source point at
    // the same content boundary. Keep every candidate instead of treating an
    // ambiguous point as absent and leaving a cell endpoint falsely unique.
    boundaries[0].push(...segmentPoints(event, 0))
    boundaries[content.length].push(...segmentPoints(event, encoded.length))
    if (cells.some(cell => cell.sourceFrom === null || cell.sourceTo === null)) reason = 'unmapped-content'
  }
  if (reason) for (const points of boundaries) points.length = 0
  return Object.freeze({ index, kind: reason ? 'unproven' : 'exact', ...(reason ? { reason } : {}), content, source,
    sourceFrom: event?.from ?? 0, sourceTo: event?.to ?? 0, cells: Object.freeze(cells),
    boundaries: Object.freeze(boundaries.map(points => Object.freeze(unique(points)))) })
}

/** Cold Source opening only. Original block identity/bytes never pass through
 * parser reconstruction; the same serializer reports its actual append facts. */
export function serializeMarkdownWithEmissionTrace(blocks: readonly MarkdownRenderableBlock[],
  options: MarkdownEmissionTraceOptions = {}): MarkdownEmissionTracedResult {
  const original = blocks.map(block => ({ ...block })), normalize = options.normalizeLineEndings !== false
  const rendering = original.map(block => ({ ...block, content: normalize ? block.content.replace(/\r\n?/g, '\n') : block.content }))
  const events = new Map<number, MarkdownEmissionEvent>()
  const { normalizeLineEndings: _normalize, ...serialization } = options
  const result = serializeMarkdownWithBlockRangesCore(rendering, serialization, undefined, { emit(event) {
    if (events.has(event.index)) throw new Error('同一块出现重复的实际源码发射。')
    events.set(event.index, event)
  } })
  const contentTraces = original.map((block, index) => buildTrace(index, block.content, rendering[index].content, result.markdown, events.get(index), normalize))
  return { ...result, contentTraces: Object.freeze(contentTraces) }
}

function valid(length: number, from: number, to: number): boolean {
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to >= from && to <= length
}
type Reverse = { starts: Map<number, number[]>; ends: Map<number, number[]>; points: Map<number, number[]> }
const reverses = new WeakMap<MarkdownEmissionContentTrace, Reverse>()
function reverse(trace: MarkdownEmissionContentTrace): Reverse {
  let result = reverses.get(trace)
  if (result) return result
  result = { starts: new Map(), ends: new Map(), points: new Map() }
  const add = (map: Map<number, number[]>, point: number, original: number) => { const values = map.get(point) ?? []; values.push(original); map.set(point, values) }
  for (const cell of trace.cells) {
    if (cell.sourceFrom !== null) add(result.starts, cell.sourceFrom, cell.from)
    if (cell.sourceTo !== null) add(result.ends, cell.sourceTo, cell.to)
  }
  trace.boundaries.forEach((points, original) => { if (points.length === 1) add(result!.points, points[0], original) })
  reverses.set(trace, result); return result
}
/** Original canonical raw range -> absolute opening source range. Shells,
 * gaps, partial CRLF/entities and ambiguous insertion points return null. */
export function projectMarkdownEmissionContentRange(trace: MarkdownEmissionContentTrace, from: number, to: number): Range | null {
  if (trace.kind !== 'exact' || !valid(trace.content.length, from, to)) return null
  if (from === to) {
    const points = trace.boundaries[from]
    return points.length === 1 && reverse(trace).points.get(points[0])?.length === 1 ? { from: points[0], to: points[0] } : null
  }
  let at = from, start: number | undefined, end: number | undefined
  let low = 0, high = trace.cells.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (trace.cells[middle].to <= from) low = middle + 1
    else high = middle
  }
  for (let index = low; index < trace.cells.length; index++) {
    const cell = trace.cells[index]
    if (cell.from !== at || cell.to > to || cell.sourceFrom === null || cell.sourceTo === null || end !== undefined && end !== cell.sourceFrom) return null
    start ??= cell.sourceFrom; end = cell.sourceTo; at = cell.to
    if (at === to) return { from: start, to: end }
  }
  return null
}
export function projectMarkdownEmissionSourceRange(trace: MarkdownEmissionContentTrace, from: number, to: number): Range | null {
  if (trace.kind !== 'exact' || !valid(trace.source.length, from, to)) return null
  const lookup = reverse(trace)
  if (from === to) {
    const originals = lookup.points.get(from)
    return originals?.length === 1 ? { from: originals[0], to: originals[0] } : null
  }
  const starts = lookup.starts.get(from), ends = lookup.ends.get(to)
  if (starts?.length !== 1 || ends?.length !== 1 || starts[0] >= ends[0]) return null
  const span = projectMarkdownEmissionContentRange(trace, starts[0], ends[0])
  return span?.from === from && span.to === to ? { from: starts[0], to: ends[0] } : null
}
