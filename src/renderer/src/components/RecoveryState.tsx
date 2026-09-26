import { useRef, useState } from 'react'
import { getActiveUiText } from '../i18n'
import { getErrorMessage } from '../utils/errorMessage'

export type RecoveryStateProps = {
  title: string
  description?: string
  error?: unknown
  onRetry?: () => void | Promise<void>
  onNavigate?: () => void
  navigateLabel?: string
  busy?: boolean
  compact?: boolean
  allowRestart?: boolean
}

export function RecoveryState({ title, description, error, onRetry, onNavigate, navigateLabel, busy, compact, allowRestart }: RecoveryStateProps) {
  const isZh = getActiveUiText().language === 'zh-CN'
  const [actionError, setActionError] = useState('')
  const [copied, setCopied] = useState(false)
  const [running, setRunning] = useState(false)
  const lock = useRef(false)
  const detail = error instanceof Error ? (error.stack || error.message) : typeof error === 'string' ? error : ''
  const run = async (action: () => void | Promise<void>) => {
    if (lock.current || busy) return
    lock.current = true
    setRunning(true)
    setActionError('')
    try { await action() } catch (cause) {
      setActionError(getErrorMessage(cause, isZh ? '操作失败，请重试。' : 'Action failed. Please retry.'))
    } finally { lock.current = false; setRunning(false) }
  }
  const restart = (safe: boolean) => {
    if (!window.confirm(isZh
      ? `${safe ? '将重启应用，并在本次启动中跳过系统插件。' : '将重新加载界面。'}未保存的内容可能丢失，是否继续？`
      : `${safe ? 'Restart the app without system plugins for this boot?' : 'Reload the interface?'} Unsaved changes may be lost.`)) return
    return safe ? window.knowbook.restartInSystemPluginSafeMode() : window.location.reload()
  }
  return <section className={`recovery-state${compact ? ' recovery-state-compact' : ''}`} aria-label={title} aria-busy={busy || running}>
    <div role="alert"><h2>{title}</h2>{description && <p>{description}</p>}</div>
    <div className="recovery-actions">
      {onRetry && <button type="button" className="primary-button" disabled={busy || running} onClick={() => { void run(onRetry) }}>
        {busy || running ? (isZh ? '正在处理…' : 'Working…') : (isZh ? '重试' : 'Retry')}</button>}
      {onNavigate && <button type="button" className="secondary-button" onClick={onNavigate}>{navigateLabel || (isZh ? '返回总览' : 'Go to dashboard')}</button>}
      {allowRestart && <button type="button" className="secondary-button" disabled={running} onClick={() => { void run(() => restart(false)) }}>
        {isZh ? '重新加载界面' : 'Reload interface'}</button>}
      {allowRestart && typeof window !== 'undefined' && typeof window.knowbook?.restartInSystemPluginSafeMode === 'function' && <button type="button" className="secondary-button" disabled={running}
        onClick={() => { void run(() => restart(true)) }}>{isZh ? '安全模式重启' : 'Restart in safe mode'}</button>}
    </div>
    {detail && <details className="recovery-details"><summary>{isZh ? '诊断信息' : 'Diagnostic details'}</summary><pre>{detail}</pre>
      <button type="button" className="secondary-button" disabled={running} onClick={() => { void run(async () => {
        const text = `KnowBook — ${title}\n${new Date().toISOString()}\n${detail}`
        if (window.knowbook?.writeClipboardText) await window.knowbook.writeClipboardText(text)
        else await navigator.clipboard.writeText(text)
        setCopied(true)
      }) }}>{copied ? (isZh ? '已复制' : 'Copied') : (isZh ? '复制诊断信息' : 'Copy diagnostics')}</button>
    </details>}
    {actionError && <p role="alert">{actionError}</p>}
  </section>
}
