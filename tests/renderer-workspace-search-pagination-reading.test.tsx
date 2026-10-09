import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { register } from 'node:module'
import React, { act, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import type { ElectronApi } from '../src/shared/contracts'
import type { WorkspaceSearchInput, WorkspaceSearchPage } from '../src/shared/workspace-search'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: SearchPage } = await import('../src/renderer/src/pages/SearchPage')

type SearchProps = ComponentProps<typeof SearchPage>

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function pageResult(input: WorkspaceSearchInput, overrides: { page?: number; total?: number } = {}): WorkspaceSearchPage {
  const page = overrides.page ?? input.page ?? 1, pageSize = input.pageSize ?? 25, total = overrides.total ?? 60
  const start = (page - 1) * pageSize
  return {
    page, pageSize, total, queryTerms: input.query.trim().split(/\s+/).filter(Boolean),
    items: Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, index) => ({
      documentId: `document-${start + index + 1}`, documentTitle: `Page ${page} result ${start + index + 1}`,
      documentPath: `Folder/Result ${start + index + 1}`, matchType: 'title', snippet: `Matching ${input.query}`,
      updatedAt: '2026-10-09T00:00:00Z', tags: []
    }))
  }
}

type PendingSearch = { input: WorkspaceSearchInput; response: ReturnType<typeof deferred<WorkspaceSearchPage>> }
type ScrollCall = { target: HTMLElement; options: ScrollIntoViewOptions | boolean | undefined }

async function withSearch(t: TestContext, run: (context: {
  document: Document
  window: Window & typeof globalThis
  pending: PendingSearch[]
  scrolls: ScrollCall[]
  outside: HTMLButtonElement
  render: (patch?: Partial<SearchProps> & { hidden?: boolean }) => Promise<void>
  remove: () => Promise<void>
  tick: () => Promise<void>
  settle: (index: number, overrides?: { page?: number; total?: number }) => Promise<void>
  mutate: () => Promise<void>
  setForeground: (value: boolean) => void
}) => Promise<void>) {
  const dom = new JSDOM('<button id="outside">Outside</button><div id="mount"></div>', { url: 'http://localhost' })
  const window = dom.window as unknown as Window & typeof globalThis, document = window.document
  const pending: PendingSearch[] = [], scrolls: ScrollCall[] = []
  let foreground = true, listener = () => {}, hidden = false
  let props: SearchProps = {
    isActive: true, isZh: false, documentTree: [], request: { query: 'needle', sequence: 1 },
    onOpenDocument: () => false, onOpenBlock: () => false
  }
  const bridge: Partial<ElectronApi> = {
    searchWorkspace: (input) => {
      const response = deferred<WorkspaceSearchPage>()
      pending.push({ input, response })
      return response.promise
    },
    getSearchFacets: async () => ({ tags: ['review'], blockTypes: ['paragraph'] }),
    listSavedSearches: async () => [],
    onWorkspaceMutated: (callback) => { listener = callback; return () => { listener = () => {} } }
  }
  Object.defineProperty(window, 'knowbook', { value: bridge })
  Object.defineProperty(document, 'hasFocus', { value: () => foreground })
  Object.defineProperty(document, 'visibilityState', { value: 'visible' })
  // JSDOM has no layout. These shims only expose connected/visible geometry and
  // record requested scrolling; focus remains the real DOM implementation.
  Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', { configurable: true, value: function (this: HTMLElement) {
    if (!this.isConnected || this.closest('[hidden], [inert], [aria-hidden="true"]')) return []
    return [{ x: 0, y: 0, top: 0, bottom: 40, left: 0, right: 300, width: 300, height: 40 }]
  } })
  Object.defineProperty(window.HTMLElement.prototype, 'checkVisibility', { configurable: true, value: function (this: HTMLElement) {
    return this.isConnected && !this.closest('[hidden], [inert], [aria-hidden="true"]')
  } })
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: function (this: HTMLElement, options?: ScrollIntoViewOptions | boolean) {
    scrolls.push({ target: this, options })
  } })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('mount')!)
  const render = async (patch: Partial<SearchProps> & { hidden?: boolean } = {}) => {
    if (patch.hidden !== undefined) hidden = patch.hidden
    const { hidden: _hidden, ...searchPatch } = patch
    props = { ...props, ...searchPatch }
    await act(async () => root.render(<main className="content management-page"><div hidden={hidden}><SearchPage {...props} /></div></main>))
  }
  try {
    await run({ document, window, pending, scrolls, outside: document.getElementById('outside') as HTMLButtonElement,
      render, remove: () => act(async () => root.render(null)), tick: () => act(async () => t.mock.timers.tick(200)),
      settle: (index, overrides) => act(async () => pending[index].response.resolve(pageResult(pending[index].input, overrides))),
      mutate: () => act(async () => listener()), setForeground: (value) => { foreground = value } })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    window.close()
  }
}

