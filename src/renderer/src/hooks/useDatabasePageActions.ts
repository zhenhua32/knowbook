import { useCallback, useMemo } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type {
  DatabaseEntity,
  DatabaseSavedView,
  DatabaseSavedViewLayoutMode,
  DatabaseSavedViewSortMode,
  DocumentCatalogEntry,
  DocumentDatabaseColumn,
  HomeData
} from '@shared/contracts'
import type { UiText } from '../i18n'

type DatabaseEntityFilterScope = '' | '__document__' | string

type UseDatabasePageActionsParams = {
  activeDatabaseSavedViewId: string
  databaseEntityDatabaseId: string
  databaseEntityFilterQuery: string
  databaseEntityFilterScope: DatabaseEntityFilterScope
  databaseEntitySortMode: DatabaseSavedViewSortMode
  databaseEntityViewMode: DatabaseSavedViewLayoutMode
  databaseSavedViewNameDraft: string
  databaseSavedViews: DatabaseSavedView[]
  setActiveDatabaseSavedViewId: Dispatch<SetStateAction<string>>
  setBackupMessage: (message: string | null) => void
  setCatalogColumns: Dispatch<SetStateAction<DocumentDatabaseColumn[]>>
  setCatalogDocuments: Dispatch<SetStateAction<DocumentCatalogEntry[]>>
  setDatabaseEntities: Dispatch<SetStateAction<DatabaseEntity[]>>
  setDatabaseEntityFilterQuery: Dispatch<SetStateAction<string>>
  setDatabaseEntityFilterScope: Dispatch<SetStateAction<DatabaseEntityFilterScope>>
  setDatabaseEntitySortMode: Dispatch<SetStateAction<DatabaseSavedViewSortMode>>
  setDatabaseEntityViewMode: Dispatch<SetStateAction<DatabaseSavedViewLayoutMode>>
  setDatabaseSavedViewNameDraft: Dispatch<SetStateAction<string>>
  setDatabaseSavedViews: Dispatch<SetStateAction<DatabaseSavedView[]>>
  setHomeData: Dispatch<SetStateAction<HomeData>>
  setIsCreatingDatabaseSavedView: Dispatch<SetStateAction<boolean>>
  setSelectedDatabaseColumns: Dispatch<SetStateAction<DocumentDatabaseColumn[]>>
  setSelectedDatabaseEntityIds: Dispatch<SetStateAction<string[]>>
  ui: UiText
}

