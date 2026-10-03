import type { AppMessageHandler } from '../../notify'
import { getErrorMessage } from '../../utils/errorMessage'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  DatabaseEntity,
  DatabaseField,
  DatabaseRecord,
  DatabaseSavedView,
  DatabaseSavedViewFormResult,
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
import type { DatabaseDeletion } from './model/databaseDeletion'
import { DatabaseTextDraftCache, type DatabaseValueCommitResult } from './model/databaseTextDrafts'

type DatabaseWorkspaceProps = {
  activeViewId: string
  catalogColumns: DocumentDatabaseColumn[]
  catalogDocuments: DocumentCatalogEntry[]
  currentDatabaseId: string
  databases: DocumentDatabase[]
  entities: DatabaseEntity[]
  locale: string
  savedViews: DatabaseSavedView[]
  viewDraftCache?: Map<string, DatabaseViewConfigV1>
  textDraftCache?: DatabaseTextDraftCache
  selectedColumns: DocumentDatabaseColumn[]
  selectedRecordIds: string[]
  onActiveViewIdChange: (viewId: string) => void
  onCurrentDatabaseIdChange: (databaseId: string) => void
  onMessage: AppMessageHandler
  onOpenDocument: (documentId: string) => void
  onRefresh: (databaseId?: string, preferredViewId?: string, shouldContinue?: () => boolean) => Promise<void | boolean>
  onSavedDatabase?: (database: DocumentDatabase, options?: { activate?: boolean }) => void
  onDeleted?: (deletion: DatabaseDeletion) => void | Promise<void>
  onSavedView?: (view: DatabaseSavedView) => void
  onSelectedRecordIdsChange: (recordIds: string[]) => void
}

