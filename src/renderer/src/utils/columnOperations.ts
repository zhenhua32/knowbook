import type { DocumentBlockDraft } from '@shared/contracts'
import { canBlockNestUnder, isColumnBlockType, isColumnsBlockType } from '@shared/blockTypes'
import { validColumnStructure } from '@shared/columnStructure'
import { createDraftBlockId } from './draftTreeFragment'
import { getBlockSubtreeEndIndex } from './draftTreeMove'
import { validateBlockTreeStructure } from './draftTreeNormalization'

type Blocks = DocumentBlockDraft[]
export type ColumnEntry = { block: DocumentBlockDraft; index: number; end: number; weight: number }
export type ColumnGroup = { group: DocumentBlockDraft; index: number; end: number; columns: ColumnEntry[] }

function valid(blocks: Blocks): boolean {
  if (!validateBlockTreeStructure(blocks).valid || !validColumnStructure(blocks, { checkParentIds: true })) return false
  const ancestors: DocumentBlockDraft[] = []
  for (const block of blocks) {
    if (!Number.isSafeInteger(block.depth) || block.depth < 0 || block.depth > 6) return false
    if (block.depth && ancestors[block.depth - 1]?.id !== block.parentBlockId) return false
    if (isColumnsBlockType(block.type) || isColumnBlockType(block.type)) {
      if (block.content !== '' || block.checked || block.language !== undefined || block.listStart !== undefined) return false
      if (isColumnBlockType(block.type) && !isColumnsBlockType(ancestors[block.depth - 1]?.type ?? '')) return false
    }
    ancestors.length = block.depth + 1
    ancestors[block.depth] = block
  }
  for (let index = 0; index < blocks.length; index++) {
    if (!isColumnsBlockType(blocks[index].type)) continue
    const group = readGroup(blocks, index)
    if (!group || group.columns.length < 1 || group.columns.length > 6
      || group.columns.some(column => !Number.isSafeInteger(column.weight) || column.weight < 1 || column.weight > 10_000)
      || group.columns.reduce((sum, column) => sum + column.weight, 0) !== 10_000) return false
  }
  return true
}

function readGroup(blocks: Blocks, index: number): ColumnGroup | null {
  const group = blocks[index]
  if (!group?.id || !isColumnsBlockType(group.type)) return null
  const end = getBlockSubtreeEndIndex(blocks, index), columns: ColumnEntry[] = []
  for (let cursor = index + 1; cursor <= end;) {
    const block = blocks[cursor]
    if (!block.id || !isColumnBlockType(block.type) || block.parentBlockId !== group.id || block.depth !== group.depth + 1) return null
    const columnEnd = getBlockSubtreeEndIndex(blocks, cursor)
    columns.push({ block, index: cursor, end: columnEnd, weight: block.markdownFormat?.columnWeight ?? 0 })
    cursor = columnEnd + 1
  }
  return { group, index, end, columns }
}

export function getColumnGroup(blocks: Blocks, groupId: string): ColumnGroup | null {
  if (!valid(blocks)) return null
  return readGroup(blocks, blocks.findIndex(block => block.id === groupId))
}

function finish(before: Blocks, next: Blocks): Blocks | null {
  return valid(next) && JSON.stringify(before) !== JSON.stringify(next) ? next : null
}

function ownerGroup(blocks: Blocks, columnId: string): ColumnGroup | null {
  const column = blocks.find(block => block.id === columnId)
  return column?.parentBlockId ? getColumnGroup(blocks, column.parentBlockId) : null
}

function shell(type: 'columns' | 'column', depth: number, parentBlockId: string | null, weight?: number): DocumentBlockDraft {
  return { id: createDraftBlockId(), type, content: '', checked: false, depth, parentBlockId,
    ...(weight === undefined ? {} : { markdownFormat: { columnWeight: weight } }) }
}

export function insertColumnsAt(blocks: Blocks, index: number, parentBlockId: string | null = null, replaceEmptyBlockId?: string): Blocks | null {
  if (!valid(blocks) || !Number.isSafeInteger(index) || index < 0 || index > blocks.length) return null
  const parent = parentBlockId ? blocks.find(block => block.id === parentBlockId) : null
  if (parentBlockId && (!parent || !canBlockNestUnder(parent.type, 'columns'))) return null
  const depth = parent ? parent.depth + 1 : 0
  if (depth + 1 > 6) return null
  const replaced = replaceEmptyBlockId ? blocks[index] : undefined
  if (replaceEmptyBlockId && (!replaced || replaced.id !== replaceEmptyBlockId || replaced.type !== 'paragraph' || replaced.content !== ''
    || replaced.depth !== depth || (replaced.parentBlockId ?? null) !== parentBlockId || getBlockSubtreeEndIndex(blocks, index) !== index)) return null
  const group = { ...shell('columns', depth, parentBlockId), ...(replaced ? { id: replaced.id, tags: replaced.tags, highlight: replaced.highlight } : {}) }
  return finish(blocks, [...blocks.slice(0, index), group, shell('column', depth + 1, group.id!, 5000),
    shell('column', depth + 1, group.id!, 5000), ...blocks.slice(index + (replaced ? 1 : 0))])
}

