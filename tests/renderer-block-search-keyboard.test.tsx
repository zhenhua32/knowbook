import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, StrictMode, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import { BlockSearchPanel } from '../src/renderer/src/components/BlockSearchPanel'

type Props = ComponentProps<typeof BlockSearchPanel>
const matches: Props['items'] = [
  { index: 4, type: 'paragraph', contentPreview: 'common updated first match' },
  { index: 17, type: 'paragraph', contentPreview: 'common updated second match' },
  { index: 91, type: 'paragraph', contentPreview: 'common updated third match' }
]
type Context = {
  document: Document
  window: JSDOM['window']
  selected: number[]
  queries: string[]
  bubbled: Array<{ key: string; defaultPrevented: boolean }>
  closes: () => number
  patch: (changes: Partial<Props>) => Promise<void>
  focus: (target: HTMLElement) => Promise<void>
  key: (target: HTMLElement, key: string, init?: KeyboardEventInit) => Promise<KeyboardEvent>
  click: (target: HTMLButtonElement) => Promise<void>
  fill: (value: string) => Promise<void>
  composition: (kind: 'compositionstart' | 'compositionend') => Promise<void>
}

async function withSearch(run: (context: Context) => Promise<void>, options: { isZh?: boolean; strict?: boolean; items?: Props['items'] } = {}) {
  const dom = new JSDOM('<div id="mount"></div><button id="outside">Other action</button>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const selected: number[] = [], queries: string[] = [], bubbled: Context['bubbled'] = []
  let closeCount = 0
  const isZh = options.isZh ?? false
  let props: Props = { isOpen: true, isZh, query: 'common', items: options.items ?? matches,
    placeholder: isZh ? '查找文档内容' : 'Find in document', noMatchText: isZh ? '没有匹配内容' : 'No matching blocks',
    onSelect: index => { selected.push(index) },
    onQueryChange: query => { queries.push(query); props = { ...props, query }; render() },
    onClose: () => { closeCount++; props = { ...props, isOpen: false, query: '' }; render() }
  }
  const render = () => {
    const element = createElement(BlockSearchPanel, props)
    root.render(options.strict ? createElement(StrictMode, null, element) : element)
  }
  const bubble = (event: KeyboardEvent) => { bubbled.push({ key: event.key, defaultPrevented: event.defaultPrevented }) }
  dom.window.document.addEventListener('keydown', bubble)
  try {
    await act(async () => render())
    await run({ document: dom.window.document, window: dom.window, selected, queries, bubbled,
      closes: () => closeCount,
      patch: async changes => { await act(async () => { props = { ...props, ...changes }; render() }) },
      focus: async target => { await act(async () => target.focus()) },
      key: async (target, key, init = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        await act(async () => target.dispatchEvent(event))
        return event
      },
      click: async target => { await act(async () => target.click()) },
      fill: async value => { await act(async () => {
        const input = searchInput(dom.window.document)
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      composition: async kind => { await act(async () => searchInput(dom.window.document).dispatchEvent(
        new dom.window.CompositionEvent(kind, { bubbles: true, data: '中文候选' }))) }
    })
  } finally {
    await act(async () => root.unmount())
    dom.window.document.removeEventListener('keydown', bubble)
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

const searchInput = (document: Document) => document.querySelector<HTMLInputElement>('.block-find-input')!
const previous = (document: Document) => document.querySelectorAll<HTMLButtonElement>('.block-find-nav-btn')[0]!
const next = (document: Document) => document.querySelectorAll<HTMLButtonElement>('.block-find-nav-btn')[1]!
const close = (document: Document) => document.querySelector<HTMLButtonElement>('.block-find-close')!
const third = (document: Document) => document.querySelector<HTMLButtonElement>('[data-result-index="2"]')!
const count = (document: Document) => document.querySelector('.block-find-count')?.textContent

test('focused find buttons retain Enter, Shift+Enter, arrows, Space and Tab without selecting a different match or losing focus', async () => {
  for (const isZh of [false, true]) {
    await withSearch(async context => {
      const { document, selected, bubbled } = context
      assert.equal(previous(document).getAttribute('aria-label'), isZh ? '上一个匹配' : 'Previous match')
      assert.equal(next(document).getAttribute('aria-label'), isZh ? '下一个匹配' : 'Next match')
      assert.equal(close(document).getAttribute('aria-label'), isZh ? '关闭查找' : 'Close find')
      for (const target of [previous(document), next(document), close(document), third(document)]) {
        await context.focus(target)
        for (const [key, init] of [
          ['Enter', {}], ['Enter', { shiftKey: true }], ['ArrowDown', {}], ['ArrowUp', {}], [' ', {}], ['Tab', {}]
        ] as const) {
          const event = await context.key(target, key, init)
          assert.equal(event.defaultPrevented, false, `The panel must leave ${key} on this button to its native behavior`)
          assert.equal(document.activeElement, target)
          assert.deepEqual(selected, [])
          assert.equal(context.closes(), 0)
          assert.equal(count(document), '1 / 3')
          assert.deepEqual(bubbled.at(-1), { key, defaultPrevented: false })
        }
      }
      // JSDOM does not activate buttons or move Tab focus from synthetic keydown.
      // This verifies only that the panel leaves those browser behaviors intact.
    }, { isZh })
  }
})

test('input Enter, Shift+Enter and arrows retain first selection, repeated navigation, wraparound and query reset', async () => {
  for (const strict of [false, true]) {
    await withSearch(async context => {
      const { document, selected } = context
      const input = searchInput(document)
      assert.equal(document.activeElement, input)
      for (const [key, init, selectedBlock, matchNumber] of [
        ['Enter', {}, 4, 1], ['Enter', {}, 17, 2], ['Enter', { shiftKey: true }, 4, 1],
        ['ArrowUp', {}, 91, 3], ['ArrowDown', {}, 4, 1], ['Enter', { shiftKey: true }, 91, 3]
      ] as const) {
        const before = selected.length
        assert.equal((await context.key(input, key, init)).defaultPrevented, true)
        assert.equal(selected.length, before + 1)
        assert.equal(selected.at(-1), selectedBlock, 'Search positions must resolve to the original block index')
        assert.equal(count(document), `${matchNumber} / 3`)
        assert.equal(document.activeElement, input)
      }
      await context.fill('updated')
      assert.deepEqual(context.queries, ['updated'])
      assert.equal(input.value, 'updated')
      assert.equal(count(document), '1 / 3')
      assert.equal((await context.key(input, 'Enter')).defaultPrevented, true)
      assert.equal(selected.at(-1), 4, 'A new query resets both position and first-Enter behavior')
      for (const key of [' ', 'Tab']) {
        const before = selected.length
        assert.equal((await context.key(input, key)).defaultPrevented, false)
        assert.equal(selected.length, before)
        assert.deepEqual(context.bubbled.at(-1), { key, defaultPrevented: false })
      }
    }, { strict })
  }
})

test('the unchanged button click handlers select their intended match once and return focus to the query input', async () => {
  await withSearch(async context => {
    const { document, selected } = context
    // Explicit clicks test the existing handlers; they do not simulate Enter activation.
    for (const [target, blockIndex, matchNumber] of [
      [previous(document), 91, 3], [next(document), 4, 1], [third(document), 91, 3]
    ] as const) {
      await context.focus(target)
      const before = selected.length
      await context.click(target)
      assert.equal(selected.length, before + 1)
      assert.equal(selected.at(-1), blockIndex)
      assert.equal(count(document), `${matchNumber} / 3`)
      assert.equal(document.activeElement, searchInput(document))
    }
    await context.click(close(document))
    assert.equal(context.closes(), 1)
    assert.equal(document.querySelector('.block-find-panel'), null)
    assert.deepEqual(selected, [91, 4, 91])
  })
})

test('Escape closes exactly once from the input and every button without reaching an outer keyboard handler', async () => {
  for (const isZh of [false, true]) {
    await withSearch(async context => {
      const { document, selected, bubbled } = context
      const controls = [searchInput, previous, next, close, third]
      for (const getControl of controls) {
        if (!document.querySelector('.block-find-panel')) await context.patch({ isOpen: true, query: 'common' })
        const target = getControl(document)
        await context.focus(target)
        const before = context.closes(), outerBefore = bubbled.length
        assert.equal((await context.key(target, 'Escape')).defaultPrevented, true)
        assert.equal(context.closes(), before + 1)
        assert.equal(bubbled.length, outerBefore)
        assert.equal(document.querySelector('.block-find-panel'), null)
        assert.deepEqual(selected, [])
      }
    }, { isZh })
  }
})

test('empty results consume only input navigation, leave the close button keyboard event intact and still support Escape', async () => {
  for (const isZh of [false, true]) {
    await withSearch(async context => {
      const { document, selected } = context
      const input = searchInput(document)
      assert.equal(count(document), isZh ? '没有匹配内容' : 'No matching blocks')
      assert.equal(previous(document).disabled, true)
      assert.equal(next(document).disabled, true)
      assert.equal(close(document).disabled, false)
      assert.equal(document.querySelectorAll('.block-find-result').length, 0)
      for (const [key, init] of [['Enter', {}], ['Enter', { shiftKey: true }], ['ArrowUp', {}], ['ArrowDown', {}]] as const) {
        assert.equal((await context.key(input, key, init)).defaultPrevented, true)
        assert.deepEqual(selected, [])
        assert.equal(document.activeElement, input)
      }
      const closeButton = close(document)
      await context.focus(closeButton)
      assert.equal((await context.key(closeButton, 'Enter')).defaultPrevented, false)
      assert.equal((await context.key(closeButton, ' ')).defaultPrevented, false)
      assert.equal(context.closes(), 0, 'Synthetic keydown does not perform native activation in JSDOM')
      assert.equal(document.activeElement, closeButton)
      assert.equal((await context.key(closeButton, 'Escape')).defaultPrevented, true)
      assert.equal(context.closes(), 1)
      assert.equal(document.querySelector('.block-find-panel'), null)
    }, { isZh, items: [] })
  }
})

test('lifecycle composition, native composing and legacy 229 preserve candidate keys without navigating or dismissing find', async () => {
  for (const isZh of [false, true]) {
    for (const source of ['lifecycle', 'native', '229'] as const) {
      await withSearch(async context => {
        const { document, selected, bubbled } = context
        const input = searchInput(document)
        const init = source === 'native' ? { isComposing: true } : source === '229' ? { keyCode: 229 } : {}
        if (source === 'lifecycle') await context.composition('compositionstart')
        for (const key of ['Enter', 'ArrowUp', 'ArrowDown', 'Escape']) {
          assert.equal((await context.key(input, key, init)).defaultPrevented, false, 'Candidate keys must retain their native default behavior')
          assert.deepEqual(selected, [])
          assert.equal(context.closes(), 0)
          assert.equal(document.activeElement, input)
          assert.equal(input.value, 'common')
          assert.equal(count(document), '1 / 3')
          assert.equal(bubbled.length, 0, 'Candidate keys must not trigger an outer app shortcut')
        }
        if (source === 'lifecycle') await context.composition('compositionend')
        assert.equal((await context.key(input, 'Enter')).defaultPrevented, true)
        assert.deepEqual(selected, [4])
        assert.equal((await context.key(input, 'Escape')).defaultPrevented, true)
        assert.equal(context.closes(), 1)
      }, { isZh })
    }
  }
})

test('blur clears unfinished composition so button keys and later input navigation work without waiting for compositionend', async () => {
  await withSearch(async context => {
    const { document, selected } = context
    const input = searchInput(document)
    await context.composition('compositionstart')
    const closeButton = close(document)
    await context.focus(closeButton)
    const before = context.bubbled.length
    for (const key of ['Enter', 'ArrowUp', 'ArrowDown', ' ']) {
      assert.equal((await context.key(closeButton, key)).defaultPrevented, false)
      assert.equal(document.activeElement, closeButton)
      assert.deepEqual(selected, [])
    }
    assert.equal(context.bubbled.length, before + 4, 'Blur must stop treating button keys as composition events')
    await context.focus(input)
    assert.equal((await context.key(input, 'Enter')).defaultPrevented, true)
    assert.deepEqual(selected, [4])
    await context.composition('compositionstart')
    await context.focus(document.getElementById('outside')!)
    await context.focus(closeButton)
    assert.equal((await context.key(closeButton, 'Escape')).defaultPrevented, true)
    assert.equal(context.closes(), 1)
    assert.deepEqual(selected, [4])
  })
})