function heading(document: Document): HTMLElement {
  return document.querySelector<HTMLElement>('.workspace-search-results-head h3')!
}

function pagination(document: Document, direction: 'next' | 'previous'): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`.workspace-search-pagination button:${direction === 'next' ? 'last' : 'first'}-child`)!
}

async function clickFocused(button: HTMLButtonElement) {
  assert.equal(button.disabled, false, 'The pagination command must be available')
  await act(async () => { button.focus(); button.click() })
}

function assertReadingStart(document: Document, scrolls: ScrollCall[], expectedScrolls: number) {
  const target = heading(document)
  assert.ok(document.activeElement === target, 'Successful explicit pagination focuses the results heading')
  assert.equal(scrolls.length, expectedScrolls, 'Each accepted pagination publication requests scrolling exactly once')
  assert.ok(scrolls.at(-1)?.target === target, 'Reading starts at the published results heading')
  assert.deepEqual(scrolls.at(-1)?.options, { block: 'start', behavior: 'instant' })
}

function setQuery(document: Document, window: Window & typeof globalThis, value: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('successful Next and Previous publications focus their results heading and request one reading-start scroll each', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withSearch(t, async ({ render, tick, settle, pending, document, scrolls }) => {
    await render(); await tick(); await settle(0)
    assert.equal(scrolls.length, 0, 'Initial search loading does not create a pagination command')
    await clickFocused(pagination(document, 'next')); await tick()
    assert.equal(pending[1].input.page, 2)
    assert.equal(scrolls.length, 0, 'The previous page remains in place while the requested page is pending')
    await settle(1)
    assert.match(document.querySelector('[data-testid="workspace-search-result"]')!.textContent!, /Page 2 result 26/)
    assertReadingStart(document, scrolls, 1)
    const descriptions = heading(document).getAttribute('aria-describedby')?.split(/\s+/) ?? []
    const describedText = descriptions.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
    assert.match(describedText, /60 results/)
    assert.match(describedText, /Page 2 of 3/)
    await render(); await tick()
    assert.equal(scrolls.length, 1, 'An ordinary rerender cannot consume the successful command again')
    await clickFocused(pagination(document, 'previous')); await tick(); await settle(2)
    assert.equal(pending[2].input.page, 1)
    assert.match(document.querySelector('[data-testid="workspace-search-result"]')!.textContent!, /Page 1 result 1/)
    assertReadingStart(document, scrolls, 2)
  })
})

test('an explicitly requested page normalized back to the current page still receives exactly one reading-start handoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withSearch(t, async ({ render, tick, settle, pending, document, scrolls }) => {
    await render(); await tick(); await settle(0)
    await clickFocused(pagination(document, 'next')); await tick()
    assert.equal(pending[1].input.page, 2)
    await settle(1, { page: 1, total: 18 })
    assert.match(document.querySelector('.workspace-search-pagination')!.textContent!, /Page 1 of 1/)
    assertReadingStart(document, scrolls, 1)
    await tick(); await render()
    assert.equal(pending.length, 2, 'Normalizing the published page does not search again')
    assert.equal(scrolls.length, 1, 'Normalized input commits preserve the consumed publication identity')
  })
})

test('a successful pagination publication with no remaining results focuses the stable results heading', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withSearch(t, async ({ render, tick, settle, document, scrolls }) => {
    await render(); await tick(); await settle(0)
    await clickFocused(pagination(document, 'next')); await tick(); await settle(1, { page: 1, total: 0 })
    assert.equal(document.querySelectorAll('[data-testid="workspace-search-result"]').length, 0)
    assert.match(document.querySelector('.workspace-search-empty')!.textContent!, /No matching results/)
    assertReadingStart(document, scrolls, 1)
  })
})

test('an unfocused programmatic pagination click preserves external focus and creates no reading-start handoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withSearch(t, async ({ render, tick, settle, document, scrolls, outside }) => {
    await render(); await tick(); await settle(0)
    await act(async () => { outside.focus(); pagination(document, 'next').click() })
    await tick(); await settle(1)
    assert.ok(document.activeElement === outside, 'An external owner retains focus after an unfocused command')
    assert.equal(scrolls.length, 0)
  })
})

