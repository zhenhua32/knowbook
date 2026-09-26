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
import './global-search.css'

type PaletteItem = { id: string; result: GlobalSearchResult } | { id: string; command: PaletteCommand }

export default function GlobalSearchPalette({ documents, shell, workspace }: {
  documents: DocumentsDomainState; shell: AppShellState; workspace: WorkspaceOperationsState
}) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), composing = useRef(false)
  const executing = useRef(false), listId = useId(), titleId = useId(), hintId = useId()
  const [activeId, setActiveId] = useState('')
  const zh = shell.isZh
  const query = documents.globalSearchQuery
  const commandsOnly = query.trimStart().startsWith('>')
  const commands = matchPaletteCommands(createPaletteCommands(documents, shell, workspace), query)
  const results: GlobalSearchResult[] = commandsOnly ? [] : query.trim() ? documents.globalSearchResults
    : shell.homeData.recentDocuments.slice(0, 6).map((document) => ({ documentId: document.id, documentTitle: document.title,
      documentPath: document.path, matchType: 'title', snippet: '' }))
  const items: PaletteItem[] = [
    ...results.map((result) => ({ id: `document:${result.documentId}:${result.blockId || 'title'}`, result })),
    ...commands.map((command) => ({ id: command.id, command }))
  ]
  const available = items.filter((item) => !('command' in item && item.command.disabledReason))
  const selected = available.find((item) => item.id === activeId) || available[0]
  const selectedIndex = items.findIndex((item) => item.id === selected?.id)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current!
    element.showModal()
    input.current?.focus()
    return () => {
      element.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    if (selectedIndex >= 0) document.getElementById(`${listId}-${selectedIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [listId, selectedIndex, selected?.id])

  const updateQuery = (value: string) => { setActiveId(''); documents.updateGlobalSearchQuery(value) }
  const execute = (item: PaletteItem | undefined) => {
    if (!item || executing.current || ('command' in item && item.command.disabledReason)) return
    executing.current = true
    if ('result' in item) { documents.handleGlobalSearchNavigate(item.result); return }
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
      if (event.key === 'Enter') { event.preventDefault(); execute(selected) }
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
      <div id={listId} role="listbox" aria-label={zh ? '搜索结果与命令' : 'Results and commands'}>
        {items.map((item, index) => <div key={item.id}>
          {(index === 0 || ('command' in item && 'result' in items[index - 1])) && <div className="palette-section-label" role="presentation">
            {'command' in item ? (zh ? '命令' : 'Commands') : query.trim() ? (zh ? '文档' : 'Documents') : (zh ? '最近更新' : 'Recently updated')}</div>}
          <button type="button" role="option" id={`${listId}-${index}`} aria-selected={selected?.id === item.id}
            disabled={'command' in item && Boolean(item.command.disabledReason)} tabIndex={-1}
            className={`${'result' in item ? 'global-search-result' : 'palette-command'} palette-option`}
            onMouseMove={() => setActiveId(item.id)} onClick={() => execute(item)}>
            {'result' in item ? <>
              <div className="global-search-result-header"><span className="global-search-doc-path">{item.result.documentPath}</span>
                <span className={`global-search-match-badge global-search-match-${item.result.matchType === 'title' ? 'title' : 'block'}`}>
                  {item.result.matchType === 'title' ? shell.ui.titleMatchLabel : item.result.blockType ?? shell.ui.blockMatchFallback}</span></div>
              <strong className="global-search-doc-title">{item.result.documentTitle}</strong>
              {item.result.snippet && <p className="global-search-snippet">{item.result.snippet}</p>}
            </> : <><div className="palette-command-heading"><strong>{item.command.title}</strong>{item.command.shortcut && <kbd>{item.command.shortcut}</kbd>}</div>
              <span className="global-search-snippet">{item.command.disabledReason || item.command.description}</span></>}
          </button>
        </div>)}
      </div>
    </div>
    <footer id={hintId} className="palette-footer"><span>{zh ? '↑↓ 选择 · Enter 执行 · Esc 关闭' : '↑↓ Choose · Enter Run · Esc Close'}</span>
      <span role="status" aria-live="polite">{zh ? `${items.length} 项` : `${items.length} items`}</span></footer>
  </dialog>, document.body)
}
