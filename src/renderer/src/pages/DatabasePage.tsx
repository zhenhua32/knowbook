import { useCallback } from 'react'
import '../features/database/database-workspace.css'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentCatalogEntry, DocumentDatabaseColumn, HomeData } from '@shared/contracts'
import type { UiText } from '../i18n'
import type { DatabaseDomainState, DatabaseWorkspaceBoardState } from '../types/appDomains'
import { collectDocumentCatalogPages } from '../utils/documentCatalogPagination'
import { DatabaseWorkspace } from '../features/database/DatabaseWorkspace'

type DatabasePageProps = {
  catalogColumns: DocumentDatabaseColumn[]
  catalogDocuments: DocumentCatalogEntry[]
  catalogLoading: boolean
  database: DatabaseDomainState
  documentCatalog: DocumentCatalogEntry[]
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
  catalogLoading,
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

  if (catalogLoading && catalogDocuments.length === 0) {
    return <div className="dbw-loading">{ui.common.loading}</div>
  }

  return (
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
  )
}
