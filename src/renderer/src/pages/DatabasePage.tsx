import type { AppMessageHandler } from '../notify'
import { useCallback, useLayoutEffect, useRef } from 'react'
import '../features/database/database-workspace.css'
import type { Dispatch, SetStateAction } from 'react'
import type { DatabaseSavedView, DatabaseViewConfigV1, DocumentCatalogEntry, DocumentDatabase, DocumentDatabaseColumn, HomeData } from '@shared/contracts'
import type { UiText } from '../i18n'
import type { DatabaseDomainState, DatabaseWorkspaceBoardState } from '../types/appDomains'
import { collectDocumentCatalogPages } from '../utils/documentCatalogPagination'
import { DatabaseWorkspace } from '../features/database/DatabaseWorkspace'
import { RecoveryState } from '../components/RecoveryState'

type DatabasePageProps = {
  catalogColumns: DocumentDatabaseColumn[]
  catalogDocuments: DocumentCatalogEntry[]
  catalogLoading: boolean
  catalogReady: boolean
  catalogError: string | null
  onRetryCatalog: () => void
  database: DatabaseDomainState
  documentCatalog: DocumentCatalogEntry[]
  onCatalogColumnsChange: Dispatch<SetStateAction<DocumentDatabaseColumn[]>>
  onCatalogDocumentsChange: Dispatch<SetStateAction<DocumentCatalogEntry[]>>
  onHomeDataChange: Dispatch<SetStateAction<HomeData>>
  onMessage: AppMessageHandler
  onOpenDocument: (documentId: string) => void
  selectedDocumentId: string | null
  workspaceBoard: DatabaseWorkspaceBoardState
  ui: UiText
}

