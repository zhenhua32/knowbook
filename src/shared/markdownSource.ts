import {
  parseMarkdownBlocksCore, serializeMarkdownWithBlockRangesCore,
  type MarkdownRenderableBlock, type MarkdownSourceSyntaxBlock, type MarkdownSourceStrictOptions,
  type MarkdownSourceStrictResult, type MarkdownSourceParsePolicy, type MarkdownSourceSerializationPolicy,
  type MarkdownBlockSourceRange, type MarkdownContainerClosingRange
} from './markdown'
import type { MarkdownNode } from './markdownEngine'
import type { SyncedStableBlockDraft } from './synced-blocks'
import { canBlockNestUnder, isListBlockType } from './blockTypes'
import { columnStructureErrorCode } from './columnStructure'
import { SYNCED_BLOCK_FENCE_INFO, parseSyncedBlockPayload, serializeSyncedBlockPayload, validateSyncedHostForest } from './syncedBlockValidation'
import { createMarkdownSourceTrace, type MarkdownSourceContentTrace, type MarkdownSourceTracePort } from './markdownSourceTrace'

function fail(message: string): never { throw new Error('Invalid strict Markdown source: ' + message) }
type ExpectedRef = { key: string; from: number; to: number; payload: string; used: boolean }

/** This cold adapter uses the same token walker as public Markdown. Local
 * expectations prove source provenance, never Main's ownership authority. */
export function parseMarkdownSourceStrict(source: string, options: MarkdownSourceStrictOptions): MarkdownSourceStrictResult {
  return parseStrict(source, options)
}

export interface MarkdownSourceStrictTracedResult extends MarkdownSourceStrictResult {
  readonly contentTraces: readonly MarkdownSourceContentTrace[]
}

/** A cold, explicit source operation. Ordinary strict/public parses do not
 * install observers, allocate character maps or change their result shape. */
export function parseMarkdownSourceStrictWithTrace(source: string, options: MarkdownSourceStrictOptions): MarkdownSourceStrictTracedResult {
  if (typeof source !== 'string') fail('invalid input')
  const trace = createMarkdownSourceTrace(source)
  const result = parseStrict(source, options, trace.port)
  return { ...result, contentTraces: trace.finish() }
}

