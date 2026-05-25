import type { ComponentProps, Dispatch, SetStateAction } from 'react'
import { DatabaseSection } from '../sections/DatabaseSection'
import {
  normalizeDatabaseColumnOptionsInput,
  normalizeDocumentDatabaseFieldValue
} from '../components/database/databaseFieldUtils'

type DatabaseSectionProps = ComponentProps<typeof DatabaseSection>
type DatabaseBoardProps = DatabaseSectionProps['board']
type DatabaseCatalogProps = DatabaseSectionProps['catalog']
type DatabaseStandaloneProps = DatabaseSectionProps['standalone']

type UseDatabaseSectionPresentationParams = {
  activeDatabaseSavedView: DatabaseStandaloneProps['activeSavedView']
  activeDatabaseSavedViewId: DatabaseStandaloneProps['activeSavedViewId']
  applyDatabaseEntityFieldToSelected: (columnId: string) => Promise<void>
  beginDrag: DatabaseBoardProps['onDragStart']
  beginCurrentDatabaseSavedViewCreation: DatabaseStandaloneProps['onBeginSavedViewCreation']
  boardColumns: DatabaseBoardProps['boardColumns']
  boardGroupBy: DatabaseBoardProps['groupBy']
  boardGroupableColumns: DatabaseBoardProps['groupableColumns']
  boardGroupingColumn: DatabaseBoardProps['boardGroupingColumn']
  cancelCurrentDatabaseSavedViewCreation: DatabaseStandaloneProps['onCancelSavedViewCreation']
  catalogColumns: DatabaseCatalogProps['columns']
  catalogQuery: DatabaseCatalogProps['query']
  clearDatabaseEntityFieldFromSelected: (columnId: string) => Promise<void>
  clearSelectedDatabaseEntityDocuments: () => Promise<void>
  createDatabase: () => Promise<void>
  createDatabaseColumn: () => Promise<void>
  createDatabaseEntity: () => Promise<void>
  databaseDescriptionDraft: DatabaseStandaloneProps['databaseDescriptionDraft']
  databaseColumnNameDraft: DatabaseCatalogProps['columnNameDraft']
  databaseColumnOptionsDraft: DatabaseCatalogProps['columnOptionsDraft']
  databaseColumnTypeDraft: DatabaseCatalogProps['columnTypeDraft']
  databaseEntities: DatabaseStandaloneProps['databaseEntities']
  databaseEntityBulkFieldValues: DatabaseStandaloneProps['bulkFieldValues']
  databaseEntityDatabaseId: DatabaseStandaloneProps['entityDatabaseId']
  databaseEntityDocumentId: DatabaseStandaloneProps['entityDocumentId']
  databaseEntityFieldValues: DatabaseStandaloneProps['entityFieldValues']
  databaseEntityFilterQuery: DatabaseStandaloneProps['filterQuery']
  databaseEntityFilterScope: DatabaseStandaloneProps['filterScope']
  databaseEntitySortMode: DatabaseStandaloneProps['sortMode']
  databaseEntityViewMode: DatabaseStandaloneProps['viewMode']
  databaseNameDraft: DatabaseStandaloneProps['databaseNameDraft']
  databaseSavedViewDirty: DatabaseStandaloneProps['savedViewDirty']
  databaseSavedViewNameDraft: DatabaseStandaloneProps['savedViewNameDraft']
  databaseSavedViews: DatabaseStandaloneProps['savedViews']
  deleteCurrentDatabase: () => Promise<void>
  deleteCurrentDatabaseSavedView: () => Promise<void>
  deleteDatabaseColumn: DatabaseCatalogProps['onDeleteColumn']
  deleteDatabaseEntity: DatabaseStandaloneProps['onDeleteEntity']
  deleteSelectedDatabaseEntities: () => Promise<void>
  dragOverBoardColumnId: DatabaseBoardProps['dragOverColumnId']
  draggingDocumentId: DatabaseBoardProps['draggingDocumentId']
  documentCatalog: DatabaseStandaloneProps['documentCatalog']
  dropOnBoardTarget: DatabaseBoardProps['onDropOnColumn']
  endDrag: DatabaseBoardProps['onDragEnd']
  filteredCatalog: DatabaseCatalogProps['filteredDocuments']
  filteredStandaloneDatabaseEntityRows: DatabaseStandaloneProps['filteredEntityRows']
  handleDatabaseSavedViewSelect: DatabaseStandaloneProps['onSavedViewSelect']
  handleBoardColumnDragOver: DatabaseBoardProps['onDragOverColumn']
  isCreatingDatabaseColumn: DatabaseCatalogProps['isCreatingColumn']
  isCreatingDatabase: DatabaseStandaloneProps['isCreatingDatabase']
  isCreatingDatabaseEntity: DatabaseStandaloneProps['isCreatingEntity']
  isCreatingDatabaseSavedView: DatabaseStandaloneProps['isCreatingSavedView']
  moveDatabaseColumn: DatabaseCatalogProps['onMoveColumn']
  openDocumentInDocumentsPage: DatabaseBoardProps['onOpenDocument']
  parentGroupValue: DatabaseBoardProps['parentGroupValue']
  renameDatabaseColumn: DatabaseCatalogProps['onRenameColumn']
  saveCurrentDatabaseSavedView: () => Promise<void>
  selectVisibleDatabaseEntities: DatabaseStandaloneProps['onSelectVisibleEntities']
  selectedDatabase: DatabaseStandaloneProps['selectedDatabase']
  selectedDatabaseColumns: DatabaseStandaloneProps['selectedDatabaseColumns']
  selectedDatabaseEntityIdSet: DatabaseStandaloneProps['selectedEntityIdSet']
  selectedEntitiesHaveLinkedDocument: DatabaseStandaloneProps['selectedEntitiesHaveLinkedDocument']
  selectedDocumentId: DatabaseBoardProps['selectedDocumentId']
  selectedVisibleDatabaseEntityIds: DatabaseStandaloneProps['selectedEntityIds']
  setBoardGroupBy: DatabaseBoardProps['onGroupByChange']
  setCatalogQuery: DatabaseCatalogProps['onQueryChange']
  setDatabaseDescriptionDraft: DatabaseStandaloneProps['onDatabaseDescriptionChange']
  setDatabaseEntityBulkFieldValues: Dispatch<SetStateAction<DatabaseStandaloneProps['bulkFieldValues']>>
  setDatabaseEntityDatabaseId: DatabaseStandaloneProps['onEntityDatabaseIdChange']
  setDatabaseEntityDocumentId: DatabaseStandaloneProps['onEntityDocumentIdChange']
  setDatabaseEntityFieldValues: Dispatch<SetStateAction<DatabaseStandaloneProps['entityFieldValues']>>
  setDatabaseEntityFilterQuery: DatabaseStandaloneProps['onFilterQueryChange']
  setDatabaseEntityFilterScope: DatabaseStandaloneProps['onFilterScopeChange']
  setDatabaseEntitySortMode: DatabaseStandaloneProps['onSortModeChange']
  setDatabaseEntityViewMode: DatabaseStandaloneProps['onViewModeChange']
  setDatabaseColumnNameDraft: DatabaseCatalogProps['onColumnNameChange']
  setDatabaseColumnOptionsDraft: DatabaseCatalogProps['onColumnOptionsChange']
  setDatabaseColumnTypeDraft: DatabaseCatalogProps['onColumnTypeChange']
  setDatabaseNameDraft: DatabaseStandaloneProps['onDatabaseNameChange']
  setDatabaseSavedViewNameDraft: DatabaseStandaloneProps['onSavedViewNameChange']
  setIsCreatingDatabase: Dispatch<SetStateAction<boolean>>
  setIsCreatingDatabaseColumn: Dispatch<SetStateAction<boolean>>
  setIsCreatingDatabaseEntity: Dispatch<SetStateAction<boolean>>
  setSelectedDatabaseEntityIds: Dispatch<SetStateAction<string[]>>
  standaloneDatabases: DatabaseStandaloneProps['databases']
  toggleDatabaseEntitySelection: DatabaseStandaloneProps['onToggleEntitySelection']
  updateCurrentDatabaseSavedView: () => Promise<void>
  updateDatabaseColumnOptions: DatabaseCatalogProps['onUpdateColumnOptions']
  updateDatabaseEntityBulkFieldValue: DatabaseStandaloneProps['onBulkFieldChange']
  updateDatabaseEntityDocument: DatabaseStandaloneProps['onUpdateEntityDocument']
  updateDatabaseEntityField: DatabaseStandaloneProps['onUpdateEntityField']
  updateDocumentDatabaseValue: DatabaseCatalogProps['onUpdateField']
}

