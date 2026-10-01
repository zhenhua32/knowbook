import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React, { act, type ReactNode } from 'react'
import { JSDOM } from 'jsdom'
import type { ElectronApi } from '../src/shared/contracts'
import type { SavedWorkspaceSearch, WorkspaceSearchInput, WorkspaceSearchPage } from '../src/shared/workspace-search'
import { useWorkspaceSearch, type WorkspaceSearchRequest } from '../src/renderer/src/hooks/useWorkspaceSearch'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: SearchPage } = await import('../src/renderer/src/pages/SearchPage')

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function searchPage(input: WorkspaceSearchInput, total = 26): WorkspaceSearchPage {
  return { page: input.page ?? 1, pageSize: input.pageSize ?? 25, total, queryTerms: input.query.trim().split(/\s+/).filter(Boolean), items: total ? [{
    documentId: 'doc-1', documentTitle: `Result ${input.page ?? 1}`, documentPath: 'Folder/Result', matchType: 'block',
    snippet: `needle <script>alert(1)</script> ${input.query}`, blockId: 'block-1', blockType: 'paragraph', tags: ['review'], updatedAt: '2026-09-30T04:00:00Z'
  }] : [] }
}

function api(overrides: Partial<ElectronApi> = {}): Partial<ElectronApi> {
  let savedSearches: SavedWorkspaceSearch[] = []
  return { searchWorkspace: async (input) => searchPage(input), getSearchFacets: async () => ({ tags: ['review'], blockTypes: ['paragraph', 'todo'] }),
    listSavedSearches: async () => savedSearches, saveSearch: async (saved) => {
      const record = { ...saved, id: saved.id ?? 'saved-1' }
      savedSearches = [...savedSearches.filter((item) => item.id !== record.id), record]; return record
    }, deleteSavedSearch: async (id) => { savedSearches = savedSearches.filter((item) => item.id !== id) }, onWorkspaceMutated: () => () => undefined,
    writeClipboardText: async () => undefined, ...overrides }
}

