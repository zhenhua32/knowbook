import type { DocumentCatalogEntry, DocumentDatabaseColumn, DocumentDatabaseFieldValue } from './contracts'

export type BoardDropTarget =
  | {
      kind: 'parent'
      parentId: string | null
    }
  | {
      kind: 'field'
      columnId: string
      value: string | boolean | null
    }

export type BoardColumn = {
  id: string
  title: string
  dropTarget: BoardDropTarget
  items: DocumentCatalogEntry[]
}

export function isBoardGroupableColumn(column: DocumentDatabaseColumn): boolean {
  return column.type === 'select' || column.type === 'multi-select' || column.type === 'checkbox'
}

export function getBoardDropFieldValue(
  column: DocumentDatabaseColumn,
  currentValue: DocumentDatabaseFieldValue,
  targetValue: string | boolean | null
): DocumentDatabaseFieldValue | undefined {
  if (column.type === 'select') {
    const normalizedCurrentValue = typeof currentValue === 'string' && column.options.includes(currentValue) ? currentValue : null
    const normalizedTargetValue = typeof targetValue === 'string' && column.options.includes(targetValue) ? targetValue : null

    return normalizedCurrentValue === normalizedTargetValue ? undefined : normalizedTargetValue
  }

  if (column.type === 'multi-select') {
    const normalizedCurrentValues = normalizeMultiSelectValues(column, currentValue)
    const normalizedTargetValues = typeof targetValue === 'string' && column.options.includes(targetValue)
      ? [...new Set([...normalizedCurrentValues, targetValue])]
      : []

    return areSameStringArrays(normalizedCurrentValues, normalizedTargetValues) ? undefined : normalizedTargetValues
  }

  if (column.type === 'checkbox') {
    const normalizedCurrentValue = currentValue === true
    const normalizedTargetValue = targetValue === true

    return normalizedCurrentValue === normalizedTargetValue ? undefined : normalizedTargetValue
  }

  return undefined
}

export function buildBoardColumns(documents: DocumentCatalogEntry[], groupByColumn: DocumentDatabaseColumn | null): BoardColumn[] {
  if (groupByColumn?.type === 'select') {
    const columns: BoardColumn[] = [
      {
        id: `${groupByColumn.id}:__unset__`,
        title: `No ${groupByColumn.name}`,
        dropTarget: {
          kind: 'field',
          columnId: groupByColumn.id,
          value: null
        },
        items: []
      },
      ...groupByColumn.options.map((option) => ({
        id: `${groupByColumn.id}:${option}`,
        title: option,
        dropTarget: {
          kind: 'field' as const,
          columnId: groupByColumn.id,
          value: option
        },
        items: [] as DocumentCatalogEntry[]
      }))
    ]

    const columnMap = new Map(columns.map((column) => [column.id, column]))
    for (const document of documents) {
      const fieldValue = document.fieldValues[groupByColumn.id]
      const columnId = typeof fieldValue === 'string' && groupByColumn.options.includes(fieldValue)
        ? `${groupByColumn.id}:${fieldValue}`
        : `${groupByColumn.id}:__unset__`
      columnMap.get(columnId)?.items.push(document)
    }

    return sortBoardColumns(columns)
  }

  if (groupByColumn?.type === 'multi-select') {
    const columns: BoardColumn[] = [
      {
        id: `${groupByColumn.id}:__unset__`,
        title: `No ${groupByColumn.name}`,
        dropTarget: {
          kind: 'field',
          columnId: groupByColumn.id,
          value: null
        },
        items: []
      },
      ...groupByColumn.options.map((option) => ({
        id: `${groupByColumn.id}:${option}`,
        title: option,
        dropTarget: {
          kind: 'field' as const,
          columnId: groupByColumn.id,
          value: option
        },
        items: [] as DocumentCatalogEntry[]
      }))
    ]

    const emptyColumn = columns[0]
    const columnMap = new Map(columns.map((column) => [column.id, column]))
    for (const document of documents) {
      const values = normalizeMultiSelectValues(groupByColumn, document.fieldValues[groupByColumn.id])

      if (values.length === 0) {
        emptyColumn.items.push(document)
        continue
      }

      for (const value of values) {
        columnMap.get(`${groupByColumn.id}:${value}`)?.items.push(document)
      }
    }

    return sortBoardColumns(columns)
  }

  if (groupByColumn?.type === 'checkbox') {
    const columns: BoardColumn[] = [
      {
        id: `${groupByColumn.id}:false`,
        title: 'No',
        dropTarget: {
          kind: 'field',
          columnId: groupByColumn.id,
          value: false
        },
        items: []
      },
      {
        id: `${groupByColumn.id}:true`,
        title: 'Yes',
        dropTarget: {
          kind: 'field',
          columnId: groupByColumn.id,
          value: true
        },
        items: []
      }
    ]

    for (const document of documents) {
      const fieldValue = document.fieldValues[groupByColumn.id] === true
      columns[fieldValue ? 1 : 0].items.push(document)
    }

    return sortBoardColumns(columns)
  }

  const rootColumnId = '__root__'
  const columnMap = new Map<string, BoardColumn>([
    [
      rootColumnId,
      {
        id: rootColumnId,
        title: 'Root',
        dropTarget: {
          kind: 'parent',
          parentId: null
        },
        items: []
      }
    ]
  ])

  for (const document of documents) {
    const key = document.parentId ?? rootColumnId
    if (!columnMap.has(key)) {
      columnMap.set(key, {
        id: key,
        title: document.parentTitle ?? 'Unknown parent',
        dropTarget: {
          kind: 'parent',
          parentId: document.parentId ?? null
        },
        items: []
      })
    }

    columnMap.get(key)?.items.push(document)
  }

  return [...columnMap.values()]
    .map((column) => ({
      ...column,
      items: [...column.items].sort((left, right) => left.path.localeCompare(right.path))
    }))
    .sort((left, right) => {
      if (left.dropTarget.kind === 'parent' && left.dropTarget.parentId === null) {
        return -1
      }
      if (right.dropTarget.kind === 'parent' && right.dropTarget.parentId === null) {
        return 1
      }
      return left.title.localeCompare(right.title)
    })
}

function normalizeMultiSelectValues(column: DocumentDatabaseColumn, value: DocumentDatabaseFieldValue): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return [...new Set(value.filter((item): item is string => typeof item === 'string' && column.options.includes(item)))]
}

function sortBoardColumns(columns: BoardColumn[]): BoardColumn[] {
  return columns.map((column) => ({
    ...column,
    items: [...column.items].sort((left, right) => left.path.localeCompare(right.path))
  }))
}

function areSameStringArrays(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}