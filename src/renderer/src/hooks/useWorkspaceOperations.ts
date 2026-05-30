import type {
  HomeData
} from '@shared/contracts'
import type { useAppShellState } from './useAppShellState'
import type { useDocumentsDomainState } from './useDocumentsDomainState'
import { useDocumentCatalogDatabaseActions } from './useDocumentCatalogDatabaseActions'
import { useWorkspaceBackupActions } from './useWorkspaceBackupActions'
import { useWorkspaceDocumentManagement } from './useWorkspaceDocumentManagement'

type AppShellState = ReturnType<typeof useAppShellState>

type DocumentsWorkspaceState = Pick<ReturnType<typeof useDocumentsDomainState>,
  'clearEditorSession'
  | 'moveTargetId'
  | 'selectedDocument'
  | 'selectedDocumentId'
  | 'setDetailLoading'
  | 'setMoveTargetId'
  | 'setSelectedDocument'
  | 'setSelectedDocumentId'
>

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