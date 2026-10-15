import { canBlockNestUnder, isColumnBlockType, isColumnsBlockType } from './blockTypes'
import type { MarkdownBlockFormat } from './markdownFormat'

export const COLUMN_WEIGHT_TOTAL = 10_000
export const MAX_COLUMNS = 6

export interface ColumnStructureBlock {
  type: string
  content: string
  depth?: number
  id?: string
  parentBlockId?: string | null
  markdownFormat?: MarkdownBlockFormat
  checked?: boolean
  language?: string | null
  listStart?: number
}

export type ColumnStructureErrorCode = 'type' | 'depth' | 'identity' | 'missingIdentity' | 'parentRole' | 'columnOwner'
  | 'missingParent' | 'parentIdentity' | 'structuralContent' | 'format' | 'groupFormat' | 'weight' | 'count' | 'total'

export function isColumnWeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= COLUMN_WEIGHT_TOTAL
}

/** Parse-time forests may not have IDs yet. Persisted forests must also prove
 * declared ownership against the active ancestor, rather than a closed subtree. */
export function columnStructureErrorCode(blocks: readonly ColumnStructureBlock[],
  options: { checkParentIds?: boolean } = {}): ColumnStructureErrorCode | null {
  if (!blocks.some(block => typeof block.type === 'string'
    && (isColumnsBlockType(block.type.trim()) || isColumnBlockType(block.type.trim())))) return null
  const ancestors: Array<{ block: ColumnStructureBlock; index: number }> = []
  const groups = new Map<number, ColumnStructureBlock[]>()
  const ids = new Set<string>()
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index], depth = block.depth ?? 0
    if (typeof block.type !== 'string' || block.type !== block.type.trim()) return 'type'
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 6) return 'depth'
    if (block.id !== undefined && block.id !== '') {
      if (typeof block.id !== 'string' || block.id !== block.id.trim() || ids.has(block.id)) return 'identity'
      ids.add(block.id)
    } else if (options.checkParentIds) return 'missingIdentity'
    const parent = depth > 0 ? ancestors[depth - 1] : undefined
    if (depth > 0 && (!parent || !canBlockNestUnder(parent.block.type, block.type))) return 'parentRole'
    if (isColumnBlockType(block.type) && (!parent || !isColumnsBlockType(parent.block.type))) return 'columnOwner'
    if (options.checkParentIds || block.parentBlockId !== undefined) {
      const expected = parent?.block.id ?? null
      if (parent && expected === null && block.parentBlockId != null) return 'missingParent'
      if ((options.checkParentIds || expected !== null || depth === 0) && (block.parentBlockId ?? null) !== expected) {
        return 'parentIdentity'
      }
    }
    if (isColumnsBlockType(block.type) || isColumnBlockType(block.type)) {
      if (block.content !== '' || block.checked || block.language != null || block.listStart !== undefined) return 'structuralContent'
      const format = block.markdownFormat
      if (format !== undefined && (!format || typeof format !== 'object' || Array.isArray(format))) return 'format'
      if (isColumnsBlockType(block.type)) {
        if (format && Object.keys(format).length) return 'groupFormat'
        groups.set(index, [])
      } else {
        if (!format || !isColumnWeight(format.columnWeight) || Object.keys(format).some(key => key !== 'columnWeight')) return 'weight'
        groups.get(parent!.index)!.push(block)
      }
    }
    ancestors.length = depth + 1
    ancestors[depth] = { block, index }
  }
  for (const columns of groups.values()) {
    if (columns.length < 1 || columns.length > MAX_COLUMNS) return 'count'
    if (columns.reduce((sum, column) => sum + column.markdownFormat!.columnWeight!, 0) !== COLUMN_WEIGHT_TOTAL) return 'total'
  }
  return null
}

export function validColumnStructure(blocks: readonly ColumnStructureBlock[], options?: { checkParentIds?: boolean }): boolean {
  return columnStructureErrorCode(blocks, options) === null
}
