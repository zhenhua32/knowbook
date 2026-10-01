import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React, { act, type ReactNode } from 'react'
import { JSDOM } from 'jsdom'
import type { ElectronApi } from '../src/shared/contracts'
import type { SavedWorkspaceSearch, WorkspaceSearchInput, WorkspaceSearchPage, WorkspaceSearchResult } from '../src/shared/workspace-search'
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
    await act(async () => document.querySelector<HTMLButtonElement>('.workspace-search-filter-toggle')!.click())
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

test('collapsed filters remain applied and removable without losing the query, page size or keyboard focus', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requests: WorkspaceSearchInput[] = []
  const common = { isActive: true, isZh: false, documentTree: [], request: { query: 'needle', sequence: 1 }, onOpenDocument: () => false, onOpenBlock: () => false }
  await withRenderer(api({ searchWorkspace: async (input) => { requests.push(input); return searchPage(input, 130) } }), async ({ render, document, window }) => {
    const tick = () => act(async () => t.mock.timers.tick(200))
    await render(<SearchPage {...common} />); await tick()
    const toggle = document.querySelector<HTMLButtonElement>('.workspace-search-filter-toggle')!
    const advanced = document.getElementById(toggle.getAttribute('aria-controls')!)!
    assert.equal(toggle.getAttribute('aria-expanded'), 'false'); assert.equal(advanced.hidden, true)
    assert.equal(advanced.contains(document.querySelector('[data-testid="workspace-search-results"]')), false)
    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-expanded'), 'true'); assert.equal(advanced.hidden, false)
    const change = async (suffix: string, value: string) => act(async () => {
      const select = document.querySelector<HTMLSelectElement>(`select[id$="-${suffix}"]`)!
      select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    await change('scope', 'blocks'); await change('tag', 'review'); await change('page-size', '50'); await tick()
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Next page')!.click()); await tick()
    assert.equal(requests.at(-1)?.page, 2)
    await act(async () => toggle.click())
    assert.equal(advanced.hidden, true); assert.equal(requests.at(-1)?.tag, 'review')
    assert.equal(document.querySelectorAll('.workspace-search-filter-chip').length, 2)
    const removeTag = document.querySelector<HTMLButtonElement>('[aria-label="Remove tag filter: review"]')!
    await act(async () => { removeTag.focus(); removeTag.click() }); await tick()
    assert.equal(requests.at(-1)?.tag, ''); assert.equal(requests.at(-1)?.scope, 'blocks')
    assert.equal(requests.at(-1)?.query, 'needle'); assert.equal(requests.at(-1)?.page, 1); assert.equal(requests.at(-1)?.pageSize, 50)
    assert.equal(document.activeElement, toggle, 'Removing a focused condition returns focus to its stable disclosure')
    await render(<SearchPage {...common} isZh />); await tick()
    assert.equal(toggle.getAttribute('aria-label'), '筛选'); assert.equal(advanced.hidden, true)
    assert.match(document.querySelector('.workspace-search-filter-chip')!.textContent!, /范围: 仅内容块/)
    await act(async () => toggle.click())
    assert.equal(document.querySelector<HTMLSelectElement>('select[id$="-scope"]')!.value, 'blocks')
    assert.equal(document.querySelector<HTMLSelectElement>('select[id$="-tag"]')!.value, '')
  })
})

test('empty results offer direct recovery while an empty workspace gives an appropriate first step', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requests: WorkspaceSearchInput[] = []
  const common = { isActive: true, isZh: false, documentTree: [], request: { query: 'missing words', sequence: 1 }, onOpenDocument: () => false, onOpenBlock: () => false }
  await withRenderer(api({ searchWorkspace: async (input) => { requests.push(input); return searchPage(input, input.query || input.tag ? 0 : 26) } }), async ({ render, document, window }) => {
    const tick = () => act(async () => t.mock.timers.tick(200))
    const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!
    await render(<SearchPage {...common} />); await tick()
    assert.match(document.querySelector('.workspace-search-empty')!.textContent!, /No matching results/)
    await act(async () => button('Match any word').click()); await tick()
    assert.equal(requests.at(-1)?.matchMode, 'any'); assert.equal(requests.at(-1)?.query, 'missing words')
    await act(async () => document.querySelector<HTMLButtonElement>('.workspace-search-filter-toggle')!.click())
    await act(async () => {
      const select = document.querySelector<HTMLSelectElement>('select[id$="-tag"]')!
      select.value = 'review'; select.dispatchEvent(new window.Event('change', { bubbles: true }))
    }); await tick()
    await act(async () => button('Search without filters').click()); await tick()
    assert.equal(requests.at(-1)?.tag, ''); assert.equal(requests.at(-1)?.matchMode, 'all'); assert.equal(requests.at(-1)?.query, 'missing words')
    await act(async () => button('Browse all content').click()); await tick()
    assert.equal(requests.at(-1)?.query, ''); assert.equal(requests.at(-1)?.page, 1)
    assert.equal(document.querySelector('.workspace-search-empty'), null)
    assert.equal(document.activeElement, document.querySelector('input[type="search"]'))
  })
  await withRenderer(api({ searchWorkspace: async (input) => searchPage(input, 0) }), async ({ render, document }) => {
    await render(<SearchPage {...common} request={null} />); await act(async () => t.mock.timers.tick(200))
    assert.match(document.querySelector('.workspace-search-empty')!.textContent!, /No searchable content yet.*Add a document/)
    assert.equal(document.querySelector('.workspace-search-empty-actions')!.childElementCount, 0)
  })
})

