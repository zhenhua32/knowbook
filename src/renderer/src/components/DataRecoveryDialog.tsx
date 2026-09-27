import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DocumentDetail, UpdateDocumentInput } from '@shared/contracts'
import type { BackupVersion, DocumentRecoveryEntry } from '@shared/document-recovery'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import { showConfirmation } from './showConfirmation'
import { getErrorMessage } from '../utils/errorMessage'
import { notify } from '../notify'
import './data-recovery.css'

export type DataRecoveryTarget = { kind: 'trash' } | { kind: 'backups' } | { kind: 'history'; documentId: string }
type Entry = DocumentRecoveryEntry | BackupVersion

export default function DataRecoveryDialog({ target, isZh: zh, onClose, beforeRestore, onRestored }: {
  target: DataRecoveryTarget
  isZh: boolean
  onClose: () => void
  beforeRestore: () => Promise<boolean>
  onRestored: (documentId?: string) => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false), titleId = useId()
  const [entries, setEntries] = useState<Entry[]>([]), [selectedId, setSelectedId] = useState('')
  const [content, setContent] = useState<UpdateDocumentInput | null>(null)
  const [current, setCurrent] = useState<DocumentDetail | null>(null)
  const [query, setQuery] = useState(''), [error, setError] = useState('')
  const [loading, setLoading] = useState(true), [previewLoading, setPreviewLoading] = useState(false)
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  const title = target.kind === 'trash' ? (zh ? '回收站' : 'Trash') : target.kind === 'history'
    ? (zh ? '文档历史' : 'Document history') : (zh ? '备份版本' : 'Backup versions')
  const selected = entries.find((entry) => entry.id === selectedId)
  const visible = entries.filter((entry) => `${'title' in entry ? `${entry.title} ${entry.path}` : ''} ${entry.createdAt}`.toLowerCase().includes(query.toLowerCase()))
  const markdown = useMemo(() => content ? serializeBlocksToMarkdown(content.blocks) : '', [content])
  const currentMarkdown = useMemo(() => current ? serializeBlocksToMarkdown(current.blocks) : '', [current])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, element = dialog.current!
    element.showModal()
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    void (async () => {
      if (!await beforeRestore()) throw new Error(zh ? '请先解决文档保存错误。' : 'Resolve the document save error first.')
      const items = target.kind === 'trash' ? await window.knowbook.listTrashedDocuments()
        : target.kind === 'backups' ? await window.knowbook.listBackupVersions()
        : await window.knowbook.listDocumentHistory(target.documentId)
      const detail = target.kind === 'history' ? await window.knowbook.getDocumentDetail(target.documentId) : null
      if (active) { setEntries(items); setCurrent(detail); setSelectedId(items[0]?.id ?? '') }
    })().catch((e) => { if (active) setError(getErrorMessage(e, zh ? '读取失败，请重试。' : 'Could not load records. Retry.')) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [target, revision])
  useEffect(() => {
    let active = true
    setContent(null)
    if (!selectedId || target.kind === 'backups') { setPreviewLoading(false); return }
    setPreviewLoading(true)
    const request = target.kind === 'trash' ? window.knowbook.getTrashedDocument(selectedId)
      : window.knowbook.getDocumentHistory(target.documentId, selectedId).then((version) => version.content)
    void request.then((value) => { if (active) setContent(value) })
      .catch((e) => { if (active) setError(getErrorMessage(e, zh ? '预览失败，请重试。' : 'Could not load preview. Retry.')) })
      .finally(() => { if (active) setPreviewLoading(false) })
    return () => { active = false }
  }, [selectedId, target, revision])

  const mutate = async (purge = false) => {
    if (lock.current || !selected) return
    lock.current = true; setBusy(true); setError('')
    try {
      const action = async () => {
        if (purge) { await window.knowbook.purgeTrashedDocument(selected.id); return }
        if (!await beforeRestore()) throw new Error(zh ? '请先解决文档保存错误。' : 'Resolve the document save error first.')
        let documentId: string | undefined
        if (target.kind === 'trash') documentId = await window.knowbook.restoreTrashedDocument(selected.id)
        else if (target.kind === 'history') {
          if (!current) throw new Error(zh ? '当前文档不存在。' : 'The current document is missing.')
          await window.knowbook.restoreDocumentHistory(target.documentId, selected.id, current.updatedAt)
          documentId = target.documentId
        } else {
          const result = await window.knowbook.restoreBackupVersion(selected.id)
          if (!result) return false
        }
        try { await onRestored(documentId) }
        catch { notify(zh ? '数据已恢复，但界面刷新失败。请重新打开文档。' : 'Data restored. Reopen the document to refresh the view.', 'warning') }
        notify(zh ? '恢复完成。' : 'Restored successfully.', 'success')
        return true
      }
      if (target.kind === 'backups') {
        if (await action()) onClose()
      } else {
        const accepted = await showConfirmation({
          title: purge ? (zh ? '永久删除' : 'Delete permanently') : (zh ? '恢复文档' : 'Restore document'),
          description: purge
            ? (zh ? '这会删除回收站中的文档及其历史，无法撤销。已有备份版本会保留。' : 'This removes the trash copy and its history. Existing backup versions are kept. This cannot be undone.')
            : target.kind === 'history'
              ? (zh ? '用所选版本恢复标题、摘要和正文？恢复前会保存当前版本，目录和数据库字段保持原样。' : 'Restore the selected title, summary and content? The current version will be saved first. Location and database fields stay as they are.')
              : (zh ? '恢复到原目录；原目录不存在时放到根目录，重名时自动调整名称。已上移的子文档保持当前位置。' : 'Restore to the original folder, or the root if it is missing. Conflicting names are adjusted. Previously reparented children stay where they are.'),
          tone: purge ? 'danger' : 'warning', onConfirm: async () => { await action() }
        }, document.activeElement as HTMLElement)
        if (accepted) { if (purge) setRevision((value) => value + 1); else onClose() }
      }
    } catch (e) { setError(getErrorMessage(e, zh ? '恢复失败，请重试。' : 'Recovery failed. Retry.')) }
    finally { lock.current = false; setBusy(false) }
  }

  return createPortal(<dialog className="data-recovery-dialog" ref={dialog} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); if (!lock.current) onClose() }} onKeyDown={(event) => event.stopPropagation()}>
    <header><h2 id={titleId}>{title}</h2><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{zh ? '关闭' : 'Close'}</button></header>
    <p className="recovery-policy">{target.kind === 'trash'
      ? (zh ? '删除的文档不会自动清空。选择文档可预览、恢复或永久删除。' : 'Trash is kept until you delete it permanently. Select a document to preview or restore it.')
      : target.kind === 'history'
        ? (zh ? '自动保存修改前的检查点，连续编辑每 5 分钟最多一份，保留最近 100 份；恢复和删除前额外保存。' : 'Checkpoints preserve content before changes, at most once per 5 minutes of editing. The latest 100 are kept, with extra checkpoints before restores and deletion.')
        : (zh ? '保留最近 10 份，并额外保留近 30 天每天一份（按 UTC 日期）。恢复前会预检并创建数据库安全副本。' : 'Keeps the latest 10 snapshots, plus one per UTC day for the last 30 days. Restores are previewed and a database safety copy is created first.')}</p>
    {error && <div role="alert">{error} <button type="button" disabled={busy} onClick={() => setRevision((value) => value + 1)}>{zh ? '重新加载' : 'Reload'}</button></div>}
    {loading ? <p role="status">{zh ? '正在加载…' : 'Loading…'}</p> : entries.length === 0 ? <p>{zh ? '暂无记录。' : 'No records yet.'}</p> : <div className="recovery-layout">
      <aside><input className="editor-input" aria-label={zh ? '筛选恢复记录' : 'Filter recovery records'} placeholder={zh ? '搜索标题、路径或日期' : 'Search title, path or date'} value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} />
        <ul>{visible.map((entry) => <li key={entry.id}><button type="button" aria-pressed={entry.id === selectedId} disabled={busy} onClick={() => { setError(''); setSelectedId(entry.id) }}>
          <strong>{'title' in entry ? entry.title : entry.current ? (zh ? '最新备份' : 'Latest backup') : (zh ? '历史备份' : 'Earlier backup')}</strong>
          <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString(zh ? 'zh-CN' : 'en-US')}</time>
          {'path' in entry && <small>{entry.path}</small>}
          {'documentCount' in entry && entry.documentCount !== null && <small>{entry.documentCount} {zh ? '篇文档' : 'documents'}</small>}
          {'reason' in entry && target.kind === 'history' && <small>{entry.reason === 'restore' ? (zh ? '恢复前' : 'Before restore') : entry.reason === 'delete' ? (zh ? '删除前' : 'Before deletion') : (zh ? '修改前' : 'Before edit')}</small>}
        </button></li>)}</ul>{visible.length === 0 && <p>{zh ? '没有匹配记录。' : 'No matching records.'}</p>}</aside>
      <section className="recovery-preview">{previewLoading ? <p role="status">{zh ? '正在读取预览…' : 'Loading preview…'}</p> : content ? <div className={`recovery-comparison${current ? ' has-current' : ''}`}>
        <article><h3>{zh ? '所选版本' : 'Selected version'}</h3><h4>{content.title}</h4><p>{content.summary}</p><pre>{markdown}</pre></article>
        {current && <article><h3>{zh ? '当前版本' : 'Current version'}</h3><h4>{current.title}</h4><p>{current.summary}</p><pre>{currentMarkdown}</pre></article>}
      </div> : target.kind === 'backups' && selected ? <p>{zh ? '选择“恢复所选备份”后，将显示创建、更新和删除数量，确认后才会恢复。备份包含当时的文档、附件及数据库；文档历史和回收站保存在本机 SQLite 中。' : 'Restore selected backup shows a preview of creations, updates and deletions before confirmation. Snapshots include documents, attachments and databases. History and Trash live in the local SQLite database.'}</p> : null}</section>
    </div>}
    <footer>{target.kind === 'trash' && <button className="secondary-button" type="button" disabled={busy || loading || !selected} onClick={() => void mutate(true)}>{zh ? '永久删除' : 'Delete permanently'}</button>}
      <button className="primary-button" type="button" disabled={busy || loading || previewLoading || !selected || (target.kind !== 'backups' && !content)} onClick={() => void mutate()}>
        {busy ? (zh ? '正在处理…' : 'Working…') : target.kind === 'backups' ? (zh ? '恢复所选备份' : 'Restore selected backup') : (zh ? '恢复所选版本' : 'Restore selected version')}
      </button></footer>
  </dialog>, document.body)
}
