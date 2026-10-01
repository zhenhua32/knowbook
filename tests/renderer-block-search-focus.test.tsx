import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, StrictMode, Suspense, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import { DocumentNavigationBar } from '../src/renderer/src/components/DocumentNavigationBar'

type Props = ComponentProps<typeof DocumentNavigationBar>
type FocusCall = { element: HTMLElement; options?: FocusOptions }
type Context = {
  document: Document
  window: JSDOM['window']
  focusCalls: FocusCall[]
  selected: number[]
  open: () => Promise<void>
  setOpen: (open: boolean) => Promise<void>
  setQuery: (query: string) => Promise<void>
  setLanguage: (isZh: boolean) => Promise<void>
  route: (options: { visible?: boolean; documentId?: string }) => Promise<void>
  key: (target: HTMLElement, key: string, init?: KeyboardEventInit) => Promise<KeyboardEvent>
  focus: (target: HTMLElement) => Promise<void>
  click: (target: HTMLButtonElement) => Promise<void>
  pointer: (target: HTMLElement) => Promise<void>
  setForeground: (foreground: boolean) => void
  blurWindow: () => Promise<void>
  listenerCounts: () => { focusin: number; pointerdown: number; blur: number }
  unmount: () => Promise<void>
  suspend: () => Promise<void>
  reveal: () => Promise<void>
}

