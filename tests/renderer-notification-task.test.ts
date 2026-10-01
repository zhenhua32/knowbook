import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppNotificationHandle } from '../src/shared/app-notification'
import { appNotifications } from '../src/renderer/src/app-notifications'
import { runNotificationTask } from '../src/renderer/src/notification-task'

test('task failures persist and retry the same record, with duplicate execution suppressed', async () => {
  appNotifications.clearCompleted()
  let attempts = 0
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const progressMessage = "Error invoking remote method 'knowbook:trigger-backup': is an example in the exported guide."
  const resultMessage = 'Error: Notes.md exported successfully.'
  const work = async (update: AppNotificationHandle['update']) => {
    attempts++
    if (attempts === 1) throw new Error("Error invoking remote method 'knowbook:trigger-backup': Error: disk full")
    update({ title: 'Exporting', level: 'progress', message: progressMessage })
    await pending
    return { title: 'Saved', level: 'success' as const, message: resultMessage }
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
  assert.equal(appNotifications.getSnapshot()[0].message, progressMessage, 'literal diagnostic text in progress messages is preserved')
  appNotifications.hide(failed.id)
  release()
  await Promise.all([firstRetry, secondRetry])
  assert.equal(appNotifications.getSnapshot().length, 0)
  assert.equal(appNotifications.getHistorySnapshot().length, 1)
  assert.equal(appNotifications.getHistorySnapshot()[0].id, failed.id)
  assert.equal(appNotifications.getHistorySnapshot()[0].level, 'success')
  assert.equal(appNotifications.getHistorySnapshot()[0].message, resultMessage, 'a successful business message is preserved verbatim')
  appNotifications.clearCompleted()
})

test('explicit task error results and updates remove IPC packaging while preserving actions and business reasons', async (t) => {
  appNotifications.clearCompleted()
  t.after(() => appNotifications.clearCompleted())
  let actionRuns = 0
  const action = { label: 'Open backup folder', run: () => { actionRuns++ } }
  await runNotificationTask({ key: 'returned-task-error', title: 'Export', isZh: false, work: async update => {
    update({ title: 'Export failed', level: 'error', message: "Error invoking remote method 'knowbook:trigger-backup': Error: Cannot write C:/Notes/Error: Review.md", actions: [action] })
    const current = appNotifications.getSnapshot()[0]
    assert.equal(current.message, 'Cannot write C:/Notes/Error: Review.md')
    assert.equal(current.actions![0], action)
    return { title: 'Export failed', level: 'error', message: "Error invoking remote method 'knowbook:trigger-backup': Error: disk full", actions: [action] }
  } })
  const result = appNotifications.getSnapshot()[0]
  assert.equal(result.message, 'disk full')
  assert.equal(appNotifications.getHistorySnapshot().length, 1)
  const savedAction = result.actions![0]
  assert.ok('run' in savedAction)
  await savedAction.run()
  assert.equal(actionRuns, 1)
})

test('task non-error status messages preserve literal error prefixes and empty error exceptions use a readable fallback', async (t) => {
  appNotifications.clearCompleted()
  t.after(() => appNotifications.clearCompleted())
  for (const level of ['info', 'warning', 'success'] as const) {
    const message = "Error invoking remote method 'example': Error: is a literal quoted message."
    await runNotificationTask({ key: `literal-${level}`, title: level, isZh: false, work: async update => {
      update({ title: level, message, level })
      assert.equal(appNotifications.getSnapshot().at(-1)?.message, message)
      return { title: level, message, level }
    } })
    assert.equal(appNotifications.getHistorySnapshot().at(-1)?.message, message)
  }
  await runNotificationTask({ key: 'empty-error', title: 'Export', isZh: true, work: async () => { throw new Error('Error: ') } })
  assert.equal(appNotifications.getHistorySnapshot().at(-1)?.message, '操作失败，请重试。')
  for (const isZh of [true, false]) {
    const fallback = isZh ? '操作失败，请重试。' : 'Something went wrong. Please try again.'
    let updateMessage: string | undefined
    await runNotificationTask({ key: `empty-error-result-${isZh}`, title: 'Export', isZh, work: async update => {
      update({ title: 'Export failed', level: 'error', message: "Error invoking remote method 'knowbook:trigger-backup': Error: " })
      updateMessage = appNotifications.getSnapshot().at(-1)?.message
      return { title: 'Export failed', level: 'error', message: 'Error: ' }
    } })
    assert.equal(updateMessage, fallback, 'empty error updates use the same localized fallback as catch')
    assert.equal(appNotifications.getHistorySnapshot().at(-1)?.message, fallback, 'empty error results use the same localized fallback as catch')
  }
})

test('a cancelled task does not leave a running or success notification', async () => {
  await runNotificationTask({ key: 'cancelled', title: 'Import', isZh: true, work: async () => null })
  assert.equal(appNotifications.getSnapshot().length, 0)
  assert.equal(appNotifications.getHistorySnapshot().length, 0)
})
