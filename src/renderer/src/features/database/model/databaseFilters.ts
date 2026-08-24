import type {
  DatabaseField,
  DatabaseFilterGroup,
  DatabaseFilterRule,
  DatabaseRecord,
  DatabaseRecordValue,
  DatabaseViewSort
} from '@shared/contracts'
import { formatDatabaseRecordValueForSearch } from '@shared/database-workspace'

export function applyDatabaseView(
  records: DatabaseRecord[],
  fields: DatabaseField[],
  query: string,
  filters: DatabaseFilterGroup,
  sorts: DatabaseViewSort[]
): DatabaseRecord[] {
  const searchableFieldIds = new Set(fields.map((field) => field.id))
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = records.filter((record) => {
    if (normalizedQuery) {
      const haystack = [
        record.title,
        ...Object.entries(record.fieldValues)
          .filter(([fieldId]) => searchableFieldIds.has(fieldId))
          .map(([, value]) => formatDatabaseRecordValueForSearch(value))
      ].join(' ').toLocaleLowerCase()
      if (!haystack.includes(normalizedQuery)) {
        return false
      }
    }
    return matchesFilterGroup(record, filters)
  })

  return [...filtered].sort((left, right) => compareRecords(left, right, sorts))
}

export function groupDatabaseRecords(
  records: DatabaseRecord[],
  fieldId: string | null
): Array<{ id: string; label: string; records: DatabaseRecord[] }> {
  if (!fieldId) {
    return [{ id: '__all__', label: '全部记录', records }]
  }

  const groups = new Map<string, { label: string; records: DatabaseRecord[] }>()
  for (const record of records) {
    const value = getRecordValue(record, fieldId)
    const groupValues = Array.isArray(value) ? value : [value]
    const normalizedValues = groupValues.length > 0 ? groupValues : [null]
    for (const groupValue of normalizedValues) {
      const group = formatGroup(groupValue)
      const grouped = groups.get(group.id) ?? { label: group.label, records: [] }
      grouped.records.push(record)
      groups.set(group.id, grouped)
    }
  }

  return [...groups.entries()]
    .sort(([leftId, left], [rightId, right]) => leftId === '__ungrouped__' ? 1 : rightId === '__ungrouped__' ? -1 : left.label.localeCompare(right.label))
    .map(([id, group]) => ({ id, label: group.label, records: group.records }))
}

export function getRecordValue(record: DatabaseRecord, fieldId: string): DatabaseRecordValue | undefined {
  return fieldId === '__title__' ? record.title : record.fieldValues[fieldId]
}

function matchesFilterGroup(record: DatabaseRecord, group: DatabaseFilterGroup): boolean {
  if (group.rules.length === 0) {
    return true
  }
  const results = group.rules.map((rule) => 'rules' in rule
    ? matchesFilterGroup(record, rule)
    : matchesFilterRule(record, rule))
  return group.operator === 'or' ? results.some(Boolean) : results.every(Boolean)
}

function matchesFilterRule(record: DatabaseRecord, rule: DatabaseFilterRule): boolean {
  const value = getRecordValue(record, rule.fieldId)
  const expected = rule.value
  const valueText = formatDatabaseRecordValueForSearch(value).toLocaleLowerCase()
  const expectedText = formatDatabaseRecordValueForSearch(expected as DatabaseRecordValue | undefined).toLocaleLowerCase()
  const empty = value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)

  switch (rule.operator) {
    case 'contains': return valueText.includes(expectedText)
    case 'not-contains': return !valueText.includes(expectedText)
    case 'equals': return compareValue(value, expected) === 0
    case 'not-equals': return compareValue(value, expected) !== 0
    case 'is-empty': return empty
    case 'is-not-empty': return !empty
    case 'contains-any': return Array.isArray(value) && Array.isArray(expected) && expected.some((item) => value.includes(item))
    case 'contains-all': return Array.isArray(value) && Array.isArray(expected) && expected.every((item) => value.includes(item))
    case 'before': return compareValue(value, expected) < 0
    case 'after': return compareValue(value, expected) > 0
    case 'between': return Array.isArray(expected) && compareValue(value, expected[0]) >= 0 && compareValue(value, expected[1]) <= 0
    case 'is-checked': return value === true
    case 'is-not-checked': return value !== true
    case 'greater-than': return compareValue(value, expected) > 0
    case 'less-than': return compareValue(value, expected) < 0
    default: return true
  }
}

function compareRecords(left: DatabaseRecord, right: DatabaseRecord, sorts: DatabaseViewSort[]): number {
  for (const sort of sorts) {
    const comparison = compareValue(getRecordValue(left, sort.fieldId), getRecordValue(right, sort.fieldId))
    if (comparison !== 0) {
      return sort.direction === 'asc' ? comparison : -comparison
    }
  }
  return left.title.localeCompare(right.title)
}

function compareValue(left: unknown, right: unknown): number {
  if (left === right) return 0
  if (left === null || left === undefined || left === '') return 1
  if (right === null || right === undefined || right === '') return -1
  if (typeof left === 'number' && typeof right === 'number') return left - right
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right)
  const leftText = Array.isArray(left) ? left.join('\u0000') : String(left)
  const rightText = Array.isArray(right) ? right.join('\u0000') : String(right)
  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: 'base' })
}

function formatGroup(value: DatabaseRecordValue | undefined): { id: string; label: string } {
  if (value === null || value === undefined || value === '') return { id: '__ungrouped__', label: '未分组' }
  if (typeof value === 'boolean') return { id: value ? '__checked__' : '__unchecked__', label: value ? '已勾选' : '未勾选' }
  return { id: `value:${String(value)}`, label: String(value) }
}
