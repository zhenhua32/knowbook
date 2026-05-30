import type {
  DocumentCatalogEntry,
  DocumentDatabaseColumn,
  HomeData
} from '@shared/contracts'
import type { useAppShellState } from './useAppShellState'
import type { useDocumentsDomainState } from './useDocumentsDomainState'
import type { UiText } from '../i18n'
import { useDocumentCatalogDatabaseActions } from './useDocumentCatalogDatabaseActions'
import { useWorkspaceBackupActions } from './useWorkspaceBackupActions'
import { useWorkspaceDocumentManagement } from './useWorkspaceDocumentManagement'

type ShellWorkspaceState = Pick<ReturnType<typeof useAppShellState>,
  'setBackupMessage'
  | 'setCatalogDocuments'
  | 'setHomeData'
>

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
  catalogColumns: DocumentDatabaseColumn[]
  catalogDocuments: DocumentCatalogEntry[]
  documents: DocumentsWorkspaceState
  shell: ShellWorkspaceState
  ui: UiText
}

export function useWorkspaceOperations({
  catalogColumns,
  catalogDocuments,
  documents,
  shell,
  ui
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
    ui
  })

  const {
    updateDocumentDatabaseValue
  } = useDocumentCatalogDatabaseActions({
    setBackupMessage: shell.setBackupMessage,
    setCatalogDocuments: shell.setCatalogDocuments,
    setHomeData: shell.setHomeData
  })

  const workspaceDocumentManagement = useWorkspaceDocumentManagement({
    catalogColumns,
    catalogDocuments,
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
    ui
  })

  return {
    handleBackup,
    handleRestoreBackup,
    ...workspaceDocumentManagement
  }
}