async function withRenderer(bridge: Partial<ElectronApi>, run: (context: {
  render: (node: ReactNode) => Promise<void>; document: Document; window: Window & typeof globalThis
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  Object.defineProperty(dom.window, 'knowbook', { value: bridge })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  try { await run({ render: async (node) => { await act(async () => root.render(node)) }, document: dom.window.document, window: dom.window as unknown as Window & typeof globalThis }) }
  finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('workspace search ignores old responses and pauses hidden requests while retaining search state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requests: { input: WorkspaceSearchInput; response: ReturnType<typeof deferred<WorkspaceSearchPage>> }[] = []
  let state!: ReturnType<typeof useWorkspaceSearch>
  function Harness({ active = true, request = null }: { active?: boolean; request?: WorkspaceSearchRequest | null }) {
    state = useWorkspaceSearch({ isActive: active, isZh: false, request }); return null
  }
  await withRenderer(api({ searchWorkspace: (input) => {
    const response = deferred<WorkspaceSearchPage>(); requests.push({ input, response }); return response.promise
  } }), async ({ render }) => {
    const tick = () => act(async () => t.mock.timers.tick(200))
    await render(<Harness request={{ query: 'alpha', sequence: 1 }} />); await tick()
    assert.equal(requests.length, 1); assert.equal(requests[0].input.query, 'alpha')
    await act(async () => state.updateInput({ query: 'beta' })); await tick()
    await act(async () => requests[1].response.resolve(searchPage(requests[1].input)))
    assert.equal(state.result?.queryTerms[0], 'beta'); assert.equal(state.loading, false)
    await act(async () => requests[0].response.reject(new Error('stale failure')))
    assert.equal(state.error, ''); assert.equal(state.result?.queryTerms[0], 'beta')
    await act(async () => state.updateInput({ query: 'gamma', tag: 'review' })); await tick()
    await render(<Harness active={false} />)
    await act(async () => requests[2].response.resolve(searchPage(requests[2].input)))
    assert.equal(state.input.query, 'gamma'); assert.equal(state.input.tag, 'review'); assert.equal(state.result?.queryTerms[0], 'beta')
    await tick(); assert.equal(requests.length, 3)
    await render(<Harness />); await tick(); assert.equal(requests.length, 4)
    await act(async () => requests[3].response.resolve(searchPage(requests[3].input)))
    assert.equal(state.result?.queryTerms[0], 'gamma'); assert.equal(state.loading, false)
  })
})

test('filters reset pagination, clearing retains query and page size, and a new palette request starts fresh', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requests: WorkspaceSearchInput[] = []
  let state!: ReturnType<typeof useWorkspaceSearch>
  function Harness({ request = null }: { request?: WorkspaceSearchRequest | null }) {
    state = useWorkspaceSearch({ isActive: true, isZh: false, request }); return null
  }
  await withRenderer(api({ searchWorkspace: async (input) => { requests.push(input); return searchPage(input, 130) } }), async ({ render }) => {
    const tick = () => act(async () => t.mock.timers.tick(200))
    await render(<Harness />); await tick()
    await act(async () => state.updateInput({ query: 'needle', folderId: 'folder', tag: 'review', blockType: 'todo', matchMode: 'any', updatedFrom: '2026-09-01', updatedTo: '2026-09-30', sort: 'updated-asc', pageSize: 50 })); await tick()
    await act(async () => state.updateInput({ page: 3 })); await tick()
    assert.equal(requests.at(-1)?.page, 3); assert.equal(state.result?.page, 3)
    await act(async () => state.updateInput({ sort: 'updated-desc' })); await tick()
    assert.equal(requests.at(-1)?.page, 1)
    await act(async () => state.clearFilters()); await tick()
    assert.equal(state.input.query, 'needle'); assert.equal(state.input.pageSize, 50)
    assert.equal(state.input.folderId, null); assert.equal(state.input.tag, ''); assert.equal(state.input.blockType, '')
    assert.equal(state.input.matchMode, 'all'); assert.equal(state.input.sort, 'relevance'); assert.equal(state.input.updatedFrom, '')
    await render(<Harness request={{ query: 'another query', sequence: 2 }} />); await tick()
    assert.equal(state.input.query, 'another query'); assert.equal(state.input.pageSize, 25); assert.equal(state.input.page, 1)
    await act(async () => state.updateInput({ tag: 'review' })); await tick()
    await render(<Harness request={{ query: 'another query', sequence: 2 }} />); await tick()
    assert.equal(state.input.tag, 'review', 'Rerenders with the same palette request must not discard filters')
  })
})

test('workspace mutation refreshes results and facets; failed search preserves criteria and retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let listener: () => void = () => undefined, changed = false, fail = true, searches = 0
  let state!: ReturnType<typeof useWorkspaceSearch>
  function Harness() { state = useWorkspaceSearch({ isActive: true, isZh: false, request: null }); return null }
  await withRenderer(api({ onWorkspaceMutated: (callback) => { listener = callback; return () => undefined },
    getSearchFacets: async () => ({ tags: changed ? ['new-tag'] : ['review'], blockTypes: ['paragraph'] }),
    searchWorkspace: async (input) => { searches++; if (fail) throw new Error('disk unavailable'); return searchPage(input, changed ? 0 : 26) }
  }), async ({ render }) => {
    const tick = () => act(async () => t.mock.timers.tick(200))
    await render(<Harness />); await act(async () => state.updateInput({ query: 'needle', tag: 'review' })); await tick()
    assert.equal(state.error, 'disk unavailable'); assert.equal(state.loading, false); assert.equal(state.input.query, 'needle')
    fail = false
    await act(async () => state.retry()); await tick()
    assert.equal(state.error, ''); assert.equal(state.result?.total, 26); assert.equal(state.input.tag, 'review')
    changed = true
    await act(async () => listener()); await tick()
    assert.equal(state.result?.total, 0); assert.deepEqual(state.facets.tags, ['new-tag']); assert.equal(searches, 3)
  })
})

