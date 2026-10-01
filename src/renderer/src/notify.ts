import type { PluginNotification } from '@shared/app-notification'
import { appNotifications } from './app-notifications'
import { getActiveUiText } from './i18n'
import { normalizeErrorMessage } from './utils/errorMessage'

export type AppMessageHandler = (message: string | null, level?: PluginNotification['level']) => void

export const notify: AppMessageHandler = (message, level = 'success') => {
  if (message === null || (!message && level !== 'error')) return
  const isZh = getActiveUiText().language === 'zh-CN'
  const titles = { info: isZh ? '提示' : 'Notice', success: isZh ? '操作完成' : 'Completed',
    warning: isZh ? '请注意' : 'Attention', error: isZh ? '操作失败' : 'Action failed' }
  const displayMessage = level === 'error'
    ? normalizeErrorMessage(message, isZh ? '操作失败，请重试。' : 'Action failed. Please retry.')
    : message
  appNotifications.show({ title: titles[level], message: displayMessage, level })
}
