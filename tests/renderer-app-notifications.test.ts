import assert from 'node:assert/strict'
import test from 'node:test'
import { AppNotificationStore, appNotifications } from '../src/renderer/src/app-notifications'
import { FullTrustPluginRegistry } from '../src/renderer/src/full-trust-plugin-registry'
import type { AppNotificationHandle } from '../src/shared/app-notification'

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
