import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentCatalogEntry, DocumentDatabaseColumn, HomeData } from '@shared/contracts'
import type { UiText } from '../i18n'
import {
  BOARD_GROUP_BY_PARENT
} from '../hooks/useDatabaseDomainState'
import { useDatabaseDerivedState } from '../hooks/useDatabaseDerivedState'
import { useDatabaseColumnActions } from '../hooks/useDatabaseColumnActions'
import { useDatabaseEntityActions } from '../hooks/useDatabaseEntityActions'
import { useDatabaseEntityBulkActions } from '../hooks/useDatabaseEntityBulkActions'
import { useDatabasePageActions } from '../hooks/useDatabasePageActions'
import { useDatabaseWorkspaceActions } from '../hooks/useDatabaseWorkspaceActions'
import { useDocumentCatalogDatabaseActions } from '../hooks/useDocumentCatalogDatabaseActions'
import { useDatabaseSectionPresentation } from '../hooks/useDatabaseSectionPresentation'
import type { DatabaseDomainState, DatabaseWorkspaceBoardState } from '../types/appDomains'
import { DatabaseSection } from '../sections/DatabaseSection'

type DatabasePageProps = {
  catalogColumns: DocumentDatabaseColumn[]
  catalogDocuments: DocumentCatalogEntry[]
  database: DatabaseDomainState
  documentCatalog: HomeData['documentCatalog']
  onCatalogColumnsChange: Dispatch<SetStateAction<DocumentDatabaseColumn[]>>
  onCatalogDocumentsChange: Dispatch<SetStateAction<DocumentCatalogEntry[]>>
  onHomeDataChange: Dispatch<SetStateAction<HomeData>>
  onMessage: (message: string | null) => void
  onOpenDocument: (documentId: string) => void
  selectedDocumentId: string | null
  workspaceBoard: DatabaseWorkspaceBoardState
  ui: UiText
}