test('IME confirmation cannot submit the query, while a subsequent ordinary Enter can search', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let requests = 0
  await withRenderer(api({ searchWorkspace: async (input) => { requests++; return searchPage(input) } }), async ({ render, document, window }) => {
    await render(<SearchPage isActive isZh documentTree={[]} request={null} onOpenDocument={() => false} onOpenBlock={() => false} />)
    const tick = () => act(async () => t.mock.timers.tick(200))
    await tick(); assert.equal(requests, 1)
    const input = document.querySelector<HTMLInputElement>('input[type="search"]')!, form = input.closest('form')!
    const confirmation = new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true })
    await act(async () => input.dispatchEvent(confirmation))
    assert.equal(confirmation.defaultPrevented, true)
    await act(async () => {
      input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }))
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    }); await tick(); assert.equal(requests, 1, 'The form also rejects submission while composition is active')
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
    const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => input.dispatchEvent(enter)); assert.equal(enter.defaultPrevented, false)
    await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    await tick(); assert.equal(requests, 2)
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

function actionResult(blockId?: string): WorkspaceSearchResult {
  return { documentId: 'owner-doc', documentTitle: 'Shared result', documentPath: 'Folder/Shared result',
    matchType: blockId ? 'block' : 'title', snippet: 'needle in the result', updatedAt: '2026-09-30T04:00:00Z',
    tags: ['review'], ...(blockId ? { blockId, blockType: 'paragraph' } : {}) }
}

function actionPage(input: WorkspaceSearchInput, items: WorkspaceSearchResult[]): WorkspaceSearchPage {
  return { page: input.page ?? 1, pageSize: input.pageSize ?? 25, total: 26,
    queryTerms: input.query.trim().split(/\s+/).filter(Boolean), items }
}

function actionRow(document: Document, blockId: string | null, documentId = 'owner-doc'): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>('[data-testid="workspace-search-result"]')]
    .find((element) => element.dataset.documentId === documentId && element.dataset.blockId === (blockId ?? ''))
  assert.ok(row, 'The intended document/block result is present')
  return row
}

function resultAction(row: HTMLElement, kind: 'open' | 'document' | 'copy'): HTMLButtonElement {
  const buttons = [...row.querySelectorAll<HTMLButtonElement>('.workspace-search-result-actions button')]
  const button = kind === 'copy' ? buttons.at(-1) : kind === 'document' ? buttons[1] : buttons[0]
  assert.ok(button, 'The intended result action is present')
  return button
}

function ownerFeedback(document: Document, row: HTMLElement, role: 'status' | 'alert'): HTMLElement {
  const feedback = document.querySelector<HTMLElement>('.workspace-search-action-feedback')
  assert.equal(document.querySelectorAll('.workspace-search-action-feedback').length, 1, 'Only one operation is announced')
  assert.equal(row.contains(feedback), true, 'Feedback belongs to the document/block row that started the action')
  assert.equal(feedback?.getAttribute('role'), role)
  assert.ok(feedback?.id, 'The feedback can be referenced by the action that produced it')
  return feedback!
}

