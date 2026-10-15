import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseEmbedSnapshot, DatabaseSavedView } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { DATABASE_VIEW_MAX_BYTES, serializeDatabaseViewPayload, validateDatabaseViewConfig, type DatabaseViewBlockPayloadV1 } from '../src/shared/databaseViewBlock'
import { waitForRenderer } from './helpers/renderer-async'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
}`)}`, import.meta.url)
const { default: DocumentDatabaseViewPicker } = await import('../src/renderer/src/components/DocumentDatabaseViewPicker')
const config = () => createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title])
const saved = (id: string, viewConfig = config()): DatabaseSavedView => ({ id, databaseId: 'source', name: id,
  config: viewConfig, configVersion: 1, filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table',
  sortOrder: 0, createdAt: '2026-10-01', updatedAt: '2026-10-01' })

test('the actual source picker rejects a valid maximum-sized config whose full payload exceeds the byte limit, then recovers without document mutation', async () => {
  const oversizedConfig = config()
  oversizedConfig.query = 'x'.repeat(DATABASE_VIEW_MAX_BYTES - new TextEncoder().encode(JSON.stringify(oversizedConfig)).byteLength)
  assert.equal(new TextEncoder().encode(JSON.stringify(oversizedConfig)).byteLength, DATABASE_VIEW_MAX_BYTES)
  assert.doesNotThrow(() => validateDatabaseViewConfig(oversizedConfig), 'the source configuration itself is valid at its exact supported byte limit')
  assert.throws(() => serializeDatabaseViewPayload({ version: 1, databaseId: 'source', viewId: 'oversized', config: oversizedConfig }), 'only the additional payload envelope makes this source view too large to embed')
  const malformed = { ...config(), filters: { operator: 'and', rules: [{ id: 'broken', fieldId: DATABASE_SYSTEM_FIELD_IDS.title, operator: 'unexpected' }] } } as unknown as DatabaseSavedView['config']
  const snapshot: Extract<DatabaseEmbedSnapshot, { status: 'ready' }> = { status: 'ready', database: { id: 'source', name: 'Real source',
    kind: 'custom', description: '', createdAt: '2026-10-01', updatedAt: '2026-10-01' }, columns: [], entities: [], catalogDocuments: [],
    savedViews: [saved('oversized', oversizedConfig), saved('malformed', malformed), saved('normal')] }
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const mutations = new Set<() => void>(), selected: DatabaseViewBlockPayloadV1[] = []
  const captures = () => selected.slice()
  Object.defineProperty(dom.window, 'knowbook', { value: { getDatabases: async () => [snapshot.database],
    getDatabaseEmbedSnapshot: async () => structuredClone(snapshot),
    onWorkspaceMutated: (listener: () => void) => { mutations.add(listener); return () => mutations.delete(listener) } } })
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  const select = async (element: HTMLSelectElement, value: string) => { await act(async () => {
    element.value = value; element.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  }) }
  const insert = () => [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Insert view')!
  const alert = () => dom.window.document.querySelector('[role="alert"]')?.textContent ?? ''
  const assertVisibleControlLabels = (names: string[]) => {
    const controls = [...dom.window.document.querySelectorAll('select')]
    assert.equal(controls.length, names.length)
    const ids = new Set<string>()
    controls.forEach((control, index) => {
      const labelledBy = control.getAttribute('aria-labelledby'); assert.ok(labelledBy)
      assert.equal(labelledBy.trim().split(/\s+/).length, 1, 'the control name must reference only its visible label, excluding option text')
      const label = dom.window.document.getElementById(labelledBy); assert.ok(label)
      assert.equal(label.textContent, names[index]); assert.equal(label.tagName, 'SPAN')
      assert.equal(label.closest('label'), control.labels?.[0], 'the visible label and the native select must remain associated')
      assert.equal(label.querySelector('option'), null)
      assert.ok(!ids.has(labelledBy), 'source and saved-view controls require distinct label identities'); ids.add(labelledBy)
      assert.ok(control.options.length > 1, 'real choices are present while the exact label remains stable')
    })
  }
  try {
    await act(async () => root.render(createElement(DocumentDatabaseViewPicker, { isZh: false,
      onCancel: () => {}, onSelect: payload => { selected.push(payload); return true } })))
    await waitForRenderer(() => Boolean(dom.window.document.querySelector('select')), 'source catalog must load')
    assertVisibleControlLabels(['Source database'])
    await select(dom.window.document.querySelector('select')!, 'source')
    await waitForRenderer(() => dom.window.document.querySelectorAll('select').length === 2, 'source saved views must load')
    assertVisibleControlLabels(['Source database', 'Source saved view'])
    const view = () => dom.window.document.querySelectorAll<HTMLSelectElement>('select')[1]
    await select(view(), 'oversized'); await act(async () => insert().click())
    assert.match(alert(), /configuration is invalid or too large/); assert.deepEqual(captures(), [])
    await select(view(), 'malformed'); assert.equal(alert(), '')
    await act(async () => insert().click()); assert.match(alert(), /configuration is invalid or too large/); assert.deepEqual(captures(), [])
    snapshot.savedViews[1] = saved('malformed')
    await act(async () => mutations.forEach(notify => notify()))
    await act(async () => insert().click())
    assert.equal(alert(), ''); assert.equal(captures().length, 1); assert.equal(captures()[0].viewId, 'malformed')
    assert.doesNotThrow(() => serializeDatabaseViewPayload(captures()[0]))
    await select(view(), ''); await act(async () => insert().click())
    assert.equal(captures().length, 2); assert.equal(captures()[1].viewId, null); assert.equal(alert(), '')
    await act(async () => root.render(createElement(DocumentDatabaseViewPicker, { isZh: true,
      onCancel: () => {}, onSelect: payload => { selected.push(payload); return true } })))
    assertVisibleControlLabels(['数据库来源', '来源保存视图'])
  } finally {
    await act(async () => root.unmount()); assert.equal(mutations.size, 0)
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  }
})
