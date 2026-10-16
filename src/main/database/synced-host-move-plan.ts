import { createHash } from 'node:crypto'
import type { SyncedStructureAction, SyncedStructureInput } from '../../shared/synced-blocks'
import { syncedPlainRecord, SyncedValidationError, validateSyncedHostForest } from '../../shared/syncedBlockValidation'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { serializeMarkdownHostSource } from '../../shared/markdownSource'
import { markdownEngine, type MarkdownEnvironment, type MarkdownToken } from '../../shared/markdownEngine'
import { getMarkdownHeadingTargets, getMarkdownHeadingRewrites } from '../../shared/markdownLinkMaintenance'
import type { HostContent } from './synced-host-document-read'

export type HostMoveInput = Extract<SyncedStructureInput, { mode: 'command' }> & {
  action: Extract<SyncedStructureAction, { kind: 'move' | 'duplicate' }> & { kind: 'move' }
}
export function isHostMoveInput(input: SyncedStructureInput): input is HostMoveInput {
  return input.mode === 'command' && input.action.kind === 'move'
}
export class UnsupportedSyncedHostMove extends Error {
  constructor(readonly reason: 'move-selection' | 'semantic-binding' | 'heading-rewrite') { super('Move requires a separate structural or Markdown-context operation') }
}
function invalid(code: 'identity' | 'forest' | 'depth', message: string): never { throw new SyncedValidationError(code, message) }

/** Same-host complete sibling subtrees, resolved from original stable W IDs.
 * Raw selection order/duplicates stay in input and its request hash/journal. */
export function planSyncedHostMove(input: HostMoveInput): HostContent {
  const { selection, target } = input.action
  if (input.hostsWorkingBefore.length !== 1 || input.hostsWorkingBefore[0].documentId !== target.documentId
    || selection.documentId !== target.documentId) invalid('identity', 'move 的完整 W、选区和目标必须是同一唯一宿主。')
  const working = input.hostsWorkingBefore[0].workingBefore, blocks = working.blocks
  const byId = new Map(blocks.map((block, index) => [block.id, { block, index }])), ends: number[] = [], stack: number[] = []
  for (let index = 0; index < blocks.length; index++) {
    while (stack.length && blocks[stack[stack.length - 1]].depth >= blocks[index].depth) ends[stack.pop()!] = index
    stack.push(index)
  }
  for (const index of stack) ends[index] = blocks.length
  const selected = [...new Set(selection.selectedRootIds)].map(id => {
    const block = byId.get(id)
    if (!block) invalid('identity', 'move 选区包含不存在的真实 W 身份。')
    return block.index
  }).sort((left, right) => left - right)
  const roots: number[] = []
  for (const index of selected) if (!roots.length || index >= ends[roots[roots.length - 1]]) roots.push(index)
  if (!roots.length) invalid('forest', 'move 必须具有真实完整根。')
  const first = blocks[roots[0]]
  for (let index = 0; index < roots.length; index++) {
    const current = blocks[roots[index]]
    if (current.parentBlockId !== first.parentBlockId || current.depth !== first.depth
      || index > 0 && ends[roots[index - 1]] !== roots[index]) throw new UnsupportedSyncedHostMove('move-selection')
  }
  const start = roots[0], end = ends[roots[roots.length - 1]], fragment = blocks.slice(start, end)
  const remaining = [...blocks.slice(0, start), ...blocks.slice(end)], rest = new Map(remaining.map((block, index) => [block.id, { block, index }]))
  let position = remaining.length
  if (target.parentBlockId === null) {
    if (target.depth !== 0) invalid('depth', 'move 根目标必须有准确 depth。')
  } else {
    const parent = rest.get(target.parentBlockId)
    if (!parent) invalid('forest', 'move 目标父块不在剩余 W，不能进入自身选区或后代。')
    if (target.depth !== parent.block.depth + 1) invalid('depth', 'move 目标 depth 必须紧接真实父块。')
    position = parent.index + 1
    while (position < remaining.length && remaining[position].depth > parent.block.depth) position++
  }
  if (target.beforeBlockId !== null) {
    const before = rest.get(target.beforeBlockId)
    if (!before || before.block.parentBlockId !== target.parentBlockId || before.block.depth !== target.depth) {
      invalid('forest', 'move 锚点必须仍存在于剩余树且是目标父块的直接 child。')
    }
    position = before.index
  }
  const rootIds = new Set(roots.map(index => blocks[index].id)), delta = target.depth - first.depth
  const moved = fragment.map(block => {
    const depth = block.depth + delta
    return { ...block, depth, parentBlockId: rootIds.has(block.id) ? target.parentBlockId : block.parentBlockId }
  })
  return { title: working.title, summary: working.summary,
    blocks: validateSyncedHostForest([...remaining.slice(0, position), ...moved, ...remaining.slice(position)]) }
}
function unsupportedContext(): never { throw new UnsupportedSyncedHostMove('semantic-binding') }
/** A real complete parse supplies definitions and every inline consumer. Maps
 * below are keyed by stable physical block/definition identity, never href alone
 * or an encounter-number assigned to a footnote. Unknown projection fails shut. */
