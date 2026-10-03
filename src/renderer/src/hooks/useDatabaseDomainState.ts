import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'
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
import { getErrorMessage } from '../utils/errorMessage'
import { withoutDatabaseField, type DatabaseDeletion } from '../features/database/model/databaseDeletion'
import type { DatabaseTextDraftCache } from '../features/database/model/databaseTextDrafts'

export const BOARD_GROUP_BY_PARENT = '__parent__'

export type DatabaseWorkspaceView = 'catalog' | 'standalone'
export type StandaloneDatabaseEntityViewMode = DatabaseSavedViewLayoutMode
export type DatabaseEntityFilterScope = '' | '__document__' | string
export type DatabaseEntitySortMode = DatabaseSavedViewSortMode

export function useDatabaseDomainState(isActive = true) {
  const databaseTextDraftCache = useRef<DatabaseTextDraftCache | null>(null)
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
  const [listReady, setListReady] = useState(false)
  const [loadedDatabaseId, setLoadedDatabaseId] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [dataLoading, setDataLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const listWriteRevision = useRef(0)
  const dataWriteRevision = useRef(0)
  const currentSourceId = useRef(databaseEntityDatabaseId)
  currentSourceId.current = databaseEntityDatabaseId
  const latestViews = useRef(databaseSavedViews)
  latestViews.current = databaseSavedViews
  const acknowledgeDatabase = useCallback((saved: DocumentDatabase) => {
    listWriteRevision.current++
    setDatabases(previous => previous.some(database => database.id === saved.id)
      ? previous.map(database => database.id === saved.id ? saved : database)
      : [...previous, saved])
  }, [])
  const acknowledgeWorkspaceRead = useCallback((databaseId: string) => {
    // A complete Page read supersedes an older independent source load.
    listWriteRevision.current++
    dataWriteRevision.current++
    setListReady(true)
    setListError(null)
    setListLoading(false)
    setLoadedDatabaseId(databaseId)
    setDataError(null)
    setDataLoading(false)
  }, [])
  const acknowledgeDeletion = useCallback((deleted: DatabaseDeletion,
    applyToCurrentSource = currentSourceId.current === deleted.databaseId) => {
    if (deleted.kind === 'database') {
      listWriteRevision.current++
      setDatabases(previous => previous.filter(database => database.id !== deleted.id))
      return
    }
    if (!applyToCurrentSource) return
    dataWriteRevision.current++
    if (deleted.kind === 'view') {
      setDatabaseSavedViews(previous => previous.filter(view => view.id !== deleted.id))
      setActiveDatabaseSavedViewId(previous => previous === deleted.id
        ? latestViews.current.find(view => view.id !== deleted.id)?.id ?? '' : previous)
    } else if (deleted.kind === 'field') {
      setSelectedDatabaseColumns(previous => previous.filter(field => field.id !== deleted.id))
      setDatabaseEntities(previous => previous.map(entity => ({ ...entity, fieldValues: withoutDatabaseField(entity.fieldValues, deleted.id) })))
      setDatabaseEntityFieldValues(previous => withoutDatabaseField(previous, deleted.id))
      setDatabaseEntityBulkFieldValues(previous => withoutDatabaseField(previous, deleted.id))
    } else {
      const ids = new Set(deleted.kind === 'records' ? deleted.ids : [deleted.id])
      setDatabaseEntities(previous => previous.filter(entity => !ids.has(entity.id)))
      setSelectedDatabaseEntityIds(previous => previous.filter(id => !ids.has(id)))
    }
  }, [])
  const activateCreatedDatabase = useCallback((databaseId: string) => {
    // A successful creation confirms an empty source. Keep the workspace
    // mounted while its normal reads run, without presenting the old rows.
    setLoadedDatabaseId(databaseId)
    setDataError(null)
    setSelectedDatabaseColumns([])
    setDatabaseEntities([])
    setDatabaseSavedViews([])
    setActiveDatabaseSavedViewId('')
    setSelectedDatabaseEntityIds([])
    setDatabaseEntityFieldValues({})
    setDatabaseEntityBulkFieldValues({})
    setDatabaseEntityDatabaseId(databaseId)
  }, [])
  const reloadDatabaseDomain = useCallback(() => {
    setDatabaseDomainRevision((revision) => revision + 1)
  }, [])

  useEffect(() => {
    if (!isActive) {
      return
    }

    let mounted = true
    const revision = listWriteRevision.current
    setListLoading(true)
    setListError(null)
    window.knowbook.getDatabases().then((items) => {
      if (mounted && revision === listWriteRevision.current) {
        setDatabases(items)
        setListReady(true)
        setDatabaseEntityDatabaseId((current) => {
          if (current && items.some((database) => database.id === current)) {
            return current
          }
          let rememberedId: string | null = null
          try { rememberedId = window.localStorage.getItem('knowbook.database.last-source') } catch { /* A preference cache is optional. */ }
          const remembered = items.find((database) => database.id === rememberedId)
          return remembered?.id ?? items.find((database) => database.kind === 'document-catalog')?.id ?? items[0]?.id ?? ''
        })
      }
    }).catch((error) => {
      if (mounted && revision === listWriteRevision.current) {
        setListError(getErrorMessage(error, 'Databases could not be loaded.'))
        console.warn('Failed to load databases.', error)
      }
    }).finally(() => { if (mounted) setListLoading(false) })

    return () => {
      mounted = false
    }
  }, [databaseDomainRevision, isActive])

  useEffect(() => {
    if (!isActive) {
      return
    }

    let mounted = true
    const revision = dataWriteRevision.current
    setDataError(null)

    if (!databaseEntityDatabaseId) {
      setDataLoading(false)
      setLoadedDatabaseId(null)
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

    setDataLoading(true)
    if (loadedDatabaseId !== databaseEntityDatabaseId) {
      setDatabaseSavedViews([])
      setActiveDatabaseSavedViewId('')
      setIsCreatingDatabaseSavedView(false)
      setDatabaseSavedViewNameDraft('')
      setDatabaseEntityFilterQuery('')
      setDatabaseEntityFilterScope('')
      setDatabaseEntitySortMode('updated-desc')
      setDatabaseEntityViewMode('cards')
    }

    Promise.all([
      window.knowbook.getDatabaseEntities(databaseEntityDatabaseId),
      window.knowbook.getDocumentDatabaseColumns(databaseEntityDatabaseId),
      window.knowbook.getDatabaseSavedViews(databaseEntityDatabaseId)
    ]).then(([items, columns, views]) => {
      if (mounted && revision === dataWriteRevision.current) {
        setLoadedDatabaseId(databaseEntityDatabaseId)
        setDatabaseEntities(items)
        setSelectedDatabaseColumns(columns)
        setDatabaseSavedViews(views)
        setDatabaseEntityFieldValues({})
        setDatabaseEntityBulkFieldValues({})
        setSelectedDatabaseEntityIds([])
      }
    }).catch((error) => {
      if (mounted && revision === dataWriteRevision.current) {
        setDataError(getErrorMessage(error, 'Database records could not be loaded.'))
        console.warn('Failed to load database workspace data.', error)
      }
    }).finally(() => { if (mounted) setDataLoading(false) })

    return () => {
      mounted = false
    }
  }, [databaseDomainRevision, databaseEntityDatabaseId, isActive])

  useEffect(() => {
    if (!databaseEntityDatabaseId) {
      return
    }
    try { window.localStorage.setItem('knowbook.database.last-source', databaseEntityDatabaseId) } catch { /* Keep navigation usable without storage. */ }
  }, [databaseEntityDatabaseId])

  useEffect(() => {
    if (!databaseEntityFilterScope || databaseEntityFilterScope === '__document__') {
      return
    }

    if (!selectedDatabaseColumns.some((column) => column.id === databaseEntityFilterScope)) {
      setDatabaseEntityFilterScope('')
    }
  }, [databaseEntityFilterScope, selectedDatabaseColumns])

  return {
    databaseTextDraftCache,
    acknowledgeDatabase,
    acknowledgeWorkspaceRead,
    acknowledgeDeletion,
    activateCreatedDatabase,
    databaseError: listError ?? dataError,
    databaseLoading: listLoading || dataLoading,
    databaseReady: listReady && (!databaseEntityDatabaseId || loadedDatabaseId === databaseEntityDatabaseId),
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
