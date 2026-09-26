import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GlobalSearchResult } from '@shared/contracts'
import type { DocumentsDomainState } from '../types/appDomains'
import type { AppShellState } from '../types/appShell'
import type { WorkspaceOperationsState } from '../types/appComposition'
import { createPaletteCommands, matchPaletteCommands, type PaletteCommand } from '../utils/paletteCommands'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { getErrorMessage } from '../utils/errorMessage'
import { RecoveryState } from './RecoveryState'
import { SearchMatchText } from './SearchMatchText'
import { searchResultDocumentLink } from '../utils/searchResultLink'
import './global-search.css'

type PaletteItem = { id: string; result: GlobalSearchResult } | { id: string; command: PaletteCommand }

export default function GlobalSearchPalette({ documents, shell, workspace }: {
  documents: DocumentsDomainState; shell: AppShellState; workspace: WorkspaceOperationsState
}) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), composing = useRef(false)
  const executing = useRef(false), listId = useId(), titleId = useId(), hintId = useId()
  const [activeId, setActiveId] = useState('')
  const [busy, setBusy] = useState<'open' | 'copy' | null>(null)
  const [feedback, setFeedback] = useState<{ itemId: string; message: string; error: boolean } | null>(null)
  const mounted = useRef(false), actionSequence = useRef(0)
  const zh = shell.isZh
  const query = documents.globalSearchQuery
  const commandsOnly = query.trimStart().startsWith('>')
  const commands = matchPaletteCommands(createPaletteCommands(documents, shell, workspace), query)
  const results: GlobalSearchResult[] = commandsOnly ? [] : query.trim() ? documents.globalSearchResults
    : shell.homeData.recentDocuments.slice(0, 6).map((document) => ({ documentId: document.id, documentTitle: document.title,
      documentPath: document.path, matchType: 'title', snippet: '' }))
  const items: PaletteItem[] = [
    ...results.map((result) => ({ id: `document:${result.documentId}:${result.matchType}:${result.blockId || ''}`, result })),
    ...commands.map((command) => ({ id: command.id, command }))
  ]
  const available = items.filter((item) => !('command' in item && item.command.disabledReason))
  const selected = available.find((item) => item.id === activeId) || available[0]
  const selectedIndex = items.findIndex((item) => item.id === selected?.id)
  const selectedResult = selected && 'result' in selected ? selected.result : null
  const primaryLabel = selectedResult?.blockId ? (zh ? '定位内容块' : 'Go to block') : (zh ? '打开文档' : 'Open document')

  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current!
    element.showModal()
    input.current?.focus()
    return () => {
      mounted.current = false
      element.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    if (selectedIndex >= 0) document.getElementById(`${listId}-${selectedIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [listId, selectedIndex, selected?.id])

  const updateQuery = (value: string) => { actionSequence.current++; setFeedback(null); setActiveId(''); documents.updateGlobalSearchQuery(value) }
  const runResultAction = async (item: PaletteItem & { result: GlobalSearchResult }, action: 'open' | 'document' | 'copy') => {
    if (executing.current) return
    executing.current = true
    const sequence = ++actionSequence.current
    setBusy(action === 'copy' ? 'copy' : 'open')
    setFeedback(null)
    const report = (message: string, error = false) => {
      if (mounted.current && sequence === actionSequence.current) setFeedback({ itemId: item.id, message, error })
    }
    try {
      if (action === 'copy') {
        await window.knowbook.writeClipboardText(searchResultDocumentLink(item.result))
        report(zh ? '文档链接已复制，可粘贴到其他文档。' : 'Document link copied. Paste it into another document.')
      } else if (!await documents.handleGlobalSearchNavigate(item.result, action === 'document')) {
        report(zh ? '未能切换文档，草稿和搜索已保留。请处理保存错误后重试。' : 'Could not switch documents. Your draft and search are preserved. Resolve the save error and retry.', true)
        input.current?.focus()
      }
    } catch (error) {
      report(getErrorMessage(error, action === 'copy' ? (zh ? '复制失败，请重试。' : 'Copy failed. Please retry.') : (zh ? '打开失败，请重试。' : 'Could not open the result. Please retry.')), true)
    } finally {
      executing.current = false
      if (mounted.current) setBusy(null)
    }
  }
  const execute = (item: PaletteItem | undefined, documentOnly = false) => {
    if (!item || executing.current || ('command' in item && item.command.disabledReason)) return
    if ('result' in item) { void runResultAction(item, documentOnly ? 'document' : 'open'); return }
    executing.current = true
    documents.closeGlobalSearch()
    void (async () => {
      try { await item.command.run() }
      catch (error) { shell.notify(getErrorMessage(error, zh ? '命令执行失败，请重试。' : 'Command failed. Please retry.'), 'error') }
    })()
  }

  return createPortal(<dialog ref={dialog} className="global-search-modal" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); if (!composing.current) documents.closeGlobalSearch() }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return
      const rect = event.currentTarget.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) documents.closeGlobalSearch()
    }}
    onKeyDown={(event) => {
      event.stopPropagation()
      if (isImeKeyboardEvent(event.nativeEvent, composing.current)) {
        if (event.key === 'Escape') event.preventDefault()
        return
      }
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === 'k') { event.preventDefault(); documents.closeGlobalSearch(); return }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.shiftKey && key === 'p') { event.preventDefault(); updateQuery('>'); input.current?.focus(); return }
      if (event.target !== input.current) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const current = available.findIndex((item) => item.id === selected?.id)
        const next = available[(current + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length]
        if (next) setActiveId(next.id)
      }
      if (event.key === 'Enter' && !event.altKey && !event.shiftKey) { event.preventDefault(); execute(selected, event.ctrlKey || event.metaKey) }
    }}>
    <div className="palette-heading"><h2 id={titleId}>{zh ? '搜索与命令' : 'Search and commands'}</h2>
      <button type="button" className="palette-mode" aria-pressed={commandsOnly} onClick={() => { updateQuery(commandsOnly ? '' : '>'); input.current?.focus() }}>
        {zh ? '命令' : 'Commands'} <kbd>&gt;</kbd></button></div>
    <div className="global-search-header">
      <input ref={input} className="global-search-input" role="combobox" aria-label={zh ? '搜索文档或命令' : 'Search documents or commands'}
        aria-controls={listId} aria-expanded="true" aria-autocomplete="list" aria-activedescendant={selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined}
        aria-describedby={hintId} autoComplete="off" spellCheck={false}
        placeholder={commandsOnly ? (zh ? '输入命令名称…' : 'Type a command…') : (zh ? '搜索所有文档，或输入 > 查找命令…' : 'Search all documents, or type > for commands…')}
        value={query} onChange={(event) => updateQuery(event.target.value)}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onBlur={() => { composing.current = false }} />
      <button aria-label={zh ? '关闭搜索' : 'Close search'} className="secondary-button" onClick={documents.closeGlobalSearch} type="button">✕</button>
    </div>
    <div className="global-search-results">
      {!commandsOnly && documents.globalSearchLoading && <p className="mini-hint" role="status">{shell.ui.globalSearchLoading}</p>}
      {!commandsOnly && documents.globalSearchError && <RecoveryState compact title={zh ? '搜索暂时不可用' : 'Search is unavailable'}
        description={zh ? '关键词已保留，可以重试。' : 'Your query is preserved. Try again.'} error={documents.globalSearchError} onRetry={documents.retryGlobalSearch} />}
      {!query.trim() && <p className="mini-hint">{zh ? '搜索所有文档标题和内容块，输入 > 查找命令。' : 'Search all document titles and blocks, or type > for commands.'}</p>}
      {!documents.globalSearchLoading && !documents.globalSearchError && query.trim() && items.length === 0 && <p className="mini-hint" role="status">{shell.ui.globalSearchNoResults}</p>}
      <div id={listId} role="listbox" aria-busy={Boolean(busy)} aria-label={zh ? '搜索结果与命令' : 'Results and commands'}>
        {items.map((item, index) => <div key={item.id}>
          {(index === 0 || ('command' in item && 'result' in items[index - 1])) && <div className="palette-section-label" role="presentation">
            {'command' in item ? (zh ? '命令' : 'Commands') : query.trim() ? (zh ? '文档' : 'Documents') : (zh ? '最近更新' : 'Recently updated')}</div>}
          <button type="button" role="option" id={`${listId}-${index}`} aria-selected={selected?.id === item.id}
            disabled={'command' in item && Boolean(item.command.disabledReason)} tabIndex={-1}
            className={`${'result' in item ? 'global-search-result' : 'palette-command'} palette-option`}
            onMouseMove={() => { if (!executing.current) setActiveId(item.id) }} onClick={() => { setActiveId(item.id); execute(item) }}>
            {'result' in item ? <>
              <div className="global-search-result-header"><span className="global-search-doc-path" title={item.result.documentPath}><SearchMatchText text={item.result.documentPath} query={query} /></span>
                <span className={`global-search-match-badge global-search-match-${item.result.matchType === 'title' ? 'title' : 'block'}`}>
                  {item.result.matchType === 'title' ? (zh ? '文档' : 'Document') : shell.ui.blockTypeBadges[item.result.blockType ?? ''] ?? shell.ui.blockMatchFallback}</span></div>
              <strong className="global-search-doc-title"><SearchMatchText text={item.result.documentTitle} query={query} /></strong>
              {item.result.snippet && <p className="global-search-snippet" title={item.result.snippet}><SearchMatchText text={item.result.snippet} query={query} /></p>}
            </> : <><div className="palette-command-heading"><strong>{item.command.title}</strong>{item.command.shortcut && <kbd>{item.command.shortcut}</kbd>}</div>
              <span className="global-search-snippet">{item.command.disabledReason || item.command.description}</span></>}
          </button>
        </div>)}
      </div>
    </div>
    {selected && 'result' in selected && <div className="palette-result-actions" role="group" aria-label={zh ? '所选搜索结果操作' : 'Selected result actions'}>
      <span className="palette-action-target" title={selected.result.documentPath}>{selected.result.documentPath}</span>
      <div><button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => execute(selected)}>{primaryLabel}</button>
        {selectedResult?.blockId && <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => execute(selected, true)}>{zh ? '打开文档' : 'Open document'}</button>}
        <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => { void runResultAction(selected, 'copy') }}>{zh ? '复制文档链接' : 'Copy document link'}</button></div>
    </div>}
    {(busy || (feedback && feedback.itemId === selected?.id)) && <p className="palette-action-feedback" role={feedback?.error && !busy ? 'alert' : 'status'}>
      {busy ? busy === 'open' ? (zh ? '正在打开…' : 'Opening…') : (zh ? '正在复制…' : 'Copying…') : feedback?.message}</p>}
    <footer id={hintId} className="palette-footer"><span>{selectedResult?.blockId
      ? (zh ? '↑↓ 选择 · Enter 定位 · Ctrl/⌘ Enter 打开文档 · Esc 关闭' : '↑↓ Choose · Enter Go to block · Ctrl/⌘ Enter Open document · Esc Close')
      : (zh ? '↑↓ 选择 · Enter 执行 · Esc 关闭' : '↑↓ Choose · Enter Run · Esc Close')}</span>
      <span role="status" aria-live="polite">{zh ? `${results.length} 个结果 · ${commands.length} 个命令`
        : `${results.length} result${results.length === 1 ? '' : 's'} · ${commands.length} command${commands.length === 1 ? '' : 's'}`}</span></footer>
  </dialog>, document.body)
}
