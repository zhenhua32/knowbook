import type { DocumentDatabaseFieldValue } from '@shared/contracts'

export type DatabaseDeletion = { databaseId: string } & (
  | { kind: 'database' | 'view' | 'field' | 'record'; id: string }
  | { kind: 'records'; ids: string[] }
)

export function withoutDatabaseField(values: Record<string, DocumentDatabaseFieldValue>, fieldId: string) {
  const next = { ...values }
  delete next[fieldId]
  return next
}
