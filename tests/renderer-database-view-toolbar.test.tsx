import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseField, DatabaseFilterRule, DatabaseRecord, DatabaseViewConfigV1 } from '../src/shared/contracts'
import { areDatabaseViewConfigsEqual, cloneDatabaseViewConfig, createDefaultDatabaseViewConfig, normalizeDatabaseViewConfig } from '../src/shared/database-workspace'
import { DatabaseViewToolbar } from '../src/renderer/src/features/database/components/DatabaseViewToolbar'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { applyDatabaseView } from '../src/renderer/src/features/database/model/databaseFilters'

const field = (id: string, type: DatabaseField['type'], options: string[] = []): DatabaseField => ({
  id, name: id, type, options, role: id === '__title__' ? 'title' : 'property', editable: true,
  hideable: id !== '__title__', deletable: id !== '__title__', sortOrder: 0
})
const fields = [field('__title__', 'text'), field('done', 'checkbox'), field('status', 'select', ['Todo', 'Doing']),
  field('due', 'date'), field('tags', 'multi-select', ['Design, UX', 'Core', 'One,Two,Three']), field('score', 'text')]
const record = (id: string, title: string, fieldValues: DatabaseRecord['fieldValues']): DatabaseRecord => ({
  id, title, fieldValues, databaseId: 'database', documentId: null, createdAt: '2026-10-01', updatedAt: '2026-10-01'
})
const records = [
  record('a', 'Alpha', { done: true, status: 'Todo', due: '2026-10-01', tags: ['Design, UX'], score: 3 }),
  record('b', 'Beta', { done: false, status: 'Doing', due: '2026-10-02', tags: ['Core'], score: 5 }),
  record('c', 'Gamma', { done: true, status: 'Todo', due: '2026-10-03', tags: ['Design, UX', 'Core'], score: 8 }),
  record('d', 'Delta', { done: false, status: null, due: null, tags: [], score: 1 }),
  record('e', 'Epsilon', { status: null, due: null, tags: null, score: 0 })
]
function view(rules: DatabaseFilterRule[] = []): DatabaseViewConfigV1 {
  return { ...createDefaultDatabaseViewConfig('table', fields.map(item => item.id)), sorts: [], filters: { operator: 'and', rules } }
}
function rule(config: DatabaseViewConfigV1, index = 0): DatabaseFilterRule {
  const value = config.filters.rules[index]
  assert.ok(value && !('rules' in value))
  return value
}

