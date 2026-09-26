import assert from 'node:assert/strict'
import test from 'node:test'
import { appNotifications } from '../src/renderer/src/app-notifications'
import { runNotificationTask } from '../src/renderer/src/notification-task'

test('task failures persist and retry the same record, with duplicate execution suppressed', async () => {
  appNotifications.clearCompleted()
  let attempts = 0
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const work = async () => {
    attempts++
    if (attempts === 1) throw new Error('disk full')
    await pending
    return { title: 'Saved', level: 'success' as const }
  }
  await runNotificationTask({ key: 'test-task', title: 'Backup', isZh: false, work })
  const failed = appNotifications.getSnapshot()[0]
  assert.equal(failed.message, 'disk full')
  assert.equal(failed.level, 'error')
  const retry = failed.actions![0]
  assert.ok('run' in retry)
  const firstRetry = retry.run()
  const secondRetry = retry.run()
  await runNotificationTask({ key: 'test-task', title: 'Duplicate backup', isZh: false, work })
  assert.equal(attempts, 2)
  appNotifications.hide(failed.id)
  release()
  await Promise.all([firstRetry, secondRetry])
  assert.equal(appNotifications.getSnapshot().length, 0)
  assert.equal(appNotifications.getHistorySnapshot().length, 1)
  assert.equal(appNotifications.getHistorySnapshot()[0].id, failed.id)
  assert.equal(appNotifications.getHistorySnapshot()[0].level, 'success')
  appNotifications.clearCompleted()
})

test('a cancelled task does not leave a running or success notification', async () => {
  await runNotificationTask({ key: 'cancelled', title: 'Import', isZh: true, work: async () => null })
  assert.equal(appNotifications.getSnapshot().length, 0)
  assert.equal(appNotifications.getHistorySnapshot().length, 0)
})
