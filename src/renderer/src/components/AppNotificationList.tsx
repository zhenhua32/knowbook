import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { AppNotificationAction } from '@shared/app-notification'
import { appNotifications, type AppNotification } from '../app-notifications'
import { getErrorMessage } from '../utils/errorMessage'
import './app-notifications.css'

type NotificationProps = {
  isZh: boolean
  onDismiss: (id: number) => void
  onOpenDocument: (documentId: string) => void
  historyMode?: boolean
  onActionComplete?: () => void
}

const compactNotificationQuery = '(max-width:900px), (max-height:700px)'

export default function AppNotificationList({ notifications, history, open, onClose, onOpenCenter, returnFocusRef, ...props }: NotificationProps & {
  notifications: readonly AppNotification[]
  history: readonly AppNotification[]
  open: boolean
  onClose: () => void
  onOpenCenter?: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  const listRef = useRef<HTMLElement>(null)
  const resizeFocusOwner = useRef<HTMLElement | null>(null)
  const newestId = notifications.at(-1)?.id
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(compactNotificationQuery).matches)
  const [summaryHovered, setSummaryHovered] = useState(false)
  const [summaryFocused, setSummaryFocused] = useState(false)
  const liveIds = new Set(notifications.map((item) => item.id))
  // Updates reorder history, while a running task keeps its original toast slot.
  const latest = [...history].reverse().find((item) => liveIds.has(item.id)) ?? notifications.at(-1)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(compactNotificationQuery)
    const update = () => {
      const list = listRef.current
      if (list && list.classList.contains('is-compact') !== media.matches) {
        const active = document.activeElement as HTMLElement | null
        resizeFocusOwner.current = active && list.contains(active) ? active : null
      }
      setCompact(media.matches)
    }
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!compact) { setSummaryHovered(false); setSummaryFocused(false) }
  }, [compact])
  useLayoutEffect(() => {
    const previous = resizeFocusOwner.current
    resizeFocusOwner.current = null
    if (!previous || open || !listRef.current) return
    const active = document.activeElement
    if (active !== previous && active !== document.body) return
    // Resizing hides the old control. Move only focus owned by this list.
    const target = compact ? listRef.current.querySelector<HTMLButtonElement>('.app-notification-summary-open') : returnFocusRef?.current
    target?.focus({ preventScroll: true })
  }, [compact, open, returnFocusRef])
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const rootStyle = document.documentElement.style
    const property = '--kb-notification-clearance'
    const previousValue = rootStyle.getPropertyValue(property)
    const previousPriority = rootStyle.getPropertyPriority(property)
    let active = true
    const updateClearance = () => {
      if (!active) return
      const bounds = list.getBoundingClientRect()
      const clearance = list.isConnected && notifications.length > 0 && bounds.height > 0
        ? Math.max(0, Math.ceil(window.innerHeight - bounds.top + 12)) : 0
      rootStyle.setProperty(property, `${clearance}px`)
    }
    updateClearance()
    const observer = typeof window.ResizeObserver === 'undefined' ? null : new window.ResizeObserver(updateClearance)
    observer?.observe(list)
    window.addEventListener('resize', updateClearance)
    return () => {
      active = false
      observer?.disconnect()
      window.removeEventListener('resize', updateClearance)
      if (previousValue) rootStyle.setProperty(property, previousValue, previousPriority)
      else rootStyle.removeProperty(property)
    }
  }, [open, notifications, history, compact])
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [newestId])
  return createPortal(
    <>
    {!open && <section ref={listRef} className={`app-notifications${compact ? ' is-compact' : ''}`} aria-label={props.isZh ? '应用内通知' : 'Notifications'}>
      {compact && latest && <NotificationSummary notification={latest} count={notifications.length} isZh={props.isZh} onOpenCenter={onOpenCenter}
        onMouseEnter={() => setSummaryHovered(true)} onMouseLeave={() => setSummaryHovered(false)}
        onFocus={() => setSummaryFocused(true)} onBlur={() => setSummaryFocused(false)} />}
      {notifications.map((notification) => <NotificationCard key={notification.id} notification={notification} {...props}
        pausedExternally={compact && notification.id === latest?.id && (summaryHovered || summaryFocused)} />)}
    </section>}
    {open && <NotificationCenter history={history} onClose={onClose} returnFocusRef={returnFocusRef} {...props} />}
    </>, document.body)
}

function NotificationSummary({ notification, count, isZh, onOpenCenter, onMouseEnter, onMouseLeave, onFocus, onBlur }: {
  notification: AppNotification
  count: number
  isZh: boolean
  onOpenCenter?: () => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  onFocus: () => void
  onBlur: () => void
}) {
  const level = notification.level ?? 'info'
  const running = level === 'progress'
  const message = running ? notification.progressLabel || notification.message || (Number.isFinite(notification.progress)
    ? `${Math.round(Math.max(0, Math.min(100, notification.progress!)))}%` : isZh ? '任务进行中…' : 'Task in progress…') : notification.message
  return <article className={`app-notification-summary app-notification-${level}`} data-testid="notification-summary" data-notification-id={notification.id}
    onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onFocusCapture={onFocus}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onBlur() }}>
    <span className="app-notification-icon" aria-hidden="true">{running ? '↻' : level === 'success' ? '✓' : level === 'error' || level === 'warning' ? '!' : 'i'}</span>
    <div className="app-notification-body" role={level === 'error' ? 'alert' : 'status'} aria-atomic="true">
      <strong className="app-notification-title">{notification.title}</strong>
      {message && <p className="app-notification-message">{message}</p>}
    </div>
    <button type="button" className="app-notification-summary-open" onClick={onOpenCenter}
      aria-label={isZh ? `查看 ${count} 条通知` : `View ${count} notification${count === 1 ? '' : 's'}`}>
      {isZh ? `查看通知 (${count})` : `View all (${count})`}
    </button>
  </article>
}

function NotificationCenter({ history, onClose, returnFocusRef, ...props }: NotificationProps & {
  history: readonly AppNotification[]
  onClose: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement as HTMLElement | null
    dialog.showModal()
    return () => {
      dialog.close()
      if (previous?.isConnected && previous !== document.body && previous !== document.documentElement) previous.focus({ preventScroll: true })
      else returnFocusRef?.current?.focus({ preventScroll: true })
    }
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

function NotificationCard({ notification, isZh, onDismiss, onOpenDocument, historyMode, onActionComplete, pausedExternally }: NotificationProps & { notification: AppNotification; pausedExternally?: boolean }) {
  const actionLock = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [hovered, setHovered] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const paused = hovered || focusWithin
  const level = notification.level ?? 'info'
  const running = level === 'progress'
  const persistent = running || level === 'error' || notification.persistent || Boolean(notification.actions?.length)
  useEffect(() => {
    if (historyMode || persistent || paused || pausedExternally) return
    const timer = setTimeout(() => onDismiss(notification.id), 6_000)
    return () => clearTimeout(timer)
  }, [notification, onDismiss, paused, pausedExternally, persistent, historyMode])

  const runAction = async (action: AppNotificationAction) => {
    if (actionLock.current || action.disabled) return
    actionLock.current = true
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
      setError(getErrorMessage(cause, isZh ? '操作失败，请重试。' : 'Action failed. Please retry.'))
    } finally {
      actionLock.current = false
      setBusy(false)
    }
  }

  return <article className={`app-notification app-notification-${level}`} data-notification-id={notification.id}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocusWithin(true)} onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false)
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