/** Selected siblings and all their descendants become the first column. */
export function wrapBlocksInColumns(blocks: Blocks, selectedIds: readonly string[]): Blocks | null {
  if (!valid(blocks) || !selectedIds.length) return null
  const chosen = new Set(selectedIds), roots: number[] = []
  for (let index = 0; index < blocks.length; index++) {
    if (!chosen.has(blocks[index].id!)) continue
    roots.push(index)
    index = getBlockSubtreeEndIndex(blocks, index)
  }
  if (!roots.length || selectedIds.some(id => !blocks.some(block => block.id === id))) return null
  const first = blocks[roots[0]], end = getBlockSubtreeEndIndex(blocks, roots.at(-1)!)
  if (first.type === 'frontmatter' || isColumnBlockType(first.type)
    || roots.some((index, position) => blocks[index].depth !== first.depth || blocks[index].parentBlockId !== first.parentBlockId
      || blocks[index].type === 'frontmatter' || isColumnBlockType(blocks[index].type)
      || position > 0 && getBlockSubtreeEndIndex(blocks, roots[position - 1]) + 1 !== index)) return null
  const parent = first.parentBlockId ? blocks.find(block => block.id === first.parentBlockId) : null
  if (parent && !canBlockNestUnder(parent.type, 'columns')) return null
  const group = shell('columns', first.depth, first.parentBlockId ?? null)
  const left = shell('column', first.depth + 1, group.id!, 5000), right = shell('column', first.depth + 1, group.id!, 5000)
  const rootIds = new Set(roots.map(index => blocks[index].id))
  const children = blocks.slice(roots[0], end + 1).map(block => ({ ...block, depth: block.depth + 2,
    parentBlockId: rootIds.has(block.id) ? left.id : block.parentBlockId }))
  return finish(blocks, [...blocks.slice(0, roots[0]), group, left, ...children, right, ...blocks.slice(end + 1)])
}

export function addColumn(blocks: Blocks, groupId: string, afterColumnId?: string): Blocks | null {
  const group = getColumnGroup(blocks, groupId)
  if (!group || group.columns.length >= 6) return null
  const after = afterColumnId ? group.columns.find(column => column.block.id === afterColumnId) : group.columns.at(-1)
  if (!after) return null
  const donor = after.weight >= 2 ? after : group.columns.reduce((a, b) => a.weight > b.weight ? a : b)
  const weight = Math.floor(donor.weight / 2)
  const next = blocks.map(block => block.id === donor.block.id ? { ...block,
    markdownFormat: { ...block.markdownFormat, columnWeight: donor.weight - weight } } : block)
  next.splice(after.end + 1, 0, shell('column', group.group.depth + 1, groupId, weight))
  return finish(blocks, next)
}

/** Removing a column preserves its children in the adjacent surviving column. */
export function removeColumn(blocks: Blocks, columnId: string): Blocks | null {
  const group = ownerGroup(blocks, columnId)
  if (!group || group.columns.length <= 1) return null
  const position = group.columns.findIndex(column => column.block.id === columnId)
  if (position < 0) return null
  const removed = group.columns[position], target = group.columns[position > 0 ? position - 1 : 1]
  const children = blocks.slice(removed.index + 1, removed.end + 1).map(block => block.parentBlockId === columnId
    ? { ...block, parentBlockId: target.block.id } : block)
  const next = blocks.filter((_, index) => index < removed.index || index > removed.end).map(block => block.id === target.block.id
    ? { ...block, markdownFormat: { ...block.markdownFormat, columnWeight: target.weight + removed.weight } } : block)
  const targetIndex = next.findIndex(block => block.id === target.block.id)
  next.splice(position === 0 ? targetIndex + 1 : getBlockSubtreeEndIndex(next, targetIndex) + 1, 0, ...children)
  return finish(blocks, next)
}

export function reorderColumn(blocks: Blocks, columnId: string, targetIndex: number): Blocks | null {
  const group = ownerGroup(blocks, columnId)
  if (!group || !Number.isSafeInteger(targetIndex) || targetIndex < 0 || targetIndex >= group.columns.length) return null
  const from = group.columns.findIndex(column => column.block.id === columnId)
  if (from < 0 || from === targetIndex) return null
  const fragments = group.columns.map(column => blocks.slice(column.index, column.end + 1))
  const [moved] = fragments.splice(from, 1)
  fragments.splice(targetIndex, 0, moved)
  return finish(blocks, [...blocks.slice(0, group.index + 1), ...fragments.flat(), ...blocks.slice(group.end + 1)])
}

