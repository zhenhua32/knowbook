export interface PluginNotification {
  title?: string
  message: string
  level: 'info' | 'success' | 'warning' | 'error'
}

export type AppNotificationAction = {
  label: string
  disabled?: boolean
  /** Close the history panel after an action successfully opens another surface. */
  closeNotificationCenter?: boolean
} & ({ documentId: string } | { run: () => void | Promise<void> })

export interface AppNotificationInput {
  title: string
  message?: string
  level?: PluginNotification['level'] | 'progress'
  /** A percentage from 0 to 100; omit for indeterminate progress. */
  progress?: number
  progressLabel?: string
  actions?: readonly AppNotificationAction[]
  /** Progress, errors and notifications with actions always remain until resolved or dismissed. */
  persistent?: boolean
}

export interface AppNotificationHandle {
  /** Replace the contents of this notification. Updates never reopen a dismissed notification. */
  update(input: AppNotificationInput): void
  dismiss(): void
}
