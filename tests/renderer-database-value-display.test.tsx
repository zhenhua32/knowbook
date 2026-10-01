import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import type { DatabaseField, DatabaseRecord } from '../src/shared/contracts'
import { DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { DatabaseCardView } from '../src/renderer/src/features/database/components/DatabaseCardView'
import { DatabaseTableView } from '../src/renderer/src/features/database/components/DatabaseTableView'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { formatDatabaseValueDisplay } from '../src/renderer/src/features/database/model/databaseValueDisplay'

const field = (id: string, type: DatabaseField['type'], role: DatabaseField['role'] = 'property'): DatabaseField => ({
  id, name: id, type, role, options: [], editable: false, hideable: true, deletable: false, sortOrder: 0
})
const dateField = field('due', 'date')
const zones = ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']
const locales = ['en-US', 'zh-CN']

function withTimeZone(zone: string, run: () => void) {
  const previous = process.env.TZ
  process.env.TZ = zone
  try {
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, zone)
    run()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

function record(fieldValues: DatabaseRecord['fieldValues']): DatabaseRecord {
  return { id: 'record', databaseId: 'database', title: 'A record', documentId: null, fieldValues,
    createdAt: '2026-10-01T00:30:00.000Z', updatedAt: '2026-09-30T20:30:00.000Z' }
}

function renderViews(fields: DatabaseField[], input: DatabaseRecord, locale?: string) {
  const shared = { fields, records: [input], locale, selectedIds: new Set<string>(), sourceKind: 'custom' as const,
    text: getDatabaseWorkspaceText('zh-CN'), onOpenDocument: () => {}, onOpenRecord: () => {}, onSelect: () => {} }
  const dom = new JSDOM(renderToStaticMarkup(<>
    <DatabaseCardView {...shared} />
    <DatabaseTableView {...shared} documents={[]} columnWidths={{}} onColumnWidthChange={() => {}}
      onUpdateDocument={async () => {}} onUpdateValue={async () => {}} />
  </>))
  return { document: dom.window.document,
    cardValues: () => [...dom.window.document.querySelectorAll('dd')].map(value => value.textContent),
    tableValues: () => [...dom.window.document.querySelectorAll('tbody tr:not(.dbw-virtual-spacer) td')].slice(1).map(value => value.textContent),
    close: () => dom.window.close() }
}

test('system timestamps display the local calendar day with the explicit application locale at UTC and year boundaries', () => {
  const input = [
    { value: '2026-10-01T00:30:00.000Z', days: ['10/1/2026', '10/1/2026', '9/30/2026'], zhDays: ['2026/10/1', '2026/10/1', '2026/9/30'] },
    { value: '2026-09-30T20:30:00.000Z', days: ['9/30/2026', '10/1/2026', '9/30/2026'], zhDays: ['2026/9/30', '2026/10/1', '2026/9/30'] },
    { value: '2026-12-31T23:30:00.000Z', days: ['12/31/2026', '1/1/2027', '12/31/2026'], zhDays: ['2026/12/31', '2027/1/1', '2026/12/31'] }
  ]
  zones.forEach((zone, index) => withTimeZone(zone, () => {
    for (const item of input) {
      assert.equal(formatDatabaseValueDisplay(field(DATABASE_SYSTEM_FIELD_IDS.createdAt, 'date', 'system'), item.value, 'en-US'), item.days[index])
      assert.equal(formatDatabaseValueDisplay(field(DATABASE_SYSTEM_FIELD_IDS.updatedAt, 'date', 'system'), item.value, 'zh-CN'), item.zhDays[index])
    }
  }))
})

test('pure date properties preserve their calendar day in every timezone, including leap days and daylight-saving boundaries', () => {
  const input = [
    ['2026-10-01', '10/1/2026', '2026/10/1'], ['2024-02-29', '2/29/2024', '2024/2/29'],
    ['2026-03-08', '3/8/2026', '2026/3/8'], ['2026-11-01', '11/1/2026', '2026/11/1']
  ]
  for (const zone of zones) withTimeZone(zone, () => {
    for (const [value, en, zh] of input) {
      assert.equal(formatDatabaseValueDisplay(dateField, value, 'en-US'), en)
      assert.equal(formatDatabaseValueDisplay(dateField, value, 'zh-CN'), zh)
    }
  })
})

test('invalid date strings retain the original text instead of becoming a different calendar day', () => {
  for (const zone of zones) withTimeZone(zone, () => {
    for (const locale of locales) {
      for (const value of ['invalid date', '2026-02-29', '2026-02-30', '2026-13-01', '2026-01-00',
        '2026-02-30T12:00:00.000Z', '2026-10-01T99:00:00.000Z', ' 2026-10-01 ', '42']) {
        assert.equal(formatDatabaseValueDisplay(dateField, value, locale), value)
      }
    }
  })
})

test('field-aware display preserves empty, text, select, multi-select, checkbox and numeric semantics', () => {
  for (const locale of locales) {
    for (const value of [null, undefined, '']) assert.equal(formatDatabaseValueDisplay(dateField, value, locale), '—')
    assert.equal(formatDatabaseValueDisplay(dateField, 0, locale), '0')
    assert.equal(formatDatabaseValueDisplay(dateField, 42, locale), '42')
    assert.equal(formatDatabaseValueDisplay(dateField, true, locale), '✓')
    assert.equal(formatDatabaseValueDisplay(dateField, false, locale), '—')
    assert.equal(formatDatabaseValueDisplay(field('notes', 'text'), '2026-10-01T00:30:00.000Z', locale), '2026-10-01T00:30:00.000Z')
    assert.equal(formatDatabaseValueDisplay(field('status', 'select'), '2026-10-01', locale), '2026-10-01')
    assert.equal(formatDatabaseValueDisplay(field('tags', 'multi-select'), ['Design, UX', 'Core'], locale), 'Design, UX · Core')
    assert.equal(formatDatabaseValueDisplay(field('tags', 'multi-select'), [], locale), '')
    assert.equal(formatDatabaseValueDisplay(field('done', 'checkbox'), true, locale), '✓')
    assert.equal(formatDatabaseValueDisplay(field('done', 'checkbox'), false, locale), '—')
  }
})

test('card dates and readonly table dates show identical localized values without changing the raw record', () => {
  const fields = [field(DATABASE_SYSTEM_FIELD_IDS.createdAt, 'date', 'system'), field(DATABASE_SYSTEM_FIELD_IDS.updatedAt, 'date', 'system'),
    dateField, field('invalid', 'date')]
  const input = record({ [DATABASE_SYSTEM_FIELD_IDS.createdAt]: '2026-10-01T00:30:00.000Z',
    [DATABASE_SYSTEM_FIELD_IDS.updatedAt]: '2026-09-30T20:30:00.000Z', due: '2026-10-01', invalid: '2026-02-30' })
  const original = JSON.stringify(input)
  zones.forEach((zone, index) => withTimeZone(zone, () => {
    for (const locale of locales) {
      const view = renderViews(fields, input, locale)
      try {
        const en = [['10/1/2026', '9/30/2026'], ['10/1/2026', '10/1/2026'], ['9/30/2026', '9/30/2026']][index]
        const zh = [['2026/10/1', '2026/9/30'], ['2026/10/1', '2026/10/1'], ['2026/9/30', '2026/9/30']][index]
        const expected = [...(locale === 'en-US' ? en : zh), locale === 'en-US' ? '10/1/2026' : '2026/10/1', '2026-02-30']
        assert.deepEqual(view.cardValues(), expected)
        assert.deepEqual(view.tableValues(), expected)
        assert.equal(JSON.stringify(input), original)
      } finally { view.close() }
    }
  }))
})

test('omitting the locale defaults both views to English independently of the labels locale', () => {
  withTimeZone('America/Los_Angeles', () => {
    const input = record({ due: '2026-10-01T00:30:00.000Z' })
    const view = renderViews([dateField], input)
    try {
      assert.deepEqual(view.cardValues(), ['9/30/2026'])
      assert.deepEqual(view.tableValues(), ['9/30/2026'])
    } finally { view.close() }
  })
})

test('formatting card and readonly dates leaves editable table dates as their original calendar values', () => {
  for (const locale of locales) withTimeZone('America/Los_Angeles', () => {
    const fields = [{ ...dateField, editable: true }, field('notes', 'text'), field('tags', 'multi-select'), field('done', 'checkbox')]
    const input = record({ due: '2026-10-01', notes: '2026-10-01T00:30:00.000Z', tags: ['Design, UX', 'Core'], done: true })
    const view = renderViews(fields, input, locale)
    try {
      assert.equal(view.document.querySelector<HTMLInputElement>('tbody input[type=date]')!.value, '2026-10-01')
      assert.deepEqual(view.cardValues(), [locale === 'en-US' ? '10/1/2026' : '2026/10/1', '2026-10-01T00:30:00.000Z', 'Design, UX · Core', '✓'])
      assert.equal(view.document.querySelector<HTMLElement>('tbody .dbw-readonly-value')!.textContent, '2026-10-01T00:30:00.000Z')
      assert.deepEqual([...view.document.querySelectorAll('tbody .dbw-tag')].map(tag => tag.textContent), ['Design, UX', 'Core'])
      assert.equal(view.tableValues().at(-1), '✓')
      assert.equal(input.fieldValues.due, '2026-10-01')
    } finally { view.close() }
  })
})
