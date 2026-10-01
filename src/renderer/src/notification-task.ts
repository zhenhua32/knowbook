import type { AppNotificationHandle, AppNotificationInput } from '@shared/app-notification'
import { appNotifications } from './app-notifications'
import { normalizeErrorMessage } from './utils/errorMessage'

const running = new Set<string>()

/** One task, one record; retries update that record and never execute concurrently. */
export async function runNotificationTask(options: {
  key: string
  title: string
  isZh: boolean
  work: (update: AppNotificationHandle['update']) => Promise<AppNotificationInput | null>
}): Promise<void> {
  let handle: AppNotificationHandle | undefined
  const failureMessage = options.isZh ? '操作失败，请重试。' : 'Something went wrong. Please try again.'
  const run = async () => {
    if (running.has(options.key)) return
    running.add(options.key)
    const progress: AppNotificationInput = { title: options.title, level: 'progress' }
    if (handle) handle.update(progress)
    else handle = appNotifications.show(progress)
    const update: AppNotificationHandle['update'] = (input) => handle!.update(input.level === 'error' && typeof input.message === 'string'
      ? { ...input, message: normalizeErrorMessage(input.message, failureMessage) } : input)
    try {
      const result = await options.work(update)
      if (result) update(result)
      else handle.dismiss() // A cancelled picker or unsaved document is not a completed task.
    } catch (error) {
      handle.update({ title: options.isZh ? `${options.title}失败` : `${options.title} failed`, level: 'error',
        message: normalizeErrorMessage(error instanceof Error ? error.message : String(error), failureMessage),
        actions: [{ label: options.isZh ? '重试' : 'Retry', run }] })
    } finally {
      running.delete(options.key)
    }
  }
  await run()
}