test('saved search failure preserves the name and filters; successful saves restore, update and delete', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let persisted: SavedWorkspaceSearch[] = [], failSave = true, failDelete = true
  let state!: ReturnType<typeof useWorkspaceSearch>
  const bridge = api({ listSavedSearches: async () => persisted,
    saveSearch: async (saved) => {
      if (failSave) throw new Error('save unavailable')
      const record = { ...saved, id: saved.id ?? 'saved-1' }; persisted = [...persisted.filter((item) => item.id !== record.id), record]; return record
    }, deleteSavedSearch: async (id) => {
      if (failDelete) throw new Error('delete unavailable'); persisted = persisted.filter((item) => item.id !== id)
    } })
  function Harness() { state = useWorkspaceSearch({ isActive: true, isZh: false, request: null }); return null }
  await withRenderer(bridge, async ({ render }) => {
    await render(<Harness />)
    await act(async () => { state.updateInput({ query: 'saved terms', tag: 'review', page: 3, pageSize: 50 }); state.setSavedName('Review notes') })
    await act(async () => state.save())
    assert.equal(state.savedError, 'save unavailable'); assert.equal(state.savedName, 'Review notes'); assert.equal(state.input.query, 'saved terms')
    assert.equal(state.savedSearches.length, 0)
    failSave = false
    await act(async () => state.save())
    assert.equal(state.savedError, ''); assert.equal(state.savedId, 'saved-1'); assert.equal(persisted[0].input.page, 1)
  })
  await withRenderer(bridge, async ({ render }) => {
    await render(<Harness />)
    assert.equal(state.savedSearches[0].name, 'Review notes')
    await act(async () => state.loadSaved('saved-1'))
    assert.equal(state.input.query, 'saved terms'); assert.equal(state.input.tag, 'review'); assert.equal(state.input.pageSize, 50); assert.equal(state.input.page, 1)
    await act(async () => { state.updateInput({ matchMode: 'phrase' }); state.setSavedName('Exact review') })
    await act(async () => state.save(true))
    assert.equal(persisted.length, 1); assert.equal(persisted[0].name, 'Exact review'); assert.equal(persisted[0].input.matchMode, 'phrase')
    await act(async () => state.deleteSaved('saved-1'))
    assert.equal(state.savedError, 'delete unavailable'); assert.equal(state.savedSearches.length, 1)
    failDelete = false
    await act(async () => state.deleteSaved('saved-1'))
    assert.equal(state.savedSearches.length, 0); assert.equal(state.savedId, ''); assert.equal(state.input.query, 'saved terms')
  })
})

test('saving refreshes the whole inventory and prevents an older list request from replacing it', async () => {
  const inventory = deferred<SavedWorkspaceSearch[]>()
  let listRequests = 0
  const existing: SavedWorkspaceSearch = { id: 'existing', name: 'Older search', input: { query: 'older' } }
  const fresh: SavedWorkspaceSearch = { id: 'saved-1', name: 'Fresh search', input: { query: 'fresh' } }
  let state!: ReturnType<typeof useWorkspaceSearch>
  function Harness() { state = useWorkspaceSearch({ isActive: true, isZh: false, request: null }); return null }
  await withRenderer(api({ listSavedSearches: () => ++listRequests === 1 ? inventory.promise : Promise.resolve([existing, fresh]) }), async ({ render }) => {
    await render(<Harness />)
    await act(async () => { state.setSavedName('Fresh search'); state.updateInput({ query: 'fresh' }) })
    await act(async () => state.save())
    assert.deepEqual(state.savedSearches.map((item) => item.id), ['existing', 'saved-1']); assert.equal(listRequests, 2)
    await act(async () => inventory.resolve([]))
    assert.deepEqual(state.savedSearches.map((item) => item.id), ['existing', 'saved-1']); assert.equal(state.savedLoading, false)
  })
})

test('late saved-search mutations never overwrite a newer palette query or its feedback', async () => {
  const saving = deferred<SavedWorkspaceSearch>(), deleting = deferred<void>()
  let persisted: SavedWorkspaceSearch[] = []
  let state!: ReturnType<typeof useWorkspaceSearch>
  function Harness({ request }: { request: WorkspaceSearchRequest }) {
    state = useWorkspaceSearch({ isActive: true, isZh: false, request }); return null
  }
  await withRenderer(api({ listSavedSearches: async () => persisted,
    saveSearch: () => saving.promise, deleteSavedSearch: () => deleting.promise
  }), async ({ render }) => {
    await render(<Harness request={{ query: 'old query', sequence: 1 }} />)
    await act(async () => state.setSavedName('Old query search'))
    let save!: Promise<void>
    await act(async () => { save = state.save() })
    await render(<Harness request={{ query: 'new query', sequence: 2 }} />)
    await act(async () => {
      persisted = [{ id: 'saved-old', name: 'Old query search', input: { query: 'old query' } }]
      saving.resolve(persisted[0]); await save
    })
    assert.equal(state.input.query, 'new query'); assert.equal(state.savedId, ''); assert.equal(state.savedName, ''); assert.equal(state.savedFeedback, '')
    assert.equal(state.savedSearches[0].id, 'saved-old', 'The completed mutation remains visible in the saved inventory')
    await act(async () => state.loadSaved('saved-old'))
    let remove!: Promise<void>
    await act(async () => { remove = state.deleteSaved('saved-old') })
    await render(<Harness request={{ query: 'latest query', sequence: 3 }} />)
    await act(async () => { deleting.reject(new Error('late deletion error')); await remove })
    assert.equal(state.input.query, 'latest query'); assert.equal(state.savedError, ''); assert.equal(state.savedFeedback, '')
    assert.equal(state.savedSearches[0].id, 'saved-old')
  })
})

