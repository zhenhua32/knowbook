import { useCallback, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentDetail, HomeData, MarkdownImportReport } from '@shared/contracts'
import type { UiText } from '../i18n'

type UseWorkspaceBackupActionsParams = {
  selectedDocumentId: string | null
  flushPendingDocumentChanges: () => Promise<boolean>
  reloadDatabaseDomain: () => void
  setHomeData: Dispatch<SetStateAction<HomeData>>
  setSelectedDocument: Dispatch<SetStateAction<DocumentDetail | null>>
  setSelectedDocumentId: Dispatch<SetStateAction<string | null>>
  ui: UiText
}

export function useWorkspaceBackupActions({
  selectedDocumentId,
  flushPendingDocumentChanges,
  reloadDatabaseDomain,
  setHomeData,
  setSelectedDocument,
  setSelectedDocumentId,
  ui
}: UseWorkspaceBackupActionsParams) {
  const [importReport, setImportReport] = useState<MarkdownImportReport | null>(null)
  const [isImportReportOpen, setImportReportOpen] = useState(false)
  const selection = useRef(selectedDocumentId)
  selection.current = selectedDocumentId
  const refreshWorkspaceAfterStorageMutation = useCallback(async () => {
    const refreshed = await window.knowbook.getHomeData()
    setHomeData(refreshed)
    const nextDocumentId = selectedDocumentId ?? refreshed.initialDocumentId
    if (selection.current !== selectedDocumentId) return
    if (!selectedDocumentId && nextDocumentId) {
      setSelectedDocumentId(nextDocumentId)
    }
    if (selectedDocumentId) {
      const detail = await window.knowbook.getDocumentDetail(selectedDocumentId)
      if (selection.current !== selectedDocumentId) return
      if (detail) {
        setSelectedDocument(detail)
      } else {
        setSelectedDocument(null)
        setSelectedDocumentId(refreshed.initialDocumentId)
      }
    }
  }, [selectedDocumentId, setHomeData, setSelectedDocument, setSelectedDocumentId])

  const latest = useRef({ flushPendingDocumentChanges, refreshWorkspaceAfterStorageMutation, reloadDatabaseDomain, ui })
  latest.current = { flushPendingDocumentChanges, refreshWorkspaceAfterStorageMutation, reloadDatabaseDomain, ui }

  const runBackup = useCallback(async (restore: boolean) => {
    const { runWorkspaceBackup } = await import('../workspace-backup-notifications')
    await runWorkspaceBackup(restore, latest, setImportReport, setImportReportOpen)
  }, [])
  const handleBackup = useCallback(() => runBackup(false), [runBackup])
  const handleRestoreBackup = useCallback(() => runBackup(true), [runBackup])

  return {
    importReport,
    isImportReportOpen,
    setImportReportOpen,
    handleBackup,
    handleRestoreBackup,
    refreshWorkspaceAfterStorageMutation
  }
}
