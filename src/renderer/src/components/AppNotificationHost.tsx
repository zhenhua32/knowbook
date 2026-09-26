import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import { appNotifications } from '../app-notifications'

const NotificationList = lazy(() => import('./AppNotificationList'))

export function AppNotificationHost({ isZh, onOpenDocument }: {
  isZh: boolean
  onOpenDocument: (documentId: string) => void
}) {
  const notifications = useSyncExternalStore(appNotifications.subscribe, appNotifications.getSnapshot)
  const history = useSyncExternalStore(appNotifications.subscribe, appNotifications.getHistorySnapshot)
  const [open, setOpen] = useState(false)
  const unread = history.filter((item) => !item.read).length
  useEffect(() => {
    let disposed = false
    let disconnect: (() => void) | undefined
    void import('../notification-history').then(({ connectNotificationHistory }) => {
      if (!disposed) {
        try { disconnect = connectNotificationHistory(appNotifications, window.localStorage) } catch { /* Storage can be unavailable. */ }
      }
    })
    return () => { disposed = true; disconnect?.() }
  }, [])
  useEffect(() => window.knowbook.onPluginNotification((notification) => {
    appNotifications.show({ ...notification, title: notification.title || (isZh ? '插件通知' : 'Plugin notification') })
  }), [isZh])
  useEffect(() => {
    let disposed = false
    let disconnect: (() => void) | undefined
    void import('../backup-notifications').then(({ connectBackupNotifications }) => {
      if (!disposed) disconnect = connectBackupNotifications(window.knowbook)
    })
    return () => { disposed = true; disconnect?.() }
  }, [])

  return <>
    <button className="nav-icon-btn notification-bell" type="button" aria-haspopup="dialog" aria-expanded={open}
      aria-label={isZh ? `通知中心${unread ? `，${unread} 条未读` : ''}` : `Notification center${unread ? `, ${unread} unread` : ''}`}
      title={isZh ? '通知中心' : 'Notification center'} onClick={() => setOpen(true)}>
      <svg aria-hidden="true" className="nav-icon-svg" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
      {unread > 0 && <span className="notification-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {(open || notifications.length > 0) && <Suspense fallback={null}>
      <NotificationList notifications={notifications} history={history} open={open} onClose={() => setOpen(false)} isZh={isZh}
        onDismiss={appNotifications.hide} onOpenDocument={onOpenDocument} />
    </Suspense>}
  </>
}
