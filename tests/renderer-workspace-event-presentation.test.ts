import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkspaceEventDetails, WorkspaceEventRecord, WorkspaceEventType } from '../src/shared/contracts'
import { formatWorkspaceEvent, formatWorkspaceEventTime } from '../src/renderer/src/sections/workspace-event-presentation'

function event(type: WorkspaceEventType, details?: WorkspaceEventDetails): WorkspaceEventRecord {
  return { id: 'event-1', type, title: 'English technical title', description: 'Created "Unrelated title" at old/path.',
    documentId: 'document-1', createdAt: '2026-10-01T08:00:00.000Z', ...(details ? { details } : {}) }
}

test('host event presentation uses structured historical facts in Chinese and English', () => {
  const facts: WorkspaceEventDetails = { schemaVersion: 1, documentTitle: '产品规划', path: '团队/产品规划' }
  const cases = [
    ['document.created', '已创建「产品规划」', 'Created “产品规划”'],
    ['document.updated', '已保存「产品规划」', 'Saved “产品规划”'],
    ['document.summary.generated', '已生成「产品规划」的 AI 摘要', 'Generated an AI summary for “产品规划”'],
    ['document.moved', '已移动「产品规划」', 'Moved “产品规划”'],
    ['document.deleted', '已删除「产品规划」', 'Deleted “产品规划”']
  ] as const
  for (const [type, zh, en] of cases) {
    const record = event(type, facts)
    assert.equal(formatWorkspaceEvent(record, 'zh-CN').title, zh)
    assert.equal(formatWorkspaceEvent(record, 'en-US').title, en)
    assert.equal(formatWorkspaceEvent(record, 'zh-CN').documentTitle, '产品规划')
  }
  assert.equal(formatWorkspaceEvent(event('document.moved', { ...facts, previousPath: '收件箱/产品规划' }), 'zh-CN').path,
    '位置：收件箱/产品规划 → 团队/产品规划')
  assert.equal(formatWorkspaceEvent(event('document.deleted', facts), 'en-US').path, 'Previous location: 团队/产品规划')
  const ai = event('ai.config.updated', { schemaVersion: 1, model: 'local-chat', aiEnabled: false })
  assert.equal(formatWorkspaceEvent(ai, 'zh-CN').description, 'AI 已关闭 · 模型：local-chat')
  assert.equal(formatWorkspaceEvent(ai, 'en-US').description, 'AI disabled · Model: local-chat')
  assert.equal(formatWorkspaceEvent(ai, 'en-US').path, '')
})

test('save and delete facts describe path changes and retained descendants without implying child deletion', () => {
  const details: WorkspaceEventDetails = { schemaVersion: 1, affectedDocumentCount: 2, pathChanged: true }
  assert.equal(formatWorkspaceEvent(event('document.updated', details), 'zh-CN').description, '已更新 2 个子文档的路径。')
  assert.equal(formatWorkspaceEvent(event('document.updated', { ...details, pathChanged: false }), 'zh-CN').description, '')
  assert.equal(formatWorkspaceEvent(event('document.moved', details), 'zh-CN').description, '连同 2 个子文档一起移动。')
  assert.equal(formatWorkspaceEvent(event('document.deleted', details), 'en-US').description, 'Kept and relocated 2 nested documents.')
  assert.equal(formatWorkspaceEvent(event('document.deleted', { ...details, affectedDocumentCount: 1 }), 'en-US').description,
    'Kept and relocated 1 nested document.')
  for (const count of [0, -1, 1.5, Number.NaN]) {
    assert.equal(formatWorkspaceEvent(event('document.deleted', { ...details, affectedDocumentCount: count }), 'zh-CN').description, '')
  }
})

test('legacy host events get localized generic actions without guessing targets from free text', () => {
  for (const type of ['document.created', 'document.updated', 'document.summary.generated', 'document.moved',
    'document.deleted', 'ai.config.updated'] as const) {
    const zh = formatWorkspaceEvent(event(type), 'zh-CN')
    assert.doesNotMatch(zh.title, /English|Unrelated|old\/path/)
    assert.equal(zh.documentTitle, undefined)
    assert.equal(zh.path, '')
    assert.equal(zh.description, '')
  }
  assert.equal(formatWorkspaceEvent(event('document.deleted'), 'zh-CN').title, '文档已删除')
  const futureVersion = { schemaVersion: 2, documentTitle: 'Must not guess' } as unknown as WorkspaceEventDetails
  assert.equal(formatWorkspaceEvent(event('document.created', futureVersion), 'en-US').title, 'Document created')
})

test('plugin lifecycle and action text remains unchanged regardless of locale or details', () => {
  for (const type of ['plugin.loaded', 'plugin.reloaded', 'plugin.installed', 'plugin.updated', 'plugin.removed',
    'plugin.action.executed', 'plugin.action.failed'] as const) {
    const record = { ...event(type, { schemaVersion: 1, documentTitle: 'Ignored host facts' }),
      title: '  Created "not a host document"  ', description: '扩展消息 / Saved changes to "custom command".' }
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const formatted = formatWorkspaceEvent(record, locale)
      assert.equal(formatted.title, record.title)
      assert.equal(formatted.description, record.description)
      assert.equal(formatted.path, '')
      assert.equal(formatted.documentTitle, undefined)
    }
  }
})

test('activity time distinguishes today, yesterday, older dates, and invalid records', () => {
  const now = new Date(2026, 9, 1, 12, 0)
  for (const locale of ['zh-CN', 'en-US'] as const) {
    const today = formatWorkspaceEventTime(new Date(2026, 9, 1, 9, 15).toISOString(), locale, now)
    const yesterday = formatWorkspaceEventTime(new Date(2026, 8, 30, 9, 15).toISOString(), locale, now)
    assert.ok(today.text.startsWith(locale === 'zh-CN' ? '今天 ' : 'Today '))
    assert.ok(yesterday.text.startsWith(locale === 'zh-CN' ? '昨天 ' : 'Yesterday '))
    assert.match(formatWorkspaceEventTime(new Date(2025, 9, 1, 9, 15).toISOString(), locale, now).text, /2025/)
    assert.ok(today.title.length > today.text.length)
    assert.equal(today.dateTime, new Date(2026, 9, 1, 9, 15).toISOString())
    const invalid = formatWorkspaceEventTime('not a date', locale, now)
    assert.equal(invalid.text, locale === 'zh-CN' ? '时间未知' : 'Time unavailable')
    assert.equal(invalid.dateTime, undefined)
  }
})
