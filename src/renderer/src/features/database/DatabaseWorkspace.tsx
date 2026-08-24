import { useEffect, useMemo, useState } from 'react'
import type {
  DatabaseEntity,
  DatabaseField,
  DatabaseRecord,
  DatabaseSavedView,
  DatabaseSavedViewLayoutMode,
  DatabaseViewConfigV1,
  DocumentCatalogEntry,
  DocumentDatabase,
  DocumentDatabaseColumn,
  DocumentDatabaseColumnType,
  DocumentDatabaseFieldValue
} from '@shared/contracts'
import { DATABASE_SYSTEM_FIELD_IDS } from '@shared/database-workspace'
import { getBoardDropFieldValue } from '@shared/board'
import {
  adaptCatalogFields,
  adaptCatalogRecords,
  adaptCustomFields,
  adaptCustomRecords,
  adaptDatabaseSources
} from './model/databaseAdapters'
import { applyDatabaseView, groupDatabaseRecords } from './model/databaseFilters'
import { getDatabaseWorkspaceText } from './databaseText'
import { useDatabaseViewDraft } from './hooks/useDatabaseViewDraft'
import { DatabaseHeader } from './components/DatabaseHeader'
import { DatabaseViewTabs } from './components/DatabaseViewTabs'
import { DatabaseViewToolbar } from './components/DatabaseViewToolbar'
import { DatabaseTableView } from './components/DatabaseTableView'
import { DatabaseBoardView } from './components/DatabaseBoardView'
import { DatabaseCardView } from './components/DatabaseCardView'
import { DatabaseFieldDrawer } from './components/DatabaseFieldDrawer'
import { CreateRecordDialog, DatabaseRecordDrawer } from './components/DatabaseRecordDrawer'
import { DatabaseConfirmDialog, DatabaseFormDialog } from './components/DatabaseDialogs'
import { DatabaseValueEditor } from './components/DatabaseValueEditor'

type DatabaseWorkspaceProps = {
  activeViewId: string
  catalogColumns: DocumentDatabaseColumn[]
  catalogDocuments: DocumentCatalogEntry[]
  currentDatabaseId: string
  databases: DocumentDatabase[]
  entities: DatabaseEntity[]
  locale: string
  savedViews: DatabaseSavedView[]
  selectedColumns: DocumentDatabaseColumn[]
  selectedRecordIds: string[]
  onActiveViewIdChange: (viewId: string) => void
  onCurrentDatabaseIdChange: (databaseId: string) => void
  onMessage: (message: string | null) => void
  onOpenDocument: (documentId: string) => void
  onRefresh: (databaseId?: string, preferredViewId?: string) => Promise<void>
  onSelectedRecordIdsChange: (recordIds: string[]) => void
}

type FormMode = 'create-database' | 'edit-database' | 'create-view' | 'rename-view' | null
type ConfirmTarget =
  | { kind: 'database'; id: string; name: string }
  | { kind: 'view'; id: string; name: string }
  | { kind: 'field'; id: string; name: string }
  | { kind: 'record'; id: string; name: string }
  | { kind: 'records'; ids: string[]; name: string }

