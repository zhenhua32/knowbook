import type { DatabaseFilterGroup, DatabaseFilterOperator, DatabaseFilterRule, DatabaseViewConfigV1 } from './contracts'
import { DATABASE_SYSTEM_FIELD_IDS } from './database-workspace'
import { parseStrictJson } from './strictJson'
import { isContainerBlockType, isColumnBlockType } from './blockTypes'

export const DATABASE_VIEW_FENCE_INFO = 'knowbook-database-view-v1'
export const DATABASE_VIEW_MAX_BYTES = 128 * 1024
const MAX_FILTER_DEPTH = 8, MAX_FILTER_NODES = 256, MAX_IDS = 2048
const systemFields = new Set<string>(Object.values(DATABASE_SYSTEM_FIELD_IDS))
const unsafeIds = new Set(['__proto__', 'prototype', 'constructor'])
const operators = new Set<DatabaseFilterOperator>(['contains', 'not-contains', 'equals', 'not-equals', 'is-empty', 'is-not-empty',
  'contains-any', 'contains-all', 'before', 'after', 'between', 'is-checked', 'is-not-checked', 'greater-than', 'less-than'])

export interface DatabaseViewBlockPayloadV1 {
  version: 1
  databaseId: string
  viewId: string | null
  config: DatabaseViewConfigV1
}
export interface DatabaseViewReferenceResolver {
  databaseId?: (sourceId: string) => string
  viewId?: (sourceDatabaseId: string, sourceViewId: string) => string
  fieldId?: (sourceDatabaseId: string, sourceFieldId: string) => string
}

function fail(): never { throw new Error('数据库视图引用或配置无效，未修改正文。') }
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
}
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail()
}
export function isDatabaseViewReferenceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) && !unsafeIds.has(value)
}
function id(value: unknown, field = false): string {
  if (!isDatabaseViewReferenceId(value) || field && value.startsWith('__') && !systemFields.has(value)) return fail()
  return value
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDS) return fail()
  const result = value.map(item => id(item, true))
  if (new Set(result).size !== result.length) return fail()
  return result
}
function bounded(value: unknown): void {
  const json = JSON.stringify(value)
  if (json.length > DATABASE_VIEW_MAX_BYTES || new TextEncoder().encode(json).byteLength > DATABASE_VIEW_MAX_BYTES) fail()
}

/** Strict authored configuration. It never repairs missing fields or filters. */
export function validateDatabaseViewConfig(value: unknown): DatabaseViewConfigV1 {
  shape(value, ['version', 'layout', 'query', 'filters', 'sorts', 'groupBy', 'visibleFieldIds', 'fieldOrder', 'columnWidths', 'cardFieldIds'])
  if (value.version !== 1 || !['table', 'cards', 'board'].includes(value.layout as string) || typeof value.query !== 'string') return fail()
  let nodes = 0
  const ruleIds = new Set<string>()
  const filter = (group: unknown, depth: number): DatabaseFilterGroup => {
    shape(group, ['operator', 'rules'])
    if (depth > MAX_FILTER_DEPTH || !['and', 'or'].includes(group.operator as string) || !Array.isArray(group.rules)) return fail()
    return { operator: group.operator as 'and' | 'or', rules: group.rules.map((rule: unknown) => {
      if (++nodes > MAX_FILTER_NODES) return fail()
      if (record(rule) && Object.hasOwn(rule, 'rules')) return filter(rule, depth + 1)
      shape(rule, ['id', 'fieldId', 'operator'], ['value'])
      if (!operators.has(rule.operator as DatabaseFilterOperator)) return fail()
      const data = rule.value
      if (data !== undefined && data !== null && typeof data !== 'string' && typeof data !== 'boolean'
        && !(typeof data === 'number' && Number.isFinite(data))
        && !(Array.isArray(data) && data.length <= MAX_IDS && data.every(item => typeof item === 'string'))) return fail()
      const ruleId = id(rule.id)
      if (ruleIds.has(ruleId)) return fail()
      ruleIds.add(ruleId)
      return { id: ruleId, fieldId: id(rule.fieldId, true), operator: rule.operator as DatabaseFilterOperator,
        ...(data === undefined ? {} : { value: Array.isArray(data) ? [...data] : data }) } as DatabaseFilterRule
    }) }
  }
  if (!Array.isArray(value.sorts) || value.sorts.length > MAX_IDS) return fail()
  const sorts = value.sorts.map((sort): DatabaseViewConfigV1['sorts'][number] => {
    shape(sort, ['fieldId', 'direction'])
    if (sort.direction !== 'asc' && sort.direction !== 'desc') return fail()
    return { fieldId: id(sort.fieldId, true), direction: sort.direction }
  })
  if (new Set(sorts.map(sort => sort.fieldId)).size !== sorts.length) return fail()
  shape(value.groupBy, ['fieldId'])
  if (!record(value.columnWidths) || Object.keys(value.columnWidths).length > MAX_IDS) return fail()
  const columnWidths: Record<string, number> = {}
  for (const [key, width] of Object.entries(value.columnWidths)) {
    id(key, true)
    if (typeof width !== 'number' || !Number.isSafeInteger(width) || width < 80 || width > 1200) return fail()
    columnWidths[key] = width
  }
  const config: DatabaseViewConfigV1 = {
    version: 1, layout: value.layout as DatabaseViewConfigV1['layout'], query: value.query,
    filters: filter(value.filters, 1), sorts,
    groupBy: { fieldId: value.groupBy.fieldId === null ? null : id(value.groupBy.fieldId, true) },
    visibleFieldIds: ids(value.visibleFieldIds), fieldOrder: ids(value.fieldOrder), columnWidths, cardFieldIds: ids(value.cardFieldIds)
  }
  bounded(config)
  return config
}

