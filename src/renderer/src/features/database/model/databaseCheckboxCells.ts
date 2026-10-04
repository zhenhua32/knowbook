import type { DocumentDatabaseFieldValue } from '@shared/contracts'
import type { DatabaseValueCommitResult } from './databaseTextDrafts'

export function checkboxCellChoices(value: DocumentDatabaseFieldValue): string[] {
  return value === true ? ['checked'] : []
}

export function checkboxCellSchema(): string {
  return JSON.stringify(['checkbox', []])
}

/** Encode the cache's empty choice as false, never as an unset database value. */
export function adaptCheckboxCellChange(
  change: (value: DocumentDatabaseFieldValue) => void | Promise<void | DatabaseValueCommitResult>
): (choices: DocumentDatabaseFieldValue) => void | Promise<void | DatabaseValueCommitResult> {
  return choices => {
    const result = change(Array.isArray(choices) && choices.includes('checked'))
    if (!result) return
    return result.then(saved => saved?.status === 'saved'
      ? { ...saved, value: checkboxCellChoices(saved.value) }
      : saved)
  }
}