test('new attention cancels pagination recovery permanently even when focus or foreground returns before publication', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const interruption of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'compositionstart', 'blur', 'focus-away-and-body'] as const) {
    await withSearch(t, async ({ render, tick, settle, document, window, scrolls, outside, setForeground }) => {
      await render(); await tick(); await settle(0)
      await clickFocused(pagination(document, 'next')); await tick()
      await act(async () => {
        if (interruption === 'blur') {
          setForeground(false)
          window.dispatchEvent(new window.FocusEvent('blur'))
          setForeground(true)
        } else if (interruption === 'focus-away-and-body') {
          outside.focus(); outside.blur()
        } else if (interruption === 'keydown') {
          document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
        } else {
          document.dispatchEvent(new window.Event(interruption, { bubbles: true }))
        }
      })
      await settle(1)
      assert.equal(scrolls.length, 0, `${interruption} permanently gives up the pending reading-start handoff`)
      assert.ok(document.activeElement !== heading(document), `${interruption} cannot recover focus when the response arrives`)
      assert.match(document.querySelector('.workspace-search-pagination')!.textContent!, /Page 2 of 3/, 'Attention changes still allow valid data publication')
      await render()
      assert.equal(scrolls.length, 0, `${interruption} does not revive on another commit`)
    })
  }
})

test('a query edit and return to the same text cannot let an obsolete page response restore reading attention', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withSearch(t, async ({ render, tick, settle, pending, document, window, scrolls }) => {
    await render(); await tick(); await settle(0)
    await clickFocused(pagination(document, 'next')); await tick()
    await act(async () => setQuery(document, window, 'different'))
    await act(async () => setQuery(document, window, 'needle'))
    await tick()
    assert.equal(pending[2].input.query, 'needle')
    assert.equal(pending[2].input.page, 1)
    await settle(1)
    assert.equal(scrolls.length, 0, 'The old pagination response is stale despite matching query text again')
    await settle(2)
    assert.match(document.querySelector('.workspace-search-pagination')!.textContent!, /Page 1 of 3/)
    assert.ok(document.activeElement !== heading(document))
    assert.equal(scrolls.length, 0, 'The replacement criteria search is not an explicit pagination publication')
  })
})

test('a changed sort cancels the pending pagination handoff without preventing the criteria search', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withSearch(t, async ({ render, tick, settle, pending, document, window, scrolls }) => {
    await render(); await tick(); await settle(0)
    await clickFocused(pagination(document, 'next')); await tick()
    await act(async () => {
      const sort = document.querySelector<HTMLSelectElement>('.workspace-search-sort select')!
      sort.value = 'updated-desc'; sort.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    await tick()
    assert.equal(pending[2].input.sort, 'updated-desc')
    assert.equal(pending[2].input.page, 1)
    await settle(2); await settle(1)
    assert.equal(scrolls.length, 0)
    assert.ok(document.activeElement !== heading(document))
    assert.match(document.querySelector('.workspace-search-pagination')!.textContent!, /Page 1 of 3/)
  })
})

test('a new palette request owns its query focus and invalidates an old pagination response', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withSearch(t, async ({ render, tick, settle, pending, document, scrolls }) => {
    await render(); await tick(); await settle(0)
    await clickFocused(pagination(document, 'next')); await tick()
    await render({ request: { query: 'new query', sequence: 2 } }); await tick()
    const query = document.querySelector<HTMLInputElement>('input[type="search"]')!
    assert.ok(document.activeElement === query, 'The existing palette entry point focuses the newly requested query')
    assert.equal(pending[2].input.query, 'new query')
    await settle(1); await settle(2)
    assert.ok(document.activeElement === query, 'Old pagination cannot override the new palette request')
    assert.equal(scrolls.length, 0)
  })
})

test('workspace refresh publications, including a refresh that supersedes pending pagination, do not reclaim reading attention', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withSearch(t, async ({ render, tick, settle, pending, document, scrolls, mutate, outside }) => {
    await render(); await tick(); await settle(0)
    await act(async () => outside.focus())
    await mutate(); await tick(); await settle(1)
    assert.ok(document.activeElement === outside)
    assert.equal(scrolls.length, 0, 'Ordinary workspace refresh does not move the user to the results beginning')
    await clickFocused(pagination(document, 'next')); await tick()
    await mutate(); await tick()
    assert.equal(pending[2].input.page, 2)
    assert.equal(pending[3].input.page, 2, 'Refresh retains current requested page criteria')
    await settle(2); await settle(3)
    assert.match(document.querySelector('.workspace-search-pagination')!.textContent!, /Page 2 of 3/)
    assert.ok(document.activeElement !== heading(document))
    assert.equal(scrolls.length, 0, 'A background replacement with the same criteria cannot consume the explicit command')
  })
})

