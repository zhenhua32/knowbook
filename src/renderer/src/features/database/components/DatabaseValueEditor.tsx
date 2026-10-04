import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { DocumentDatabaseColumn, DocumentDatabaseFieldValue } from '@shared/contracts'
import { isImeKeyboardEvent } from '../../../utils/imeKeyboard'
import { getDatabaseWorkspaceText, type DatabaseWorkspaceText } from '../databaseText'
import { DatabaseTextDraftCache, formatTextDraft, type DatabaseTextDraft, type DatabaseValueCommitResult } from '../model/databaseTextDrafts'
import { DatabaseMultiSelectCellCache, multiSelectChoices, multiSelectSchema } from '../model/databaseMultiSelectCells'
import { adaptSelectCellChange, selectCellChoices, selectCellSchema } from '../model/databaseSelectCells'
import { adaptCheckboxCellChange, checkboxCellChoices, checkboxCellSchema } from '../model/databaseCheckboxCells'
import { dateDraftKey } from '../model/databaseDateCells'
import { appNotifications } from '../../../app-notifications'

const cellMessages = ['en-US', 'zh-CN'].map(getDatabaseWorkspaceText)

export function DatabaseValueEditor({
  column,
  value,
  onChangeValue,
  textCommitMode = 'blur',
  textDraftCache,
  multiSelectCache,
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
  multiSelectCache?: DatabaseMultiSelectCellCache
  textDraftKey?: string
  textDraftRevision?: string
  onRefreshValue?: (isCurrent: () => boolean) => Promise<void | boolean>
  text?: DatabaseWorkspaceText
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(formatDraft(value))
  const [dateIncomplete, setDateIncomplete] = useState(false)
  const composing = useRef(false)
  const cancelBlurCommit = useRef(false)
  const focusValue = useRef(value)
  const localCache = useRef<DatabaseTextDraftCache | null>(null)
  if (!localCache.current) localCache.current = new DatabaseTextDraftCache()
  const cache = textDraftCache ?? localCache.current
  const isDate = column.type === 'date'
  const baseKey = textDraftKey ?? JSON.stringify(['', '', column.id])
  const key = isDate ? dateDraftKey(baseKey) : baseKey
  const blurText = (column.type === 'text' || isDate) && textCommitMode === 'blur'
  const isMulti = column.type === 'multi-select'
  const isSelect = column.type === 'select'
  const isCheckbox = column.type === 'checkbox'
  const isChoice = isMulti || isSelect || isCheckbox
  const localMultiCache = useRef<DatabaseMultiSelectCellCache | null>(null)
  if (!localMultiCache.current) localMultiCache.current = new DatabaseMultiSelectCellCache()
  const multiCache = multiSelectCache ?? localMultiCache.current
  const multiSchema = isSelect ? selectCellSchema(column.options) : isCheckbox ? checkboxCellSchema() : multiSelectSchema(column.options)
  const multiCell = useSyncExternalStore(listener => isChoice ? multiCache.subscribe(key, listener) : () => {},
    () => isChoice ? multiCache.get(key) : undefined, () => isChoice ? multiCache.get(key) : undefined)
  const cell = useSyncExternalStore(listener => blurText ? cache.subscribe(key, listener) : () => {},
    () => blurText ? cache.get(key) : undefined, () => blurText ? cache.get(key) : undefined)
  const focusDraft = useRef<DatabaseTextDraft | undefined>(undefined)
  const root = useRef<HTMLSpanElement>(null), feedbackId = useId()
  const pending = Boolean(cell?.operation)
  const reading = Boolean(cell?.readOperation)
  const message = pending ? text.saving : dateIncomplete ? text.dateIncomplete
    : reading ? text.cellRefreshing : localizeCellMessage(cell?.message ?? '', text)
  const { detailsRef, menuRef, menuStyle } = useMultiSelectMenuPosition(isMulti && isEditing,
    Boolean(multiCell?.operation || multiCell?.valid && multiCell.schema === multiSchema && (multiCell.readOperation || multiCell.message)))

  useLayoutEffect(() => {
    focusDraft.current = undefined
    focusValue.current = value
    composing.current = false
    cancelBlurCommit.current = false
    setDateIncomplete(false)
  }, [cache, key, column.type, textCommitMode])
  useLayoutEffect(() => {
    if (blurText) cache.sync(key, value, textDraftRevision)
  }, [blurText, cache, key, value, textDraftRevision, cell])
  useLayoutEffect(() => {
    if (isChoice) multiCache.sync(key, isSelect ? selectCellChoices(value) : isCheckbox ? checkboxCellChoices(value) : value,
      textDraftRevision, multiSchema)
  }, [isChoice, isSelect, isCheckbox, multiCache, key, value, textDraftRevision, multiSchema, multiCell])
  useLayoutEffect(() => {
    if (!blurText || !focusDraft.current?.operation || !cell || cell.operation
      || (cell.status !== 'saved' && cell.status !== 'failed')) return
    const container = root.current
    if (container && container.querySelector('input') === container.ownerDocument.activeElement) {
      focusDraft.current = cell
    }
  }, [blurText, cell])
  useEffect(() => {
    if (isEditing) return
    if (!blurText) setDraft(formatDraft(value))
  }, [blurText, isEditing, value])

  if (column.type === 'checkbox') {
    const valid = multiCell?.valid && multiCell.schema === multiSchema
    const checked = valid ? multiCell.choices.includes('checked') : value === true
    const saving = Boolean(multiCell?.operation), refreshing = Boolean(valid && multiCell.readOperation)
    const checkboxMessage = saving ? text.saving : refreshing ? text.cellRefreshing
      : valid && multiCell.message === 'save' ? text.checkboxSaveFailed
      : valid && multiCell.message === 'refresh' ? text.savedRefreshFailed : ''
    return <span className="dbw-checkbox-editor">
      <input aria-label={column.name} checked={checked} type="checkbox" aria-disabled={saving || undefined}
        aria-busy={saving || refreshing || undefined} aria-describedby={checkboxMessage ? feedbackId : undefined}
        title={checkboxMessage || undefined} onChange={(event) => {
          multiCache.commit(key, checkboxCellChoices(event.currentTarget.checked), checkboxCellChoices(value),
            textDraftRevision, multiSchema, adaptCheckboxCellChange(onChangeValue))
        }} />
      {saving && <small aria-hidden="true">{text.saving}</small>}
      {valid && multiCell.action === 'refresh' && onRefreshValue && <button type="button" className="dbw-quiet-button"
        aria-disabled={refreshing || undefined} aria-busy={refreshing || undefined}
        aria-describedby={checkboxMessage ? feedbackId : undefined} title={checkboxMessage || undefined}
        onClick={() => void multiCache.refresh(key, onRefreshValue)}>{text.refresh}</button>}
      {checkboxMessage && <span className="sr-only dbw-checkbox-cell-feedback" id={feedbackId}
        role={valid && multiCell.message === 'save' && !saving ? 'alert' : 'status'}>{checkboxMessage}</span>}
    </span>
  }

  if (column.type === 'select') {
    const valid = multiCell?.valid && multiCell.schema === multiSchema
    const selected = valid ? multiCell.choices[0] ?? '' : typeof value === 'string' ? value : ''
    const saving = Boolean(multiCell?.operation), refreshing = Boolean(valid && multiCell.readOperation)
    const selectMessage = saving ? text.saving : refreshing ? text.cellRefreshing
      : valid && multiCell.message === 'save' ? text.selectSaveFailed
      : valid && multiCell.message === 'refresh' ? text.savedRefreshFailed : ''
    return (
      <span className="dbw-text-cell-editor dbw-select-cell-editor">
        <select aria-label={column.name} className="catalog-cell-input" aria-disabled={saving || undefined}
          aria-busy={saving || refreshing || undefined} aria-describedby={selectMessage ? feedbackId : undefined}
          title={selectMessage || undefined} value={selected} onChange={(event) => {
            multiCache.commit(key, selectCellChoices(event.currentTarget.value), selectCellChoices(value),
              textDraftRevision, multiSchema, adaptSelectCellChange(onChangeValue))
          }}>
          <option value="">—</option>
          {column.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        {saving && <small aria-hidden="true">{text.saving}</small>}
        {valid && multiCell.action === 'refresh' && onRefreshValue && <button type="button" className="dbw-quiet-button"
          aria-disabled={refreshing || undefined} aria-busy={refreshing || undefined}
          aria-describedby={selectMessage ? feedbackId : undefined} title={selectMessage || undefined}
          onClick={() => void multiCache.refresh(key, onRefreshValue)}>{text.refresh}</button>}
        {selectMessage && <span className="sr-only dbw-select-cell-feedback" id={feedbackId}
          role={valid && multiCell.message === 'save' && !saving ? 'alert' : 'status'}>{selectMessage}</span>}
      </span>
    )
  }

  if (column.type === 'multi-select') {
    const valid = multiCell?.valid && multiCell.schema === multiSchema
    const multiDraft = valid ? multiCell.choices : multiSelectChoices(value)
    const saving = Boolean(multiCell?.operation), refreshing = Boolean(valid && multiCell.readOperation)
    const multiMessage = saving ? text.saving : refreshing ? text.cellRefreshing
      : valid && multiCell.message === 'save' ? text.multiSelectSaveFailed
      : valid && multiCell.message === 'refresh' ? text.savedRefreshFailed : ''
    return (
      <details className="dbw-multi-editor" onToggle={(event) => setIsEditing(event.currentTarget.open)} ref={detailsRef}>
        <summary aria-label={column.name} aria-busy={saving || refreshing || undefined}
          aria-describedby={multiMessage ? feedbackId : undefined} title={multiDraft.join(' · ')}>
          {saving ? text.saving : multiDraft.length > 0 ? multiDraft.join(' · ') : '—'}
        </summary>
        <div className="dbw-multi-editor-menu" ref={menuRef} style={menuStyle}>
          {column.options.map((option) => (
            <label key={option}><input aria-disabled={saving || undefined} aria-busy={saving || undefined}
              aria-describedby={multiMessage ? feedbackId : undefined} checked={multiDraft.includes(option)} onChange={(event) => {
              const next = event.target.checked ? [...new Set([...multiDraft, option])] : multiDraft.filter((item) => item !== option)
              multiCache.commit(key, next, value, textDraftRevision, multiSchema, onChangeValue)
            }} type="checkbox" />{option}</label>
          ))}
          {multiMessage && <p className="dbw-multi-feedback" id={feedbackId}
            role={valid && multiCell.message === 'save' && !saving ? 'alert' : 'status'}>{multiMessage}</p>}
          {valid && multiCell.action === 'refresh' && onRefreshValue && <button type="button" className="dbw-quiet-button"
            aria-busy={refreshing || undefined} aria-disabled={refreshing || undefined}
            aria-describedby={multiMessage ? feedbackId : undefined} title={multiMessage || undefined}
            onClick={() => void multiCache.refresh(key, onRefreshValue)}>{text.refresh}</button>}
        </div>
      </details>
    )
  }

  const commit = (nextDraft: string, explicitRetry = false, badInput = false) => {
    // An unfinished native date segment has an empty value, but is not a clear.
    if (isDate && textCommitMode === 'blur') {
      const incomplete = badInput || nextDraft !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(nextDraft)
      setDateIncomplete(incomplete)
      if (incomplete) return
    }
    const nextValue = nextDraft.trim() || null
    if (!blurText) { void onChangeValue(nextValue); return }
    if (!cache.get(key) && nextValue === (formatTextDraft(value).trim() || null)) return
    if (!cache.get(key) || cache.get(key)?.raw !== nextDraft) cache.edit(key, value, nextDraft, textDraftRevision)
    void cache.commit(key, nextValue, onChangeValue, isDate ? text.dateSaveFailed : text.formFailed,
      { value, revision: textDraftRevision, explicitRetry }, text.savedRefreshFailed)
    // Date Enter keeps focus; rebase its Escape snapshot when this write settles.
    const accepted = isDate ? cache.get(key) : undefined
    const input = root.current?.querySelector('input')
    if (accepted?.operation && input === input?.ownerDocument.activeElement) focusDraft.current = accepted
  }
  const control = (
    <input
      aria-label={column.name}
      aria-busy={blurText && pending || undefined}
      aria-invalid={dateIncomplete || cell?.status === 'failed' || undefined}
      aria-describedby={message ? feedbackId : undefined}
      className="catalog-cell-input"
      onBlur={(event) => {
        composing.current = false
        setIsEditing(false)
        if (textCommitMode === 'blur' && !cancelBlurCommit.current && !root.current?.contains(event.relatedTarget as Node | null)) commit(event.currentTarget.value, false, event.currentTarget.validity.badInput)
        cancelBlurCommit.current = false
      }}
      onChange={(event) => { if (isDate) setDateIncomplete(false); if (blurText) cache.edit(key, value, event.target.value, textDraftRevision); else setDraft(event.target.value); if (textCommitMode === 'change') commit(event.target.value) }}
      onFocus={() => { focusValue.current = value; focusDraft.current = cache.get(key); cancelBlurCommit.current = false; setIsEditing(true) }}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={() => { composing.current = false }}
      onKeyDown={(event) => {
        if (isImeKeyboardEvent(event.nativeEvent, composing.current)) {
          event.stopPropagation()
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          if (isDate) { if (blurText) commit(event.currentTarget.value, false, event.currentTarget.validity.badInput) }
          else event.currentTarget.blur()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          cancelBlurCommit.current = true
          setDateIncomplete(false)
          if (blurText) cache.restore(key, focusDraft.current)
          else setDraft(formatDraft(focusValue.current))
          if (textCommitMode === 'change') void onChangeValue(focusValue.current)
          event.currentTarget.blur()
        }
      }}
      readOnly={blurText && pending}
      type={isDate ? 'date' : undefined}
      title={message || undefined}
      value={blurText ? cell?.raw ?? formatTextDraft(value) : draft}
    />
  )
  if (!blurText) return control
  return <span className={isDate ? 'dbw-date-cell-editor' : 'dbw-text-cell-editor'} ref={root}>
    {control}
    {isDate && pending && <small aria-hidden="true">…</small>}
    {cell?.action && <button aria-busy={pending || reading || undefined} aria-disabled={pending || reading || undefined}
      aria-label={isDate ? cell.action === 'retry' ? text.retry : text.refresh : undefined}
      aria-describedby={message ? feedbackId : undefined} className="dbw-quiet-button" type="button" title={message || undefined}
      onClick={() => {
        if (cell.action === 'retry') {
          const input = isDate ? root.current?.querySelector('input') : undefined
          commit(input?.value ?? cell.raw, true, input?.validity.badInput)
        } else if (onRefreshValue) void cache.refresh(key, onRefreshValue, text.savedRefreshFailed)
      }}>
      {isDate ? '↻' : cell.action === 'retry' ? text.retry : text.refresh}
    </button>}
    {message && <span className={`sr-only ${isDate ? 'dbw-date-cell-feedback' : 'dbw-text-cell-feedback'}`} id={feedbackId}
      role={dateIncomplete || cell?.status === 'failed' ? 'alert' : 'status'}>{message}</span>}
  </span>
}

function localizeCellMessage(message: string, text: DatabaseWorkspaceText): string {
  if (cellMessages.some(source => source.formFailed === message)) return text.formFailed
  if (cellMessages.some(source => source.dateSaveFailed === message)) return text.dateSaveFailed
  if (cellMessages.some(source => source.savedRefreshFailed === message)) return text.savedRefreshFailed
  return message
}

function formatDraft(value: DocumentDatabaseFieldValue): string {
  if (Array.isArray(value)) return value.join(', ')
  return typeof value === 'string' ? value : ''
}

function useMultiSelectMenuPosition(open: boolean, feedback: boolean) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>()

  useLayoutEffect(() => {
    if (!open) return
    const details = detailsRef.current
    const menu = menuRef.current
    const view = details?.ownerDocument.defaultView
    if (!details || !menu || !view) return
    const owner = details.ownerDocument
    let disposed = false, frame: number | null = null
    const observed = new Set<Element>(), lists = new Set<Element>()

    const update = () => {
      if (disposed || !details.isConnected || !menu.isConnected) return
      const anchor = details.getBoundingClientRect()
      const bounds = { top: 0, bottom: view.innerHeight, left: 0, right: view.innerWidth }
      // Stay inside every clipping ancestor, including the table/form scroller.
      for (let parent = details.parentElement; parent; parent = parent.parentElement) {
        const style = view.getComputedStyle(parent)
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
      const desiredHeight = Math.min(220, menu.scrollHeight + 2)
      const width = Math.min(Math.max(anchor.width, feedback ? 240 : 180), Math.max(0, bounds.right - bounds.left - gap * 2))
      const clampLeft = (left: number) => Math.max(bounds.left + gap, Math.min(left, bounds.right - width - gap))
      const originalLeft = clampLeft(anchor.left)
      const obstacles = [...owner.querySelectorAll<HTMLElement>('.app-notifications > .app-notification, .app-notifications > .app-notification-summary')]
        .flatMap(card => {
          const style = view.getComputedStyle(card), rect = card.getBoundingClientRect()
          if (!card.getClientRects().length || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return []
          const list = card.parentElement!.getBoundingClientRect()
          const visible = { left: Math.max(0, rect.left, list.left), right: Math.min(view.innerWidth, rect.right, list.right),
            top: Math.max(0, rect.top, list.top), bottom: Math.min(view.innerHeight, rect.bottom, list.bottom) }
          return visible.right > visible.left && visible.bottom > visible.top ? [visible] : []
        })
      const candidates = new Set([originalLeft])
      for (const obstacle of obstacles) {
        candidates.add(clampLeft(obstacle.left - width - gap))
        candidates.add(clampLeft(obstacle.right + gap))
      }
      const placements = [...candidates].map(left => {
        let below = Math.max(0, bounds.bottom - anchor.bottom - gap * 2)
        let above = Math.max(0, anchor.top - bounds.top - gap * 2)
        for (const obstacle of obstacles) {
          if (left + width <= obstacle.left || left >= obstacle.right) continue
          if (obstacle.bottom > anchor.bottom + gap && obstacle.top < bounds.bottom - gap) {
            below = Math.min(below, Math.max(0, obstacle.top - anchor.bottom - gap * 2))
          }
          if (obstacle.top < anchor.top - gap && obstacle.bottom > bounds.top + gap) {
            above = Math.min(above, Math.max(0, anchor.top - obstacle.bottom - gap * 2))
          }
        }
        const aboveAnchor = desiredHeight > below && above > below
        return { left, aboveAnchor, capacity: aboveAnchor ? above : below, distance: Math.abs(left - originalLeft) }
      }).sort((left, right) => {
        const leftFits = left.capacity >= desiredHeight, rightFits = right.capacity >= desiredHeight
        if (leftFits !== rightFits) return leftFits ? -1 : 1
        return leftFits ? left.distance - right.distance : right.capacity - left.capacity || left.distance - right.distance
      })
      const placement = placements[0]
      const next: CSSProperties = {
        top: placement.aboveAnchor ? 'auto' : 'calc(100% + 4px)',
        bottom: placement.aboveAnchor ? 'calc(100% + 4px)' : 'auto',
        left: placement.left - anchor.left,
        width,
        maxHeight: Math.min(220, placement.capacity)
      }
      setMenuStyle((current) => current && Object.keys(next).every((key) => current[key as keyof CSSProperties] === next[key as keyof CSSProperties]) ? current : next)
    }

    const schedule = () => {
      if (disposed || frame !== null) return
      frame = view.requestAnimationFrame(() => { frame = null; if (!disposed) { observeToasts(); update() } })
    }
    const observer = typeof view.ResizeObserver === 'undefined' ? null : new view.ResizeObserver(schedule)
    const toastObserver = new view.MutationObserver(schedule)
    const observeToasts = () => {
      const nextLists = [...owner.querySelectorAll('.app-notifications')]
      if (nextLists.length !== lists.size || nextLists.some(list => !lists.has(list))) {
        toastObserver.disconnect()
        lists.clear()
        for (const list of nextLists) { lists.add(list); toastObserver.observe(list, { childList: true, subtree: true }) }
      }
      const next = new Set<Element>([details, menu, ...nextLists, ...nextLists.flatMap(list =>
        [...list.querySelectorAll('.app-notification, .app-notification-summary')].filter(card => card.getClientRects().length > 0))])
      for (const target of observed) if (!next.has(target)) { observer?.unobserve(target); observed.delete(target) }
      for (const target of next) if (!observed.has(target)) { observer?.observe(target); observed.add(target) }
    }
    const bodyObserver = new view.MutationObserver(schedule)
    bodyObserver.observe(owner.body, { childList: true })
    const unsubscribe = appNotifications.subscribe(schedule)
    observeToasts()
    update()
    view.addEventListener('resize', schedule)
    view.addEventListener('scroll', schedule, true)
    return () => {
      disposed = true
      if (frame !== null) view.cancelAnimationFrame(frame)
      unsubscribe()
      observer?.disconnect()
      toastObserver.disconnect()
      bodyObserver.disconnect()
      view.removeEventListener('resize', schedule)
      view.removeEventListener('scroll', schedule, true)
    }
  }, [open, feedback])

  return { detailsRef, menuRef, menuStyle }
}