function payload(value: unknown): DatabaseViewBlockPayloadV1 {
  shape(value, ['version', 'databaseId', 'viewId', 'config'])
  if (value.version !== 1) return fail()
  const result: DatabaseViewBlockPayloadV1 = { version: 1, databaseId: id(value.databaseId),
    viewId: value.viewId === null ? null : id(value.viewId), config: validateDatabaseViewConfig(value.config) }
  bounded(result)
  return result
}
export function parseDatabaseViewPayload(content: string): DatabaseViewBlockPayloadV1 {
  return payload(parseStrictJson(content, { maxBytes: DATABASE_VIEW_MAX_BYTES, maxDepth: 32 }))
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => record(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
}
export function serializeDatabaseViewPayload(value: DatabaseViewBlockPayloadV1): string { return canonical(payload(value)) }

export function validateDatabaseViewBlock(block: { type: string; content: string; checked?: boolean; language?: unknown;
  listStart?: unknown; markdownFormat?: unknown }): void {
  if (block.type !== 'database-view' || block.checked !== undefined && block.checked !== false
    || block.language !== undefined || block.listStart !== undefined || block.markdownFormat !== undefined) fail()
  parseDatabaseViewPayload(block.content)
}

/** Validate atoms before normalizers can discard an invalid authored property
 * or repair their ownership. Other historical block types retain their rules. */
export function assertDatabaseViewStructure(blocks: readonly { id?: string; type: string; content: string; depth?: number;
  parentBlockId?: string | null; checked?: boolean; language?: unknown; listStart?: unknown; markdownFormat?: unknown }[]): void {
  if (!blocks.some(block => block.type === 'database-view')) return
  const active: typeof blocks[number][] = []
  const atomIds = new Set(blocks.filter(block => block.type === 'database-view').map(block => block.id).filter(Boolean))
  for (const block of blocks) {
    const depth = block.depth ?? 0, parent = depth > 0 ? active[depth - 1] : undefined
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 6) fail()
    if (block.parentBlockId && atomIds.has(block.parentBlockId) || parent?.type === 'database-view') fail()
    if (block.type === 'database-view') {
      validateDatabaseViewBlock(block)
      if (!Number.isSafeInteger(depth) || depth < 0 || depth > 6
        || depth === 0 && block.parentBlockId != null
        || depth > 0 && (!parent || !isContainerBlockType(parent.type) && !isColumnBlockType(parent.type))
        || block.parentBlockId != null && block.parentBlockId !== parent?.id) fail()
    }
    active.length = Math.max(0, depth); active[depth] = block
  }
}

export function mapDatabaseViewConfigFieldIds(config: DatabaseViewConfigV1, mapper: (fieldId: string) => string): DatabaseViewConfigV1 {
  const before = validateDatabaseViewConfig(config)
  const mapped = new Map<string, string>(), owners = new Map<string, string>()
  const resolve = (sourceId: string): string => {
    const existing = mapped.get(sourceId)
    if (existing !== undefined) return existing
    const targetId = id(mapper(sourceId), true)
    if (systemFields.has(sourceId) && targetId !== sourceId || owners.has(targetId) && owners.get(targetId) !== sourceId) return fail()
    mapped.set(sourceId, targetId); owners.set(targetId, sourceId)
    return targetId
  }
  const filter = (group: DatabaseFilterGroup): DatabaseFilterGroup => ({ ...group,
    rules: group.rules.map(rule => 'rules' in rule ? filter(rule) : { ...rule, fieldId: resolve(rule.fieldId) }) })
  const result = { ...before, filters: filter(before.filters),
    sorts: before.sorts.map(sort => ({ ...sort, fieldId: resolve(sort.fieldId) })),
    groupBy: { fieldId: before.groupBy.fieldId === null ? null : resolve(before.groupBy.fieldId) },
    visibleFieldIds: before.visibleFieldIds.map(resolve), fieldOrder: before.fieldOrder.map(resolve),
    columnWidths: Object.fromEntries(Object.entries(before.columnWidths).map(([key, width]) => [resolve(key), width])),
    cardFieldIds: before.cardFieldIds.map(resolve) }
  if (Object.keys(result.columnWidths).length !== Object.keys(before.columnWidths).length) fail()
  return validateDatabaseViewConfig(result)
}
export function collectDatabaseViewConfigFieldIds(config: DatabaseViewConfigV1): Set<string> {
  const result = new Set<string>()
  mapDatabaseViewConfigFieldIds(config, fieldId => { result.add(fieldId); return fieldId })
  return result
}
export function collectDatabaseViewFieldIds(value: DatabaseViewBlockPayloadV1): Set<string> {
  return collectDatabaseViewConfigFieldIds(payload(value).config)
}
export function mapDatabaseViewReferences(value: DatabaseViewBlockPayloadV1, resolver: DatabaseViewReferenceResolver): DatabaseViewBlockPayloadV1 {
  const before = payload(value), source = before.databaseId
  return payload({ ...before, databaseId: resolver.databaseId ? resolver.databaseId(source) : source,
    viewId: before.viewId === null ? null : resolver.viewId ? resolver.viewId(source, before.viewId) : before.viewId,
    config: resolver.fieldId ? mapDatabaseViewConfigFieldIds(before.config, fieldId => resolver.fieldId!(source, fieldId)) : before.config })
}
