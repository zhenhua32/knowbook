import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { collectDatabaseViewFieldIds, parseDatabaseViewPayload, serializeDatabaseViewPayload, type DatabaseViewBlockPayloadV1 } from '@shared/databaseViewBlock'
import { DATABASE_SYSTEM_FIELD_IDS } from '@shared/database-workspace'
import { DatabaseWorkspace } from './DatabaseWorkspace'
import { useDatabaseEmbedContext, type DatabaseEmbedContextValue } from './DatabaseEmbedContext'
import { useDatabaseEmbedSnapshot } from './hooks/useDatabaseEmbedSnapshot'
import { databaseEmbedSnapshots } from './model/databaseEmbedSnapshots'
import { defaultDatabaseEmbedPayload } from './model/databaseEmbedDefaults'
import { DatabaseTextDraftCache } from './model/databaseTextDrafts'
import { DatabaseMultiSelectCellCache } from './model/databaseMultiSelectCells'
import './database-workspace.css'
import './inline-database-view.css'

export type InlineDatabaseViewProps = { blockId: string; content: string; mode: 'edit' | 'reading';
  onCommitContent?: (expectedContent: string, nextContent: string) => boolean }
type HostState = { databaseId: string; viewId: string | null; generation: object; text: DatabaseTextDraftCache; multi: DatabaseMultiSelectCellCache; selected: string[] }
type HostRegistry = { active: HostState | null; mode: InlineDatabaseViewProps['mode'] | null; sources: Map<string, HostState> }
type Publication = { revision: number; isCurrent: () => boolean; confirm: () => void; resolve: (accepted: boolean) => void }

export function InlineDatabaseView(props: InlineDatabaseViewProps) {
  const context = useDatabaseEmbedContext()
  const parsed = useMemo(() => {
    try { return { payload: parseDatabaseViewPayload(props.content) } }
    catch (error) { return { error: error instanceof Error ? error.message : 'Invalid database view.' } }
  }, [props.content])
  if (!context) return <p role="status">Database view is waiting for its document.</p>
  if (!parsed.payload) return <div className="inline-database-view-error" role="alert">{parsed.error}</div>
  return <DatabaseEmbedHost {...props} payload={parsed.payload} context={context} />
}
export default InlineDatabaseView

