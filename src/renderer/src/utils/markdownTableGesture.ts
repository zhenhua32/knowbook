import { MIN_TABLE_COLUMN_WIDTH, MAX_TABLE_COLUMN_WIDTH } from '@shared/markdownTableLayout'
import type { TableOperation } from '@shared/markdownTableEditing'

export function tableGestureWidth(width: number, delta: number): number {
  return Math.max(MIN_TABLE_COLUMN_WIDTH, Math.min(MAX_TABLE_COLUMN_WIDTH, Math.round(width + delta)))
}
function movedIndex(index: number, from: number, to: number) {
  return index === from ? to : from < to && index > from && index <= to ? index - 1 : from > to && index >= to && index < from ? index + 1 : index
}
export function mapTableGestureCell<T extends { row: number; column: number }>(cell: T, operation: TableOperation): T {
  return operation.kind === 'move-row' ? { ...cell, row: movedIndex(cell.row, operation.row, operation.toRow) }
    : operation.kind === 'move-column' ? { ...cell, column: movedIndex(cell.column, operation.column, operation.toColumn) } : cell
}
