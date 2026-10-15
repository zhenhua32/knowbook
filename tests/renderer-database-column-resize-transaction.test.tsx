import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseField, DatabaseRecord } from '../src/shared/contracts'
import { DatabaseTableView } from '../src/renderer/src/features/database/components/DatabaseTableView'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

const fields: DatabaseField[] = [{ id: 'notes', name: 'Notes', type: 'text', role: 'property', options: [],
  editable: true, hideable: true, deletable: true, sortOrder: 0 }]
const records: DatabaseRecord[] = [{ id: 'record', databaseId: 'source', title: 'Record', documentId: null,
  fieldValues: { notes: 'Value' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' }]
async function withTable(run: (api: {
  window: JSDOM['window']; document: Document; separator: () => HTMLElement; writes: Array<[string, number]>
  event: (target: EventTarget, event: Event) => Promise<void>; rerender: (patch: Partial<ComponentProps<typeof DatabaseTableView>>) => Promise<void>
  unmount: () => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const writes: Array<[string, number]> = []
  let props: ComponentProps<typeof DatabaseTableView> = { fields, records, documents: [], columnWidths: {}, selectedIds: new Set(), sourceKind: 'custom',
    text: getDatabaseWorkspaceText('en-US'), onColumnWidthChange: (id, width) => writes.push([id, width]), onSelect: () => {},
    onOpenDocument: () => {}, onOpenRecord: () => {}, onUpdateDocument: async () => {}, onUpdateValue: async () => {} }
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  let mounted = true
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()) } }
  try {
    await act(async () => root.render(createElement(DatabaseTableView, props)))
    await run({ window: dom.window, document: dom.window.document, writes,
      separator: () => dom.window.document.querySelector<HTMLElement>('[role="separator"]')!, unmount,
      event: async (target, event) => { await act(async () => { target.dispatchEvent(event) }) },
      rerender: async patch => { props = { ...props, ...patch }; await act(async () => root.render(createElement(DatabaseTableView, props))) }
    })
  } finally {
    await unmount()
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  }
}

test('column resize previews locally, commits once on release and cancels on Escape, blur, source replacement and unmount', async () => {
  await withTable(async ({ window, separator, writes, event, rerender, unmount }) => {
    const begin = async () => { await event(separator(), new window.MouseEvent('mousedown', { bubbles: true, clientX: 100 })); await event(window, new window.MouseEvent('mousemove', { clientX: 160 })) }
    await begin(); assert.equal(separator().getAttribute('aria-valuenow'), '240'); assert.deepEqual(writes, [])
    await event(window, new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true })); assert.equal(separator().getAttribute('aria-valuenow'), '180')
    await event(window, new window.MouseEvent('mouseup')); assert.deepEqual(writes, [])
    await begin(); await event(window, new window.Event('blur')); await event(window, new window.MouseEvent('mouseup')); assert.deepEqual(writes, [])
    await begin(); await rerender({ fields: fields.map(field => ({ ...field })) }); await event(window, new window.MouseEvent('mouseup')); assert.deepEqual(writes, [])
    await begin(); await event(window, new window.MouseEvent('mouseup')); assert.deepEqual(writes, [['notes', 240]])
    await event(window, new window.MouseEvent('mouseup')); assert.deepEqual(writes, [['notes', 240]])
    await begin(); await unmount(); await event(window, new window.MouseEvent('mouseup')); assert.deepEqual(writes, [['notes', 240]])
  })
})

test('column width keyboard actions stay bounded and reading mode rejects all resize entry points', async () => {
  await withTable(async ({ window, separator, writes, event, rerender }) => {
    for (const key of ['ArrowRight', 'Home', 'End']) await event(separator(), new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    assert.deepEqual(writes, [['notes', 190], ['notes', 80], ['notes', 1200]])
    await rerender({ readOnly: true }); assert.equal(separator().tabIndex, -1)
    await event(separator(), new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await event(separator(), new window.MouseEvent('dblclick', { bubbles: true }))
    await event(separator(), new window.MouseEvent('mousedown', { bubbles: true, clientX: 100 }))
    await event(window, new window.MouseEvent('mousemove', { clientX: 200 })); await event(window, new window.MouseEvent('mouseup'))
    assert.equal(writes.length, 3)
  })
})
