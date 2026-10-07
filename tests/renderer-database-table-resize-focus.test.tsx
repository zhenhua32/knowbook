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
  render: (records: DatabaseRecord[]) => Promise<void>;
  move: (top: number, left?: number) => Promise<void>;
  resize: (height: number) => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const observers = new Set<() => void>()
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
      const padding = [...element.querySelectorAll<HTMLElement>('.dbw-virtual-spacer td')]
        .reduce((total, cell) => total + Number.parseFloat(cell.style.height), 0)
      return 42 + count * 64 + padding
    } })
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const rectangle = (top: number, height: number) => ({
      x: 0, y: top, top, bottom: top + height, left: 0, right: 700, width: 700, height,
      toJSON: () => ({ top, height })
    }) as DOMRect
    if (this.classList.contains('dbw-table-scroll')) return rectangle(100, viewportHeight)
    if (this.tagName === 'THEAD') return rectangle(100, 42)
    const row = this.closest<HTMLTableRowElement>('tbody tr:not(.dbw-virtual-spacer)')
    const port = row?.closest<HTMLElement>('.dbw-table-scroll')
    if (row && port && this.tagName === 'INPUT') {
      const bodyRows = [...row.parentElement!.querySelectorAll<HTMLTableRowElement>('tr:not(.dbw-virtual-spacer)')]
      const first = row.parentElement!.firstElementChild
      const before = first?.classList.contains('dbw-virtual-spacer')
        ? Number.parseFloat(first.querySelector<HTMLElement>('td')!.style.height) : 0
      return rectangle(100 + 42 + before + bodyRows.indexOf(row) * 64 + 16 - port.scrollTop, 32)
    }
    return originalRect.call(this)
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
    await run({ document: dom.window.document, scroll,
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

test('shrinking a viewport reveals its focused bottom text cell before trimming the virtual slice and preserves its selection', async () => {
  await withViewport(async ({ document, scroll, render, move, resize }) => {
    await render(records)
    await resize(1200)
    await move(64042 - 1200, 245)
    const input = rows(document).at(-1)!.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!
    const node = input
    await act(async () => {
      input.focus()
      input.setSelectionRange(1, 5, 'backward')
    })
    const value = input.value
    const oldTop = scroll().scrollTop
    await resize(300)
    assert.equal(document.activeElement, node, 'the focused row must not be removed by the first shortened virtual slice')
    assert.equal(rows(document).at(-1)!.querySelector('input[aria-label="Notes"]'), node)
    assert.equal(node.isConnected, true)
    assert.equal(node.value, value)
    assert.deepEqual([node.selectionStart, node.selectionEnd, node.selectionDirection], [1, 5, 'backward'])
    assert.ok(scroll().scrollTop > oldTop, 'only the table scroll position should reveal the cell below the new bottom edge')
    assert.equal(scroll().scrollLeft, 245)
    const control = node.getBoundingClientRect(), port = scroll().getBoundingClientRect()
    assert.ok(control.top >= port.top + 42 && control.bottom <= port.top + scroll().clientHeight,
      'the same cell is visible below the sticky header and above the new viewport bottom')
    assert.equal(titles(document).at(-1), 'Record 999')
    assert.ok(spacers(document).every(height => Number.isFinite(height) && height >= 0))
    await resize(1200)
    assert.equal(scroll().scrollTop, 64042 - 1200, 'growing the viewport still applies the existing bottom clamp')
    assert.equal(scroll().scrollLeft, 245)
    assert.equal(document.activeElement, node)
    assert.equal(rows(document).at(-1)!.querySelector('input[aria-label="Notes"]'), node)
    assert.deepEqual([node.selectionStart, node.selectionEnd, node.selectionDirection], [1, 5, 'backward'])
  })
})

test('ordinary scrolling and unchanged resize observations do not pull back to an old focused cell, and outside focus does not anchor a shrink', async () => {
  await withViewport(async ({ document, scroll, render, move, resize }) => {
    await render(records)
    await move(12000, 195)
    const input = rows(document)[10].querySelector<HTMLInputElement>('input[aria-label="Notes"]')!
    await act(async () => input.focus())
    await move(12400)
    assert.equal(document.activeElement, input)
    assert.equal(scroll().scrollTop, 12400, 'a user scroll must not be reversed merely because an old cell retains focus')
    await resize(600)
    assert.equal(scroll().scrollTop, 12400, 'an observer callback with unchanged measurements must not reposition the table')
    const outside = document.createElement('input')
    document.body.append(outside)
    await act(async () => outside.focus())
    await resize(300)
    assert.equal(document.activeElement, outside)
    assert.equal(scroll().scrollTop, 12400, 'focus outside the table does not give an old virtual row a scroll anchor')
    assert.equal(scroll().scrollLeft, 195)
    assert.ok(rows(document).length > 0)
    assert.ok(spacers(document).every(height => Number.isFinite(height) && height >= 0))
  })
})
