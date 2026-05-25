import { useCallback, useMemo } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DatabaseEntity, DocumentDatabase, DocumentDatabaseColumnType, DocumentDatabaseFieldValue } from '@shared/contracts'
import type { UiText } from '../i18n'

type DatabaseWorkspaceView = 'catalog' | 'standalone'

type UseDatabaseWorkspaceActionsParams = {
  databaseEntityDatabaseId: string
  databaseDescriptionDraft: string
  databaseNameDraft: string
  databases: DocumentDatabase[]
  isDefaultDocumentDatabase: (database: DocumentDatabase) => boolean
  setBackupMessage: (message: string | null) => void
  setDatabaseColumnNameDraft: Dispatch<SetStateAction<string>>
  setDatabaseColumnOptionsDraft: Dispatch<SetStateAction<string>>
  setDatabaseColumnTypeDraft: Dispatch<SetStateAction<DocumentDatabaseColumnType>>
  setDatabaseDescriptionDraft: Dispatch<SetStateAction<string>>
  setDatabaseEntities: Dispatch<SetStateAction<DatabaseEntity[]>>
  setDatabaseEntityBulkFieldValues: Dispatch<SetStateAction<Record<string, DocumentDatabaseFieldValue>>>
  setDatabaseEntityDatabaseId: Dispatch<SetStateAction<string>>
  setDatabaseEntityDocumentId: Dispatch<SetStateAction<string>>
  setDatabaseEntityFieldValues: Dispatch<SetStateAction<Record<string, DocumentDatabaseFieldValue>>>
  setDatabaseNameDraft: Dispatch<SetStateAction<string>>
  setDatabaseWorkspaceView: Dispatch<SetStateAction<DatabaseWorkspaceView>>
  setDatabases: Dispatch<SetStateAction<DocumentDatabase[]>>
  setIsCreatingDatabase: Dispatch<SetStateAction<boolean>>
  setIsCreatingDatabaseColumn: Dispatch<SetStateAction<boolean>>
  setIsCreatingDatabaseEntity: Dispatch<SetStateAction<boolean>>
  setSelectedDatabaseEntityIds: Dispatch<SetStateAction<string[]>>
  ui: UiText
}

export function useDatabaseWorkspaceActions({
  databaseEntityDatabaseId,
  databaseDescriptionDraft,
  databaseNameDraft,
  databases,
  isDefaultDocumentDatabase,
  setBackupMessage,
  setDatabaseColumnNameDraft,
  setDatabaseColumnOptionsDraft,
  setDatabaseColumnTypeDraft,
  setDatabaseDescriptionDraft,
  setDatabaseEntities,
  setDatabaseEntityBulkFieldValues,
  setDatabaseEntityDatabaseId,
  setDatabaseEntityDocumentId,
  setDatabaseEntityFieldValues,
  setDatabaseNameDraft,
  setDatabaseWorkspaceView,
  setDatabases,
  setIsCreatingDatabase,
  setIsCreatingDatabaseColumn,
  setIsCreatingDatabaseEntity,
  setSelectedDatabaseEntityIds,
  ui
}: UseDatabaseWorkspaceActionsParams) {
  const selectedDatabase = useMemo(
    () => databases.find((database) => !isDefaultDocumentDatabase(database) && database.id === databaseEntityDatabaseId) ?? null,
    [databaseEntityDatabaseId, databases, isDefaultDocumentDatabase]
  )

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

  const resetDatabaseDrafts = useCallback(() => {
    setIsCreatingDatabase(false)
    setDatabaseNameDraft('')
    setDatabaseDescriptionDraft('')
  }, [setDatabaseDescriptionDraft, setDatabaseNameDraft, setIsCreatingDatabase])

  const resetEntityDrafts = useCallback(() => {
    setIsCreatingDatabaseEntity(false)
    setDatabaseEntityDocumentId('')
    setDatabaseEntityFieldValues({})
    setDatabaseEntityBulkFieldValues({})
    setSelectedDatabaseEntityIds([])
  }, [
    setDatabaseEntityBulkFieldValues,
    setDatabaseEntityDocumentId,
    setDatabaseEntityFieldValues,
    setIsCreatingDatabaseEntity,
    setSelectedDatabaseEntityIds
  ])

  const switchDatabaseWorkspaceView = useCallback((nextView: DatabaseWorkspaceView) => {
    setDatabaseWorkspaceView(nextView)
    resetColumnDrafts()
    resetDatabaseDrafts()
    resetEntityDrafts()
  }, [resetColumnDrafts, resetDatabaseDrafts, resetEntityDrafts, setDatabaseWorkspaceView])

  const createDatabase = useCallback(async () => {
    try {
      const createdDatabase = await window.knowbook.createDocumentDatabase({
        name: databaseNameDraft,
        description: databaseDescriptionDraft.trim() || undefined
      })
      const refreshedDatabases = await window.knowbook.getDatabases()
      setDatabases(refreshedDatabases)
      setDatabaseWorkspaceView('standalone')
      setDatabaseEntityDatabaseId(createdDatabase.id)
      setDatabaseEntities([])
      setIsCreatingDatabase(false)
      setIsCreatingDatabaseEntity(true)
      setDatabaseNameDraft('')
      setDatabaseDescriptionDraft('')
      setBackupMessage(ui.databaseCreated(createdDatabase.name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseCreateFailed
      setBackupMessage(message)
    }
  }, [
    databaseDescriptionDraft,
    databaseNameDraft,
    setBackupMessage,
    setDatabaseDescriptionDraft,
    setDatabaseEntities,
    setDatabaseEntityDatabaseId,
    setDatabaseNameDraft,
    setDatabaseWorkspaceView,
    setDatabases,
    setIsCreatingDatabase,
    setIsCreatingDatabaseEntity,
    ui
  ])

  const deleteCurrentDatabase = useCallback(async () => {
    if (!selectedDatabase) {
      return
    }

    if (!window.confirm(ui.confirmDeleteDatabase(selectedDatabase.name))) {
      return
    }

    try {
      await window.knowbook.deleteDatabase(selectedDatabase.id)
      const refreshedDatabases = await window.knowbook.getDatabases()
      setDatabases(refreshedDatabases)
      resetColumnDrafts()
      setIsCreatingDatabaseEntity(false)
      setDatabaseEntityDocumentId('')
      setDatabaseEntityFieldValues({})
      setDatabaseEntityBulkFieldValues({})
      setSelectedDatabaseEntityIds([])
      setBackupMessage(ui.databaseDeleted(selectedDatabase.name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseDeleteFailed
      setBackupMessage(message)
    }
  }, [
    resetColumnDrafts,
    selectedDatabase,
    setBackupMessage,
    setDatabaseEntityBulkFieldValues,
    setDatabaseEntityDocumentId,
    setDatabaseEntityFieldValues,
    setDatabases,
    setIsCreatingDatabaseEntity,
    setSelectedDatabaseEntityIds,
    ui
  ])

  return {
    createDatabase,
    deleteCurrentDatabase,
    switchDatabaseWorkspaceView
  }
}