async function withToolbar(options: { config?: DatabaseViewConfigV1; fields?: DatabaseField[]; locale?: string; records?: DatabaseRecord[] }, run: (context: {
  document: Document
  text: ReturnType<typeof getDatabaseWorkspaceText>
  config: () => DatabaseViewConfigV1
  saved: () => DatabaseViewConfigV1
  results: () => string[]
  changes: () => number
  row: (index?: number) => HTMLElement
  select: (element: HTMLSelectElement, value: string) => Promise<void>
  fill: (element: HTMLInputElement, value: string) => Promise<void>
  click: (element: HTMLElement) => Promise<void>
  button: (name: string) => HTMLButtonElement
  option: (name: string, index?: number) => HTMLInputElement
  reload: () => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const text = getDatabaseWorkspaceText(options.locale ?? 'en-US')
  const sourceFields = options.fields ?? fields
  let current!: DatabaseViewConfigV1
  let persisted = cloneDatabaseViewConfig(options.config ?? view())
  let setConfig!: Dispatch<SetStateAction<DatabaseViewConfigV1>>
  let changed = 0
  function Harness() {
    const [draft, updateDraft] = useState(() => cloneDatabaseViewConfig(persisted))
    const [base, setBase] = useState(() => cloneDatabaseViewConfig(persisted))
    current = draft
    setConfig = updateDraft
    const results = applyDatabaseView(options.records ?? records, sourceFields, draft.query, draft.filters, draft.sorts)
    return createElement('div', null,
      createElement(DatabaseViewToolbar, { config: draft, fields: sourceFields, dirty: !areDatabaseViewConfigsEqual(draft, base),
        recordCount: results.length, text, onChange: updater => { changed++; updateDraft(updater) },
        onOpenFields: () => {}, onSaveAs: () => {}, onReset: () => updateDraft(cloneDatabaseViewConfig(base)),
        onSave: () => { persisted = normalizeDatabaseViewConfig(JSON.parse(JSON.stringify(draft))); setBase(cloneDatabaseViewConfig(persisted)) } }),
      createElement('output', { 'data-results': true }, results.map(item => item.id).join(',')))
  }
  const row = (index = 0) => {
    const element = dom.window.document.querySelectorAll<HTMLElement>('.dbw-filter-row')[index]
    assert.ok(element)
    return element
  }
  const button = (name: string) => {
    const element = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(item =>
      item.getAttribute('aria-label') === name || item.textContent?.trim() === name || item.textContent?.trim() === `＋ ${name}`)
    assert.ok(element, `button ${name} should exist`)
    return element
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    dom.window.document.querySelector<HTMLDetailsElement>('.dbw-toolbar-menu')!.open = true
    await run({ document: dom.window.document, text, config: () => current, saved: () => persisted, changes: () => changed, row, button,
      results: () => dom.window.document.querySelector('output[data-results]')!.textContent!.split(',').filter(Boolean).sort(),
      select: async (element, value) => { await act(async () => { element.value = value; element.dispatchEvent(new dom.window.Event('change', { bubbles: true })) }) },
      fill: async (element, value) => { await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(element, value)
        element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        element.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      }) },
      click: async element => { await act(async () => element.click()) },
      option: (name, index = 0) => {
        const label = [...row(index).querySelectorAll<HTMLLabelElement>('.dbw-filter-options label')].find(item => item.textContent === name)
        assert.ok(label, `whole option ${name} should exist`)
        return label.querySelector<HTMLInputElement>('input[type=checkbox]')!
      },
      reload: async () => { await act(async () => setConfig(normalizeDatabaseViewConfig(JSON.parse(JSON.stringify(persisted))))) }
    })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

const fieldSelect = (row: HTMLElement) => row.querySelectorAll<HTMLSelectElement>('select')[0]
const conditionSelect = (row: HTMLElement) => row.querySelectorAll<HTMLSelectElement>('select')[1]
const valueControl = (row: HTMLElement) => row.querySelector<HTMLInputElement | HTMLSelectElement>('.dbw-filter-value')!

test('new filter rules choose a compatible default operator and value for each field type', async () => {
  const defaults = [
    ['__title__', 'contains', ''], ['done', 'is-checked', undefined], ['status', 'equals', ''],
    ['due', 'equals', ''], ['tags', 'contains-any', []]
  ] as const
  for (const [fieldId, operator, value] of defaults) {
    const first = fields.find(item => item.id === fieldId)!
    await withToolbar({ fields: [first, ...fields.filter(item => item.id !== fieldId)] }, async ({ config, row, text, click, button, results }) => {
      await click(button(text.addFilter))
      assert.equal(rule(config()).fieldId, fieldId)
      assert.equal(rule(config()).operator, operator)
      assert.deepEqual(rule(config()).value, value)
      assert.equal(conditionSelect(row()).value, operator)
      assert.ok([...conditionSelect(row()).options].some(item => item.value === operator))
      if (first.type === 'checkbox') {
        assert.equal(row().querySelector('.dbw-filter-value'), null)
        assert.deepEqual(results(), ['a', 'c'])
      } else if (first.type === 'date') assert.equal((valueControl(row()) as HTMLInputElement).type, 'date')
      else if (first.type === 'multi-select') assert.equal(row().querySelectorAll('input[type=checkbox]').length, first.options.length)
    })
  }
})

test('switching fields uses compatible checkbox, select, date and multi-select controls with matching results', async () => {
  await withToolbar({ config: view([{ id: 'first', fieldId: '__title__', operator: 'contains', value: 'Alpha' }]) },
    async ({ config, row, select, fill, click, option, results }) => {
      assert.deepEqual(results(), ['a'])
      await select(fieldSelect(row()), 'done')
      assert.equal(conditionSelect(row()).value, 'is-checked')
      assert.equal(Object.hasOwn(rule(config()), 'value'), false)
      assert.deepEqual(results(), ['a', 'c'])
      await select(conditionSelect(row()), 'is-not-checked')
      assert.deepEqual(results(), ['b', 'd', 'e'])
      await select(fieldSelect(row()), 'status')
      assert.equal(conditionSelect(row()).value, 'equals')
      assert.equal(valueControl(row()).tagName, 'SELECT')
      await select(valueControl(row()) as HTMLSelectElement, 'Todo')
      assert.deepEqual(results(), ['a', 'c'])
      await select(conditionSelect(row()), 'not-equals')
      assert.deepEqual(results(), ['b', 'd', 'e'])
      await select(fieldSelect(row()), 'due')
      assert.equal(conditionSelect(row()).value, 'equals')
      assert.equal((valueControl(row()) as HTMLInputElement).type, 'date')
      await fill(valueControl(row()) as HTMLInputElement, '2026-10-02')
      assert.deepEqual(results(), ['b'])
      await select(conditionSelect(row()), 'before')
      assert.deepEqual(results(), ['a'])
      await select(conditionSelect(row()), 'after')
      assert.deepEqual(results(), ['c'])
      await select(fieldSelect(row()), 'tags')
      assert.equal(conditionSelect(row()).value, 'contains-any')
      assert.deepEqual(rule(config()).value, [])
      await click(option('Design, UX'))
      assert.deepEqual(rule(config()).value, ['Design, UX'])
      assert.deepEqual(results(), ['a', 'c'])
      await click(option('Core'))
      assert.deepEqual(results(), ['a', 'b', 'c'])
      await select(conditionSelect(row()), 'contains-all')
      assert.deepEqual(rule(config()).value, ['Design, UX', 'Core'])
      assert.deepEqual(results(), ['c'])
    })
})

test('empty conditions remove values and switching back restores the correct scalar or array shape without stale choices', async () => {
  for (const fieldId of ['status', 'due', 'tags']) {
    const initial: DatabaseFilterRule = { id: 'first', fieldId, operator: fieldId === 'tags' ? 'contains-all' : 'equals',
      value: fieldId === 'tags' ? ['Design, UX', 'Core'] : fieldId === 'status' ? 'Todo' : '2026-10-02' }
    await withToolbar({ config: view([initial]) }, async ({ config, row, results, select, text, click, button }) => {
      await select(conditionSelect(row()), 'is-empty')
      assert.equal(Object.hasOwn(rule(config()), 'value'), false)
      assert.equal(row().querySelector('.dbw-filter-value'), null)
      assert.deepEqual(results(), ['d', 'e'])
      await select(conditionSelect(row()), 'is-not-empty')
      assert.deepEqual(results(), ['a', 'b', 'c'])
      await select(conditionSelect(row()), initial.operator)
      assert.deepEqual(rule(config()).value, fieldId === 'tags' ? [] : '')
      if (fieldId === 'tags') {
        assert.ok([...row().querySelectorAll<HTMLInputElement>('input[type=checkbox]')].every(input => !input.checked))
        assert.deepEqual(results(), ['a', 'b', 'c', 'd'])
      } else assert.equal(valueControl(row()).value, '')
      await click(button(text.clearFilters))
      assert.deepEqual(config().filters.rules, [])
      assert.deepEqual(results(), ['a', 'b', 'c', 'd', 'e'])
    })
  }
})

test('multi-select filters save, reset and reload whole option strings including commas', async () => {
  const initial = view([{ id: 'saved', fieldId: 'tags', operator: 'contains-all', value: ['Design, UX', 'Core'] }])
  await withToolbar({ config: initial }, async ({ config, saved, results, option, click, text, button, reload }) => {
    assert.equal(option('Design, UX').checked, true)
    assert.equal(option('Core').checked, true)
    assert.deepEqual(results(), ['c'])
    await click(option('Core'))
    assert.deepEqual(results(), ['a', 'c'])
    await click(button(text.resetView))
    assert.deepEqual(config(), initial)
    assert.equal(option('Core').checked, true)
    await click(option('Core'))
    await click(option('One,Two,Three'))
    await click(button(text.saveChanges))
    assert.deepEqual(rule(saved()).value, ['Design, UX', 'One,Two,Three'])
    await click(option('Design, UX'))
    await reload()
    assert.deepEqual(rule(config()).value, ['Design, UX', 'One,Two,Three'])
    assert.equal(option('Design, UX').checked, true)
    assert.equal(option('One,Two,Three').checked, true)
    assert.equal(option('Core').checked, false)
    assert.deepEqual(results(), [])
  })
})

test('multiple filter rows remain independent while search clearing preserves their conditions', async () => {
  await withToolbar({ config: view([{ id: 'status-rule', fieldId: 'status', operator: 'equals', value: 'Todo' },
    { id: 'tags-rule', fieldId: 'tags', operator: 'contains-any', value: ['Core'] }]) },
  async ({ config, document, results, row, select, fill, click, option, button, text }) => {
    assert.deepEqual(results(), ['c'])
    await select(valueControl(row()) as HTMLSelectElement, 'Doing')
    assert.deepEqual(rule(config(), 1).value, ['Core'])
    assert.deepEqual(results(), ['b'])
    await click(option('Design, UX', 1))
    assert.equal(rule(config()).value, 'Doing')
    assert.deepEqual(rule(config(), 1).value, ['Core', 'Design, UX'])
    const search = document.querySelector<HTMLInputElement>('.dbw-main-search input')!
    await fill(search, 'Gamma')
    assert.deepEqual(results(), [])
    const filtersBeforeClear = cloneDatabaseViewConfig(config()).filters
    await click(button(text.clearSearch))
    assert.equal(config().query, '')
    assert.deepEqual(config().filters, filtersBeforeClear)
    assert.deepEqual(results(), ['b'])
    await click(row().querySelector<HTMLButtonElement>('button[aria-label="Delete"]')!)
    assert.equal(rule(config()).id, 'tags-rule')
    assert.equal(fieldSelect(row()).getAttribute('aria-label'), 'Filter field 1')
    assert.deepEqual(rule(config()).value, ['Core', 'Design, UX'])
    assert.deepEqual(results(), ['a', 'b', 'c'])
  })
})

test('invalid saved multi-select strings are explained and only repaired by selecting actual whole options', async () => {
  for (const operator of ['contains-any', 'contains-all'] as const) {
    const initial = view([{ id: 'old', fieldId: 'tags', operator, value: 'Design, UX' }])
    await withToolbar({ config: initial }, async ({ config, changes, results, row, option, text, click }) => {
      assert.deepEqual(config(), initial, 'loading must not silently reinterpret the existing rule')
      assert.equal(changes(), 0)
      assert.deepEqual(results(), [])
      assert.ok(row().querySelector('[role=alert]')!.textContent!.includes(text.invalidFilterValue))
      assert.ok(row().querySelector('[role=alert]')!.textContent!.includes('Design, UX'))
      assert.equal(option('Design, UX').checked, false)
      await click(option('Design, UX'))
      assert.deepEqual(rule(config()).value, ['Design, UX'])
      assert.equal(row().querySelector('[role=alert]'), null)
      assert.deepEqual(results(), ['a', 'c'])
    })
  }
})

test('legal API date ranges, exact timestamps, number and boolean rules stay visible and retain their conditions after save and reload', async () => {
  const scenarios: Array<{ rule: DatabaseFilterRule; expected: string[]; inputType?: string }> = [
    { rule: { id: 'range', fieldId: 'due', operator: 'between', value: ['2026-10-01', '2026-10-02'] }, expected: ['a', 'b'] },
    { rule: { id: 'exact', fieldId: 'due', operator: 'equals', value: '2026-10-02T12:30:00.000Z' }, expected: [], inputType: 'text' },
    { rule: { id: 'number', fieldId: 'score', operator: 'greater-than', value: 5 }, expected: ['c'], inputType: 'number' },
    { rule: { id: 'bool', fieldId: 'done', operator: 'equals', value: false }, expected: ['b', 'd'], inputType: 'checkbox' },
    { rule: { id: 'partial', fieldId: 'status', operator: 'contains', value: 'Tod' }, expected: ['a', 'c'] }
  ]
  for (const scenario of scenarios) {
    await withToolbar({ config: view([scenario.rule]) }, async ({ config, saved, row, changes, results, click, text, button, reload }) => {
      assert.equal(changes(), 0)
      assert.deepEqual(rule(config()), scenario.rule)
      assert.equal(conditionSelect(row()).value, scenario.rule.operator)
      assert.deepEqual(results(), scenario.expected)
      if (scenario.inputType) assert.equal((valueControl(row()) as HTMLInputElement).type, scenario.inputType)
      if (scenario.rule.operator === 'between') {
        const inputs = [...row().querySelectorAll<HTMLInputElement>('.dbw-filter-range input')]
        assert.deepEqual(inputs.map(input => input.value), scenario.rule.value)
        assert.ok(inputs.every(input => input.type === 'date'))
      }
      // Save after a separate query edit so the actual Save changes action is enabled.
      const search = row().ownerDocument.querySelector<HTMLInputElement>('.dbw-main-search input')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(search.ownerDocument.defaultView!.HTMLInputElement.prototype, 'value')!.set!.call(search, ' ')
        search.dispatchEvent(new search.ownerDocument.defaultView!.Event('input', { bubbles: true }))
      })
      await click(button(text.saveChanges))
      assert.deepEqual(rule(saved()), scenario.rule)
      await reload()
      assert.deepEqual(rule(config()), scenario.rule)
      assert.deepEqual(results(), scenario.expected)
    })
  }
})