function assertDescribedBy(button: HTMLButtonElement, feedback: HTMLElement): void {
  assert.equal((button.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(feedback.id), true,
    'The action exposes its own progress or result to assistive technology')
}

test('result copy feedback stays with the exact row, retains its action, and rejects same-frame duplicate operations', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const items = [actionResult(), actionResult('document'), actionResult('block-a'), actionResult('block-b')]
  const copies: { text: string; response: ReturnType<typeof deferred<void>> }[] = []
  let opened = 0
  const common = { isActive: true, isZh: false, documentTree: [], request: { query: 'needle', sequence: 1 },
    onOpenDocument: () => { opened++; return false }, onOpenBlock: () => { opened++; return false } }
  await withRenderer(api({ searchWorkspace: async (input) => actionPage(input, items), writeClipboardText: (text) => {
    const response = deferred<void>(); copies.push({ text, response }); return response.promise
  } }), async ({ render, document }) => {
    await render(<SearchPage {...common} />); await act(async () => t.mock.timers.tick(200))
    const row = actionRow(document, 'block-a'), copy = resultAction(row, 'copy')
    await act(async () => {
      copy.focus(); copy.click(); copy.click()
      resultAction(row, 'open').click(); resultAction(actionRow(document, 'block-b'), 'copy').click()
    })
    assert.equal(copies.length, 1); assert.equal(opened, 0)
    assert.equal(copies[0].text, '[Shared result](/Folder/Shared%20result.md)')
    assert.equal(copy.disabled, false, 'The pending Copy action remains a native keyboard focus target')
    assert.equal(copy.getAttribute('aria-disabled'), 'true')
    assert.equal(document.activeElement === copy, true)
    const progress = ownerFeedback(document, row, 'status')
    assert.match(progress.textContent!, /copy/i); assertDescribedBy(copy, progress)
    for (const button of document.querySelectorAll<HTMLButtonElement>('.workspace-search-result-actions button')) {
      if (button !== copy) assert.equal(button.disabled, true, 'Other result operations retain the global busy lock')
    }
    await act(async () => copies[0].response.reject(new Error('Clipboard unavailable')))
    const failure = ownerFeedback(document, row, 'alert')
    assert.match(failure.textContent!, /Clipboard unavailable/); assertDescribedBy(copy, failure)
    assert.equal(copy.disabled, false); assert.notEqual(copy.getAttribute('aria-disabled'), 'true')
    await act(async () => copy.click())
    assert.equal(copies.length, 2)
    assert.equal(document.querySelectorAll('.workspace-search-action-feedback[role="alert"]').length, 0)
    ownerFeedback(document, row, 'status')
    await act(async () => copies[1].response.resolve())
    assert.match(ownerFeedback(document, row, 'status').textContent!, /Document link copied/)

    const collisionRow = actionRow(document, 'document'), titleRow = actionRow(document, null)
    const collisionCopy = resultAction(collisionRow, 'copy')
    await act(async () => collisionCopy.click())
    assert.equal(copies.length, 3)
    assertDescribedBy(collisionCopy, ownerFeedback(document, collisionRow, 'status'))
    assert.equal(titleRow.querySelectorAll('.workspace-search-action-feedback').length, 0,
      'A block literally named document cannot share feedback with its document-title result')
    await act(async () => copies[2].response.resolve())
    ownerFeedback(document, collisionRow, 'status')
    assert.equal(row.querySelectorAll('.workspace-search-action-feedback').length, 0)
  })
})

