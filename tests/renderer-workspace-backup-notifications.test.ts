import assert from 'node:assert/strict'
import test from 'node:test'
import { appNotifications } from '../src/renderer/src/app-notifications'
import { runWorkspaceBackup, type WorkspaceBackupContext } from '../src/renderer/src/workspace-backup-notifications'
import { getUiText } from '../src/renderer/src/i18n'

test('refresh retry after a completed backup never exports or imports the data again', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let exports = 0
  let refreshes = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { knowbook: {
    triggerBackup: async () => { exports++; return { exported: 2, root: '/backup', at: new Date().toISOString() } }
  } } })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
    appNotifications.clearCompleted()
  })
  const latest: { current: WorkspaceBackupContext } = { current: {
    flushPendingDocumentChanges: async () => true,
    refreshWorkspaceAfterStorageMutation: async () => { refreshes++; throw new Error('IPC unavailable') },
    reloadDatabaseDomain: () => undefined,
    ui: getUiText('en-US')
  } }
  await runWorkspaceBackup(false, latest, () => undefined, () => undefined)
  const warning = appNotifications.getSnapshot()[0]
  assert.equal(warning.level, 'warning')
  assert.equal(exports, 1)
  latest.current.refreshWorkspaceAfterStorageMutation = async () => { refreshes++ }
  const action = warning.actions![0]
  assert.ok('run' in action)
  await action.run()
  assert.equal(exports, 1)
  assert.equal(refreshes, 2)
  assert.equal(appNotifications.getSnapshot()[0].level, 'success')
})