function parseStrict(source: string, options: MarkdownSourceStrictOptions, trace?: MarkdownSourceTracePort): MarkdownSourceStrictResult {
  if (typeof source !== 'string' || !options || !['canonical', 'internal-host'].includes(options.mode)) fail('invalid input')
  const result: MarkdownSourceStrictResult = { blocks: [], sourceRanges: [], closingRanges: [], metadata: [], references: [] }
  const starts = [0], originalLines = source.split(/\r\n?|\n/)
  for (const match of source.matchAll(/\r\n?|\n/g)) starts.push(match.index + match[0].length)
  const span = (startLine: number, endLine: number) => {
    const from = (starts[startLine] ?? source.length) + (startLine === 0 && source.startsWith('\uFEFF') ? 1 : 0)
    let to = starts[endLine] ?? source.length
    if (source[to - 1] === '\n') to--
    if (source[to - 1] === '\r') to--
    return { from, to: Math.max(from, to) }
  }
  const fenceSpan = (node: MarkdownNode) => {
    const { token } = node
    if (token.type !== 'fence' || !token.map || token.map[1] - token.map[0] < 2) return null
    const firstLine = originalLines[token.map[0]], lastLine = originalLines[token.map[1] - 1]
    const bom = token.map[0] === 0 && firstLine?.startsWith('\uFEFF') ? 1 : 0
    const opening = /^([ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)*)(`{3,}|~{3,})(.*)$/.exec(firstLine?.slice(bom) ?? '')
    const closing = /^([ \t]*)(`{3,}|~{3,})([ \t]*)$/.exec(lastLine ?? '')
    if (!opening || opening[2] !== token.markup || !closing || closing[2][0] !== token.markup[0]
      || closing[2].length < token.markup.length) return null
    return { from: starts[token.map[0]] + bom + opening[1].length,
      to: starts[token.map[1] - 1] + closing[1].length + closing[2].length }
  }
  const references: ExpectedRef[] = [], byKey = new Map<string, ExpectedRef>()
  if (options.mode === 'internal-host') {
    if (!Array.isArray(options.references)) fail('invalid reference expectations')
    for (const ref of options.references) {
      if (!ref || typeof ref.key !== 'string' || !ref.key || byKey.has(ref.key) || !Number.isSafeInteger(ref.from)
        || !Number.isSafeInteger(ref.to) || ref.from < 0 || ref.to <= ref.from || ref.to > source.length || typeof ref.payload !== 'string')
        fail('invalid or duplicate reference expectation')
      if (serializeSyncedBlockPayload(parseSyncedBlockPayload(ref.payload)) !== ref.payload) fail('noncanonical expected payload')
      const checked = { ...ref, used: false }
      references.push(checked); byKey.set(ref.key, checked)
    }
  } else if (Object.hasOwn(options, 'references')) fail('canonical source cannot bind references')
  references.sort((a, b) => a.from - b.from || a.to - b.to)
  for (let index = 1; index < references.length; index++)
    if (references[index].from < references[index - 1].to) fail('overlapping reference expectations')
  const byRange = new Map(references.map(ref => [`${ref.from}:${ref.to}`, ref])), parents: number[] = []
  const expectedRef = (node: MarkdownNode) => {
    const range = fenceSpan(node)
    return range ? byRange.get(`${range.from}:${range.to}`) : undefined
  }
  const checkListDepth = (node: MarkdownNode, depth: number): void => {
    if (depth > 6) fail('source nesting exceeds six levels')
    for (const item of node.children) for (const child of item.children)
      if (child.token.type === 'bullet_list_open' || child.token.type === 'ordered_list_open') checkListDepth(child, depth + 1)
  }
  const policy: MarkdownSourceParsePolicy = {
    trace,
    fail, expectedRef, checkListDepth,
    push(block, index, refKey) {
      const depth = block.depth ?? 0, parentIndex = depth ? parents[depth - 1] : null
      if (!Number.isSafeInteger(depth) || depth < 0 || depth > 6) fail('source nesting exceeds six levels')
      const parent = parentIndex == null ? undefined : result.blocks[parentIndex]
      if (depth > 0 && (!parent || !canBlockNestUnder(parent.type, block.type)
        && !(refKey !== null && isListBlockType(parent.type)))) fail('invalid syntax parent role')
      if (block.type === 'column' && parent?.type !== 'columns') fail('column has no columns owner')
      const { id: _id, parentBlockId: _parent, tags: _tags, highlight: _highlight, depth: _depth, ...syntax } = block
      result.blocks.push({ ...syntax, depth, parentIndex: parentIndex ?? null, refKey })
      parents.length = depth + 1; parents[depth] = index
    },
    consumeRef(node, key) {
      const ref = byKey.get(key), content = node.token.content.replace(/\n$/, '')
      if (!ref || ref.used || expectedRef(node) !== ref || node.token.info.trim() !== SYNCED_BLOCK_FENCE_INFO)
        fail('unknown or repeated protected reference fence')
      if (content !== ref.payload || serializeSyncedBlockPayload(parseSyncedBlockPayload(content)) !== ref.payload) fail('protected reference payload changed')
      ref.used = true; result.references.push({ key, from: ref.from, to: ref.to })
    },
    hasProtectedRef(node) {
      if (!node.token.map) return false
      const range = span(...node.token.map)
      let low = 0, high = references.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (references[middle].to <= range.from) low = middle + 1
        else high = middle
      }
      return low < references.length && references[low].from < range.to
    },
    metadata(node) {
      const range = span(...node.token.map!)
      result.metadata.push({ startLine: node.token.map![0], endLine: node.token.map![1], raw: source.slice(range.from, range.to) })
    },
    finish(blocks) { if (columnStructureErrorCode(blocks, { allowSyncedPlaceholders: true })) fail('invalid column forest') }
  }
  parseMarkdownBlocksCore(source, result.sourceRanges, result.closingRanges, policy)
  if (references.some(ref => !ref.used)) fail('a protected reference is damaged, hidden or unmatched')
  return result
}

