import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentDatabaseFieldValue } from '@shared/contracts'
import type { UiText } from '../i18n'
import { normalizeDocumentDatabaseFieldValue } from '../components/database/databaseFieldUtils'

type UseDatabaseEntityBulkActionsParams = {
  databaseEntityBulkFieldValues: Record<string, DocumentDatabaseFieldValue>
  databaseEntityDatabaseId: string
  filteredStandaloneDatabaseEntityIds: string[]
  refreshDatabasePageData: (targetDatabaseId?: string | null, preferredSavedViewId?: string) => Promise<void>
  selectedVisibleDatabaseEntityIds: string[]
  setBackupMessage: (message: string | null) => void
  setDatabaseEntityBulkFieldValues: Dispatch<SetStateAction<Record<string, DocumentDatabaseFieldValue>>>
  setSelectedDatabaseEntityIds: Dispatch<SetStateAction<string[]>>
  ui: UiText
}

export function useDatabaseEntityBulkActions({
  databaseEntityBulkFieldValues,
  databaseEntityDatabaseId,
  filteredStandaloneDatabaseEntityIds,
  refreshDatabasePageData,
  selectedVisibleDatabaseEntityIds,
  setBackupMessage,
  setDatabaseEntityBulkFieldValues,
  setSelectedDatabaseEntityIds,
  ui
}: UseDatabaseEntityBulkActionsParams) {
  const updateSelectedDatabaseEntities = useCallback(async (input: {
    fieldValues?: Record<string, DocumentDatabaseFieldValue>
    documentId?: string | null
  }) => {
    if (selectedVisibleDatabaseEntityIds.length === 0) {
      return
    }

    const entityIds = [...selectedVisibleDatabaseEntityIds]
    const count = entityIds.length

    try {
      await window.knowbook.updateDatabaseEntities({
        updates: entityIds.map((entityId) => ({
          entityId,
          fieldValues: input.fieldValues,
          documentId: input.documentId
        }))
      })

      await refreshDatabasePageData(databaseEntityDatabaseId)
      setBackupMessage(ui.databaseEntitiesUpdated(count))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseEntitiesUpdateFailed
      setBackupMessage(message)
    }
  }, [databaseEntityDatabaseId, refreshDatabasePageData, selectedVisibleDatabaseEntityIds, setBackupMessage, ui])

  const deleteSelectedDatabaseEntities = useCallback(async () => {
    if (selectedVisibleDatabaseEntityIds.length === 0) {
      return
    }

    if (!window.confirm(ui.confirmDeleteDatabaseEntities(selectedVisibleDatabaseEntityIds.length))) {
      return
    }

    try {
      await window.knowbook.deleteDatabaseEntities({
        entityIds: selectedVisibleDatabaseEntityIds
      })

      await refreshDatabasePageData(databaseEntityDatabaseId)
      setSelectedDatabaseEntityIds([])
      setBackupMessage(ui.databaseEntitiesDeleted(selectedVisibleDatabaseEntityIds.length))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseEntitiesDeleteFailed
      setBackupMessage(message)
    }
  }, [
    databaseEntityDatabaseId,
    refreshDatabasePageData,
    selectedVisibleDatabaseEntityIds,
    setBackupMessage,
    setSelectedDatabaseEntityIds,
    ui
  ])

  const updateDatabaseEntityBulkFieldValue = useCallback((columnId: string, value: DocumentDatabaseFieldValue) => {
    setDatabaseEntityBulkFieldValues((current) => ({
      ...current,
      [columnId]: normalizeDocumentDatabaseFieldValue(value)
    }))
  }, [setDatabaseEntityBulkFieldValues])

  const applyDatabaseEntityFieldToSelected = useCallback(async (columnId: string) => {
    await updateSelectedDatabaseEntities({
      fieldValues: {
        [columnId]: databaseEntityBulkFieldValues[columnId] ?? null
      }
    })
  }, [databaseEntityBulkFieldValues, updateSelectedDatabaseEntities])

  const clearDatabaseEntityFieldFromSelected = useCallback(async (columnId: string) => {
    setDatabaseEntityBulkFieldValues((current) => ({
      ...current,
      [columnId]: null
    }))

    await updateSelectedDatabaseEntities({
      fieldValues: {
        [columnId]: null
      }
    })
  }, [setDatabaseEntityBulkFieldValues, updateSelectedDatabaseEntities])

  const clearSelectedDatabaseEntityDocuments = useCallback(async () => {
    await updateSelectedDatabaseEntities({ documentId: null })
  }, [updateSelectedDatabaseEntities])

  const toggleDatabaseEntitySelection = useCallback((entityId: string, checked: boolean) => {
    setSelectedDatabaseEntityIds((current) => {
      if (checked) {
        return current.includes(entityId) ? current : [...current, entityId]
      }

      return current.filter((candidate) => candidate !== entityId)
    })
  }, [setSelectedDatabaseEntityIds])

  const selectVisibleDatabaseEntities = useCallback(() => {
    setSelectedDatabaseEntityIds(filteredStandaloneDatabaseEntityIds)
  }, [filteredStandaloneDatabaseEntityIds, setSelectedDatabaseEntityIds])

  return {
    applyDatabaseEntityFieldToSelected,
    clearDatabaseEntityFieldFromSelected,
    clearSelectedDatabaseEntityDocuments,
    deleteSelectedDatabaseEntities,
    selectVisibleDatabaseEntities,
    toggleDatabaseEntitySelection,
    updateDatabaseEntityBulkFieldValue
  }
}
