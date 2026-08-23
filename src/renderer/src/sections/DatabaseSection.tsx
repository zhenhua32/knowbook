import { useEffect, useState } from 'react'
import type { BoardColumn, BoardDropTarget } from '@shared/board'
import type {
  DatabaseEntity,
  DatabaseSavedView,
  DatabaseSavedViewLayoutMode,
  DatabaseSavedViewSortMode,
  DocumentCatalogEntry,
  DocumentDatabase,
  DocumentDatabaseColumn,
  DocumentDatabaseColumnType,
  DocumentDatabaseFieldValue
} from '@shared/contracts'
import type { UiText } from '../i18n'
import {
  DatabaseFieldEditor,
  DatabaseSchemaColumnCard,
  DocumentBoard,
  DocumentCatalogTable,
  StandaloneDatabaseEntityTable
} from '../components/database/DatabaseSectionComponents'

type DatabaseWorkspaceView = 'catalog' | 'standalone'
type DatabaseEntityFilterScope = '' | '__document__' | string

type CatalogDatabasePanelProps = {
  isCreatingColumn: boolean
  columnNameDraft: string
  onColumnNameChange: (value: string) => void
  columnTypeDraft: DocumentDatabaseColumnType
  onColumnTypeChange: (value: DocumentDatabaseColumnType) => void
  columnOptionsDraft: string
  onColumnOptionsChange: (value: string) => void
  canSaveColumn: boolean
  onToggleCreateColumn: () => void
  onSaveColumn: () => void
  onCancelCreateColumn: () => void
  query: string
  onQueryChange: (value: string) => void
  columns: DocumentDatabaseColumn[]
  filteredDocuments: DocumentCatalogEntry[]
  selectedDocumentId: string | null
  onOpenDocument: (documentId: string) => void
  onUpdateField: (documentId: string, columnId: string, value: DocumentDatabaseFieldValue) => Promise<void>
  onDeleteColumn: (columnId: string, columnName: string) => Promise<void>
  onMoveColumn: (columnId: string, direction: 'left' | 'right') => Promise<void>
  onUpdateColumnOptions: (columnId: string, optionsInput: string) => Promise<void>
  onRenameColumn: (columnId: string, name: string) => Promise<void>
}

type StandaloneDatabasePanelProps = {
  isCreatingColumn: boolean
  columnNameDraft: string
  onColumnNameChange: (value: string) => void
  columnTypeDraft: DocumentDatabaseColumnType
  onColumnTypeChange: (value: DocumentDatabaseColumnType) => void
  columnOptionsDraft: string
  onColumnOptionsChange: (value: string) => void
  canSaveColumn: boolean
  onToggleCreateColumn: () => void
  onSaveColumn: () => void
  onCancelCreateColumn: () => void
  isCreatingDatabase: boolean
  onToggleCreateDatabase: () => void
  databaseNameDraft: string
  onDatabaseNameChange: (value: string) => void
  databaseDescriptionDraft: string
  onDatabaseDescriptionChange: (value: string) => void
  onSubmitCreateDatabase: () => void
  onCancelCreateDatabase: () => void
  isCreatingEntity: boolean
  onToggleCreateEntity: () => void
  entityDatabaseId: string
  onEntityDatabaseIdChange: (value: string) => void
  entityDocumentId: string
  onEntityDocumentIdChange: (value: string) => void
  entityFieldValues: Record<string, DocumentDatabaseFieldValue>
  onEntityDraftFieldChange: (columnId: string, value: DocumentDatabaseFieldValue) => void
  onSubmitCreateEntity: () => void
  onCancelCreateEntity: () => void
  databases: DocumentDatabase[]
  selectedDatabase: DocumentDatabase | null
  selectedDatabaseColumns: DocumentDatabaseColumn[]
  databaseEntities: DatabaseEntity[]
  documentCatalog: DocumentCatalogEntry[]
  savedViews: DatabaseSavedView[]
  activeSavedViewId: string
  onSavedViewSelect: (viewId: string) => void
  onBeginSavedViewCreation: () => void
  isCreatingSavedView: boolean
  savedViewNameDraft: string
  onSavedViewNameChange: (value: string) => void
  onSaveSavedView: () => void
  onCancelSavedViewCreation: () => void
  activeSavedView: DatabaseSavedView | null
  savedViewDirty: boolean
  onUpdateSavedView: () => void
  onDeleteSavedView: () => void
  onDeleteDatabase: () => void
  onUpdateDatabaseMetadata: (name: string, description: string) => void
  filterQuery: string
  onFilterQueryChange: (value: string) => void
  filterScope: DatabaseEntityFilterScope
  onFilterScopeChange: (value: DatabaseEntityFilterScope) => void
  sortMode: DatabaseSavedViewSortMode
  onSortModeChange: (value: DatabaseSavedViewSortMode) => void
  viewMode: DatabaseSavedViewLayoutMode
  onViewModeChange: (value: DatabaseSavedViewLayoutMode) => void
  filteredEntityRows: Array<{ entity: DatabaseEntity; linkedDocument: DocumentCatalogEntry | null }>
  selectedEntityIds: string[]
  selectedEntityIdSet: Set<string>
  onSelectVisibleEntities: () => void
  onClearSelectedEntities: () => void
  onDeleteSelectedEntities: () => void
  selectedEntitiesHaveLinkedDocument: boolean
  bulkFieldValues: Record<string, DocumentDatabaseFieldValue>
  onBulkFieldChange: (columnId: string, value: DocumentDatabaseFieldValue) => void
  onClearSelectedEntityDocuments: () => void
  onClearBulkFieldValues: () => void
  onApplyFieldToSelected: (columnId: string) => void
  onClearFieldFromSelected: (columnId: string) => void
  onDeleteEntity: (entityId: string) => Promise<void>
  onToggleEntitySelection: (entityId: string, checked: boolean) => void
  onUpdateEntityDocument: (entity: DatabaseEntity, documentId: string | null) => Promise<void>
  onUpdateEntityField: (entity: DatabaseEntity, columnId: string, value: DocumentDatabaseFieldValue) => Promise<void>
  onDeleteColumn: (columnId: string, columnName: string) => Promise<void>
  onMoveColumn: (columnId: string, direction: 'left' | 'right') => Promise<void>
  onUpdateColumnOptions: (columnId: string, optionsInput: string) => Promise<void>
  onRenameColumn: (columnId: string, name: string) => Promise<void>
}

