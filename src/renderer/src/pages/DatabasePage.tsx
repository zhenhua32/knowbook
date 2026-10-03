import type { AppMessageHandler } from '../notify'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import '../features/database/database-workspace.css'
import type { Dispatch, SetStateAction } from 'react'
import type { DatabaseSavedView, DatabaseViewConfigV1, DocumentCatalogEntry, DocumentDatabase, DocumentDatabaseColumn, HomeData } from '@shared/contracts'
import type { UiText } from '../i18n'
import type { DatabaseDomainState, DatabaseWorkspaceBoardState } from '../types/appDomains'
import { collectDocumentCatalogPages } from '../utils/documentCatalogPagination'
import { DatabaseWorkspace } from '../features/database/DatabaseWorkspace'
import { RecoveryState } from '../components/RecoveryState'
import { withoutDatabaseField, type DatabaseDeletion } from '../features/database/model/databaseDeletion'
import { getErrorMessage } from '../utils/errorMessage'
import { DatabaseTextDraftCache } from '../features/database/model/databaseTextDrafts'

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
  const localTextDraftCache = useRef<DatabaseTextDraftCache | null>(null)
  const textDraftCache = database.databaseTextDraftCache ?? localTextDraftCache
  if (!textDraftCache.current) textDraftCache.current = new DatabaseTextDraftCache()
  const deletionRevision = useRef(0)
  const [deletionRecovery, setDeletionRecovery] = useState<{ sourceId: string; sourceGeneration: number; revision: number; error: string; busy: boolean } | null>(null)
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
    preferredViewId?: string,
    shouldContinue?: () => boolean
  ) => {
    if (!mounted.current || shouldContinue?.() === false) return false
    const targetId = targetDatabaseId ?? sourceSession.current.currentId
    const requestId = ++refreshGeneration.current
    const sessionId = sourceSession.current.generation
    const isCurrentRequest = () => mounted.current && requestId === refreshGeneration.current
      && sessionId === sourceSession.current.generation && shouldContinue?.() !== false
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
      return false
    }
    if (!isCurrentRequest()) return false
    const [home, documents, databases, columns, entities, views] = result
    const refreshedTarget = databases.find((candidate) => candidate.id === targetId) ?? targetDatabase
    const current = latest.current
    // Creating or deleting a database refreshes the shared catalog before the
    // workspace switches sources. Target data must wait for its own source.
    // This read has already passed its request guard. A subsequent intentional
    // source switch must retain its global metadata; cell edits can still veto it.
    const canPublishGlobal = () => shouldContinue?.() !== false
    current.onHomeDataChange(previous => canPublishGlobal() ? home : previous)
    current.onCatalogDocumentsChange(previous => canPublishGlobal() ? documents : previous)
    current.database.setDatabases(previous => canPublishGlobal() ? databases : previous)
    if (refreshedTarget?.kind === 'document-catalog') {
      current.onCatalogColumnsChange(previous => canPublishGlobal() ? columns : previous)
    }
    if (!isCurrentSource()) return false
    current.database.setSelectedDatabaseColumns(previous => isCurrentSource() ? columns : previous)
    current.database.setDatabaseEntities(previous => isCurrentSource() ? entities : previous)
    current.database.setDatabaseSavedViews(previous => isCurrentSource() ? views : previous)
    current.database.setActiveDatabaseSavedViewId((current) => {
      if (!isCurrentSource()) return current
      const candidateId = preferredViewId ?? current
      return views.some((view) => view.id === candidateId) ? candidateId : views[0]?.id ?? ''
    })
    current.database.acknowledgeWorkspaceRead(targetId)
    return true
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

  const refreshDeletedSource = useCallback(async (sourceId: string, revision: number, sourceGeneration: number) => {
    const ownsRecovery = () => mounted.current && deletionRevision.current === revision
      && sourceSession.current.currentId === sourceId && sourceSession.current.generation === sourceGeneration
    if (!ownsRecovery()) return
    setDeletionRecovery(previous => previous?.revision === revision ? { ...previous, busy: true } : previous)
    try {
      await refreshWorkspace(sourceId)
      if (ownsRecovery()) setDeletionRecovery(null)
    } catch (error) {
      if (ownsRecovery()) setDeletionRecovery({ sourceId, sourceGeneration, revision,
        error: getErrorMessage(error, ui.language === 'zh-CN' ? '数据库刷新失败，请重试。' : 'The database could not be refreshed.'), busy: false })
    }
  }, [refreshWorkspace, ui.language])

  const acknowledgeDeleted = useCallback(async (deleted: DatabaseDeletion) => {
    if (!mounted.current) return
    refreshGeneration.current++
    const current = latest.current
    const affectsCurrentSource = sourceSession.current.currentId === deleted.databaseId
    current.database.acknowledgeDeletion(deleted, affectsCurrentSource)
    const deletedSource = current.database.databases.find(source => source.id === deleted.databaseId)
    if (deleted.kind === 'field' && deletedSource?.kind === 'document-catalog') {
      current.onCatalogColumnsChange(previous => previous.filter(field => field.id !== deleted.id))
      current.onCatalogDocumentsChange(previous => previous.map(document => ({ ...document,
        fieldValues: withoutDatabaseField(document.fieldValues, deleted.id) })))
    }
    if (!affectsCurrentSource) return
    const revision = ++deletionRevision.current
    setDeletionRecovery(null)
    let targetId = deleted.databaseId
    if (deleted.kind === 'database') {
      const remaining = current.database.databases.filter(source => source.id !== deleted.id)
      targetId = remaining.find(source => source.kind === 'document-catalog')?.id ?? remaining[0]?.id ?? ''
      changeCurrentDatabase(targetId)
    }
    await refreshDeletedSource(targetId, revision, sourceSession.current.generation)
  }, [changeCurrentDatabase, refreshDeletedSource])

  const error = catalogError ?? database.databaseError
  const ready = catalogReady && database.databaseReady
  const deletionWarning = deletionRecovery && deletionRecovery.sourceId === sourceSession.current.currentId
    && deletionRecovery.sourceGeneration === sourceSession.current.generation ? <RecoveryState compact
      title={ui.language === 'zh-CN' ? '删除已完成，刷新失败' : 'Deleted, but refresh failed'}
      description={ui.language === 'zh-CN' ? '数据已删除。重试只会刷新列表，不会再次删除。' : 'The data was deleted. Retry only refreshes the list; it will not delete again.'}
      error={deletionRecovery.error} busy={deletionRecovery.busy}
      onRetry={() => refreshDeletedSource(deletionRecovery.sourceId, deletionRecovery.revision, deletionRecovery.sourceGeneration)} /> : null
  const recovery = error ? <RecoveryState compact={ready} title={ui.language === 'zh-CN' ? '数据库加载失败' : 'Unable to load database'}
    description={ready ? (ui.language === 'zh-CN' ? '仍显示上次成功读取的数据，请重试刷新。' : 'Showing the last loaded data. Retry the refresh.') : undefined}
    error={error} busy={catalogLoading || database.databaseLoading} onRetry={() => { onRetryCatalog(); database.reloadDatabaseDomain() }} /> : null
  if (error && !ready) return <>{deletionWarning}{recovery}</>
  if (!ready) {
    return <>{deletionWarning}<div className="dbw-loading">{ui.common.loading}</div></>
  }
  if (!database.databases.length) return <>{deletionWarning}{recovery}<p className="dbw-loading" role="status">{ui.language === 'zh-CN' ? '暂无可用的数据库。' : 'No databases are available.'}
    <button type="button" className="secondary-button" onClick={database.reloadDatabaseDomain}>{ui.language === 'zh-CN' ? '刷新' : 'Refresh'}</button></p></>

  return (
    <>{deletionWarning}{recovery}
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
      onDeleted={acknowledgeDeleted}
      onSavedDatabase={acknowledgeSavedDatabase}
      onSavedView={acknowledgeSavedView}
      onSelectedRecordIdsChange={database.setSelectedDatabaseEntityIds}
      savedViews={database.databaseSavedViews}
      viewDraftCache={viewDraftCache.current}
      textDraftCache={textDraftCache.current}
      selectedColumns={database.selectedDatabaseColumns}
      selectedRecordIds={database.selectedDatabaseEntityIds}
    />
    </>
  )
}
