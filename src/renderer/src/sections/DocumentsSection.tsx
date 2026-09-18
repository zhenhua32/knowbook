import { MarkdownNodes, MarkdownReferencesContext } from '../components/MarkdownContent'
import { MarkdownBlockNodesContext, MarkdownDocumentProvider } from '../components/MarkdownDocumentContext'
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
import { BlockReadingRow } from '../components/BlockReadingRow'
import { DocumentNavigationBar } from '../components/DocumentNavigationBar'
import { useDocumentViewport } from '../hooks/useDocumentViewport'

type VisibleEditorRow = Pick<ComponentProps<typeof BlockEditorRow>, 'block' | 'dropPreview' | 'hasChildren' | 'indentPx' | 'index' | 'isHighlighted' | 'isSelected' | 'numberLabel' | 'isSearchMatch'>
type SharedBlockEditorRowProps = Omit<ComponentProps<typeof BlockEditorRow>, 'block' | 'dropPreview' | 'hasChildren' | 'indentPx' | 'index' | 'isHighlighted' | 'isSelected' | 'numberLabel'>
type RelationGroup = {
  title: string
  emptyText: string
  links: LinkedDocument[]
}

type DocumentsSectionProps = {
  isReadingMode: boolean
  navigationRequest: { index: number; documentId: string; sequence: number; headingIndex?: number } | null
  highlightedBlockId: string | null
  onToggleReadingMode: () => void
  onRevealBlock: (blockId: string) => void
  onOpenBlockSearch: () => void
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
  isReadingMode,
  navigationRequest,
  highlightedBlockId,
  onToggleReadingMode,
  onRevealBlock,
  onOpenBlockSearch,
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
  const documentReady = Boolean(selectedDocument && !previewHeaderProps.detailLoading)
  const auxPanelProps = documentsAuxPanelProps?.isOpen && documentReady ? documentsAuxPanelProps : null
  const showAuxPanel = Boolean(auxPanelProps)
  const viewport = useDocumentViewport({
    documentId: documentReady ? selectedDocument?.id ?? null : null,
    reading: isReadingMode,
    navigation: navigationRequest,
    highlightedBlockId,
    onRevealBlock
  })

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

  const handleAuxPanelResizeKeyDown: KeyboardEventHandler<HTMLDivElement> = useCallback((event) => {
    if (!showAuxPanel) {
      return
    }

    const step = event.shiftKey ? 48 : 16
    let nextWidth: number | null = null

    if (event.key === 'ArrowLeft') {
      nextWidth = effectiveAuxPanelWidth + step
    } else if (event.key === 'ArrowRight') {
      nextWidth = effectiveAuxPanelWidth - step
    } else if (event.key === 'Home') {
      nextWidth = 280
    } else if (event.key === 'End') {
      nextWidth = clampAuxPanelWidth(760)
    }

    if (nextWidth === null) {
      return
    }

    event.preventDefault()
    onAuxPanelWidthChange(clampAuxPanelWidth(nextWidth))
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
      <article
        className={`panel preview-panel${isWideMode ? ' preview-panel-wide' : ''}${isReadingMode ? ' preview-panel-reading' : ''}`}
        data-testid="document-scroll-region"
        ref={viewport.scrollRef}
      >
        <div className="document-sticky-header" ref={viewport.headerRef}>
          <DocumentPreviewHeader {...previewHeaderProps} canUndo={!isReadingMode && previewHeaderProps.canUndo} canRedo={!isReadingMode && previewHeaderProps.canRedo} />
          {documentReady ? <DocumentNavigationBar key={selectedDocument?.id}
            outline={outlinePanelProps} search={blockSearchPanelProps}
            activeIndex={viewport.activeHeadingIndex} progress={viewport.progress}
            reading={isReadingMode} isZh={previewHeaderProps.isZh}
            onOpenSearch={onOpenBlockSearch}
            onToggleReading={() => {
              viewport.capturePosition()
              onToggleReadingMode()
            }} /> : null}
        </div>

        {selectedDocument && documentReady ? (
          <>
            {summaryCardProps && !outlinePanelProps?.focusedHeadingId ? isReadingMode
              ? <div className="document-reading-summary"><h1>{summaryCardProps.title}</h1><p>{summaryCardProps.summary}</p></div>
              : <DocumentSummaryCard {...summaryCardProps} /> : null}

              <div className={`preview-section${isWideMode ? ' preview-section-wide' : ''}`} ref={viewport.contentRef}>
                {!isReadingMode ? <p className="panel-label">{blocksPanelLabel}</p> : null}
               <MarkdownReferencesContext.Provider value={blockEditorRowSharedProps?.markdownReferences}>
               <MarkdownDocumentProvider key={selectedDocument.id} documentId={selectedDocument.id}
                 model={blockEditorRowSharedProps?.markdownDocument} isZh={previewHeaderProps.isZh}
                 containerRef={viewport.contentRef} onRevealBlock={onRevealBlock}>
               <div className="block-editor-list" onKeyDown={onEditorKeyDown}>
                {!isReadingMode && selectionToolbarProps ? <BlockSelectionToolbar {...selectionToolbarProps} /> : null}
                {blockEditorRowSharedProps
                  ? visibleEditorRows.map((row) => (
                     <MarkdownBlockNodesContext.Provider key={row.block.id ?? `${selectedDocument.id}-draft-${row.index}`} value={blockEditorRowSharedProps.markdownDocument?.blockNodes[row.index]}>
                     {isReadingMode ? <BlockReadingRow
                       {...row}
                       collapsed={Boolean(row.block.id && blockEditorRowSharedProps.collapsedBlockIds.has(row.block.id))}
                       onToggleCollapse={blockEditorRowSharedProps.toggleBlockCollapse}
                       onNavigateReference={blockEditorRowSharedProps.navigateInlineReferenceAtCursor}
                       ui={previewHeaderProps.ui}
                       isZh={previewHeaderProps.isZh}
                     /> : <BlockEditorRow
                       {...blockEditorRowSharedProps}
                       block={row.block}
                       dropPreview={row.dropPreview}
                       hasChildren={row.hasChildren}
                       indentPx={row.indentPx}
                        index={row.index}
                        isHighlighted={row.isHighlighted}
                        isSelected={row.isSelected}
                       isSearchMatch={row.isSearchMatch}
                       numberLabel={row.numberLabel}
                     />}
                     </MarkdownBlockNodesContext.Provider>
                  ))
                  : null}
                {blockEditorRowSharedProps?.markdownDocument?.footnotes.length ? <MarkdownNodes nodes={blockEditorRowSharedProps.markdownDocument.footnotes}
                  onReference={(label) => { void blockEditorRowSharedProps.navigateInlineReferenceAtCursor(`[[${label}]]`, 2) }} /> : null}
                {!isReadingMode ? <button className="secondary-button add-block-button" onClick={onAddBlock} type="button">
                  <span aria-hidden="true">＋</span>
                  {addBlockLabel}
                </button> : null}
                {isReadingMode ? null : linkSuggestionPanelProps ? (
                  <LinkSuggestionPanel {...linkSuggestionPanelProps} />
                ) : (
                  <p className="mini-hint">{editorHelpText}</p>
                )}
              </div>
              </MarkdownDocumentProvider>
              </MarkdownReferencesContext.Provider>
            </div>

            {!isReadingMode && floatingSlashCommandPanelProps ? <FloatingSlashCommandPanel {...floatingSlashCommandPanelProps} /> : null}

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
          aria-label={previewHeaderProps.isZh ? '调整辅助区宽度' : 'Resize auxiliary panel'}
          aria-orientation="vertical"
          aria-valuemax={clampAuxPanelWidth(760)}
          aria-valuemin={280}
          aria-valuenow={effectiveAuxPanelWidth}
          className={`document-aux-resizer${isResizingAuxPanel ? ' document-aux-resizer-active' : ''}`}
          onKeyDown={handleAuxPanelResizeKeyDown}
          onPointerDown={handleAuxPanelResizeStart}
          role="separator"
          tabIndex={0}
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
