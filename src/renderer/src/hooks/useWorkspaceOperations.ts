import type { Dispatch, SetStateAction } from 'react'
import type {
  DocumentCatalogEntry,
  DocumentDatabaseColumn,
  DocumentDetail,
  HomeData
} from '@shared/contracts'
import type { UiText } from '../i18n'
import { useDocumentCatalogDatabaseActions } from './useDocumentCatalogDatabaseActions'
import { useWorkspaceBackupActions } from './useWorkspaceBackupActions'
import { useWorkspaceDocumentManagement } from './useWorkspaceDocumentManagement'

type UseWorkspaceOperationsParams = {
  catalogColumns: DocumentDatabaseColumn[]
  catalogDocuments: DocumentCatalogEntry[]
  moveTargetId: string
  selectedDocument: DocumentDetail | null
  selectedDocumentId: string | null
  setBackupMessage: (message: string | null) => void
  setCatalogDocuments: Dispatch<SetStateAction<DocumentCatalogEntry[]>>
  setDetailLoading: Dispatch<SetStateAction<boolean>>
  setHomeData: Dispatch<SetStateAction<HomeData>>
  setMoveTargetId: Dispatch<SetStateAction<string>>
  setSelectedDocument: Dispatch<SetStateAction<DocumentDetail | null>>
  setSelectedDocumentId: Dispatch<SetStateAction<string | null>>
  ui: UiText
  onClearEditorSession: () => void
}

export function useWorkspaceOperations({
  catalogColumns,
  catalogDocuments,
  moveTargetId,
  selectedDocument,
  selectedDocumentId,
  setBackupMessage,
  setCatalogDocuments,
  setDetailLoading,
  setHomeData,
  setMoveTargetId,
  setSelectedDocument,
  setSelectedDocumentId,
  ui,
  onClearEditorSession
}: UseWorkspaceOperationsParams) {
  const {
    handleBackup,
    handleRestoreBackup
  } = useWorkspaceBackupActions({
    selectedDocumentId,
    setBackupMessage,
    setHomeData,
    setSelectedDocument,
    setSelectedDocumentId,
    ui
  })

  const {
    updateDocumentDatabaseValue
  } = useDocumentCatalogDatabaseActions({
    setBackupMessage,
    setCatalogDocuments,
    setHomeData
  })

  const workspaceDocumentManagement = useWorkspaceDocumentManagement({
    catalogColumns,
    catalogDocuments,
    moveTargetId,
    onClearEditorSession,
    onDetailLoadingChange: setDetailLoading,
    onHomeDataChange: setHomeData,
    onMessage: (message) => setBackupMessage(message),
    onMoveTargetIdChange: setMoveTargetId,
    onSelectedDocumentChange: setSelectedDocument,
    onSelectedDocumentIdChange: setSelectedDocumentId,
    onUpdateDocumentDatabaseValue: updateDocumentDatabaseValue,
    selectedDocument,
    selectedDocumentId,
    ui
  })

  return {
    handleBackup,
    handleRestoreBackup,
    ...workspaceDocumentManagement
  }
}