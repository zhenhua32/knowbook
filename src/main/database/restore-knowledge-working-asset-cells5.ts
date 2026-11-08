import { serializeMarkdownWithBlockRanges, type MarkdownRenderableBlock } from '../../shared/markdown'
import { projectedMarkdownContentPosition } from '../../shared/markdownNativeText'
import { collectStoredMarkdownAssetDestinations } from '../../shared/syncedBlockPortable'
import { capsuleBytesHash, capsuleJson } from './restore-knowledge-capsule-model'

const opaque = new Set(['code', 'code-block', 'math', 'frontmatter', 'database-view', 'synced-block'])
type StoredDestination = { readonly uri: string; readonly from: number; readonly to: number }
export const workingAssetPosition5 = (value: StoredDestination) => capsuleJson([value.from, value.to, value.uri])
export const workingAssetCellPosition5 = (blockId: string, value: StoredDestination) => capsuleJson([blockId, value.from, value.to, value.uri])

/** Recover the physical UTF-16 positions using the same serializer/projection
 * as native links. A masked block or synthetic delimiter never supplies a cell. */
export function projectWorkingAssetBodyCells5(input: readonly MarkdownRenderableBlock[], scope: 'base' | 'working', collectAll = false) {
  const blocks = input.map(block => !opaque.has(block.type) ? block
    : scope === 'base' ? { id: block.id, type: 'paragraph', content: '', checked: false,
      depth: block.depth, parentBlockId: block.parentBlockId ?? null } : { ...block, type: 'paragraph', content: '' })
  const { markdown, ranges, contentProjections } = serializeMarkdownWithBlockRanges(blocks)
  const lines = markdown.split('\n'), lineOffsets = [0]
  for (const line of lines) lineOffsets.push(lineOffsets.at(-1)! + line.length + 1)
  const byBodyPosition = new Map<string, { blockId: string; from: number; to: number; raw: string; uri: string; kind: string; syntax: string }>()
  const byCellPosition = new Map<string, NonNullable<ReturnType<typeof byBodyPosition.get>>>()
  const bodyDestinations: Array<Omit<NonNullable<ReturnType<typeof byBodyPosition.get>>, 'blockId'>> = []
  let line = 0, rangeIndex = 0
  for (const asset of collectStoredMarkdownAssetDestinations(markdown)) {
    if (collectAll) bodyDestinations.push({ from: asset.start, to: asset.end, uri: asset.url,
      raw: markdown.slice(asset.start, asset.end), kind: asset.kind, syntax: asset.syntax ?? 'markdown' })
    while (line + 1 < lineOffsets.length && lineOffsets[line + 1] <= asset.start) line++
    while (rangeIndex < ranges.length && ranges[rangeIndex].endLine <= line) rangeIndex++
    const range = ranges[rangeIndex], block = blocks[rangeIndex]
    if (!range || !block?.id || line < range.startLine || opaque.has(input[rangeIndex].type)) continue
    const from = projectedMarkdownContentPosition(block, range, markdown, lines, lineOffsets, asset.start, contentProjections?.[rangeIndex])
    const to = projectedMarkdownContentPosition(block, range, markdown, lines, lineOffsets, asset.end, contentProjections?.[rangeIndex], true)
    if (from === null || to === null || to <= from) continue
    const raw = block.content.slice(from, to)
    if (raw !== markdown.slice(asset.start, asset.end)) continue
    const value = { blockId: block.id, from, to, raw, uri: asset.url, kind: asset.kind, syntax: asset.syntax ?? 'markdown' }
    const key = workingAssetPosition5({ from: asset.start, to: asset.end, uri: asset.url }), cell = workingAssetCellPosition5(block.id, value)
    if (byBodyPosition.has(key) || byCellPosition.has(cell)) throw new Error('Working5 正文附件坐标重复')
    byBodyPosition.set(key, value); byCellPosition.set(cell, value)
  }
  return { bodyDestinations, byBodyPosition, byCellPosition, baseProjectionHash: capsuleBytesHash('knowbook.capsule2.asset-body-discovery-projection.v1\0' + markdown) }
}
