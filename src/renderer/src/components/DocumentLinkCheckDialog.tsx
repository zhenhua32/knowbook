import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DocumentLinkCheck, DocumentLinkIssueReason } from '@shared/contracts'
import './document-link-check.css'

const labels: Record<DocumentLinkIssueReason, [string, string]> = {
  'missing-document': ['找不到文档', 'Document not found'],
  'missing-heading': ['找不到章节', 'Heading not found'],
  'missing-block': ['找不到引用块', 'Block not found'],
  'missing-attachment': ['附件已丢失或无法读取', 'Attachment missing or unreadable'],
  'unmanaged-attachment': ['附件未导入工作区', 'Attachment is outside the workspace'],
  'invalid-path': ['路径无效', 'Invalid path'],
  'ambiguous-reference': ['存在同名文档，请使用完整路径', 'Ambiguous title; use a full document path']
}

export default function DocumentLinkCheckDialog({ documentId, isZh, onFlush, onClose, onLocate }: {
  documentId: string
  isZh: boolean
  onFlush: () => Promise<boolean>
  onClose: () => void
  onLocate: (blockId: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const labelId = useId()
  const [report, setReport] = useState<DocumentLinkCheck | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [revision, setRevision] = useState(0)
  const flush = useRef(onFlush)
  flush.current = onFlush
  useEffect(() => {
    const returnFocus = document.querySelector<HTMLElement>('.document-header-more-button')
    dialog.current?.showModal()
    return () => { returnFocus?.focus() }
  }, [])
  useEffect(() => {
    let active = true
    setBusy(true); setError(''); setReport(null)
    void (async () => {
      try {
        if (!await flush.current()) throw new Error(isZh ? '保存失败，请重试；草稿仍保留。' : 'Save failed. Retry; your draft is preserved.')
        if (!active) return
        const result = await window.knowbook.checkDocumentLinks(documentId)
        if (active) setReport(result)
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : String(failure))
      } finally { if (active) setBusy(false) }
    })()
    return () => { active = false }
  }, [documentId, revision, isZh])
  return createPortal(<dialog ref={dialog} className="document-link-check" aria-labelledby={labelId}
    onCancel={(event) => { event.preventDefault(); onClose() }} onKeyDown={(event) => event.stopPropagation()}>
    <header><h3 id={labelId}>{isZh ? '检查链接' : 'Check links'}</h3>
      <button type="button" className="secondary-button" onClick={onClose}>{isZh ? '关闭' : 'Close'}</button></header>
    {busy && <p role="status">{isZh ? '正在保存并检查本地链接…' : 'Saving and checking local links…'}</p>}
    {error && <p role="alert">{error}</p>}
    {report && <>
      <p role="status">{isZh ? `已检查 ${report.checkedCount} 个本地目标，发现 ${report.issues.length} 处问题。` : `Checked ${report.checkedCount} local targets; found ${report.issues.length} issues.`}</p>
      {report.issues.length === 0 && <p>{isZh ? '本地文档、章节、块引用和附件均可找到。' : 'Local documents, headings, block references and attachments are available.'}</p>}
      <ul>{report.issues.map((issue, index) => <li key={`${issue.blockId}:${issue.offset}:${index}`}>
        <button type="button" className="secondary-button" onClick={() => { onClose(); onLocate(issue.blockId) }}>
          <strong>{labels[issue.reason][isZh ? 0 : 1]}</strong><code>{issue.url}</code>
          <span>{isZh ? '定位到来源块' : 'Go to source block'}</span>
        </button>
      </li>)}</ul>
      <p className="mini-hint">{isZh ? `检查范围：当前完整文档。外部网址未联网检查（${report.ignoredExternalCount} 个）。` : `Scope: the complete current document. External URLs were not fetched (${report.ignoredExternalCount}).`}</p>
    </>}
    <footer><button type="button" className="secondary-button" disabled={busy} onClick={() => setRevision((value) => value + 1)}>{isZh ? '重新检查' : 'Check again'}</button></footer>
  </dialog>, document.body)
}