export function DatabasePage({
  catalogColumns,
  catalogDocuments,
  catalogLoading,
  catalogReady,
  catalogError,
  onRetryCatalog,
  database,
  onCatalogColumnsChange,
  onCatalogDocumentsChange,
  onHomeDataChange,
  onMessage,
  onOpenDocument,
  ui
}: DatabasePageProps) {
  const latest = useRef({ database, onCatalogColumnsChange, onCatalogDocumentsChange, onHomeDataChange })
  latest.current = { database, onCatalogColumnsChange, onCatalogDocumentsChange, onHomeDataChange }
  const mounted = useRef(true)
  const refreshGeneration = useRef(0)
  const createdSource = useRef<string | null>(null)
  const viewDraftCache = useRef(new Map<string, DatabaseViewConfigV1>())
  const sourceSession = useRef({ renderedId: database.databaseEntityDatabaseId, currentId: database.databaseEntityDatabaseId, generation: 0 })
  if (sourceSession.current.renderedId !== database.databaseEntityDatabaseId) {
    sourceSession.current.renderedId = database.databaseEntityDatabaseId
    if (sourceSession.current.currentId !== database.databaseEntityDatabaseId) {
      sourceSession.current.currentId = database.databaseEntityDatabaseId
      sourceSession.current.generation++
      refreshGeneration.current++
    }
  }
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; sourceSession.current.generation++; refreshGeneration.current++ }
  }, [])

  const changeCurrentDatabase = useCallback((databaseId: string) => {
    if (sourceSession.current.currentId !== databaseId) {
      sourceSession.current.currentId = databaseId
      sourceSession.current.generation++
      refreshGeneration.current++
    }
    const activateEmptySource = createdSource.current === databaseId
    createdSource.current = null
    if (activateEmptySource) latest.current.database.activateCreatedDatabase(databaseId)
    else latest.current.database.setDatabaseEntityDatabaseId(databaseId)
  }, [])

  const refreshWorkspace = useCallback(async (
    targetDatabaseId?: string,
    preferredViewId?: string
  ) => {
    if (!mounted.current) return
    const targetId = targetDatabaseId ?? sourceSession.current.currentId
    const requestId = ++refreshGeneration.current
    const sessionId = sourceSession.current.generation
    const isCurrentRequest = () => mounted.current && requestId === refreshGeneration.current && sessionId === sourceSession.current.generation
    const isCurrentSource = () => isCurrentRequest() && targetId === sourceSession.current.currentId
    const targetDatabase = latest.current.database.databases.find((candidate) => candidate.id === targetId)
    let result
    try {
      result = await Promise.all([
        window.knowbook.getHomeData(),
        collectDocumentCatalogPages(window.knowbook.getDocumentCatalogPage),
        window.knowbook.getDatabases(),
        targetId ? window.knowbook.getDocumentDatabaseColumns(targetId) : Promise.resolve([]),
        targetId ? window.knowbook.getDatabaseEntities(targetId) : Promise.resolve([]),
        targetId ? window.knowbook.getDatabaseSavedViews(targetId) : Promise.resolve([])
      ])
    } catch (error) {
      if (isCurrentRequest()) throw error
      return
    }
    if (!isCurrentRequest()) return
    const [home, documents, databases, columns, entities, views] = result
    const refreshedTarget = databases.find((candidate) => candidate.id === targetId) ?? targetDatabase
    const current = latest.current
    // Creating or deleting a database refreshes the shared catalog before the
    // workspace switches sources. Target data must wait for its own source.
    current.onHomeDataChange(home)
    current.onCatalogDocumentsChange(documents)
    current.database.setDatabases(databases)
    if (refreshedTarget?.kind === 'document-catalog') {
      current.onCatalogColumnsChange(columns)
    }
    if (!isCurrentSource()) return
    current.database.setSelectedDatabaseColumns(previous => isCurrentSource() ? columns : previous)
    current.database.setDatabaseEntities(previous => isCurrentSource() ? entities : previous)
    current.database.setDatabaseSavedViews(previous => isCurrentSource() ? views : previous)
    current.database.setActiveDatabaseSavedViewId((current) => {
      if (!isCurrentSource()) return current
      const candidateId = preferredViewId ?? current
      return views.some((view) => view.id === candidateId) ? candidateId : views[0]?.id ?? ''
    })
  }, [])

  const acknowledgeSavedView = useCallback((view: DatabaseSavedView) => {
    const session = sourceSession.current.generation
    const isCurrentSource = () => mounted.current && sourceSession.current.currentId === view.databaseId
      && sourceSession.current.generation === session
    if (!isCurrentSource()) return
    latest.current.database.setDatabaseSavedViews((previous) => {
      if (!isCurrentSource()) return previous
      return previous.some((candidate) => candidate.id === view.id)
        ? previous.map((candidate) => candidate.id === view.id ? view : candidate)
        : [...previous, view]
    })
  }, [])

  const acknowledgeSavedDatabase = useCallback((saved: DocumentDatabase, options?: { activate?: boolean }) => {
    if (!mounted.current) return
    // A read started before this write must not replace its acknowledged
    // metadata. This shared list update is independent of source navigation.
    refreshGeneration.current++
    latest.current.database.acknowledgeDatabase(saved)
    if (options?.activate) createdSource.current = saved.id
  }, [])

  const error = catalogError ?? database.databaseError
  const ready = catalogReady && database.databaseReady
  const recovery = error ? <RecoveryState compact={ready} title={ui.language === 'zh-CN' ? '数据库加载失败' : 'Unable to load database'}
    description={ready ? (ui.language === 'zh-CN' ? '仍显示上次成功读取的数据，请重试刷新。' : 'Showing the last loaded data. Retry the refresh.') : undefined}
    error={error} busy={catalogLoading || database.databaseLoading} onRetry={() => { onRetryCatalog(); database.reloadDatabaseDomain() }} /> : null
  if (error && !ready) return recovery
  if (!ready) {
    return <div className="dbw-loading">{ui.common.loading}</div>
  }
  if (!database.databases.length) return <>{recovery}<p className="dbw-loading" role="status">{ui.language === 'zh-CN' ? '暂无可用的数据库。' : 'No databases are available.'}
    <button type="button" className="secondary-button" onClick={database.reloadDatabaseDomain}>{ui.language === 'zh-CN' ? '刷新' : 'Refresh'}</button></p></>

  return (
    <>{recovery}
    <DatabaseWorkspace
      activeViewId={database.activeDatabaseSavedViewId}
      catalogColumns={catalogColumns}
      catalogDocuments={catalogDocuments}
      currentDatabaseId={database.databaseEntityDatabaseId}
      databases={database.databases}
      entities={database.databaseEntities}
      locale={ui.locale}
      onActiveViewIdChange={database.setActiveDatabaseSavedViewId}
      onCurrentDatabaseIdChange={changeCurrentDatabase}
      onMessage={onMessage}
      onOpenDocument={onOpenDocument}
      onRefresh={refreshWorkspace}
      onSavedDatabase={acknowledgeSavedDatabase}
      onSavedView={acknowledgeSavedView}
      onSelectedRecordIdsChange={database.setSelectedDatabaseEntityIds}
      savedViews={database.databaseSavedViews}
      viewDraftCache={viewDraftCache.current}
      selectedColumns={database.selectedDatabaseColumns}
      selectedRecordIds={database.selectedDatabaseEntityIds}
    />
    </>
  )
}
