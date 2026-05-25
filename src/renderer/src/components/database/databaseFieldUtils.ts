import type { DocumentDatabaseFieldValue } from '@shared/contracts'

export function normalizeDatabaseColumnOptionsInput(input: string): string[] {
  return [...new Set(input.split(',').map((option) => option.trim()).filter(Boolean))]
}

export function formatDocumentDatabaseFieldValueForDraft(value: DocumentDatabaseFieldValue): string {
  if (Array.isArray(value)) {
    return value.join(', ')
  }

  return typeof value === 'string' ? value : ''
}

export function normalizeDocumentDatabaseFieldValue(value: DocumentDatabaseFieldValue): DocumentDatabaseFieldValue {
  if (Array.isArray(value)) {
    const normalizedValues = [...new Set(value.map((item) => item.trim()).filter(Boolean))]
    return normalizedValues.length > 0 ? normalizedValues : null
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim()
    return normalizedValue.length > 0 ? normalizedValue : null
  }

  return value
}

export function areDocumentDatabaseFieldValuesEqual(left: DocumentDatabaseFieldValue, right: DocumentDatabaseFieldValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    const leftValues = Array.isArray(left) ? [...left].sort() : []
    const rightValues = Array.isArray(right) ? [...right].sort() : []

    if (leftValues.length !== rightValues.length) {
      return false
    }

    return leftValues.every((value, index) => value === rightValues[index])
  }

  return left === right
}

export function formatDocumentCatalogFieldValueForDisplay(value: DocumentDatabaseFieldValue): string {
  if (Array.isArray(value)) {
    return value.join(', ')
  }

  if (typeof value === 'boolean') {
    return value ? 'True' : 'False'
  }

  return value ?? ''
}

export function compactDocumentDatabaseFieldValues(values: Record<string, DocumentDatabaseFieldValue>): Record<string, DocumentDatabaseFieldValue> {
  const compacted: Record<string, DocumentDatabaseFieldValue> = {}

  for (const [columnId, value] of Object.entries(values)) {
    const normalizedValue = normalizeDocumentDatabaseFieldValue(value)
    if (normalizedValue !== null) {
      compacted[columnId] = normalizedValue
    }
  }

  return compacted
}