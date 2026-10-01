import { useEffect, useId, useRef, useState } from 'react'
import type { DocumentTreeNode } from '@shared/contracts'
import type { WorkspaceSearchResult } from '@shared/workspace-search'
import { useWorkspaceSearch, type WorkspaceSearchRequest } from '../hooks/useWorkspaceSearch'
import { getUiText } from '../i18n'
import { getErrorMessage } from '../utils/errorMessage'
import { searchResultDocumentLink } from '../utils/searchResultLink'
import './workspace-search.css'

export type SearchPageProps = {
  isActive: boolean
  isZh: boolean
  documentTree: DocumentTreeNode[]
  request: WorkspaceSearchRequest | null
  onOpenDocument: (id: string, shouldContinue?: () => boolean) => boolean | void | Promise<boolean | void>
  onOpenBlock: (documentId: string, blockId: string, shouldContinue?: () => boolean) => boolean | void | Promise<boolean | void>
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
  const mounted = useRef(false), actionLock = useRef(false), actionSequence = useRef(0)
  const active = useRef(isActive)
  active.current = isActive
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null)
  const choose = (zh: string, en: string) => isZh ? zh : en
  const folders = flattenTree(documentTree)
  const blockLabels = getUiText(isZh ? 'zh-CN' : 'en-US').blockTypeBadges
  const pages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1
  const page = result?.page ?? input.page ?? 1
  const from = result && result.total > 0 ? (result.page - 1) * result.pageSize + 1 : 0
  const to = result ? Math.min(result.page * result.pageSize, result.total) : 0
  const terms = result?.queryTerms ?? []

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; actionSequence.current++ } }, [])
  useEffect(() => { actionSequence.current++; setFeedback(null) }, [isActive, input])
  useEffect(() => { if (isActive) queryInput.current?.focus({ preventScroll: true }) }, [isActive, request?.sequence])

  const runAction = async (item: WorkspaceSearchResult, action: 'open' | 'document' | 'copy') => {
    if (actionLock.current || loading) return
    actionLock.current = true; setBusy(true); setFeedback(null)
    const sequence = ++actionSequence.current
    const report = (message: string, error = false) => {
      if (mounted.current && sequence === actionSequence.current) setFeedback({ message, error })
    }
    try {
      if (action === 'copy') {
        await window.knowbook.writeClipboardText(searchResultDocumentLink(item))
        report(choose('文档链接已复制，可粘贴到其他文档。', 'Document link copied. Paste it into another document.'))
      } else {
        const shouldContinue = () => mounted.current && active.current && sequence === actionSequence.current
        const opened = action === 'open' && item.blockId ? await onOpenBlock(item.documentId, item.blockId, shouldContinue) : await onOpenDocument(item.documentId, shouldContinue)
        if (opened === false) report(choose('未能切换文档，搜索已保留。请处理保存错误后重试。', 'Could not switch documents. Your search is preserved. Resolve the save error and retry.'), true)
      }
    } catch (cause) {
      report(getErrorMessage(cause, action === 'copy' ? choose('复制失败，请重试。', 'Copy failed. Please retry.') : choose('打开失败，请重试。', 'Could not open the result. Please retry.')), true)
    } finally { actionLock.current = false; if (mounted.current) setBusy(false) }
  }

  return <div className="workspace-search-page">
    <header className="management-page-header">
      <div className="management-page-heading">
        <p className="management-page-kicker">{choose('知识库', 'Knowledge workspace')}</p>
        <h2>{choose('搜索', 'Search')}</h2>
        <p className="management-page-description">{choose('查找文档与内容，按目录、标签或更新时间缩小范围，并保存常用检索。', 'Find documents and content, narrow by folder, tag or update date, and save searches you use often.')}</p>
      </div>
    </header>

    <section className="panel workspace-search-filter-panel" aria-label={choose('搜索条件', 'Search filters')}>
      <form onSubmit={(event) => { event.preventDefault(); search.retry() }}>
        <div className="workspace-search-query-row">
          <label className="workspace-search-field workspace-search-query" htmlFor={`${id}-query`}>
            <span className="editor-label" id={`${id}-query-label`}>{choose('关键词', 'Keywords')}</span>
            <input ref={queryInput} id={`${id}-query`} aria-labelledby={`${id}-query-label`} type="search" className="editor-input" value={input.query}
              placeholder={choose('搜索标题、摘要和正文…', 'Search titles, summaries and content…')} autoComplete="off"
              onChange={(event) => search.updateInput({ query: event.target.value })} />
          </label>
          <button type="submit" className="primary-button">{choose('搜索', 'Search')}</button>
          <button type="button" className="secondary-button" onClick={search.clearFilters}>{choose('清空筛选', 'Clear filters')}</button>
        </div>
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
          <label className="workspace-search-field" htmlFor={`${id}-sort`}><span className="editor-label" id={`${id}-sort-label`}>{choose('排序', 'Sort')}</span>
            <select id={`${id}-sort`} aria-labelledby={`${id}-sort-label`} className="editor-select" value={input.sort} onChange={(event) => search.updateInput({ sort: event.target.value as typeof input.sort })}>
              <option value="relevance">{choose('相关度', 'Relevance')}</option><option value="updated-desc">{choose('最近更新优先', 'Recently updated first')}</option><option value="updated-asc">{choose('较早更新优先', 'Oldest updated first')}</option>
            </select></label>
        </div>
        <p className="mini-hint">{choose('留空关键词可浏览内容。目录包含所选文档及其子文档，日期按本地日期计算。标签来自内容块；同时筛选标签与类型时，两项需在同一内容块上匹配。', 'Leave keywords empty to browse. Folders include descendants; dates use your local calendar. Tags belong to blocks. A tag and type filter must match the same block.')}</p>
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
        <div><h3>{choose('搜索结果', 'Search results')}</h3>
          <p data-testid="workspace-search-total" data-total-number={result?.total ?? 0} role="status" aria-live="polite">
            {loading ? choose('正在搜索…', 'Searching…') : search.error ? choose('搜索未完成', 'Search did not complete') : result ? choose(`共 ${result.total} 条结果`, `${result.total} results`) : choose('准备搜索', 'Ready to search')}
          </p></div>
        <label className="workspace-search-field workspace-search-page-size" htmlFor={`${id}-page-size`}><span className="editor-label" id={`${id}-page-size-label`}>{choose('每页结果', 'Results per page')}</span>
          <select id={`${id}-page-size`} aria-labelledby={`${id}-page-size-label`} className="editor-select" value={input.pageSize} onChange={(event) => search.updateInput({ pageSize: Number(event.target.value) })}>
            <option value="25">25</option><option value="50">50</option><option value="100">100</option>
          </select></label>
      </div>
      {search.error ? <div className="workspace-search-empty" role="alert"><h4>{choose('搜索暂时不可用', 'Search is unavailable')}</h4>
        <p>{search.error}</p><p>{choose('关键词和筛选已保留，可以重试。', 'Your keywords and filters are preserved. Try again.')}</p>
        <button type="button" className="primary-button" onClick={search.retry}>{choose('重试搜索', 'Retry search')}</button></div>
        : result && result.total === 0 && !loading ? <div className="workspace-search-empty" role="status"><h4>{choose('未找到匹配结果', 'No matching results')}</h4>
          <p>{choose('尝试减少关键词、改为任意词匹配，或清空筛选。', 'Try fewer keywords, match any word, or clear the filters.')}</p></div>
          : <div className={`workspace-search-results${loading ? ' is-loading' : ''}`} data-testid="workspace-search-results">
            {result?.items.map((item) => <article className="workspace-search-result" key={`${item.documentId}:${item.blockId || 'document'}`}
              data-testid="workspace-search-result" data-document-id={item.documentId} data-block-id={item.blockId || ''}>
              <div className="workspace-search-result-head"><p className="workspace-search-path" title={item.documentPath}><MatchText text={item.documentPath} terms={terms} /></p>
                <span className="pill">{item.matchType === 'title' ? choose('文档', 'Document') : blockLabels[item.blockType || ''] || choose('内容块', 'Block')}</span></div>
              <h4><MatchText text={item.documentTitle} terms={terms} /></h4>
              {item.snippet && <p className="workspace-search-snippet"><MatchText text={item.snippet} terms={terms} /></p>}
              <div className="workspace-search-result-meta"><time dateTime={item.updatedAt}>{choose('更新于 ', 'Updated ')}{new Date(item.updatedAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}</time>
                {item.tags.map((tag) => <span className="workspace-search-tag" key={tag}>#{tag}</span>)}</div>
              <div className="workspace-search-result-actions">
                <button type="button" className="primary-button" disabled={busy || loading} onClick={() => { void runAction(item, 'open') }}>{item.blockId ? choose('定位内容块', 'Go to block') : choose('打开文档', 'Open document')}</button>
                {item.blockId && <button type="button" className="secondary-button" disabled={busy || loading} onClick={() => { void runAction(item, 'document') }}>{choose('打开文档', 'Open document')}</button>}
                <button type="button" className="secondary-button" disabled={busy || loading} onClick={() => { void runAction(item, 'copy') }}>{choose('复制文档链接', 'Copy document link')}</button>
              </div>
            </article>)}
          </div>}
      {(busy || feedback) && <p className="workspace-search-action-feedback" role={feedback?.error && !busy ? 'alert' : 'status'}>{busy ? choose('正在处理…', 'Working…') : feedback?.message}</p>}
      <nav className="workspace-search-pagination" aria-label={choose('搜索分页', 'Search pagination')}>
        <span>{result && result.total > 0 ? choose(`${from}–${to} / ${result.total} 条 · 第 ${page} / ${pages} 页`, `${from}–${to} of ${result.total} · Page ${page} of ${pages}`) : choose('第 1 页', 'Page 1')}</span>
        <div><button type="button" className="secondary-button" disabled={loading || Boolean(search.error) || page <= 1} onClick={() => search.updateInput({ page: page - 1 })}>{choose('上一页', 'Previous page')}</button>
          <button type="button" className="secondary-button" disabled={loading || Boolean(search.error) || !result || page >= pages} onClick={() => search.updateInput({ page: page + 1 })}>{choose('下一页', 'Next page')}</button></div>
      </nav>
    </section>
  </div>
}
