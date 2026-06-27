import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ComponentProps, type KeyboardEventHandler, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { DocumentDetail, LinkedDocument } from '@shared/contracts'
import { BlockEditorRow } from '../components/BlockEditorRow'
import { BlockSearchPanel } from '../components/BlockSearchPanel'
import { BlockSelectionToolbar } from '../components/BlockSelectionToolbar'
import { DocumentOutlinePanel } from '../components/DocumentOutlinePanel'
import { DocumentPreviewHeader } from '../components/DocumentPreviewHeader'
import { DocumentsAuxPanel } from '../components/DocumentsAuxPanel'
import { DocumentStatsBar } from '../components/DocumentStatsBar'
import { DocumentSummaryCard } from '../components/DocumentSummaryCard'
import { FloatingSlashCommandPanel } from '../components/FloatingSlashCommandPanel'
import { LinkSuggestionPanel } from '../components/LinkSuggestionPanel'

type VisibleEditorRow = Pick<ComponentProps<typeof BlockEditorRow>, 'block' | 'dropPreview' | 'indentPx' | 'index' | 'isSelected' | 'numberLabel' | 'isSearchMatch'>
type SharedBlockEditorRowProps = Omit<ComponentProps<typeof BlockEditorRow>, 'block' | 'dropPreview' | 'indentPx' | 'index' | 'isSelected' | 'numberLabel'>
type RelationGroup = {
  title: string
  emptyText: string
  links: LinkedDocument[]
}

type DocumentsSectionProps = {
  auxPanelWidth: number
  isWideMode: boolean
  selectedDocument: DocumentDetail | null
  previewHeaderProps: ComponentProps<typeof DocumentPreviewHeader>
  summaryCardProps: ComponentProps<typeof DocumentSummaryCard> | null
  outlinePanelProps: ComponentProps<typeof DocumentOutlinePanel> | null
  blocksPanelLabel: string
  blockSearchPanelProps: ComponentProps<typeof BlockSearchPanel>
  selectionToolbarProps: ComponentProps<typeof BlockSelectionToolbar> | null
  visibleEditorRows: VisibleEditorRow[]
  blockEditorRowSharedProps: SharedBlockEditorRowProps | null
  onEditorKeyDown: KeyboardEventHandler<HTMLDivElement>
  onAddBlock: () => void
  onAuxPanelWidthChange: (value: number) => void
  addBlockLabel: string
  linkSuggestionPanelProps: ComponentProps<typeof LinkSuggestionPanel> | null
  editorHelpText: string
  floatingSlashCommandPanelProps: ComponentProps<typeof FloatingSlashCommandPanel> | null
  documentsAuxPanelProps: Omit<ComponentProps<typeof DocumentsAuxPanel>, 'relationContent'> | null
  selectionAiContent?: ReactNode
  relationGroups: RelationGroup[]
  documentStatsBarProps: ComponentProps<typeof DocumentStatsBar> | null
  emptyDocumentStateText: string
}

function RelationList({
  title,
  links,
  emptyText,
  onSelect
}: {
  title: string
  links: LinkedDocument[]
  emptyText: string
  onSelect: (documentId: string) => void
}) {
  return (
    <section className="relation-panel">
      <p className="panel-label">{title}</p>
      {links.length > 0 ? (
        <div className="relation-list">
           {links.map((link) => (
              <button className="relation-chip" key={`${title}-${link.id}`} onClick={() => onSelect(link.id)} title={`${link.title}\n${link.path}`} type="button">
               <strong>{link.title}</strong>
               <span>{link.path}</span>
              {link.contextSnippet ? (
                <span className="relation-chip-context">{link.contextSnippet.slice(0, 120)}{link.contextSnippet.length > 120 ? '…' : ''}</span>
              ) : (
                <small>{link.label}</small>
              )}
            </button>
          ))}
        </div>
      ) : (
        <p className="empty-text">{emptyText}</p>
      )}
    </section>
  )
}

