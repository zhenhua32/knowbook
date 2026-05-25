import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentDetail, HomeData } from '@shared/contracts'
import type { UiText } from '../i18n'

type UseWorkspaceBackupActionsParams = {
  selectedDocumentId: string | null
  setBackupMessage: (message: string | null) => void
  setHomeData: Dispatch<SetStateAction<HomeData>>
  setSelectedDocument: Dispatch<SetStateAction<DocumentDetail | null>>
  setSelectedDocumentId: Dispatch<SetStateAction<string | null>>
  ui: UiText
}

export function useWorkspaceBackupActions({
  selectedDocumentId,
  setBackupMessage,
  setHomeData,
  setSelectedDocument,
  setSelectedDocumentId,
  ui
}: UseWorkspaceBackupActionsParams) {
  const refreshWorkspaceAfterStorageMutation = useCallback(async () => {
    const refreshed = await window.knowbook.getHomeData()
    setHomeData(refreshed)
    const nextDocumentId = selectedDocumentId ?? refreshed.initialDocumentId
    if (!selectedDocumentId && nextDocumentId) {
      setSelectedDocumentId(nextDocumentId)
    }
    if (selectedDocumentId) {
      const detail = await window.knowbook.getDocumentDetail(selectedDocumentId)
      setSelectedDocument(detail)
    }
  }, [selectedDocumentId, setHomeData, setSelectedDocument, setSelectedDocumentId])

  const handleBackup = useCallback(async () => {
    const result = await window.knowbook.triggerBackup()
    await refreshWorkspaceAfterStorageMutation()
    setBackupMessage(ui.backupExported(result.exported, result.at))
  }, [refreshWorkspaceAfterStorageMutation, setBackupMessage, ui])

  const handleRestoreBackup = useCallback(async () => {
    try {
      const result = await window.knowbook.restoreBackupFromFolder()
      if (!result) {
        return
      }

      await refreshWorkspaceAfterStorageMutation()
      setBackupMessage(ui.backupRestored(
        result.restored,
        result.created,
        result.updated,
        result.deleted,
        result.conflictsResolved,
        result.placeholdersCreated,
        result.at
      ))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.backupRestoreFailed
      setBackupMessage(message)
    }
  }, [refreshWorkspaceAfterStorageMutation, setBackupMessage, ui])

  return {
    handleBackup,
    handleRestoreBackup,
    refreshWorkspaceAfterStorageMutation
  }
}