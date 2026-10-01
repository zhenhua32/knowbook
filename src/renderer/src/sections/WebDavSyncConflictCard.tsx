import { useEffect, useId, useRef, useState } from 'react'
import type { ResolveWebDavSyncConflict, WebDavSyncConflict, WebDavSyncConflictDetails, WebDavSyncMergeChoice, WebDavSyncMergePart } from '@shared/webdav-sync'
import type { UpdateDocumentInput } from '@shared/contracts'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import { getErrorMessage } from '../utils/errorMessage'
import './webdav-sync.css'

function fieldLabel(part: Pick<WebDavSyncMergePart, 'field' | 'blockId'> & { property?: string }, isZh: boolean, blockIndex: number): string {
  switch (part.field) {
    case 'title': return isZh ? '标题' : 'Title'
    case 'summary': return isZh ? '摘要' : 'Summary'
    case 'parentId': return isZh ? '所在目录' : 'Folder'
    case 'sortOrder': return isZh ? '文档顺序' : 'Document order'
    case 'blocks': return isZh ? '正文块结构与顺序' : 'Block structure and order'
    case 'block-content': return isZh ? `正文块 ${blockIndex}` : `Block ${blockIndex}`
    case 'block-property': {
      const properties: Record<string, [string, string]> = {
        type: ['类型', 'type'], checked: ['任务完成状态', 'task completion'], tags: ['标签', 'tags'], language: ['代码语言', 'code language'],
        listStart: ['编号起点', 'starting number'], markdownFormat: ['格式', 'format'], highlight: ['高亮', 'highlight'],
        depth: ['嵌套层级', 'nesting depth'], parentBlockId: ['父级块', 'parent block']
      }
      const property = properties[part.property ?? '']?.[isZh ? 0 : 1] ?? (isZh ? '属性' : 'properties')
      return isZh ? `正文块 ${blockIndex} · ${property}` : `Block ${blockIndex} · ${property}`
    }
  }
}

