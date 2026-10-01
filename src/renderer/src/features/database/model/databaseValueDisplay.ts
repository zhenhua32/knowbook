import type { DatabaseField } from '@shared/contracts'

export function formatDatabaseValueDisplay(field: Pick<DatabaseField, 'type'>, value: unknown, locale = 'en-US'): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.join(' · ')
  if (typeof value === 'boolean') return value ? '✓' : '—'
  if (field.type !== 'date' || typeof value !== 'string') return String(value)

  const calendarDay = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const datePrefix = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(value)?.[1]
  // Date properties are calendar days. Validate them separately so parsing does
  // not shift a day west of UTC or silently roll an invalid day into next month.
  if (!datePrefix || !isValidCalendarDay(datePrefix)) return value
  const date = new Date(calendarDay ? `${value}T00:00:00.000Z` : value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleDateString(locale, calendarDay ? { timeZone: 'UTC' } : undefined)
}

function isValidCalendarDay(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
