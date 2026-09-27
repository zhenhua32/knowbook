import { useEffect, useState } from 'react'
import { formatAttachmentSize, type ManagedAttachment } from '@shared/attachments'
import { getActiveUiText } from '../i18n'
import './attachments.css'

export function AttachmentCard({ url, label }: { url: string; label: string }) {
  const [info, setInfo] = useState<ManagedAttachment | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const zh = getActiveUiText().language === 'zh-CN'
  useEffect(() => {
    let cancelled = false
    setInfo(null); setError('')
    void window.knowbook.getAttachment(url).then(value => { if (!cancelled) setInfo(value) }, () => {
      if (!cancelled) setError(zh ? '附件已丢失或不在工作区内，可尝试从备份恢复。' : 'Attachment missing or outside the workspace. Try restoring a backup.')
    })
    return () => { cancelled = true }
  }, [url, zh])
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await action() } catch (error) { setError(String(error)) } finally { setBusy(false) }
  }
  return <div className="attachment-card" aria-busy={busy}>
    <div className="attachment-card-description"><strong>{label || info?.name || url.split('/').at(-1)}</strong>
      <small>{info ? `${info.name} · ${formatAttachmentSize(info.size)}` : zh ? '本地附件' : 'Local attachment'}</small></div>
    <div className="attachment-card-actions">
      {info?.kind === 'image' && <button type="button" className="secondary-button" disabled={busy}
        onClick={() => { void import('./AttachmentPreview').then(module => module.showImagePreview(url, label || info.name)) }}>{zh ? '预览' : 'Preview'}</button>}
      <button type="button" className="secondary-button" disabled={!info || busy} onClick={() => { void run(() => window.knowbook.openExternalUrl(url)) }}>{zh ? '打开' : 'Open'}</button>
      <button type="button" className="secondary-button" disabled={!info || busy} onClick={() => { void run(() => window.knowbook.saveAttachment(url)) }}>{zh ? '另存为' : 'Save as'}</button>
      <button type="button" className="secondary-button" disabled={!info || busy} onClick={() => { void run(() => window.knowbook.revealAttachment(url)) }}>{zh ? '在文件夹中显示' : 'Show in folder'}</button>
    </div>
    {error && <p className="attachment-error" role="alert">{error}</p>}
  </div>
}