async function withNavigation(run: (context: Context) => Promise<void>, options: { open?: boolean; strict?: boolean; isZh?: boolean; suspense?: boolean; secondNavigation?: boolean } = {}) {
  const dom = new JSDOM('<div id="mount"></div><input id="outside" aria-label="Other field"><div id="blank">Outside pointer target</div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const focusCalls: FocusCall[] = [], selected: number[] = []
  let foreground = true
  Object.defineProperty(dom.window.document, 'hasFocus', { value: () => foreground })
  const originalFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (focusOptions?: FocusOptions) {
    focusCalls.push({ element: this, options: focusOptions })
    originalFocus.call(this, focusOptions)
  }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    if (!this.isConnected || this.hasAttribute('data-no-rect')) return [] as unknown as DOMRectList
    for (let element: HTMLElement | null = this; element; element = element.parentElement) {
      const style = dom.window.getComputedStyle(element)
      if (element.matches('[hidden], [inert], [aria-hidden="true"]') || style.display === 'none'
        || style.visibility === 'hidden' || style.visibility === 'collapse') return [] as unknown as DOMRectList
    }
    return [new dom.window.DOMRect(0, 0, 240, 36)] as unknown as DOMRectList
  }
  const focusListeners = new Set<unknown>(), pointerListeners = new Set<unknown>(), blurListeners = new Set<unknown>()
  const addDocument = dom.window.document.addEventListener.bind(dom.window.document)
  const removeDocument = dom.window.document.removeEventListener.bind(dom.window.document)
  dom.window.document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, listenerOptions?: boolean | AddEventListenerOptions) => {
    if (!listener) return
    if (type === 'focusin') focusListeners.add(listener)
    if (type === 'pointerdown') pointerListeners.add(listener)
    addDocument(type, listener, listenerOptions)
  }) as typeof dom.window.document.addEventListener
  dom.window.document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, listenerOptions?: boolean | EventListenerOptions) => {
    if (!listener) return
    if (type === 'focusin') focusListeners.delete(listener)
    if (type === 'pointerdown') pointerListeners.delete(listener)
    removeDocument(type, listener, listenerOptions)
  }) as typeof dom.window.document.removeEventListener
  const addWindow = dom.window.addEventListener.bind(dom.window)
  const removeWindow = dom.window.removeEventListener.bind(dom.window)
  dom.window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, listenerOptions?: boolean | AddEventListenerOptions) => {
    if (!listener) return
    if (type === 'blur') blurListeners.add(listener)
    addWindow(type, listener, listenerOptions)
  }) as typeof dom.window.addEventListener
  dom.window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, listenerOptions?: boolean | EventListenerOptions) => {
    if (!listener) return
    if (type === 'blur') blurListeners.delete(listener)
    removeWindow(type, listener, listenerOptions)
  }) as typeof dom.window.removeEventListener
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let mounted = true, visible = true, documentId = 'document-one', isZh = options.isZh ?? false
  let isOpen = options.open ?? true, query = 'matching'
  let suspended: { promise: Promise<void>; resolve: () => void } | null = null
  function SuspenseGate() {
    if (suspended) throw suspended.promise
    return null
  }
  const render = () => {
    const props: Props = { outline: null, activeIndex: null, progress: 37, reading: false, isZh,
      onToggleReading: () => {}, onOpenSearch: () => { isOpen = true; render() },
      search: { isOpen, isZh, query, placeholder: isZh ? '查找文档内容' : 'Find in document',
        id: options.secondNavigation ? 'caller-search-panel' : undefined,
        noMatchText: isZh ? '没有匹配内容' : 'No matching blocks',
        items: [
          { index: 4, type: 'paragraph', contentPreview: 'first matching block' },
          { index: 17, type: 'paragraph', contentPreview: 'second matching block' }
        ], onSelect: index => { selected.push(index) },
        onQueryChange: value => { query = value; render() },
        onClose: () => { isOpen = false; query = ''; render() }
      }
    }
    const navigation = visible ? createElement(DocumentNavigationBar, { ...props, key: documentId }) : null
    const navigations = options.secondNavigation && visible ? [navigation,
      createElement(DocumentNavigationBar, { ...props, key: `${documentId}-secondary` })] : navigation
    const content = options.suspense ? createElement(Suspense, {
      fallback: createElement('p', { id: 'navigation-loading' }, 'Loading another page')
    }, navigations, createElement(SuspenseGate)) : navigations
    root.render(options.strict ? createElement(StrictMode, null, content) : content)
  }
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  try {
    await act(async () => render())
    await run({ document: dom.window.document, window: dom.window, focusCalls, selected,
      open: async () => { await act(async () => { const button = findButton(dom.window.document); button.focus(); button.click() }) },
      setOpen: async value => { await act(async () => { isOpen = value; if (!value) query = ''; render() }) },
      setQuery: async value => { await act(async () => { query = value; render() }) },
      setLanguage: async value => { await act(async () => { isZh = value; render() }) },
      route: async changes => { await act(async () => {
        if (changes.visible !== undefined) visible = changes.visible
        if (changes.documentId !== undefined) documentId = changes.documentId
        isOpen = false; query = ''; render()
      }) },
      key: async (target, key, init = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        await act(async () => target.dispatchEvent(event))
        return event
      },
      focus: async target => { await act(async () => target.focus()) },
      click: async target => { await act(async () => target.click()) },
      pointer: async target => { await act(async () => target.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))) },
      setForeground: value => { foreground = value },
      blurWindow: async () => { await act(async () => dom.window.dispatchEvent(new dom.window.Event('blur'))) },
      listenerCounts: () => ({ focusin: focusListeners.size, pointerdown: pointerListeners.size, blur: blurListeners.size }), unmount,
      suspend: async () => {
        assert.equal(options.suspense, true)
        let resolve!: () => void
        const promise = new Promise<void>(done => { resolve = done })
        await act(async () => { suspended = { promise, resolve }; render() })
      },
      reveal: async () => {
        assert.ok(suspended)
        const previous = suspended
        await act(async () => { suspended = null; previous.resolve(); render() })
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

const findButton = (document: Document) => document.querySelector<HTMLButtonElement>('.document-navigation-bar > button[title]')!
const input = (document: Document) => document.querySelector<HTMLInputElement>('.block-find-input')!
const closeButton = (document: Document) => document.querySelector<HTMLButtonElement>('.block-find-close')!
const callsTo = (context: Context, target: HTMLElement) => context.focusCalls.filter(call => call.element === target)

test('Escape, the close handler and an external close transition return focus to Find without requesting scroll', async () => {
  for (const strict of [false, true]) {
    for (const method of ['escape', 'click', 'prop'] as const) {
      await withNavigation(async context => {
        const { document } = context
        const find = findButton(document)
        const panelId = find.getAttribute('aria-controls')
        assert.ok(panelId, 'Find names its controlled panel even while closed')
        assert.equal(find.getAttribute('aria-expanded'), 'false')
        assert.equal(document.querySelectorAll('.block-find-panel').length, 0)
        await context.open()
        assert.equal(find.getAttribute('aria-expanded'), 'true')
        assert.equal(find.getAttribute('aria-controls'), panelId)
        assert.equal(document.querySelector('.block-find-panel')?.id, panelId)
        assert.equal([...document.querySelectorAll('[id]')].filter(element => element.id === panelId).length, 1)
        assert.equal(document.activeElement, input(document))
        const before = callsTo(context, find).length
        if (method === 'escape') assert.equal((await context.key(input(document), 'Escape')).defaultPrevented, true)
        // This explicit click tests the handler; native Enter/Space activation belongs to E2E.
        else if (method === 'click') { await context.focus(closeButton(document)); await context.click(closeButton(document)) }
        // Ctrl/Cmd+F closes the shared state directly; it reaches this same prop transition.
        else await context.setOpen(false)
        assert.equal(document.querySelector('.block-find-panel'), null)
        assert.equal(find.getAttribute('aria-expanded'), 'false')
        assert.equal(find.getAttribute('aria-controls'), panelId)
        assert.equal(document.activeElement, find)
        assert.equal(callsTo(context, find).length, before + 1)
        assert.deepEqual(callsTo(context, find).at(-1)!.options, { preventScroll: true })
        assert.deepEqual(context.selected, [])
        assert.deepEqual(context.listenerCounts(), { focusin: 0, pointerdown: 0, blur: 0 })
      }, { open: false, strict, isZh: strict })
    }
  }
})

test('opening, query changes and match selection never restore Find before the panel actually closes', async () => {
  await withNavigation(async context => {
    const { document } = context
    const find = findButton(document)
    await context.open()
    const panelId = find.getAttribute('aria-controls')
    assert.ok(panelId)
    const before = callsTo(context, find).length
    await context.setQuery('updated')
    assert.equal(document.querySelector('.block-find-panel')?.id, panelId)
    assert.equal(find.getAttribute('aria-controls'), panelId)
    assert.equal(document.activeElement, input(document))
    assert.equal(callsTo(context, find).length, before)
    await context.setLanguage(true)
    assert.equal(find.textContent, '查找')
    assert.equal(input(document).getAttribute('aria-label'), '查找文档内容')
    assert.equal(find.getAttribute('aria-controls'), panelId)
    assert.equal(document.querySelector('.block-find-panel')?.id, panelId)
    assert.equal((await context.key(input(document), 'Enter')).defaultPrevented, true)
    assert.deepEqual(context.selected, [4])
    assert.equal((await context.key(input(document), 'ArrowDown')).defaultPrevented, true)
    assert.deepEqual(context.selected, [4, 17])
    assert.equal(document.querySelector('.block-find-result-active')?.getAttribute('data-result-index'), '1')
    assert.equal(find.getAttribute('aria-expanded'), 'true')
    assert.equal(find.getAttribute('aria-controls'), panelId)
    assert.equal(document.querySelector('.block-find-panel')?.id, panelId)
    assert.equal(document.activeElement, input(document))
    assert.equal(callsTo(context, find).length, before)
    await context.setOpen(false)
    assert.equal(document.activeElement, find)
    assert.equal(callsTo(context, find).length, before + 1)
    assert.equal(find.getAttribute('aria-expanded'), 'false')
    assert.equal(find.getAttribute('aria-controls'), panelId)
    assert.equal(document.querySelectorAll('.block-find-panel').length, 0)
    await context.open()
    assert.equal(find.getAttribute('aria-expanded'), 'true')
    assert.equal(find.getAttribute('aria-controls'), panelId)
    assert.equal(document.querySelector('.block-find-panel')?.id, panelId)
    await context.setOpen(false)
  }, { open: false, strict: true })
})

test('simultaneous navigation instances control their own unique panels even when callers reuse a panel ID', async () => {
  await withNavigation(async context => {
    const { document } = context
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.document-navigation-bar > button[title]')]
    assert.equal(buttons.length, 2)
    const ids = buttons.map(button => button.getAttribute('aria-controls'))
    assert.ok(ids.every(Boolean))
    assert.equal(new Set(ids).size, 2)
    assert.equal(document.querySelectorAll('.block-find-panel').length, 0)
    await context.open()
    for (const [index, button] of buttons.entries()) {
      const panel = button.closest('.document-navigation')!.querySelector('.block-find-panel')
      assert.equal(button.getAttribute('aria-expanded'), 'true')
      assert.equal(panel?.id, ids[index])
      assert.equal(document.getElementById(ids[index]!) === panel, true)
    }
    assert.equal(document.querySelectorAll('.block-find-panel').length, 2)
    assert.equal(document.getElementById('caller-search-panel') === null, true)
    await context.setOpen(false)
    assert.deepEqual(buttons.map(button => button.getAttribute('aria-expanded')), ['false', 'false'])
    assert.deepEqual(buttons.map(button => button.getAttribute('aria-controls')), ids)
    assert.equal(document.querySelectorAll('.block-find-panel').length, 0)
  }, { open: false, secondNavigation: true, strict: true })
})

test('external focus and pointer interactions revoke ownership even when focus later becomes body or stays in the input', async () => {
  for (const method of ['focus', 'focus-then-blur', 'pointer'] as const) {
    await withNavigation(async context => {
      const { document } = context
      const find = findButton(document), outside = document.getElementById('outside')!
      assert.equal(document.activeElement, input(document))
      if (method === 'pointer') {
        await context.pointer(document.getElementById('blank')!)
        assert.equal(document.activeElement, input(document), 'A non-focusable pointer target need not move the browser focus')
      } else {
        await context.focus(outside)
        if (method === 'focus-then-blur') await act(async () => outside.blur())
      }
      const expected = method === 'focus' ? outside : document.body
      await context.setOpen(false)
      assert.equal(document.activeElement, expected)
      assert.equal(callsTo(context, find).length, 0)
      await context.open()
      await context.setOpen(false)
      assert.equal(document.activeElement, find, 'A new opening gets fresh focus ownership')
    })
  }
})

test('window blur or a background document cancels restoration and cannot replay it when the window returns', async () => {
  for (const method of ['blur', 'background'] as const) {
    await withNavigation(async context => {
      const { document, window } = context
      const find = findButton(document)
      if (method === 'blur') await context.blurWindow()
      else context.setForeground(false)
      await context.setOpen(false)
      assert.equal(document.activeElement, document.body)
      assert.equal(callsTo(context, find).length, 0)
      context.setForeground(true)
      await act(async () => window.dispatchEvent(new window.Event('focus')))
      await context.setLanguage(true)
      assert.equal(document.activeElement, document.body)
      assert.equal(callsTo(context, find).length, 0)
    })
  }
})

test('hidden, inert, disabled and invisible return targets or panel surfaces prevent restoration', async () => {
  const cases: Array<(document: Document) => void> = [
    document => { findButton(document).disabled = true },
    document => { findButton(document).setAttribute('aria-disabled', 'true') },
    document => { findButton(document).hidden = true },
    document => { findButton(document).setAttribute('inert', '') },
    document => { findButton(document).style.visibility = 'hidden' },
    document => { findButton(document).setAttribute('data-no-rect', '') },
    document => { document.querySelector<HTMLElement>('.document-navigation')!.hidden = true },
    document => { document.querySelector('.document-navigation')!.setAttribute('inert', '') },
    document => { document.querySelector<HTMLElement>('.block-find-panel')!.hidden = true },
    document => { document.querySelector('.block-find-panel')!.setAttribute('inert', '') },
    document => { document.querySelector<HTMLElement>('.block-find-panel')!.style.display = 'none' }
  ]
  for (const makeUnavailable of cases) {
    await withNavigation(async context => {
      const find = findButton(context.document)
      makeUnavailable(context.document)
      await context.setOpen(false)
      assert.equal(callsTo(context, find).length, 0)
      assert.notEqual(context.document.activeElement, find)
      assert.equal(context.document.querySelector('.block-find-panel'), null)
    })
  }
})

test('a visible modal blocks focus restoration while a retained hidden modal does not', async () => {
  for (const hidden of [false, true]) {
    await withNavigation(async context => {
      const { document } = context
      const find = findButton(document)
      const modal = document.createElement('div')
      modal.setAttribute('role', 'dialog')
      modal.setAttribute('aria-modal', 'true')
      modal.hidden = hidden
      document.body.append(modal)
      await context.setOpen(false)
      assert.equal(callsTo(context, find).length, hidden ? 1 : 0)
      assert.equal(document.activeElement, hidden ? find : document.body)
    })
  }
})

test('page removal, document-key replacement and real unmount only clean listeners and never focus an old or new Find control', async () => {
  await withNavigation(async context => {
    const { document } = context
    const firstFind = findButton(document)
    assert.deepEqual(context.listenerCounts(), { focusin: 1, pointerdown: 1, blur: 1 })
    await context.route({ visible: false })
    assert.equal(firstFind.isConnected, false)
    assert.equal(callsTo(context, firstFind).length, 0)
    assert.deepEqual(context.listenerCounts(), { focusin: 0, pointerdown: 0, blur: 0 })
    await context.route({ visible: true })
    const secondFind = findButton(document)
    assert.notEqual(secondFind, firstFind)
    assert.equal(callsTo(context, secondFind).length, 0)
    await context.open()
    const before = callsTo(context, secondFind).length
    await context.route({ documentId: 'document-two' })
    const thirdFind = findButton(document)
    assert.notEqual(thirdFind, secondFind)
    assert.equal(secondFind.isConnected, false)
    assert.equal(callsTo(context, secondFind).length, before)
    assert.equal(callsTo(context, thirdFind).length, 0)
    assert.deepEqual(context.listenerCounts(), { focusin: 0, pointerdown: 0, blur: 0 })
    await context.open()
    const lastBefore = callsTo(context, thirdFind).length
    await context.unmount()
    assert.equal(callsTo(context, thirdFind).length, lastBefore)
    assert.deepEqual(context.listenerCounts(), { focusin: 0, pointerdown: 0, blur: 0 })
    await context.pointer(document.getElementById('blank')!)
    await context.blurWindow()
    assert.equal(callsTo(context, thirdFind).length, lastBefore)
  }, { strict: true })
})

test('IME candidate Escape keeps the panel open and does not restore Find until a normal dismissal', async () => {
  await withNavigation(async context => {
    const { document, window } = context
    const find = findButton(document), search = input(document)
    await act(async () => search.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
    assert.equal((await context.key(search, 'Escape')).defaultPrevented, false)
    assert.equal(document.activeElement, search)
    assert.equal(callsTo(context, find).length, 0)
    await act(async () => search.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      assert.equal((await context.key(search, 'Escape', init)).defaultPrevented, false)
      assert.equal(document.activeElement, search)
      assert.equal(callsTo(context, find).length, 0)
    }
    assert.equal((await context.key(search, 'Escape')).defaultPrevented, true)
    assert.equal(document.activeElement, find)
    assert.equal(callsTo(context, find).length, 1)
  })
})

test('a Suspense-hidden navigation cannot restore old find ownership when a pending close commits on reveal', async () => {
  for (const destination of ['body', 'outside'] as const) {
    await withNavigation(async context => {
      const { document } = context
      const find = findButton(document), search = input(document)
      const navigation = document.querySelector<HTMLElement>('.document-navigation')!
      assert.equal(document.activeElement, search)
      await context.suspend()
      assert.equal(find.isConnected, true, 'Suspense must retain this exact navigation rather than physically unmount it')
      assert.equal(document.getElementById('navigation-loading')?.textContent, 'Loading another page')
      assert.equal(navigation.style.display, 'none', 'The real Suspense boundary hides its retained primary DOM')
      assert.equal(find.getClientRects().length, 0)
      assert.deepEqual(context.listenerCounts(), { focusin: 0, pointerdown: 0, blur: 0 })
      // JSDOM does not perform Chromium's native focus loss when display:none is
      // applied. Reproduce that blur while keeping the actual Suspense lifecycle.
      await act(async () => search.blur())
      const outside = document.getElementById('outside')!
      if (destination === 'outside') await context.focus(outside)
      const expected = destination === 'outside' ? outside : document.body
      assert.equal(document.activeElement, expected)
      await context.setOpen(false)
      assert.equal(find.isConnected, true)
      assert.equal(navigation.style.display, 'none')
      assert.equal(callsTo(context, find).length, 0)
      await context.reveal()
      assert.equal(document.getElementById('navigation-loading'), null)
      assert.equal(findButton(document), find, 'Reveal must reuse the original control and document context')
      assert.equal(navigation.style.display, '')
      assert.equal(document.querySelector('.block-find-panel'), null)
      assert.equal(callsTo(context, find).length, 0, 'A close pending across Suspense hiding must not replay stale focus ownership')
      assert.equal(document.activeElement, expected)
    }, { suspense: true })
  }
})
