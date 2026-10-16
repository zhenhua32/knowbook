import { serializeMarkdownWithBlockRanges, type MarkdownRenderableBlock } from './markdown'
import { markdownEngine, markdownTokenTree, type MarkdownEnvironment, type MarkdownNode, type MarkdownToken } from './markdownEngine'
import { projectedMarkdownContentPosition } from './markdownNativeText'
import { capturedMarkdownSourceLinks, type MarkdownDestination, type MarkdownLinkProvenanceObserver, type MarkdownSourceLink } from './markdownSourceLinks'
import { assertNativeContainerParse } from './markdownContainers'

export type MarkdownLinkProvenanceDestination = Readonly<{
  blockIndex: number
  blockId?: string
  from: number
  to: number
  raw: string
  syntax: 'markdown' | 'wiki'
}>
export type MarkdownInlineLinkProvenance = {
  /** Full authored markup/use span in this block's raw UTF-16 content. */
  use: { from: number; to: number } | null
  via: 'direct' | 'reference'
  destination: MarkdownLinkProvenanceDestination | null
  reason?: 'unproven-reference' | 'unmapped-destination'
}
export type MarkdownInlineWithLinkProvenance = {
  nodes: MarkdownNode[]
  /** Keys are tokens in nodes, not tokens from a separate equivalent parse. */
  provenance: WeakMap<MarkdownToken, MarkdownInlineLinkProvenance>
}
export type MarkdownLinkProvenanceContext = {
  /** Physical parser destinations, including inactive definitions. No targets. */
  sourceDestinations: readonly Readonly<{ key: MarkdownLinkProvenanceDestination; url: string; kind: MarkdownSourceLink['kind'] }>[]
  parseInline: (blockIndex: number, externalReferences?: MarkdownEnvironment['references']) => MarkdownInlineWithLinkProvenance
}

/** Mirror the actual engine normalize rule. BOM remains a source code unit;
 * CRLF contracts to one LF, standalone CR contracts to one LF, NUL's U+FFFD
 * replacement retains its width. Native literal projections are separate. */
function normalizedBoundaries(source: string): number[] {
  const offsets: number[] = []
  for (let index = 0; index < source.length; index++) {
    offsets.push(index)
    if (source[index] === '\r' && source[index + 1] === '\n') index++
  }
  offsets.push(source.length)
  return offsets
}

/** Cold editor provenance only. Main still validates actual complete forests,
 * binding keys and typed targets independently at the persistence boundary. */
export function createMarkdownLinkProvenanceContext(blocks: readonly MarkdownRenderableBlock[], title = ''): MarkdownLinkProvenanceContext {
  const snapshot = blocks.map(block => ({ ...block }))
  const { markdown, ranges, contentProjections } = serializeMarkdownWithBlockRanges(snapshot)
  const boundaries = normalizedBoundaries(markdown), lines = markdown.split('\n'), offsets = [0]
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1)
  // Keep the actual object installed by the successful first definition rule.
  // Later duplicate definitions retain that object and cannot replace its key.
  const definitions = new Map<object, MarkdownDestination>()
  const observer: MarkdownLinkProvenanceObserver = {
    definition(_token, destination, reference) {
      if (reference && !definitions.has(reference)) definitions.set(reference, destination)
    },
    link() {}
  }
  const environment: MarkdownEnvironment = { documentTitle: title, markdownLinkProvenance: observer }
  markdownEngine.parse(markdown, environment)
  assertNativeContainerParse(environment)
  const groupReferences = { ...environment.references }
  const definitionKeys = new Map<object, MarkdownLinkProvenanceDestination>()
  const project = (destination: MarkdownSourceLink): MarkdownLinkProvenanceDestination | null => {
    const from = boundaries[destination.start], to = boundaries[destination.end]
    if (from === undefined || to === undefined || to < from) return null
    let line = 0
    while (line + 1 < offsets.length && offsets[line + 1] <= from) line++
    const range = ranges.find(value => value.startLine <= line && line < value.endLine)
    if (!range) return null
    const block = snapshot[range.index]
    if (!block || ['code', 'math', 'frontmatter', 'database-view'].includes(block.type)) return null
    const start = projectedMarkdownContentPosition(block, range, markdown, lines, offsets, from, contentProjections?.[range.index])
    const end = projectedMarkdownContentPosition(block, range, markdown, lines, offsets, to, contentProjections?.[range.index], true)
    if (start === null || end === null || start < 0 || end < start || end > block.content.length) return null
    return Object.freeze({ blockIndex: range.index, ...(block.id === undefined ? {} : { blockId: block.id }),
      from: start, to: end, raw: block.content.slice(start, end), syntax: destination.kind === 'wiki' ? 'wiki' : 'markdown' })
  }
  for (const [reference, destination] of definitions) {
    const key = project(destination)
    if (key) definitionKeys.set(reference, key)
  }
  const sourceDestinations = Object.freeze([...capturedMarkdownSourceLinks(environment)].sort((left, right) => left.start - right.start)
    .flatMap(destination => { const key = project(destination); return key ? [Object.freeze({ key, url: destination.url, kind: destination.kind })] : [] }))
  return {
    sourceDestinations,
    parseInline(blockIndex, externalReferences) {
      if (!Number.isInteger(blockIndex) || !snapshot[blockIndex]) throw new Error('Invalid Markdown provenance block index')
      const block = snapshot[blockIndex], rawBoundaries = normalizedBoundaries(block.content)
      const provenance = new WeakMap<MarkdownToken, MarkdownInlineLinkProvenance>()
      const inlineObserver: MarkdownLinkProvenanceObserver = {
        definition() {},
        link(token, use, destination, reference) {
          const from = rawBoundaries[use.start], to = rawBoundaries[use.end]
          const span = from === undefined || to === undefined || to < from ? null : { from, to }
          if (typeof token.meta?.label === 'string') {
            const key = reference && definitionKeys.get(reference)
            provenance.set(token, { use: span, via: 'reference', destination: key ?? null,
              ...(!key ? { reason: 'unproven-reference' as const } : {}) })
            return
          }
          const start = destination && rawBoundaries[destination.start], end = destination && rawBoundaries[destination.end]
          const key: MarkdownLinkProvenanceDestination | null = start === undefined || end === undefined || end < start ? null
            : Object.freeze({ blockIndex, ...(block.id === undefined ? {} : { blockId: block.id }), from: start, to: end,
              raw: block.content.slice(start, end), syntax: destination?.kind === 'wiki' ? 'wiki' : 'markdown' })
          provenance.set(token, { use: span, via: 'direct', destination: key, ...(!key ? { reason: 'unmapped-destination' as const } : {}) })
        }
      }
      // Actual group objects win over same-label objects from another parse.
      // External-only definitions still render, with explicitly missing proof.
      const inlineEnvironment: MarkdownEnvironment = { references: { ...externalReferences, ...groupReferences }, markdownLinkProvenance: inlineObserver }
      const nodes = markdownTokenTree(markdownEngine.parseInline(block.content, inlineEnvironment)[0]?.children ?? [])
      const visit = (items: MarkdownNode[]) => {
        for (const { token, children } of items) {
          if (token.type === 'link_open' && !provenance.has(token)) provenance.set(token, { use: null,
            via: typeof token.meta?.label === 'string' ? 'reference' : 'direct', destination: null, reason: 'unmapped-destination' })
          if (token.type !== 'image') visit(children)
        }
      }
      visit(nodes)
      return { nodes, provenance }
    }
  }
}
