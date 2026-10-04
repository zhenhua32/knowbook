import type { DocumentDatabaseFieldValue } from '@shared/contracts'
import type { DatabaseValueCommitResult } from './databaseTextDrafts'

export function selectCellChoices(value: DocumentDatabaseFieldValue): string[] {
  return typeof value === 'string' && value !== '' ? [value] : []
}

export function selectCellSchema(options: string[]): string {
  return JSON.stringify(['select', options])
}

/** Keep scalar persistence intact while sharing the choice cache's physical locks. */
export function adaptSelectCellChange(
  change: (value: DocumentDatabaseFieldValue) => void | Promise<void | DatabaseValueCommitResult>
): (choices: DocumentDatabaseFieldValue) => void | Promise<void | DatabaseValueCommitResult> {
  return choices => {
    const result = change(Array.isArray(choices) ? choices[0] ?? null : null)
    if (!result) return
    return result.then(saved => saved?.status === 'saved'
      ? { ...saved, value: selectCellChoices(saved.value) }
      : saved)
  }
}
