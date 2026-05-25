import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DatabaseEntity, DocumentDatabaseFieldValue } from '@shared/contracts'
import type { UiText } from '../i18n'
import {
  compactDocumentDatabaseFieldValues,
  normalizeDocumentDatabaseFieldValue
} from '../components/database/databaseFieldUtils'

type UseDatabaseEntityActionsParams = {
  databaseEntityDatabaseId: string
  databaseEntityDocumentId: string
  databaseEntityFieldValues: Record<string, DocumentDatabaseFieldValue>
  refreshDatabasePageData: (targetDatabaseId?: string | null, preferredSavedViewId?: string) => Promise<void>
  setBackupMessage: (message: string | null) => void
  setDatabaseEntityDocumentId: Dispatch<SetStateAction<string>>
  setDatabaseEntityFieldValues: Dispatch<SetStateAction<Record<string, DocumentDatabaseFieldValue>>>
  setIsCreatingDatabaseEntity: Dispatch<SetStateAction<boolean>>
  ui: UiText
}

export function useDatabaseEntityActions({
  databaseEntityDatabaseId,
  databaseEntityDocumentId,
  databaseEntityFieldValues,
  refreshDatabasePageData,
  setBackupMessage,
  setDatabaseEntityDocumentId,
  setDatabaseEntityFieldValues,
  setIsCreatingDatabaseEntity,
  ui
}: UseDatabaseEntityActionsParams) {
  const updateDatabaseEntity = useCallback(async (
    entityId: string,
    fieldValues?: Record<string, DocumentDatabaseFieldValue>,
    documentId?: string | null
  ) => {
    try {
      const input: {
        entityId: string
        fieldValues?: Record<string, DocumentDatabaseFieldValue>
        documentId?: string | null
      } = { entityId }

      if (fieldValues) {
        input.fieldValues = Object.fromEntries(
          Object.entries(fieldValues).map(([columnId, value]) => [columnId, normalizeDocumentDatabaseFieldValue(value)])
        )
      }

      if (documentId !== undefined) {
        input.documentId = documentId
      }

      await window.knowbook.updateDatabaseEntity(input)
      await refreshDatabasePageData(databaseEntityDatabaseId)
      setBackupMessage(ui.databaseEntityUpdated)
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseEntityUpdateFailed
      setBackupMessage(message)
    }
  }, [
    databaseEntityDatabaseId,
    refreshDatabasePageData,
    setBackupMessage,
    ui
  ])

  const createDatabaseEntity = useCallback(async () => {
    try {
      await window.knowbook.createDatabaseEntity({
        databaseId: databaseEntityDatabaseId,
        documentId: databaseEntityDocumentId || undefined,
        fieldValues: compactDocumentDatabaseFieldValues(databaseEntityFieldValues)
      })
      await refreshDatabasePageData(databaseEntityDatabaseId)
      setIsCreatingDatabaseEntity(false)
      setDatabaseEntityDocumentId('')
      setDatabaseEntityFieldValues({})
      setBackupMessage(ui.databaseEntityCreated)
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseEntityCreateFailed
      setBackupMessage(message)
    }
  }, [
    databaseEntityDatabaseId,
    databaseEntityDocumentId,
    databaseEntityFieldValues,
    refreshDatabasePageData,
    setBackupMessage,
    setDatabaseEntityDocumentId,
    setDatabaseEntityFieldValues,
    setIsCreatingDatabaseEntity,
    ui
  ])

  const updateDatabaseEntityField = useCallback(async (entity: DatabaseEntity, columnId: string, value: DocumentDatabaseFieldValue) => {
    await updateDatabaseEntity(entity.id, {
      ...entity.fieldValues,
      [columnId]: normalizeDocumentDatabaseFieldValue(value)
    })
  }, [updateDatabaseEntity])

  const updateDatabaseEntityDocument = useCallback(async (entity: DatabaseEntity, documentId: string | null) => {
    await updateDatabaseEntity(entity.id, undefined, documentId)
  }, [updateDatabaseEntity])

  const deleteDatabaseEntity = useCallback(async (entityId: string) => {
    if (!window.confirm(ui.confirmDeleteDatabaseEntity)) {
      return
    }

    try {
      await window.knowbook.deleteDatabaseEntity(entityId)
      await refreshDatabasePageData(databaseEntityDatabaseId)
      setBackupMessage(ui.databaseEntityDeleted)
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseEntityDeleteFailed
      setBackupMessage(message)
    }
  }, [databaseEntityDatabaseId, refreshDatabasePageData, setBackupMessage, ui])

  return {
    createDatabaseEntity,
    deleteDatabaseEntity,
    updateDatabaseEntityDocument,
    updateDatabaseEntityField
  }
}