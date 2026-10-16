import { createHash } from 'node:crypto'
import type { SyncedBindingKey, SyncedStableBlockDraft, SyncedStructureInput } from '../../shared/synced-blocks'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { serializeMarkdownHostSource } from '../../shared/markdownSource'
import { projectedMarkdownContentPosition } from '../../shared/markdownNativeText'
import { collectMarkdownSourceLinks } from '../../shared/markdownLinks'
import { markdownEngine, type MarkdownEnvironment, type MarkdownToken } from '../../shared/markdownEngine'
import { SyncedValidationError, validateSyncedHostForest } from '../../shared/syncedBlockValidation'

export type HostCreateInput = Extract<SyncedStructureInput, { mode: 'command' }> & { action: Extract<Extract<SyncedStructureInput, { mode: 'command' }>['action'], { kind: 'create' }> }
export type CreateContent = HostCreateInput['hostsWorkingBefore'][number]['workingBefore']
export interface CreateAuxiliary { id: string; createdAt: string; role: 'group-definition' | 'host-survivor-definition'; sourceBlockId: string; from: number; to: number; kind: 'reference' | 'note'; label: string }
export interface CreateProjection { blockId: string; sourceBlockId: string; from: number; to: number }
export interface CreateShape { selectedIds: string[]; canonical: SyncedStableBlockDraft[]; after: CreateContent; auxiliary: CreateAuxiliary[]; canonicalProjection: CreateProjection[]; hostProjection: CreateProjection[] }
export interface CreatePhysicalLink { key: SyncedBindingKey; url: string; image: boolean }
interface Definition { blockId: string; from: number; to: number; kind: 'reference' | 'note'; label: string }
interface Unit { blockId: string; from: number; to: number; semantic: unknown }
interface Facts { links: CreatePhysicalLink[]; definitions: Definition[]; effective: Map<string, Definition>; uses: Map<string, Set<string>>; units: Unit[] }
function unitIndex(units: readonly Unit[]): Map<string, { units: Unit[]; ends: number[] }> {
  const index = new Map<string, { units: Unit[]; ends: number[] }>()
  for (const unit of units) { const item = index.get(unit.blockId) ?? { units: [], ends: [] }; item.units.push(unit); index.set(unit.blockId, item) }
  for (const item of index.values()) { item.units.sort((a, b) => a.from - b.from || a.to - b.to); for (const unit of item.units) item.ends.push(Math.max(item.ends[item.ends.length - 1] ?? -1, unit.to)) }
  return index
}
function unitsIn(index: ReturnType<typeof unitIndex>, blockId: string, from: number, to: number): Unit[] {
  const item = index.get(blockId); if (!item) return []
  let low = 0, high = item.ends.length
  while (low < high) { const middle = (low + high) >>> 1; if (item.ends[middle] <= from) low = middle + 1; else high = middle }
  const result: Unit[] = []
  for (let i = low; i < item.units.length && item.units[i].from < to; i++) if (item.units[i].to > from) result.push(item.units[i])
  return result
}
const encode = canonicalSyncedPortableJson
const definitionKey = (kind: Definition['kind'], label: string) => kind + ':' + label
const physical = (value: Pick<Definition, 'blockId' | 'from' | 'to'>) => encode({ blockId: value.blockId, from: value.from, to: value.to })
export class UnsupportedSyncedHostCreate extends Error { constructor(readonly reason: 'create-selection' | 'semantic-binding' | 'heading-rewrite') { super('Create cannot prove the complete original parse scope') } }
function unsupported(): never { throw new UnsupportedSyncedHostCreate('semantic-binding') }
function invalid(message: string): never { throw new SyncedValidationError('forest', message) }
export function isHostCreateInput(input: SyncedStructureInput): input is HostCreateInput { return input.mode === 'command' && input.action.kind === 'create' }

/** Strict host source keeps old reference leaves opaque. Every destination is
 * projected back to original raw content, including CRLF and native prefixes. */
