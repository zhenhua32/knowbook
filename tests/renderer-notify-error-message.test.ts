import assert from 'node:assert/strict'
import test from 'node:test'
import { AppNotificationStore, appNotifications } from '../src/renderer/src/app-notifications'
import { getActiveUiText, setActiveUiLanguage } from '../src/renderer/src/i18n'
import { connectNotificationHistory } from '../src/renderer/src/notification-history'
import { notify } from '../src/renderer/src/notify'

test('host failure reasons remain consistent in the toast and persisted notification history', () => {
  const previousLanguage = getActiveUiText().language
  appNotifications.clearCompleted()
  let json: string | null = null
  const storage = { getItem: () => json, setItem: (_key: string, value: string) => { json = value } }
  const disconnect = connectNotificationHistory(appNotifications, storage)
  try {
    setActiveUiLanguage('zh-CN')
    const reason = '无法保存 C:/Notes/Error: Review.md\n请检查写入权限。'
    notify(`Error invoking remote method 'knowbook:save-document': Error: TypeError: ${reason}`, 'error')
    const toast = appNotifications.getSnapshot()[0]
    assert.equal(toast.title, '操作失败')
    assert.equal(toast.message, reason)
    assert.equal(appNotifications.getHistorySnapshot()[0].message, reason)
    assert.equal(JSON.parse(json!)[0].message, reason)
    const restored = new AppNotificationStore()
    const disconnectRestored = connectNotificationHistory(restored, storage)
    try {
      assert.equal(restored.getHistorySnapshot()[0].message, reason)
      assert.equal(restored.getSnapshot().length, 0)
    } finally { disconnectRestored() }
  } finally {
    disconnect()
    setActiveUiLanguage(previousLanguage)
    appNotifications.clearCompleted()
  }
})

test('empty error reasons use the active language while null still clears without a notification', () => {
  const previousLanguage = getActiveUiText().language
  appNotifications.clearCompleted()
  try {
    for (const language of ['zh-CN', 'en-US'] as const) {
      setActiveUiLanguage(language)
      const fallback = language === 'zh-CN' ? '操作失败，请重试。' : 'Action failed. Please retry.'
      for (const message of ['', '  ', "Error invoking remote method 'knowbook:save-document': Error: ",
        "Error invoking remote method 'knowbook:save-document': Error", "Error invoking remote method 'knowbook:save-document': TypeError"]) {
        notify(message, 'error')
        assert.equal(appNotifications.getSnapshot().at(-1)?.message, fallback)
      }
      appNotifications.clearCompleted()
    }
    notify(null, 'error')
    notify('', 'success')
    assert.equal(appNotifications.getHistorySnapshot().length, 0)
  } finally {
    setActiveUiLanguage(previousLanguage)
    appNotifications.clearCompleted()
  }
})

test('ordinary notifications and plugin-provided error content retain their original text', () => {
  appNotifications.clearCompleted()
  try {
    const text = "  Error invoking remote method 'example': Error: is quoted in C:/Error: Notes.md\n  "
    for (const level of ['info', 'success', 'warning'] as const) {
      notify(text, level)
      assert.equal(appNotifications.getHistorySnapshot().at(-1)?.message, text)
    }
    appNotifications.show({ title: 'Plugin diagnostic', level: 'error', message: text })
    assert.equal(appNotifications.getHistorySnapshot().at(-1)?.message, text)
    assert.equal(appNotifications.getSnapshot().at(-1)?.message, text)
  } finally { appNotifications.clearCompleted() }
})
