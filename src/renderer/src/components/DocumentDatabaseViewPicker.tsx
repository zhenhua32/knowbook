import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { DocumentDatabase } from '@shared/contracts'
import { parseDatabaseViewPayload, serializeDatabaseViewPayload, type DatabaseViewBlockPayloadV1 } from '@shared/databaseViewBlock'
import { defaultDatabaseEmbedPayload } from '../features/database/model/databaseEmbedDefaults'
import { databaseEmbedSnapshots } from '../features/database/model/databaseEmbedSnapshots'
import { useDatabaseEmbedSnapshot } from '../features/database/hooks/useDatabaseEmbedSnapshot'
import '../features/database/inline-database-view.css'

export default function DocumentDatabaseViewPicker({ isZh, onSelect, onCancel }: {
  isZh: boolean; onSelect: (payload: DatabaseViewBlockPayloadV1) => boolean; onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement | null>(null), titleId = useId(), sourceLabelId = useId()
  const [sources, setSources] = useState<DocumentDatabase[] | null>(null), [error, setError] = useState<string | null>(null)
  const [sourceId, setSourceId] = useState(''), [retry, setRetry] = useState(0)
  useLayoutEffect(() => { dialog.current?.showModal(); return () => { dialog.current?.close() } }, [])
  useEffect(() => {
    let current = true; setError(null)
    void window.knowbook.getDatabases().then(value => { if (current) setSources(value) })
      .catch(() => { if (current) setError(isZh ? '无法加载数据库，请重试。' : 'Could not load databases. Please retry.') })
    return () => { current = false }
  }, [isZh, retry])
  return <dialog ref={dialog} className="database-view-picker" data-block-shortcuts data-editor-island="database-view"
    aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onCancel() }} onKeyDown={event => event.stopPropagation()}>
    <h2 id={titleId}>{isZh ? '插入数据库视图' : 'Insert database view'}</h2>
    {error ? <p role="alert">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>{isZh ? '重试' : 'Retry'}</button></p>
      : !sources ? <p role="status">{isZh ? '正在加载数据库…' : 'Loading databases…'}</p>
        : <label><span id={sourceLabelId}>{isZh ? '数据库来源' : 'Source database'}</span><select aria-labelledby={sourceLabelId} value={sourceId} onChange={event => setSourceId(event.target.value)}>
          <option value="">{isZh ? '请选择来源' : 'Choose a source'}</option>
          {sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
        </select></label>}
    {sourceId && <DatabaseChoice key={sourceId} id={sourceId} isZh={isZh} onSelect={onSelect} />}
    <footer><button type="button" onClick={onCancel}>{isZh ? '取消' : 'Cancel'}</button></footer>
  </dialog>
}

function DatabaseChoice({ id, isZh, onSelect }: { id: string; isZh: boolean; onSelect: (payload: DatabaseViewBlockPayloadV1) => boolean }) {
  const viewLabelId = useId()
  const state = useDatabaseEmbedSnapshot(id), [viewId, setViewId] = useState(''), [stale, setStale] = useState(false), [configurationError, setConfigurationError] = useState('')
  const snapshot = state.snapshot
  if (state.status === 'error') return <p role="alert">{state.error}<button type="button" onClick={() => void databaseEmbedSnapshots.invalidate(id).catch(() => {})}>{isZh ? '重试' : 'Retry'}</button></p>
  if (!snapshot) return <p role="status">{isZh ? '正在加载来源视图…' : 'Loading source views…'}</p>
  if (snapshot.status === 'missing') return <p role="alert">{isZh ? '该来源已删除，请选择其他来源。' : 'This source was deleted. Choose another source.'}</p>
  const view = viewId ? snapshot.savedViews.find(candidate => candidate.id === viewId) : undefined
  return <>
    <label><span id={viewLabelId}>{isZh ? '来源保存视图' : 'Source saved view'}</span><select aria-labelledby={viewLabelId} value={viewId} onChange={event => { setViewId(event.target.value); setStale(false); setConfigurationError('') }}>
      <option value="">{isZh ? '本地表格视图' : 'Local table view'}</option>
      {snapshot.savedViews.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}
    </select></label>
    {viewId && !view ? <p role="alert">{isZh ? '视图已删除，请重新选择。' : 'This view was deleted. Select another view.'}</p> : null}
    {stale && <p role="alert">{isZh ? '正文已改变，请关闭后重新插入。' : 'The document changed. Close this picker and insert again.'}</p>}
    {configurationError && <p role="alert">{configurationError}</p>}
    <button type="button" disabled={Boolean(viewId && !view)} onClick={() => {
      setConfigurationError(''); setStale(false)
      let payload: DatabaseViewBlockPayloadV1
      try {
        const candidate = view ? { version: 1 as const, databaseId: id, viewId: view.id, config: structuredClone(view.config) }
          : defaultDatabaseEmbedPayload(snapshot)
        payload = parseDatabaseViewPayload(serializeDatabaseViewPayload(candidate))
      } catch {
        setConfigurationError(isZh ? '该来源视图配置无效或过大。请选择其他视图，或使用本地表格视图。'
          : 'This source view configuration is invalid or too large. Choose another view or use the local table view.')
        return
      }
      if (!onSelect(payload)) setStale(true)
    }}>{isZh ? '插入视图' : 'Insert view'}</button>
  </>
}
