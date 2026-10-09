import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { DocumentTreeNode } from '@shared/contracts'
import type { WorkspaceSearchInput, WorkspaceSearchResult } from '@shared/workspace-search'
import { defaultWorkspaceSearchInput, useWorkspaceSearch, type WorkspaceSearchRequest } from '../hooks/useWorkspaceSearch'
import { getUiText } from '../i18n'
import { getErrorMessage } from '../utils/errorMessage'
import { searchResultDocumentLink } from '../utils/searchResultLink'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import './workspace-search.css'

export type SearchPageProps = {
  isActive: boolean
  isZh: boolean
  documentTree: DocumentTreeNode[]
  request: WorkspaceSearchRequest | null
  onOpenDocument: (id: string, shouldContinue?: () => boolean) => boolean | void | Promise<boolean | void>
  onOpenBlock: (documentId: string, blockId: string, shouldContinue?: () => boolean) => boolean | void | Promise<boolean | void>
}

type SearchAction = 'open' | 'document' | 'copy'
type SearchActionContext = {
  item: WorkspaceSearchResult
  action: SearchAction
  input: WorkspaceSearchInput
  requestSequence: number | undefined
  sequence: number
}

function matchesActionResult(context: SearchActionContext, item: WorkspaceSearchResult): boolean {
  return context.item.documentId === item.documentId && (context.item.blockId ?? null) === (item.blockId ?? null)
    && (context.action !== 'copy' || (context.item.documentTitle === item.documentTitle && context.item.documentPath === item.documentPath))
}

function flattenTree(nodes: DocumentTreeNode[]): DocumentTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)])
}

