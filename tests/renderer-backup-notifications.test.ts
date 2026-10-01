import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { BackupHealth } from '../src/shared/backup-health'
import type { BackupResult, ElectronApi } from '../src/shared/contracts'
import { appNotifications } from '../src/renderer/src/app-notifications'
import { connectBackupNotifications } from '../src/renderer/src/backup-notifications'
import { getActiveUiText, setActiveUiLanguage } from '../src/renderer/src/i18n'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function connect(t: TestContext, language: 'zh-CN' | 'en-US') {
  appNotifications.clearCompleted()
  const previousLanguage = getActiveUiText().language
  setActiveUiLanguage(language)
  const initial = deferred<BackupHealth>()
  const attempts: ReturnType<typeof deferred<BackupResult>>[] = []
  let listener!: (state: BackupHealth) => void
  let unsubscribed = false
  const api: Pick<ElectronApi, 'onBackupHealth' | 'getBackupHealth' | 'triggerBackup'> = {
    onBackupHealth: callback => { listener = callback; return () => { unsubscribed = true } },
    getBackupHealth: () => initial.promise,
    triggerBackup: () => { const request = deferred<BackupResult>(); attempts.push(request); return request.promise }
  }
  const stop = connectBackupNotifications(api)
  let disposed = false
  const dispose = () => { if (!disposed) { disposed = true; stop() } }
  t.after(() => { dispose(); setActiveUiLanguage(previousLanguage); appNotifications.clearCompleted() })
  return { initial, attempts, emit: (state: BackupHealth) => listener(state), dispose, unsubscribed: () => unsubscribed }
}

test('backup health errors and retry failures show the business reason on one persistent retry record', async t => {
  const { initial, attempts, emit } = connect(t, 'zh-CN')
  emit({ revision: 2, error: "Error invoking remote method 'knowbook:trigger-backup': Error: 无法写入 C:/Notes/Error: Review.md\n请检查剩余磁盘空间。" })
  const failed = appNotifications.getSnapshot()[0]
  assert.equal(failed.title, '自动备份失败')
  assert.equal(failed.message, '无法写入 C:/Notes/Error: Review.md\n请检查剩余磁盘空间。')
  assert.equal(failed.level, 'error')
  initial.resolve({ revision: 1, error: 'stale failure' })
  await initial.promise
  await Promise.resolve()
  assert.equal(appNotifications.getSnapshot()[0].id, failed.id)
  assert.equal(appNotifications.getHistorySnapshot().length, 1)
  const retry = failed.actions![0]
  assert.equal(retry.label, '重试备份')
  assert.ok('run' in retry)
  const first = retry.run()
  const duplicate = retry.run()
  assert.equal(attempts.length, 1)
  assert.equal(appNotifications.getSnapshot()[0].level, 'progress')
  attempts[0].reject(new Error("Error invoking remote method 'knowbook:trigger-backup': Error: 备份目录不可用"))
  await Promise.all([first, duplicate])
  assert.equal(appNotifications.getSnapshot()[0].message, '备份目录不可用')
  assert.equal(appNotifications.getSnapshot()[0].id, failed.id)
  assert.equal(appNotifications.getHistorySnapshot().length, 1)
  const nextRetry = appNotifications.getSnapshot()[0].actions![0]
  assert.ok('run' in nextRetry)
  const recovered = nextRetry.run()
  attempts[1].resolve({ exported: 3, root: 'C:/backup', at: '2026-10-01T00:00:00.000Z' })
  await recovered
  assert.equal(appNotifications.getSnapshot()[0].title, '自动备份已恢复')
  assert.equal(appNotifications.getHistorySnapshot()[0].level, 'success')
  assert.equal(appNotifications.getHistorySnapshot()[0].id, failed.id)
  assert.equal(appNotifications.getHistorySnapshot().length, 1)
})

test('backup failures preserve plain multiline details and use the active language when packaging has no reason', async t => {
  const { emit } = connect(t, 'en-US')
  const reason = '  Cannot save C:/Error: Review.md\nCheck write permission.  '
  emit({ revision: 1, error: reason })
  assert.equal(appNotifications.getSnapshot()[0].message, reason)
  assert.equal(appNotifications.getSnapshot()[0].title, 'Automatic backup failed')
  emit({ revision: 2, error: "Error invoking remote method 'knowbook:trigger-backup': Error: " })
  assert.equal(appNotifications.getSnapshot()[0].message, 'Something went wrong. Please try again.')
  assert.equal(appNotifications.getSnapshot()[0].actions![0].label, 'Retry backup')
})

test('disposing a backup notification during retry prevents its late failure from creating a new notification', async t => {
  const { emit, attempts, dispose, unsubscribed } = connect(t, 'en-US')
  emit({ revision: 1, error: 'disk full' })
  const failed = appNotifications.getSnapshot()[0]
  const retry = failed.actions![0]
  assert.ok('run' in retry)
  const pending = retry.run()
  dispose()
  assert.equal(unsubscribed(), true)
  assert.equal(appNotifications.getSnapshot().length, 0)
  attempts[0].reject(new Error("Error invoking remote method 'knowbook:trigger-backup': Error: late disk error"))
  await pending
  assert.equal(appNotifications.getSnapshot().length, 0)
  assert.equal(appNotifications.getHistorySnapshot().length, 0)
})