function DatabaseEmbedHost(props: InlineDatabaseViewProps & { payload: DatabaseViewBlockPayloadV1; context: DatabaseEmbedContextValue }) {
  const { context, payload } = props
  let registry = context.registry.get(props.blockId) as HostRegistry | undefined
  if (!registry) { registry = { active: null, mode: null, sources: new Map() }; context.registry.set(props.blockId, registry) }
  let host = registry.sources.get(payload.databaseId)
  if (!host) {
    host = { databaseId: payload.databaseId, viewId: payload.viewId, generation: {}, text: new DatabaseTextDraftCache(), multi: new DatabaseMultiSelectCellCache(), selected: [] }
    registry.sources.set(payload.databaseId, host)
  }
  if (registry.active !== host || registry.mode !== props.mode || host.viewId !== payload.viewId) { host.viewId = payload.viewId; host.generation = {}; host.selected = [] }
  registry.active = host; registry.mode = props.mode
  const currentHost = host
  const generation = currentHost.generation
  const state = useDatabaseEmbedSnapshot(payload.databaseId)
  const [, pulse] = useState(0)
  const mounted = useRef(false), publications = useRef(new Set<Publication>())
  const latest = useRef({ props, host: currentHost }); latest.current = { props, host: currentHost }
  const isCurrent = () => mounted.current && latest.current.props.context.session === context.session
    && latest.current.host === currentHost && latest.current.host.generation === generation
    && latest.current.props.payload.databaseId === payload.databaseId && latest.current.props.payload.viewId === payload.viewId
  useLayoutEffect(() => { mounted.current = true; return () => {
    mounted.current = false
    for (const publication of publications.current) publication.resolve(false)
    publications.current.clear()
  } }, [])
  useLayoutEffect(() => {
    for (const publication of publications.current) {
      if (!publication.isCurrent()) { publication.resolve(false); publications.current.delete(publication) }
      else if (state.status === 'ready' && state.revision >= publication.revision) {
        publication.confirm(); publication.resolve(true); publications.current.delete(publication)
      }
    }
  })
  const commit = (next: DatabaseViewBlockPayloadV1) => {
    if (!isCurrent() || props.mode !== 'edit' || latest.current.props.content !== props.content) return false
    let content: string
    try { content = serializeDatabaseViewPayload(next) }
    catch (error) { context.onMessage(error instanceof Error ? error.message : String(error), 'error'); return false }
    if (content === props.content) return true
    return props.onCommitContent ? props.onCommitContent(props.content, content)
      : context.commitContent(props.blockId, props.content, content)
  }
  const chooseSource = () => {
    if (props.mode !== 'edit') return
    context.openPicker({ isCurrent: () => isCurrent() && latest.current.props.content === props.content,
      onSelect: commit })
  }
  const refresh = async (id?: string, _view?: string, shouldContinue?: () => boolean): Promise<boolean> => {
    const allowed = () => isCurrent() && shouldContinue?.() !== false
    if (id && id !== payload.databaseId || !allowed()) return false
    const text = currentHost.text.captureSavedRefresh(payload.databaseId)
    const multi = currentHost.multi.captureSavedRefresh(payload.databaseId)
    await databaseEmbedSnapshots.invalidate(payload.databaseId)
    if (!allowed()) return false
    const revision = databaseEmbedSnapshots.state(payload.databaseId).revision
    return await new Promise<boolean>(resolve => {
      publications.current.add({ revision, isCurrent: allowed, resolve,
        confirm: () => { currentHost.text.confirmSavedRefresh(text); currentHost.multi.confirmSavedRefresh(multi) } })
      pulse(value => value + 1)
    })
  }
  const snapshot = state.snapshot
  const zh = context.isZh
  const wrapper = { 'data-editor-island': 'database-view', 'data-database-source-id': payload.databaseId,
    className: 'inline-database-view', contentEditable: false as const }
  if (!snapshot) return <section {...wrapper} aria-busy={state.status === 'pending'}>
    <p role={state.status === 'error' ? 'alert' : 'status'}>{state.error ?? (zh ? '正在加载数据库…' : 'Loading database…')}</p>
    {state.status === 'error' && <button type="button" onClick={() => void refresh().catch(error => context.onMessage(String(error), 'error'))}>{zh ? '重试' : 'Retry'}</button>}
  </section>
  if (snapshot.status === 'missing') return <section {...wrapper}>
    <p role="alert">{zh ? '来源数据库已不存在。' : 'The source database no longer exists.'}</p>
    {props.mode === 'edit' ? <button type="button" onClick={chooseSource}>{zh ? '选择来源' : 'Choose source'}</button>
      : <button type="button" onClick={context.onEnterEditing}>{zh ? '进入编辑模式' : 'Enter editing mode'}</button>}
  </section>
  const system = DATABASE_SYSTEM_FIELD_IDS
  const sourceFields = snapshot.database.kind === 'document-catalog'
    ? [system.title, system.path, system.parent, system.blockCount, system.linkCount, system.childCount, system.updatedAt]
    : [system.title, system.document, system.createdAt, system.updatedAt]
  const knownFields = new Set<string>([...sourceFields, ...snapshot.columns.map(column => column.id)])
  const missingFields = [...collectDatabaseViewFieldIds(payload)].filter(id => !knownFields.has(id))
  const missingView = payload.viewId !== null && !snapshot.savedViews.some(view => view.id === payload.viewId)
  const readOnly = props.mode === 'reading' || missingView || state.status === 'error'
  return <section {...wrapper} aria-label={zh ? '文内数据库视图' : 'Inline database view'}>
    {props.mode === 'reading' && <button type="button" className="inline-database-edit" onClick={context.onEnterEditing}>{zh ? '进入编辑模式' : 'Enter editing mode'}</button>}
    {state.status === 'error' && <p role="alert">{state.error}<button type="button" onClick={() => void refresh().catch(() => {})}>{zh ? '重试' : 'Retry'}</button></p>}
    {missingView && <p role="alert">{zh ? '来源视图已失效，保留当前配置。' : 'The source view is unavailable. Its local configuration is preserved.'}
      {props.mode === 'edit' && <button type="button" onClick={() => commit({ ...payload, viewId: null })}>{zh ? '使用本地视图' : 'Use local view'}</button>}</p>}
    {missingFields.length > 0 ? <div role="alert"><p>{zh ? '视图引用了已删除的字段；不会扩大显示范围。' : 'This view refers to missing fields. Its results are unavailable.'}</p>
      {props.mode === 'edit' && <button type="button" onClick={() => commit(defaultDatabaseEmbedPayload(snapshot))}>{zh ? '重设本地视图' : 'Reset local view'}</button>}</div>
      : <DatabaseWorkspace key={payload.databaseId} activeViewId={missingView ? '' : payload.viewId ?? ''}
        currentDatabaseId={payload.databaseId} databases={[snapshot.database]} catalogColumns={snapshot.columns}
        selectedColumns={snapshot.columns} catalogDocuments={snapshot.catalogDocuments} entities={snapshot.entities}
        savedViews={snapshot.savedViews} locale={context.locale} onMessage={context.onMessage} onOpenDocument={(id, shouldContinue) => {
          const allowed = () => isCurrent() && shouldContinue?.() !== false
          if (allowed()) context.onOpenDocument(id, allowed)
        }}
        selectedRecordIds={currentHost.selected} onSelectedRecordIdsChange={ids => { if (isCurrent()) { currentHost.selected = ids; pulse(value => value + 1) } }}
        onActiveViewIdChange={id => {
          const view = snapshot.savedViews.find(candidate => candidate.id === id)
          if (view) commit({ ...payload, viewId: view.id, config: structuredClone(view.config) })
          else if (!id) commit({ ...payload, viewId: null })
        }} onCurrentDatabaseIdChange={chooseSource} onRefresh={refresh}
        textDraftCache={currentHost.text} multiSelectCache={currentHost.multi}
        embedded={{ config: payload.config, onChange: config => { commit({ ...payload, config }) }, readOnly,
          session: currentHost.generation, onChooseSource: chooseSource }} />}
  </section>
}
