import type {
  DatabaseField,
  DatabaseFilterGroup,
  DatabaseFilterRule,
  DatabaseSavedViewLayoutMode,
  DatabaseSavedViewSortMode,
  DatabaseViewConfigV1,
  DocumentDatabaseFieldValue
} from './contracts'

export const DATABASE_SYSTEM_FIELD_IDS = {
  title: '__title__',
  path: '__path__',
  parent: '__parent__',
  document: '__document__',
  blockCount: '__block_count__',
  linkCount: '__link_count__',
  childCount: '__child_count__',
  createdAt: '__created_at__',
  updatedAt: '__updated_at__'
} as const

export const DEFAULT_DATABASE_VIEW_CONFIG_VERSION = 1 as const

export function createEmptyDatabaseFilterGroup(): DatabaseFilterGroup {
  return {
    operator: 'and',
    rules: []
  }
}

export function createDefaultDatabaseViewConfig(
  layout: DatabaseSavedViewLayoutMode = 'table',
  visibleFieldIds: string[] = [],
  fieldOrder: string[] = visibleFieldIds
): DatabaseViewConfigV1 {
  return {
    version: DEFAULT_DATABASE_VIEW_CONFIG_VERSION,
    layout,
    query: '',
    filters: createEmptyDatabaseFilterGroup(),
    sorts: [{ fieldId: DATABASE_SYSTEM_FIELD_IDS.updatedAt, direction: 'desc' }],
    groupBy: { fieldId: layout === 'board' ? DATABASE_SYSTEM_FIELD_IDS.parent : null },
    visibleFieldIds: [...visibleFieldIds],
    fieldOrder: [...fieldOrder],
    columnWidths: {},
    cardFieldIds: visibleFieldIds.slice(0, 4)
  }
}

export function createLegacyDatabaseViewConfig(input: {
  filterQuery?: string
  filterScope?: string
  sortMode?: DatabaseSavedViewSortMode
  viewMode?: DatabaseSavedViewLayoutMode
}): DatabaseViewConfigV1 {
  const sortMode = input.sortMode ?? 'updated-desc'
  const sortFieldId = sortMode.startsWith('created-')
    ? DATABASE_SYSTEM_FIELD_IDS.createdAt
    : DATABASE_SYSTEM_FIELD_IDS.updatedAt
  const direction = sortMode.endsWith('-asc') ? 'asc' : 'desc'
  const filterScope = input.filterScope?.trim() ?? ''
  const query = input.filterQuery ?? ''
  const rules: DatabaseFilterRule[] = query && filterScope
    ? [{
        id: `legacy-${filterScope}`,
        fieldId: filterScope,
        operator: 'contains',
        value: query
      }]
    : []

  return {
    ...createDefaultDatabaseViewConfig(input.viewMode ?? 'cards'),
    query: filterScope ? '' : query,
    filters: {
      operator: 'and',
      rules
    },
    sorts: [{ fieldId: sortFieldId, direction }]
  }
}

export function normalizeDatabaseViewConfig(
  value: unknown,
  fallback: DatabaseViewConfigV1 = createDefaultDatabaseViewConfig()
): DatabaseViewConfigV1 {
  if (!isRecord(value) || value.version !== DEFAULT_DATABASE_VIEW_CONFIG_VERSION) {
    return cloneDatabaseViewConfig(fallback)
  }

  const layout = normalizeLayout(value.layout, fallback.layout)
  const query = typeof value.query === 'string' ? value.query : fallback.query
  const filters = normalizeFilterGroup(value.filters)
  const sorts = Array.isArray(value.sorts)
    ? value.sorts.flatMap((sort) => {
        if (!isRecord(sort) || typeof sort.fieldId !== 'string') {
          return []
        }
        return [{
          fieldId: sort.fieldId,
          direction: sort.direction === 'asc' ? 'asc' as const : 'desc' as const
        }]
      })
    : fallback.sorts
  const groupBy = isRecord(value.groupBy) && (typeof value.groupBy.fieldId === 'string' || value.groupBy.fieldId === null)
    ? { fieldId: value.groupBy.fieldId as string | null }
    : fallback.groupBy

  return {
    version: DEFAULT_DATABASE_VIEW_CONFIG_VERSION,
    layout,
    query,
    filters,
    sorts: sorts.length > 0 ? sorts : [...fallback.sorts],
    groupBy,
    visibleFieldIds: normalizeStringArray(value.visibleFieldIds, fallback.visibleFieldIds),
    fieldOrder: normalizeStringArray(value.fieldOrder, fallback.fieldOrder),
    columnWidths: normalizeColumnWidths(value.columnWidths),
    cardFieldIds: normalizeStringArray(value.cardFieldIds, fallback.cardFieldIds)
  }
}