export interface MarkdownHostSourceResult {
  markdown: string
  ranges: MarkdownBlockSourceRange[]
  closingRanges: MarkdownContainerClosingRange[]
  references: Array<{ index: number; from: number; to: number }>
}

/** Internal source only. Public Markdown/clipboard must materialize snapshots
 * and must not use these identity-bearing out-of-band reference positions. */
export function serializeMarkdownHostSource(blocks: readonly SyncedStableBlockDraft[]): MarkdownHostSourceResult {
  const checked = validateSyncedHostForest(blocks)
  const policy: MarkdownSourceSerializationPolicy = {
    depths: values => values.map(block => block.depth ?? 0),
    listMember: (block, parentType) => isListBlockType(block.type) || block.type === 'synced-block' && parentType !== null && isListBlockType(parentType),
    render(block, indent, parentType) {
      if (block.type !== 'synced-block') return null
      const content = serializeSyncedBlockPayload(parseSyncedBlockPayload(block.content))
      const list = parentType !== null && isListBlockType(parentType)
      const prefix = list ? indent + '- ' : '', continuation = list ? indent + '  ' : ''
      const markdown = [prefix + '```' + SYNCED_BLOCK_FENCE_INFO, continuation + content, continuation + '```'].join('\n')
      return { markdown, from: prefix.length, to: markdown.length }
    }
  }
  const rendering = checked.map(block => ({ ...block, content: block.content.replace(/\r\n?/g, '\n') }))
  const rendered = serializeMarkdownWithBlockRangesCore(rendering, {}, policy)
  const result: MarkdownHostSourceResult = { markdown: rendered.markdown, ranges: rendered.ranges,
    closingRanges: rendered.closingRanges, references: rendered.references ?? [] }
  verifyHostReferences(checked, result)
  return result
}

function verifyHostReferences(blocks: readonly SyncedStableBlockDraft[], source: MarkdownHostSourceResult): void {
  if (source.ranges.length !== blocks.length || source.ranges.some((range, index) => range.index !== index)) fail('source ranges lost input identities')
  const expected = blocks.flatMap((block, index) => block.type === 'synced-block' ? [index] : [])
  if (source.references.length !== expected.length || source.references.some((ref, index) => ref.index !== expected[index])) fail('source references lost input identities')
  const parsed = parseMarkdownSourceStrict(source.markdown, { mode: 'internal-host', references: source.references.map(ref => ({
    key: String(ref.index), from: ref.from, to: ref.to, payload: serializeSyncedBlockPayload(parseSyncedBlockPayload(blocks[ref.index].content))
  })) })
  const nonempty = source.ranges.filter(range => range.endLine > range.startLine)
  const owner = (range: MarkdownBlockSourceRange): number | null => {
    let low = 0, high = nonempty.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (nonempty[middle].startLine <= range.startLine) low = middle + 1
      else high = middle
    }
    const candidate = nonempty[low - 1]
    return candidate && range.startLine >= candidate.startLine && range.endLine <= candidate.endLine ? candidate.index : null
  }
  const owners = parsed.sourceRanges.map(owner), inputIndices = new Map(blocks.map((block, index) => [block.id, index]))
  for (let index = 0; index < parsed.blocks.length; index++) {
    const syntax: MarkdownSourceSyntaxBlock = parsed.blocks[index]
    if (syntax.refKey === null) continue
    const inputIndex = Number(syntax.refKey), original = blocks[inputIndex]
    if (!original || original.type !== 'synced-block' || owners[index] !== inputIndex) fail('reference escaped its emitted source range')
    let parent = syntax.parentIndex, previous = inputIndex, outerParent: number | null = null, depth = 0
    while (parent !== null) {
      const current = owners[parent]
      if (current === null) fail('reference parent crosses emitted source ranges')
      if (current !== previous) {
        if (outerParent === null) outerParent = current
        depth++; previous = current
      }
      parent = parsed.blocks[parent].parentIndex
    }
    const expectedParent = original.parentBlockId === null ? null : inputIndices.get(original.parentBlockId)
    if (outerParent !== expectedParent || depth !== original.depth) fail('reference changed its real host parent or depth')
  }
}