export default function WebDavSyncConflictCard({ conflict, isZh, disabled, onResolve }: {
  conflict: WebDavSyncConflict
  isZh: boolean
  disabled: boolean
  onResolve: (input: ResolveWebDavSyncConflict) => Promise<boolean>
}) {
  const [details, setDetails] = useState<WebDavSyncConflictDetails | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [merging, setMerging] = useState(false), [choices, setChoices] = useState<Record<string, WebDavSyncMergeChoice>>({})
  const [composing, setComposing] = useState(false)
  const [result, setResult] = useState<UpdateDocumentInput | null>(null), [previewLoading, setPreviewLoading] = useState(false)
  const request = useRef(0), previewRequest = useRef(0), mounted = useRef(false), lock = useRef(false)
  const resolution = useRef(conflict.resolution)
  resolution.current = conflict.resolution
  const prefix = useId(), t = (zh: string, en: string) => isZh ? zh : en
  const version = { key: conflict.key, localHash: conflict.localHash, remoteHash: conflict.remoteHash }
  const parts = details?.merge?.conflicts ?? []
  const completed = parts.filter(part => choices[part.id]).length
  const reasons: Record<WebDavSyncConflict['reason'], string> = {
    overlap: t('两端修改了同一处内容；其他独立改动会保留在合并结果中。', 'Both devices changed the same content. Independent changes will be kept in the merge.'),
    'no-base': t('没有可用的共同版本，请对比两端内容后选择。', 'There is no common version available. Compare both versions before choosing.'),
    'delete-edit': t('一端删除了文档，另一端修改了文档。', 'One device deleted the document while the other edited it.'),
    database: t('数据库、字段、视图和记录需要作为整体选择。', 'Choose one version of the databases, fields, views and records as a whole.')
  }
  const resolutionLabels = {
    local: t('本地版本', 'Local version'), remote: t('远端版本', 'Remote version'),
    both: t('两份都保留', 'Keep both'), merge: t('逐项合并', 'Merge changes')
  }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current++; previewRequest.current++ }
  }, [])

  const loadDetails = async () => {
    if (loading || details) return
    const id = ++request.current
    const resolutionAtRequest = conflict.resolution
    setLoading(true); setError('')
    try {
      const value = await window.knowbook.getWebDavSyncConflictDetails(version)
      if (!mounted.current || id !== request.current) return
      if (value.key !== version.key || value.localHash !== version.localHash || value.remoteHash !== version.remoteHash) {
        throw new Error(t('冲突版本已变化，请重新打开冲突。', 'The conflict changed. Reopen it to compare the current versions.'))
      }
      setDetails(value)
      if (value.savedChoices && resolutionAtRequest === 'merge' && resolution.current === 'merge') {
        setChoices(value.savedChoices)
        if (value.merge && value.merge.unresolvedIds.length === 0) setResult(value.merge.document)
      }
    } catch (reason) {
      if (mounted.current && id === request.current) setError(getErrorMessage(reason, t('无法加载完整版本，请重试。', 'Could not load full versions. Retry.')))
    } finally { if (mounted.current && id === request.current) setLoading(false) }
  }
  const resolve = async (input: Omit<ResolveWebDavSyncConflict, keyof typeof version>) => {
    if (disabled || lock.current || composing) return
    lock.current = true
    try {
      if (await onResolve({ ...version, ...input }) && mounted.current) {
        setError('')
        if (input.choice !== 'merge') setMerging(false)
      }
    } finally { lock.current = false }
  }
  const choose = (id: string, value: WebDavSyncMergeChoice) => {
    previewRequest.current++
    setResult(null); setPreviewLoading(false)
    setChoices(current => ({ ...current, [id]: value }))
  }
  const previewMerge = async () => {
    if (disabled || composing || completed !== parts.length || previewLoading) return
    const id = ++previewRequest.current
    setPreviewLoading(true); setError('')
    try {
      const value = await window.knowbook.getWebDavSyncConflictDetails({ ...version, mergeChoices: choices })
      if (!mounted.current || id !== previewRequest.current) return
      if (value.key !== version.key || value.localHash !== version.localHash || value.remoteHash !== version.remoteHash) {
        throw new Error(t('冲突版本已变化，请重新打开冲突。', 'The conflict changed. Reopen it to compare the current versions.'))
      }
      if (!value.merge || value.merge.unresolvedIds.length) throw new Error(t('请先处理全部重叠改动。', 'Resolve every overlapping change before previewing.'))
      setResult(value.merge.document)
    } catch (reason) {
      if (mounted.current && id === previewRequest.current) setError(getErrorMessage(reason, t('无法预览合并结果，请重试。', 'Could not preview the merge. Retry.')))
    } finally { if (mounted.current && id === previewRequest.current) setPreviewLoading(false) }
  }
  const blockIndex = (part: Pick<WebDavSyncMergePart, 'blockId'>) => {
    const index = details?.merge?.document.blocks.findIndex(block => block.id === part.blockId) ?? -1
    return index < 0 ? 1 : index + 1
  }
  const partPreview = (part: WebDavSyncMergePart, value: string) => part.property === 'checked' && ['true', 'false'].includes(value)
    ? value === 'true' ? t('已完成', 'Completed') : t('未完成', 'Incomplete') : value
  const preview = (heading: string, value: string, id: string, deleted = false) => <section className="webdav-conflict-version" aria-labelledby={id}>
    <h5 id={id}>{heading}{deleted ? ` · ${t('已删除', 'Deleted')}` : ''}</h5>
    <pre>{value || t('（空）', '(Empty)')}</pre>
  </section>

  return <details className="webdav-conflict-card" onToggle={event => {
    if (event.target === event.currentTarget && event.currentTarget.open) void loadDetails()
  }}>
    <summary><strong>{conflict.title}</strong>{conflict.resolution ? <span className="webdav-conflict-pending">{t('待同步应用', 'Pending sync')} · {resolutionLabels[conflict.resolution]}</span> : null}</summary>
    <div className="webdav-conflict-body">
      <p>{reasons[conflict.reason]}</p>
      {conflict.mergeFields.length > 0 ? <p className="mini-hint">{t('需要处理：', 'Changes to resolve: ')}{(parts.length ? parts : conflict.mergeFields).map(part => fieldLabel(part, isZh, blockIndex(part))).join(t('、', ', '))}</p> : null}
      {loading ? <p className="mini-hint">{t('正在加载完整版本…', 'Loading full versions…')}</p> : null}
      {error ? <div role="alert">{error} <button className="secondary-button" type="button" disabled={disabled || loading || previewLoading || Boolean(details && (composing || completed !== parts.length))}
        onClick={() => { if (details) void previewMerge(); else void loadDetails() }}>{details ? t('重试预览', 'Retry preview') : t('重新加载', 'Reload')}</button></div> : null}
      <div className="webdav-conflict-comparison">
        {preview(t('本地版本', 'Local version'), details?.localPreview ?? conflict.localPreview, `${prefix}-local`, conflict.localDeleted)}
        {preview(t('远端版本', 'Remote version'), details?.remotePreview ?? conflict.remotePreview, `${prefix}-remote`, conflict.remoteDeleted)}
      </div>
      {!details && (conflict.localPreview.length >= 12_000 || conflict.remotePreview.length >= 12_000) ? <p className="mini-hint">{t('当前显示简略预览；加载后可查看完整版本。', 'This is a shortened preview. Full versions appear after loading.')}</p> : null}
      {details?.basePreview !== null && details?.basePreview !== undefined ? <details className="webdav-conflict-base"><summary>{t('查看共同版本', 'View common version')}</summary><pre>{details.basePreview}</pre></details> : null}
      <div className="settings-actions">
        {conflict.canMerge ? <button className="primary-button" type="button" disabled={disabled || loading} aria-expanded={merging} onClick={() => {
          setMerging(current => !current); void loadDetails()
        }}>{t('逐项合并', 'Merge changes')}</button> : null}
        {conflict.canKeepBoth ? <button className="secondary-button" type="button" disabled={disabled} onClick={() => void resolve({ choice: 'both' })}>{t('两份都保留', 'Keep both')}</button> : null}
        <button className="secondary-button" type="button" disabled={disabled} onClick={() => void resolve({ choice: 'local' })}>{t('使用本地版本', 'Use local version')}</button>
        <button className="secondary-button" type="button" disabled={disabled} onClick={() => void resolve({ choice: 'remote' })}>{t('使用远端版本', 'Use remote version')}</button>
        {conflict.resolution ? <button className="secondary-button" type="button" disabled={disabled} onClick={() => void resolve({ choice: 'clear' })}>{t('取消处理方案', 'Clear resolution')}</button> : null}
      </div>
      {conflict.canKeepBoth ? <p className="mini-hint">{conflict.localDeleted
        ? t('两份都保留会保留原文档的本地删除状态，并在根目录生成远端冲突副本。', 'Keep both retains the local deletion and creates a remote conflict copy in the root folder.')
        : t('两份都保留会在根目录生成本地冲突副本，原文档采用远端版本。', 'Keep both creates a local conflict copy in the root folder and uses the remote version for the original document.')}</p> : null}
      {conflict.resolution ? <p className="webdav-conflict-pending">{t('方案已保存，点击“立即同步”应用。任一版本变化时会重新提示冲突。', 'Resolution saved. Click Sync now to apply it. Changed versions will require a new decision.')}</p> : null}
      {merging && details?.merge ? <div className="webdav-conflict-merge" data-block-shortcuts onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onBlur={() => setComposing(false)}>
        <h5>{t('逐项处理重叠改动', 'Resolve overlapping changes')}</h5>
        <p className="mini-hint">{t('仅需决定以下重叠改动；两端其他独立改动已合并。', 'Decide only the overlapping changes below. Other independent changes from both devices are combined.')}</p>
        {parts.map(part => {
          const label = fieldLabel(part, isZh, blockIndex(part)), choice = choices[part.id]
          return <fieldset key={part.id} data-merge-part={part.id} disabled={disabled}>
            <legend>{label}</legend>
            <div className="webdav-conflict-comparison">
              {preview(t('本地改动', 'Local change'), partPreview(part, part.localPreview), `${prefix}-${part.id}-local`)}
              {preview(t('远端改动', 'Remote change'), partPreview(part, part.remotePreview), `${prefix}-${part.id}-remote`)}
            </div>
            <details className="webdav-conflict-base"><summary>{t('查看修改前内容', 'View original content')}</summary><pre>{partPreview(part, part.basePreview) || t('（空）', '(Empty)')}</pre></details>
            <div className="webdav-conflict-options">
              <label><input type="radio" name={`${prefix}-${part.id}`} checked={choice?.choice === 'local'} onChange={() => choose(part.id, { choice: 'local' })} />{t('保留本地改动', 'Keep local change')}</label>
              <label><input type="radio" name={`${prefix}-${part.id}`} checked={choice?.choice === 'remote'} onChange={() => choose(part.id, { choice: 'remote' })} />{t('保留远端改动', 'Keep remote change')}</label>
              {part.canEditText ? <label><input type="radio" name={`${prefix}-${part.id}`} checked={choice?.choice === 'custom'} onChange={() => choose(part.id, { choice: 'custom', text: choice?.choice === 'custom' ? choice.text : part.localPreview })} />{t('自定义合并内容', 'Custom merged text')}</label> : null}
            </div>
            {choice?.choice === 'custom' ? <label className="editor-label">{t(`${label}合并内容`, `${label} merged content`)}
              {part.field === 'title' ? <input className="editor-input" value={choice.text} onChange={event => choose(part.id, { choice: 'custom', text: event.target.value })} />
                : <textarea className="editor-textarea" rows={5} value={choice.text} onChange={event => choose(part.id, { choice: 'custom', text: event.target.value })} />}
            </label> : null}
          </fieldset>
        })}
        <p className="mini-hint">{t(`已处理 ${completed} / ${parts.length} 项重叠改动`, `${completed} / ${parts.length} overlapping changes resolved`)}</p>
        <div className="settings-actions">
          <button className="secondary-button" type="button" disabled={disabled || composing || completed !== parts.length || previewLoading} onClick={() => void previewMerge()}>{previewLoading ? t('正在生成预览…', 'Preparing preview…') : t('预览合并结果', 'Preview merge result')}</button>
          <button className="primary-button" type="button" disabled={disabled || composing || completed !== parts.length} onClick={() => void resolve({ choice: 'merge', mergeChoices: choices })}>{t('保存合并方案', 'Save merge plan')}</button>
        </div>
        {result ? <section aria-labelledby={`${prefix}-result`}><h5 id={`${prefix}-result`}>{t('合并结果', 'Merge result')}</h5>
          <pre className="webdav-conflict-result">{[result.title, result.summary, serializeBlocksToMarkdown(result.blocks)].filter(Boolean).join('\n\n')}</pre></section> : null}
      </div> : null}
    </div>
  </details>
}
