import type { PluginNotification } from '@shared/app-notification'
import { appNotifications } from './app-notifications'
import { getActiveUiText } from './i18n'

export type AppMessageHandler = (message: string | null, level?: PluginNotification['level']) => void

export const notify: AppMessageHandler = (message, level = 'success') => {
  if (!message) return
  const isZh = getActiveUiText().language === 'zh-CN'
  const titles = { info: isZh ? '提示' : 'Notice', success: isZh ? '操作完成' : 'Completed',
    warning: isZh ? '请注意' : 'Attention', error: isZh ? '操作失败' : 'Action failed' }
  appNotifications.show({ title: titles[level], message, level })
}