test('filter rows and their value controls have precise Chinese and English accessible names', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    await withToolbar({ locale, config: view([{ id: 'one', fieldId: 'status', operator: 'equals', value: 'Todo' },
      { id: 'two', fieldId: 'tags', operator: 'contains-any', value: ['Design, UX'] },
      { id: 'three', fieldId: 'due', operator: 'between', value: ['2026-10-01', '2026-10-02'] }]) },
    async ({ row, document, text }) => {
      assert.equal(row().getAttribute('aria-label'), `${text.filter} 1`)
      assert.equal(fieldSelect(row()).getAttribute('aria-label'), `${text.filterField} 1`)
      assert.equal(conditionSelect(row()).getAttribute('aria-label'), `${text.operator} 1`)
      assert.equal(valueControl(row()).getAttribute('aria-label'), `${text.value} 1`)
      assert.equal(row(1).querySelector('[role=group]')!.getAttribute('aria-label'), `${text.value} 2`)
      assert.deepEqual([...row(1).querySelectorAll('label')].map(label => label.textContent), fields.find(item => item.id === 'tags')!.options)
      assert.ok(row(2).querySelector(`input[aria-label="${text.value} 3 ${text.rangeStart}"]`))
      assert.ok(row(2).querySelector(`input[aria-label="${text.value} 3 ${text.rangeEnd}"]`))
      assert.equal(document.querySelector('.dbw-main-search input')!.getAttribute('aria-label'), text.search)
    })
  }
})

test('adding a new rule retains an existing OR group and each rule applies independently', async () => {
  const initial = view([{ id: 'old', fieldId: 'status', operator: 'equals', value: 'Todo' }])
  initial.filters.operator = 'or'
  await withToolbar({ config: initial, fields: [fields[1], ...fields.filter(item => item.id !== 'done')] }, async ({ config, results, text, click, button, row, select }) => {
    await click(button(text.addFilter))
    assert.equal(config().filters.operator, 'or')
    assert.equal(rule(config(), 1).operator, 'is-checked')
    await select(conditionSelect(row(1)), 'is-not-checked')
    assert.equal(rule(config()).value, 'Todo')
    assert.deepEqual(results(), ['a', 'b', 'c', 'd', 'e'])
  })
})
