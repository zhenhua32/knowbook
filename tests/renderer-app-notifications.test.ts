import assert from 'node:assert/strict'
import test from 'node:test'
import { AppNotificationStore, appNotifications } from '../src/renderer/src/app-notifications'
import { FullTrustPluginRegistry } from '../src/renderer/src/full-trust-plugin-registry'
import type { AppNotificationHandle } from '../src/shared/app-notification'
import { connectNotificationHistory } from '../src/renderer/src/notification-history'

test('notifications update in place and late updates cannot reopen a dismissed result', () => {
  const store = new AppNotificationStore()
  let changes = 0
  const unsubscribe = store.subscribe(() => { changes++ })
  const handle = store.show({ title: 'Translating', level: 'progress', progress: 0 })
  const id = store.getSnapshot()[0].id
  handle.update({ title: 'Translating', level: 'progress', progress: 50 })
  assert.equal(store.getSnapshot().length, 1)
  assert.equal(store.getSnapshot()[0].id, id)
  assert.equal(store.getSnapshot()[0].progress, 50)
  handle.update({ title: 'Done', level: 'success', actions: [{ label: 'Open', documentId: 'result' }] })
  const other = store.show({ title: 'Other task', level: 'progress' })
  store.dismiss(id)
  handle.update({ title: 'Stale completion' })
  handle.dismiss()
  assert.deepEqual(store.getSnapshot().map((item) => item.title), ['Other task'])
  assert.equal(changes, 5)
  unsubscribe()
  other.dismiss()
  assert.equal(changes, 5)
  assert.equal(store.getSnapshot().length, 0)
})

test('hiding a task preserves its result in history without reopening a toast', () => {
  const store = new AppNotificationStore()
  const task = store.show({ title: 'Exporting', level: 'progress' })
  const id = store.getSnapshot()[0].id
  store.hide(id)
  store.markAllRead()
  task.update({ title: 'Exported', level: 'success' })
  assert.equal(store.getSnapshot().length, 0)
  assert.equal(store.getHistorySnapshot()[0].title, 'Exported')
  assert.equal(store.getHistorySnapshot()[0].read, false)
  store.markAllRead()
  assert.equal(store.getHistorySnapshot()[0].read, true)
  store.show({ title: 'Another result' })
  store.markAllRead()
  assert.equal(store.getSnapshot().length, 0, 'read notifications must not reappear after leaving the center')
})

test('completed history is bounded and clearing it preserves running tasks', () => {
  const store = new AppNotificationStore()
  const task = store.show({ title: 'Still running', level: 'progress' })
  for (let index = 0; index < 110; index++) store.show({ title: `Result ${index}`, level: 'success' })
  assert.equal(store.getHistorySnapshot().length, 101)
  assert.equal(store.getSnapshot().length, 3)
  store.clearCompleted()
  assert.deepEqual(store.getHistorySnapshot().map((item) => item.title), ['Still running'])
  task.update({ title: 'Finished', level: 'success' })
  assert.equal(store.getHistorySnapshot()[0].title, 'Finished')
})

test('disposing a plugin removes running records and revokes actions on completed history', () => {
  const store = new AppNotificationStore()
  const task = store.show({ title: 'Running', level: 'progress' })
  const result = store.show({ title: 'Done', actions: [{ label: 'Run plugin code', run: () => undefined }] })
  store.hide(store.getSnapshot()[1].id)
  task.dismiss()
  result.dismiss()
  result.update({ title: 'Stale' })
  assert.equal(store.getSnapshot().length, 0)
  assert.equal(store.getHistorySnapshot().length, 1)
  assert.equal(store.getHistorySnapshot()[0].title, 'Done')
  assert.equal(store.getHistorySnapshot()[0].actions, undefined)
})

