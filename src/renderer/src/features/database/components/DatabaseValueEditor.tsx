import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { DocumentDatabaseColumn, DocumentDatabaseFieldValue } from '@shared/contracts'

export function DatabaseValueEditor({
  column,
  value,
  onChangeValue,
  textCommitMode = 'blur'
}: {
  column: DocumentDatabaseColumn
  value: DocumentDatabaseFieldValue
  onChangeValue: (value: DocumentDatabaseFieldValue) => void | Promise<void>
  textCommitMode?: 'blur' | 'change'
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(formatDraft(value))
  const [multiDraft, setMultiDraft] = useState<string[]>(Array.isArray(value) ? value : [])
  const { detailsRef, menuRef, menuStyle } = useMultiSelectMenuPosition(column.type === 'multi-select' && isEditing)

  useEffect(() => {
    if (isEditing) return
    setDraft(formatDraft(value))
    setMultiDraft(Array.isArray(value) ? value : [])
  }, [isEditing, value])

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

  const commit = (nextDraft: string) => void onChangeValue(nextDraft.trim() || null)
  return (
    <input
      aria-label={column.name}
      className="catalog-cell-input"
      onBlur={() => { setIsEditing(false); if (textCommitMode === 'blur') commit(draft) }}
      onChange={(event) => { setDraft(event.target.value); if (textCommitMode === 'change') commit(event.target.value) }}
      onFocus={() => setIsEditing(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') { setDraft(formatDraft(value)); event.currentTarget.blur() }
      }}
      value={draft}
    />
  )
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