export function repairDatabaseViewConfig(
  config: DatabaseViewConfigV1,
  fields: DatabaseField[]
): DatabaseViewConfigV1 {
  const validFieldIds = new Set(fields.map((field) => field.id))
  const titleFieldId = fields.find((field) => field.role === 'title')?.id ?? DATABASE_SYSTEM_FIELD_IDS.title
  const newlyAddedPropertyFieldIds = fields
    .filter((field) => field.role === 'property' && !config.fieldOrder.includes(field.id))
    .map((field) => field.id)
  const visibleFieldIds = uniqueIds([
    titleFieldId,
    ...config.visibleFieldIds.filter((fieldId) => validFieldIds.has(fieldId)),
    ...newlyAddedPropertyFieldIds
  ])
  const fieldOrder = uniqueIds([
    titleFieldId,
    ...config.fieldOrder.filter((fieldId) => validFieldIds.has(fieldId)),
    ...visibleFieldIds,
    ...newlyAddedPropertyFieldIds
  ])
  const filters = repairFilterGroup(config.filters, validFieldIds)
  const sorts = config.sorts.filter((sort) => validFieldIds.has(sort.fieldId))
  const groupByFieldId = config.groupBy.fieldId

  return {
    ...config,
    filters,
    sorts: sorts.length > 0
      ? sorts
      : [{ fieldId: DATABASE_SYSTEM_FIELD_IDS.updatedAt, direction: 'desc' }],
    groupBy: {
      fieldId: groupByFieldId && validFieldIds.has(groupByFieldId) ? groupByFieldId : null
    },
    visibleFieldIds,
    fieldOrder,
    columnWidths: Object.fromEntries(
      Object.entries(config.columnWidths).filter(([fieldId]) => validFieldIds.has(fieldId))
    ),
    cardFieldIds: config.cardFieldIds.filter((fieldId) => validFieldIds.has(fieldId)).slice(0, 4)
  }
}

export function cloneDatabaseViewConfig(config: DatabaseViewConfigV1): DatabaseViewConfigV1 {
  return {
    ...config,
    filters: cloneFilterGroup(config.filters),
    sorts: config.sorts.map((sort) => ({ ...sort })),
    groupBy: { ...config.groupBy },
    visibleFieldIds: [...config.visibleFieldIds],
    fieldOrder: [...config.fieldOrder],
    columnWidths: { ...config.columnWidths },
    cardFieldIds: [...config.cardFieldIds]
  }
}

export function areDatabaseViewConfigsEqual(left: DatabaseViewConfigV1, right: DatabaseViewConfigV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function normalizeLayout(value: unknown, fallback: DatabaseSavedViewLayoutMode): DatabaseSavedViewLayoutMode {
  return value === 'table' || value === 'board' || value === 'cards' ? value : fallback
}

function normalizeFilterGroup(value: unknown): DatabaseFilterGroup {
  if (!isRecord(value) || !Array.isArray(value.rules)) {
    return createEmptyDatabaseFilterGroup()
  }

  const rules: DatabaseFilterGroup['rules'] = []
  for (const rule of value.rules) {
    if (isRecord(rule) && Array.isArray(rule.rules)) {
      rules.push(normalizeFilterGroup(rule))
      continue
    }
    const normalizedRule = normalizeFilterRule(rule)
    if (normalizedRule) {
      rules.push(normalizedRule)
    }
  }

  return {
    operator: value.operator === 'or' ? 'or' : 'and',
    rules
  }
}

function normalizeFilterRule(value: unknown): DatabaseFilterRule | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.fieldId !== 'string' || typeof value.operator !== 'string') {
    return null
  }

  return {
    id: value.id,
    fieldId: value.fieldId,
    operator: value.operator as DatabaseFilterRule['operator'],
    value: normalizeFilterValue(value.value)
  }
}

function normalizeFilterValue(value: unknown): DatabaseFilterRule['value'] {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[] | [string, string]
  }
  return undefined
}

function repairFilterGroup(group: DatabaseFilterGroup, validFieldIds: Set<string>): DatabaseFilterGroup {
  const rules: DatabaseFilterGroup['rules'] = []
  for (const rule of group.rules) {
    if ('rules' in rule) {
      const repaired = repairFilterGroup(rule, validFieldIds)
      if (repaired.rules.length > 0) {
        rules.push(repaired)
      }
      continue
    }
    if (validFieldIds.has(rule.fieldId)) {
      rules.push({ ...rule })
    }
  }

  return {
    operator: group.operator,
    rules
  }
}

function cloneFilterGroup(group: DatabaseFilterGroup): DatabaseFilterGroup {
  return {
    operator: group.operator,
    rules: group.rules.map((rule) => 'rules' in rule
      ? cloneFilterGroup(rule)
      : { ...rule, value: cloneFilterValue(rule.value) })
  }
}

function cloneFilterValue(value: DatabaseFilterRule['value']): DatabaseFilterRule['value'] {
  return Array.isArray(value) ? [...value] as string[] | [string, string] : value
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? uniqueIds(value)
    : [...fallback]
}

function normalizeColumnWidths(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([fieldId, width]) => (
      typeof width === 'number' && Number.isFinite(width) && width >= 80 && width <= 1200
        ? [[fieldId, Math.round(width)]]
        : []
    ))
  )
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function formatDatabaseRecordValueForSearch(value: DocumentDatabaseFieldValue | number | undefined): string {
  if (Array.isArray(value)) {
    return value.join(' ')
  }
  if (typeof value === 'boolean') {
    return value ? 'checked true yes' : 'unchecked false no'
  }
  return value === null || value === undefined ? '' : String(value)
}
