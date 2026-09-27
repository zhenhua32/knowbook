import { useEffect, useId, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getActiveUiText } from '../i18n'
import { toBlockRichMediaPreviewUrl } from '../utils/blockRichMedia'
import './attachments.css'

export function showImagePreview(url: string, name: string): void {
  if (document.querySelector('.attachment-image-dialog')) return
  const previous = document.activeElement as HTMLElement | null, container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  root.render(<ImagePreview url={url} name={name} onClose={() => {
    root.unmount(); container.remove(); if (previous?.isConnected) previous.focus({ preventScroll: true })
  }} />)
}

function ImagePreview({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const zh = getActiveUiText().language === 'zh-CN', dialog = useRef<HTMLDialogElement>(null), titleId = useId()
  const [zoom, setZoom] = useState<number | null>(null), [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const local = url.startsWith('file:')
  useEffect(() => { dialog.current?.showModal() }, [])
  const save = async () => {
    setBusy(true); setError('')
    try { await window.knowbook.saveAttachment(url) } catch (error) { setError(String(error)) } finally { setBusy(false) }
  }
  return <dialog data-block-shortcuts ref={dialog} className="attachment-image-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id={titleId}>{name || (zh ? '图片预览' : 'Image preview')}</h2><button type="button" className="secondary-button" onClick={onClose}>{zh ? '关闭' : 'Close'}</button></header>
    <div className="attachment-image-tools">
      <button type="button" className="secondary-button" disabled={failed} onClick={() => setZoom(value => Math.max(.25, (value ?? 1) - .25))}>{zh ? '缩小' : 'Zoom out'}</button>
      <button type="button" className="secondary-button" disabled={failed} onClick={() => setZoom(null)}>{zh ? '适应窗口' : 'Fit to window'}</button>
      <button type="button" className="secondary-button" disabled={failed} onClick={() => setZoom(1)}>{zh ? '原始大小' : 'Actual size'}</button>
      <button type="button" className="secondary-button" disabled={failed} onClick={() => setZoom(value => Math.min(4, (value ?? 1) + .25))}>{zh ? '放大' : 'Zoom in'}</button>
      <span role="status">{zoom === null ? (zh ? '自适应' : 'Fit') : `${Math.round(zoom * 100)}%`}{size ? ` · ${size.width} × ${size.height}` : ''}</span>
      {local && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void save() }}>{zh ? '另存为' : 'Save as'}</button>}
    </div>
    <div className={`attachment-image-stage${zoom === null ? ' is-fit' : ''}`}>
      {failed ? <p role="alert">{zh ? '无法显示图片，文件可能已丢失或损坏。' : 'Cannot display this image. The file may be missing or damaged.'}</p> : <img alt={name} src={toBlockRichMediaPreviewUrl(url)}
        onError={() => setFailed(true)} onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        style={zoom !== null && size ? { width: size.width * zoom, maxWidth: 'none', maxHeight: 'none' } : undefined} />}
    </div>
    {error && <p className="attachment-error" role="alert">{error}</p>}
  </dialog>
}
