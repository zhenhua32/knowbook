import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppNotificationAction } from '@shared/app-notification'
import type { AppNotification } from '../app-notifications'
import './app-notifications.css'

type NotificationProps = {
  isZh: boolean
  onDismiss: (id: number) => void
  onOpenDocument: (documentId: string) => void
}

export default function AppNotificationList({ notifications, ...props }: NotificationProps & {
  notifications: readonly AppNotification[]
}) {
  const listRef = useRef<HTMLElement>(null)
  const newestId = notifications.at(-1)?.id
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [newestId])
  return createPortal(
    <section ref={listRef} className="app-notifications" aria-label={props.isZh ? '应用内通知' : 'Notifications'}>
      {notifications.map((notification) => <NotificationCard key={notification.id} notification={notification} {...props} />)}
    </section>, document.body)
}

function NotificationCard({ notification, isZh, onDismiss, onOpenDocument }: NotificationProps & { notification: AppNotification }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [paused, setPaused] = useState(false)
  const level = notification.level ?? 'info'
  const running = level === 'progress'
  const persistent = running || level === 'error' || notification.persistent || Boolean(notification.actions?.length)
  useEffect(() => {
    if (persistent || paused) return
    const timer = setTimeout(() => onDismiss(notification.id), 6_000)
    return () => clearTimeout(timer)
  }, [notification, onDismiss, paused, persistent])

  const runAction = async (action: AppNotificationAction) => {
    if (busy || action.disabled) return
    setBusy(true)
    setError('')
    try {
      if ('documentId' in action) {
        const document = await window.knowbook.getDocumentDetail(action.documentId)
        if (!document) throw new Error(isZh ? '文档已被删除或无法打开。' : 'This document no longer exists.')
        onOpenDocument(action.documentId)
      } else await action.run()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (isZh ? '操作失败，请重试。' : 'Action failed. Please retry.'))
    } finally {
      setBusy(false)
    }
  }

  return <article className={`app-notification app-notification-${level}`} data-notification-id={notification.id}
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocusCapture={() => setPaused(true)} onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false)
    }}>
    <span className="app-notification-icon" aria-hidden="true">{running ? '↻' : level === 'success' ? '✓' : level === 'error' || level === 'warning' ? '!' : 'i'}</span>
    <div className="app-notification-body">
      <div role={level === 'error' ? 'alert' : 'status'} aria-atomic="true">
        <strong className="app-notification-title">{notification.title}</strong>
        {notification.message && <p className="app-notification-message">{notification.message}</p>}
      </div>
      {running && <div className="app-notification-meter">
        <progress max={100} value={Number.isFinite(notification.progress) ? Math.max(0, Math.min(100, notification.progress!)) : undefined}
          aria-label={notification.progressLabel || (isZh ? '任务进度' : 'Task progress')} />
        {notification.progressLabel && <span>{notification.progressLabel}</span>}
      </div>}
      {notification.actions?.length ? <div className="app-notification-actions">
        {notification.actions.map((action, index) => <button key={index} type="button" disabled={busy || action.disabled}
          onClick={() => { void runAction(action) }}>{action.label}</button>)}
      </div> : null}
      {error && <p className="app-notification-action-error" role="alert">{error}</p>}
    </div>
    {!running && <button className="app-notification-close" type="button" onClick={() => onDismiss(notification.id)}
      aria-label={isZh ? '关闭通知' : 'Dismiss notification'} title={isZh ? '关闭通知' : 'Dismiss notification'}>×</button>}
  </article>
}
