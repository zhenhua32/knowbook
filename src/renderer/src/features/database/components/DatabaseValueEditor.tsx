import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { DocumentDatabaseColumn, DocumentDatabaseFieldValue } from '@shared/contracts'
import { isImeKeyboardEvent } from '../../../utils/imeKeyboard'
import { getDatabaseWorkspaceText, type DatabaseWorkspaceText } from '../databaseText'
import { DatabaseTextDraftCache, formatTextDraft, type DatabaseTextDraft, type DatabaseValueCommitResult } from '../model/databaseTextDrafts'

const cellMessages = ['en-US', 'zh-CN'].map(getDatabaseWorkspaceText)

export function DatabaseValueEditor({
  column,
  value,
  onChangeValue,
  textCommitMode = 'blur',
  textDraftCache,
  textDraftKey,
  textDraftRevision,
  onRefreshValue,
  text = getDatabaseWorkspaceText('en-US')
}: {
  column: DocumentDatabaseColumn
  value: DocumentDatabaseFieldValue
  onChangeValue: (value: DocumentDatabaseFieldValue) => void | Promise<void | DatabaseValueCommitResult>
  textCommitMode?: 'blur' | 'change'
  textDraftCache?: DatabaseTextDraftCache
  textDraftKey?: string
  textDraftRevision?: string
  onRefreshValue?: () => Promise<void>
  text?: DatabaseWorkspaceText
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(formatDraft(value))
  const [multiDraft, setMultiDraft] = useState<string[]>(Array.isArray(value) ? value : [])
  const composing = useRef(false)
  const cancelBlurCommit = useRef(false)
  const focusValue = useRef(value)
  const localCache = useRef<DatabaseTextDraftCache | null>(null)
  if (!localCache.current) localCache.current = new DatabaseTextDraftCache()
  const cache = textDraftCache ?? localCache.current
  const key = textDraftKey ?? JSON.stringify(['', '', column.id])
  const blurText = column.type === 'text' && textCommitMode === 'blur'
  const cell = useSyncExternalStore(listener => blurText ? cache.subscribe(key, listener) : () => {},
    () => blurText ? cache.get(key) : undefined, () => blurText ? cache.get(key) : undefined)
  const focusDraft = useRef<DatabaseTextDraft | undefined>(undefined)
  const root = useRef<HTMLSpanElement>(null), feedbackId = useId()
  const pending = Boolean(cell?.operation)
  const message = pending ? cell?.status === 'refreshing' ? text.cellRefreshing : text.saving
    : localizeCellMessage(cell?.message ?? '', text)
  const { detailsRef, menuRef, menuStyle } = useMultiSelectMenuPosition(column.type === 'multi-select' && isEditing)

  useLayoutEffect(() => {
    if (blurText) cache.sync(key, value, textDraftRevision)
  }, [blurText, cache, key, value, textDraftRevision, cell])
  useEffect(() => {
    if (isEditing) return
    if (!blurText) setDraft(formatDraft(value))
    setMultiDraft(Array.isArray(value) ? value : [])
  }, [blurText, isEditing, value])

  if (column.type === 'checkbox') {
    return <span className="dbw-checkbox-editor"><input aria-label={column.name} checked={value === true} onChange={(event) => void onChangeValue(event.target.checked)} type="checkbox" /></span>
  }

  if (column.type === 'select') {
    return (
      <select aria-label={column.name} className="catalog-cell-input" onChange={(event) => void onChangeValue(event.target.value || null)} value={typeof value === 'string' ? value : ''}>
        <option value="">—</option>
        {column.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    )
  }

  if (column.type === 'multi-select') {
    return (
      <details className="dbw-multi-editor" onToggle={(event) => setIsEditing(event.currentTarget.open)} ref={detailsRef}>
        <summary aria-label={column.name} title={multiDraft.join(' · ')}>{multiDraft.length > 0 ? multiDraft.join(' · ') : '—'}</summary>
        <div className="dbw-multi-editor-menu" ref={menuRef} style={menuStyle}>
          {column.options.map((option) => (
            <label key={option}><input checked={multiDraft.includes(option)} onChange={(event) => {
              const next = event.target.checked ? [...new Set([...multiDraft, option])] : multiDraft.filter((item) => item !== option)
              setMultiDraft(next)
              void onChangeValue(next.length > 0 ? next : null)
            }} type="checkbox" />{option}</label>
          ))}
        </div>
      </details>
    )
  }

  if (column.type === 'date') {
    return <input aria-label={column.name} className="catalog-cell-input" onBlur={() => setIsEditing(false)} onChange={(event) => void onChangeValue(event.target.value || null)} onFocus={() => setIsEditing(true)} type="date" value={typeof value === 'string' ? value : ''} />
  }

  const commit = (nextDraft: string) => {
    const nextValue = nextDraft.trim() || null
    if (!blurText) { void onChangeValue(nextValue); return }
    if (!cache.get(key) || cache.get(key)?.raw !== nextDraft) cache.edit(key, value, nextDraft, textDraftRevision)
    void cache.commit(key, nextValue, onChangeValue, text.formFailed, { value, revision: textDraftRevision })
  }
  const control = (
    <input
      aria-label={column.name}
      aria-busy={blurText && pending || undefined}
      aria-invalid={cell?.status === 'failed' || undefined}
      aria-describedby={message ? feedbackId : undefined}
      className="catalog-cell-input"
      onBlur={(event) => {
        composing.current = false
        setIsEditing(false)
        if (textCommitMode === 'blur' && !cancelBlurCommit.current && !root.current?.contains(event.relatedTarget as Node | null)) commit(event.currentTarget.value)
        cancelBlurCommit.current = false
      }}
      onChange={(event) => { if (blurText) cache.edit(key, value, event.target.value, textDraftRevision); else setDraft(event.target.value); if (textCommitMode === 'change') commit(event.target.value) }}
      onFocus={() => { focusValue.current = value; focusDraft.current = cache.get(key); cancelBlurCommit.current = false; setIsEditing(true) }}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={() => { composing.current = false }}
      onKeyDown={(event) => {
        if (isImeKeyboardEvent(event.nativeEvent, composing.current)) {
          event.stopPropagation()
          return
        }
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          cancelBlurCommit.current = true
          if (blurText) cache.restore(key, focusDraft.current)
          else setDraft(formatDraft(focusValue.current))
          if (textCommitMode === 'change') void onChangeValue(focusValue.current)
          event.currentTarget.blur()
        }
      }}
      readOnly={blurText && pending}
      title={message || undefined}
      value={blurText ? cell?.raw ?? formatTextDraft(value) : draft}
    />
  )
  if (!blurText) return control
  return <span className="dbw-text-cell-editor" ref={root}>
    {control}
    {cell?.action && <button aria-busy={pending || undefined} aria-disabled={pending || undefined}
      aria-describedby={message ? feedbackId : undefined} className="dbw-quiet-button" type="button" title={message || undefined}
      onClick={() => { if (cell.action === 'retry') commit(cell.raw); else if (onRefreshValue) void cache.refresh(key, onRefreshValue, text.savedRefreshFailed) }}>
      {cell.action === 'retry' ? text.retry : text.refresh}
    </button>}
    {message && <span className="sr-only dbw-text-cell-feedback" id={feedbackId} role={cell?.status === 'failed' ? 'alert' : 'status'}>{message}</span>}
  </span>
}

function localizeCellMessage(message: string, text: DatabaseWorkspaceText): string {
  if (cellMessages.some(source => source.formFailed === message)) return text.formFailed
  if (cellMessages.some(source => source.savedRefreshFailed === message)) return text.savedRefreshFailed
  return message
}

function formatDraft(value: DocumentDatabaseFieldValue): string {
  if (Array.isArray(value)) return value.join(', ')
  return typeof value === 'string' ? value : ''
}

function useMultiSelectMenuPosition(open: boolean) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>()

  useLayoutEffect(() => {
    if (!open) return
    const details = detailsRef.current
    const menu = menuRef.current
    if (!details || !menu) return

    const update = () => {
      const anchor = details.getBoundingClientRect()
      const bounds = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
      // Stay inside every clipping ancestor, including the table/form scroller.
      for (let parent = details.parentElement; parent; parent = parent.parentElement) {
        const style = window.getComputedStyle(parent)
        const rect = parent.getBoundingClientRect()
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          bounds.top = Math.max(bounds.top, rect.top + parent.clientTop)
          bounds.bottom = Math.min(bounds.bottom, rect.top + parent.clientTop + parent.clientHeight)
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          bounds.left = Math.max(bounds.left, rect.left + parent.clientLeft)
          bounds.right = Math.min(bounds.right, rect.left + parent.clientLeft + parent.clientWidth)
        }
      }

      const gap = 4
      const below = Math.max(0, bounds.bottom - anchor.bottom - gap * 2)
      const above = Math.max(0, anchor.top - bounds.top - gap * 2)
      const desiredHeight = Math.min(220, menu.scrollHeight + 2)
      const opensAbove = desiredHeight > below && above > below
      const width = Math.min(Math.max(anchor.width, 180), Math.max(0, bounds.right - bounds.left - gap * 2))
      const left = Math.max(bounds.left + gap, Math.min(anchor.left, bounds.right - width - gap)) - anchor.left
      const next: CSSProperties = {
        top: opensAbove ? 'auto' : 'calc(100% + 4px)',
        bottom: opensAbove ? 'calc(100% + 4px)' : 'auto',
        left,
        width,
        maxHeight: Math.min(220, opensAbove ? above : below)
      }
      setMenuStyle((current) => current && Object.keys(next).every((key) => current[key as keyof CSSProperties] === next[key as keyof CSSProperties]) ? current : next)
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(details)
    observer.observe(menu)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  return { detailsRef, menuRef, menuStyle }
}
