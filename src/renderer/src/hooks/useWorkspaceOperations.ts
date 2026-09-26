import type { DocumentsWorkspaceState } from '../types/appDomains'
import type { AppShellState } from '../types/appShell'
import { useDocumentCatalogDatabaseActions } from './useDocumentCatalogDatabaseActions'
import { useWorkspaceBackupActions } from './useWorkspaceBackupActions'
import { useWorkspaceDocumentManagement } from './useWorkspaceDocumentManagement'

type UseWorkspaceOperationsParams = {
  documents: DocumentsWorkspaceState
  reloadDatabaseDomain: () => void
  shell: AppShellState
}

export function useWorkspaceOperations({
  documents,
  reloadDatabaseDomain,
  shell
}: UseWorkspaceOperationsParams) {
  const {
    handleBackup,
    handleRestoreBackup,
    importReport,
    isImportReportOpen,
    setImportReportOpen
  } = useWorkspaceBackupActions({
    flushPendingDocumentChanges: documents.flushPendingChanges,
    reloadDatabaseDomain,
    selectedDocumentId: documents.selectedDocumentId,
    setHomeData: shell.setHomeData,
    setSelectedDocument: documents.setSelectedDocument,
    setSelectedDocumentId: documents.setSelectedDocumentId,
    ui: shell.ui
  })

  const {
    updateDocumentDatabaseValue
  } = useDocumentCatalogDatabaseActions({
    notify: shell.notify,
    setCatalogDocuments: shell.setCatalogDocuments
  })

  const workspaceDocumentManagement = useWorkspaceDocumentManagement({
    catalogColumns: shell.catalogColumns,
    catalogDocuments: shell.catalogDocuments,
    documentIndex: shell.homeData.documentCatalog,
    moveTargetId: documents.moveTargetId,
    onCancelPendingAutoSave: documents.cancelPendingAutoSave,
    onFlushPendingDocumentChanges: documents.flushPendingChanges,
    getDraftMarkdownExport: documents.getDraftMarkdownExport,
    onClearEditorSession: documents.clearEditorSession,
    onDetailLoadingChange: documents.setDetailLoading,
    onHomeDataChange: shell.setHomeData,
    onMessage: shell.notify,
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
    importReport,
    isImportReportOpen,
    setImportReportOpen,
    ...workspaceDocumentManagement
  }
}