export function captureSyncedCreateSourceFacts(blocks: readonly SyncedStableBlockDraft[]): Facts {
  const source = serializeMarkdownHostSource(blocks), lines = source.markdown.split('\n'), offsets = [0]
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1)
  const lineOwner = new Array<number>(lines.length).fill(-1)
  for (const range of source.ranges) for (let line = range.startLine; line < range.endLine; line++) {
    if (lineOwner[line] !== -1) unsupported(); lineOwner[line] = range.index
  }
  const normalized = blocks.map(block => ({ ...block, content: block.content.replace(/\r\n?/g, '\n') }))
  const rawOffsets = blocks.map(block => { const result: number[] = []; for (let i = 0; i < block.content.length; i++) { result.push(i); if (block.content[i] === '\r' && block.content[i + 1] === '\n') i++ } result.push(block.content.length); return result })
  function local(position: number, end = false): { index: number; offset: number } {
    if (!Number.isSafeInteger(position) || position < 0 || position > source.markdown.length) return unsupported()
    let lo = 0, hi = offsets.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (offsets[mid] <= position) lo = mid + 1; else hi = mid }
    let line = lo - 1
    if (end && position === offsets[line] && line > 0) line--
    const index = lineOwner[line]
    if (index === undefined || index < 0) return unsupported()
    const value = projectedMarkdownContentPosition(normalized[index], source.ranges[index], source.markdown, lines, offsets, position, undefined, end)
    if (value === null || rawOffsets[index][value] === undefined) return unsupported()
    return { index, offset: rawOffsets[index][value] }
  }
  const links: CreatePhysicalLink[] = []
  for (const link of collectMarkdownSourceLinks(source.markdown)) {
    const from = local(link.start), to = local(link.end, true)
    if (from.index !== to.index || blocks[from.index].type === 'synced-block') return unsupported()
    const block = blocks[from.index]
    links.push({ key: { blockId: block.id, from: from.offset, to: to.offset, raw: block.content.slice(from.offset, to.offset), syntax: link.kind === 'wiki' ? 'wiki' : 'markdown' }, url: link.url, image: link.kind === 'image' })
  }
  const env: MarkdownEnvironment = { captureSourceLinks: true }, state = new markdownEngine.core.State(source.markdown, markdownEngine, env)
  for (const rule of markdownEngine.core.ruler.__rules__) { if (rule.name === 'footnote_tail') break; if (rule.enabled && rule.name !== 'strip_references') rule.fn(state) }
  if (state.src !== source.markdown.replace(/\0/g, '\uFFFD')) return unsupported()
  const definitions: Definition[] = [], effective = new Map<string, Definition>(), tokens = state.tokens
  const prior = new Array<number>(tokens.length), next = new Array<number>(tokens.length)
  for (let i = 0, line = 0; i < tokens.length; i++) { prior[i] = line; if (tokens[i].map) line = tokens[i].map![1] }
  for (let i = tokens.length - 1, line = lines.length - 1; i >= 0; i--) { next[i] = line; if (tokens[i].map) line = tokens[i].map![0] }
  function definition(kind: Definition['kind'], label: string, first: number, last: number): Definition {
    const from = local(offsets[first]), to = local(offsets[last - 1] + lines[last - 1].length, true)
    const block = blocks[from.index]
    if (from.index !== to.index || block.type !== 'paragraph' || block.depth !== 0 || block.parentBlockId !== null || to.offset <= from.offset) return unsupported()
    // A definition must be a genuine physical paragraph span, not a native title.
    const emitted = lines.slice(source.ranges[from.index].startLine, source.ranges[from.index].endLine).join('\n').replace(/\n+$/, '')
    if (emitted !== normalized[from.index].content.replace(/\n+$/, '')) return unsupported()
    return { kind, label, blockId: block.id, from: from.offset, to: to.offset }
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === 'reference_definition') {
      if (!token.map || typeof token.meta?.label !== 'string') return unsupported()
      const item = definition('reference', token.meta.label, token.map[0], token.map[1]); definitions.push(item)
      const key = definitionKey(item.kind, item.label); if (!effective.has(key)) effective.set(key, item)
    }
    if (token.type !== 'footnote_reference_open') continue
    const label = token.meta?.label; if (typeof label !== 'string') return unsupported()
    let close = i + 1
    while (close < tokens.length && tokens[close].type !== 'footnote_reference_close') close++
    if (close === tokens.length) return unsupported()
    const maps = tokens.slice(i + 1, close).flatMap(item => item.map ? [item.map] : [])
    let firstBody = next[close], last = -1
    for (const map of maps) { firstBody = Math.min(firstBody, map[0]); last = Math.max(last, map[1] - 1) }
    const headers: number[] = []
    for (let line = prior[i]; line <= firstBody && line < lines.length; line++) if (/^\[\^([^\]\x20\n]+)\]:/.exec(lines[line])?.[1] === label) headers.push(line)
    if (headers.length !== 1) return unsupported()
    if (last < 0) last = headers[0]
    while (last > headers[0] && !lines[last].trim()) last--
    const item = definition('note', label, headers[0], last + 1); definitions.push(item); effective.set(definitionKey('note', label), item)
  }
  if (Object.keys(env.references ?? {}).length !== [...effective.values()].filter(item => item.kind === 'reference').length) return unsupported()
  const footnotes = env.footnotes as { refs?: Record<string, number>; list?: Array<{ content?: string; tokens?: MarkdownToken[] }> } | undefined
  const noteNames = Object.keys(footnotes?.refs ?? {})
  if (noteNames.length !== [...effective.values()].filter(item => item.kind === 'note').length || noteNames.some(name => !name.startsWith(':') || !effective.has(definitionKey('note', name.slice(1))))) return unsupported()
  const uses = new Map(blocks.map(block => [block.id, new Set<string>()])), units: Unit[] = []
  function semantic(token: MarkdownToken, owner: string, active = new Set<MarkdownToken>()): unknown {
    if (active.has(token)) return unsupported(); active.add(token)
    const label = typeof token.meta?.label === 'string' ? token.meta.label : null
    if (label !== null && (token.type === 'link_open' || token.type === 'image')) uses.get(owner)!.add(definitionKey('reference', label))
    if (label !== null && token.type === 'footnote_ref') uses.get(owner)!.add(definitionKey('note', label))
    const id = token.meta?.id, inline = token.type === 'footnote_ref' && label === null && typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? footnotes?.list?.[id] : undefined
    if (token.type === 'footnote_ref' && label === null && (!inline || typeof inline.content !== 'string')) return unsupported()
    const result = { type: token.type, tag: token.tag, nesting: token.nesting, content: token.content, attrs: token.attrs, info: token.info, markup: token.markup, label,
      ...(inline ? { inlineNote: { content: inline.content, tokens: (inline.tokens ?? []).map(child => semantic(child, owner, active)) } } : {}), children: (token.children ?? []).map(child => semantic(child, owner, active)) }
    active.delete(token); return result
  }
  for (const token of tokens) {
    if (!['inline', 'native_container_title', 'callout_title', 'fence', 'code_block', 'html_block', 'math_block'].includes(token.type) || !token.content && !token.children?.length) continue
    const mappedOwner = token.map ? lineOwner[token.map[0]] : undefined
    if (mappedOwner !== undefined && mappedOwner >= 0 && blocks[mappedOwner].type === 'synced-block') continue
    if (mappedOwner !== undefined && mappedOwner >= 0 && ['code', 'math', 'frontmatter'].includes(blocks[mappedOwner].type)) {
      const range = source.ranges[mappedOwner]
      if (!token.map || token.map[0] < range.startLine || token.map[1] > range.endLine) return unsupported()
      units.push({ blockId: blocks[mappedOwner].id, from: 0, to: blocks[mappedOwner].content.length, semantic: semantic(token, blocks[mappedOwner].id) }); continue
    }
    const map = token.meta?.sourceMap
    let from: { index: number; offset: number }, to: { index: number; offset: number }
    if (Array.isArray(map) && map.length && map.every(value => Number.isSafeInteger(value))) {
      const ends = token.meta?.sourceEndMap
      if (ends !== undefined && (!Array.isArray(ends) || ends.length !== map.length || !ends.every(value => Number.isSafeInteger(value)))) return unsupported()
      from = local(map[0] as number); to = local(Array.isArray(ends) ? ends[ends.length - 1] as number : (map[map.length - 1] as number) + 1, true)
    }
    else if (token.map) { from = local(offsets[token.map[0]]); to = local(offsets[token.map[1] - 1] + lines[token.map[1] - 1].length, true) }
    else return unsupported()
    if (from.index !== to.index) return unsupported()
    if (blocks[from.index].type === 'synced-block') continue
    units.push({ blockId: blocks[from.index].id, from: from.offset, to: to.offset, semantic: semantic(token, blocks[from.index].id) })
  }
  return { links, definitions, effective, uses, units }
}