export function DocumentsSection({
  auxPanelWidth,
  isWideMode,
  selectedDocument,
  previewHeaderProps,
  summaryCardProps,
  outlinePanelProps,
  blocksPanelLabel,
  blockSearchPanelProps,
  selectionToolbarProps,
  visibleEditorRows,
  blockEditorRowSharedProps,
  onEditorKeyDown,
  onAddBlock,
  onAuxPanelWidthChange,
  addBlockLabel,
  linkSuggestionPanelProps,
  editorHelpText,
  floatingSlashCommandPanelProps,
  documentsAuxPanelProps,
  selectionAiContent,
  relationGroups,
  documentStatsBarProps,
  emptyDocumentStateText
}: DocumentsSectionProps) {
  const workspaceGridRef = useRef<HTMLElement | null>(null)
  const [isResizingAuxPanel, setIsResizingAuxPanel] = useState(false)
  const auxPanelProps = documentsAuxPanelProps?.isOpen && selectedDocument ? documentsAuxPanelProps : null
  const showAuxPanel = Boolean(auxPanelProps)

  const clampAuxPanelWidth = useCallback((candidateWidth: number) => {
    const containerWidth = workspaceGridRef.current?.getBoundingClientRect().width ?? 0
    const minWidth = 280
    const maxWidth = containerWidth > 0
      ? Math.min(760, Math.max(minWidth, containerWidth - 420))
      : 760

    return Math.max(minWidth, Math.min(Math.round(candidateWidth), maxWidth))
  }, [])

  const effectiveAuxPanelWidth = showAuxPanel ? clampAuxPanelWidth(auxPanelWidth) : auxPanelWidth

  useEffect(() => {
    if (!showAuxPanel || effectiveAuxPanelWidth === auxPanelWidth) {
      return
    }

    onAuxPanelWidthChange(effectiveAuxPanelWidth)
  }, [auxPanelWidth, effectiveAuxPanelWidth, onAuxPanelWidthChange, showAuxPanel])

  useEffect(() => {
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  const handleAuxPanelResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!showAuxPanel) {
      return
    }

    event.preventDefault()

    const startClientX = event.clientX
    const startWidth = effectiveAuxPanelWidth

    setIsResizingAuxPanel(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = startClientX - moveEvent.clientX
      onAuxPanelWidthChange(clampAuxPanelWidth(startWidth + delta))
    }

    const stopResizing = () => {
      setIsResizingAuxPanel(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResizing)
      window.removeEventListener('pointercancel', stopResizing)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResizing)
    window.addEventListener('pointercancel', stopResizing)
  }, [clampAuxPanelWidth, effectiveAuxPanelWidth, onAuxPanelWidthChange, showAuxPanel])

  const workspaceGridStyle = useMemo<CSSProperties | undefined>(() => {
    if (!showAuxPanel) {
      return undefined
    }

    return {
      ['--document-aux-width' as string]: `${effectiveAuxPanelWidth}px`
    } as CSSProperties
  }, [effectiveAuxPanelWidth, showAuxPanel])

  return (
    <section
      className={`workspace-grid${showAuxPanel ? ' workspace-grid-with-aux' : ''}${isResizingAuxPanel ? ' workspace-grid-resizing' : ''}`}
      data-testid="workspace-grid"
      ref={workspaceGridRef}
      style={workspaceGridStyle}
    >
      <article className={`panel preview-panel${isWideMode ? ' preview-panel-wide' : ''}`}>
        <DocumentPreviewHeader {...previewHeaderProps} />

        {selectedDocument ? (
          <>
            {summaryCardProps ? <DocumentSummaryCard {...summaryCardProps} /> : null}
            {outlinePanelProps ? <DocumentOutlinePanel {...outlinePanelProps} /> : null}

              <div className={`preview-section${isWideMode ? ' preview-section-wide' : ''}`}>
                <BlockSearchPanel {...blockSearchPanelProps} />
                <p className="panel-label">{blocksPanelLabel}</p>
               <div className="block-editor-list" onKeyDown={onEditorKeyDown}>
                {selectionToolbarProps ? <BlockSelectionToolbar {...selectionToolbarProps} /> : null}
                {blockEditorRowSharedProps
                  ? visibleEditorRows.map((row) => (
                     <BlockEditorRow
                       key={row.block.id ?? `${selectedDocument.id}-draft-${row.index}`}
                       {...blockEditorRowSharedProps}
                       block={row.block}
                       dropPreview={row.dropPreview}
                       indentPx={row.indentPx}
                       index={row.index}
                       isSelected={row.isSelected}
                       isSearchMatch={row.isSearchMatch}
                       numberLabel={row.numberLabel}
                     />
                  ))
                  : null}
                <button className="secondary-button" onClick={onAddBlock} type="button">
                  {addBlockLabel}
                </button>
                {linkSuggestionPanelProps ? (
                  <LinkSuggestionPanel {...linkSuggestionPanelProps} />
                ) : (
                  <p className="mini-hint">{editorHelpText}</p>
                )}
              </div>
            </div>

            {floatingSlashCommandPanelProps ? <FloatingSlashCommandPanel {...floatingSlashCommandPanelProps} /> : null}

            {documentStatsBarProps ? <DocumentStatsBar {...documentStatsBarProps} /> : null}
          </>
        ) : (
          <div className="empty-preview">
            <p>{emptyDocumentStateText}</p>
          </div>
        )}
      </article>

      {showAuxPanel ? (
        <div
          aria-hidden="true"
          className={`document-aux-resizer${isResizingAuxPanel ? ' document-aux-resizer-active' : ''}`}
          onPointerDown={handleAuxPanelResizeStart}
        >
          <span className="document-aux-resizer-handle" />
        </div>
      ) : null}

      {auxPanelProps ? (
        <aside className="panel document-aux-sidebar">
          <DocumentsAuxPanel
            {...auxPanelProps}
            selectionAiContent={selectionAiContent}
             relationContent={(
               <div className="document-aux-relation-grid">
                 {relationGroups.map((group) => (
                   <RelationList
                    emptyText={group.emptyText}
                    key={group.title}
                    links={group.links}
                    onSelect={auxPanelProps.onOpenDocument}
                    title={group.title}
                  />
                ))}
              </div>
            )}
          />
        </aside>
      ) : null}
    </section>
  )
}