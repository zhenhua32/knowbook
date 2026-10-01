import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { DocumentNavigationBar } from '../src/renderer/src/components/DocumentNavigationBar'

async function withOutline(isZh: boolean, run: (context: {
  document: Document; window: JSDOM['window']; selected: number[];
  open: () => Promise<HTMLInputElement>; fill: (input: HTMLInputElement, value: string) => Promise<void>
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
  const selected: number[] = []
  try {
    await act(async () => root.render(createElement(DocumentNavigationBar, {
      isZh, activeIndex: null, progress: 0, reading: false, onToggleReading: () => {}, onOpenSearch: () => {},
      outline: { title: isZh ? '文档大纲' : 'Document outline', isZh,
        emptyHeadingTitleLevel1: 'Untitled', emptyHeadingTitleLevel2: 'Untitled',
        filterPlaceholder: isZh ? '筛选标题' : 'Filter headings', noMatchText: isZh ? '没有匹配标题' : 'No matching headings',
        items: [
          { id: 'parent', index: 0, level: 1, title: 'Project plan' },
          { id: 'child', index: 1, level: 2, title: '中文路线' },
          { id: 'other', index: 2, level: 1, title: 'Other notes' }
        ], onSelect: index => selected.push(index) },
      search: { isOpen: false, query: '', placeholder: 'Find', noMatchText: 'No matches', items: [],
        onQueryChange: () => {}, onClose: () => {}, onSelect: () => {} }
    })))
    await run({ document: dom.window.document, window: dom.window, selected,
      open: async () => {
        await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[aria-controls="document-outline-popover"]')!.click())
        const input = dom.window.document.querySelector<HTMLInputElement>('.outline-filter')!
        await act(async () => input.focus())
        return input
      },
      fill: async (input, value) => {
        await act(async () => {
          Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })
      }
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

const toggle = (document: Document) => document.querySelector<HTMLButtonElement>('[aria-controls="document-outline-popover"]')!
const headings = (document: Document) => [...document.querySelectorAll('.toc-item')].map(item => item.textContent)

test('the real outline filter retains matched parents and selecting a result restores the toggle in both languages', async () => {
  for (const isZh of [true, false]) {
    await withOutline(isZh, async ({ document, selected, open, fill }) => {
      const input = await open()
      assert.equal(input.getAttribute('aria-label'), isZh ? '筛选标题' : 'Filter headings')
      await fill(input, '路线')
      assert.deepEqual(headings(document), ['Project plan', '中文路线'])
      await fill(input, 'no such heading')
      assert.deepEqual(headings(document), [])
      assert.equal(document.querySelector('.document-outline-panel .empty-text')?.textContent, isZh ? '没有匹配标题' : 'No matching headings')
      await fill(input, '路线')
      await act(async () => document.querySelector<HTMLButtonElement>('.toc-item-h2')!.click())
      assert.deepEqual(selected, [1])
      assert.equal(document.querySelector('.document-outline-popover'), null)
      assert.equal(document.activeElement, toggle(document))
    })
  }
})

test('composition lifecycle Escape preserves the outline filter, candidates and focus until composition ends', async () => {
  await withOutline(true, async ({ document, window, selected, open, fill }) => {
    const input = await open()
    await fill(input, '路线')
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
    const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => input.dispatchEvent(escape))
    assert.equal(escape.defaultPrevented, false, 'the IME still receives its native candidate cancellation')
    assert.equal(toggle(document).getAttribute('aria-expanded'), 'true')
    assert.equal(document.activeElement, input)
    assert.equal(input.value, '路线')
    assert.deepEqual(headings(document), ['Project plan', '中文路线'])
    assert.deepEqual(selected, [])
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
    const normalEscape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => input.dispatchEvent(normalEscape))
    assert.equal(normalEscape.defaultPrevented, true)
    assert.equal(toggle(document).getAttribute('aria-expanded'), 'false')
    assert.equal(document.activeElement, toggle(document))
  })
})

test('native composing and legacy 229 Escape cannot close the outline even without a compositionstart event', async () => {
  await withOutline(false, async ({ document, window, open, fill }) => {
    const input = await open()
    await fill(input, '路线')
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...options })
      await act(async () => input.dispatchEvent(escape))
      assert.equal(escape.defaultPrevented, false)
      assert.equal(document.activeElement, input)
      assert.equal(input.value, '路线')
      assert.equal(toggle(document).getAttribute('aria-expanded'), 'true')
      assert.deepEqual(headings(document), ['Project plan', '中文路线'])
    }
    await act(async () => toggle(document).focus())
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...options })
      await act(async () => toggle(document).dispatchEvent(escape))
      assert.equal(escape.defaultPrevented, false)
      assert.equal(toggle(document).getAttribute('aria-expanded'), 'true', 'the parent has its own native IME guard')
    }
  })
})

test('a consumed Escape is ignored and blur clears a stale composition lifecycle before normal dismissal', async () => {
  await withOutline(true, async ({ document, window, open, fill }) => {
    const input = await open()
    await fill(input, '路线')
    const consumed = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    consumed.preventDefault()
    await act(async () => input.dispatchEvent(consumed))
    assert.equal(toggle(document).getAttribute('aria-expanded'), 'true')
    assert.equal(document.activeElement, input)
    assert.equal(input.value, '路线')
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
    await act(async () => toggle(document).focus())
    await act(async () => input.focus())
    await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    assert.equal(toggle(document).getAttribute('aria-expanded'), 'false')
    assert.equal(document.activeElement, toggle(document))
  })
})