function selection(input: HostCreateInput): { from: number; to: number; ids: string[] } {
  const blocks = input.hostsWorkingBefore[0].workingBefore.blocks, byId = new Map(blocks.map((block, i) => [block.id, i])), ends = new Array<number>(blocks.length), stack: number[] = []
  for (let i = 0; i <= blocks.length; i++) { while (stack.length && (i === blocks.length || blocks[stack[stack.length - 1]].depth >= blocks[i].depth)) ends[stack.pop()!] = i; if (i < blocks.length) stack.push(i) }
  const raw = [...new Set(input.action.selectedRootIds)].map(id => { const index = byId.get(id); if (index === undefined) return invalid('create 的真实 W 选区身份缺失。'); return index }).sort((a, b) => a - b)
  const roots: number[] = []
  for (const index of raw) if (!roots.length || index >= ends[roots[roots.length - 1]]) roots.push(index)
  if (!roots.length) return invalid('create 选区不能为空。')
  const first = roots[0]
  for (let i = 0; i < roots.length; i++) if (blocks[roots[i]].parentBlockId !== blocks[first].parentBlockId || blocks[roots[i]].depth !== blocks[first].depth || i > 0 && roots[i] !== ends[roots[i - 1]]) throw new UnsupportedSyncedHostCreate('create-selection')
  const to = ends[roots[roots.length - 1]], selected = blocks.slice(first, to)
  if (selected.some(block => block.type === 'synced-block')) throw new SyncedValidationError('nested-sync', 'create 不允许所选子树含已有同步引用。')
  if (selected.some(block => /^heading-[1-6]$/.test(block.type))) throw new UnsupportedSyncedHostCreate('heading-rewrite')
  return { from: first, to, ids: selected.map(block => block.id) }
}
export function planSyncedHostCreate(input: HostCreateInput, allocate: (facts: Omit<CreateAuxiliary, 'id' | 'createdAt'>) => Pick<CreateAuxiliary, 'id' | 'createdAt'>): CreateShape {
  const working = input.hostsWorkingBefore[0].workingBefore, range = selection(input), selected = new Set(range.ids), facts = captureSyncedCreateSourceFacts(working.blocks)
  const byId = new Map(working.blocks.map(block => [block.id, block])), auxiliary: CreateAuxiliary[] = []
  const unitsByBlock = unitIndex(facts.units)
  function closure(moved: boolean): Set<string> {
    const result = new Set<string>(), queue = working.blocks.filter(block => selected.has(block.id) === moved).flatMap(block => [...facts.uses.get(block.id)!])
    for (const item of facts.definitions) if (selected.has(item.blockId) === moved) queue.push(definitionKey(item.kind, item.label))
    for (let i = 0; i < queue.length; i++) {
      const key = queue[i]; if (result.has(key)) continue
      const item = facts.effective.get(key); if (!item) return unsupported()
      result.add(key)
      // Traverse only actual parsed consumers inside this exact definition,
      // rather than all other definitions that happen to share its paragraph.
      for (const unit of unitsIn(unitsByBlock, item.blockId, item.from, item.to)) if (unit.from >= item.from && unit.to <= item.to) {
        const walk = (value: unknown): void => {
          if (!value || typeof value !== 'object') return
          if (Array.isArray(value)) { value.forEach(walk); return }
          const record = value as Record<string, unknown>
          if (typeof record.label === 'string') {
            if (record.type === 'link_open' || record.type === 'image') queue.push(definitionKey('reference', record.label))
            if (record.type === 'footnote_ref') queue.push(definitionKey('note', record.label))
          }
          Object.values(record).forEach(walk)
        }
        walk(unit.semantic)
      }
    }
    return result
  }
  const groupLabels = closure(true), hostLabels = closure(false)
  function copies(labels: Set<string>, moved: boolean) {
    const chosen = [...labels].map(key => facts.effective.get(key)!).filter(item => selected.has(item.blockId) !== moved)
    return chosen.map(item => {
      const spec: Omit<CreateAuxiliary, 'id' | 'createdAt'> = { role: moved ? 'group-definition' : 'host-survivor-definition', sourceBlockId: item.blockId, from: item.from, to: item.to, kind: item.kind, label: item.label }
      const value = { ...spec, ...allocate(spec) }; auxiliary.push(value)
      return { allocation: value, block: { id: value.id, type: 'paragraph', content: byId.get(item.blockId)!.content.slice(item.from, item.to), checked: false, depth: 0, parentBlockId: null } satisfies SyncedStableBlockDraft }
    })
  }
  const groupCopies = copies(groupLabels, true), hostCopies = copies(hostLabels, false)
  const depth = working.blocks[range.from].depth, roots = new Set(working.blocks.slice(range.from, range.to).filter(block => block.depth === depth).map(block => block.id))
  const canonical = [...groupCopies.filter(item => item.allocation.kind === 'reference').map(item => item.block),
    ...working.blocks.slice(range.from, range.to).map(block => ({ ...block, depth: block.depth - depth, parentBlockId: roots.has(block.id) ? null : block.parentBlockId })),
    ...groupCopies.filter(item => item.allocation.kind === 'note').map(item => item.block)]
  const leaf: SyncedStableBlockDraft = { id: input.action.instanceId, type: 'synced-block', content: encode({ version: 1, groupId: input.action.groupId }), checked: false, depth, parentBlockId: working.blocks[range.from].parentBlockId }
  const after = { title: working.title, summary: working.summary, blocks: [...hostCopies.filter(item => item.allocation.kind === 'reference').map(item => item.block),
    ...working.blocks.slice(0, range.from), leaf, ...working.blocks.slice(range.to), ...hostCopies.filter(item => item.allocation.kind === 'note').map(item => item.block)] }
  validateSyncedHostForest(canonical); validateSyncedHostForest(after.blocks)
  const auxiliaryById = new Map(auxiliary.map(item => [item.id, item]))
  const projection = (blocks: SyncedStableBlockDraft[]): CreateProjection[] => blocks.filter(block => block.id !== input.action.instanceId).map(block => {
    const copy = auxiliaryById.get(block.id)
    return copy ? { blockId: copy.id, sourceBlockId: copy.sourceBlockId, from: copy.from, to: copy.to } : { blockId: block.id, sourceBlockId: block.id, from: 0, to: byId.get(block.id)!.content.length }
  })
  const shape = { selectedIds: range.ids, canonical, after, auxiliary, canonicalProjection: projection(canonical), hostProjection: projection(after.blocks) }
  assertSyncedCreateScope(facts, shape.canonical, shape.canonicalProjection, groupLabels)
  assertSyncedCreateScope(facts, shape.after.blocks, shape.hostProjection, hostLabels)
  return shape
}
function assertSyncedCreateScope(original: Facts, blocks: SyncedStableBlockDraft[], projections: CreateProjection[], needed: Set<string>): void {
  const actual = captureSyncedCreateSourceFacts(blocks), byId = new Map(projections.map(item => [item.blockId, item]))
  function source(unit: Pick<Unit, 'blockId' | 'from' | 'to'>) {
    const projection = byId.get(unit.blockId); if (!projection || unit.from < 0 || unit.to > projection.to - projection.from) return unsupported()
    return { blockId: projection.sourceBlockId, from: projection.from + unit.from, to: projection.from + unit.to }
  }
  for (const [key, item] of actual.effective) {
    const before = original.effective.get(key); if (!before || physical(source(item)) !== physical(before)) return unsupported()
  }
  for (const key of needed) if (!actual.effective.has(key)) return unsupported()
  const expected: string[] = []
  const unitsByBlock = unitIndex(original.units)
  for (const projection of projections) for (const unit of unitsIn(unitsByBlock, projection.sourceBlockId, projection.from, projection.to)) {
    if (unit.from < projection.from || unit.to > projection.to) return unsupported()
    expected.push(encode({ ...unit, blockId: unit.blockId }))
  }
  const observed = actual.units.map(unit => encode({ ...source(unit), semantic: unit.semantic }))
  expected.sort(); observed.sort(); if (encode(expected) !== encode(observed)) return unsupported()
}
export function createPhysicalKey(key: SyncedBindingKey): string { return encode([key.blockId, key.from, key.to, key.raw, key.syntax]) }
export function projectSyncedCreateLinks(shape: CreateShape, source: readonly CreatePhysicalLink[]): Array<{ source: SyncedBindingKey; destination: SyncedBindingKey; url: string }> {
  const actual = captureSyncedCreateSourceFacts(shape.canonical).links.filter(link => !link.image), origins = new Map(shape.canonicalProjection.map(item => [item.blockId, item]))
  const sourcesByKey = new Map<string, CreatePhysicalLink[]>()
  for (const item of source) if (!item.image) { const key = createPhysicalKey(item.key), values = sourcesByKey.get(key) ?? []; values.push(item); sourcesByKey.set(key, values) }
  return actual.map(link => {
    const projection = origins.get(link.key.blockId); if (!projection) return unsupported()
    const from = projection.from + link.key.from, to = projection.from + link.key.to
    const matches = sourcesByKey.get(createPhysicalKey({ ...link.key, blockId: projection.sourceBlockId, from, to })) ?? []
    if (matches.length !== 1 || matches[0].url !== link.url) return unsupported()
    return { source: matches[0].key, destination: link.key, url: link.url }
  })
}
export function createRawHash(value: unknown): string { return createHash('sha256').update(encode(value)).digest('hex') }
