import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentDatabase, DocumentDatabaseColumnType } from '@shared/contracts'
import type { UiText } from '../i18n'

type DatabaseWorkspaceView = 'catalog' | 'standalone'

type UseDatabaseColumnActionsParams = {
  databaseColumnNameDraft: string
  databaseColumnOptionsDraft: string
  databaseColumnTypeDraft: DocumentDatabaseColumnType
  databaseWorkspaceView: DatabaseWorkspaceView
  normalizeDatabaseColumnOptionsInput: (input: string) => string[]
  refreshDatabasePageData: (targetDatabaseId?: string | null, preferredSavedViewId?: string) => Promise<void>
  refreshDocumentCatalogData: () => Promise<void>
  selectedDatabase: DocumentDatabase | null
  setBackupMessage: (message: string | null) => void
  setDatabaseColumnNameDraft: Dispatch<SetStateAction<string>>
  setDatabaseColumnOptionsDraft: Dispatch<SetStateAction<string>>
  setDatabaseColumnTypeDraft: Dispatch<SetStateAction<DocumentDatabaseColumnType>>
  setIsCreatingDatabaseColumn: Dispatch<SetStateAction<boolean>>
  ui: UiText
}

export function useDatabaseColumnActions({
  databaseColumnNameDraft,
  databaseColumnOptionsDraft,
  databaseColumnTypeDraft,
  databaseWorkspaceView,
  normalizeDatabaseColumnOptionsInput,
  refreshDatabasePageData,
  refreshDocumentCatalogData,
  selectedDatabase,
  setBackupMessage,
  setDatabaseColumnNameDraft,
  setDatabaseColumnOptionsDraft,
  setDatabaseColumnTypeDraft,
  setIsCreatingDatabaseColumn,
  ui
}: UseDatabaseColumnActionsParams) {
  const resetColumnDrafts = useCallback(() => {
    setIsCreatingDatabaseColumn(false)
    setDatabaseColumnNameDraft('')
    setDatabaseColumnTypeDraft('text')
    setDatabaseColumnOptionsDraft('')
  }, [
    setDatabaseColumnNameDraft,
    setDatabaseColumnOptionsDraft,
    setDatabaseColumnTypeDraft,
    setIsCreatingDatabaseColumn
  ])

  const refreshCurrentDatabaseSurface = useCallback(async () => {
    if (databaseWorkspaceView === 'catalog') {
      await refreshDocumentCatalogData()
      return
    }

    await refreshDatabasePageData()
  }, [databaseWorkspaceView, refreshDatabasePageData, refreshDocumentCatalogData])

  const createDatabaseColumn = useCallback(async () => {
    if (databaseWorkspaceView === 'standalone' && !selectedDatabase) {
      setBackupMessage(ui.noIndependentDatabasesYet)
      return
    }

    try {
      const createdColumn = await window.knowbook.createDocumentDatabaseColumn({
        databaseId: databaseWorkspaceView === 'standalone' ? selectedDatabase?.id : undefined,
        name: databaseColumnNameDraft,
        type: databaseColumnTypeDraft,
        options: normalizeDatabaseColumnOptionsInput(databaseColumnOptionsDraft)
      })
      await refreshCurrentDatabaseSurface()
      resetColumnDrafts()
      setBackupMessage(ui.databaseColumnAdded(createdColumn.name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseColumnCreateFailed
      setBackupMessage(message)
    }
  }, [
    databaseColumnNameDraft,
    databaseColumnOptionsDraft,
    databaseColumnTypeDraft,
    databaseWorkspaceView,
    normalizeDatabaseColumnOptionsInput,
    refreshCurrentDatabaseSurface,
    resetColumnDrafts,
    selectedDatabase,
    setBackupMessage,
    ui
  ])

  const renameDatabaseColumn = useCallback(async (columnId: string, name: string) => {
    try {
      await window.knowbook.renameDocumentDatabaseColumn({ columnId, name })
      await refreshCurrentDatabaseSurface()
      setBackupMessage(ui.databaseColumnRenamed(name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseColumnRenameFailed
      setBackupMessage(message)
    }
  }, [refreshCurrentDatabaseSurface, setBackupMessage, ui])

  const moveDatabaseColumn = useCallback(async (columnId: string, direction: 'left' | 'right') => {
    try {
      await window.knowbook.moveDocumentDatabaseColumn({ columnId, direction })
      await refreshCurrentDatabaseSurface()
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseColumnReorderFailed
      setBackupMessage(message)
    }
  }, [refreshCurrentDatabaseSurface, setBackupMessage, ui])

  const updateDatabaseColumnOptions = useCallback(async (columnId: string, optionsInput: string) => {
    const options = normalizeDatabaseColumnOptionsInput(optionsInput)

    try {
      await window.knowbook.updateDocumentDatabaseColumnOptions({ columnId, options })
      await refreshCurrentDatabaseSurface()
      setBackupMessage(ui.databaseColumnOptionsUpdated)
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseColumnOptionsUpdateFailed
      setBackupMessage(message)
    }
  }, [normalizeDatabaseColumnOptionsInput, refreshCurrentDatabaseSurface, setBackupMessage, ui])

  const deleteDatabaseColumn = useCallback(async (columnId: string, columnName: string) => {
    const accepted = window.confirm(ui.confirmDeleteDatabaseColumn(columnName))
    if (!accepted) {
      return
    }

    try {
      await window.knowbook.deleteDocumentDatabaseColumn(columnId)
      await refreshCurrentDatabaseSurface()
      setBackupMessage(ui.databaseColumnDeleted(columnName))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseColumnDeleteFailed
      setBackupMessage(message)
    }
  }, [refreshCurrentDatabaseSurface, setBackupMessage, ui])

  return {
    createDatabaseColumn,
    deleteDatabaseColumn,
    moveDatabaseColumn,
    renameDatabaseColumn,
    updateDatabaseColumnOptions
  }
}