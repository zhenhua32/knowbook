import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { DatabaseSource } from '@shared/contracts'
import type { DatabaseWorkspaceText } from '../databaseText'
import { isImeKeyboardEvent } from '../../../utils/imeKeyboard'

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getClientRects().length) return false
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return Boolean(style && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse')
}

type DatabaseHeaderProps = {
  currentSource: DatabaseSource
  sourceSessionKey?: unknown
  sources: DatabaseSource[]
  text: DatabaseWorkspaceText
  onCreateDatabase: (returnTarget: HTMLElement | null) => void
  onCreateRecord: () => void
  onDeleteDatabase: () => void
  onEditDatabase: (returnTarget: HTMLElement | null) => void
  onRefresh: () => void | Promise<void>
  onSourceChange: (sourceId: string) => void
  refreshing: boolean
}

export function DatabaseHeader({
  currentSource,
  sourceSessionKey,
  sources,
  text,
  onCreateDatabase,
  onCreateRecord,
  onDeleteDatabase,
  onEditDatabase,
  onRefresh,
  onSourceChange,
  refreshing
}: DatabaseHeaderProps) {
  const sourcePickerId = useId()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const sourceTriggerRef = useRef<HTMLButtonElement | null>(null)
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null)
  const sourcePickerRef = useRef<HTMLDivElement | null>(null)
  const settingsMenuRef = useRef<HTMLDivElement | null>(null)
  const composingTarget = useRef<EventTarget | null>(null)

  const closePopup = (close: (open: boolean) => void, popup: HTMLElement | null, trigger: HTMLElement | null) => {
    close(false)
    const target = composingTarget.current as Node | null
    if (popup?.contains(target) || trigger?.contains(target) || (target && !target.isConnected)) composingTarget.current = null
  }
  const closePicker = () => closePopup(setPickerOpen, sourcePickerRef.current, sourceTriggerRef.current)
  const closeMenu = () => closePopup(setMenuOpen, settingsMenuRef.current, settingsTriggerRef.current)

  useLayoutEffect(() => {
    if (pickerOpen) closePicker()
    if (menuOpen) closeMenu()
  }, [currentSource.id, currentSource.kind, sourceSessionKey])

  const closeOnEscape = (event: ReactKeyboardEvent<HTMLElement>, open: boolean,
    close: (open: boolean) => void, trigger: HTMLButtonElement | null) => {
    if (!open || event.defaultPrevented || event.key !== 'Escape'
      || isImeKeyboardEvent(event.nativeEvent, composingTarget.current === event.target)) return
    event.preventDefault()
    event.stopPropagation()
    const scope = event.currentTarget, owner = scope.ownerDocument, active = owner.activeElement
    const ownsFocus = scope.contains(active) || active === trigger
    close(false)
    composingTarget.current = null
    if (!ownsFocus || !trigger || active === trigger || !owner.hasFocus() || trigger.ownerDocument !== owner
      || trigger.disabled || trigger.getAttribute('aria-disabled') === 'true' || !isVisible(scope) || !isVisible(trigger)) return
    const foreignModal = Array.from(owner.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"], [role="alertdialog"]'))
      .some(modal => !modal.contains(rootRef.current) && isVisible(modal))
    if (!foreignModal) trigger.focus({ preventScroll: true })
  }

  useEffect(() => {
    const owner = rootRef.current?.ownerDocument, view = owner?.defaultView
    if (!owner || !view) return
    const outside = (event: Event) => {
      const target = event.target as Node | null, picker = sourcePickerRef.current, menu = settingsMenuRef.current
      if (picker && !picker.contains(target) && !sourceTriggerRef.current?.contains(target)) closePicker()
      if (menu && !menu.contains(target) && !settingsTriggerRef.current?.contains(target)) closeMenu()
    }
    const blur = () => {
      if (sourcePickerRef.current) closePicker()
      if (settingsMenuRef.current) closeMenu()
    }
    owner.addEventListener('pointerdown', outside, true)
    owner.addEventListener('focusin', outside, true)
    view.addEventListener('blur', blur)
    return () => {
      owner.removeEventListener('pointerdown', outside, true)
      owner.removeEventListener('focusin', outside, true)
      view.removeEventListener('blur', blur)
    }
  }, [])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredSources = sources.filter((source) => !normalizedQuery || `${source.name} ${source.description}`.toLocaleLowerCase().includes(normalizedQuery))
  const systemSources = filteredSources.filter((source) => source.kind === 'document-catalog')
  const customSources = filteredSources.filter((source) => source.kind === 'custom')

  return (
    <header className="dbw-header" ref={rootRef}
      onCompositionStartCapture={event => { composingTarget.current = event.target }}
      onCompositionEndCapture={() => { composingTarget.current = null }}
      onBlurCapture={event => { if (composingTarget.current === event.target) composingTarget.current = null }}>
      <div className="dbw-identity">
        <span aria-hidden="true" className="dbw-database-mark">▦</span>
        <div className="dbw-source-wrap">
          <button
            aria-expanded={pickerOpen}
            aria-haspopup="dialog"
            aria-controls={pickerOpen ? sourcePickerId : undefined}
            className="dbw-source-trigger"
            ref={sourceTriggerRef}
            onKeyDown={event => closeOnEscape(event, pickerOpen, setPickerOpen, sourceTriggerRef.current)}
            onClick={() => {
              setPickerOpen((open) => !open)
              if (settingsMenuRef.current) closeMenu()
            }}
            title={currentSource.kind === 'document-catalog' ? text.allDocuments : currentSource.name}
            type="button"
          >
            <span>{currentSource.kind === 'document-catalog' ? text.allDocuments : currentSource.name}</span>
            <span aria-hidden="true" className="dbw-chevron">⌄</span>
          </button>
          <p>{currentSource.kind === 'document-catalog' ? text.catalogDescription : currentSource.description || text.customDescription}</p>

          {pickerOpen ? (
            <div className="dbw-popover dbw-source-picker" role="dialog" id={sourcePickerId} aria-label={text.chooseDatabase} ref={sourcePickerRef}
              onKeyDown={event => closeOnEscape(event, pickerOpen, setPickerOpen, sourceTriggerRef.current)}>
              <label className="dbw-search-field dbw-source-search">
                <span aria-hidden="true">⌕</span>
                <input
                  autoFocus
                  aria-label={text.searchDatabase}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={text.searchDatabase}
                  value={query}
                />
              </label>
              <div className="dbw-source-list">
                {filteredSources.length === 0 ? <p className="dbw-source-empty">{text.noDatabases}</p> : null}
                {systemSources.map((source) => (
                  <SourceOption allDocumentsLabel={text.allDocuments} currentId={currentSource.id} key={source.id} onSelect={(sourceId) => { setPickerOpen(false); setQuery(''); onSourceChange(sourceId) }} source={source} systemLabel={text.system} />
                ))}
                {customSources.length > 0 ? <p className="dbw-menu-label">{text.custom}</p> : null}
                {customSources.map((source) => (
                  <SourceOption allDocumentsLabel={text.allDocuments} currentId={currentSource.id} key={source.id} onSelect={(sourceId) => { setPickerOpen(false); setQuery(''); onSourceChange(sourceId) }} source={source} systemLabel={text.system} />
                ))}
              </div>
              <button
                className="dbw-menu-create"
                onClick={() => {
                  setPickerOpen(false)
                  onCreateDatabase(sourceTriggerRef.current)
                }}
                type="button"
              >
                <span aria-hidden="true">＋</span>{text.newDatabase}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="dbw-header-actions">
        <button aria-label={text.refreshDatabase} title={text.refreshDatabase} aria-busy={refreshing || undefined}
          aria-disabled={refreshing || undefined} className="dbw-icon-button dbw-refresh-button" type="button"
          onPointerDown={(event) => { if (event.isPrimary && event.button === 0) event.preventDefault() }}
          onClick={() => { void onRefresh() }}>
          <span aria-hidden="true">{refreshing ? '…' : '↻'}</span>
        </button>
        {refreshing ? <span className="sr-only" role="status">{text.refreshingDatabase}</span> : null}
        <button className="dbw-primary-button" onClick={onCreateRecord} type="button">
          <span aria-hidden="true">＋</span>
          {currentSource.kind === 'document-catalog' ? text.newDocument : text.newRecord}
        </button>
        {currentSource.kind === 'custom' ? (
          <div className="dbw-menu-wrap">
            <button
              aria-label={text.databaseSettings}
              aria-expanded={menuOpen}
              className="dbw-icon-button"
              ref={settingsTriggerRef}
              onKeyDown={event => closeOnEscape(event, menuOpen, setMenuOpen, settingsTriggerRef.current)}
              onClick={() => {
                setMenuOpen((open) => !open)
                if (sourcePickerRef.current) closePicker()
              }}
              type="button"
            >•••</button>
            {menuOpen ? (
              <div className="dbw-popover dbw-action-menu" ref={settingsMenuRef}
                onKeyDown={event => closeOnEscape(event, menuOpen, setMenuOpen, settingsTriggerRef.current)}>
                <button onClick={() => { setMenuOpen(false); onEditDatabase(settingsTriggerRef.current) }} type="button">{text.editDatabase}</button>
                <button className="dbw-danger-text" onClick={() => { setMenuOpen(false); onDeleteDatabase() }} type="button">{text.deleteDatabase}</button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  )
}

function SourceOption({
  currentId,
  allDocumentsLabel,
  onSelect,
  source,
  systemLabel
}: {
  currentId: string
  allDocumentsLabel: string
  onSelect: (sourceId: string) => void
  source: DatabaseSource
  systemLabel: string
}) {
  return (
    <button
      aria-current={source.id === currentId ? 'true' : undefined}
      className="dbw-source-option"
      onClick={() => onSelect(source.id)}
      type="button"
    >
      <span className="dbw-source-option-icon" aria-hidden="true">{source.kind === 'document-catalog' ? '▤' : '▦'}</span>
      <span className="dbw-source-option-copy">
        <strong>{source.kind === 'document-catalog' ? allDocumentsLabel : source.name}</strong>
        <small>{source.description}</small>
      </span>
      {source.kind === 'document-catalog' ? <span className="dbw-system-badge">{systemLabel}</span> : null}
      {source.id === currentId ? <span aria-hidden="true">✓</span> : null}
    </button>
  )
}
