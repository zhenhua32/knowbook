import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type MouseEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import { collectMarkdownDestinations } from '@shared/markdownLinks'
import type { DocumentsDomainState } from '../types/appDomains'
import { importAttachmentFiles, insertAttachmentBlocks, type AttachmentInsertion } from '../utils/attachments'
import { AttachmentCard } from '../components/AttachmentCard'
import { notify } from '../notify'
import '../components/attachments.css'

export function useDocumentAttachments(documents: DocumentsDomainState, zh: boolean) {
  const latest = useRef(documents), active = useRef(true), locked = useRef(false), dialogRef = useRef<HTMLDialogElement>(null), titleId = useId()
  latest.current = documents
  const [dialogDocumentId, setDialogDocumentId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [dragging, setDragging] = useState(false)
  const open = Boolean(dialogDocumentId && dialogDocumentId === documents.selectedDocumentId)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => { setDialogDocumentId(null); setError(''); setDragging(false) }, [documents.selectedDocumentId])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.showModal()
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [open])
  const urls = useMemo(() => open ? [...new Set(collectMarkdownDestinations(serializeBlocksToMarkdown(documents.draftBlocks))
    .map(link => link.url).filter(url => url.startsWith('file:')))] : [], [open, documents.draftBlocks])

  const insert = async (files: File[], target?: AttachmentInsertion) => {
    const initial = latest.current, documentId = initial.selectedDocumentId
    if (!documentId || initial.detailLoading || !files.length) return
    if (locked.current) { notify(zh ? '请等待当前附件导入完成。' : 'Wait for the current import to finish.', 'info'); return }
    locked.current = true; setBusy(true); setError('')
    try {
      const attachments = await importAttachmentFiles(files)
      if (!active.current || latest.current.selectedDocumentId !== documentId || latest.current.detailLoading) return
      const editor = latest.current
      const next = insertAttachmentBlocks(editor.getDraftBlocks(), attachments, target)
      editor.checkpointDraft(); editor.clearBlockSelection(); editor.setIsReadingMode(false); editor.setDraftBlocks(next)
      notify(zh ? `已插入 ${attachments.length} 个附件。` : `Inserted ${attachments.length} attachments.`)
    } catch (error) {
      if (active.current) { setError(String(error)); notify(String(error), 'error') }
    } finally {
      locked.current = false
      if (active.current) setBusy(false)
    }
  }
  const insertionAt = (element: Element): AttachmentInsertion | undefined => {
    const row = element.closest<HTMLElement>('[data-block-index]')
    const index = row ? Number(row.dataset.blockIndex) : -1
    const block = latest.current.getDraftBlocks()[index]
    if (!block?.id) return undefined
    const textarea = element instanceof HTMLTextAreaElement ? element : row?.querySelector('textarea')
    return { blockId: block.id, content: block.content, start: textarea?.selectionStart ?? block.content.length, end: textarea?.selectionEnd ?? block.content.length }
  }
  const fileDrag = (event: DragEvent<HTMLDivElement>) => event.dataTransfer.types.includes('Files') && (event.target as Element).closest('.preview-panel')
  const previewInlineImage = (event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof HTMLImageElement) || !target.matches('.markdown-inline-image')) return
    if ('key' in event && event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault(); event.stopPropagation()
    const url = target.src.startsWith('knowbook-asset:') ? new URL(target.src).searchParams.get('source') : target.src
    if (url) void import('../components/AttachmentPreview').then(module => module.showImagePreview(url, target.alt))
  }
  const surfaceProps = {
    className: 'document-attachment-surface',
    onClickCapture: previewInlineImage,
    onKeyDownCapture: previewInlineImage,
    onPasteCapture: (event: ClipboardEvent<HTMLDivElement>) => {
      if (!(event.target as Element).matches('.block-inline-textarea') || !event.clipboardData.files.length) return
      event.preventDefault(); event.stopPropagation()
      void insert(Array.from(event.clipboardData.files), insertionAt(event.target as Element))
    },
    onDragOverCapture: (event: DragEvent<HTMLDivElement>) => {
      if (!fileDrag(event)) return
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setDragging(true)
    },
    onDragLeaveCapture: (event: DragEvent<HTMLDivElement>) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false)
    },
    onDropCapture: (event: DragEvent<HTMLDivElement>) => {
      setDragging(false)
      if (!fileDrag(event)) return
      event.preventDefault(); event.stopPropagation()
      void insert(Array.from(event.dataTransfer.files), insertionAt(event.target as Element))
    }
  }
  const dialog = <>
    {(busy || dragging) && createPortal(<div className="attachment-import-status" role="status">{busy ? (zh ? '正在导入附件…' : 'Importing attachments…') : (zh ? '松开以插入图片或附件' : 'Drop to insert images or attachments')}</div>, document.body)}
    {open && createPortal(<dialog data-block-shortcuts ref={dialogRef} className="attachment-dialog" aria-labelledby={titleId} onKeyDown={event => event.stopPropagation()}
      onCancel={event => { event.preventDefault(); if (!busy) setDialogDocumentId(null) }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
      onDrop={event => { event.preventDefault(); event.stopPropagation(); void insert(Array.from(event.dataTransfer.files)) }}>
      <header><h2 id={titleId}>{zh ? '图片与附件' : 'Images and attachments'}</h2><button type="button" className="secondary-button" disabled={busy} onClick={() => setDialogDocumentId(null)}>{zh ? '关闭' : 'Close'}</button></header>
      <label className="attachment-upload"><strong>{zh ? '选择文件或拖到这里，插入到文档末尾' : 'Choose files or drop here to append to the document'}</strong>
        <input type="file" multiple disabled={busy} aria-label={zh ? '选择图片或附件' : 'Choose images or attachments'} onChange={event => {
          const files = Array.from(event.target.files ?? []); event.target.value = ''; void insert(files)
        }} />
        <span>{zh ? '正文支持拖拽文件、粘贴截图。单个文件最多 25 MB，每次最多 20 个、合计 100 MB。' : 'Drop files or paste screenshots into the body. Up to 25 MB per file, 20 files and 100 MB per import.'}</span>
      </label>
      {error && <p className="attachment-error" role="alert">{error}</p>}
      <p>{zh ? `当前文档引用了 ${urls.length} 个本地附件。删除正文中的引用不会删除文件，历史版本仍可使用。` : `${urls.length} local attachments in this document. Removing a reference keeps the file available to history.`}</p>
      <div className="attachment-list">{urls.map(url => <AttachmentCard key={url} url={url} label="" />)}</div>
    </dialog>, document.body)}
  </>
  return { surfaceProps, dialog, openAttachments: () => { setError(''); setDialogDocumentId(documents.selectedDocumentId) } }
}