type FormMode = 'create-database' | 'edit-database' | 'create-view' | 'rename-view' | null
type FormFocusLease = {
  session: number
  target: HTMLElement | null
  source: { id: string | undefined }
  closedView: { sourceId: string | undefined; viewId: string } | null
  approved: boolean
}
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
  viewDraftCache,
  textDraftCache,
  selectedColumns,
  selectedRecordIds,
  onActiveViewIdChange,
  onCurrentDatabaseIdChange,
  onMessage,
  onOpenDocument,
  onRefresh,
  onSavedDatabase,
  onDeleted,
  onSavedView,
  onSelectedRecordIdsChange
}: DatabaseWorkspaceProps) {
  const text = useMemo(() => getDatabaseWorkspaceText(locale), [locale])
  const localTextDraftCache = useRef<DatabaseTextDraftCache | null>(null)
  if (!localTextDraftCache.current) localTextDraftCache.current = new DatabaseTextDraftCache()
  const cellDrafts = textDraftCache ?? localTextDraftCache.current
  const sources = useMemo(() => adaptDatabaseSources(databases), [databases])
  const currentSource = sources.find((source) => source.id === currentDatabaseId) ?? sources[0]
  const currentSourceIdRef = useRef(currentSource?.id)
  currentSourceIdRef.current = currentSource?.id
  const fieldSourceSessionRef = useRef({ id: currentSource?.id })
  if (fieldSourceSessionRef.current.id !== currentSource?.id) fieldSourceSessionRef.current = { id: currentSource?.id }
  const fieldSourceSession = fieldSourceSessionRef.current
  const viewSessionRef = useRef({ sourceId: currentSource?.id, viewId: activeViewId })
  if (viewSessionRef.current.sourceId !== currentSource?.id || viewSessionRef.current.viewId !== activeViewId) {
    viewSessionRef.current = { sourceId: currentSource?.id, viewId: activeViewId }
  }
  const viewSession = viewSessionRef.current
  const mounted = useRef(false)
  const refreshRequestRef = useRef<{ source: typeof fieldSourceSession } | null>(null)
  const [refreshingSource, setRefreshingSource] = useState<typeof fieldSourceSession | null>(null)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const viewSaveRequests = useRef(new Map<string, symbol>())
  const [savingViews, setSavingViews] = useState(() => new Set<string>())
  const viewSaveKey = JSON.stringify([currentSource?.id, activeViewId])
  const [fieldDrawerOpen, setFieldDrawerOpen] = useState(false)
  const [createRecordOpen, setCreateRecordOpen] = useState(false)
  const [openRecordId, setOpenRecordId] = useState<string | null>(null)
  const [formMode, setFormMode] = useState<FormMode>(null)
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formViewLayout, setFormViewLayout] = useState<DatabaseSavedViewLayoutMode>('table')
  const [formViewId, setFormViewId] = useState<string | null>(null)
  const formSessionRef = useRef(0)
  const [formSession, setFormSession] = useState(0)
  const formOwnerRef = useRef({ source: fieldSourceSession, view: viewSession })
  const newViewTriggerRef = useRef<HTMLElement | null>(null)
  const formFocusLeaseRef = useRef<FormFocusLease | null>(null)
  const formFocusLease = formFocusLeaseRef.current
  const formRequests = useRef(new Map<number, symbol>())
  const [pendingForms, setPendingForms] = useState(() => new Set<number>())
  const [formError, setFormError] = useState<string | null>(null)
  const [formNameIssue, setFormNameIssue] = useState<Extract<DatabaseSavedViewFormResult, { status: 'invalid-name' }>['reason'] | null>(null)
  const metadataSaveRequests = useRef(new Map<string, symbol>())
  const [savingDatabases, setSavingDatabases] = useState(() => new Set<string>())
  const closeForm = (expectedSession = formSessionRef.current, restoreFocus = true,
    completedView = formOwnerRef.current.view, completedSource = formOwnerRef.current.source) => {
    if (formSessionRef.current !== expectedSession) return
    const lease = formFocusLeaseRef.current
    if (lease?.session === expectedSession) {
      lease.approved = restoreFocus && fieldSourceSessionRef.current === completedSource && viewSessionRef.current === completedView
      lease.source = completedSource
      lease.closedView = viewSessionRef.current
    }
    formSessionRef.current++
    setFormMode(null)
    setFormError(null)
    setFormNameIssue(null)
  }
  useLayoutEffect(() => {
    if (!formMode) return
    if (formOwnerRef.current.source !== fieldSourceSession || formOwnerRef.current.view !== viewSession) closeForm(formSession, false)
  }, [fieldSourceSession, formMode, formSession, viewSession])
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)
  const confirmSessionRef = useRef(0)
  const [confirmSession, setConfirmSession] = useState(0)
  const confirmOwner = useRef({ source: fieldSourceSession, view: viewSession, returnFocus: null as HTMLElement | null })
  const openConfirm = (target: ConfirmTarget) => {
    confirmOwner.current = { source: fieldSourceSessionRef.current, view: viewSessionRef.current,
      returnFocus: document.querySelector<HTMLInputElement>('.dbw-main-search input') }
    setConfirmSession(++confirmSessionRef.current)
    setConfirmTarget(target)
  }
  const closeConfirm = (session = confirmSessionRef.current) => {
    if (session !== confirmSessionRef.current) return
    confirmSessionRef.current++
    setConfirmTarget(null)
  }
  useLayoutEffect(() => {
    if (confirmTarget && (confirmOwner.current.source !== fieldSourceSession || confirmOwner.current.view !== viewSession)) closeConfirm(confirmSession)
  }, [confirmTarget, confirmSession, fieldSourceSession, viewSession])
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
  useLayoutEffect(() => {
    if (currentSource) cellDrafts.prune(currentSource.id, new Set(records.map(record => record.id)),
      new Set(fields.filter(field => field.role === 'property' && field.type === 'text').map(field => field.id)))
  }, [cellDrafts, currentSource?.id, fields, records])

  const { activeView, activateCreatedView, baseConfig, dirty, draft, replaceDraft, updateDraft } = useDatabaseViewDraft({
    activeViewId,
    databaseId: currentSource?.id ?? '',
    draftCache: viewDraftCache,
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
      if (target?.closest('[role="dialog"], [role="alertdialog"]')) return
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
        openConfirm({ kind: 'records', ids: selectedRecordIds, name: text.selected(selectedRecordIds.length) })
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [currentSource?.kind, selectedRecordIds, text])

  if (!currentSource) return <div className="dbw-loading">{text.loading}</div>

  const reportError = (error: unknown) => onMessage(error instanceof Error ? error.message : text.failed, 'error')
  const run = async (action: () => Promise<void>, successMessage?: string) => {
    try {
      await action()
      if (successMessage) onMessage(successMessage)
      return true
    } catch (error) {
      reportError(error)
      return false
    }
  }
  const refresh = (preferredViewId?: string) => onRefresh(currentSource.id, preferredViewId)
  const refreshDatabase = async () => {
    const shouldContinue = () => mounted.current && fieldSourceSessionRef.current === fieldSourceSession
    if (!shouldContinue() || refreshRequestRef.current?.source === fieldSourceSession) return
    const request = { source: fieldSourceSession }
    refreshRequestRef.current = request
    setRefreshingSource(fieldSourceSession)
    try { await onRefresh(currentSource.id, undefined, shouldContinue) }
    catch (error) {
      console.warn('Database refresh failed.', error)
      if (shouldContinue()) onMessage(text.refreshFailed, 'error')
    } finally {
      if (refreshRequestRef.current === request) {
        refreshRequestRef.current = null
        if (mounted.current) setRefreshingSource(previous => previous === request.source ? null : previous)
      }
    }
  }
  const runFieldMutation = async <T,>(mutate: () => Promise<T>, onSaved?: (result: T) => void) => {
    let result: T
    try {
      result = await mutate()
    } catch {
      return false
    }
    // The field already exists on disk; a failed refresh must not make a
    // second creation look like a retry of the original mutation.
    if (fieldSourceSessionRef.current !== fieldSourceSession) return true
    try {
      onSaved?.(result)
      await refresh(activeViewId)
    } catch {
      if (fieldSourceSessionRef.current === fieldSourceSession) onMessage(text.fieldsSavedRefreshFailed, 'error')
    }
    return true
  }

  const switchSource = (databaseId: string) => {
    if (databaseId !== currentSource.id) {
      fieldSourceSessionRef.current = { id: databaseId }
      viewSessionRef.current = { sourceId: databaseId, viewId: '' }
    }
    onSelectedRecordIdsChange([])
    setOpenRecordId(null)
    onActiveViewIdChange('')
    onCurrentDatabaseIdChange(databaseId)
  }

  const selectView = (viewId: string) => {
    if (viewId !== activeViewId) viewSessionRef.current = { sourceId: currentSource.id, viewId }
    onActiveViewIdChange(viewId)
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

  const beginForm = (returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null) => {
    const session = ++formSessionRef.current
    formOwnerRef.current = { source: fieldSourceSessionRef.current, view: viewSessionRef.current }
    formFocusLeaseRef.current = { session, target: returnTarget, source: fieldSourceSessionRef.current, closedView: null, approved: false }
    setFormSession(session)
    setFormError(null)
    setFormNameIssue(null)
  }
  const openDatabaseForm = (mode: 'create-database' | 'edit-database', returnTarget?: HTMLElement | null) => {
    beginForm(returnTarget)
    setFormMode(mode)
    setFormName(mode === 'edit-database' ? currentSource.name : '')
    setFormDescription(mode === 'edit-database' ? currentSource.description : '')
  }
  const openViewForm = (mode: 'create-view' | 'rename-view', layout: DatabaseSavedViewLayoutMode, view?: DatabaseSavedView, returnTarget?: HTMLElement | null) => {
    beginForm(returnTarget === undefined && mode === 'create-view' ? newViewTriggerRef.current : returnTarget)
    setFormMode(mode)
    setFormViewLayout(layout)
    setFormViewId(view?.id ?? null)
    setFormName(view?.name ?? `${layout === 'table' ? text.table : layout === 'board' ? text.board : text.cards} ${savedViews.length + 1}`)
    setFormDescription('')
  }

  const submitForm = async () => {
    if (!mounted.current || formSessionRef.current !== formSession || formRequests.current.has(formSession)) return
    const name = formName.trim()
    if (!name) return
    if (formMode === 'create-database' || formMode === 'edit-database') {
      await submitDatabaseForm(name)
      return
    }
    if (formMode === 'create-view' || (formMode === 'rename-view' && formViewId)) await submitViewForm(name)
  }

  const submitDatabaseForm = async (name: string) => {
    const owner = formOwnerRef.current
    if (owner.source !== fieldSourceSessionRef.current || owner.view !== viewSessionRef.current) return
    const creating = formMode === 'create-database'
    const metadataId = creating ? null : currentSource.id
    if (metadataId && metadataSaveRequests.current.has(metadataId)) return
    const request = Symbol('database-form')
    formRequests.current.set(formSession, request)
    setPendingForms((current) => new Set(current).add(formSession))
    setFormError(null)
    if (metadataId) {
      metadataSaveRequests.current.set(metadataId, request)
      setSavingDatabases((current) => new Set(current).add(metadataId))
    }
    const releaseMetadataSave = () => {
      if (!metadataId || metadataSaveRequests.current.get(metadataId) !== request) return
      metadataSaveRequests.current.delete(metadataId)
      if (mounted.current) setSavingDatabases((current) => {
        const next = new Set(current)
        next.delete(metadataId)
        return next
      })
    }
    const ownsForm = () => mounted.current && fieldSourceSessionRef.current === owner.source
      && viewSessionRef.current === owner.view && formSessionRef.current === formSession
    let completedSource = owner.source
    let completedView = owner.view
    const ownsClosedForm = () => mounted.current && fieldSourceSessionRef.current === completedSource
      && viewSessionRef.current === completedView && formSessionRef.current === formSession + 1
    try {
      const saved = creating
        ? await window.knowbook.createDocumentDatabase({ name, description: formDescription })
        : await window.knowbook.updateDatabaseMetadata({ databaseId: currentSource.id, name, description: formDescription })
      releaseMetadataSave()
      const shouldCompleteForm = ownsForm()
      // Metadata belongs in the shared list even if the user has left this
      // workspace while its Page is loading another source. The Page guards
      // its own lifetime; activation belongs only to this form session.
      onSavedDatabase?.(saved, creating && shouldCompleteForm ? { activate: true } : undefined)
      if (!shouldCompleteForm) return
      if (creating) {
        switchSource(saved.id)
        completedSource = fieldSourceSessionRef.current
        completedView = viewSessionRef.current
      }
      closeForm(formSession, true, completedView, completedSource)
      try {
        await onRefresh(saved.id)
      } catch {
        if (ownsClosedForm()) onMessage(text.databasesSavedRefreshFailed, 'error')
      }
    } catch (error) {
      if (ownsForm()) setFormError(getErrorMessage(error, text.failed))
      else if (ownsClosedForm()) onMessage(getErrorMessage(error, text.failed), 'error')
    } finally {
      if (formRequests.current.get(formSession) === request) {
        formRequests.current.delete(formSession)
        if (mounted.current) setPendingForms((current) => {
          const next = new Set(current)
          next.delete(formSession)
          return next
        })
      }
      releaseMetadataSave()
    }
  }

  const normalizeCreatedConfig = (config: DatabaseViewConfigV1, layout: DatabaseSavedViewLayoutMode) => {
    const defaultBoardField = fields.find((field) => field.type === 'select' || field.type === 'multi-select')
      ?? fields.find((field) => field.id === DATABASE_SYSTEM_FIELD_IDS.parent)
      ?? fields.find((field) => field.role === 'property')
    return layout === 'board' && !config.groupBy.fieldId && defaultBoardField
      ? { ...config, layout, groupBy: { fieldId: defaultBoardField.id } }
      : { ...config, layout }
  }

  const submitViewForm = async (name: string) => {
    const owner = formOwnerRef.current
    if (owner.source !== fieldSourceSessionRef.current || owner.view !== viewSessionRef.current) return
    const renameId = formMode === 'rename-view' ? formViewId : null
    const saveKey = renameId ? JSON.stringify([currentSource.id, renameId]) : null
    if (saveKey && viewSaveRequests.current.has(saveKey)) return
    const request = Symbol('view-form')
    formRequests.current.set(formSession, request)
    setPendingForms((current) => new Set(current).add(formSession))
    setFormError(null)
    setFormNameIssue(null)
    if (saveKey) {
      viewSaveRequests.current.set(saveKey, request)
      setSavingViews((current) => new Set(current).add(saveKey))
    }
    const ownsSource = () => mounted.current && fieldSourceSessionRef.current === owner.source
    const ownsForm = () => ownsSource() && viewSessionRef.current === owner.view && formSessionRef.current === formSession
    let completedViewSession = owner.view
    const ownsClosedForm = () => ownsSource() && viewSessionRef.current === completedViewSession && formSessionRef.current === formSession + 1
    try {
      const config = normalizeCreatedConfig(draft, formViewLayout)
      const result = renameId
        ? await window.knowbook.updateDatabaseSavedViewForm({ viewId: renameId, name })
        : await window.knowbook.createDatabaseSavedViewForm({ databaseId: currentSource.id, name, ...legacyViewFields(config), config })
      if (result.status === 'invalid-name') {
        if (ownsForm()) {
          setFormNameIssue(result.reason)
          setFormError(result.message)
        }
        return
      }
      const saved = result.view
      if (!ownsSource()) return
      const shouldCompleteForm = ownsForm()
      onSavedView?.(saved)
      if (shouldCompleteForm) {
        if (!renameId) {
          completedViewSession = { sourceId: currentSource.id, viewId: saved.id }
          viewSessionRef.current = completedViewSession
          // Activate once, at the write acknowledgement. Refresh may finish
          // after the user has edited or left this new view.
          activateCreatedView(saved)
        }
        closeForm(formSession, true, completedViewSession)
      }
      try {
        await refresh()
      } catch {
        if (ownsClosedForm()) onMessage(text.viewsSavedRefreshFailed, 'error')
      }
    } catch (error) {
      if (ownsForm()) setFormError(getErrorMessage(error, text.failed))
      else if (ownsClosedForm()) reportError(error)
    } finally {
      if (formRequests.current.get(formSession) === request) {
        formRequests.current.delete(formSession)
        if (mounted.current) setPendingForms((current) => {
          const next = new Set(current)
          next.delete(formSession)
          return next
        })
      }
      if (saveKey && viewSaveRequests.current.get(saveKey) === request) {
        viewSaveRequests.current.delete(saveKey)
        if (mounted.current) setSavingViews((current) => {
          const next = new Set(current)
          next.delete(saveKey)
          return next
        })
      }
    }
  }

  const saveView = async () => {
    if (!mounted.current || viewSessionRef.current !== viewSession || viewSaveRequests.current.has(viewSaveKey)) return
    if (!activeView) {
      openViewForm('create-view', draft.layout)
      return
    }
    const request = Symbol('save-view')
    viewSaveRequests.current.set(viewSaveKey, request)
    setSavingViews((current) => new Set(current).add(viewSaveKey))
    const ownsSource = () => mounted.current && fieldSourceSessionRef.current === fieldSourceSession
    const ownsView = () => ownsSource() && viewSessionRef.current === viewSession
    try {
      const updated = await window.knowbook.updateDatabaseSavedView({ viewId: activeView.id, ...legacyViewFields(draft), config: draft })
      if (!ownsSource()) return
      // The submitted snapshot is now on disk. Updating its baseline must not
      // replace the cached draft or select a view the user has left.
      onSavedView?.(updated)
      try {
        await refresh()
      } catch {
        if (ownsView()) onMessage(text.viewsSavedRefreshFailed, 'error')
      }
    } catch (error) {
      if (ownsView()) reportError(error)
    } finally {
      if (viewSaveRequests.current.get(viewSaveKey) === request) {
        viewSaveRequests.current.delete(viewSaveKey)
        if (mounted.current) setSavingViews((current) => {
          const next = new Set(current)
          next.delete(viewSaveKey)
          return next
        })
      }
    }
  }

  const updateValue = async (record: DatabaseRecord, field: DatabaseField, value: DocumentDatabaseFieldValue, fromTextCell = false): Promise<void | DatabaseValueCommitResult> => {
    const write = async () => {
      if (currentSource.kind === 'document-catalog') {
        await window.knowbook.updateDocumentDatabaseValue({ documentId: record.id, columnId: field.id, value })
      } else {
        await window.knowbook.updateDatabaseEntity({ entityId: record.id, fieldValues: { [field.id]: value } })
      }
    }
    if (field.type !== 'text') {
      await run(async () => { await write(); await refresh(activeViewId) })
      return
    }
    const ownsSource = () => mounted.current && fieldSourceSessionRef.current === fieldSourceSession
    if (!ownsSource()) return { status: 'failed', message: text.formFailed }
    const cellKey = JSON.stringify([record.databaseId, record.id, field.id])
    const cellOperation = fromTextCell ? cellDrafts.get(cellKey)?.operation : null
    try { await write() }
    catch (error) {
      console.warn('Database text cell save failed.', error)
      if (ownsSource()) {
        if (!fromTextCell) reportError(error)
        else if (cellOperation && cellDrafts.get(cellKey)?.operation === cellOperation) onMessage(text.formFailed, 'error')
      }
      return { status: 'failed', message: text.formFailed }
    }
    // End the write lock at its ACK; subsequent reads have separate ownership.
    return { status: 'saved', value, refresh: async (isCurrent) => {
      const shouldContinue = () => ownsSource() && isCurrent()
      if (!shouldContinue()) return false
      try { return await onRefresh(currentSource.id, undefined, shouldContinue) }
      catch (error) {
        if (shouldContinue()) onMessage(text.savedRefreshFailed, 'error')
        throw error
      }
    } }
  }
  const refreshTextValues = async (isCurrent: () => boolean) => {
    const shouldContinue = () => mounted.current && fieldSourceSessionRef.current === fieldSourceSession && isCurrent()
    if (!shouldContinue()) return false
    return await onRefresh(currentSource.id, undefined, shouldContinue)
  }

  const updateLinkedDocument = async (record: DatabaseRecord, documentId: string | null) => {
    await run(async () => {
      await window.knowbook.updateDatabaseEntity({ entityId: record.id, documentId })
      await refresh(activeViewId)
    })
  }

  const refreshAfterRecordSave = async () => {
    if (currentSourceIdRef.current !== currentSource.id) return
    try {
      await refresh(activeViewId)
    } catch {
      // The mutation already succeeded; retrying creation would duplicate it.
      onMessage(text.savedRefreshFailed, 'error')
    }
  }

  const createRecord = async (recordDraft: { title: string; documentId: string; fieldValues: Record<string, DocumentDatabaseFieldValue> }) => {
    return run(async () => {
      await window.knowbook.createDatabaseEntity({
        databaseId: currentSource.id,
        title: recordDraft.title,
        documentId: recordDraft.documentId || undefined,
        fieldValues: recordDraft.fieldValues
      })
      await refreshAfterRecordSave()
    })
  }

  const saveRecord = async (record: DatabaseRecord, recordDraft: { title: string; documentId: string; fieldValues: Record<string, DocumentDatabaseFieldValue> }) => {
    return run(async () => {
      await window.knowbook.updateDatabaseEntity({
        entityId: record.id,
        title: recordDraft.title,
        documentId: recordDraft.documentId || null,
        fieldValues: recordDraft.fieldValues
      })
      await refreshAfterRecordSave()
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
      if (nextValue !== undefined) {
        const result = await updateValue(record, field, nextValue)
        if (result && result.status === 'saved' && result.refresh) {
          try { await result.refresh(() => true) }
          catch { /* The write succeeded; the refresh callback already reports its failure. */ }
        }
      }
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
    const session = confirmSession
    const owner = confirmOwner.current
    const ownsConfirmation = () => mounted.current && confirmSessionRef.current === session
      && fieldSourceSessionRef.current === owner.source && viewSessionRef.current === owner.view
    if (!ownsConfirmation()) return
    const deleted: DatabaseDeletion = target.kind === 'records'
      ? { kind: 'records', ids: [...target.ids], databaseId: currentSource.id }
      : { kind: target.kind, id: target.id, databaseId: currentSource.id }
    if (target.kind === 'database') await window.knowbook.deleteDatabase(target.id)
    else if (target.kind === 'view') await window.knowbook.deleteDatabaseSavedView(target.id)
    else if (target.kind === 'field') await window.knowbook.deleteDocumentDatabaseColumn(target.id)
    else if (target.kind === 'record') await window.knowbook.deleteDatabaseEntity(target.id)
    else await window.knowbook.deleteDatabaseEntities({ entityIds: target.ids })
    const owned = ownsConfirmation()
    const fallback = sources.find(source => source.kind === 'document-catalog' && source.id !== currentSource.id)
      ?? sources.find(source => source.id !== currentSource.id)
    let completedView = owner.view
    if (owned) {
      if (target.kind === 'view' && target.id === activeViewId) {
        selectView(savedViews.find(view => view.id !== target.id)?.id ?? '')
        completedView = viewSessionRef.current
      }
      if (target.kind === 'field') setFieldDrawerOpen(false)
      if (target.kind === 'record' || target.kind === 'records') {
        const ids = new Set(target.kind === 'records' ? target.ids : [target.id])
        if (openRecordId && ids.has(openRecordId)) setOpenRecordId(null)
        if (!onDeleted) onSelectedRecordIdsChange(selectedRecordIds.filter(id => !ids.has(id)))
      }
      closeConfirm(session)
    }
    try {
      if (onDeleted) await onDeleted(deleted)
      else if (owned) {
        if (target.kind === 'database' && fallback) switchSource(fallback.id)
        await onRefresh(target.kind === 'database' ? fallback?.id : currentSource.id)
      }
    } catch {
      const expectedSource = target.kind === 'database' ? fallback?.id : owner.source.id
      if (owned && mounted.current && confirmSessionRef.current === session + 1
        && currentSourceIdRef.current === expectedSource && (target.kind === 'database' || viewSessionRef.current === completedView)) {
        onMessage(text.deletedRefreshFailed, 'error')
      }
    }
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
  const hasSearchOrFilters = draft.query.trim().length > 0 || draft.filters.rules.length > 0
  const clearSearchAndFilters = () => {
    updateDraft((current) => ({ ...current, query: '', filters: { operator: 'and', rules: [] } }))
    document.querySelector<HTMLInputElement>('.dbw-main-search input')?.focus()
  }
  return (
    <section className="dbw-shell" data-testid="database-grid">
      <DatabaseHeader
        currentSource={currentSource}
        onCreateDatabase={(returnTarget) => openDatabaseForm('create-database', returnTarget)}
        onCreateRecord={createDocumentOrRecord}
        onDeleteDatabase={() => openConfirm({ kind: 'database', id: currentSource.id, name: currentSource.name })}
        onEditDatabase={(returnTarget) => openDatabaseForm('edit-database', returnTarget)}
        onRefresh={refreshDatabase}
        onSourceChange={switchSource}
        refreshing={refreshingSource === fieldSourceSession}
        sources={sources}
        text={text}
      />
      <DatabaseViewTabs
        activeViewId={activeViewId}
        dirty={dirty}
        newViewTriggerRef={newViewTriggerRef}
        onCreateView={(layout, returnTarget) => openViewForm('create-view', layout, undefined, returnTarget)}
        onDeleteView={(view) => {
          if (savedViews.length <= 1) { onMessage(locale.startsWith('zh') ? '数据库至少需要保留一个视图。' : 'A database must keep at least one view.'); return }
          openConfirm({ kind: 'view', id: view.id, name: view.name })
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
        onRenameView={(view, returnTarget) => openViewForm('rename-view', view.config.layout, view, returnTarget)}
        onSelectView={selectView}
        savedViews={savedViews}
        text={text}
      />
      <DatabaseViewToolbar
        config={draft}
        dirty={dirty}
        saving={savingViews.has(viewSaveKey)}
        fields={fields}
        onChange={updateDraft}
        onOpenFields={() => setFieldDrawerOpen(true)}
        onReset={() => replaceDraft(baseConfig)}
        onSave={() => void saveView()}
        onSaveAs={(returnTarget) => openViewForm('create-view', draft.layout, undefined, returnTarget)}
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
          {currentSource.kind === 'custom' ? <button className="dbw-danger-text" onClick={() => openConfirm({ kind: 'records', ids: selectedRecordIds, name: text.selected(selectedRecordIds.length) })} type="button">{text.deleteRecord}</button> : null}
        </div>
      ) : null}

      <main className={`dbw-canvas dbw-canvas-${draft.layout}`}>
        {empty ? (
          <div className="dbw-empty-state">
            <span aria-hidden="true">{hasSearchOrFilters ? '⌕' : '▦'}</span>
            <h3>{hasSearchOrFilters ? text.noMatchingRecords : text.noRecords}</h3>
            <p>{hasSearchOrFilters ? text.noMatchingRecordsHint : text.noRecordsHint}</p>
            {hasSearchOrFilters ? (
              <button className="dbw-primary-button" onClick={clearSearchAndFilters} type="button">{text.clearSearchAndFilters}</button>
            ) : (
              <button className="dbw-primary-button" onClick={createDocumentOrRecord} type="button">＋ {currentSource.kind === 'document-catalog' ? text.newDocument : text.newRecord}</button>
            )}
          </div>
        ) : null}
        {!empty && draft.layout === 'table' ? (
          <DatabaseTableView columnWidths={draft.columnWidths} documents={catalogDocuments} fields={visibleFields} locale={locale} onColumnWidthChange={(fieldId, width) => updateDraft((current) => ({ ...current, columnWidths: { ...current.columnWidths, [fieldId]: Math.round(width) } }))} onOpenDocument={onOpenDocument} onOpenRecord={(record) => setOpenRecordId(record.id)} onSelect={(id, selected) => onSelectedRecordIdsChange(selected ? [...selectedRecordIds, id] : selectedRecordIds.filter((candidate) => candidate !== id))} onUpdateDocument={updateLinkedDocument} onUpdateValue={(record, field, value) => updateValue(record, field, value, true)} onRefreshValue={refreshTextValues} textDraftCache={cellDrafts} records={filteredRecords} selectedIds={selectedIdSet} sourceKind={currentSource.kind} text={text} />
        ) : null}
        {!empty && draft.layout === 'board' ? <DatabaseBoardView field={boardField} groups={boardGroups} onMoveRecord={moveBoardRecord} onOpenDocument={onOpenDocument} onOpenRecord={(record) => setOpenRecordId(record.id)} sourceKind={currentSource.kind} text={text} /> : null}
        {!empty && draft.layout === 'cards' ? <DatabaseCardView fields={draft.cardFieldIds.length > 0 ? visibleFields.filter((field) => draft.cardFieldIds.includes(field.id) || field.role === 'title') : visibleFields} locale={locale} onOpenDocument={onOpenDocument} onOpenRecord={(record) => setOpenRecordId(record.id)} onSelect={(id, selected) => onSelectedRecordIdsChange(selected ? [...selectedRecordIds, id] : selectedRecordIds.filter((candidate) => candidate !== id))} records={filteredRecords} selectedIds={selectedIdSet} sourceKind={currentSource.kind} text={text} /> : null}
      </main>

      <DatabaseFieldDrawer
        key={`fields-${currentSource.id}`}
        sourceSessionKey={currentSource.id}
        fieldOrder={draft.fieldOrder}
        fields={fields}
        onClose={() => setFieldDrawerOpen(false)}
        onCreateField={async (name, type, options) => {
          return runFieldMutation(() => window.knowbook.createDocumentDatabaseColumn({ databaseId: currentSource.id, name, type, options }), (created) => {
            const createdId = created.id
            updateDraft((current) => ({
              ...current,
              visibleFieldIds: [...current.visibleFieldIds, createdId],
              fieldOrder: [...current.fieldOrder, createdId],
              cardFieldIds: [...current.cardFieldIds, createdId].slice(0, 4)
            }))
          })
        }}
        onDeleteField={(field) => openConfirm({ kind: 'field', id: field.id, name: field.name })}
        onMoveField={moveField}
        onMoveDatabaseField={(fieldId, direction) => runFieldMutation(() => window.knowbook.moveDocumentDatabaseColumn({ columnId: fieldId, direction }))}
        onRenameField={(fieldId, name) => runFieldMutation(() => window.knowbook.renameDocumentDatabaseColumn({ columnId: fieldId, name }))}
        onToggleField={toggleField}
        onUpdateOptions={(fieldId, options) => runFieldMutation(() => window.knowbook.updateDocumentDatabaseColumnOptions({ columnId: fieldId, options }))}
        open={fieldDrawerOpen}
        text={text}
        visibleFieldIds={draft.visibleFieldIds}
      />
      <CreateRecordDialog documents={catalogDocuments} fields={visibleFields} key={`create-${currentSource.id}`} onCancel={() => setCreateRecordOpen(false)} onCreate={createRecord} open={createRecordOpen} text={text} />
      <DatabaseRecordDrawer documents={catalogDocuments} fields={fields} key={`record-${currentSource.id}`} onClose={() => setOpenRecordId(null)} onDelete={(record) => openConfirm({ kind: 'record', id: record.id, name: record.title })} onOpenDocument={onOpenDocument} onSave={saveRecord} open={Boolean(openRecord)} record={openRecord} text={text} />
      <DatabaseFormDialog blocked={!pendingForms.has(formSession) && (formMode === 'rename-view'
          ? savingViews.has(JSON.stringify([currentSource.id, formViewId])) : formMode === 'edit-database' && savingDatabases.has(currentSource.id))}
        blockedMessage={formMode === 'edit-database' ? text.databaseEditWaitsForSave : undefined}
        busy={pendingForms.has(formSession)} description={formDescription} error={formError} key={formSession} name={formName}
        nameError={formNameIssue === 'name-taken' ? text.viewNameTaken : formNameIssue === 'name-required' ? text.viewNameRequired : null}
        canReturnFocus={() => Boolean(formFocusLease?.approved && mounted.current
          && fieldSourceSessionRef.current === formFocusLease.source && viewSessionRef.current === formFocusLease.closedView
          && formSessionRef.current === formFocusLease.session + 1)}
        returnFocusTarget={formFocusLease?.target}
        onCancel={() => closeForm(formSession)}
        onDescriptionChange={(value) => { if (formSessionRef.current === formSession && !formRequests.current.has(formSession)) setFormDescription(value) }}
        onNameChange={(value) => {
          if (formSessionRef.current !== formSession || formRequests.current.has(formSession)) return
          if (value !== formName && formNameIssue) {
            setFormNameIssue(null)
            setFormError(null)
          }
          setFormName(value)
        }}
        onSubmit={() => void submitForm()} open={formMode !== null} pendingLabel={formMode === 'create-view' || formMode === 'create-database' ? text.creating : text.saving}
        submitLabel={formMode === 'create-database' || formMode === 'create-view' ? text.create : text.save} text={text}
        title={formMode === 'create-database' ? text.newDatabase : formMode === 'edit-database' ? text.editDatabase : formMode === 'rename-view' ? text.rename : text.newView}
        withDescription={formMode === 'create-database' || formMode === 'edit-database'} />
      <DatabaseConfirmDialog body={confirmTarget ? `“${confirmTarget.name}”` : ''} confirmLabel={confirmTarget?.kind === 'database' ? text.deleteDatabase : confirmTarget?.kind === 'field' ? text.deleteField : confirmTarget?.kind === 'view' ? text.deleteView : text.deleteRecord}
        key={`confirm-${confirmSession}`} returnFocus={confirmOwner.current.returnFocus}
        canReturnFocus={() => mounted.current && fieldSourceSessionRef.current === confirmOwner.current.source
          && confirmSessionRef.current === confirmSession + 1}
        onCancel={() => closeConfirm(confirmSession)} onConfirm={handleConfirm} open={Boolean(confirmTarget)} text={text} title={confirmTarget?.kind === 'database' ? text.deleteDatabase : confirmTarget?.kind === 'field' ? text.deleteField : confirmTarget?.kind === 'view' ? text.deleteView : text.deleteRecord} />
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
