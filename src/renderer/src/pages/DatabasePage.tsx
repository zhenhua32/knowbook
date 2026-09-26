import type { AppMessageHandler } from '../notify'
import { useCallback } from 'react'
import '../features/database/database-workspace.css'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentCatalogEntry, DocumentDatabaseColumn, HomeData } from '@shared/contracts'
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
  const refreshWorkspace = useCallback(async (
    targetDatabaseId: string = database.databaseEntityDatabaseId,
    preferredViewId?: string
  ) => {
    const targetDatabase = database.databases.find((candidate) => candidate.id === targetDatabaseId)
    const [home, documents, databases, columns, entities, views] = await Promise.all([
      window.knowbook.getHomeData(),
      collectDocumentCatalogPages(window.knowbook.getDocumentCatalogPage),
      window.knowbook.getDatabases(),
      targetDatabaseId ? window.knowbook.getDocumentDatabaseColumns(targetDatabaseId) : Promise.resolve([]),
      targetDatabaseId ? window.knowbook.getDatabaseEntities(targetDatabaseId) : Promise.resolve([]),
      targetDatabaseId ? window.knowbook.getDatabaseSavedViews(targetDatabaseId) : Promise.resolve([])
    ])
    const refreshedTarget = databases.find((candidate) => candidate.id === targetDatabaseId) ?? targetDatabase
    onHomeDataChange(home)
    onCatalogDocumentsChange(documents)
    database.setDatabases(databases)
    database.setSelectedDatabaseColumns(columns)
    database.setDatabaseEntities(entities)
    database.setDatabaseSavedViews(views)
    if (refreshedTarget?.kind === 'document-catalog') {
      onCatalogColumnsChange(columns)
    }
    database.setActiveDatabaseSavedViewId((current) => {
      const candidateId = preferredViewId ?? current
      return views.some((view) => view.id === candidateId) ? candidateId : views[0]?.id ?? ''
    })
  }, [
    database,
    onCatalogColumnsChange,
    onCatalogDocumentsChange,
    onHomeDataChange
  ])

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
      onCurrentDatabaseIdChange={database.setDatabaseEntityDatabaseId}
      onMessage={onMessage}
      onOpenDocument={onOpenDocument}
      onRefresh={refreshWorkspace}
      onSelectedRecordIdsChange={database.setSelectedDatabaseEntityIds}
      savedViews={database.databaseSavedViews}
      selectedColumns={database.selectedDatabaseColumns}
      selectedRecordIds={database.selectedDatabaseEntityIds}
    />
    </>
  )
}