export function DatabasePage({
  catalogColumns,
  catalogDocuments,
  database,
  documentCatalog,
  onCatalogColumnsChange,
  onCatalogDocumentsChange,
  onHomeDataChange,
  onMessage,
  onOpenDocument,
  selectedDocumentId,
  workspaceBoard,
  ui
}: DatabasePageProps) {
  const {
    createDatabase,
    deleteCurrentDatabase,
    switchDatabaseWorkspaceView
  } = useDatabaseWorkspaceActions({
    databaseEntityDatabaseId: database.databaseEntityDatabaseId,
    databaseDescriptionDraft: database.databaseDescriptionDraft,
    databaseNameDraft: database.databaseNameDraft,
    databases: database.databases,
    setBackupMessage: onMessage,
    setDatabaseColumnNameDraft: database.setDatabaseColumnNameDraft,
    setDatabaseColumnOptionsDraft: database.setDatabaseColumnOptionsDraft,
    setDatabaseColumnTypeDraft: database.setDatabaseColumnTypeDraft,
    setDatabaseDescriptionDraft: database.setDatabaseDescriptionDraft,
    setDatabaseEntities: database.setDatabaseEntities,
    setDatabaseEntityBulkFieldValues: database.setDatabaseEntityBulkFieldValues,
    setDatabaseEntityDatabaseId: database.setDatabaseEntityDatabaseId,
    setDatabaseEntityDocumentId: database.setDatabaseEntityDocumentId,
    setDatabaseEntityFieldValues: database.setDatabaseEntityFieldValues,
    setDatabaseNameDraft: database.setDatabaseNameDraft,
    setDatabaseWorkspaceView: database.setDatabaseWorkspaceView,
    setDatabases: database.setDatabases,
    setIsCreatingDatabase: database.setIsCreatingDatabase,
    setIsCreatingDatabaseColumn: database.setIsCreatingDatabaseColumn,
    setIsCreatingDatabaseEntity: database.setIsCreatingDatabaseEntity,
    setSelectedDatabaseEntityIds: database.setSelectedDatabaseEntityIds,
    ui
  })

  const {
    beginCurrentDatabaseSavedViewCreation,
    cancelCurrentDatabaseSavedViewCreation,
    deleteCurrentDatabaseSavedView,
    handleDatabaseSavedViewSelect,
    refreshDatabasePageData,
    refreshDocumentCatalogData,
    saveCurrentDatabaseSavedView,
    updateCurrentDatabaseSavedView
  } = useDatabasePageActions({
    activeDatabaseSavedViewId: database.activeDatabaseSavedViewId,
    databaseEntityDatabaseId: database.databaseEntityDatabaseId,
    databaseEntityFilterQuery: database.databaseEntityFilterQuery,
    databaseEntityFilterScope: database.databaseEntityFilterScope,
    databaseEntitySortMode: database.databaseEntitySortMode,
    databaseEntityViewMode: database.databaseEntityViewMode,
    databaseSavedViewNameDraft: database.databaseSavedViewNameDraft,
    databaseSavedViews: database.databaseSavedViews,
    setActiveDatabaseSavedViewId: database.setActiveDatabaseSavedViewId,
    setBackupMessage: onMessage,
    setCatalogColumns: onCatalogColumnsChange,
    setCatalogDocuments: onCatalogDocumentsChange,
    setDatabaseEntities: database.setDatabaseEntities,
    setDatabaseEntityFilterQuery: database.setDatabaseEntityFilterQuery,
    setDatabaseEntityFilterScope: database.setDatabaseEntityFilterScope,
    setDatabaseEntitySortMode: database.setDatabaseEntitySortMode,
    setDatabaseEntityViewMode: database.setDatabaseEntityViewMode,
    setDatabaseSavedViewNameDraft: database.setDatabaseSavedViewNameDraft,
    setDatabaseSavedViews: database.setDatabaseSavedViews,
    setHomeData: onHomeDataChange,
    setIsCreatingDatabaseSavedView: database.setIsCreatingDatabaseSavedView,
    setSelectedDatabaseColumns: database.setSelectedDatabaseColumns,
    setSelectedDatabaseEntityIds: database.setSelectedDatabaseEntityIds,
    ui
  })

  const {
    updateDocumentDatabaseValue
  } = useDocumentCatalogDatabaseActions({
    setBackupMessage: onMessage,
    setCatalogDocuments: onCatalogDocumentsChange,
    setHomeData: onHomeDataChange
  })

  const {
    activeDatabaseSavedView,
    boardColumns,
    boardGroupableColumns,
    boardGroupingColumn,
    databasePageHint,
    databasePageTitle,
    databaseSavedViewDirty,
    filteredCatalog,
    filteredStandaloneDatabaseEntityIds,
    filteredStandaloneDatabaseEntityRows,
    selectedDatabase,
    selectedDatabaseEntityIdSet,
    selectedVisibleDatabaseEntitiesHaveLinkedDocument,
    selectedVisibleDatabaseEntityIds,
    standaloneDatabases
  } = useDatabaseDerivedState({
    activeDatabaseSavedViewId: database.activeDatabaseSavedViewId,
    boardGroupBy: database.boardGroupBy,
    catalogColumns,
    catalogDocuments,
    databaseEntities: database.databaseEntities,
    databaseEntityDatabaseId: database.databaseEntityDatabaseId,
    databaseEntityFilterQuery: database.databaseEntityFilterQuery,
    databaseEntityFilterScope: database.databaseEntityFilterScope,
    databaseEntitySortMode: database.databaseEntitySortMode,
    databaseEntityViewMode: database.databaseEntityViewMode,
    databaseSavedViews: database.databaseSavedViews,
    databaseWorkspaceView: database.databaseWorkspaceView,
    databases: database.databases,
    deferredCatalogQuery: database.deferredCatalogQuery,
    documentCatalog,
    isDatabasePageActive: true,
    selectedDatabaseColumns: database.selectedDatabaseColumns,
    selectedDatabaseEntityIds: database.selectedDatabaseEntityIds,
    uiDocumentCatalogHint: ui.documentCatalogHint,
    uiDocumentCatalogTitle: ui.documentCatalogTitle,
    uiStandaloneDatabasesHint: ui.standaloneDatabasesHint,
    uiStandaloneDatabasesTitle: ui.standaloneDatabasesTitle
  })

  const {
    createDatabaseColumn,
    deleteDatabaseColumn,
    moveDatabaseColumn,
    renameDatabaseColumn,
    updateDatabaseColumnOptions
  } = useDatabaseColumnActions({
    databaseColumnNameDraft: database.databaseColumnNameDraft,
    databaseColumnOptionsDraft: database.databaseColumnOptionsDraft,
    databaseColumnTypeDraft: database.databaseColumnTypeDraft,
    databaseWorkspaceView: database.databaseWorkspaceView,
    refreshDatabasePageData,
    refreshDocumentCatalogData,
    selectedDatabase,
    setBackupMessage: onMessage,
    setDatabaseColumnNameDraft: database.setDatabaseColumnNameDraft,
    setDatabaseColumnOptionsDraft: database.setDatabaseColumnOptionsDraft,
    setDatabaseColumnTypeDraft: database.setDatabaseColumnTypeDraft,
    setIsCreatingDatabaseColumn: database.setIsCreatingDatabaseColumn,
    ui
  })

  const {
    createDatabaseEntity,
    deleteDatabaseEntity,
    updateDatabaseEntityDocument,
    updateDatabaseEntityField
  } = useDatabaseEntityActions({
    databaseEntityDatabaseId: database.databaseEntityDatabaseId,
    databaseEntityDocumentId: database.databaseEntityDocumentId,
    databaseEntityFieldValues: database.databaseEntityFieldValues,
    refreshDatabasePageData,
    setBackupMessage: onMessage,
    setDatabaseEntityDocumentId: database.setDatabaseEntityDocumentId,
    setDatabaseEntityFieldValues: database.setDatabaseEntityFieldValues,
    setIsCreatingDatabaseEntity: database.setIsCreatingDatabaseEntity,
    ui
  })

  const {
    applyDatabaseEntityFieldToSelected,
    clearDatabaseEntityFieldFromSelected,
    clearSelectedDatabaseEntityDocuments,
    deleteSelectedDatabaseEntities,
    selectVisibleDatabaseEntities,
    toggleDatabaseEntitySelection,
    updateDatabaseEntityBulkFieldValue
  } = useDatabaseEntityBulkActions({
    databaseEntityBulkFieldValues: database.databaseEntityBulkFieldValues,
    databaseEntityDatabaseId: database.databaseEntityDatabaseId,
    filteredStandaloneDatabaseEntityIds,
    refreshDatabasePageData,
    selectedVisibleDatabaseEntityIds,
    setBackupMessage: onMessage,
    setDatabaseEntityBulkFieldValues: database.setDatabaseEntityBulkFieldValues,
    setSelectedDatabaseEntityIds: database.setSelectedDatabaseEntityIds,
    ui
  })

  const {
    board,
    catalog,
    standalone
  } = useDatabaseSectionPresentation({
    activeDatabaseSavedView,
    activeDatabaseSavedViewId: database.activeDatabaseSavedViewId,
    applyDatabaseEntityFieldToSelected,
    beginDrag: workspaceBoard.beginDrag,
    beginCurrentDatabaseSavedViewCreation,
    boardColumns,
    boardGroupBy: database.boardGroupBy,
    boardGroupableColumns,
    boardGroupingColumn,
    cancelCurrentDatabaseSavedViewCreation,
    catalogColumns,
    catalogQuery: database.catalogQuery,
    clearDatabaseEntityFieldFromSelected,
    clearSelectedDatabaseEntityDocuments,
    createDatabase,
    createDatabaseColumn,
    createDatabaseEntity,
    databaseDescriptionDraft: database.databaseDescriptionDraft,
    databaseColumnNameDraft: database.databaseColumnNameDraft,
    databaseColumnOptionsDraft: database.databaseColumnOptionsDraft,
    databaseColumnTypeDraft: database.databaseColumnTypeDraft,
    databaseEntities: database.databaseEntities,
    databaseEntityBulkFieldValues: database.databaseEntityBulkFieldValues,
    databaseEntityDatabaseId: database.databaseEntityDatabaseId,
    databaseEntityDocumentId: database.databaseEntityDocumentId,
    databaseEntityFieldValues: database.databaseEntityFieldValues,
    databaseEntityFilterQuery: database.databaseEntityFilterQuery,
    databaseEntityFilterScope: database.databaseEntityFilterScope,
    databaseEntitySortMode: database.databaseEntitySortMode,
    databaseEntityViewMode: database.databaseEntityViewMode,
    databaseNameDraft: database.databaseNameDraft,
    databaseSavedViewDirty,
    databaseSavedViewNameDraft: database.databaseSavedViewNameDraft,
    databaseSavedViews: database.databaseSavedViews,
    deleteCurrentDatabase,
    deleteCurrentDatabaseSavedView,
    deleteDatabaseColumn,
    deleteDatabaseEntity,
    deleteSelectedDatabaseEntities,
    dragOverBoardColumnId: workspaceBoard.dragOverBoardColumnId,
    draggingDocumentId: workspaceBoard.draggingDocumentId,
    documentCatalog,
    dropOnBoardTarget: workspaceBoard.dropOnBoardTarget,
    endDrag: workspaceBoard.endDrag,
    filteredCatalog,
    filteredStandaloneDatabaseEntityRows,
    handleDatabaseSavedViewSelect,
    handleBoardColumnDragOver: workspaceBoard.handleBoardColumnDragOver,
    isCreatingDatabaseColumn: database.isCreatingDatabaseColumn,
    isCreatingDatabase: database.isCreatingDatabase,
    isCreatingDatabaseEntity: database.isCreatingDatabaseEntity,
    isCreatingDatabaseSavedView: database.isCreatingDatabaseSavedView,
    moveDatabaseColumn,
    openDocumentInDocumentsPage: onOpenDocument,
    parentGroupValue: BOARD_GROUP_BY_PARENT,
    renameDatabaseColumn,
    saveCurrentDatabaseSavedView,
    selectVisibleDatabaseEntities,
    selectedDatabase,
    selectedDatabaseColumns: database.selectedDatabaseColumns,
    selectedDatabaseEntityIdSet,
    selectedEntitiesHaveLinkedDocument: selectedVisibleDatabaseEntitiesHaveLinkedDocument,
    selectedDocumentId,
    selectedVisibleDatabaseEntityIds,
    setBoardGroupBy: database.setBoardGroupBy,
    setCatalogQuery: database.setCatalogQuery,
    setDatabaseDescriptionDraft: database.setDatabaseDescriptionDraft,
    setDatabaseEntityBulkFieldValues: database.setDatabaseEntityBulkFieldValues,
    setDatabaseEntityDatabaseId: database.setDatabaseEntityDatabaseId,
    setDatabaseEntityDocumentId: database.setDatabaseEntityDocumentId,
    setDatabaseEntityFieldValues: database.setDatabaseEntityFieldValues,
    setDatabaseEntityFilterQuery: database.setDatabaseEntityFilterQuery,
    setDatabaseEntityFilterScope: database.setDatabaseEntityFilterScope,
    setDatabaseEntitySortMode: database.setDatabaseEntitySortMode,
    setDatabaseEntityViewMode: database.setDatabaseEntityViewMode,
    setDatabaseColumnNameDraft: database.setDatabaseColumnNameDraft,
    setDatabaseColumnOptionsDraft: database.setDatabaseColumnOptionsDraft,
    setDatabaseColumnTypeDraft: database.setDatabaseColumnTypeDraft,
    setDatabaseNameDraft: database.setDatabaseNameDraft,
    setDatabaseSavedViewNameDraft: database.setDatabaseSavedViewNameDraft,
    setIsCreatingDatabase: database.setIsCreatingDatabase,
    setIsCreatingDatabaseColumn: database.setIsCreatingDatabaseColumn,
    setIsCreatingDatabaseEntity: database.setIsCreatingDatabaseEntity,
    setSelectedDatabaseEntityIds: database.setSelectedDatabaseEntityIds,
    standaloneDatabases,
    toggleDatabaseEntitySelection,
    updateCurrentDatabaseSavedView,
    updateDatabaseColumnOptions,
    updateDatabaseEntityBulkFieldValue,
    updateDatabaseEntityDocument,
    updateDatabaseEntityField,
    updateDocumentDatabaseValue
  })

  useEffect(() => {
    const visibleEntityIdSet = new Set(filteredStandaloneDatabaseEntityIds)
    database.setSelectedDatabaseEntityIds((current) => {
      const next = current.filter((entityId) => visibleEntityIdSet.has(entityId))
      return next.length === current.length ? current : next
    })
  }, [
    database,
    database.databaseEntities,
    database.databaseEntityFilterQuery,
    database.databaseEntityFilterScope,
    database.databaseEntitySortMode,
    documentCatalog,
    filteredStandaloneDatabaseEntityIds,
    database.selectedDatabaseColumns
  ])

  useEffect(() => {
    if (database.boardGroupBy === BOARD_GROUP_BY_PARENT) {
      return
    }

    if (!boardGroupableColumns.some((column) => column.id === database.boardGroupBy)) {
      database.setBoardGroupBy(BOARD_GROUP_BY_PARENT)
    }
  }, [boardGroupableColumns, database])

  return (
    <DatabaseSection
      board={board}
      catalog={catalog}
      databasePageHint={databasePageHint}
      databasePageTitle={databasePageTitle}
      databaseWorkspaceView={database.databaseWorkspaceView}
      onSwitchDatabaseWorkspaceView={switchDatabaseWorkspaceView}
      standalone={standalone}
      ui={ui}
    />
  )
}