type DatabaseBoardPanelProps = {
  boardGroupingColumn: DocumentDatabaseColumn | null
  parentGroupValue: string
  groupBy: string
  onGroupByChange: (value: string) => void
  groupableColumns: DocumentDatabaseColumn[]
  boardColumns: BoardColumn[]
  selectedDocumentId: string | null
  draggingDocumentId: string | null
  dragOverColumnId: string | null
  onOpenDocument: (documentId: string) => void
  onDragStart: (documentId: string) => void
  onDragEnd: () => void
  onDragOverColumn: (columnId: string) => void
  onDropOnColumn: (target: BoardDropTarget) => Promise<void>
}

type DatabaseSectionProps = {
  ui: UiText
  databasePageTitle: string
  databasePageHint: string
  databaseWorkspaceView: DatabaseWorkspaceView
  onSwitchDatabaseWorkspaceView: (view: DatabaseWorkspaceView) => void
  catalog: CatalogDatabasePanelProps
  standalone: StandaloneDatabasePanelProps
  board: DatabaseBoardPanelProps
}

export function DatabaseSection({
  ui,
  databasePageTitle,
  databasePageHint,
  databaseWorkspaceView,
  onSwitchDatabaseWorkspaceView,
  catalog,
  standalone,
  board
}: DatabaseSectionProps) {
  const selectedEntityCount = standalone.selectedEntityIds.length
  const [editingDatabaseId, setEditingDatabaseId] = useState<string | null>(null)
  const [metadataNameDraft, setMetadataNameDraft] = useState('')
  const [metadataDescriptionDraft, setMetadataDescriptionDraft] = useState('')

  useEffect(() => {
    setEditingDatabaseId(null)
  }, [standalone.selectedDatabase?.id])

  const beginDatabaseMetadataEdit = () => {
    if (!standalone.selectedDatabase) {
      return
    }
    setMetadataNameDraft(standalone.selectedDatabase.name)
    setMetadataDescriptionDraft(standalone.selectedDatabase.description)
    setEditingDatabaseId(standalone.selectedDatabase.id)
  }

  return (
    <section className="database-grid" data-testid="database-grid">
      <article className="panel database-panel">
        <div className="panel-head compact-head">
          <div>
            <p className="panel-label">{ui.databaseViewLabel}</p>
            <h3>{databasePageTitle}</h3>
          </div>
          <div className="toolbar-inline">
            <button
              className={databaseWorkspaceView === 'catalog' ? 'primary-button' : 'secondary-button'}
              onClick={() => onSwitchDatabaseWorkspaceView('catalog')}
              type="button"
            >
              {ui.documentCatalogTitle}
            </button>
            <button
              className={databaseWorkspaceView === 'standalone' ? 'primary-button' : 'secondary-button'}
              onClick={() => onSwitchDatabaseWorkspaceView('standalone')}
              type="button"
            >
              {ui.standaloneDatabasesTitle}
            </button>
          </div>
        </div>

        <p className="mini-hint">{databasePageHint}</p>

        {databaseWorkspaceView === 'catalog' ? (
          <>
            <div className="toolbar-inline">
              <button className="secondary-button" onClick={catalog.onToggleCreateColumn} type="button">
                {catalog.isCreatingColumn ? ui.closeSchema : ui.addColumn}
              </button>
              <input
                className="editor-input table-search"
                onChange={(event) => catalog.onQueryChange(event.target.value)}
                placeholder={ui.searchDocumentsPlaceholder}
                type="text"
                value={catalog.query}
              />
              <span className="pill">{ui.customColumnsCount(catalog.columns.length)}</span>
              <span className="pill">{ui.rowsCount(catalog.filteredDocuments.length)}</span>
            </div>

            {catalog.isCreatingColumn ? (
              <div className="database-schema-form">
                <label className="editor-label">
                  {ui.columnName}
                  <input className="editor-input" onChange={(event) => catalog.onColumnNameChange(event.target.value)} type="text" value={catalog.columnNameDraft} />
                </label>
                <label className="editor-label">
                  {ui.fieldType}
                  <select className="editor-input" onChange={(event) => catalog.onColumnTypeChange(event.target.value as DocumentDatabaseColumnType)} value={catalog.columnTypeDraft}>
                    {Object.entries(ui.databaseColumnTypes).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                {catalog.columnTypeDraft === 'select' || catalog.columnTypeDraft === 'multi-select' ? (
                  <label className="editor-label database-schema-options">
                    {ui.options}
                    <input
                      className="editor-input"
                      onChange={(event) => catalog.onColumnOptionsChange(event.target.value)}
                      placeholder={ui.optionsCommaHint}
                      type="text"
                      value={catalog.columnOptionsDraft}
                    />
                  </label>
                ) : null}
                <div className="database-schema-actions">
                  <button className="secondary-button" disabled={!catalog.canSaveColumn} onClick={catalog.onSaveColumn} type="button">
                    {ui.saveColumn}
                  </button>
                  <button className="secondary-button" onClick={catalog.onCancelCreateColumn} type="button">
                    {ui.common.cancel}
                  </button>
                </div>
              </div>
            ) : null}

            {catalog.columns.length > 0 ? (
              <div className="database-schema-chip-row">
                {catalog.columns.map((column, index) => (
                  <DatabaseSchemaColumnCard
                    column={column}
                    isFirst={index === 0}
                    isLast={index === catalog.columns.length - 1}
                    key={column.id}
                    onDelete={catalog.onDeleteColumn}
                    onMove={catalog.onMoveColumn}
                    onUpdateOptions={catalog.onUpdateColumnOptions}
                    onRename={catalog.onRenameColumn}
                  />
                ))}
              </div>
            ) : (
              <p className="mini-hint">{ui.noCustomColumnsYet}</p>
            )}

            <DocumentCatalogTable
              columns={catalog.columns}
              documents={catalog.filteredDocuments}
              onSelect={catalog.onOpenDocument}
              onUpdateField={catalog.onUpdateField}
              selectedDocumentId={catalog.selectedDocumentId}
            />
          </>
        ) : (
          <>
            <div className="toolbar-inline">
              <button
                className="secondary-button"
                disabled={!standalone.selectedDatabase && !standalone.isCreatingColumn}
                onClick={standalone.onToggleCreateColumn}
                type="button"
              >
                {standalone.isCreatingColumn ? ui.closeSchema : ui.addColumn}
              </button>
              <button className="secondary-button" onClick={standalone.onToggleCreateDatabase} type="button">
                {standalone.isCreatingDatabase ? ui.common.cancel : ui.addDatabase}
              </button>
              <button
                className="secondary-button"
                disabled={!standalone.selectedDatabase && !standalone.isCreatingEntity}
                onClick={standalone.onToggleCreateEntity}
                type="button"
              >
                {standalone.isCreatingEntity ? ui.common.cancel : ui.addEntity}
              </button>
              <span className="pill">{ui.customColumnsCount(standalone.selectedDatabaseColumns.length)}</span>
              <span className="pill">{ui.rowsCount(standalone.databaseEntities.length)}</span>
            </div>

            {standalone.isCreatingDatabase ? (
              <div className="database-schema-form">
                <label className="editor-label">
                  {ui.databaseName}
                  <input className="editor-input" onChange={(event) => standalone.onDatabaseNameChange(event.target.value)} type="text" value={standalone.databaseNameDraft} />
                </label>
                <label className="editor-label">
                  {ui.databaseDescription}
                  <input className="editor-input" onChange={(event) => standalone.onDatabaseDescriptionChange(event.target.value)} type="text" value={standalone.databaseDescriptionDraft} />
                </label>
                <div className="database-schema-actions">
                  <button className="secondary-button" disabled={standalone.databaseNameDraft.trim().length === 0} onClick={standalone.onSubmitCreateDatabase} type="button">
                    {ui.createDatabase}
                  </button>
                  <button className="secondary-button" onClick={standalone.onCancelCreateDatabase} type="button">
                    {ui.common.cancel}
                  </button>
                </div>
              </div>
            ) : null}

            {standalone.isCreatingColumn ? (
              <div className="database-schema-form">
                <label className="editor-label">
                  {ui.columnName}
                  <input className="editor-input" onChange={(event) => standalone.onColumnNameChange(event.target.value)} type="text" value={standalone.columnNameDraft} />
                </label>
                <label className="editor-label">
                  {ui.fieldType}
                  <select className="editor-input" onChange={(event) => standalone.onColumnTypeChange(event.target.value as DocumentDatabaseColumnType)} value={standalone.columnTypeDraft}>
                    {Object.entries(ui.databaseColumnTypes).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                {standalone.columnTypeDraft === 'select' || standalone.columnTypeDraft === 'multi-select' ? (
                  <label className="editor-label database-schema-options">
                    {ui.options}
                    <input
                      className="editor-input"
                      onChange={(event) => standalone.onColumnOptionsChange(event.target.value)}
                      placeholder={ui.optionsCommaHint}
                      type="text"
                      value={standalone.columnOptionsDraft}
                    />
                  </label>
                ) : null}
                <div className="database-schema-actions">
                  <button className="secondary-button" disabled={!standalone.canSaveColumn} onClick={standalone.onSaveColumn} type="button">
                    {ui.saveColumn}
                  </button>
                  <button className="secondary-button" onClick={standalone.onCancelCreateColumn} type="button">
                    {ui.common.cancel}
                  </button>
                </div>
              </div>
            ) : null}

            {standalone.isCreatingEntity ? (
              <div className="database-schema-form">
                <label className="editor-label">
                  Database
                  <select className="editor-input" onChange={(event) => standalone.onEntityDatabaseIdChange(event.target.value)} value={standalone.entityDatabaseId}>
                    <option value="">{ui.selectDatabasePlaceholder}</option>
                    {standalone.databases.map((database) => (
                      <option key={database.id} value={database.id}>{database.name}</option>
                    ))}
                  </select>
                </label>
                <label className="editor-label">
                  {ui.linkToDocumentOptional}
                  <select
                    className="editor-input database-entity-document-select"
                    onChange={(event) => standalone.onEntityDocumentIdChange(event.target.value)}
                    value={standalone.entityDocumentId}
                  >
                    <option value="">{ui.noLinkedDocument}</option>
                    {standalone.documentCatalog.map((document) => (
                      <option key={document.id} value={document.id}>{document.path}</option>
                    ))}
                  </select>
                </label>
                {standalone.selectedDatabaseColumns.length > 0 ? (
                  <div className="database-entity-field-grid database-entity-field-grid-form">
                    {standalone.selectedDatabaseColumns.map((column) => (
                      <label className="editor-label database-entity-field" key={`draft-${column.id}`}>
                        {column.name}
                        <DatabaseFieldEditor
                          column={column}
                          textCommitMode="change"
                          value={standalone.entityFieldValues[column.id] ?? null}
                          onChangeValue={(value) => {
                            standalone.onEntityDraftFieldChange(column.id, value)
                          }}
                        />
                      </label>
                    ))}
                  </div>
                ) : null}
                <div className="database-schema-actions">
                  <button className="secondary-button" disabled={!standalone.entityDatabaseId} onClick={standalone.onSubmitCreateEntity} type="button">
                    {ui.createEntity}
                  </button>
                  <button className="secondary-button" onClick={standalone.onCancelCreateEntity} type="button">
                    {ui.common.cancel}
                  </button>
                </div>
              </div>
            ) : null}

            {standalone.databases.length > 0 ? (
              <>
                <div className="toolbar-inline toolbar-inline-wrap toolbar-inline-spaced">
                  {standalone.databases.map((database) => (
                    <button
                      className={database.id === standalone.entityDatabaseId ? 'primary-button' : 'secondary-button'}
                      key={database.id}
                      onClick={() => standalone.onEntityDatabaseIdChange(database.id)}
                      type="button"
                    >
                      {database.name}
                    </button>
                  ))}
                </div>

                {standalone.selectedDatabase ? (
                  <>
                    <div className="toolbar-inline toolbar-inline-wrap toolbar-inline-spaced toolbar-inline-start">
                      <span className="pill">{ui.databaseSavedViewsLabel}</span>
                      <select
                        className="editor-input database-saved-view-select"
                        onChange={(event) => standalone.onSavedViewSelect(event.target.value)}
                        value={standalone.activeSavedViewId}
                      >
                        <option value="">{ui.databaseSavedViewDraftOption}</option>
                        {standalone.savedViews.map((view) => (
                          <option key={view.id} value={view.id}>{view.name}</option>
                        ))}
                      </select>
                      <button className="secondary-button database-saved-view-create-button" onClick={standalone.onBeginSavedViewCreation} type="button">
                        {ui.saveCurrentDatabaseView}
                      </button>
                      {standalone.isCreatingSavedView ? (
                        <>
                          <input
                            aria-label={ui.databaseSavedViewNamePrompt}
                            className="editor-input database-saved-view-name-input"
                            onChange={(event) => standalone.onSavedViewNameChange(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                standalone.onSaveSavedView()
                              }

                              if (event.key === 'Escape') {
                                event.preventDefault()
                                standalone.onCancelSavedViewCreation()
                              }
                            }}
                            placeholder={ui.databaseSavedViewNamePrompt}
                            type="text"
                            value={standalone.savedViewNameDraft}
                          />
                          <button
                            className="secondary-button database-saved-view-confirm-button"
                            disabled={!standalone.savedViewNameDraft.trim()}
                            onClick={standalone.onSaveSavedView}
                            type="button"
                          >
                            {ui.saveCurrentDatabaseView}
                          </button>
                          <button className="secondary-button database-saved-view-cancel-button" onClick={standalone.onCancelSavedViewCreation} type="button">
                            {ui.common.cancel}
                          </button>
                        </>
                      ) : null}
                      <button
                        className="secondary-button database-saved-view-update-button"
                        disabled={!standalone.activeSavedView || !standalone.savedViewDirty}
                        onClick={standalone.onUpdateSavedView}
                        type="button"
                      >
                        {ui.updateCurrentDatabaseView}
                      </button>
                      <button
                        className="secondary-button database-saved-view-delete-button"
                        disabled={!standalone.activeSavedView}
                        onClick={standalone.onDeleteSavedView}
                        type="button"
                      >
                        {ui.deleteCurrentDatabaseView}
                      </button>
                      <button className="secondary-button" onClick={beginDatabaseMetadataEdit} type="button">
                        {ui.editCurrentDatabase}
                      </button>
                      <button className="secondary-button database-delete-button" onClick={standalone.onDeleteDatabase} type="button">
                        {ui.deleteCurrentDatabase}
                      </button>
                    </div>

                    {editingDatabaseId === standalone.selectedDatabase.id ? (
                      <div className="database-schema-form database-metadata-form">
                        <label className="editor-label">
                          {ui.databaseName}
                          <input
                            className="editor-input"
                            onChange={(event) => setMetadataNameDraft(event.target.value)}
                            type="text"
                            value={metadataNameDraft}
                          />
                        </label>
                        <label className="editor-label">
                          {ui.databaseDescription}
                          <input
                            className="editor-input"
                            onChange={(event) => setMetadataDescriptionDraft(event.target.value)}
                            type="text"
                            value={metadataDescriptionDraft}
                          />
                        </label>
                        <div className="database-schema-actions">
                          <button
                            className="secondary-button"
                            disabled={!metadataNameDraft.trim()}
                            onClick={() => {
                              standalone.onUpdateDatabaseMetadata(metadataNameDraft, metadataDescriptionDraft)
                              setEditingDatabaseId(null)
                            }}
                            type="button"
                          >
                            {ui.common.save}
                          </button>
                          <button className="secondary-button" onClick={() => setEditingDatabaseId(null)} type="button">
                            {ui.common.cancel}
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {standalone.databaseEntities.length > 0 ? (
                      <>
                        <div className="toolbar-inline toolbar-inline-wrap toolbar-inline-spaced toolbar-inline-start">
                          <input
                            className="editor-input database-entity-filter-query"
                            onChange={(event) => standalone.onFilterQueryChange(event.target.value)}
                            placeholder={ui.searchDatabaseEntitiesPlaceholder}
                            type="search"
                            value={standalone.filterQuery}
                          />
                          <select
                            className="editor-input database-entity-filter-scope-select"
                            onChange={(event) => standalone.onFilterScopeChange(event.target.value as DatabaseEntityFilterScope)}
                            value={standalone.filterScope}
                          >
                            <option value="">{ui.databaseEntityFilterAllFields}</option>
                            <option value="__document__">{ui.databaseEntityFilterLinkedDocument}</option>
                            {standalone.selectedDatabaseColumns.map((column) => (
                              <option key={column.id} value={column.id}>{ui.databaseEntityFilterField(column.name)}</option>
                            ))}
                          </select>
                          <select
                            className="editor-input database-entity-sort-select"
                            onChange={(event) => standalone.onSortModeChange(event.target.value as DatabaseSavedViewSortMode)}
                            value={standalone.sortMode}
                          >
                            <option value="updated-desc">{ui.databaseEntitySortUpdatedDesc}</option>
                            <option value="updated-asc">{ui.databaseEntitySortUpdatedAsc}</option>
                            <option value="created-desc">{ui.databaseEntitySortCreatedDesc}</option>
                            <option value="created-asc">{ui.databaseEntitySortCreatedAsc}</option>
                          </select>
                          <span className="pill">{ui.databaseEntityViewModeLabel}</span>
                          <button
                            className={standalone.viewMode === 'cards' ? 'primary-button database-entity-cards-view-button' : 'secondary-button database-entity-cards-view-button'}
                            onClick={() => standalone.onViewModeChange('cards')}
                            type="button"
                          >
                            {ui.databaseEntityCardsView}
                          </button>
                          <button
                            className={standalone.viewMode === 'table' ? 'primary-button database-entity-table-view-button' : 'secondary-button database-entity-table-view-button'}
                            onClick={() => standalone.onViewModeChange('table')}
                            type="button"
                          >
                            {ui.databaseEntityTableView}
                          </button>
                          <span className="pill">{ui.filteredRowsCount(standalone.filteredEntityRows.length, standalone.databaseEntities.length)}</span>
                        </div>

                        <div className="toolbar-inline toolbar-inline-wrap toolbar-inline-spaced toolbar-inline-start">
                          <button
                            className="secondary-button database-entity-select-visible-button"
                            disabled={standalone.filteredEntityRows.length === 0}
                            onClick={standalone.onSelectVisibleEntities}
                            type="button"
                          >
                            {ui.selectVisibleDatabaseEntities}
                          </button>
                          <button className="secondary-button" disabled={selectedEntityCount === 0} onClick={standalone.onClearSelectedEntities} type="button">
                            {ui.common.clear}
                          </button>
                          <button
                            className="secondary-button database-entity-delete-selected-button"
                            disabled={selectedEntityCount === 0}
                            onClick={standalone.onDeleteSelectedEntities}
                            type="button"
                          >
                            {ui.deleteSelectedDatabaseEntities(selectedEntityCount)}
                          </button>
                          <span className="pill">{ui.selectedDatabaseEntitiesCount(selectedEntityCount)}</span>
                        </div>

                        {selectedEntityCount > 0 ? (
                          <section className="database-entity-bulk-panel">
                            <div className="database-entity-bulk-panel-head">
                              <div>
                                <p className="panel-label">{ui.databaseEntityBulkEditLabel}</p>
                                <h4>{ui.databaseEntityBulkEditTitle(selectedEntityCount)}</h4>
                              </div>
                              <div className="toolbar-inline toolbar-inline-start">
                                <button
                                  className="secondary-button database-entity-bulk-document-clear-button"
                                  disabled={!standalone.selectedEntitiesHaveLinkedDocument}
                                  onClick={standalone.onClearSelectedEntityDocuments}
                                  type="button"
                                >
                                  {ui.clearSelectedDatabaseEntityDocuments(selectedEntityCount)}
                                </button>
                                <button className="secondary-button" onClick={standalone.onClearBulkFieldValues} type="button">
                                  {ui.common.clear}
                                </button>
                              </div>
                            </div>
                            <p className="mini-hint">{ui.databaseEntityBulkEditHint}</p>
                            {standalone.selectedDatabaseColumns.length > 0 ? (
                              <div className="database-entity-field-grid">
                                {standalone.selectedDatabaseColumns.map((column) => (
                                  <div
                                    className="database-entity-bulk-field"
                                    data-column-id={column.id}
                                    data-column-name={column.name}
                                    key={`bulk-${column.id}`}
                                  >
                                    <label className="editor-label database-entity-field">
                                      {column.name}
                                      <DatabaseFieldEditor
                                        column={column}
                                        textCommitMode="change"
                                        value={standalone.bulkFieldValues[column.id] ?? null}
                                        onChangeValue={(value) => {
                                          standalone.onBulkFieldChange(column.id, value)
                                        }}
                                      />
                                    </label>
                                    <div className="database-entity-bulk-field-actions">
                                      <button
                                        className="secondary-button database-entity-bulk-field-apply-button"
                                        onClick={() => standalone.onApplyFieldToSelected(column.id)}
                                        type="button"
                                      >
                                        {ui.applySelectedDatabaseEntityField(column.name, selectedEntityCount)}
                                      </button>
                                      <button
                                        className="secondary-button database-entity-bulk-field-clear-button"
                                        onClick={() => standalone.onClearFieldFromSelected(column.id)}
                                        type="button"
                                      >
                                        {ui.clearSelectedDatabaseEntityField(column.name, selectedEntityCount)}
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </section>
                        ) : null}

                        <p className="mini-hint">{standalone.viewMode === 'table' ? ui.databaseEntityTableHint : ui.databaseEntityCardsHint}</p>

                        {standalone.filteredEntityRows.length > 0 ? (
                          standalone.viewMode === 'table' ? (
                            <StandaloneDatabaseEntityTable
                              columns={standalone.selectedDatabaseColumns}
                              documentCatalog={standalone.documentCatalog}
                              entities={standalone.filteredEntityRows}
                              onDeleteEntity={standalone.onDeleteEntity}
                              onToggleSelection={standalone.onToggleEntitySelection}
                              onUpdateDocument={standalone.onUpdateEntityDocument}
                              onUpdateField={standalone.onUpdateEntityField}
                              selectedEntityIds={standalone.selectedEntityIdSet}
                            />
                          ) : (
                            <div className="document-list database-document-list-spaced">
                              {standalone.filteredEntityRows.map(({ entity, linkedDocument }) => {
                                const entityLabel = linkedDocument?.title ?? ui.entityFallbackLabel(entity.id)

                                return (
                                  <div className="document-row" key={entity.id}>
                                    <div className={`database-entity-card${standalone.selectedEntityIdSet.has(entity.id) ? ' database-entity-card-selected' : ''}`}>
                                      <div className="database-entity-head">
                                        <div className="database-entity-head-main">
                                          <label className="database-entity-select-toggle">
                                            <input
                                              aria-label={ui.selectDatabaseEntity(entityLabel)}
                                              checked={standalone.selectedEntityIdSet.has(entity.id)}
                                              className="database-entity-select-checkbox"
                                              onChange={(event) => standalone.onToggleEntitySelection(entity.id, event.target.checked)}
                                              type="checkbox"
                                            />
                                          </label>
                                          <div>
                                            <strong>{entityLabel}</strong>
                                            <p>{linkedDocument?.path ?? ui.noLinkedDocument}</p>
                                          </div>
                                        </div>
                                        <div className="document-meta">
                                          <span>{new Date(entity.updatedAt).toLocaleDateString(ui.locale)}</span>
                                          <button className="secondary-button" onClick={() => void standalone.onDeleteEntity(entity.id)} type="button">
                                            {ui.common.delete}
                                          </button>
                                        </div>
                                      </div>
                                      <label className="editor-label database-editor-label-spaced">
                                        {ui.linkToDocumentOptional}
                                        <select
                                          className="editor-input database-entity-document-select"
                                          onChange={(event) => {
                                            void standalone.onUpdateEntityDocument(entity, event.target.value || null)
                                          }}
                                          value={entity.documentId ?? ''}
                                        >
                                          <option value="">{ui.noLinkedDocument}</option>
                                          {standalone.documentCatalog.map((document) => (
                                            <option key={document.id} value={document.id}>{document.path}</option>
                                          ))}
                                        </select>
                                      </label>
                                      {standalone.selectedDatabaseColumns.length > 0 ? (
                                        <div className="database-entity-field-grid">
                                          {standalone.selectedDatabaseColumns.map((column) => (
                                            <label className="editor-label database-entity-field" key={`${entity.id}-${column.id}`}>
                                              {column.name}
                                              <DatabaseFieldEditor
                                                column={column}
                                                value={entity.fieldValues[column.id] ?? null}
                                                onChangeValue={(value) => {
                                                  void standalone.onUpdateEntityField(entity, column.id, value)
                                                }}
                                              />
                                            </label>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          )
                        ) : (
                          <p className="mini-hint">{ui.noFilteredDatabaseEntitiesYet(standalone.selectedDatabase.name)}</p>
                        )}
                      </>
                    ) : (
                      <p className="mini-hint">{ui.noDatabaseEntitiesYet(standalone.selectedDatabase.name)}</p>
                    )}
                  </>
                ) : null}
              </>
            ) : (
              <p className="mini-hint">{ui.noIndependentDatabasesYet}</p>
            )}

            {standalone.selectedDatabaseColumns.length > 0 ? (
              <div className="database-schema-chip-row">
                {standalone.selectedDatabaseColumns.map((column, index) => (
                  <DatabaseSchemaColumnCard
                    column={column}
                    isFirst={index === 0}
                    isLast={index === standalone.selectedDatabaseColumns.length - 1}
                    key={column.id}
                    onDelete={standalone.onDeleteColumn}
                    onMove={standalone.onMoveColumn}
                    onUpdateOptions={standalone.onUpdateColumnOptions}
                    onRename={standalone.onRenameColumn}
                  />
                ))}
              </div>
            ) : (
              <p className="mini-hint">{standalone.selectedDatabase ? ui.noStandaloneDatabaseColumnsYet(standalone.selectedDatabase.name) : ui.noIndependentDatabasesYet}</p>
            )}
          </>
        )}
      </article>

      {databaseWorkspaceView === 'catalog' ? (
        <article className="panel board-panel">
          <div className="panel-head compact-head">
            <div>
              <p className="panel-label">{ui.boardViewLabel}</p>
              <h3>{ui.boardGroupedBy(board.boardGroupingColumn?.name ?? null)}</h3>
            </div>
            <div className="toolbar-inline">
              <select className="editor-input" onChange={(event) => board.onGroupByChange(event.target.value)} value={board.groupBy}>
                <option value={board.parentGroupValue}>{ui.parentBucket}</option>
                {board.groupableColumns.map((column) => (
                  <option key={column.id} value={column.id}>{column.name} ({ui.databaseColumnTypes[column.type]})</option>
                ))}
              </select>
              <span className="pill">{ui.boardColumnsCount(board.boardColumns.length)}</span>
            </div>
          </div>

          <p className="mini-hint">
            {board.boardGroupingColumn
              ? ui.boardHintForColumn(board.boardGroupingColumn.name, board.boardGroupingColumn.type === 'multi-select')
              : ui.boardHintForParent}
          </p>

          <DocumentBoard
            columns={board.boardColumns}
            dragOverColumnId={board.dragOverColumnId}
            draggingDocumentId={board.draggingDocumentId}
            onDragEnd={board.onDragEnd}
            onDragOverColumn={board.onDragOverColumn}
            onDragStart={board.onDragStart}
            onDropOnColumn={board.onDropOnColumn}
            onSelect={board.onOpenDocument}
            selectedDocumentId={board.selectedDocumentId}
          />
        </article>
      ) : null}
    </section>
  )
}