function markdownContext(content: HostContent) {
  const source = serializeMarkdownHostSource(content.blocks), env: MarkdownEnvironment = { captureSourceLinks: true }
  const state = new markdownEngine.core.State(source.markdown, markdownEngine, env)
  let reachedTail = false
  for (const rule of markdownEngine.core.ruler.__rules__) {
    if (rule.name === 'footnote_tail') { reachedTail = true; break }
    if (rule.enabled && rule.name !== 'strip_references') rule.fn(state)
  }
  if (!reachedTail || state.src !== source.markdown.replace(/\0/g, '\uFFFD')) unsupportedContext()
  const lines = state.src.split('\n'), starts = [0], ownerByLine = new Array<number>(lines.length).fill(-1)
  for (const line of lines) starts.push(starts[starts.length - 1] + line.length + 1)
  for (const range of source.ranges) for (let line = range.startLine; line < range.endLine; line++) {
    if (ownerByLine[line] !== -1) unsupportedContext()
    ownerByLine[line] = range.index
  }
  const owner = (from: number, to: number): number => {
    const index = ownerByLine[from], range = source.ranges[index]
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || !range
      || from < range.startLine || to > range.endLine || ownerByLine[to - 1] !== index) unsupportedContext()
    return index
  }
  const lineAt = (position: number): number => {
    if (!Number.isSafeInteger(position) || position < 0 || position >= state.src.length) unsupportedContext()
    let left = 0, right = starts.length - 1
    while (left + 1 < right) { const middle = (left + right) >>> 1; if (starts[middle] <= position) left = middle; else right = middle }
    return left
  }
  const rawHashes = new Map(content.blocks.map(block => [block.id, createHash('sha256').update(block.content).digest('hex')]))
  const definition = (label: string, from: number, to: number) => {
    const index = owner(from, to), block = content.blocks[index], range = source.ranges[index]
    // Strict source does not expose a raw content projection. Only an exact
    // top-level paragraph copy proves these local spans; complex cases refuse.
    if (block.type !== 'paragraph' || block.depth !== 0
      || lines.slice(range.startLine, range.endLine).join('\n') !== block.content.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD')) unsupportedContext()
    return { label, blockId: block.id, fromLine: from - range.startLine, toLine: to - range.startLine,
      rawBlockSHA256: rawHashes.get(block.id), definition: lines.slice(from, to).join('\n') }
  }
  const references = new Map<string, unknown>(), notes = new Map<string, unknown>()
  const tokens = state.tokens, priorEnds: number[] = [], followingStarts: number[] = []
  let prior = 0, following = lines.length - 1
  for (let index = 0; index < tokens.length; index++) { priorEnds[index] = prior; if (tokens[index].map) prior = tokens[index].map![1] }
  for (let index = tokens.length - 1; index >= 0; index--) { followingStarts[index] = following; if (tokens[index].map) following = tokens[index].map![0] }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.type === 'reference_definition') {
      const label = token.meta?.label
      if (typeof label !== 'string' || !token.map) unsupportedContext()
      const fact = definition(label, token.map[0], token.map[1]), binding = env.references?.[label]
      if (!syncedPlainRecord(binding) || typeof binding.href !== 'string' || typeof binding.title !== 'string') unsupportedContext()
      if (!references.has(label)) references.set(label, { ...fact, href: binding.href, title: binding.title })
    }
    if (token.type !== 'footnote_reference_open') continue
    const label = token.meta?.label
    if (typeof label !== 'string') unsupportedContext()
    let close = index + 1
    while (close < tokens.length && tokens[close].type !== 'footnote_reference_close') {
      if (tokens[close].type === 'footnote_reference_open') unsupportedContext()
      close++
    }
    if (close === tokens.length) unsupportedContext()
    const maps = tokens.slice(index + 1, close).flatMap(item => item.map ? [item.map] : [])
    const lower = priorEnds[index], following = followingStarts[close]
    const firstBody = maps.length ? maps.reduce((minimum, map) => Math.min(minimum, map[0]), Infinity) : following
    const headers: number[] = []
    for (let line = lower; line <= firstBody && line < lines.length; line++) {
      const match = /^\[\^([^\]\x20\n]+)\]:/.exec(lines[line])
      if (match?.[1] === label) headers.push(line)
    }
    if (headers.length !== 1) unsupportedContext()
    let last = maps.length ? maps.reduce((maximum, map) => Math.max(maximum, map[1]), -Infinity) - 1 : headers[0]
    while (last > headers[0] && !lines[last].trim()) last--
    notes.set(label, definition(label, headers[0], last + 1)) // actual named-note rule is last-binding
  }
  if (Object.keys(env.references ?? {}).length !== references.size) unsupportedContext()
  const footnotes = env.footnotes as { refs?: Record<string, number>; list?: Array<{ content?: string; tokens?: MarkdownToken[] }> } | undefined
  const noteNames = Object.keys(footnotes?.refs ?? {})
  if (noteNames.length !== notes.size || noteNames.some(name => !name.startsWith(':') || !notes.has(name.slice(1)))) unsupportedContext()
  const semantic = (token: MarkdownToken, active = new Set<MarkdownToken>()): unknown => {
    if (active.has(token)) return unsupportedContext()
    active.add(token)
    const label = typeof token.meta?.label === 'string' ? token.meta.label : null
    const noteId = token.meta?.id
    const inlineNote = token.type === 'footnote_ref' && label === null && typeof noteId === 'number' && Number.isSafeInteger(noteId) && noteId >= 0 ? footnotes?.list?.[noteId] : undefined
    if (token.type === 'footnote_ref' && label === null && (!inlineNote || typeof inlineNote.content !== 'string')) unsupportedContext()
    const result = { type: token.type, tag: token.tag, nesting: token.nesting, content: token.content, attrs: token.attrs,
      info: token.info, markup: token.markup, label,
      ...(inlineNote ? { inlineNote: { content: inlineNote.content, tokens: (inlineNote.tokens ?? []).map((child: MarkdownToken) => semantic(child, active)) } } : {}),
      children: (token.children ?? []).map(child => semantic(child, active)) }
    active.delete(token); return result
  }
  const units = new Map(content.blocks.map(block => [block.id, [] as unknown[]]))
  for (const token of tokens) {
    if (!['inline', 'native_container_title', 'callout_title', 'fence', 'code_block', 'html_block', 'math_block'].includes(token.type)) continue
    if (!token.content && !token.children?.length) continue
    const positions = token.meta?.sourceMap
    let index: number
    if (Array.isArray(positions) && positions.length) {
      let from = Infinity, to = -Infinity
      for (const position of positions) { if (!Number.isSafeInteger(position)) unsupportedContext(); from = Math.min(from, position); to = Math.max(to, position) }
      index = owner(lineAt(from), lineAt(to) + 1)
    } else if (token.map) index = owner(token.map[0], token.map[1])
    else return unsupportedContext()
    units.get(content.blocks[index].id)!.push({ type: token.type,
      semantics: token.type === 'inline' || token.type === 'native_container_title' || token.type === 'callout_title'
        ? (token.children ?? []).map(child => semantic(child)) : semantic(token) })
  }
  const sorted = (map: Map<string, unknown>) => [...map].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return { references: sorted(references), notes: sorted(notes), uses: sorted(units) }
}
export function assertSyncedHostMoveContext(before: HostContent, after: HostContent): void {
  if (canonicalSyncedPortableJson(before) === canonicalSyncedPortableJson(after)) return
  if (getMarkdownHeadingRewrites(getMarkdownHeadingTargets(before.blocks, before.title), getMarkdownHeadingTargets(after.blocks, after.title)).size) {
    throw new UnsupportedSyncedHostMove('heading-rewrite')
  }
  try {
    if (canonicalSyncedPortableJson(markdownContext(before)) !== canonicalSyncedPortableJson(markdownContext(after))) unsupportedContext()
  } catch (error) {
    if (error instanceof UnsupportedSyncedHostMove) throw error
    throw new UnsupportedSyncedHostMove('semantic-binding')
  }
}
