import type { AppNotificationHandle, AppNotificationInput } from '@shared/app-notification'
import type { BackupHealth } from '@shared/backup-health'
import type { ElectronApi } from '@shared/contracts'
import { appNotifications } from './app-notifications'
import { getActiveUiText } from './i18n'

export function connectBackupNotifications(api: Pick<ElectronApi, 'onBackupHealth' | 'getBackupHealth' | 'triggerBackup'>): () => void {
  let revision = -1
  let disposed = false
  let busy = false
  let handle: AppNotificationHandle | undefined
  const isZh = () => getActiveUiText().language === 'zh-CN'
  const show = (input: AppNotificationInput) => {
    if (disposed) return
    if (handle) handle.update(input)
    else handle = appNotifications.show(input)
  }
  const failed = (message: string) => show({ title: isZh() ? '自动备份失败' : 'Automatic backup failed', message, level: 'error',
    actions: [{ label: isZh() ? '重试备份' : 'Retry backup', run: retry }] })
  async function retry() {
    if (busy || disposed) return
    busy = true
    show({ title: isZh() ? '正在重试备份' : 'Retrying backup', level: 'progress' })
    try {
      await api.triggerBackup()
      show({ title: isZh() ? '自动备份已恢复' : 'Automatic backup recovered', level: 'success' })
    } catch (error) { failed(error instanceof Error ? error.message : String(error)) }
    finally { busy = false }
  }
  const apply = (state: BackupHealth) => {
    if (disposed || state.revision <= revision) return
    revision = state.revision
    if (state.error) {
      handle?.dismiss()
      handle = undefined
      failed(state.error)
    }
    else if (handle) show({ title: isZh() ? '自动备份已恢复' : 'Automatic backup recovered', level: 'success' })
  }
  const unsubscribe = api.onBackupHealth(apply)
  void api.getBackupHealth().then(apply).catch(() => { /* Live updates remain subscribed. */ })
  return () => { disposed = true; unsubscribe(); handle?.dismiss() }
}