test('a long-running task finishing after many other results remains in recent history', () => {
  const store = new AppNotificationStore()
  const task = store.show({ title: 'Long export', level: 'progress' })
  for (let index = 0; index < 110; index++) store.show({ title: `Other ${index}` })
  task.update({ title: 'Export finished', level: 'success' })
  assert.equal(store.getHistorySnapshot().length, 100)
  assert.equal(store.getHistorySnapshot().at(-1)?.title, 'Export finished')
})

test('history survives restart without stale actions, running tasks or renewed toasts', () => {
  let json: string | null = null
  const storage = { getItem: () => json, setItem: (_key: string, value: string) => { json = value } }
  const store = new AppNotificationStore()
  const disconnect = connectNotificationHistory(store, storage)
  store.show({ title: 'Error', level: 'error', actions: [{ label: 'Retry', run: () => undefined }] })
  store.show({ title: 'Transient task', level: 'progress' })
  disconnect()
  const restored = new AppNotificationStore()
  const disconnectRestored = connectNotificationHistory(restored, storage)
  assert.equal(restored.getSnapshot().length, 0)
  assert.equal(restored.getHistorySnapshot().length, 1)
  assert.equal(restored.getHistorySnapshot()[0].actions, undefined)
  assert.equal(restored.getHistorySnapshot()[0].read, false)
  disconnectRestored()
  const disconnectAgain = connectNotificationHistory(restored, storage)
  assert.equal(restored.getHistorySnapshot().length, 1, 'effect reconnection must not duplicate history')
  restored.clearCompleted()
  assert.deepEqual(JSON.parse(json!), [])
  disconnectAgain()
})

test('invalid cache and storage failures do not break notifications', () => {
  for (const json of ['{', JSON.stringify([{ title: 'Bad date', level: 'error', createdAt: 1e20, updatedAt: 1 }])]) {
    const store = new AppNotificationStore()
    const disconnect = connectNotificationHistory(store, { getItem: () => json, setItem: () => { throw new Error('quota') } })
    assert.equal(store.getHistorySnapshot().length, 0)
    store.show({ title: 'Works' })
    assert.equal(store.getSnapshot().length, 1)
    disconnect()
  }
})

test('Full Trust notifications publish only at commit and clean up on failure, replacement and deactivation', async () => {
  const registry = new FullTrustPluginRegistry()
  let handle!: AppNotificationHandle
  try {
    const api = await registry.activatePlugin({ id: 'notifier', version: '1', revisionHash: 'sha256:one' }, (api) => {
      handle = api.showNotification({ title: 'Staged' })
      handle.update({ title: 'Ready', level: 'progress' })
      const discarded = api.showNotification({ title: 'Never shown' })
      discarded.dismiss()
    })
    assert.equal(appNotifications.getSnapshot().length, 0)
    await registry.commitPlugin('notifier', 'sha256:one')
    assert.deepEqual(appNotifications.getSnapshot().map((item) => item.title), ['Ready'])
    await assert.rejects(registry.activatePlugin({ id: 'notifier', version: '2', revisionHash: 'sha256:failed' }, (api) => {
      api.showNotification({ title: 'Failed activation' })
      throw new Error('activation failure')
    }), /activation failure/)
    assert.deepEqual(appNotifications.getSnapshot().map((item) => item.title), ['Ready'])
    await registry.activatePlugin({ id: 'notifier', version: '2', revisionHash: 'sha256:two' }, (api) => {
      api.showNotification({ title: 'New revision' })
    })
    await registry.commitPlugin('notifier', 'sha256:two')
    assert.deepEqual(appNotifications.getSnapshot().map((item) => item.title), ['New revision'])
    assert.throws(() => handle.update({ title: 'Stale' }), /not active/)
    assert.throws(() => api.showNotification({ title: 'Stale' }), /not active/)
    handle.dismiss()
    assert.equal(appNotifications.getSnapshot().length, 1)
    await registry.deactivateAll()
    assert.equal(appNotifications.getSnapshot().length, 0)
  } finally {
    await registry.deactivateAll()
  }
})