test('a removed last page settles on the actual page and stays there when new content is added', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let listener: () => void = () => undefined, small = false
  const requestedPages: number[] = []
  let state!: ReturnType<typeof useWorkspaceSearch>
  function Harness() { state = useWorkspaceSearch({ isActive: true, isZh: false, request: null }); return null }
  await withRenderer(api({ onWorkspaceMutated: (callback) => { listener = callback; return () => undefined },
    searchWorkspace: async (input) => {
      requestedPages.push(input.page ?? 1)
      return searchPage({ ...input, page: small ? 1 : input.page }, small ? 2 : 26)
    }
  }), async ({ render }) => {
    const tick = () => act(async () => t.mock.timers.tick(200))
    await render(<Harness />); await tick()
    await act(async () => state.updateInput({ page: 2 })); await tick()
    assert.equal(state.result?.page, 2)
    small = true
    await act(async () => listener()); await tick()
    assert.equal(state.result?.page, 1); assert.equal(state.input.page, 1)
    await tick(); assert.deepEqual(requestedPages, [1, 2, 2], 'Normalizing the page does not repeat the completed request')
    small = false
    await act(async () => listener()); await tick()
    assert.equal(state.result?.page, 1); assert.deepEqual(requestedPages, [1, 2, 2, 1])
  })
})

test('facet and saved inventory failures expose independent retries without blocking the query', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let failing = true
  let state!: ReturnType<typeof useWorkspaceSearch>
  function Harness() { state = useWorkspaceSearch({ isActive: true, isZh: false, request: null }); return null }
  await withRenderer(api({ getSearchFacets: async () => { if (failing) throw new Error('facets unavailable'); return { tags: ['recovered'], blockTypes: ['todo'] } },
    listSavedSearches: async () => { if (failing) throw new Error('inventory unavailable'); return [{ id: 'recovered', name: 'Recovered search', input: { query: 'retained' } }] }
  }), async ({ render }) => {
    await render(<Harness />); await act(async () => t.mock.timers.tick(200))
    assert.equal(state.facetError, 'facets unavailable'); assert.equal(state.savedListError, 'inventory unavailable'); assert.equal(state.result?.total, 26)
    failing = false
    await act(async () => { state.refreshFacets(); state.refreshSaved() })
    assert.equal(state.facetError, ''); assert.equal(state.savedListError, ''); assert.deepEqual(state.facets.tags, ['recovered'])
    assert.equal(state.savedSearches[0].name, 'Recovered search')
  })
})