export function resizeColumnPair(blocks: Blocks, leftColumnId: string, leftWeight: number): Blocks | null {
  const group = ownerGroup(blocks, leftColumnId)
  const position = group?.columns.findIndex(column => column.block.id === leftColumnId) ?? -1
  if (!group || position < 0 || position >= group.columns.length - 1 || !Number.isSafeInteger(leftWeight)) return null
  const left = group.columns[position], right = group.columns[position + 1], total = left.weight + right.weight
  if (leftWeight < 1 || leftWeight >= total || leftWeight === left.weight) return null
  return finish(blocks, blocks.map(block => block.id === left.block.id || block.id === right.block.id
    ? { ...block, markdownFormat: { ...block.markdownFormat, columnWeight: block.id === left.block.id ? leftWeight : total - leftWeight } } : block))
}

export function moveBlockToColumn(blocks: Blocks, blockId: string, targetColumnId: string, beforeBlockId?: string): Blocks | null {
  if (!valid(blocks)) return null
  const index = blocks.findIndex(block => block.id === blockId), target = blocks.find(block => block.id === targetColumnId)
  const block = blocks[index]
  if (!block || !target || !isColumnBlockType(target.type) || !canBlockNestUnder(target.type, block.type)) return null
  const end = getBlockSubtreeEndIndex(blocks, index)
  if (blocks.slice(index, end + 1).some(item => item.id === targetColumnId)) return null
  const next = blocks.filter((_, cursor) => cursor < index || cursor > end)
  const targetIndex = next.findIndex(item => item.id === targetColumnId)
  const before = beforeBlockId ? next.findIndex(item => item.id === beforeBlockId) : -1
  if (beforeBlockId && (before < 0 || next[before].parentBlockId !== targetColumnId)) return null
  const at = before >= 0 ? before : getBlockSubtreeEndIndex(next, targetIndex) + 1
  const delta = target.depth + 1 - block.depth
  const fragment = blocks.slice(index, end + 1).map(item => ({ ...item, depth: item.depth + delta,
    parentBlockId: item.id === blockId ? targetColumnId : item.parentBlockId }))
  next.splice(at, 0, ...fragment)
  return finish(blocks, next)
}

export function unwrapColumns(blocks: Blocks, groupId: string): Blocks | null {
  const group = getColumnGroup(blocks, groupId)
  if (!group) return null
  const parent = group.group.parentBlockId ? blocks.find(block => block.id === group.group.parentBlockId) : null
  const children = group.columns.flatMap(column => blocks.slice(column.index + 1, column.end + 1).map(block => ({ ...block,
    depth: block.depth - 2, parentBlockId: block.parentBlockId === column.block.id ? group.group.parentBlockId ?? null : block.parentBlockId })))
  if (parent && children.some(block => block.depth === group.group.depth && !canBlockNestUnder(parent.type, block.type))) return null
  return finish(blocks, [...blocks.slice(0, group.index), ...children, ...blocks.slice(group.end + 1)])
}

/** Empty columns stay empty until this explicit user action. */
export function appendColumnParagraph(blocks: Blocks, columnId: string): Blocks | null {
  const group = ownerGroup(blocks, columnId), column = group?.columns.find(item => item.block.id === columnId)
  if (!column || column.block.depth >= 6) return null
  const child: DocumentBlockDraft = { id: createDraftBlockId(), type: 'paragraph', content: '', checked: false,
    depth: column.block.depth + 1, parentBlockId: columnId }
  const next = [...blocks]
  next.splice(column.end + 1, 0, child)
  return finish(blocks, next)
}

/** Source Slash has already crossed its cold import boundary before entering. */
export function completeColumnSlash(blocks: Blocks, index: number, content: string, context: {
  isCurrent: () => boolean
  pushToHistory: (blocks: Blocks) => void
  clearBlockSelection: () => void
  setDraftBlocks: (next: Blocks | ((previous: Blocks) => Blocks)) => void
  setActiveBlockIndex: (index: null) => void
  setPendingFocusBlockIndex: (index: null) => void
  endBlockDrag: () => void
}): void {
  if (!context.isCurrent()) return
  const current = blocks[index]
  if (!current) return
  const source = blocks.map((block, cursor) => cursor === index ? { ...block, content } : block)
  const empty = !content && getBlockSubtreeEndIndex(source, index) === index && current.type === 'paragraph'
  const next = empty ? insertColumnsAt(source, index, current.parentBlockId ?? null, current.id)
    : current.id ? wrapBlocksInColumns(source, [current.id]) : null
  if (!next || !context.isCurrent()) return
  context.pushToHistory(blocks); context.clearBlockSelection()
  context.setDraftBlocks(previous => previous === blocks ? next : previous)
  context.setActiveBlockIndex(null); context.setPendingFocusBlockIndex(null); context.endBlockDrag()
}