/** Results are text, including text that looks like HTML or Markdown. */
function MatchText({ text, terms }: { text: string; terms: string[] }) {
  const literals = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!literals.length) return <>{text}</>
  const pattern = new RegExp(`(${literals.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu')
  return <>{text.split(pattern).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</>
}

export default function SearchPage({ isActive, isZh, documentTree, request, onOpenDocument, onOpenBlock }: SearchPageProps) {
  const search = useWorkspaceSearch({ isActive, isZh, request })
  const { input, result, loading } = search
  const id = useId(), queryInput = useRef<HTMLInputElement>(null)
  const resultsHeading = useRef<HTMLHeadingElement>(null)
  const paginationIntent = useRef<{
    token: number; trigger: HTMLButtonElement; requestSequence: number | undefined; isZh: boolean; cleanup: () => void
  } | null>(null)
  const filterToggle = useRef<HTMLButtonElement>(null), composing = useRef(false)
  const mounted = useRef(false), actionLock = useRef(false), actionSequence = useRef(0)
  const current = useRef({ isActive, input, result, requestSequence: request?.sequence })
  current.current = { isActive, input, result, requestSequence: request?.sequence }
  const [busy, setBusy] = useState<SearchActionContext | null>(null)
  const [filtersExpanded, setFiltersExpanded] = useState(false)
  const [feedback, setFeedback] = useState<{ context: SearchActionContext; message: string; error: boolean } | null>(null)
  const choose = (zh: string, en: string) => isZh ? zh : en
  const folders = flattenTree(documentTree)
  const blockLabels = getUiText(isZh ? 'zh-CN' : 'en-US').blockTypeBadges
  const pages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1
  const page = result?.page ?? input.page ?? 1
  const from = result && result.total > 0 ? (result.page - 1) * result.pageSize + 1 : 0
  const to = result ? Math.min(result.page * result.pageSize, result.total) : 0
  const terms = result?.queryTerms ?? []
  const appliedFilters: { key: string; label: string; value: string; reset: Partial<WorkspaceSearchInput> }[] = []
  if (input.scope !== 'all') appliedFilters.push({ key: 'scope', label: choose('范围', 'Scope'), value: input.scope === 'documents' ? choose('仅文档', 'Documents only') : choose('仅内容块', 'Blocks only'), reset: { scope: 'all' } })
  if (input.matchMode !== 'all') appliedFilters.push({ key: 'match', label: choose('匹配', 'Match'), value: input.matchMode === 'any' ? choose('任意词', 'Any word') : choose('完整短语', 'Exact phrase'), reset: { matchMode: 'all' } })
  if (input.folderId) appliedFilters.push({ key: 'folder', label: choose('目录', 'Folder'), value: folders.find((folder) => folder.id === input.folderId)?.path ?? choose('目录已移除', 'Folder removed'), reset: { folderId: null } })
  if (input.tag) appliedFilters.push({ key: 'tag', label: choose('标签', 'Tag'), value: input.tag, reset: { tag: '' } })
  if (input.blockType) appliedFilters.push({ key: 'type', label: choose('类型', 'Type'), value: blockLabels[input.blockType] || input.blockType, reset: { blockType: '' } })
  if (input.updatedFrom) appliedFilters.push({ key: 'from', label: choose('开始日期', 'From'), value: input.updatedFrom, reset: { updatedFrom: '' } })
  if (input.updatedTo) appliedFilters.push({ key: 'to', label: choose('结束日期', 'To'), value: input.updatedTo, reset: { updatedTo: '' } })
  const hasCriteria = appliedFilters.length > 0
  const clearCriteria = () => {
    search.clearFilters()
    filterToggle.current?.focus({ preventScroll: true })
  }
  const browseAll = () => {
    search.updateInput({ ...defaultWorkspaceSearchInput, pageSize: input.pageSize })
    queryInput.current?.focus({ preventScroll: true })
  }
  const isCurrentAction = (context: SearchActionContext) => current.current.isActive
    && context.input === current.current.input && context.requestSequence === current.current.requestSequence
    && context.sequence === actionSequence.current
  const hasActionOwner = (context: SearchActionContext) => current.current.result?.items.some((item) => matchesActionResult(context, item)) ?? false

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; actionSequence.current++ } }, [])
  useEffect(() => { actionSequence.current++; setFeedback(null) }, [isActive, input, request?.sequence])
  useEffect(() => {
    // A save can refresh and reorder results while navigation is still pending.
    // Only copying an obsolete link invalidates that in-flight action.
    if (busy?.action === 'copy' && isCurrentAction(busy) && !hasActionOwner(busy)) actionSequence.current++
    setFeedback((previous) => previous && !hasActionOwner(previous.context) ? null : previous)
  }, [result])
  useEffect(() => { if (isActive) queryInput.current?.focus({ preventScroll: true }) }, [isActive, request?.sequence])

  const cancelPaginationIntent = () => {
    const intent = paginationIntent.current
    paginationIntent.current = null
    intent?.cleanup()
  }
  const canReadResults = () => {
    const target = resultsHeading.current
    return target?.isConnected && !target.closest('[hidden], [inert], [aria-hidden="true"]')
      && target.checkVisibility?.({ checkVisibilityCSS: true }) !== false
      && document.visibilityState === 'visible' && document.hasFocus() && !document.querySelector('dialog[open]')
  }
  const changePage = (nextPage: number, trigger: HTMLButtonElement) => {
    cancelPaginationIntent()
    const ownsAttention = isActive && document.activeElement === trigger && canReadResults()
    const token = search.updateInput({ page: nextPage })
    if (!ownsAttention) return
    // Listen after the activating click/key event. Any subsequent interaction
    // gives up this one-shot continuation, even if focus later returns.
    const cancel = () => cancelPaginationIntent()
    const onFocus = (event: FocusEvent) => { if (event.target !== trigger && event.target !== document.body) cancel() }
    const onVisibility = () => { if (document.visibilityState !== 'visible') cancel() }
    const attentionEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'compositionstart'] as const
    for (const event of attentionEvents) document.addEventListener(event, cancel, true)
    document.addEventListener('focusin', onFocus, true)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', cancel)
    paginationIntent.current = { token, trigger, requestSequence: request?.sequence, isZh, cleanup: () => {
      for (const event of attentionEvents) document.removeEventListener(event, cancel, true)
      document.removeEventListener('focusin', onFocus, true)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', cancel)
    } }
  }
  useLayoutEffect(() => () => cancelPaginationIntent(), [])
  useLayoutEffect(() => {
    const intent = paginationIntent.current
    if (!intent) return
    if (!isActive || intent.token !== search.requestToken || intent.requestSequence !== request?.sequence
      || intent.isZh !== isZh || search.error || !canReadResults()) {
      cancelPaginationIntent()
      return
    }
    if (loading) return
    cancelPaginationIntent()
    if (search.resultToken !== intent.token || (document.activeElement !== intent.trigger && document.activeElement !== document.body)) return
    const target = resultsHeading.current!
    target.focus({ preventScroll: true })
    target.scrollIntoView({ block: 'start', behavior: 'instant' })
  }, [isActive, isZh, request?.sequence, search.requestToken, search.resultToken, loading, search.error])

  const runAction = async (item: WorkspaceSearchResult, action: SearchAction) => {
    if (actionLock.current || loading) return
    actionLock.current = true
    const context: SearchActionContext = { item, action, input, requestSequence: request?.sequence, sequence: ++actionSequence.current }
    setBusy(context); setFeedback(null)
    const report = (message: string, error = false) => {
      if (mounted.current && isCurrentAction(context) && hasActionOwner(context)) setFeedback({ context, message, error })
    }
    try {
      if (action === 'copy') {
        await window.knowbook.writeClipboardText(searchResultDocumentLink(item))
        report(choose('文档链接已复制，可粘贴到其他文档。', 'Document link copied. Paste it into another document.'))
      } else {
        const shouldContinue = () => mounted.current && isCurrentAction(context)
        const opened = action === 'open' && item.blockId ? await onOpenBlock(item.documentId, item.blockId, shouldContinue) : await onOpenDocument(item.documentId, shouldContinue)
        if (opened === false) report(choose('未能切换文档，搜索已保留。请处理保存错误后重试。', 'Could not switch documents. Your search is preserved. Resolve the save error and retry.'), true)
      }
    } catch (cause) {
      report(getErrorMessage(cause, action === 'copy' ? choose('复制失败，请重试。', 'Copy failed. Please retry.') : choose('打开失败，请重试。', 'Could not open the result. Please retry.')), true)
    } finally { actionLock.current = false; if (mounted.current) setBusy(null) }
  }

  return <div className="workspace-search-page">
    <header className="management-page-header">
      <div className="management-page-heading">
        <h2>{choose('搜索', 'Search')}</h2>
        <p className="management-page-description">{choose('搜索整个知识库，快速定位文档和内容块。', 'Find documents and blocks across your knowledge workspace.')}</p>
      </div>
    </header>

    <section className="panel workspace-search-filter-panel" aria-label={choose('搜索条件', 'Search filters')}>
      <form onSubmit={(event) => { event.preventDefault(); if (!composing.current) search.retry() }}>
        <div className="workspace-search-query-row">
          <label className="workspace-search-field workspace-search-query" htmlFor={`${id}-query`}>
            <span className="editor-label" id={`${id}-query-label`}>{choose('关键词', 'Keywords')}</span>
            <span className="workspace-search-query-input">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
              <input ref={queryInput} id={`${id}-query`} aria-labelledby={`${id}-query-label`} aria-describedby={`${id}-query-hint`} type="search" className="editor-input" value={input.query}
              placeholder={choose('搜索标题、摘要和正文…', 'Search titles, summaries and content…')} autoComplete="off"
              onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
              onKeyDown={(event) => { if (event.key === 'Enter' && isImeKeyboardEvent(event.nativeEvent, composing.current)) event.preventDefault() }}
              onChange={(event) => search.updateInput({ query: event.target.value })} />
            </span>
          </label>
          <button type="submit" className="primary-button">{choose('搜索', 'Search')}</button>
        </div>
        <div className="workspace-search-query-tools">
          <button ref={filterToggle} type="button" className={`secondary-button workspace-search-filter-toggle${filtersExpanded ? ' is-expanded' : ''}`}
            aria-label={choose('筛选', 'Filters')} aria-description={choose(`已启用 ${appliedFilters.length} 项筛选`, `${appliedFilters.length} filters applied`)}
            aria-expanded={filtersExpanded} aria-controls={`${id}-filters`} onClick={() => setFiltersExpanded((value) => !value)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M7 12h10M10 17h4" /></svg>
            {choose('筛选', 'Filters')}{appliedFilters.length > 0 && <span className="workspace-search-filter-count" aria-hidden="true">{appliedFilters.length}</span>}
            <svg className="workspace-search-filter-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg>
          </button>
          <p className="workspace-search-query-hint" id={`${id}-query-hint`}>{choose('留空浏览全部内容 · Enter 立即搜索', 'Leave empty to browse all content · Enter to search now')}</p>
          {hasCriteria && <button type="button" className="secondary-button workspace-search-clear" onClick={clearCriteria}>{choose('清空筛选', 'Clear filters')}</button>}
        </div>
        {appliedFilters.length > 0 && <div className="workspace-search-applied-filters" role="group" aria-label={choose('已启用筛选', 'Applied filters')}>
          {appliedFilters.map((filter) => <button key={filter.key} type="button" className="workspace-search-filter-chip"
            aria-label={choose(`移除${filter.label}筛选：${filter.value}`, `Remove ${filter.label.toLowerCase()} filter: ${filter.value}`)}
            title={`${filter.label}: ${filter.value}`} onClick={() => { search.updateInput(filter.reset); filterToggle.current?.focus({ preventScroll: true }) }}>
            <span>{filter.label}: {filter.value}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
          </button>)}
        </div>}
        <div id={`${id}-filters`} className="workspace-search-advanced" hidden={!filtersExpanded}>
        <div className="workspace-search-filters">
          <label className="workspace-search-field" htmlFor={`${id}-scope`}><span className="editor-label" id={`${id}-scope-label`}>{choose('搜索范围', 'Search scope')}</span>
            <select id={`${id}-scope`} aria-labelledby={`${id}-scope-label`} className="editor-select" value={input.scope} onChange={(event) => search.updateInput({ scope: event.target.value as typeof input.scope })}>
              <option value="all">{choose('文档和内容块', 'Documents and blocks')}</option><option value="documents">{choose('仅文档', 'Documents only')}</option><option value="blocks">{choose('仅内容块', 'Blocks only')}</option>
            </select></label>
          <label className="workspace-search-field" htmlFor={`${id}-match`}><span className="editor-label" id={`${id}-match-label`}>{choose('匹配方式', 'Match mode')}</span>
            <select id={`${id}-match`} aria-labelledby={`${id}-match-label`} className="editor-select" value={input.matchMode} onChange={(event) => search.updateInput({ matchMode: event.target.value as typeof input.matchMode })}>
              <option value="all">{choose('包含所有词', 'All words')}</option><option value="any">{choose('包含任意词', 'Any word')}</option><option value="phrase">{choose('完整短语', 'Exact phrase')}</option>
            </select></label>
          <label className="workspace-search-field" htmlFor={`${id}-folder`}><span className="editor-label" id={`${id}-folder-label`}>{choose('目录', 'Folder')}</span>
            <select id={`${id}-folder`} aria-labelledby={`${id}-folder-label`} className="editor-select" value={input.folderId || ''} onChange={(event) => search.updateInput({ folderId: event.target.value || null })}>
              <option value="">{choose('所有目录', 'All folders')}</option>
              {input.folderId && !folders.some((folder) => folder.id === input.folderId) && <option value={input.folderId}>{choose('目录已移除', 'Folder removed')}</option>}
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
            </select></label>
          <label className="workspace-search-field" htmlFor={`${id}-tag`}><span className="editor-label" id={`${id}-tag-label`}>{choose('标签', 'Tag')}</span>
            <select id={`${id}-tag`} aria-labelledby={`${id}-tag-label`} className="editor-select" value={input.tag || ''} onChange={(event) => search.updateInput({ tag: event.target.value })}>
              <option value="">{choose('所有标签', 'All tags')}</option>
              {input.tag && !search.facets.tags.includes(input.tag) && <option value={input.tag}>{input.tag}</option>}
              {search.facets.tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </select></label>
          <label className="workspace-search-field" htmlFor={`${id}-block-type`}><span className="editor-label" id={`${id}-block-type-label`}>{choose('内容类型', 'Block type')}</span>
            <select id={`${id}-block-type`} aria-labelledby={`${id}-block-type-label`} className="editor-select" value={input.blockType || ''} onChange={(event) => search.updateInput({ blockType: event.target.value })}>
              <option value="">{choose('所有类型', 'All types')}</option>
              {input.blockType && !search.facets.blockTypes.includes(input.blockType) && <option value={input.blockType}>{blockLabels[input.blockType] || input.blockType}</option>}
              {search.facets.blockTypes.map((type) => <option key={type} value={type}>{blockLabels[type] || type}</option>)}
            </select></label>
          <label className="workspace-search-field" htmlFor={`${id}-from`}><span className="editor-label" id={`${id}-from-label`}>{choose('更新开始日期', 'Updated from')}</span>
            <input id={`${id}-from`} aria-labelledby={`${id}-from-label`} type="date" className="editor-input" value={input.updatedFrom || ''} onChange={(event) => search.updateInput({ updatedFrom: event.target.value })} /></label>
          <label className="workspace-search-field" htmlFor={`${id}-to`}><span className="editor-label" id={`${id}-to-label`}>{choose('更新结束日期', 'Updated to')}</span>
            <input id={`${id}-to`} aria-labelledby={`${id}-to-label`} type="date" className="editor-input" value={input.updatedTo || ''} min={input.updatedFrom || undefined} onChange={(event) => search.updateInput({ updatedTo: event.target.value })} /></label>
        </div>
        <p className="mini-hint">{choose('目录包含所选文档及其子文档，日期按本地日期计算。标签来自内容块；同时筛选标签与类型时，两项需在同一内容块上匹配。', 'Folders include descendants; dates use your local calendar. Tags belong to blocks. A tag and type filter must match the same block.')}</p>
        </div>
      </form>
      {search.facetError && <div className="workspace-search-inline-error" role="alert"><p>{search.facetError}</p><button type="button" className="secondary-button" onClick={search.refreshFacets}>{choose('重试加载筛选', 'Retry loading filters')}</button></div>}
    </section>

    <details className="panel workspace-search-saved-panel">
      <summary className="workspace-search-saved-summary">{choose('保存与加载检索', 'Save and load searches')}</summary>
      <div className="workspace-search-saved-row">
        <label className="workspace-search-field" htmlFor={`${id}-saved`}><span className="editor-label" id={`${id}-saved-label`}>{choose('已保存检索', 'Saved searches')}</span>
          <select id={`${id}-saved`} aria-labelledby={`${id}-saved-label`} className="editor-select" value={search.savedId} disabled={search.savedBusy || search.savedLoading} onChange={(event) => {
            search.setSavedId(event.target.value)
            search.setSavedName(search.savedSearches.find((saved) => saved.id === event.target.value)?.name ?? '')
          }}>
            <option value="">{search.savedLoading ? choose('正在加载…', 'Loading…') : choose('选择检索', 'Choose a search')}</option>
            {search.savedSearches.map((saved) => <option key={saved.id} value={saved.id}>{saved.name}</option>)}
          </select></label>
        <div className="workspace-search-saved-actions">
          <button type="button" className="secondary-button" disabled={!search.savedId || search.savedBusy || search.savedLoading} onClick={() => search.loadSaved(search.savedId)}>{choose('加载检索', 'Load search')}</button>
          <button type="button" className="secondary-button" disabled={!search.savedId || search.savedBusy || search.savedLoading} onClick={() => { void search.deleteSaved(search.savedId) }}>{choose('删除检索', 'Delete search')}</button>
        </div>
        <label className="workspace-search-field" htmlFor={`${id}-save-name`}><span className="editor-label" id={`${id}-save-name-label`}>{choose('检索名称', 'Search name')}</span>
          <input id={`${id}-save-name`} aria-labelledby={`${id}-save-name-label`} className="editor-input" value={search.savedName} disabled={search.savedBusy} maxLength={80}
            placeholder={choose('为当前条件命名…', 'Name the current search…')} onChange={(event) => search.setSavedName(event.target.value)} /></label>
        <div className="workspace-search-saved-actions">
          <button type="button" className="secondary-button" disabled={search.savedBusy} onClick={() => { void search.save() }}>{choose('保存检索', 'Save search')}</button>
          <button type="button" className="secondary-button" disabled={!search.savedId || search.savedBusy || search.savedLoading} onClick={() => { void search.save(true) }}>{choose('更新检索', 'Update search')}</button>
        </div>
      </div>
      <p className="mini-hint">{choose('保存关键词和筛选条件，下次加载时从第一页开始。', 'Save keywords and filters. Loading a saved search starts from the first page.')}</p>
      {search.savedListError && <div className="workspace-search-inline-error" role="alert"><p>{search.savedListError}</p><button type="button" className="secondary-button" onClick={search.refreshSaved}>{choose('重试加载检索', 'Retry loading searches')}</button></div>}
      {search.savedError && <p role="alert">{search.savedError}</p>}
      {search.savedBusy && <p role="status">{choose('正在保存更改…', 'Saving changes…')}</p>}
      {!search.savedBusy && search.savedFeedback && <p role="status">{search.savedFeedback}</p>}
    </details>

    <section className="panel workspace-search-results-panel" aria-label={choose('搜索结果', 'Search results')} aria-busy={loading}>
      <div className="workspace-search-results-head">
        <div><h3 ref={resultsHeading} tabIndex={-1} aria-describedby={`${id}-results-total ${id}-page-range`}>{choose('搜索结果', 'Search results')}</h3>
          <p id={`${id}-results-total`} data-testid="workspace-search-total" data-total-number={result?.total ?? 0} role="status" aria-live="polite">
            {loading ? choose('正在搜索…', 'Searching…') : search.error ? choose('搜索未完成', 'Search did not complete') : result ? choose(`共 ${result.total} 条结果`, `${result.total} results`) : choose('准备搜索', 'Ready to search')}
          </p></div>
        <div className="workspace-search-result-options">
        <label className="workspace-search-field workspace-search-sort" htmlFor={`${id}-sort`}><span className="editor-label" id={`${id}-sort-label`}>{choose('排序', 'Sort')}</span>
          <select id={`${id}-sort`} aria-labelledby={`${id}-sort-label`} className="editor-select" value={input.sort} onChange={(event) => search.updateInput({ sort: event.target.value as typeof input.sort })}>
            <option value="relevance">{choose('相关度', 'Relevance')}</option><option value="updated-desc">{choose('最近更新优先', 'Recently updated first')}</option><option value="updated-asc">{choose('较早更新优先', 'Oldest updated first')}</option>
          </select></label>
        <label className="workspace-search-field workspace-search-page-size" htmlFor={`${id}-page-size`}><span className="editor-label" id={`${id}-page-size-label`}>{choose('每页结果', 'Results per page')}</span>
          <select id={`${id}-page-size`} aria-labelledby={`${id}-page-size-label`} className="editor-select" value={input.pageSize} onChange={(event) => search.updateInput({ pageSize: Number(event.target.value) })}>
            <option value="25">25</option><option value="50">50</option><option value="100">100</option>
          </select></label>
        </div>
      </div>
      {search.error ? <div className="workspace-search-empty" role="alert"><h4>{choose('搜索暂时不可用', 'Search is unavailable')}</h4>
        <p>{search.error}</p><p>{choose('关键词和筛选已保留，可以重试。', 'Your keywords and filters are preserved. Try again.')}</p>
        <button type="button" className="primary-button" onClick={search.retry}>{choose('重试搜索', 'Retry search')}</button></div>
        : result && result.total === 0 && !loading ? <div className="workspace-search-empty" role="status">
          <svg className="workspace-search-empty-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
          <h4>{input.query.trim() || appliedFilters.length ? choose('未找到匹配结果', 'No matching results') : choose('暂无可搜索内容', 'No searchable content yet')}</h4>
          <p>{input.query.trim() || appliedFilters.length ? choose('试试更少的关键词，或放宽当前筛选范围。', 'Try fewer keywords or broaden your current filters.') : choose('文档和内容块会显示在这里。添加文档后即可搜索。', 'Your documents and blocks will appear here. Add a document to start searching.')}</p>
          <div className="workspace-search-empty-actions">
            {appliedFilters.length > 0 && <button type="button" className="primary-button" onClick={clearCriteria}>{choose('清空筛选再试', 'Search without filters')}</button>}
            {input.query.trim().split(/\s+/).length > 1 && input.matchMode !== 'any' && <button type="button" className="secondary-button" onClick={() => search.updateInput({ matchMode: 'any' })}>{choose('改为任意词匹配', 'Match any word')}</button>}
            {input.query.trim() && <button type="button" className="secondary-button" onClick={browseAll}>{choose('浏览全部内容', 'Browse all content')}</button>}
          </div>
        </div>
          : <div className={`workspace-search-results${loading ? ' is-loading' : ''}`} data-testid="workspace-search-results">
            {result?.items.map((item, index) => {
              const pending = busy && isCurrentAction(busy) && matchesActionResult(busy, item) ? busy : null
              const completed = feedback && isCurrentAction(feedback.context) && matchesActionResult(feedback.context, item) ? feedback : null
              const rowAction = pending ?? completed?.context
              const feedbackId = rowAction ? `${id}-action-${index}` : undefined
              const actionProps = (action: SearchAction) => {
                const ownsFeedback = rowAction?.action === action
                const isPending = pending?.action === action
                return {
                  // Keep the original trigger through a save and a concurrent
                  // refresh, including a failure that arrives before results.
                  disabled: !ownsFeedback && (Boolean(busy) || loading),
                  'aria-disabled': isPending || (ownsFeedback && loading),
                  'aria-busy': isPending,
                  'aria-describedby': ownsFeedback ? feedbackId : undefined
                }
              }
              return <article className="workspace-search-result" key={JSON.stringify([item.documentId, item.blockId ?? null])}
              data-testid="workspace-search-result" data-document-id={item.documentId} data-block-id={item.blockId || ''}>
              <div className="workspace-search-result-head"><div className="workspace-search-result-heading">
                <h4><MatchText text={item.documentTitle} terms={terms} /></h4>
                <p className="workspace-search-path" title={item.documentPath}><MatchText text={item.documentPath} terms={terms} /></p></div>
                <span className="pill">{item.matchType === 'title' ? choose('文档', 'Document') : blockLabels[item.blockType || ''] || choose('内容块', 'Block')}</span></div>
              {item.snippet && <p className="workspace-search-snippet"><MatchText text={item.snippet} terms={terms} /></p>}
              <div className="workspace-search-result-footer">
                <div className="workspace-search-result-meta"><time dateTime={item.updatedAt} title={new Date(item.updatedAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}>{choose('更新于 ', 'Updated ')}{new Date(item.updatedAt).toLocaleDateString(isZh ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</time>
                  {item.tags.map((tag) => <span className="workspace-search-tag" key={tag}>#{tag}</span>)}</div>
                <div className="workspace-search-result-actions">
                  <button type="button" className="primary-button" {...actionProps('open')} onClick={() => { void runAction(item, 'open') }}>{item.blockId ? choose('定位内容块', 'Go to block') : choose('打开文档', 'Open document')}</button>
                  {item.blockId && <button type="button" className="secondary-button" {...actionProps('document')} onClick={() => { void runAction(item, 'document') }}>{choose('打开文档', 'Open document')}</button>}
                  <button type="button" className="secondary-button" {...actionProps('copy')} onClick={() => { void runAction(item, 'copy') }}>{choose('复制文档链接', 'Copy document link')}</button>
                </div>
              </div>
              {rowAction && <p id={feedbackId} className="workspace-search-action-feedback" role={!pending && completed?.error ? 'alert' : 'status'}>
                {pending ? pending.action === 'copy' ? choose('正在复制…', 'Copying…') : choose('正在打开…', 'Opening…') : completed?.message}
              </p>}
            </article>})}
          </div>}
      <nav className="workspace-search-pagination" aria-label={choose('搜索分页', 'Search pagination')}>
        <span id={`${id}-page-range`}>{result && result.total > 0 ? choose(`${from}–${to} / ${result.total} 条 · 第 ${page} / ${pages} 页`, `${from}–${to} of ${result.total} · Page ${page} of ${pages}`) : choose('第 1 页', 'Page 1')}</span>
        <div><button type="button" className="secondary-button" disabled={loading || Boolean(search.error) || page <= 1} onClick={(event) => changePage(page - 1, event.currentTarget)}>{choose('上一页', 'Previous page')}</button>
          <button type="button" className="secondary-button" disabled={loading || Boolean(search.error) || !result || page >= pages} onClick={(event) => changePage(page + 1, event.currentTarget)}>{choose('下一页', 'Next page')}</button></div>
      </nav>
    </section>
  </div>
}