test('search page exposes usable filters and pagination, safely highlights text, and preserves rejected navigation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requests: WorkspaceSearchInput[] = [], opened: string[][] = [], copied: string[] = []
  const common = { isActive: true, isZh: false, documentTree: [{ id: 'folder', title: 'Folder', path: 'Folder', updatedAt: '2026-09-30', children: [] }],
    request: { query: 'needle', sequence: 1 }, onOpenDocument: () => false,
    onOpenBlock: (documentId: string, blockId: string) => { opened.push([documentId, blockId]); return false } }
  await withRenderer(api({ searchWorkspace: async (input) => { requests.push(input); return searchPage(input) },
    writeClipboardText: async (text) => { copied.push(text) }
  }), async ({ render, document, window }) => {
    const tick = () => act(async () => t.mock.timers.tick(200))
    const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)!
    const control = (label: string) => {
      const element = [...document.querySelectorAll<HTMLLabelElement>('label')].find((item) => item.querySelector('.editor-label')?.textContent === label)!
      return document.getElementById(element.htmlFor) as HTMLInputElement | HTMLSelectElement
    }
    const changeSelect = async (label: string, value: string) => act(async () => {
      const select = control(label) as HTMLSelectElement; select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    await render(<SearchPage {...common} />); await tick()
    for (const element of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.workspace-search-field input, .workspace-search-field select')) {
      const label = document.getElementById(element.getAttribute('aria-labelledby') ?? '')
      assert.ok(label?.matches('.editor-label'), 'Every control has a clear, explicit accessible name that excludes option text')
    }
    assert.equal(document.querySelector('[data-testid="workspace-search-total"]')?.getAttribute('data-total-number'), '26')
    assert.ok(document.querySelector('[data-testid="workspace-search-result"] mark'))
    assert.equal(document.querySelector('[data-testid="workspace-search-result"] script'), null)
    assert.match(document.querySelector('.workspace-search-snippet')!.textContent!, /<script>alert\(1\)<\/script>/)
    await act(async () => button('Next page').click()); await tick()
    assert.equal(requests.at(-1)?.page, 2); assert.match(document.querySelector('.workspace-search-pagination')!.textContent!, /Page 2 of 2/)
    await changeSelect('Folder', 'folder'); await changeSelect('Tag', 'review'); await changeSelect('Block type', 'todo'); await changeSelect('Match mode', 'any'); await tick()
    assert.equal(requests.at(-1)?.page, 1); assert.equal(requests.at(-1)?.folderId, 'folder'); assert.equal(requests.at(-1)?.tag, 'review'); assert.equal(requests.at(-1)?.blockType, 'todo')
    await act(async () => button('Go to block').click())
    assert.deepEqual(opened, [['doc-1', 'block-1']]); assert.match(document.querySelector('.workspace-search-action-feedback')!.textContent!, /Your search is preserved/)
    assert.equal(control('Keywords').value, 'needle'); assert.equal(control('Tag').value, 'review')
    await act(async () => button('Copy document link').click())
    assert.deepEqual(copied, ['[Result 1](/Folder/Result.md)']); assert.match(document.querySelector('.workspace-search-action-feedback')!.textContent!, /Document link copied/)
    await act(async () => button('Clear filters').click()); await tick()
    assert.equal(control('Tag').value, ''); assert.equal(control('Folder').value, ''); assert.equal(control('Keywords').value, 'needle')
  })
})

test('search result navigation supplies a guard that expires on a new query and when the page is hidden', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = deferred<void>()
  let guard: (() => boolean) | undefined
  const common = { isActive: true, isZh: false, documentTree: [], request: { query: 'needle', sequence: 1 }, onOpenDocument: () => false,
    onOpenBlock: async (_documentId: string, _blockId: string, shouldContinue?: () => boolean) => {
      guard = shouldContinue; await pending.promise; return guard?.() ? true : false
    } }
  await withRenderer(api(), async ({ render, document }) => {
    await render(<SearchPage {...common} />); await act(async () => t.mock.timers.tick(200))
    const open = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === 'Go to block')!
    await act(async () => open.click()); assert.equal(guard?.(), true)
    await render(<SearchPage {...common} request={{ query: 'newer', sequence: 2 }} />)
    assert.equal(guard?.(), false)
    await render(<SearchPage {...common} isActive={false} request={{ query: 'newer', sequence: 2 }} />)
    assert.equal(guard?.(), false)
    await act(async () => pending.resolve())
    assert.equal(document.querySelector('.workspace-search-action-feedback'), null)
  })
})

test('saved search controls use a collapsed native disclosure and retain their draft when reopened', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const common = { isActive: true, isZh: false, documentTree: [], request: null, onOpenDocument: () => false, onOpenBlock: () => false }
  await withRenderer(api(), async ({ render, document, window }) => {
    await render(<SearchPage {...common} />); await act(async () => t.mock.timers.tick(200))
    const details = document.querySelector<HTMLDetailsElement>('.workspace-search-saved-panel')!
    const summary = details.querySelector('summary')!
    assert.equal(details.tagName, 'DETAILS'); assert.equal(details.firstElementChild, summary)
    assert.equal(summary.textContent, 'Save and load searches'); assert.equal(details.open, false)
    assert.equal(details.getAttribute('role'), null, 'The disclosure keeps its native accessible semantics')
    assert.equal(details.contains(document.querySelector('[data-testid="workspace-search-results"]')), false, 'Results remain outside the collapsed controls')
    await act(async () => summary.click()); assert.equal(details.open, true)
    const name = details.querySelector<HTMLInputElement>('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(name, 'Draft search name')
      name.dispatchEvent(new window.InputEvent('input', { bubbles: true, data: 'Draft search name', inputType: 'insertText' }))
    })
    await act(async () => summary.click()); assert.equal(details.open, false)
    await act(async () => summary.click()); assert.equal(details.open, true); assert.equal(name.value, 'Draft search name')
    await render(<SearchPage {...common} isZh />)
    assert.equal(summary.textContent, '保存与加载检索'); assert.equal(details.open, true); assert.equal(name.value, 'Draft search name')
  })
})
