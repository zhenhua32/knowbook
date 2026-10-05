import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { GlobalSearchResult } from '../src/shared/contracts'
import { getUiText } from '../src/renderer/src/i18n'
import { useGlobalDocumentSearch } from '../src/renderer/src/hooks/useGlobalDocumentSearch'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: GlobalSearchPalette } = await import('../src/renderer/src/components/GlobalSearchPalette')
type Props = Parameters<typeof GlobalSearchPalette>[0]
type Search = ReturnType<typeof useGlobalDocumentSearch>
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
type SearchRequest = ReturnType<typeof deferred<GlobalSearchResult[]>> & { query: string; settled: boolean }
type Navigation = ReturnType<typeof deferred<boolean>> & { documentId: string; blockId?: string; settled: boolean }
const results: GlobalSearchResult[] = [
  { documentId: 'alpha', documentTitle: 'New Alpha', documentPath: 'Notes/New Alpha', matchType: 'title', snippet: '' },
  { documentId: 'beta', documentTitle: 'New Beta', documentPath: 'Notes/New Beta', matchType: 'block',
    blockId: 'beta-paragraph', blockType: 'paragraph', snippet: 'The exact New Beta paragraph.' }
]
type Context = {
  document: Document; window: JSDOM['window']; requests: SearchRequest[]; navigations: Navigation[]
  calls: { created: Array<string | null>; pages: string[]; captures: string[]; other: string[] }
  focusCalls: HTMLElement[]; state: () => Search; input: () => HTMLInputElement
  open: (commands?: boolean) => Promise<void>; query: (value: string, external?: boolean) => Promise<void>
  key: (key: string, options?: KeyboardEventInit) => Promise<KeyboardEvent>
  change: (action: () => void) => Promise<void>; waitForSearch: (count: number) => Promise<void>
  resolve: (index: number, value?: GlobalSearchResult[]) => Promise<void>; reject: (index: number) => Promise<void>
  assertData: () => void
}
const selected = (context: Context) => {
  const id = context.input().getAttribute('aria-activedescendant')
  return id ? context.document.getElementById(id) as HTMLButtonElement | null : null
}
const commands = (context: Context) => [...context.document.querySelectorAll<HTMLButtonElement>('.palette-command:not(:disabled)')]
const noActions = (context: Context) => {
  assert.deepEqual(context.calls, { created: [], pages: [], captures: [], other: [] })
  assert.equal(context.navigations.length, 0)
  context.assertData()
}

