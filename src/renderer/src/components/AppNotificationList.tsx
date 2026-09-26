import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppNotificationAction } from '@shared/app-notification'
import { appNotifications, type AppNotification } from '../app-notifications'
import './app-notifications.css'

type NotificationProps = {
  isZh: boolean
  onDismiss: (id: number) => void
  onOpenDocument: (documentId: string) => void
  historyMode?: boolean
  onActionComplete?: () => void
}

export default function AppNotificationList({ notifications, history, open, onClose, ...props }: NotificationProps & {
  notifications: readonly AppNotification[]
  history: readonly AppNotification[]
  open: boolean
  onClose: () => void
}) {
  const listRef = useRef<HTMLElement>(null)
  const newestId = notifications.at(-1)?.id
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [newestId])
  return createPortal(
    <>
    {!open && <section ref={listRef} className="app-notifications" aria-label={props.isZh ? '应用内通知' : 'Notifications'}>
      {notifications.map((notification) => <NotificationCard key={notification.id} notification={notification} {...props} />)}
    </section>}
    {open && <NotificationCenter history={history} onClose={onClose} {...props} />}
    </>, document.body)
}

function NotificationCenter({ history, onClose, ...props }: NotificationProps & {
  history: readonly AppNotification[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement as HTMLElement | null
    dialog.showModal()
    return () => { dialog.close(); previous?.focus() }
  }, [])
  useEffect(() => { appNotifications.markAllRead() }, [history])
  const running = history.filter((item) => item.level === 'progress').length
  return <dialog ref={ref} className="notification-center" aria-labelledby="notification-center-title" onCancel={onClose}
    onKeyDown={(event) => event.stopPropagation()}
    onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="notification-center-content">
      <header className="notification-center-header">
        <div><h2 id="notification-center-title">{props.isZh ? '通知中心' : 'Notification center'}</h2>
          <p>{running > 0 ? (props.isZh ? `${running} 个任务进行中 · ` : `${running} running · `) : ''}
            {props.isZh ? '最近 100 条记录，保存在本机' : 'Last 100 notifications, saved on this device'}</p></div>
        <button type="button" className="app-notification-close" autoFocus onClick={onClose}
          aria-label={props.isZh ? '关闭通知中心' : 'Close notification center'}>×</button>
      </header>
      <div className="notification-center-toolbar">
        <span>{props.isZh ? `共 ${history.length} 条` : `${history.length} notification${history.length === 1 ? '' : 's'}`}</span>
        <button type="button" className="secondary-button" disabled={!history.some((item) => item.level !== 'progress')}
          onClick={appNotifications.clearCompleted}>{props.isZh ? '清除已结束通知' : 'Clear completed'}</button>
      </div>
      <div className="notification-center-list">
        {history.length === 0 && <p className="notification-center-empty">{props.isZh ? '暂无通知。操作结果和任务进度会显示在这里。' : 'No notifications yet. Results and task progress will appear here.'}</p>}
        {[...history].reverse().map((notification) => <NotificationCard key={notification.id} notification={notification} {...props}
          historyMode onActionComplete={onClose} onOpenDocument={(id) => { onClose(); props.onOpenDocument(id) }} />)}
      </div>
    </div>
  </dialog>
}

function NotificationCard({ notification, isZh, onDismiss, onOpenDocument, historyMode, onActionComplete }: NotificationProps & { notification: AppNotification }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [paused, setPaused] = useState(false)
  const level = notification.level ?? 'info'
  const running = level === 'progress'
  const persistent = running || level === 'error' || notification.persistent || Boolean(notification.actions?.length)
  useEffect(() => {
    if (historyMode || persistent || paused) return
    const timer = setTimeout(() => onDismiss(notification.id), 6_000)
    return () => clearTimeout(timer)
  }, [notification, onDismiss, paused, persistent, historyMode])

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
      if (action.closeNotificationCenter) onActionComplete?.()
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
      <div role={historyMode ? undefined : level === 'error' ? 'alert' : 'status'} aria-atomic="true">
        <strong className="app-notification-title">{notification.title}</strong>
        {notification.message && <p className="app-notification-message">{notification.message}</p>}
      </div>
      {historyMode && <time className="notification-time" dateTime={new Date(notification.updatedAt).toISOString()}>
        {new Date(notification.updatedAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}</time>}
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
    {!historyMode && <button className="app-notification-close" type="button" onClick={() => onDismiss(notification.id)}
      aria-label={isZh ? '关闭通知' : 'Dismiss notification'}
      title={running ? (isZh ? '收起提示，任务继续运行' : 'Hide notification; the task continues') : (isZh ? '关闭通知' : 'Dismiss notification')}>×</button>}
  </article>
}
