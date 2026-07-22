import type { DocumentsWorkspaceState } from '../types/appDomains'
import type { AppShellState } from '../types/appShell'
import { useDocumentCatalogDatabaseActions } from './useDocumentCatalogDatabaseActions'
import { useWorkspaceBackupActions } from './useWorkspaceBackupActions'
import { useWorkspaceDocumentManagement } from './useWorkspaceDocumentManagement'

type UseWorkspaceOperationsParams = {
  documents: DocumentsWorkspaceState
  shell: AppShellState
}

export function useWorkspaceOperations({
  documents,
  shell
}: UseWorkspaceOperationsParams) {
  const {
    handleBackup,
    handleRestoreBackup
  } = useWorkspaceBackupActions({
    flushPendingDocumentChanges: documents.flushPendingChanges,
    selectedDocumentId: documents.selectedDocumentId,
    setBackupMessage: shell.setBackupMessage,
    setHomeData: shell.setHomeData,
    setSelectedDocument: documents.setSelectedDocument,
    setSelectedDocumentId: documents.setSelectedDocumentId,
    ui: shell.ui
  })

  const {
    updateDocumentDatabaseValue
  } = useDocumentCatalogDatabaseActions({
    setBackupMessage: shell.setBackupMessage,
    setCatalogDocuments: shell.setCatalogDocuments,
    setHomeData: shell.setHomeData
  })

  const workspaceDocumentManagement = useWorkspaceDocumentManagement({
    catalogColumns: shell.catalogColumns,
    catalogDocuments: shell.catalogDocuments,
    moveTargetId: documents.moveTargetId,
    onCancelPendingAutoSave: documents.cancelPendingAutoSave,
    onFlushPendingDocumentChanges: documents.flushPendingChanges,
    onClearEditorSession: documents.clearEditorSession,
    onDetailLoadingChange: documents.setDetailLoading,
    onHomeDataChange: shell.setHomeData,
    onMessage: (message) => shell.setBackupMessage(message),
    onMoveTargetIdChange: documents.setMoveTargetId,
    onSelectedDocumentChange: documents.setSelectedDocument,
    onSelectedDocumentIdChange: documents.setSelectedDocumentId,
    onUpdateDocumentDatabaseValue: updateDocumentDatabaseValue,
    selectedDocument: documents.selectedDocument,
    selectedDocumentId: documents.selectedDocumentId,
    ui: shell.ui
  })

  return {
    handleBackup,
    handleRestoreBackup,
    ...workspaceDocumentManagement
  }
}
