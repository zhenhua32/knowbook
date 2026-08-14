import { useCallback, useDeferredValue, useEffect, useState } from 'react'
import type {
  DatabaseEntity,
  DatabaseSavedView,
  DatabaseSavedViewLayoutMode,
  DatabaseSavedViewSortMode,
  DocumentDatabase,
  DocumentDatabaseColumn,
  DocumentDatabaseColumnType,
  DocumentDatabaseFieldValue
} from '@shared/contracts'
import { isDefaultDocumentDatabase } from '../components/database/databaseFieldUtils'

export const BOARD_GROUP_BY_PARENT = '__parent__'

export type DatabaseWorkspaceView = 'catalog' | 'standalone'
export type StandaloneDatabaseEntityViewMode = DatabaseSavedViewLayoutMode
export type DatabaseEntityFilterScope = '' | '__document__' | string
export type DatabaseEntitySortMode = DatabaseSavedViewSortMode

export function useDatabaseDomainState(isActive = true) {
  const [catalogQuery, setCatalogQuery] = useState('')
  const deferredCatalogQuery = useDeferredValue(catalogQuery)
  const [databaseWorkspaceView, setDatabaseWorkspaceView] = useState<DatabaseWorkspaceView>('catalog')
  const [boardGroupBy, setBoardGroupBy] = useState(BOARD_GROUP_BY_PARENT)
  const [isCreatingDatabaseColumn, setIsCreatingDatabaseColumn] = useState(false)
  const [databaseColumnNameDraft, setDatabaseColumnNameDraft] = useState('')
  const [databaseColumnTypeDraft, setDatabaseColumnTypeDraft] = useState<DocumentDatabaseColumnType>('text')
  const [databaseColumnOptionsDraft, setDatabaseColumnOptionsDraft] = useState('')
  const [databases, setDatabases] = useState<DocumentDatabase[]>([])
  const [selectedDatabaseColumns, setSelectedDatabaseColumns] = useState<DocumentDatabaseColumn[]>([])
  const [databaseEntities, setDatabaseEntities] = useState<DatabaseEntity[]>([])
  const [isCreatingDatabase, setIsCreatingDatabase] = useState(false)
  const [databaseNameDraft, setDatabaseNameDraft] = useState('')
  const [databaseDescriptionDraft, setDatabaseDescriptionDraft] = useState('')
  const [isCreatingDatabaseEntity, setIsCreatingDatabaseEntity] = useState(false)
  const [databaseEntityDatabaseId, setDatabaseEntityDatabaseId] = useState('')
  const [databaseSavedViews, setDatabaseSavedViews] = useState<DatabaseSavedView[]>([])
  const [activeDatabaseSavedViewId, setActiveDatabaseSavedViewId] = useState('')
  const [isCreatingDatabaseSavedView, setIsCreatingDatabaseSavedView] = useState(false)
  const [databaseSavedViewNameDraft, setDatabaseSavedViewNameDraft] = useState('')
  const [databaseEntityDocumentId, setDatabaseEntityDocumentId] = useState('')
  const [databaseEntityFieldValues, setDatabaseEntityFieldValues] = useState<Record<string, DocumentDatabaseFieldValue>>({})
  const [databaseEntityBulkFieldValues, setDatabaseEntityBulkFieldValues] = useState<Record<string, DocumentDatabaseFieldValue>>({})
  const [databaseEntityFilterQuery, setDatabaseEntityFilterQuery] = useState('')
  const [databaseEntityFilterScope, setDatabaseEntityFilterScope] = useState<DatabaseEntityFilterScope>('')
  const [databaseEntitySortMode, setDatabaseEntitySortMode] = useState<DatabaseEntitySortMode>('updated-desc')
  const [databaseEntityViewMode, setDatabaseEntityViewMode] = useState<StandaloneDatabaseEntityViewMode>('cards')
  const [selectedDatabaseEntityIds, setSelectedDatabaseEntityIds] = useState<string[]>([])
  const [databaseDomainRevision, setDatabaseDomainRevision] = useState(0)
  const reloadDatabaseDomain = useCallback(() => {
    setDatabaseDomainRevision((revision) => revision + 1)
  }, [])

  useEffect(() => {
    if (!isActive) {
      return
    }

    let mounted = true

    window.knowbook.getDatabases().then((items) => {
      if (mounted) {
        setDatabases(items)
        setDatabaseEntityDatabaseId((current) => current || items[0]?.id || '')
      }
    }).catch((error) => {
      if (mounted) {
        console.warn('Failed to load databases.', error)
      }
    })

    return () => {
      mounted = false
    }
  }, [databaseDomainRevision, isActive])

  useEffect(() => {
    if (!isActive) {
      return
    }

    let mounted = true

    if (!databaseEntityDatabaseId) {
      setDatabaseSavedViews([])
      setActiveDatabaseSavedViewId('')
      setIsCreatingDatabaseSavedView(false)
      setDatabaseSavedViewNameDraft('')
      setSelectedDatabaseColumns([])
      setDatabaseEntities([])
      setDatabaseEntityFieldValues({})
      setDatabaseEntityBulkFieldValues({})
      setDatabaseEntityFilterQuery('')
      setDatabaseEntityFilterScope('')
      setDatabaseEntitySortMode('updated-desc')
      setDatabaseEntityViewMode('cards')
      setSelectedDatabaseEntityIds([])
      return () => {
        mounted = false
      }
    }

    setDatabaseSavedViews([])
    setActiveDatabaseSavedViewId('')
    setIsCreatingDatabaseSavedView(false)
    setDatabaseSavedViewNameDraft('')
    setDatabaseEntityFilterQuery('')
    setDatabaseEntityFilterScope('')
    setDatabaseEntitySortMode('updated-desc')
    setDatabaseEntityViewMode('cards')

    Promise.all([
      window.knowbook.getDatabaseEntities(databaseEntityDatabaseId),
      window.knowbook.getDocumentDatabaseColumns(databaseEntityDatabaseId),
      window.knowbook.getDatabaseSavedViews(databaseEntityDatabaseId)
    ]).then(([items, columns, views]) => {
      if (mounted) {
        setDatabaseEntities(items)
        setSelectedDatabaseColumns(columns)
        setDatabaseSavedViews(views)
        setDatabaseEntityFieldValues({})
        setDatabaseEntityBulkFieldValues({})
        setSelectedDatabaseEntityIds([])
      }
    }).catch((error) => {
      if (mounted) {
        console.warn('Failed to load database workspace data.', error)
      }
    })

    return () => {
      mounted = false
    }
  }, [databaseDomainRevision, databaseEntityDatabaseId, isActive])

  useEffect(() => {
    const nextStandaloneDatabases = databases.filter((database) => !isDefaultDocumentDatabase(database))

    if (nextStandaloneDatabases.length === 0) {
      if (databaseEntityDatabaseId) {
        setDatabaseEntityDatabaseId('')
      }
      return
    }

    if (!nextStandaloneDatabases.some((database) => database.id === databaseEntityDatabaseId)) {
      setDatabaseEntityDatabaseId(nextStandaloneDatabases[0].id)
    }
  }, [databaseEntityDatabaseId, databases])

  useEffect(() => {
    if (!databaseEntityFilterScope || databaseEntityFilterScope === '__document__') {
      return
    }

    if (!selectedDatabaseColumns.some((column) => column.id === databaseEntityFilterScope)) {
      setDatabaseEntityFilterScope('')
    }
  }, [databaseEntityFilterScope, selectedDatabaseColumns])

  return {
    activeDatabaseSavedViewId,
    boardGroupBy,
    catalogQuery,
    databaseColumnNameDraft,
    databaseColumnOptionsDraft,
    databaseColumnTypeDraft,
    databaseDescriptionDraft,
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
    databaseSavedViewNameDraft,
    databaseSavedViews,
    databases,
    deferredCatalogQuery,
    isCreatingDatabase,
    isCreatingDatabaseColumn,
    isCreatingDatabaseEntity,
    isCreatingDatabaseSavedView,
    reloadDatabaseDomain,
    selectedDatabaseColumns,
    selectedDatabaseEntityIds,
    setActiveDatabaseSavedViewId,
    setBoardGroupBy,
    setCatalogQuery,
    setDatabaseColumnNameDraft,
    setDatabaseColumnOptionsDraft,
    setDatabaseColumnTypeDraft,
    setDatabaseDescriptionDraft,
    setDatabaseEntities,
    setDatabaseEntityBulkFieldValues,
    setDatabaseEntityDatabaseId,
    setDatabaseEntityDocumentId,
    setDatabaseEntityFieldValues,
    setDatabaseEntityFilterQuery,
    setDatabaseEntityFilterScope,
    setDatabaseEntitySortMode,
    setDatabaseEntityViewMode,
    setDatabaseNameDraft,
    setDatabaseSavedViewNameDraft,
    setDatabaseSavedViews,
    setDatabases,
    setIsCreatingDatabase,
    setIsCreatingDatabaseColumn,
    setIsCreatingDatabaseEntity,
    setIsCreatingDatabaseSavedView,
    setSelectedDatabaseColumns,
    setSelectedDatabaseEntityIds,
    databaseWorkspaceView,
    setDatabaseWorkspaceView
  }
}
