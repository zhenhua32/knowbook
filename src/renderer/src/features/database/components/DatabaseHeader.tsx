import { useEffect, useRef, useState } from 'react'
import type { DatabaseSource } from '@shared/contracts'
import type { DatabaseWorkspaceText } from '../databaseText'

type DatabaseHeaderProps = {
  currentSource: DatabaseSource
  sources: DatabaseSource[]
  text: DatabaseWorkspaceText
  onCreateDatabase: () => void
  onCreateRecord: () => void
  onDeleteDatabase: () => void
  onEditDatabase: () => void
  onSourceChange: (sourceId: string) => void
}

export function DatabaseHeader({
  currentSource,
  sources,
  text,
  onCreateDatabase,
  onCreateRecord,
  onDeleteDatabase,
  onEditDatabase,
  onSourceChange
}: DatabaseHeaderProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setPickerOpen(false)
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredSources = sources.filter((source) => !normalizedQuery || `${source.name} ${source.description}`.toLocaleLowerCase().includes(normalizedQuery))
  const systemSources = filteredSources.filter((source) => source.kind === 'document-catalog')
  const customSources = filteredSources.filter((source) => source.kind === 'custom')

  return (
    <header className="dbw-header" ref={rootRef}>
      <div className="dbw-identity">
        <span aria-hidden="true" className="dbw-database-mark">▦</span>
        <div className="dbw-source-wrap">
          <button
            aria-expanded={pickerOpen}
            className="dbw-source-trigger"
            onClick={() => {
              setPickerOpen((open) => !open)
              setMenuOpen(false)
            }}
            type="button"
          >
            <span>{currentSource.kind === 'document-catalog' ? text.allDocuments : currentSource.name}</span>
            <span aria-hidden="true" className="dbw-chevron">⌄</span>
          </button>
          <p>{currentSource.kind === 'document-catalog' ? text.catalogDescription : currentSource.description || text.customDescription}</p>

          {pickerOpen ? (
            <div className="dbw-popover dbw-source-picker" role="dialog">
              <label className="dbw-search-field dbw-source-search">
                <span aria-hidden="true">⌕</span>
                <input
                  autoFocus
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={text.searchDatabase}
                  value={query}
                />
              </label>
              <div className="dbw-source-list">
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
                  onCreateDatabase()
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
        <button className="dbw-primary-button" onClick={onCreateRecord} type="button">
          <span aria-hidden="true">＋</span>
          {currentSource.kind === 'document-catalog' ? text.newDocument : text.newRecord}
        </button>
        {currentSource.kind === 'custom' ? (
          <div className="dbw-menu-wrap">
            <button
              aria-label={text.databaseSettings}
              className="dbw-icon-button"
              onClick={() => {
                setMenuOpen((open) => !open)
                setPickerOpen(false)
              }}
              type="button"
            >•••</button>
            {menuOpen ? (
              <div className="dbw-popover dbw-action-menu">
                <button onClick={() => { setMenuOpen(false); onEditDatabase() }} type="button">{text.editDatabase}</button>
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
