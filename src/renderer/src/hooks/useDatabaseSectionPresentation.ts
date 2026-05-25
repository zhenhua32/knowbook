import type { ComponentProps, Dispatch, SetStateAction } from 'react'
import { DatabaseSection } from '../sections/DatabaseSection'

type DatabaseSectionProps = ComponentProps<typeof DatabaseSection>
type DatabaseBoardProps = DatabaseSectionProps['board']
type DatabaseCatalogProps = DatabaseSectionProps['catalog']

type UseDatabaseSectionPresentationParams = {
  beginDrag: DatabaseBoardProps['onDragStart']
  boardColumns: DatabaseBoardProps['boardColumns']
  boardGroupBy: DatabaseBoardProps['groupBy']
  boardGroupableColumns: DatabaseBoardProps['groupableColumns']
  boardGroupingColumn: DatabaseBoardProps['boardGroupingColumn']
  catalogCanSaveColumn: DatabaseCatalogProps['canSaveColumn']
  catalogColumns: DatabaseCatalogProps['columns']
  catalogQuery: DatabaseCatalogProps['query']
  createDatabaseColumn: () => Promise<void>
  databaseColumnNameDraft: DatabaseCatalogProps['columnNameDraft']
  databaseColumnOptionsDraft: DatabaseCatalogProps['columnOptionsDraft']
  databaseColumnTypeDraft: DatabaseCatalogProps['columnTypeDraft']
  deleteDatabaseColumn: DatabaseCatalogProps['onDeleteColumn']
  dragOverBoardColumnId: DatabaseBoardProps['dragOverColumnId']
  draggingDocumentId: DatabaseBoardProps['draggingDocumentId']
  dropOnBoardTarget: DatabaseBoardProps['onDropOnColumn']
  endDrag: DatabaseBoardProps['onDragEnd']
  filteredCatalog: DatabaseCatalogProps['filteredDocuments']
  handleBoardColumnDragOver: DatabaseBoardProps['onDragOverColumn']
  isCreatingDatabaseColumn: DatabaseCatalogProps['isCreatingColumn']
  moveDatabaseColumn: DatabaseCatalogProps['onMoveColumn']
  openDocumentInDocumentsPage: DatabaseBoardProps['onOpenDocument']
  parentGroupValue: DatabaseBoardProps['parentGroupValue']
  renameDatabaseColumn: DatabaseCatalogProps['onRenameColumn']
  selectedDocumentId: DatabaseBoardProps['selectedDocumentId']
  setBoardGroupBy: DatabaseBoardProps['onGroupByChange']
  setCatalogQuery: DatabaseCatalogProps['onQueryChange']
  setDatabaseColumnNameDraft: DatabaseCatalogProps['onColumnNameChange']
  setDatabaseColumnOptionsDraft: DatabaseCatalogProps['onColumnOptionsChange']
  setDatabaseColumnTypeDraft: DatabaseCatalogProps['onColumnTypeChange']
  setIsCreatingDatabaseColumn: Dispatch<SetStateAction<boolean>>
  updateDatabaseColumnOptions: DatabaseCatalogProps['onUpdateColumnOptions']
  updateDocumentDatabaseValue: DatabaseCatalogProps['onUpdateField']
}

export function useDatabaseSectionPresentation({
  beginDrag,
  boardColumns,
  boardGroupBy,
  boardGroupableColumns,
  boardGroupingColumn,
  catalogCanSaveColumn,
  catalogColumns,
  catalogQuery,
  createDatabaseColumn,
  databaseColumnNameDraft,
  databaseColumnOptionsDraft,
  databaseColumnTypeDraft,
  deleteDatabaseColumn,
  dragOverBoardColumnId,
  draggingDocumentId,
  dropOnBoardTarget,
  endDrag,
  filteredCatalog,
  handleBoardColumnDragOver,
  isCreatingDatabaseColumn,
  moveDatabaseColumn,
  openDocumentInDocumentsPage,
  parentGroupValue,
  renameDatabaseColumn,
  selectedDocumentId,
  setBoardGroupBy,
  setCatalogQuery,
  setDatabaseColumnNameDraft,
  setDatabaseColumnOptionsDraft,
  setDatabaseColumnTypeDraft,
  setIsCreatingDatabaseColumn,
  updateDatabaseColumnOptions,
  updateDocumentDatabaseValue
}: UseDatabaseSectionPresentationParams) {
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
    onCancelCreateColumn: () => {
      setIsCreatingDatabaseColumn(false)
      setDatabaseColumnNameDraft('')
      setDatabaseColumnTypeDraft('text')
      setDatabaseColumnOptionsDraft('')
    },
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

  return {
    board,
    catalog
  }
}