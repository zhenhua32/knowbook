import { useMemo } from 'react'
import { buildBoardColumns, isBoardGroupableColumn } from '@shared/board'
import type {
  DatabaseEntity,
  DatabaseSavedView,
  DatabaseSavedViewLayoutMode,
  DatabaseSavedViewSortMode,
  DocumentCatalogEntry,
  DocumentDatabase,
  DocumentDatabaseColumn,
  DocumentDatabaseFieldValue
} from '@shared/contracts'
import { isDefaultDocumentDatabase } from '../components/database/databaseFieldUtils'

type DatabaseWorkspaceView = 'catalog' | 'standalone'
type DatabaseEntityFilterScope = '' | '__document__' | string

type UseDatabaseDerivedStateParams = {
  activeDatabaseSavedViewId: string
  boardGroupBy: string
  catalogColumns: DocumentDatabaseColumn[]
  catalogDocuments: DocumentCatalogEntry[]
  databaseEntities: DatabaseEntity[]
  databaseEntityDatabaseId: string
  databaseEntityFilterQuery: string
  databaseEntityFilterScope: DatabaseEntityFilterScope
  databaseEntitySortMode: DatabaseSavedViewSortMode
  databaseEntityViewMode: DatabaseSavedViewLayoutMode
  databaseSavedViews: DatabaseSavedView[]
  databaseWorkspaceView: DatabaseWorkspaceView
  databases: DocumentDatabase[]
  deferredCatalogQuery: string
  documentCatalog: DocumentCatalogEntry[]
  isDatabasePageActive: boolean
  selectedDatabaseColumns: DocumentDatabaseColumn[]
  selectedDatabaseEntityIds: string[]
  uiDocumentCatalogHint: string
  uiDocumentCatalogTitle: string
  uiStandaloneDatabasesHint: string
  uiStandaloneDatabasesTitle: string
}