test('a failed pagination request and its later retry never move focus or programmatically scroll to results', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withSearch(t, async ({ render, tick, settle, pending, document, scrolls }) => {
    await render(); await tick(); await settle(0)
    await clickFocused(pagination(document, 'next')); await tick()
    await act(async () => pending[1].response.reject(new Error('Pagination unavailable')))
    assert.match(document.querySelector('.workspace-search-empty')!.textContent!, /Pagination unavailable/)
    assert.equal(scrolls.length, 0)
    assert.ok(document.activeElement !== heading(document))
    const retry = document.querySelector<HTMLButtonElement>('.workspace-search-empty button')!
    await clickFocused(retry); await tick(); await settle(2)
    assert.equal(pending[2].input.page, 2, 'Retry still requests the failed page')
    assert.match(document.querySelector('.workspace-search-pagination')!.textContent!, /Page 2 of 3/)
    assert.equal(scrolls.length, 0, 'Retry is not a new pagination intent')
    assert.ok(document.activeElement !== heading(document))
  })
})

test('a hidden search host consumes no pending pagination attention and cannot revive it when shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withSearch(t, async ({ render, tick, settle, document, scrolls }) => {
    await render(); await tick(); await settle(0)
    await clickFocused(pagination(document, 'next')); await tick()
    await render({ hidden: true }); await settle(1)
    assert.match(document.querySelector('.workspace-search-pagination')!.textContent!, /Page 2 of 3/)
    assert.equal(scrolls.length, 0, 'A hidden retained host may receive data without reading-start effects')
    await render({ hidden: false })
    assert.equal(scrolls.length, 0, 'Showing the retained host cannot revive the old command')
    assert.ok(document.activeElement !== heading(document))
  })
})

test('deactivation and reactivation cannot lend a new request the old pagination command', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withSearch(t, async ({ render, tick, settle, pending, document, scrolls }) => {
    await render(); await tick(); await settle(0)
    await clickFocused(pagination(document, 'next')); await tick()
    await render({ isActive: false }); await settle(1)
    assert.match(document.querySelector('.workspace-search-pagination')!.textContent!, /Page 1 of 3/, 'Hidden owners ignore the obsolete response')
    await render({ isActive: true }); await tick(); await settle(2)
    assert.equal(pending[2].input.page, 2)
    assert.equal(scrolls.length, 0)
    assert.ok(document.activeElement === document.querySelector('input[type="search"]'), 'The existing activation focus remains the owner')
  })
})

test('unmounting a pending pagination owner prevents both late recovery and recovery after remount', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withSearch(t, async ({ render, remove, tick, settle, pending, document, scrolls }) => {
    await render(); await tick(); await settle(0)
    await clickFocused(pagination(document, 'next')); await tick()
    await remove(); await settle(1)
    assert.equal(scrolls.length, 0)
    assert.equal(document.querySelector('.workspace-search-page'), null)
    await render(); await tick(); await settle(2)
    assert.equal(pending[2].input.page, 1)
    assert.equal(scrolls.length, 0)
    assert.ok(document.activeElement !== heading(document))
  })
})

test('a foreign modal or lost foreground at publication gives up the pending handoff permanently', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const boundary of ['modal', 'foreground'] as const) {
    await withSearch(t, async ({ render, tick, settle, document, scrolls, setForeground }) => {
      await render(); await tick(); await settle(0)
      await clickFocused(pagination(document, 'next')); await tick()
      let modal: HTMLDialogElement | null = null
      if (boundary === 'modal') {
        modal = document.createElement('dialog'); modal.open = true; modal.textContent = 'Foreign dialog'
        document.body.append(modal)
      } else setForeground(false)
      await settle(1)
      assert.equal(scrolls.length, 0, `${boundary} prevents reading-start recovery at publication`)
      assert.ok(document.activeElement !== heading(document))
      modal?.remove(); setForeground(true)
      await render()
      assert.equal(scrolls.length, 0, `${boundary} cannot revive a command after the boundary is removed`)
      assert.ok(document.activeElement !== heading(document))
    })
  }
})
