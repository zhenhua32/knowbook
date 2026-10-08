import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseField, DatabaseRecord } from '../src/shared/contracts'
import { DatabaseTableView } from '../src/renderer/src/features/database/components/DatabaseTableView'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

const fields: DatabaseField[] = [
  { id: '__title__', name: 'Title', type: 'text', role: 'title', options: [], editable: false, hideable: false, deletable: false, sortOrder: 0 },
  { id: 'notes', name: 'Notes', type: 'text', role: 'property', options: [], editable: true, hideable: true, deletable: true, sortOrder: 1 }
]
const records: DatabaseRecord[] = Array.from({ length: 1000 }, (_, index) => ({ id: `record-${index}`, databaseId: 'db',
  title: `Record ${index}`, documentId: null, fieldValues: { notes: `Notes ${index}` }, createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
const rows = (document: Document) => [...document.querySelectorAll<HTMLTableRowElement>('tbody tr:not(.dbw-virtual-spacer)')]
const titles = (document: Document) => rows(document).map(row => row.querySelector('strong')!.textContent)
const spacers = (document: Document) => [...document.querySelectorAll<HTMLElement>('.dbw-virtual-spacer td')].map(cell => Number.parseFloat(cell.style.height))

async function withViewport(run: (context: {
  document: Document; scroll: () => HTMLDivElement;
  measurements: { count: number; top: number }[];
  render: (records: DatabaseRecord[]) => Promise<void>;
  move: (top: number, left?: number) => Promise<void>;
  resize: (height: number) => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const observers = new Set<() => void>()
  const measurements: { count: number; top: number }[] = []
  let viewportHeight = 600
  class TestResizeObserver {
    private readonly update: () => void
    constructor(callback: ResizeObserverCallback) { this.update = () => callback([], this as unknown as ResizeObserver) }
    observe() { observers.add(this.update) }
    unobserve() { observers.delete(this.update) }
    disconnect() { observers.delete(this.update) }
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true,
    get() { return (this as HTMLElement).classList.contains('dbw-table-scroll') ? viewportHeight : 0 } })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true,
    get() {
      const element = this as HTMLElement
      if (!element.classList.contains('dbw-table-scroll')) return 0
      const count = element.querySelectorAll('tbody tr:not(.dbw-virtual-spacer)').length
      measurements.push({ count, top: element.scrollTop })
      const padding = [...element.querySelectorAll<HTMLElement>('.dbw-virtual-spacer td')]
        .reduce((total, cell) => total + Number.parseFloat(cell.style.height), 0)
      return 42 + count * 56 + padding
    } })
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.tagName === 'THEAD' ? { x: 0, y: 0, top: 0, bottom: 42, left: 0, right: 0, width: 0, height: 42, toJSON: () => ({ height: 42 }) } as DOMRect
      : originalRect.call(this)
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, ResizeObserver: TestResizeObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const props: Omit<ComponentProps<typeof DatabaseTableView>, 'records'> = {
    fields, documents: [], columnWidths: {}, selectedIds: new Set(), sourceKind: 'custom', text: getDatabaseWorkspaceText('en-US'),
    onColumnWidthChange: () => {}, onOpenDocument: () => {}, onOpenRecord: () => {}, onSelect: () => {},
    onUpdateDocument: async () => {}, onUpdateValue: async () => {}
  }
  const scroll = () => dom.window.document.querySelector<HTMLDivElement>('.dbw-table-scroll')!
  try {
    await run({ document: dom.window.document, scroll, measurements,
      render: async records => { await act(async () => root.render(createElement(DatabaseTableView, { ...props, records }))) },
      move: async (top, left) => {
        await act(async () => {
          scroll().scrollTop = top
          if (left !== undefined) scroll().scrollLeft = left
          scroll().dispatchEvent(new dom.window.Event('scroll', { bubbles: true }))
        })
      },
      resize: async height => { await act(async () => { viewportHeight = height; observers.forEach(update => update()) }) }
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

test('deep scrolling then filtering 1000 records to five renders results before layout and synchronizes both the viewport and recovery', async () => {
  await withViewport(async ({ document, scroll, measurements, render, move }) => {
    await render(records)
    await move(12000, 175)
    assert.ok(rows(document).length > 0)
    assert.equal(scroll().scrollTop, 12000)
    measurements.length = 0
    await render(records.slice(0, 5))
    assert.equal(measurements[0].count, 5, 'the first committed result slice is valid before layout repairs scrollTop')
    assert.deepEqual(titles(document), ['Record 0', 'Record 1', 'Record 2', 'Record 3', 'Record 4'])
    assert.equal(scroll().scrollTop, 0)
    assert.equal(scroll().scrollLeft, 175)
    assert.deepEqual(spacers(document), [])
    await render([])
    assert.equal(rows(document).length, 0)
    assert.deepEqual(spacers(document), [])
    assert.equal(scroll().scrollTop, 0)
    assert.equal(scroll().scrollLeft, 175)
    await render(records)
    assert.equal(titles(document)[0], 'Record 0')
    assert.equal(scroll().scrollTop, 0, 'returning to all results keeps the recovered position')
    assert.equal(scroll().scrollLeft, 175)
    assert.ok(rows(document).length < 40)
  })
})

test('a larger viewport clamps an old bottom position and still includes the last record with nonnegative spacers', async () => {
  await withViewport(async ({ document, scroll, render, move, resize }) => {
    await render(records)
    await move(56042 - 600, 245)
    assert.equal(titles(document).at(-1), 'Record 999')
    await resize(1200)
    assert.equal(scroll().scrollTop, 56042 - 1200)
    assert.equal(scroll().scrollLeft, 245)
    assert.equal(titles(document).at(-1), 'Record 999')
    assert.ok(rows(document).length > 0)
    assert.ok(spacers(document).every(height => Number.isFinite(height) && height >= 0))
    await resize(70000)
    assert.equal(scroll().scrollTop, 0)
    assert.equal(rows(document).length, 1000)
    assert.deepEqual(spacers(document), [])
    assert.equal(scroll().scrollLeft, 245)
  })
})

test('fresh objects with the same record IDs retain scroll position, input identity and focus during data refresh', async () => {
  await withViewport(async ({ document, scroll, render, move }) => {
    await render(records)
    await move(12000, 195)
    const firstTitle = titles(document)[0]
    const input = rows(document)[0].querySelector<HTMLInputElement>('input[aria-label="Notes"]')!
    await act(async () => input.focus())
    await render(records.map(record => ({ ...record, fieldValues: { ...record.fieldValues }, updatedAt: '2026-10-02' })))
    assert.equal(scroll().scrollTop, 12000)
    assert.equal(scroll().scrollLeft, 195)
    assert.equal(titles(document)[0], firstTitle)
    assert.equal(rows(document)[0].querySelector('input[aria-label="Notes"]'), input)
    assert.equal(document.activeElement, input)
  })
})

test('reordering or replacing a same-sized result set retains a valid position instead of forcing a jump to the top', async () => {
  await withViewport(async ({ document, scroll, render, move }) => {
    await render(records)
    await move(12000, 80)
    const firstRecordIndex = Number(titles(document)[0]!.replace('Record ', ''))
    await render([...records].reverse())
    assert.equal(scroll().scrollTop, 12000)
    assert.equal(scroll().scrollLeft, 80)
    assert.ok(rows(document).length > 0)
    assert.equal(titles(document)[0], `Record ${records.length - 1 - firstRecordIndex}`)
    await render(records.map(record => ({ ...record, id: `other-${record.id}`, title: `Other ${record.title}` })))
    assert.equal(scroll().scrollTop, 12000)
    assert.equal(titles(document)[0], `Other Record ${firstRecordIndex}`)
    assert.ok(spacers(document).every(height => height >= 0))
  })
})

test('overrunning the last interval and reducing to a shorter nonempty list never produces a blank slice or loses horizontal offset', async () => {
  await withViewport(async ({ document, scroll, render, move }) => {
    await render(records)
    await move(1_000_000, 320)
    assert.equal(scroll().scrollTop, 56042 - 600)
    assert.equal(titles(document).at(-1), 'Record 999')
    await render(records.slice(0, 20))
    assert.equal(scroll().scrollTop, 1162 - 600)
    assert.equal(scroll().scrollLeft, 320)
    assert.equal(titles(document).at(-1), 'Record 19')
    assert.ok(rows(document).length > 0)
    assert.ok(spacers(document).every(height => height >= 0))
    await move(-20)
    assert.equal(scroll().scrollTop, 0)
    assert.equal(titles(document)[0], 'Record 0')
    assert.equal(scroll().scrollLeft, 320)
  })
})