export function useDatabaseDerivedState({
  activeDatabaseSavedViewId,
  boardGroupBy,
  catalogColumns,
  catalogDocuments,
  databaseEntities,
  databaseEntityDatabaseId,
  databaseEntityFilterQuery,
  databaseEntityFilterScope,
  databaseEntitySortMode,
  databaseEntityViewMode,
  databaseSavedViews,
  databaseWorkspaceView,
  databases,
  deferredCatalogQuery,
  documentCatalog,
  isDatabasePageActive,
  selectedDatabaseColumns,
  selectedDatabaseEntityIds,
  uiDocumentCatalogHint,
  uiDocumentCatalogTitle,
  uiStandaloneDatabasesHint,
  uiStandaloneDatabasesTitle
}: UseDatabaseDerivedStateParams) {
  const boardGroupableColumns = useMemo(
    () => catalogColumns.filter(isBoardGroupableColumn),
    [catalogColumns]
  )

  const boardGroupingColumn = useMemo(
    () => (boardGroupBy === '__parent__'
      ? null
      : boardGroupableColumns.find((column) => column.id === boardGroupBy) ?? null),
    [boardGroupBy, boardGroupableColumns]
  )

  const standaloneDatabases = useMemo(
    () => databases.filter((database) => !isDefaultDocumentDatabase(database)),
    [databases]
  )

  const selectedDatabase = useMemo(
    () => standaloneDatabases.find((database) => database.id === databaseEntityDatabaseId) ?? null,
    [databaseEntityDatabaseId, standaloneDatabases]
  )

  const activeDatabaseSavedView = useMemo(
    () => databaseSavedViews.find((view) => view.id === activeDatabaseSavedViewId) ?? null,
    [activeDatabaseSavedViewId, databaseSavedViews]
  )

  const databaseSavedViewDirty = activeDatabaseSavedView !== null && (
    activeDatabaseSavedView.filterQuery !== databaseEntityFilterQuery
    || activeDatabaseSavedView.filterScope !== databaseEntityFilterScope
    || activeDatabaseSavedView.sortMode !== databaseEntitySortMode
    || activeDatabaseSavedView.viewMode !== databaseEntityViewMode
  )

  const databasePageTitle = databaseWorkspaceView === 'standalone' ? uiStandaloneDatabasesTitle : uiDocumentCatalogTitle
  const databasePageHint = databaseWorkspaceView === 'standalone' ? uiStandaloneDatabasesHint : uiDocumentCatalogHint
  const isDocumentCatalogViewActive = isDatabasePageActive && databaseWorkspaceView === 'catalog'
  const trimmedDatabaseEntityFilterQuery = databaseEntityFilterQuery.trim().toLowerCase()

  const filteredStandaloneDatabaseEntityRows = useMemo(() => {
    const standaloneDatabaseEntityRows = databaseEntities.map((entity) => {
      const linkedDocument = entity.documentId
        ? documentCatalog.find((document) => document.id === entity.documentId) ?? null
        : null

      return {
        entity,
        linkedDocument,
        searchableDocumentText: [linkedDocument?.title ?? '', linkedDocument?.path ?? ''].join(' ').trim(),
        searchableFieldText: selectedDatabaseColumns
          .map((column) => formatDocumentDatabaseFieldValueForSearch(entity.fieldValues[column.id] ?? null))
          .join(' ')
      }
    })

    return standaloneDatabaseEntityRows
      .filter(({ entity, searchableDocumentText, searchableFieldText }) => {
        if (!trimmedDatabaseEntityFilterQuery) {
          return true
        }

        if (databaseEntityFilterScope === '__document__') {
          return searchableDocumentText.toLowerCase().includes(trimmedDatabaseEntityFilterQuery)
        }

        if (databaseEntityFilterScope) {
          return formatDocumentDatabaseFieldValueForSearch(entity.fieldValues[databaseEntityFilterScope] ?? null)
            .toLowerCase()
            .includes(trimmedDatabaseEntityFilterQuery)
        }

        return [searchableDocumentText, searchableFieldText]
          .join(' ')
          .toLowerCase()
          .includes(trimmedDatabaseEntityFilterQuery)
      })
      .sort((left, right) => {
        if (databaseEntitySortMode === 'updated-asc') {
          return new Date(left.entity.updatedAt).getTime() - new Date(right.entity.updatedAt).getTime()
        }

        if (databaseEntitySortMode === 'created-desc') {
          return new Date(right.entity.createdAt).getTime() - new Date(left.entity.createdAt).getTime()
        }

        if (databaseEntitySortMode === 'created-asc') {
          return new Date(left.entity.createdAt).getTime() - new Date(right.entity.createdAt).getTime()
        }

        return new Date(right.entity.updatedAt).getTime() - new Date(left.entity.updatedAt).getTime()
      })
  }, [
    databaseEntities,
    databaseEntityFilterScope,
    databaseEntitySortMode,
    documentCatalog,
    selectedDatabaseColumns,
    trimmedDatabaseEntityFilterQuery
  ])

  const selectedDatabaseEntityIdSet = useMemo(
    () => new Set(selectedDatabaseEntityIds),
    [selectedDatabaseEntityIds]
  )

  const filteredStandaloneDatabaseEntityIds = useMemo(
    () => filteredStandaloneDatabaseEntityRows.map(({ entity }) => entity.id),
    [filteredStandaloneDatabaseEntityRows]
  )

  const selectedVisibleDatabaseEntityIds = useMemo(
    () => filteredStandaloneDatabaseEntityIds.filter((entityId) => selectedDatabaseEntityIdSet.has(entityId)),
    [filteredStandaloneDatabaseEntityIds, selectedDatabaseEntityIdSet]
  )

  const selectedVisibleDatabaseEntitiesHaveLinkedDocument = useMemo(
    () => filteredStandaloneDatabaseEntityRows
      .filter(({ entity }) => selectedDatabaseEntityIdSet.has(entity.id))
      .some(({ entity }) => Boolean(entity.documentId)),
    [filteredStandaloneDatabaseEntityRows, selectedDatabaseEntityIdSet]
  )

  const trimmedCatalogQuery = deferredCatalogQuery.trim().toLowerCase()

  const filteredCatalog = useMemo(() => {
    if (!isDocumentCatalogViewActive) {
      return catalogDocuments
    }

    return catalogDocuments.filter((document) => {
      if (!trimmedCatalogQuery) {
        return true
      }

      const dynamicFieldSearchText = Object.values(document.fieldValues)
        .map((value) => formatDocumentDatabaseFieldValueForSearch(value))
        .join(' ')

      return [document.title, document.path, document.summary, dynamicFieldSearchText]
        .join(' ')
        .toLowerCase()
        .includes(trimmedCatalogQuery)
    })
  }, [catalogDocuments, isDocumentCatalogViewActive, trimmedCatalogQuery])

  const boardColumns = useMemo(() => {
    if (!isDocumentCatalogViewActive) {
      return []
    }

    return buildBoardColumns(filteredCatalog, boardGroupingColumn)
  }, [boardGroupingColumn, filteredCatalog, isDocumentCatalogViewActive])

  return {
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
  }
}

function formatDocumentDatabaseFieldValueForSearch(value: DocumentDatabaseFieldValue): string {
  if (Array.isArray(value)) {
    return value.join(' ')
  }

  if (typeof value === 'boolean') {
    return value ? 'checked true yes' : 'unchecked false no'
  }

  return value ?? ''
}