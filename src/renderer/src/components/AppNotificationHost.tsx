import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react'
import { appNotifications } from '../app-notifications'

const NotificationList = lazy(() => import('./AppNotificationList'))

export function AppNotificationHost({ isZh, onOpenDocument }: {
  isZh: boolean
  onOpenDocument: (documentId: string) => void
}) {
  const notifications = useSyncExternalStore(appNotifications.subscribe, appNotifications.getSnapshot)
  useEffect(() => window.knowbook.onPluginNotification((notification) => {
    appNotifications.show({ ...notification, title: notification.title || (isZh ? '插件通知' : 'Plugin notification') })
  }), [isZh])

  return notifications.length > 0 ? <Suspense fallback={null}>
    <NotificationList notifications={notifications} isZh={isZh}
      onDismiss={appNotifications.dismiss} onOpenDocument={onOpenDocument} />
  </Suspense> : null
}
