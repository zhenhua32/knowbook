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
  'detailLoading'
  | 'isSaving'
  | 'navCanGoBack'
  | 'navCanGoForward'
  | 'navBack'
  | 'navForward'
  | 'openDocumentInDocumentsPage'
  | 'openGlobalSearch'
  | 'pinnedDocumentIds'
  | 'saveDocument'
  | 'selectedDocument'
  | 'selectedDocumentId'
  | 'togglePinDocument'
>

export type DocumentsKeyboardState = Pick<DocumentsDomainState,
  'closeBlockSearch'
  | 'closeGlobalSearch'
  | 'isBlockSearchOpen'
  | 'isEditing'
  | 'isGlobalSearchOpen'
  | 'navBack'
  | 'navForward'
  | 'openBlockSearch'
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
  | 'copyDocumentMarkdown'
  | 'deleteDocumentById'
  | 'dragOverRoot'
  | 'dropOnDocument'
  | 'dropToRoot'
  | 'endDrag'
  | 'exportDocumentMarkdown'
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