export function useDatabaseSectionPresentation({
  activeDatabaseSavedView,
  activeDatabaseSavedViewId,
  applyDatabaseEntityFieldToSelected,
  beginDrag,
  beginCurrentDatabaseSavedViewCreation,
  boardColumns,
  boardGroupBy,
  boardGroupableColumns,
  boardGroupingColumn,
  cancelCurrentDatabaseSavedViewCreation,
  catalogColumns,
  catalogQuery,
  clearDatabaseEntityFieldFromSelected,
  clearSelectedDatabaseEntityDocuments,
  createDatabase,
  createDatabaseColumn,
  createDatabaseEntity,
  databaseDescriptionDraft,
  databaseColumnNameDraft,
  databaseColumnOptionsDraft,
  databaseColumnTypeDraft,
  databaseEntities,
  databaseEntityBulkFieldValues,
  databaseEntityDatabaseId,
  databaseEntityDocumentId,
  databaseEntityFieldValues,
  databaseEntityFilterQuery,
  databaseEntityFilterScope,
  databaseEntitySortMode,
  databaseEntityViewMode,
  databaseNameDraft,
  databaseSavedViewDirty,
  databaseSavedViewNameDraft,
  databaseSavedViews,
  deleteCurrentDatabase,
  deleteCurrentDatabaseSavedView,
  deleteDatabaseColumn,
  deleteDatabaseEntity,
  deleteSelectedDatabaseEntities,
  dragOverBoardColumnId,
  draggingDocumentId,
  documentCatalog,
  dropOnBoardTarget,
  endDrag,
  filteredCatalog,
  filteredStandaloneDatabaseEntityRows,
  handleDatabaseSavedViewSelect,
  handleBoardColumnDragOver,
  isCreatingDatabaseColumn,
  isCreatingDatabase,
  isCreatingDatabaseEntity,
  isCreatingDatabaseSavedView,
  moveDatabaseColumn,
  openDocumentInDocumentsPage,
  parentGroupValue,
  renameDatabaseColumn,
  saveCurrentDatabaseSavedView,
  selectVisibleDatabaseEntities,
  selectedDatabase,
  selectedDatabaseColumns,
  selectedDatabaseEntityIdSet,
  selectedEntitiesHaveLinkedDocument,
  selectedDocumentId,
  selectedVisibleDatabaseEntityIds,
  setBoardGroupBy,
  setCatalogQuery,
  setDatabaseDescriptionDraft,
  setDatabaseEntityBulkFieldValues,
  setDatabaseEntityDatabaseId,
  setDatabaseEntityDocumentId,
  setDatabaseEntityFieldValues,
  setDatabaseEntityFilterQuery,
  setDatabaseEntityFilterScope,
  setDatabaseEntitySortMode,
  setDatabaseEntityViewMode,
  setDatabaseColumnNameDraft,
  setDatabaseColumnOptionsDraft,
  setDatabaseColumnTypeDraft,
  setDatabaseNameDraft,
  setDatabaseSavedViewNameDraft,
  setIsCreatingDatabase,
  setIsCreatingDatabaseColumn,
  setIsCreatingDatabaseEntity,
  setSelectedDatabaseEntityIds,
  standaloneDatabases,
  toggleDatabaseEntitySelection,
  updateCurrentDatabaseSavedView,
  updateDatabaseColumnOptions,
  updateDatabaseEntityBulkFieldValue,
  updateDatabaseEntityDocument,
  updateDatabaseEntityField,
  updateDocumentDatabaseValue
}: UseDatabaseSectionPresentationParams) {
  const catalogCanSaveColumn = databaseColumnNameDraft.trim().length > 0
    && ((databaseColumnTypeDraft !== 'select' && databaseColumnTypeDraft !== 'multi-select')
      || normalizeDatabaseColumnOptionsInput(databaseColumnOptionsDraft).length > 0)
  const standaloneCanSaveColumn = Boolean(selectedDatabase) && catalogCanSaveColumn

  const resetColumnDrafts = () => {
    setIsCreatingDatabaseColumn(false)
    setDatabaseColumnNameDraft('')
    setDatabaseColumnTypeDraft('text')
    setDatabaseColumnOptionsDraft('')
  }

  const resetDatabaseDrafts = () => {
    setIsCreatingDatabase(false)
    setDatabaseNameDraft('')
    setDatabaseDescriptionDraft('')
  }

  const resetEntityDrafts = () => {
    setIsCreatingDatabaseEntity(false)
    setDatabaseEntityDocumentId('')
    setDatabaseEntityFieldValues({})
  }

  const board: DatabaseBoardProps = {
    boardColumns,
    boardGroupingColumn,
    dragOverColumnId: dragOverBoardColumnId,
    draggingDocumentId,
    groupBy: boardGroupBy,
    groupableColumns: boardGroupableColumns,
    onDragEnd: endDrag,
    onDragOverColumn: handleBoardColumnDragOver,
    onDragStart: beginDrag,
    onDropOnColumn: dropOnBoardTarget,
    onGroupByChange: setBoardGroupBy,
    onOpenDocument: openDocumentInDocumentsPage,
    parentGroupValue,
    selectedDocumentId
  }

  const catalog: DatabaseCatalogProps = {
    canSaveColumn: catalogCanSaveColumn,
    columnNameDraft: databaseColumnNameDraft,
    columnOptionsDraft: databaseColumnOptionsDraft,
    columnTypeDraft: databaseColumnTypeDraft,
    columns: catalogColumns,
    filteredDocuments: filteredCatalog,
    isCreatingColumn: isCreatingDatabaseColumn,
    onCancelCreateColumn: resetColumnDrafts,
    onColumnNameChange: setDatabaseColumnNameDraft,
    onColumnOptionsChange: setDatabaseColumnOptionsDraft,
    onColumnTypeChange: setDatabaseColumnTypeDraft,
    onDeleteColumn: deleteDatabaseColumn,
    onMoveColumn: moveDatabaseColumn,
    onOpenDocument: openDocumentInDocumentsPage,
    onQueryChange: setCatalogQuery,
    onRenameColumn: renameDatabaseColumn,
    onSaveColumn: () => {
      void createDatabaseColumn()
    },
    onToggleCreateColumn: () => setIsCreatingDatabaseColumn((previous) => !previous),
    onUpdateColumnOptions: updateDatabaseColumnOptions,
    onUpdateField: updateDocumentDatabaseValue,
    query: catalogQuery,
    selectedDocumentId
  }

  const standalone: DatabaseStandaloneProps = {
    activeSavedView: activeDatabaseSavedView,
    activeSavedViewId: activeDatabaseSavedViewId,
    bulkFieldValues: databaseEntityBulkFieldValues,
    canSaveColumn: standaloneCanSaveColumn,
    columnNameDraft: databaseColumnNameDraft,
    columnOptionsDraft: databaseColumnOptionsDraft,
    columnTypeDraft: databaseColumnTypeDraft,
    databaseDescriptionDraft,
    databaseEntities,
    databaseNameDraft,
    databases: standaloneDatabases,
    documentCatalog,
    entityDatabaseId: databaseEntityDatabaseId,
    entityDocumentId: databaseEntityDocumentId,
    entityFieldValues: databaseEntityFieldValues,
    filterQuery: databaseEntityFilterQuery,
    filteredEntityRows: filteredStandaloneDatabaseEntityRows,
    filterScope: databaseEntityFilterScope,
    isCreatingColumn: isCreatingDatabaseColumn,
    isCreatingDatabase,
    isCreatingEntity: isCreatingDatabaseEntity,
    isCreatingSavedView: isCreatingDatabaseSavedView,
    onApplyFieldToSelected: (columnId) => {
      void applyDatabaseEntityFieldToSelected(columnId)
    },
    onBeginSavedViewCreation: beginCurrentDatabaseSavedViewCreation,
    onBulkFieldChange: updateDatabaseEntityBulkFieldValue,
    onCancelCreateColumn: resetColumnDrafts,
    onCancelCreateDatabase: resetDatabaseDrafts,
    onCancelCreateEntity: resetEntityDrafts,
    onCancelSavedViewCreation: cancelCurrentDatabaseSavedViewCreation,
    onClearBulkFieldValues: () => setDatabaseEntityBulkFieldValues({}),
    onClearFieldFromSelected: (columnId) => {
      void clearDatabaseEntityFieldFromSelected(columnId)
    },
    onClearSelectedEntities: () => setSelectedDatabaseEntityIds([]),
    onClearSelectedEntityDocuments: () => {
      void clearSelectedDatabaseEntityDocuments()
    },
    onColumnNameChange: setDatabaseColumnNameDraft,
    onColumnOptionsChange: setDatabaseColumnOptionsDraft,
    onColumnTypeChange: setDatabaseColumnTypeDraft,
    onDatabaseDescriptionChange: setDatabaseDescriptionDraft,
    onDatabaseNameChange: setDatabaseNameDraft,
    onDeleteColumn: deleteDatabaseColumn,
    onDeleteDatabase: () => {
      void deleteCurrentDatabase()
    },
    onDeleteEntity: deleteDatabaseEntity,
    onDeleteSavedView: () => {
      void deleteCurrentDatabaseSavedView()
    },
    onDeleteSelectedEntities: () => {
      void deleteSelectedDatabaseEntities()
    },
    onEntityDatabaseIdChange: setDatabaseEntityDatabaseId,
    onEntityDocumentIdChange: setDatabaseEntityDocumentId,
    onEntityDraftFieldChange: (columnId, value) => {
      const normalizedValue = normalizeDocumentDatabaseFieldValue(value)
      setDatabaseEntityFieldValues((previous) => {
        const nextFieldValues = { ...previous }
        if (normalizedValue === null) {
          delete nextFieldValues[columnId]
        } else {
          nextFieldValues[columnId] = normalizedValue
        }
        return nextFieldValues
      })
    },
    onFilterQueryChange: setDatabaseEntityFilterQuery,
    onFilterScopeChange: setDatabaseEntityFilterScope,
    onMoveColumn: moveDatabaseColumn,
    onRenameColumn: renameDatabaseColumn,
    onSavedViewNameChange: setDatabaseSavedViewNameDraft,
    onSavedViewSelect: handleDatabaseSavedViewSelect,
    onSaveColumn: () => {
      void createDatabaseColumn()
    },
    onSaveSavedView: () => {
      void saveCurrentDatabaseSavedView()
    },
    onSelectVisibleEntities: selectVisibleDatabaseEntities,
    onSortModeChange: setDatabaseEntitySortMode,
    onSubmitCreateDatabase: () => {
      void createDatabase()
    },
    onSubmitCreateEntity: () => {
      void createDatabaseEntity()
    },
    onToggleCreateColumn: () => setIsCreatingDatabaseColumn((previous) => !previous),
    onToggleCreateDatabase: () => setIsCreatingDatabase((previous) => !previous),
    onToggleCreateEntity: () => setIsCreatingDatabaseEntity((previous) => !previous),
    onToggleEntitySelection: toggleDatabaseEntitySelection,
    onUpdateColumnOptions: updateDatabaseColumnOptions,
    onUpdateEntityDocument: updateDatabaseEntityDocument,
    onUpdateEntityField: updateDatabaseEntityField,
    onUpdateSavedView: () => {
      void updateCurrentDatabaseSavedView()
    },
    onViewModeChange: setDatabaseEntityViewMode,
    savedViewDirty: databaseSavedViewDirty,
    savedViewNameDraft: databaseSavedViewNameDraft,
    savedViews: databaseSavedViews,
    selectedDatabase,
    selectedDatabaseColumns,
    selectedEntitiesHaveLinkedDocument,
    selectedEntityIdSet: selectedDatabaseEntityIdSet,
    selectedEntityIds: selectedVisibleDatabaseEntityIds,
    sortMode: databaseEntitySortMode,
    viewMode: databaseEntityViewMode
  }

  return {
    board,
    catalog,
    standalone
  }
}