export function useDatabasePageActions({
  activeDatabaseSavedViewId,
  databaseEntityDatabaseId,
  databaseEntityFilterQuery,
  databaseEntityFilterScope,
  databaseEntitySortMode,
  databaseEntityViewMode,
  databaseSavedViewNameDraft,
  databaseSavedViews,
  setActiveDatabaseSavedViewId,
  setBackupMessage,
  setCatalogColumns,
  setCatalogDocuments,
  setDatabaseEntities,
  setDatabaseEntityFilterQuery,
  setDatabaseEntityFilterScope,
  setDatabaseEntitySortMode,
  setDatabaseEntityViewMode,
  setDatabaseSavedViewNameDraft,
  setDatabaseSavedViews,
  setHomeData,
  setIsCreatingDatabaseSavedView,
  setSelectedDatabaseColumns,
  setSelectedDatabaseEntityIds,
  ui
}: UseDatabasePageActionsParams) {
  const activeDatabaseSavedView = useMemo(
    () => databaseSavedViews.find((view) => view.id === activeDatabaseSavedViewId) ?? null,
    [activeDatabaseSavedViewId, databaseSavedViews]
  )

  const refreshDocumentCatalogData = useCallback(async () => {
    const [refreshedColumns, refreshedCatalog] = await Promise.all([
      window.knowbook.getDocumentDatabaseColumns(),
      window.knowbook.getDocumentCatalog()
    ])
    setCatalogColumns(refreshedColumns)
    setCatalogDocuments(refreshedCatalog)
    setHomeData((previous) => ({
      ...previous,
      databaseColumns: refreshedColumns,
      documentCatalog: refreshedCatalog
    }))
  }, [setCatalogColumns, setCatalogDocuments, setHomeData])

  const refreshDatabasePageData = useCallback(async (
    targetDatabaseId: string | null = databaseEntityDatabaseId,
    preferredSavedViewId?: string
  ) => {
    const [refreshedHome, refreshedEntities, refreshedColumns, refreshedViews] = await Promise.all([
      window.knowbook.getHomeData(),
      targetDatabaseId ? window.knowbook.getDatabaseEntities(targetDatabaseId) : Promise.resolve<DatabaseEntity[]>([]),
      window.knowbook.getDocumentDatabaseColumns(targetDatabaseId),
      targetDatabaseId ? window.knowbook.getDatabaseSavedViews(targetDatabaseId) : Promise.resolve<DatabaseSavedView[]>([])
    ])
    setHomeData(refreshedHome)
    setDatabaseEntities(refreshedEntities)
    setSelectedDatabaseColumns(refreshedColumns)
    setDatabaseSavedViews(refreshedViews)
    setActiveDatabaseSavedViewId((current) => {
      const nextId = preferredSavedViewId ?? current
      return nextId && refreshedViews.some((view) => view.id === nextId) ? nextId : ''
    })
  }, [
    databaseEntityDatabaseId,
    setActiveDatabaseSavedViewId,
    setDatabaseEntities,
    setDatabaseSavedViews,
    setHomeData,
    setSelectedDatabaseColumns
  ])

  const applyDatabaseSavedView = useCallback((view: DatabaseSavedView) => {
    setActiveDatabaseSavedViewId(view.id)
    setDatabaseEntityFilterQuery(view.filterQuery)
    setDatabaseEntityFilterScope(view.filterScope as DatabaseEntityFilterScope)
    setDatabaseEntitySortMode(view.sortMode)
    setDatabaseEntityViewMode(view.viewMode)
    setSelectedDatabaseEntityIds([])
  }, [
    setActiveDatabaseSavedViewId,
    setDatabaseEntityFilterQuery,
    setDatabaseEntityFilterScope,
    setDatabaseEntitySortMode,
    setDatabaseEntityViewMode,
    setSelectedDatabaseEntityIds
  ])

  const handleDatabaseSavedViewSelect = useCallback((viewId: string) => {
    if (!viewId) {
      setActiveDatabaseSavedViewId('')
      return
    }

    const nextView = databaseSavedViews.find((view) => view.id === viewId)
    if (!nextView) {
      return
    }

    applyDatabaseSavedView(nextView)
  }, [applyDatabaseSavedView, databaseSavedViews, setActiveDatabaseSavedViewId])

  const beginCurrentDatabaseSavedViewCreation = useCallback(() => {
    const suggestedName = activeDatabaseSavedView?.name ?? ui.databaseSavedViewDefaultName(databaseSavedViews.length + 1)
    setDatabaseSavedViewNameDraft(suggestedName)
    setIsCreatingDatabaseSavedView(true)
  }, [
    activeDatabaseSavedView,
    databaseSavedViews.length,
    setDatabaseSavedViewNameDraft,
    setIsCreatingDatabaseSavedView,
    ui
  ])

  const cancelCurrentDatabaseSavedViewCreation = useCallback(() => {
    setIsCreatingDatabaseSavedView(false)
    setDatabaseSavedViewNameDraft('')
  }, [setDatabaseSavedViewNameDraft, setIsCreatingDatabaseSavedView])

  const saveCurrentDatabaseSavedView = useCallback(async () => {
    if (!databaseEntityDatabaseId) {
      return
    }

    const nextName = databaseSavedViewNameDraft.trim()
    if (!nextName.trim()) {
      return
    }

    try {
      const createdView = await window.knowbook.createDatabaseSavedView({
        databaseId: databaseEntityDatabaseId,
        name: nextName,
        filterQuery: databaseEntityFilterQuery,
        filterScope: databaseEntityFilterScope,
        sortMode: databaseEntitySortMode,
        viewMode: databaseEntityViewMode
      })
      setDatabaseSavedViews((current) => [createdView, ...current.filter((view) => view.id !== createdView.id)])
      applyDatabaseSavedView(createdView)
      setIsCreatingDatabaseSavedView(false)
      setDatabaseSavedViewNameDraft('')
      await refreshDatabasePageData(databaseEntityDatabaseId, createdView.id)
      setBackupMessage(ui.databaseSavedViewCreated(createdView.name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseSavedViewCreateFailed
      setBackupMessage(message)
    }
  }, [
    applyDatabaseSavedView,
    databaseEntityDatabaseId,
    databaseEntityFilterQuery,
    databaseEntityFilterScope,
    databaseEntitySortMode,
    databaseEntityViewMode,
    databaseSavedViewNameDraft,
    refreshDatabasePageData,
    setBackupMessage,
    setDatabaseSavedViewNameDraft,
    setDatabaseSavedViews,
    setIsCreatingDatabaseSavedView,
    ui
  ])

  const updateCurrentDatabaseSavedView = useCallback(async () => {
    if (!activeDatabaseSavedView) {
      return
    }

    try {
      const updatedView = await window.knowbook.updateDatabaseSavedView({
        viewId: activeDatabaseSavedView.id,
        filterQuery: databaseEntityFilterQuery,
        filterScope: databaseEntityFilterScope,
        sortMode: databaseEntitySortMode,
        viewMode: databaseEntityViewMode
      })
      await refreshDatabasePageData(databaseEntityDatabaseId, updatedView.id)
      setBackupMessage(ui.databaseSavedViewUpdated(updatedView.name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseSavedViewUpdateFailed
      setBackupMessage(message)
    }
  }, [
    activeDatabaseSavedView,
    databaseEntityDatabaseId,
    databaseEntityFilterQuery,
    databaseEntityFilterScope,
    databaseEntitySortMode,
    databaseEntityViewMode,
    refreshDatabasePageData,
    setBackupMessage,
    ui
  ])

  const deleteCurrentDatabaseSavedView = useCallback(async () => {
    if (!activeDatabaseSavedView) {
      return
    }

    if (!window.confirm(ui.confirmDeleteDatabaseSavedView(activeDatabaseSavedView.name))) {
      return
    }

    try {
      await window.knowbook.deleteDatabaseSavedView(activeDatabaseSavedView.id)
      await refreshDatabasePageData(databaseEntityDatabaseId, '')
      setBackupMessage(ui.databaseSavedViewDeleted(activeDatabaseSavedView.name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseSavedViewDeleteFailed
      setBackupMessage(message)
    }
  }, [activeDatabaseSavedView, databaseEntityDatabaseId, refreshDatabasePageData, setBackupMessage, ui])

  return {
    beginCurrentDatabaseSavedViewCreation,
    cancelCurrentDatabaseSavedViewCreation,
    deleteCurrentDatabaseSavedView,
    handleDatabaseSavedViewSelect,
    refreshDatabasePageData,
    refreshDocumentCatalogData,
    saveCurrentDatabaseSavedView,
    updateCurrentDatabaseSavedView
  }
}
