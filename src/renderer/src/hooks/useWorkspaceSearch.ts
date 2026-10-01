import { useEffect, useRef, useState } from 'react'
import type { SavedWorkspaceSearch, WorkspaceSearchFacets, WorkspaceSearchInput, WorkspaceSearchPage } from '@shared/workspace-search'
import { getErrorMessage } from '../utils/errorMessage'

export const defaultWorkspaceSearchInput: WorkspaceSearchInput = {
  query: '', scope: 'all', matchMode: 'all', folderId: null, tag: '', blockType: '',
  updatedFrom: '', updatedTo: '', sort: 'relevance', page: 1, pageSize: 25
}

export type WorkspaceSearchRequest = { query: string; sequence: number }

/** Owns the full search independently of the document editor and quick palette. */
export function useWorkspaceSearch({ isActive, isZh, request }: {
  isActive: boolean; isZh: boolean; request: WorkspaceSearchRequest | null
}) {
  const [input, setInput] = useState<WorkspaceSearchInput>({ ...defaultWorkspaceSearchInput })
  const [result, setResult] = useState<WorkspaceSearchPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [facets, setFacets] = useState<WorkspaceSearchFacets>({ tags: [], blockTypes: [] })
  const [facetError, setFacetError] = useState('')
  const [savedSearches, setSavedSearches] = useState<SavedWorkspaceSearch[]>([])
  const [savedListError, setSavedListError] = useState('')
  const [savedLoading, setSavedLoading] = useState(false)
  const [savedBusy, setSavedBusy] = useState(false)
  const [savedError, setSavedError] = useState('')
  const [savedFeedback, setSavedFeedback] = useState('')
  const [savedId, setSavedId] = useState('')
  const [savedName, setSavedName] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [facetRefresh, setFacetRefresh] = useState(0)
  const [savedRefresh, setSavedRefresh] = useState(0)
  const mounted = useRef(false), searchSequence = useRef(0), facetSequence = useRef(0), savedListSequence = useRef(0)
  const saving = useRef(false), latestRequest = useRef<number | null>(null), savedContext = useRef(0)
  const normalizedInput = useRef<{ input: WorkspaceSearchInput; refresh: number } | null>(null)
  const active = useRef(isActive)
  active.current = isActive

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!request || latestRequest.current === request.sequence) return
    latestRequest.current = request.sequence
    savedContext.current++
    searchSequence.current++
    setInput({ ...defaultWorkspaceSearchInput, query: request.query })
    setSavedId(''); setSavedName(''); setSavedError(''); setSavedFeedback('')
  }, [request?.sequence, request?.query])

  const invalidate = () => { searchSequence.current++; setError(''); setLoading(true) }
  const updateInput = (patch: Partial<WorkspaceSearchInput>) => {
    savedContext.current++
    invalidate()
    setInput((current) => ({ ...current, ...patch, page: patch.page ?? 1 }))
  }
  const clearFilters = () => {
    savedContext.current++
    invalidate()
    setInput((current) => ({ ...defaultWorkspaceSearchInput, query: current.query, pageSize: current.pageSize }))
  }
  const retry = () => { invalidate(); setRefresh((value) => value + 1) }
  const refreshFacets = () => setFacetRefresh((value) => value + 1)
  const refreshSaved = () => setSavedRefresh((value) => value + 1)

  useEffect(() => window.knowbook.onWorkspaceMutated(() => {
    searchSequence.current++; facetSequence.current++
    setRefresh((value) => value + 1); setFacetRefresh((value) => value + 1)
  }), [])

  useEffect(() => {
    const sequence = ++searchSequence.current
    const alreadyLoaded = normalizedInput.current?.input === input && normalizedInput.current.refresh === refresh
    normalizedInput.current = null
    if (!isActive) { setLoading(false); return }
    if (alreadyLoaded) return
    setLoading(true); setError('')
    const timer = setTimeout(() => {
      void window.knowbook.searchWorkspace(input).then((page) => {
        if (mounted.current && active.current && sequence === searchSequence.current) {
          setResult(page); setLoading(false)
          if (page.page !== input.page) {
            const normalized = { ...input, page: page.page }
            normalizedInput.current = { input: normalized, refresh }
            setInput(normalized)
          }
        }
      }).catch((cause) => {
        if (mounted.current && active.current && sequence === searchSequence.current) {
          setError(getErrorMessage(cause, isZh ? '搜索失败，请重试。' : 'Search failed. Please retry.')); setLoading(false)
        }
      })
    }, 180)
    return () => { clearTimeout(timer); searchSequence.current++ }
  }, [input, isActive, refresh, isZh])

  useEffect(() => {
    const sequence = ++facetSequence.current
    if (!isActive) return
    setFacetError('')
    void window.knowbook.getSearchFacets().then((value) => {
      if (mounted.current && active.current && sequence === facetSequence.current) setFacets(value)
    }).catch((cause) => {
      if (mounted.current && active.current && sequence === facetSequence.current)
        setFacetError(getErrorMessage(cause, isZh ? '无法加载标签与内容类型。' : 'Could not load tags and block types.'))
    })
    return () => { facetSequence.current++ }
  }, [isActive, facetRefresh, isZh])

  useEffect(() => {
    const sequence = ++savedListSequence.current
    if (!isActive) { setSavedLoading(false); return }
    setSavedLoading(true); setSavedListError('')
    void window.knowbook.listSavedSearches().then((value) => {
      if (mounted.current && active.current && sequence === savedListSequence.current) { setSavedSearches(value); setSavedLoading(false) }
    }).catch((cause) => {
      if (mounted.current && active.current && sequence === savedListSequence.current) {
        setSavedListError(getErrorMessage(cause, isZh ? '无法加载已保存检索。' : 'Could not load saved searches.')); setSavedLoading(false)
      }
    })
    return () => { savedListSequence.current++ }
  }, [isActive, savedRefresh, isZh])

  const loadSaved = (id: string) => {
    const saved = savedSearches.find((item) => item.id === id)
    if (!saved) return
    savedContext.current++
    invalidate()
    setInput({ ...defaultWorkspaceSearchInput, ...saved.input, page: 1 })
    setSavedId(saved.id); setSavedName(saved.name); setSavedError(''); setSavedFeedback('')
  }
  const save = async (updateExisting = false) => {
    if (saving.current) return
    if (!savedName.trim()) { setSavedError(isZh ? '请输入检索名称。' : 'Enter a search name.'); return }
    saving.current = true; setSavedBusy(true); setSavedError(''); setSavedFeedback('')
    // Capture the exact query being named, even if the user edits while saving.
    const name = savedName.trim(), searchInput = { ...input, page: 1 }, id = updateExisting ? savedId : undefined, context = savedContext.current
    try {
      const saved = await window.knowbook.saveSearch({ name, input: searchInput, ...(id ? { id } : {}) })
      if (!mounted.current) return
      // A pending list request must never overwrite this successful mutation.
      savedListSequence.current++
      setSavedLoading(false); setSavedListError('')
      setSavedSearches((items) => [...items.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)))
      setSavedRefresh((value) => value + 1)
      if (context === savedContext.current) {
        setSavedId(saved.id)
        setSavedFeedback(isZh ? '检索已保存，下次可直接加载。' : 'Search saved. Load it again next time.')
      }
    } catch (cause) {
      if (mounted.current && context === savedContext.current) setSavedError(getErrorMessage(cause, isZh ? '保存失败，名称和筛选已保留。' : 'Could not save. Your name and filters are preserved.'))
    } finally { saving.current = false; if (mounted.current) setSavedBusy(false) }
  }
  const deleteSaved = async (id: string) => {
    if (!id || saving.current) return
    saving.current = true; setSavedBusy(true); setSavedError(''); setSavedFeedback('')
    const context = savedContext.current
    try {
      await window.knowbook.deleteSavedSearch(id)
      if (!mounted.current) return
      savedListSequence.current++; setSavedLoading(false); setSavedListError('')
      setSavedSearches((items) => items.filter((item) => item.id !== id))
      setSavedRefresh((value) => value + 1)
      setSavedId((current) => current === id ? '' : current)
      if (context === savedContext.current) setSavedFeedback(isZh ? '已删除保存的检索，当前筛选已保留。' : 'Saved search deleted. Your current filters are preserved.')
    } catch (cause) {
      if (mounted.current && context === savedContext.current) setSavedError(getErrorMessage(cause, isZh ? '删除失败，请重试。' : 'Could not delete. Please retry.'))
    } finally { saving.current = false; if (mounted.current) setSavedBusy(false) }
  }
  return { input, result, loading, error, facets, facetError, savedSearches, savedListError, savedLoading, savedBusy,
    savedId, savedName, savedError, savedFeedback,
    setSavedId: (value: string) => { savedContext.current++; setSavedId(value) },
    setSavedName: (value: string) => { savedContext.current++; setSavedName(value) }, updateInput, clearFilters, retry,
    refreshFacets, refreshSaved, loadSaved, save, deleteSaved }
}
