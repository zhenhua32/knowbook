import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, StrictMode } from 'react'
import { JSDOM } from 'jsdom'
import { DocumentNavigationBar } from '../src/renderer/src/components/DocumentNavigationBar'

type FocusCall = { element: HTMLElement; options?: FocusOptions }
type OutlineContext = {
  document: Document; window: JSDOM['window']; selected: number[];
  open: () => Promise<HTMLInputElement>; fill: (input: HTMLInputElement, value: string) => Promise<void>
  focus: (target: HTMLElement) => Promise<void>; click: (target: HTMLButtonElement) => Promise<void>
  focusCalls: FocusCall[]; folded: number[]; openSearch: () => Promise<void>; unmount: () => Promise<void>
}

async function withOutline(isZh: boolean, run: (context: OutlineContext) => Promise<void>, options: { strict?: boolean } = {}) {
  const dom = new JSDOM('<div id="mount"></div><textarea id="editor">Unsaved editor draft</textarea>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const focusCalls: FocusCall[] = [], folded: number[] = []
  const originalFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (focusOptions?: FocusOptions) {
    focusCalls.push({ element: this, options: focusOptions })
    originalFocus.call(this, focusOptions)
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const selected: number[] = []
  let mounted = true, searchOpen = false, searchQuery = '', parentCollapsed = false
  const render = () => {
    const element = createElement(DocumentNavigationBar, {
      isZh, activeIndex: null, progress: 0, reading: false, onToggleReading: () => {},
      onOpenSearch: () => { searchOpen = true; render() },
      outline: { title: isZh ? '文档大纲' : 'Document outline', isZh,
        emptyHeadingTitleLevel1: 'Untitled', emptyHeadingTitleLevel2: 'Untitled',
        filterPlaceholder: isZh ? '筛选标题' : 'Filter headings', noMatchText: isZh ? '没有匹配标题' : 'No matching headings',
        items: [
          { id: 'parent', index: 0, level: 1, title: 'Project plan', hasChildren: true, collapsed: parentCollapsed },
          { id: 'child', index: 1, level: 2, title: '中文路线' },
          { id: 'other', index: 2, level: 1, title: 'Other notes' }
        ], onSelect: index => selected.push(index),
        onToggleFold: index => { folded.push(index); parentCollapsed = !parentCollapsed; render() } },
      search: { isOpen: searchOpen, query: searchQuery, placeholder: isZh ? '查找文档内容' : 'Find in document', noMatchText: 'No matches', items: [],
        onQueryChange: value => { searchQuery = value; render() },
        onClose: () => { searchOpen = false; searchQuery = ''; render() }, onSelect: () => {} }
    })
    root.render(options.strict ? createElement(StrictMode, null, element) : element)
  }
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  try {
    await act(async () => render())
    await run({ document: dom.window.document, window: dom.window, selected, focusCalls, folded, unmount,
      focus: async target => { await act(async () => target.focus()) },
      click: async target => { await act(async () => target.click()) },
      openSearch: async () => {
        // Calling the real click handler opens the real BlockSearchPanel. This
        // deliberately leaves focus in the outline until its input autofocus.
        await act(async () => findButton(dom.window.document).click())
      },
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
    await unmount()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

const toggle = (document: Document) => document.querySelector<HTMLButtonElement>('[aria-controls="document-outline-popover"]')!
const headings = (document: Document) => [...document.querySelectorAll('.toc-item')].map(item => item.textContent)
const findButton = (document: Document) => document.querySelector<HTMLButtonElement>('.document-navigation-bar > button[title]')!
const readButton = (document: Document) => document.querySelector<HTMLButtonElement>('.document-view-toggle')!
const callsTo = (context: OutlineContext, target: HTMLElement) => context.focusCalls.filter(call => call.element === target)

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

test('null-target blur and window blur keep the outline open, while consumed Escape and composition recovery retain normal dismissal', async () => {
  await withOutline(true, async context => {
    const { document, window, open, fill } = context
    const input = await open()
    await fill(input, '路线')
    const relatedTargets: Array<EventTarget | null> = []
    input.addEventListener('blur', event => { relatedTargets.push(event.relatedTarget) })
    await act(async () => input.blur())
    assert.equal(relatedTargets[0], null, 'The real blur has no explicit next focus target')
    assert.equal(toggle(document).getAttribute('aria-expanded'), 'true')
    assert.equal(document.activeElement, document.body)
    await act(async () => window.dispatchEvent(new window.Event('blur')))
    assert.equal(toggle(document).getAttribute('aria-expanded'), 'true')
    assert.equal(document.activeElement, document.body)
    assert.equal(callsTo(context, toggle(document)).length, 0, 'Unknown focus intent must never restore the trigger')
    await context.focus(input)
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

test('explicit focus departure to Find, Read or the editor dismisses the outline and preserves the new focus in both languages', async () => {
  for (const isZh of [false, true]) {
    for (const destination of ['find', 'read', 'editor'] as const) {
      await withOutline(isZh, async context => {
        const { document, selected } = context
        const input = await context.open()
        await context.fill(input, '路线')
        const target = destination === 'find' ? findButton(document) : destination === 'read' ? readButton(document) : document.getElementById('editor')!
        const trigger = toggle(document), before = callsTo(context, trigger).length, callsBefore = context.focusCalls.length
        await context.focus(target)
        assert.equal(document.querySelectorAll('.document-outline-popover').length, 0)
        assert.equal(trigger.getAttribute('aria-expanded'), 'false')
        assert.equal(document.activeElement, target)
        assert.equal(callsTo(context, trigger).length, before)
        assert.equal(context.focusCalls.length, callsBefore + 1, 'The explicit external focus call is the only focus operation')
        assert.deepEqual(selected, [])
        assert.equal(document.querySelector<HTMLTextAreaElement>('#editor')!.value, 'Unsaved editor draft')
      })
    }
  }
})

test('focus moves among the outline filter, trigger, fold and result controls without dismissing the popover', async () => {
  for (const isZh of [false, true]) {
    await withOutline(isZh, async context => {
      const { document, folded, selected } = context
      const input = await context.open()
      const fold = document.querySelector<HTMLButtonElement>('.toc-fold-button')!
      const result = document.querySelector<HTMLButtonElement>('.toc-item-h2')!
      assert.equal(fold.disabled, false)
      for (const target of [fold, toggle(document), result, input]) {
        const before = context.focusCalls.length
        await context.focus(target)
        assert.equal(toggle(document).getAttribute('aria-expanded'), 'true')
        assert.ok(document.querySelector('.document-outline-popover'))
        assert.equal(document.activeElement, target)
        assert.equal(context.focusCalls.length, before + 1)
      }
      await context.focus(fold)
      const beforeClick = context.focusCalls.length
      await context.click(fold)
      assert.deepEqual(folded, [0])
      assert.equal(fold.getAttribute('aria-expanded'), 'false')
      assert.equal(document.activeElement, fold)
      assert.equal(context.focusCalls.length, beforeClick)
      assert.equal(toggle(document).getAttribute('aria-expanded'), 'true')
      await context.focus(input)
      await context.fill(input, '路线')
      assert.deepEqual(headings(document), ['Project plan', '中文路线'])
      assert.equal(document.activeElement, input)
      assert.equal(toggle(document).getAttribute('aria-expanded'), 'true')
      assert.deepEqual(selected, [])
    })
  }
})

test('an explicit external focus departure during composition dismisses without requiring compositionend or stealing editor focus', async () => {
  for (const isZh of [false, true]) {
    await withOutline(isZh, async context => {
      const { document, window, selected } = context
      const input = await context.open()
      await context.fill(input, '路线')
      await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true, data: '中文候选' })))
      const editor = document.querySelector<HTMLTextAreaElement>('#editor')!
      const before = callsTo(context, toggle(document)).length
      await context.focus(editor)
      assert.equal(document.querySelectorAll('.document-outline-popover').length, 0)
      assert.equal(toggle(document).getAttribute('aria-expanded'), 'false')
      assert.equal(document.activeElement, editor)
      assert.equal(editor.value, 'Unsaved editor draft')
      assert.equal(callsTo(context, toggle(document)).length, before)
      assert.deepEqual(selected, [])
    })
  }
})

test('real unmount and StrictMode cleanup never restore an old outline trigger or replay focus after window activation', async () => {
  for (const strict of [false, true]) {
    await withOutline(strict, async context => {
      const { document, window } = context
      const input = await context.open(), trigger = toggle(document)
      assert.equal(document.activeElement, input)
      const before = callsTo(context, trigger).length
      await context.unmount()
      assert.equal(trigger.isConnected, false)
      assert.equal(document.querySelectorAll('.document-outline-popover').length, 0)
      assert.equal(document.activeElement, document.body)
      assert.equal(callsTo(context, trigger).length, before)
      await act(async () => {
        window.dispatchEvent(new window.Event('blur'))
        window.dispatchEvent(new window.Event('focus'))
      })
      assert.equal(callsTo(context, trigger).length, before)
      assert.equal(document.activeElement, document.body)
    }, { strict })
  }
})

test('opening the actual block find panel from the same navigation dismisses the outline when its query input receives focus', async () => {
  for (const isZh of [false, true]) {
    await withOutline(isZh, async context => {
      const { document, selected } = context
      const outlineInput = await context.open(), trigger = toggle(document)
      await context.fill(outlineInput, '路线')
      const before = callsTo(context, trigger).length
      assert.equal(document.activeElement, outlineInput)
      await context.openSearch()
      const search = document.querySelector<HTMLInputElement>('.block-find-input')!
      assert.ok(search, 'The real onOpenSearch handler renders BlockSearchPanel')
      assert.equal(search.getAttribute('aria-label'), isZh ? '查找文档内容' : 'Find in document')
      assert.equal(document.activeElement, search)
      assert.equal(document.querySelectorAll('.document-outline-popover').length, 0)
      assert.equal(trigger.getAttribute('aria-expanded'), 'false')
      assert.equal(callsTo(context, trigger).length, before)
      assert.deepEqual(callsTo(context, search).at(-1)!.options, { preventScroll: true })
      assert.deepEqual(selected, [])
    })
  }
})