test('result navigation feedback preserves filters on rejection, permits retry, and tolerates a draft-triggered workspace refresh', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let listener: () => void = () => undefined
  let reversed = false, blockResponse = deferred<boolean>()
  const documentResponse = deferred<boolean>(), requests: WorkspaceSearchInput[] = []
  const blockOpens: { documentId: string; blockId: string; guard?: () => boolean }[] = []
  const documentOpens: string[] = []
  const items = [actionResult(), actionResult('block-a'), actionResult('block-b')]
  const common = { isActive: true, isZh: false, documentTree: [], request: { query: 'needle', sequence: 1 },
    onOpenBlock: (documentId: string, blockId: string, guard?: () => boolean) => {
      blockOpens.push({ documentId, blockId, guard }); return blockResponse.promise
    }, onOpenDocument: (documentId: string) => { documentOpens.push(documentId); return documentResponse.promise } }
  await withRenderer(api({ onWorkspaceMutated: (callback) => { listener = callback; return () => undefined },
    searchWorkspace: async (input) => { requests.push(input); return actionPage(input, reversed ? [...items].reverse() : items) }
  }), async ({ render, document, window }) => {
    const tick = () => act(async () => t.mock.timers.tick(200))
    await render(<SearchPage {...common} />); await tick()
    await act(async () => {
      const select = document.querySelector<HTMLSelectElement>('select[id$="-tag"]')!
      select.value = 'review'; select.dispatchEvent(new window.Event('change', { bubbles: true }))
    }); await tick()
    let row = actionRow(document, 'block-a')
    await act(async () => resultAction(row, 'open').click())
    assert.equal(blockOpens.length, 1); assert.equal(blockOpens[0].guard?.(), true)
    assertDescribedBy(resultAction(row, 'open'), ownerFeedback(document, row, 'status'))
    for (const button of document.querySelectorAll<HTMLButtonElement>('.workspace-search-result-actions button')) {
      assert.equal(button.disabled, true, 'Opening keeps native disabling for every result action')
    }
    reversed = true
    await act(async () => listener()); await tick()
    assert.equal(blockOpens[0].guard?.(), true, 'A save-triggered refresh must not cancel an otherwise current document jump')
    row = actionRow(document, 'block-a')
    await act(async () => blockResponse.resolve(false))
    assert.match(ownerFeedback(document, row, 'alert').textContent!, /Your search is preserved/)
    assert.equal(document.querySelector<HTMLInputElement>('input[type="search"]')!.value, 'needle')
    assert.equal(document.querySelector<HTMLSelectElement>('select[id$="-tag"]')!.value, 'review')
    assert.equal(requests.at(-1)?.tag, 'review')

    const documentRow = actionRow(document, 'block-b')
    await act(async () => resultAction(documentRow, 'document').click())
    assert.deepEqual(documentOpens, ['owner-doc'])
    assert.equal(row.querySelectorAll('.workspace-search-action-feedback').length, 0)
    await act(async () => documentResponse.reject(new Error('Navigation failed')))
    const failure = ownerFeedback(document, documentRow, 'alert')
    assert.match(failure.textContent!, /Navigation failed/)
    assertDescribedBy(resultAction(documentRow, 'document'), failure)
    assert.equal(document.querySelector<HTMLInputElement>('input[type="search"]')!.value, 'needle')
    assert.equal(document.querySelector<HTMLSelectElement>('select[id$="-tag"]')!.value, 'review')
    blockResponse = deferred<boolean>()
    await act(async () => resultAction(row, 'open').click())
    assert.equal(blockOpens.length, 2)
    assert.equal(documentRow.querySelectorAll('.workspace-search-action-feedback').length, 0)
    ownerFeedback(document, row, 'status')
    await act(async () => blockResponse.resolve(true))
    assert.equal(document.querySelectorAll('.workspace-search-action-feedback').length, 0)
  })
})

test('pending result acknowledgements expire on unsubmitted query edits, pagination, hiding and unmount without releasing the live lock early', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const copies: ReturnType<typeof deferred<void>>[] = [], requests: WorkspaceSearchInput[] = []
  const common = { isActive: true, isZh: false, documentTree: [], request: { query: 'needle', sequence: 1 },
    onOpenDocument: () => false, onOpenBlock: () => false }
  await withRenderer(api({ searchWorkspace: async (input) => {
    requests.push(input); return actionPage(input, [actionResult('block-a')])
  }, writeClipboardText: () => { const response = deferred<void>(); copies.push(response); return response.promise }
  }), async ({ render, document, window }) => {
    const tick = () => act(async () => t.mock.timers.tick(200))
    const copy = () => resultAction(actionRow(document, 'block-a'), 'copy')
    const noFeedback = () => assert.equal(document.querySelectorAll('.workspace-search-action-feedback').length, 0)
    await render(<SearchPage {...common} />); await tick()
    await act(async () => copy().click())
    const input = document.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'new query')
      input.dispatchEvent(new window.InputEvent('input', { bubbles: true, data: 'new query', inputType: 'insertText' }))
    })
    assert.equal(input.value, 'new query'); assert.equal(requests.length, 1, 'The changed query has not reached the debounced IPC yet')
    noFeedback()
    await tick()
    await act(async () => copy().click())
    assert.equal(copies.length, 1, 'The invalidated owner does not release a still-pending clipboard operation')
    await act(async () => copies[0].reject(new Error('Old query failure')))
    noFeedback()

    await act(async () => copy().click()); assert.equal(copies.length, 2)
    await act(async () => document.querySelector<HTMLButtonElement>('.workspace-search-pagination button:last-child')!.click())
    noFeedback()
    await act(async () => copies[1].resolve())
    noFeedback(); await tick(); assert.equal(requests.at(-1)?.page, 2)

    await act(async () => copy().click()); assert.equal(copies.length, 3)
    await render(<SearchPage {...common} isActive={false} />)
    noFeedback()
    await act(async () => copies[2].reject(new Error('Hidden page failure')))
    await render(<SearchPage {...common} />); await tick()
    noFeedback()
    assert.equal(document.querySelector<HTMLInputElement>('input[type="search"]')!.value, 'new query')

    await act(async () => copy().click()); assert.equal(copies.length, 4)
    await render(null)
    await render(<SearchPage {...common} />); await tick()
    await act(async () => copy().click()); assert.equal(copies.length, 5)
    await act(async () => copies[3].reject(new Error('Unmounted owner failure')))
    const row = actionRow(document, 'block-a')
    ownerFeedback(document, row, 'status')
    assert.equal(copy().getAttribute('aria-disabled'), 'true', 'An old instance cannot release the new instance action')
    await act(async () => copies[4].resolve())
    assert.match(ownerFeedback(document, row, 'status').textContent!, /Document link copied/)
  })
})