async function withPalette(isZh: boolean, run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' }), document = dom.window.document
  const originals = new Map<string, PropertyDescriptor | undefined>(), requests: SearchRequest[] = [], navigations: Navigation[] = []
  const focusCalls: HTMLElement[] = [], calls = { created: [] as Array<string | null>, pages: [] as string[], captures: [] as string[], other: [] as string[] }
  const data = { title: 'Current unsaved draft', summary: 'Original summary', body: 'Original paragraph',
    source: 'original-source', view: 'original-view', notes: 'Original notes', fieldValues: { retained: ['Blue'] } }
  const before = JSON.stringify(data), originalResults = structuredClone(results)
  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options?: FocusOptions) { focusCalls.push(this); nativeFocus.call(this, options) }
  dom.window.HTMLElement.prototype.scrollIntoView = function () {}
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(20, 20, 460, 80) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return (this.isConnected && !this.closest('[hidden], [inert]') ? [this.getBoundingClientRect()] : []) as unknown as DOMRectList
  }
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
  Object.defineProperty(dom.window, 'knowbook', { value: {
    searchDocuments: (query: string) => { const request = { ...deferred<GlobalSearchResult[]>(), query, settled: false }; requests.push(request); return request.promise },
    writeClipboardText: async () => { calls.other.push('clipboard') }
  } })
  for (const name of ['knowbook:open-document-templates', 'knowbook:quick-capture', 'knowbook:save-document-template']) {
    dom.window.addEventListener(name, () => { calls.captures.push(name) })
  }
  for (const [key, value] of Object.entries({ window: dom.window, document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client'), root = createRoot(document.getElementById('mount')!)
  let state!: Search
  const change = async (action: () => void) => { await act(async () => action()) }
  const navigate = (documentId: string, blockId?: string) => {
    const request = { ...deferred<boolean>(), documentId, blockId, settled: false }
    navigations.push(request); return request.promise
  }
  function Harness() {
    state = useGlobalDocumentSearch({ onOpenDocument: id => navigate(id), onOpenBlock: (id, block) => navigate(id, block) })
    const documents = { ...state, selectedDocumentId: 'current', selectedDocument: { id: 'current', title: data.title },
      draftTitle: data.title, detailLoading: false, documentLoadError: null, isSaving: false,
      saveDocument: async () => { calls.other.push('save') }, copyDocumentAsMarkdown: async () => { calls.other.push('copy-markdown') },
      saveDocumentAsMarkdown: async () => { calls.other.push('export') } } as unknown as Props['documents']
    const shell = { isZh, ui: getUiText(isZh ? 'zh-CN' : 'en-US'), workspaceReady: true, workspaceError: null,
      homeData: { recentDocuments: [{ id: 'recent', title: 'Recent unchanged', path: 'Notes/Recent unchanged' }] },
      pageItems: [{ id: 'documents', label: isZh ? '文档' : 'Documents', description: 'Browse notes' },
        { id: 'settings', label: isZh ? '设置' : 'Settings', description: 'Manage preferences' }],
      isNavCollapsed: false, toggleNavCollapse: () => { calls.other.push('sidebar') },
      setActivePage: (page: string) => { calls.pages.push(page) }, openWorkspaceSearch: () => { calls.other.push('full-search') },
      notify: () => { calls.other.push('notification') } } as unknown as Props['shell']
    const workspace = { handleCreateDocument: async (parent: string | null) => { calls.created.push(parent) },
      handleBackup: async () => { calls.other.push('backup') }, handleRestoreBackup: async () => { calls.other.push('restore') } } as unknown as Props['workspace']
    return createElement('div', null,
      createElement('button', { id: 'opener', onClick: () => state.openGlobalSearch() }, 'Open search'),
      createElement('button', { id: 'command-opener', onClick: () => state.openGlobalSearch('commands') }, 'Open commands'),
      state.isGlobalSearchOpen ? createElement(GlobalSearchPalette, { documents, shell, workspace }) : null)
  }
  const input = () => document.querySelector<HTMLInputElement>('.global-search-input')!
  try {
    await change(() => root.render(createElement(Harness)))
    await run({ document, window: dom.window, requests, navigations, calls, focusCalls, state: () => state, input, change,
      open: async (commandMode = false) => { await change(() => document.getElementById(commandMode ? 'command-opener' : 'opener')!.click()) },
      query: async (value, external = false) => { await change(() => {
        if (external) state.updateGlobalSearchQuery(value)
        else { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
          input().dispatchEvent(new dom.window.Event('input', { bubbles: true })) }
      }) },
      key: async (key, options = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
        await change(() => input().dispatchEvent(event)); return event
      },
      // Exercise the real hook's debounce, then hold only its actual API reply.
      waitForSearch: async count => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) }); assert.equal(requests.length, count) },
      resolve: async (index, value = results) => { await change(() => { requests[index].settled = true; requests[index].resolve(structuredClone(value)) }) },
      reject: async index => { await change(() => { requests[index].settled = true; requests[index].reject(new Error('Search unavailable fixture')) }) },
      assertData: () => { assert.equal(JSON.stringify(data), before); assert.deepEqual(results, originalResults) }
    })
  } finally {
    await act(async () => root.unmount())
    await act(async () => { for (const request of requests) if (!request.settled) request.resolve([])
      for (const request of navigations) if (!request.settled) request.resolve(false) })
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('plain pending search has no implicit command and repeated Enter waits for actual document results in both languages', async t => {
  for (const isZh of [false, true]) await withPalette(isZh, async context => {
    await context.open(); await context.query('new'); await context.waitForSearch(1)
    const input = context.input()
    t.diagnostic(JSON.stringify({ language: isZh ? 'zh-CN' : 'en-US', query: input.value,
      loading: context.state().globalSearchLoading, requests: context.requests.map(request => request.query), commands: commands(context).length }))
    assert.equal(context.state().globalSearchLoading, true)
    assert.equal(input.getAttribute('aria-activedescendant'), null)
    assert.equal(context.document.querySelectorAll('[role="option"][aria-selected="true"]').length, 0)
    assert.equal(context.document.querySelector('[role="listbox"]')?.getAttribute('aria-busy'), 'true')
    assert.equal((await context.key('Enter')).defaultPrevented, true)
    await context.key('Enter'); noActions(context)
    assert.equal(context.state().isGlobalSearchOpen, true)
    assert.equal(context.document.activeElement === input, true)
    await context.resolve(0)
    assert.equal(context.state().globalSearchLoading, false)
    assert.equal(selected(context)?.querySelector('.global-search-doc-title')?.textContent, 'New Alpha')
    assert.equal(context.navigations.length, 0, 'A reply selects a result but does not execute it')
    await context.key('Enter'); await context.key('Enter')
    assert.equal(context.navigations.length, 1)
    assert.equal(context.navigations[0].documentId, 'alpha')
    assert.equal(context.navigations[0].blockId, undefined)
    await context.change(() => { context.navigations[0].settled = true; context.navigations[0].resolve(true) })
    assert.equal(context.state().isGlobalSearchOpen, false)
    context.assertData()
  })
})

test('explicit Down chooses the first command and Up the last while a plain query is still loading', async () => {
  for (const key of ['ArrowDown', 'ArrowUp']) await withPalette(false, async context => {
    await context.open(); await context.query('new'); await context.waitForSearch(1)
    const available = commands(context)
    assert.ok(available.length >= 2)
    assert.equal((await context.key(key)).defaultPrevented, true)
    assert.equal(selected(context) === (key === 'ArrowDown' ? available[0] : available.at(-1)), true)
    noActions(context)
    if (key === 'ArrowDown') {
      await context.key('Enter')
      assert.deepEqual(context.calls.created, [null])
      assert.deepEqual(context.calls.pages, ['documents'])
      assert.equal(context.state().isGlobalSearchOpen, false)
      assert.equal(context.navigations.length, 0)
    }
    context.assertData()
  })
})

test('pointer selection and direct command click remain available during pending search', async () => {
  for (const pointer of ['hover-enter', 'click']) await withPalette(false, async context => {
    await context.open(); await context.query('new'); await context.waitForSearch(1)
    const command = commands(context)[0]
    if (pointer === 'hover-enter') {
      await context.change(() => command.dispatchEvent(new context.window.MouseEvent('mousemove', { bubbles: true })))
      assert.equal(selected(context) === command, true)
      await context.key('Enter')
    } else await context.change(() => command.click())
    assert.deepEqual(context.calls.created, [null])
    assert.deepEqual(context.calls.pages, ['documents'])
    assert.equal(context.navigations.length, 0)
    assert.equal(context.state().isGlobalSearchOpen, false)
    context.assertData()
  })
})

test('local and external query changes including ABA permanently discard an older explicit selection', async () => {
  for (const external of [false, true]) await withPalette(false, async context => {
    await context.open(); await context.query('new'); await context.waitForSearch(1)
    await context.key('ArrowDown'); assert.equal(selected(context) === commands(context)[0], true)
    await context.query('create', external)
    assert.equal(context.input().getAttribute('aria-activedescendant'), null)
    await context.query('new', external); await context.waitForSearch(2)
    assert.deepEqual(context.requests.map(request => request.query), ['new', 'new'])
    assert.equal(context.input().getAttribute('aria-activedescendant'), null)
    await context.resolve(0)
    assert.equal(context.state().globalSearchLoading, true)
    assert.equal(context.state().globalSearchResults.length, 0)
    await context.key('Enter'); noActions(context)
    await context.resolve(1)
    assert.equal(selected(context)?.querySelector('.global-search-doc-title')?.textContent, 'New Alpha')
    noActions(context)
  })
})

test('command mode and failed ordinary Settings search still permit deliberate Enter execution', async () => {
  for (const isZh of [false, true]) {
    await withPalette(isZh, async context => {
      await context.open(true); await context.query('> new')
      assert.equal(context.state().globalSearchLoading, false)
      assert.equal(context.requests.length, 0)
      assert.equal(selected(context) === commands(context)[0], true)
      await context.key('Enter')
      assert.deepEqual(context.calls.created, [null]); assert.deepEqual(context.calls.pages, ['documents'])
      context.assertData()
    })
    await withPalette(isZh, async context => {
      await context.open(); await context.query('settings'); await context.waitForSearch(1)
      await context.reject(0)
      assert.equal(context.state().globalSearchLoading, false)
      assert.ok(context.state().globalSearchError)
      assert.equal(selected(context)?.querySelector('strong')?.textContent, isZh ? '设置' : 'Settings')
      await context.key('Enter')
      assert.deepEqual(context.calls.pages, ['settings']); assert.deepEqual(context.calls.created, [])
      assert.equal(context.navigations.length, 0); context.assertData()
    })
  }
})

test('the actual recovery Retry starts a new pending intent and requires another explicit command choice', async () => {
  for (const explicit of [false, true]) await withPalette(false, async context => {
    await context.open(); await context.query('settings'); await context.waitForSearch(1)
    await context.reject(0)
    if (explicit) await context.key('ArrowDown')
    assert.equal(selected(context)?.querySelector('strong')?.textContent, 'Settings')
    const retry = context.document.querySelector<HTMLButtonElement>('.recovery-actions .primary-button')!
    await context.change(() => retry.click()); await context.waitForSearch(2)
    assert.equal(context.input().value, 'settings')
    assert.equal(context.state().globalSearchLoading, true)
    assert.equal(context.input().getAttribute('aria-activedescendant'), null)
    await context.key('Enter'); noActions(context)
    await context.key('ArrowDown')
    assert.equal(selected(context) === commands(context)[0], true)
    await context.key('Enter')
    assert.deepEqual(context.calls.pages, ['settings'])
    assert.deepEqual(context.calls.created, [])
    assert.equal(context.navigations.length, 0)
    context.assertData()
  })
})

test('closing and reopening invalidates old search replies without automatic execution in the new palette', async () => {
  await withPalette(false, async context => {
    await context.open(); await context.query('new'); await context.waitForSearch(1)
    await context.change(() => context.document.querySelector<HTMLButtonElement>('.global-search-header button')!.click())
    assert.equal(context.state().isGlobalSearchOpen, false)
    await context.open(); await context.query('new'); await context.waitForSearch(2)
    await context.resolve(0)
    assert.equal(context.state().globalSearchLoading, true)
    assert.equal(context.state().globalSearchResults.length, 0)
    assert.equal(context.input().getAttribute('aria-activedescendant'), null)
    await context.key('Enter'); noActions(context)
    await context.resolve(1)
    assert.equal(selected(context)?.querySelector('.global-search-doc-title')?.textContent, 'New Alpha')
    assert.equal(context.navigations.length, 0)
    context.assertData()
  })
})

test('IME candidate Enter and repeated pending Enter never execute a command or duplicate navigation', async () => {
  await withPalette(true, async context => {
    await context.open(); await context.query('new'); await context.waitForSearch(1)
    const input = context.input()
    await context.change(() => input.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true })))
    assert.equal((await context.key('Enter')).defaultPrevented, false)
    await context.change(() => input.dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true })))
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) assert.equal((await context.key('Enter', options)).defaultPrevented, false)
    await context.key('Enter'); await context.key('Enter'); noActions(context)
    await context.resolve(0)
    assert.equal(selected(context)?.querySelector('.global-search-doc-title')?.textContent, 'New Alpha')
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) await context.key('Enter', options)
    noActions(context)
    await context.key('Enter'); await context.key('Enter')
    assert.equal(context.navigations.length, 1)
    await context.change(() => { context.navigations[0].settled = true; context.navigations[0].resolve(false) })
    assert.equal(context.state().isGlobalSearchOpen, true)
    assert.equal(context.input().value, 'new')
    assert.equal(context.document.querySelectorAll('.palette-action-feedback[role="alert"]').length, 1)
    context.assertData()
  })
})
