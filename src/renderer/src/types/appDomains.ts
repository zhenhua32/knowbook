import type { useAiDomain } from '../hooks/useAiDomain'
import type { useDatabaseDomainState } from '../hooks/useDatabaseDomainState'
import type { useDocumentsDomainState } from '../hooks/useDocumentsDomainState'
import type { usePluginsDomain } from '../hooks/usePluginsDomain'
import type { useWorkspaceDocumentManagement } from '../hooks/useWorkspaceDocumentManagement'

export type DatabaseDomainState = ReturnType<typeof useDatabaseDomainState>
export type DocumentsDomainState = ReturnType<typeof useDocumentsDomainState>
export type AiDomainState = ReturnType<typeof useAiDomain>
export type PluginsDomainState = ReturnType<typeof usePluginsDomain>

type WorkspaceDocumentManagementState = ReturnType<typeof useWorkspaceDocumentManagement>

export type DocumentsSidebarState = Pick<DocumentsDomainState,
  'navCanGoBack'
  | 'navCanGoForward'
  | 'navBack'
  | 'navForward'
  | 'openDocumentInDocumentsPage'
  | 'openGlobalSearch'
  | 'pinnedDocumentIds'
  | 'selectedDocumentId'
>

export type DocumentsKeyboardState = Pick<DocumentsDomainState,
  'closeGlobalSearch'
  | 'isEditing'
  | 'isGlobalSearchOpen'
  | 'navBack'
  | 'navForward'
  | 'openGlobalSearch'
  | 'redoEdit'
  | 'selectedBlockRange'
  | 'undoEdit'
>

export type DocumentsWorkspaceState = Pick<DocumentsDomainState,
  'cancelPendingAutoSave'
  | 'clearEditorSession'
  | 'moveTargetId'
  | 'selectedDocument'
  | 'selectedDocumentId'
  | 'setDetailLoading'
  | 'setMoveTargetId'
  | 'setSelectedDocument'
  | 'setSelectedDocumentId'
>

export type DocumentsFeatureState = Pick<DocumentsDomainState,
  'openDocumentInDocumentsPage'
  | 'selectedDocument'
  | 'selectedDocumentId'
  | 'setDraftSummary'
  | 'setSelectedDocument'
>

export type WorkspaceSidebarActions = Pick<WorkspaceDocumentManagementState,
  'beginDrag'
  | 'dragOverRoot'
  | 'dropOnDocument'
  | 'dropToRoot'
  | 'endDrag'
  | 'handleCreateDocument'
  | 'handleRootDragLeave'
  | 'handleRootDragOver'
  | 'handleTreeNodeDragOver'
>

export type DatabaseWorkspaceBoardState = Pick<WorkspaceDocumentManagementState,
  'beginDrag'
  | 'dragOverBoardColumnId'
  | 'draggingDocumentId'
  | 'dropOnBoardTarget'
  | 'endDrag'
  | 'handleBoardColumnDragOver'
>