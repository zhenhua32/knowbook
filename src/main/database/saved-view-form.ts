import type { DatabaseSavedView, DatabaseSavedViewFormResult } from '@shared/contracts'

type NameFailureReason = Extract<DatabaseSavedViewFormResult, { status: 'invalid-name' }>['reason']

export class DatabaseSavedViewNameError extends Error {
  constructor(readonly reason: NameFailureReason, message: string) {
    super(message)
  }
}

export function runDatabaseSavedViewForm(save: () => DatabaseSavedView): DatabaseSavedViewFormResult {
  try {
    return { status: 'saved', view: save() }
  } catch (error) {
    if (error instanceof DatabaseSavedViewNameError) {
      return { status: 'invalid-name', reason: error.reason, message: error.message }
    }
    throw error
  }
}