export function DatabaseWorkspace({
  activeViewId,
  catalogColumns,
  catalogDocuments,
  currentDatabaseId,
  databases,
  entities,
  locale,
  savedViews,
  selectedColumns,
  selectedRecordIds,
  onActiveViewIdChange,
  onCurrentDatabaseIdChange,
  onMessage,
  onOpenDocument,
  onRefresh,
  onSelectedRecordIdsChange
}: DatabaseWorkspaceProps) {
  const text = useMemo(() => getDatabaseWorkspaceText(locale), [locale])
  const sources = useMemo(() => adaptDatabaseSources(databases), [databases])
  const currentSource = sources.find((source) => source.id === currentDatabaseId) ?? sources[0]
  const [fieldDrawerOpen, setFieldDrawerOpen] = useState(false)
  const [createRecordOpen, setCreateRecordOpen] = useState(false)
  const [openRecordId, setOpenRecordId] = useState<string | null>(null)
  const [formMode, setFormMode] = useState<FormMode>(null)
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formViewLayout, setFormViewLayout] = useState<DatabaseSavedViewLayoutMode>('table')
  const [formViewId, setFormViewId] = useState<string | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)
  const [bulkFieldId, setBulkFieldId] = useState('')
  const [bulkValue, setBulkValue] = useState<DocumentDatabaseFieldValue>(null)

  const labels = useMemo(() => ({
    title: text.title,
    path: locale.startsWith('zh') ? '路径' : 'Path',
    parent: locale.startsWith('zh') ? '父级' : 'Parent',
    linkedDocument: text.linkedDocument,
    blockCount: locale.startsWith('zh') ? '块数' : 'Blocks',
    linkCount: locale.startsWith('zh') ? '链接数' : 'Links',
    childCount: locale.startsWith('zh') ? '子文档' : 'Children',
    createdAt: locale.startsWith('zh') ? '创建时间' : 'Created',
    updatedAt: locale.startsWith('zh') ? '更新时间' : 'Updated'
  }), [locale, text.linkedDocument, text.title])

  const columns = currentSource?.kind === 'document-catalog' ? catalogColumns : selectedColumns
  const fields = useMemo(() => currentSource?.kind === 'document-catalog'
    ? adaptCatalogFields(columns, labels)
    : adaptCustomFields(columns, labels), [columns, currentSource?.kind, labels])
  const records = useMemo(() => !currentSource ? [] : currentSource.kind === 'document-catalog'
    ? adaptCatalogRecords(currentSource.id, catalogDocuments)
    : adaptCustomRecords(currentSource.id, entities, catalogDocuments), [catalogDocuments, currentSource, entities])

  const { activeView, baseConfig, dirty, draft, markSaved, replaceDraft, updateDraft } = useDatabaseViewDraft({
    activeViewId,
    databaseId: currentSource?.id ?? '',
    fields,
    onActiveViewIdChange,
    savedViews
  })
  const visibleFields = useMemo(() => {
    const byId = new Map(fields.map((field) => [field.id, field]))
    return draft.fieldOrder
      .filter((fieldId) => draft.visibleFieldIds.includes(fieldId))
      .map((fieldId) => byId.get(fieldId))
      .filter((field): field is DatabaseField => Boolean(field))
  }, [draft.fieldOrder, draft.visibleFieldIds, fields])
  const filteredRecords = useMemo(() => applyDatabaseView(records, fields, draft.query, draft.filters, draft.sorts), [draft.filters, draft.query, draft.sorts, fields, records])
  const selectedIdSet = useMemo(() => new Set(selectedRecordIds), [selectedRecordIds])
  const boardField = fields.find((field) => field.id === draft.groupBy.fieldId) ?? null
  const boardGroups = useMemo(() => groupDatabaseRecords(filteredRecords, boardField?.id ?? null).map((group) => ({
    ...group,
    label: group.id === '__ungrouped__' ? text.noGrouping : group.id === '__checked__' ? text.checked : group.id === '__unchecked__' ? text.unchecked : group.label
  })), [boardField?.id, filteredRecords, text])
  const openRecord = records.find((record) => record.id === openRecordId) ?? null
  const propertyFields = fields.filter((field) => field.role === 'property')
  const bulkField = propertyFields.find((field) => field.id === bulkFieldId) ?? propertyFields[0] ?? null

  useEffect(() => {
    const visibleIds = new Set(filteredRecords.map((record) => record.id))
    const next = selectedRecordIds.filter((recordId) => visibleIds.has(recordId))
    if (next.length !== selectedRecordIds.length) onSelectedRecordIdsChange(next)
  }, [filteredRecords, onSelectedRecordIdsChange, selectedRecordIds])

  useEffect(() => {
    if (draft.layout !== 'board' || draft.groupBy.fieldId) return
    const nextField = fields.find((field) => field.type === 'select' || field.type === 'multi-select')
      ?? fields.find((field) => field.id === DATABASE_SYSTEM_FIELD_IDS.parent)
      ?? fields.find((field) => field.role === 'property')
    if (nextField) updateDraft((current) => ({ ...current, groupBy: { fieldId: nextField.id } }))
  }, [draft.groupBy.fieldId, draft.layout, fields, updateDraft])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTyping = target?.matches('input, textarea, select, [contenteditable="true"]')
      if (event.key === '/' && !isTyping) {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('.dbw-main-search input')?.focus()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        document.querySelector<HTMLButtonElement>('.dbw-source-trigger')?.focus()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        document.querySelector<HTMLElement>('.dbw-new-view-menu summary')?.focus()
        return
      }
      if (event.key === 'Delete' && !isTyping && currentSource?.kind === 'custom' && selectedRecordIds.length > 0) {
        event.preventDefault()
        setConfirmTarget({ kind: 'records', ids: selectedRecordIds, name: text.selected(selectedRecordIds.length) })
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [currentSource?.kind, selectedRecordIds, text])

  if (!currentSource) return <div className="dbw-loading">{text.loading}</div>

  const reportError = (error: unknown) => onMessage(error instanceof Error ? error.message : text.failed)
  const run = async (action: () => Promise<void>, successMessage?: string) => {
    try {
      await action()
      if (successMessage) onMessage(successMessage)
    } catch (error) {
      reportError(error)
    }
  }
  const refresh = (preferredViewId?: string) => onRefresh(currentSource.id, preferredViewId)

  const switchSource = (databaseId: string) => {
    onSelectedRecordIdsChange([])
    setOpenRecordId(null)
    onActiveViewIdChange('')
    onCurrentDatabaseIdChange(databaseId)
  }

  const createDocumentOrRecord = () => {
    if (currentSource.kind === 'custom') {
      setCreateRecordOpen(true)
      return
    }
    void run(async () => {
      const created = await window.knowbook.createDocument(null)
      await onRefresh(currentSource.id)
      onOpenDocument(created.id)
    })
  }

  const openDatabaseForm = (mode: 'create-database' | 'edit-database') => {
    setFormMode(mode)
    setFormName(mode === 'edit-database' ? currentSource.name : '')
    setFormDescription(mode === 'edit-database' ? currentSource.description : '')
  }
  const openViewForm = (mode: 'create-view' | 'rename-view', layout: DatabaseSavedViewLayoutMode, view?: DatabaseSavedView) => {
    setFormMode(mode)
    setFormViewLayout(layout)
    setFormViewId(view?.id ?? null)
    setFormName(view?.name ?? `${layout === 'table' ? text.table : layout === 'board' ? text.board : text.cards} ${savedViews.length + 1}`)
    setFormDescription('')
  }

  const submitForm = async () => {
    const name = formName.trim()
    if (!name) return
    if (formMode === 'create-database') {
      await run(async () => {
        const created = await window.knowbook.createDocumentDatabase({ name, description: formDescription })
        setFormMode(null)
        await onRefresh(created.id)
        switchSource(created.id)
      })
      return
    }
    if (formMode === 'edit-database') {
      await run(async () => {
        await window.knowbook.updateDatabaseMetadata({ databaseId: currentSource.id, name, description: formDescription })
        setFormMode(null)
        await refresh()
      })
      return
    }
    if (formMode === 'create-view') {
      await createView(name, formViewLayout)
      return
    }
    if (formMode === 'rename-view' && formViewId) {
      await run(async () => {
        const updated = await window.knowbook.updateDatabaseSavedView({ viewId: formViewId, name })
        setFormMode(null)
        await refresh(updated.id)
        markSaved(updated)
      })
    }
  }

  const createView = async (name: string, layout: DatabaseSavedViewLayoutMode, config: DatabaseViewConfigV1 = { ...draft, layout }) => {
    const defaultBoardField = fields.find((field) => field.type === 'select' || field.type === 'multi-select')
      ?? fields.find((field) => field.id === DATABASE_SYSTEM_FIELD_IDS.parent)
      ?? fields.find((field) => field.role === 'property')
    const normalizedConfig = layout === 'board' && !config.groupBy.fieldId && defaultBoardField
      ? { ...config, layout, groupBy: { fieldId: defaultBoardField.id } }
      : { ...config, layout }
    await run(async () => {
      const created = await window.knowbook.createDatabaseSavedView({
        databaseId: currentSource.id,
        name,
        ...legacyViewFields(normalizedConfig),
        config: normalizedConfig
      })
      setFormMode(null)
      await refresh(created.id)
      markSaved(created)
    })
  }

  const saveView = async () => {
    if (!activeView) {
      openViewForm('create-view', draft.layout)
      return
    }
    await run(async () => {
      const updated = await window.knowbook.updateDatabaseSavedView({ viewId: activeView.id, ...legacyViewFields(draft), config: draft })
      await refresh(updated.id)
      markSaved(updated)
    })
  }

  const updateValue = async (record: DatabaseRecord, field: DatabaseField, value: DocumentDatabaseFieldValue) => {
    await run(async () => {
      if (currentSource.kind === 'document-catalog') {
        await window.knowbook.updateDocumentDatabaseValue({ documentId: record.id, columnId: field.id, value })
      } else {
        await window.knowbook.updateDatabaseEntity({ entityId: record.id, fieldValues: { [field.id]: value } })
      }
      await refresh(activeViewId)
    })
  }

  const updateLinkedDocument = async (record: DatabaseRecord, documentId: string | null) => {
    await run(async () => {
      await window.knowbook.updateDatabaseEntity({ entityId: record.id, documentId })
      await refresh(activeViewId)
    })
  }

  const createRecord = async (recordDraft: { title: string; documentId: string; fieldValues: Record<string, DocumentDatabaseFieldValue> }, continueAdding: boolean) => {
    await run(async () => {
      await window.knowbook.createDatabaseEntity({
        databaseId: currentSource.id,
        title: recordDraft.title,
        documentId: recordDraft.documentId || undefined,
        fieldValues: recordDraft.fieldValues
      })
      await refresh(activeViewId)
      if (!continueAdding) setCreateRecordOpen(false)
    })
  }

  const saveRecord = async (record: DatabaseRecord, recordDraft: { title: string; documentId: string; fieldValues: Record<string, DocumentDatabaseFieldValue> }) => {
    await run(async () => {
      await window.knowbook.updateDatabaseEntity({
        entityId: record.id,
        title: recordDraft.title,
        documentId: recordDraft.documentId || null,
        fieldValues: recordDraft.fieldValues
      })
      await refresh(activeViewId)
      setOpenRecordId(null)
    })
  }

  const moveBoardRecord = async (record: DatabaseRecord, field: DatabaseField | null, groupId: string) => {
    if (!field) return
    const value: string | boolean | null = groupId === '__ungrouped__'
      ? null
      : groupId === '__checked__'
        ? true
        : groupId === '__unchecked__'
          ? false
          : groupId.startsWith('value:') ? groupId.slice('value:'.length) : groupId
    if (field.id === DATABASE_SYSTEM_FIELD_IDS.parent && currentSource.kind === 'document-catalog') {
      const parent = value ? catalogDocuments.find((document) => document.title === value) : null
      await run(async () => { await window.knowbook.moveDocument(record.id, parent?.id ?? null); await refresh(activeViewId) })
      return
    }
    if (field.id === DATABASE_SYSTEM_FIELD_IDS.document && currentSource.kind === 'custom') {
      const document = value ? catalogDocuments.find((candidate) => candidate.path === value) : null
      await updateLinkedDocument(record, document?.id ?? null)
      return
    }
    if (field.role === 'property') {
      const nextValue = getBoardDropFieldValue(
        { id: field.id, name: field.name, type: field.type, options: field.options, sortOrder: field.sortOrder },
        toDocumentFieldValue(record.fieldValues[field.id]),
        value
      )
      if (nextValue !== undefined) await updateValue(record, field, nextValue)
    }
  }

  const applyBulkValue = async (clear = false) => {
    if (!bulkField || currentSource.kind !== 'custom' || selectedRecordIds.length === 0) return
    await run(async () => {
      await window.knowbook.updateDatabaseEntities({
        updates: selectedRecordIds.map((entityId) => ({
          entityId,
          fieldValues: { [bulkField.id]: clear ? null : bulkValue }
        }))
      })
      await refresh(activeViewId)
    })
  }

  const clearBulkDocuments = async () => {
    if (currentSource.kind !== 'custom') return
    await run(async () => {
      await window.knowbook.updateDatabaseEntities({ updates: selectedRecordIds.map((entityId) => ({ entityId, documentId: null })) })
      await refresh(activeViewId)
    })
  }

  const handleConfirm = async () => {
    const target = confirmTarget
    if (!target) return
    await run(async () => {
      if (target.kind === 'database') {
        await window.knowbook.deleteDatabase(target.id)
        const fallback = sources.find((source) => source.kind === 'document-catalog')
        setConfirmTarget(null)
        await onRefresh(fallback?.id)
        if (fallback) switchSource(fallback.id)
        return
      }
      if (target.kind === 'view') await window.knowbook.deleteDatabaseSavedView(target.id)
      if (target.kind === 'field') await window.knowbook.deleteDocumentDatabaseColumn(target.id)
      if (target.kind === 'record') await window.knowbook.deleteDatabaseEntity(target.id)
      if (target.kind === 'records') await window.knowbook.deleteDatabaseEntities({ entityIds: target.ids })
      setConfirmTarget(null)
      setOpenRecordId(null)
      onSelectedRecordIdsChange([])
      await refresh()
    })
  }

  const toggleField = (fieldId: string) => updateDraft((current) => ({
    ...current,
    visibleFieldIds: current.visibleFieldIds.includes(fieldId)
      ? current.visibleFieldIds.filter((candidate) => candidate !== fieldId)
      : [...current.visibleFieldIds, fieldId]
  }))
  const moveField = (fieldId: string, direction: 'up' | 'down') => updateDraft((current) => {
    const order = [...current.fieldOrder]
    const index = order.indexOf(fieldId)
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    if (index < 0 || targetIndex < 0 || targetIndex >= order.length) return current
    ;[order[index], order[targetIndex]] = [order[targetIndex]!, order[index]!]
    return { ...current, fieldOrder: order }
  })

  const empty = filteredRecords.length === 0
  return (
    <section className="dbw-shell" data-testid="database-grid">
      <DatabaseHeader
        currentSource={currentSource}
        onCreateDatabase={() => openDatabaseForm('create-database')}
        onCreateRecord={createDocumentOrRecord}
        onDeleteDatabase={() => setConfirmTarget({ kind: 'database', id: currentSource.id, name: currentSource.name })}
        onEditDatabase={() => openDatabaseForm('edit-database')}
        onSourceChange={switchSource}
        sources={sources}
        text={text}
      />
      <DatabaseViewTabs
        activeViewId={activeViewId}
        dirty={dirty}
        onCreateView={(layout) => openViewForm('create-view', layout)}
        onDeleteView={(view) => {
          if (savedViews.length <= 1) { onMessage(locale.startsWith('zh') ? '数据库至少需要保留一个视图。' : 'A database must keep at least one view.'); return }
          setConfirmTarget({ kind: 'view', id: view.id, name: view.name })
        }}
        onMoveView={(viewId, targetViewId) => {
          const reordered = [...savedViews]
          const fromIndex = reordered.findIndex((view) => view.id === viewId)
          const toIndex = reordered.findIndex((view) => view.id === targetViewId)
          if (fromIndex < 0 || toIndex < 0) return
          const [moved] = reordered.splice(fromIndex, 1)
          if (!moved) return
          reordered.splice(toIndex, 0, moved)
          void run(async () => {
            await window.knowbook.reorderDatabaseSavedViews({ databaseId: currentSource.id, viewIds: reordered.map((view) => view.id) })
            await refresh(activeViewId)
          })
        }}
        onRenameView={(view) => openViewForm('rename-view', view.config.layout, view)}
        onSelectView={onActiveViewIdChange}
        savedViews={savedViews}
        text={text}
      />
      <DatabaseViewToolbar
        config={draft}
        dirty={dirty}
        fields={fields}
        onChange={updateDraft}
        onOpenFields={() => setFieldDrawerOpen(true)}
        onReset={() => replaceDraft(baseConfig)}
        onSave={() => void saveView()}
        onSaveAs={() => openViewForm('create-view', draft.layout)}
        recordCount={filteredRecords.length}
        text={text}
      />

      {selectedRecordIds.length > 0 ? (
        <div className="dbw-selection-toolbar">
          <strong>{text.selected(selectedRecordIds.length)}</strong>
          <button onClick={() => onSelectedRecordIdsChange(filteredRecords.map((record) => record.id))} type="button">{locale.startsWith('zh') ? '全选当前视图' : 'Select all visible'}</button>
          <button onClick={() => onSelectedRecordIdsChange([])} type="button">{text.clearSelection}</button>
          {currentSource.kind === 'custom' && bulkField ? (
            <div className="dbw-bulk-field-editor">
              <select onChange={(event) => { setBulkFieldId(event.target.value); setBulkValue(null) }} value={bulkField.id}>
                {propertyFields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
              </select>
              <DatabaseValueEditor column={{ id: bulkField.id, name: bulkField.name, type: bulkField.type, options: bulkField.options, sortOrder: bulkField.sortOrder }} onChangeValue={setBulkValue} textCommitMode="change" value={bulkValue} />
              <button onClick={() => void applyBulkValue(false)} type="button">{locale.startsWith('zh') ? '应用' : 'Apply'}</button>
              <button onClick={() => void applyBulkValue(true)} type="button">{locale.startsWith('zh') ? '清空字段' : 'Clear field'}</button>
            </div>
          ) : null}
          {currentSource.kind === 'custom' && selectedRecordIds.some((recordId) => records.find((record) => record.id === recordId)?.documentId) ? <button onClick={() => void clearBulkDocuments()} type="button">{locale.startsWith('zh') ? '解除文档关联' : 'Unlink documents'}</button> : null}
          {currentSource.kind === 'custom' ? <button className="dbw-danger-text" onClick={() => setConfirmTarget({ kind: 'records', ids: selectedRecordIds, name: text.selected(selectedRecordIds.length) })} type="button">{text.deleteRecord}</button> : null}
        </div>
      ) : null}

      <main className={`dbw-canvas dbw-canvas-${draft.layout}`}>
        {empty ? <div className="dbw-empty-state"><span aria-hidden="true">▦</span><h3>{text.noRecords}</h3><p>{text.noRecordsHint}</p><button className="dbw-primary-button" onClick={createDocumentOrRecord} type="button">＋ {currentSource.kind === 'document-catalog' ? text.newDocument : text.newRecord}</button></div> : null}
        {!empty && draft.layout === 'table' ? (
          <DatabaseTableView columnWidths={draft.columnWidths} documents={catalogDocuments} fields={visibleFields} onColumnWidthChange={(fieldId, width) => updateDraft((current) => ({ ...current, columnWidths: { ...current.columnWidths, [fieldId]: Math.round(width) } }))} onOpenDocument={onOpenDocument} onOpenRecord={(record) => setOpenRecordId(record.id)} onSelect={(id, selected) => onSelectedRecordIdsChange(selected ? [...selectedRecordIds, id] : selectedRecordIds.filter((candidate) => candidate !== id))} onUpdateDocument={updateLinkedDocument} onUpdateValue={updateValue} records={filteredRecords} selectedIds={selectedIdSet} sourceKind={currentSource.kind} text={text} />
        ) : null}
        {!empty && draft.layout === 'board' ? <DatabaseBoardView field={boardField} groups={boardGroups} onMoveRecord={moveBoardRecord} onOpenDocument={onOpenDocument} onOpenRecord={(record) => setOpenRecordId(record.id)} sourceKind={currentSource.kind} text={text} /> : null}
        {!empty && draft.layout === 'cards' ? <DatabaseCardView fields={draft.cardFieldIds.length > 0 ? visibleFields.filter((field) => draft.cardFieldIds.includes(field.id) || field.role === 'title') : visibleFields} onOpenDocument={onOpenDocument} onOpenRecord={(record) => setOpenRecordId(record.id)} onSelect={(id, selected) => onSelectedRecordIdsChange(selected ? [...selectedRecordIds, id] : selectedRecordIds.filter((candidate) => candidate !== id))} records={filteredRecords} selectedIds={selectedIdSet} sourceKind={currentSource.kind} text={text} /> : null}
      </main>

      <DatabaseFieldDrawer
        fieldOrder={draft.fieldOrder}
        fields={fields}
        onClose={() => setFieldDrawerOpen(false)}
        onCreateField={async (name, type, options) => run(async () => {
          const created = await window.knowbook.createDocumentDatabaseColumn({ databaseId: currentSource.id, name, type, options })
          updateDraft((current) => ({
            ...current,
            visibleFieldIds: [...current.visibleFieldIds, created.id],
            fieldOrder: [...current.fieldOrder, created.id],
            cardFieldIds: [...current.cardFieldIds, created.id].slice(0, 4)
          }))
          await refresh(activeViewId)
        })}
        onDeleteField={(field) => setConfirmTarget({ kind: 'field', id: field.id, name: field.name })}
        onMoveField={moveField}
        onMoveDatabaseField={(fieldId, direction) => run(async () => { await window.knowbook.moveDocumentDatabaseColumn({ columnId: fieldId, direction }); await refresh(activeViewId) })}
        onRenameField={(fieldId, name) => run(async () => { await window.knowbook.renameDocumentDatabaseColumn({ columnId: fieldId, name }); await refresh(activeViewId) })}
        onToggleField={toggleField}
        onUpdateOptions={(fieldId, options) => run(async () => { await window.knowbook.updateDocumentDatabaseColumnOptions({ columnId: fieldId, options }); await refresh(activeViewId) })}
        open={fieldDrawerOpen}
        text={text}
        visibleFieldIds={draft.visibleFieldIds}
      />
      <CreateRecordDialog documents={catalogDocuments} fields={visibleFields} onCancel={() => setCreateRecordOpen(false)} onCreate={createRecord} open={createRecordOpen} text={text} />
      <DatabaseRecordDrawer documents={catalogDocuments} fields={fields} onClose={() => setOpenRecordId(null)} onDelete={(record) => setConfirmTarget({ kind: 'record', id: record.id, name: record.title })} onOpenDocument={onOpenDocument} onSave={saveRecord} open={Boolean(openRecord)} record={openRecord} text={text} />
      <DatabaseFormDialog description={formDescription} name={formName} onCancel={() => setFormMode(null)} onDescriptionChange={setFormDescription} onNameChange={setFormName} onSubmit={() => void submitForm()} open={formMode !== null} submitLabel={formMode === 'create-database' || formMode === 'create-view' ? text.create : text.save} text={text} title={formMode === 'create-database' ? text.newDatabase : formMode === 'edit-database' ? text.editDatabase : formMode === 'rename-view' ? text.rename : text.newView} withDescription={formMode === 'create-database' || formMode === 'edit-database'} />
      <DatabaseConfirmDialog body={confirmTarget ? `“${confirmTarget.name}”` : ''} confirmLabel={confirmTarget?.kind === 'database' ? text.deleteDatabase : confirmTarget?.kind === 'field' ? text.deleteField : confirmTarget?.kind === 'view' ? text.deleteView : text.deleteRecord} onCancel={() => setConfirmTarget(null)} onConfirm={() => void handleConfirm()} open={Boolean(confirmTarget)} text={text} title={confirmTarget?.kind === 'database' ? text.deleteDatabase : confirmTarget?.kind === 'field' ? text.deleteField : confirmTarget?.kind === 'view' ? text.deleteView : text.deleteRecord} />
    </section>
  )
}

function legacyViewFields(config: DatabaseViewConfigV1) {
  const primarySort = config.sorts[0]
  const sortMode = primarySort?.fieldId === DATABASE_SYSTEM_FIELD_IDS.createdAt
    ? primarySort.direction === 'asc' ? 'created-asc' as const : 'created-desc' as const
    : primarySort?.direction === 'asc' ? 'updated-asc' as const : 'updated-desc' as const
  return {
    filterQuery: config.query,
    filterScope: '',
    sortMode,
    viewMode: config.layout
  }
}

function toDocumentFieldValue(value: unknown): DocumentDatabaseFieldValue {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value ?? null
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  return null
}
