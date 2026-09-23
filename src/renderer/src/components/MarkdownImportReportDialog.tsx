import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MarkdownImportIssueReason, MarkdownImportReport } from '@shared/contracts'
import './document-link-check.css'

const labels: Record<MarkdownImportIssueReason, [string, string]> = {
  'missing-document': ['找不到文档', 'Document not found'],
  'missing-heading': ['找不到章节或锚点', 'Heading or anchor not found'],
  'missing-block': ['找不到引用块', 'Referenced block not found'],
  'missing-attachment': ['找不到附件，已保留原链接', 'Attachment missing; original link preserved'],
  'unmanaged-attachment': ['附件未收纳到工作区', 'Attachment was not copied into the workspace'],
  'outside-import-root': ['附件位于所选目录之外，已保留原链接', 'Attachment is outside the selected folder; original link preserved'],
  'invalid-path': ['链接路径无效', 'Invalid link path'],
  'ambiguous-reference': ['同名文档无法确定，请使用完整路径', 'Ambiguous document title; use a full path'],
  'unsupported-html': ['HTML 未完整支持，已保留源码', 'HTML is not fully supported; source preserved'],
  'html-attributes': ['部分 HTML 属性仅保留在源码中', 'Some HTML attributes are preserved only in source'],
  'wiki-syntax': ['嵌入或别名语法未支持，已保留源码', 'Embed or alias syntax is unsupported; source preserved']
}

function readableSource(source: string): string {
  if (source.startsWith('<') || source.includes('[[')) return source
  try { return decodeURI(source) } catch { return source }
}

export default function MarkdownImportReportDialog({ report, isZh, onClose, onLocate }: {
  report: MarkdownImportReport
  isZh: boolean
  onClose: () => void
  onLocate: (documentId: string, blockId?: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId()
  const [onlyIssues, setOnlyIssues] = useState(false), [query, setQuery] = useState(''), [limit, setLimit] = useState(25)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  const files = report.files.filter((file) => (!onlyIssues || file.issues.length + file.omittedIssueCount > 0)
    && `${file.sourcePath}\n${file.documentPath}`.toLowerCase().includes(query.trim().toLowerCase()))
  return createPortal(<dialog ref={dialog} className="document-link-check" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose() }} onKeyDown={(event) => event.stopPropagation()}>
    <header><h3 id={titleId}>{isZh ? 'Markdown 导入报告' : 'Markdown import report'}</h3>
      <button type="button" className="secondary-button" onClick={onClose}>{isZh ? '关闭' : 'Close'}</button></header>
    <p role="status">{isZh ? `已导入 ${report.files.length} 个文档，发现 ${report.issueCount} 项需检查的内容。`
      : `Imported ${report.files.length} documents; ${report.issueCount} items need review.`}</p>
    <p className="mini-hint">{isZh ? `结果来自本次导入时的检查。外部网址未联网检查（${report.ignoredExternalCount} 个）。`
      : `Results reflect this import. External URLs were not fetched (${report.ignoredExternalCount}).`}</p>
    <p><label>{isZh ? '查找文件 ' : 'Find a file '}<input className="editor-input" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(25) }} /></label></p>
    <p><label><input type="checkbox" checked={onlyIssues} onChange={(event) => { setOnlyIssues(event.target.checked); setLimit(25) }} />
      {isZh ? '只显示需检查的文件' : 'Only files needing review'}</label></p>
    <ul>{files.slice(0, limit).map((file) => <li key={file.documentId}>
      <details>
        <summary><strong>{file.sourcePath}</strong> — {file.status === 'created' ? (isZh ? '已新建' : 'Created') : (isZh ? '已更新' : 'Updated')}
          {file.issues.length + file.omittedIssueCount > 0 ? (isZh ? ` · ${file.issues.length + file.omittedIssueCount} 项需检查` : ` · ${file.issues.length + file.omittedIssueCount} items`) : (isZh ? ' · 未发现问题' : ' · No issues found')}</summary>
        <p>{isZh ? '导入到：' : 'Imported to: '}{file.documentPath}</p>
        <button type="button" className="secondary-button" onClick={() => { onClose(); onLocate(file.documentId) }}>{isZh ? '打开文档' : 'Open document'}</button>
        <ul>{file.issues.map((issue, index) => <li key={`${issue.blockId}:${issue.offset}:${index}`}>
          <button type="button" className="secondary-button" onClick={() => { onClose(); onLocate(file.documentId, issue.blockId) }}>
            <strong>{labels[issue.reason][isZh ? 0 : 1]}</strong><code>{readableSource(issue.source)}</code>
            <span>{isZh ? '定位到来源块' : 'Go to source block'}</span>
          </button>
        </li>)}</ul>
        {file.omittedIssueCount > 0 && <p>{isZh ? `另有 ${file.omittedIssueCount} 项未列出。打开文档检查其余源码，并使用“检查链接”查看链接问题。`
          : `${file.omittedIssueCount} more items are not listed. Open the document to review its source and use Check links for link issues.`}</p>}
      </details>
    </li>)}</ul>
    {files.length === 0 && <p>{isZh ? '没有符合条件的文件。' : 'No matching files.'}</p>}
    {files.length > limit && <button type="button" className="secondary-button" onClick={() => setLimit((value) => value + 25)}>{isZh ? '显示更多文件' : 'Show more files'}</button>}
  </dialog>, document.body)
}