test('same-query refresh keeps feedback with reordered identities but suppresses obsolete copied links and removed owners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let listener: () => void = () => undefined
  let items = [actionResult(), actionResult('block-a'), actionResult('block-b')]
  const copies: { text: string; response: ReturnType<typeof deferred<void>> }[] = []
  const common = { isActive: true, isZh: false, documentTree: [], request: { query: 'needle', sequence: 1 },
    onOpenDocument: () => false, onOpenBlock: () => false }
  await withRenderer(api({ onWorkspaceMutated: (callback) => { listener = callback; return () => undefined },
    searchWorkspace: async (input) => actionPage(input, items.map((item) => ({ ...item }))),
    writeClipboardText: (text) => { const response = deferred<void>(); copies.push({ text, response }); return response.promise }
  }), async ({ render, document }) => {
    const refresh = async () => { await act(async () => listener()); await act(async () => t.mock.timers.tick(200)) }
    const noFeedback = () => assert.equal(document.querySelectorAll('.workspace-search-action-feedback').length, 0)
    await render(<SearchPage {...common} />); await act(async () => t.mock.timers.tick(200))
    await act(async () => resultAction(actionRow(document, 'block-a'), 'copy').click())
    items = [...items].reverse(); await refresh()
    await act(async () => copies[0].response.resolve())
    ownerFeedback(document, actionRow(document, 'block-a'), 'status')
    assert.equal(actionRow(document, null).querySelectorAll('.workspace-search-action-feedback').length, 0)

    await act(async () => resultAction(actionRow(document, null), 'copy').click())
    items = items.map((item) => ({ ...item, documentTitle: 'Renamed result', documentPath: 'Moved/Renamed result' }))
    await refresh(); noFeedback()
    await act(async () => copies[1].response.resolve())
    noFeedback()
    assert.equal(copies[1].text, '[Shared result](/Folder/Shared%20result.md)', 'The old native write cannot be undone by a refresh')
    await act(async () => resultAction(actionRow(document, 'block-a'), 'copy').click())
    assert.equal(copies[2].text, '[Renamed result](/Moved/Renamed%20result.md)')
    items = items.map((item) => ({ ...item, snippet: 'Updated content without a changed link', tags: ['new-tag'] }))
    await refresh()
    await act(async () => copies[2].response.resolve())
    assert.match(ownerFeedback(document, actionRow(document, 'block-a'), 'status').textContent!, /Document link copied/,
      'Replacing the result object alone does not invalidate an unchanged copied link')

    await act(async () => resultAction(actionRow(document, 'block-b'), 'copy').click())
    const removed = items.find((item) => item.blockId === 'block-b')!
    items = items.filter((item) => item !== removed); await refresh(); noFeedback()
    await act(async () => copies[3].response.reject(new Error('Removed row failure')))
    noFeedback()
    items = [...items, removed]; await refresh()
    noFeedback()
  })
})
