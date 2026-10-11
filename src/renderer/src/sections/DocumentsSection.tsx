import { MarkdownNodes, MarkdownReferencesContext } from '../components/MarkdownContent'
import { MarkdownBlockNodesContext, MarkdownDocumentProvider } from '../components/MarkdownDocumentContext'
import { markdownTaskPatch } from '@shared/markdownTasks'
import { hasAdvancedMarkdown } from '@shared/markdownDocument'
import { documentSummaryText } from '@shared/documentSummary'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ComponentProps, type KeyboardEventHandler, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
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
import { matchingOpeningTitleIndex } from '../utils/documentReadingTitle'
import { openShortcutHelp } from '../openShortcutHelp'
const MarkdownReadingList = lazy(() => import('../components/MarkdownReadingList').then((module) => ({ default: module.MarkdownReadingList })))

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
    <section className={`relation-panel${links.length === 0 ? ' relation-panel-empty' : ''}`}>
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
  floatingSlashCommandPanelProps,
  documentsAuxPanelProps,
  selectionAiContent,
  relationGroups,
  documentStatsBarProps,
  emptyDocumentStateText
}: DocumentsSectionProps) {
  const workspaceGridRef = useRef<HTMLElement | null>(null)
  const stopAuxPanelResizeRef = useRef<(() => void) | null>(null)
  const [workspaceWidth, setWorkspaceWidth] = useState(0)
  const [isResizingAuxPanel, setIsResizingAuxPanel] = useState(false)
  const documentReady = Boolean(selectedDocument && !previewHeaderProps.detailLoading)
  const onToggleMarkdownTask = useCallback((offset: number, checked: boolean) => {
    const target = blockEditorRowSharedProps?.markdownDocument?.taskTargets.get(offset)
    if (!target || !blockEditorRowSharedProps) return
    const patch = markdownTaskPatch(blockEditorRowSharedProps.getDraftBlocks()[target.index], target, checked)
    if (!patch) return
    blockEditorRowSharedProps.checkpointDraft?.()
    blockEditorRowSharedProps.updateDraftBlock(target.index, patch)
  }, [blockEditorRowSharedProps])
  const readingRows = useMemo(() => new Map(visibleEditorRows.map((row) => [row.index, row])), [visibleEditorRows])
  const visibleReadingIndices = useMemo(() => new Set(readingRows.keys()), [readingRows])
  const readingGroups = useMemo(() => {
    const groups = new Map<number, { first: number; node: NonNullable<SharedBlockEditorRowProps['markdownDocument']>['readingLists'][number]['node'] }>()
    for (const group of blockEditorRowSharedProps?.markdownDocument?.readingLists ?? []) {
      const indices = group.indices.filter((index) => readingRows.has(index))
      for (const index of indices) groups.set(index, { first: indices[0], node: group.node })
    }
    return groups
  }, [blockEditorRowSharedProps?.markdownDocument, readingRows])
  const openingTitleIndex = useMemo(() => summaryCardProps ? matchingOpeningTitleIndex(summaryCardProps.title, visibleEditorRows,
    blockEditorRowSharedProps?.markdownDocument) : null, [summaryCardProps?.title, visibleEditorRows, blockEditorRowSharedProps?.markdownDocument])
  const readingSummary = summaryCardProps ? documentSummaryText(summaryCardProps.summary) : ''
  const showReadingMetadata = Boolean(summaryCardProps && !outlinePanelProps?.focusedHeadingId)
  const renderReadingRow = (row: VisibleEditorRow, grouped = false) => blockEditorRowSharedProps && <MarkdownBlockNodesContext.Provider
    key={row.block.id ?? row.index} value={blockEditorRowSharedProps.markdownDocument?.blockNodes[row.index]}>
    <BlockReadingRow {...row} indentPx={grouped ? 0 : row.indentPx}
      collapsed={Boolean(row.block.id && blockEditorRowSharedProps.collapsedBlockIds.has(row.block.id))}
      onToggleCollapse={blockEditorRowSharedProps.toggleBlockCollapse}
      onNavigateReference={blockEditorRowSharedProps.navigateInlineReferenceAtCursor}
      ui={previewHeaderProps.ui} isZh={previewHeaderProps.isZh}
      onToggleTask={(checked) => { blockEditorRowSharedProps.checkpointDraft?.(); blockEditorRowSharedProps.updateDraftBlock(row.index, { checked }) }} />
  </MarkdownBlockNodesContext.Provider>
  const auxPanelProps = documentsAuxPanelProps?.isOpen && documentReady ? documentsAuxPanelProps : null
  const showAuxPanel = Boolean(auxPanelProps)
  const isAuxPanelStacked = showAuxPanel && workspaceWidth > 0 && workspaceWidth < 710
  const viewport = useDocumentViewport({
    documentId: documentReady ? selectedDocument?.id ?? null : null,
    reading: isReadingMode,
    navigation: navigationRequest,
    highlightedBlockId,
    onRevealBlock
  })

  useLayoutEffect(() => {
    const workspace = workspaceGridRef.current
    if (!workspace) return
    const measure = () => {
      const width = workspace.getBoundingClientRect().width
      // Only hand off focus owned by the separator that will disappear.
      // Background resizes and auxiliary inputs keep their current focus.
      if (width > 0 && width < 710 && document.hasFocus()
        && document.activeElement === workspace.querySelector('.document-aux-resizer')) {
        workspace.querySelector<HTMLButtonElement>('.document-header-aux-button')?.focus({ preventScroll: true })
      }
      setWorkspaceWidth(width)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [])

  const clampAuxPanelWidth = useCallback((candidateWidth: number) => {
    const minWidth = 280
    const maxWidth = workspaceWidth > 0
      ? Math.min(760, Math.max(minWidth, workspaceWidth - 430))
      : 760

    return Math.max(minWidth, Math.min(Math.round(candidateWidth), maxWidth))
  }, [workspaceWidth])

  const effectiveAuxPanelWidth = showAuxPanel && !isAuxPanelStacked ? clampAuxPanelWidth(auxPanelWidth) : auxPanelWidth

  // Window and sidebar changes affect the presentation, not the saved width.
  // End an active drag before a resize changes its coordinate system.
  useLayoutEffect(() => {
    stopAuxPanelResizeRef.current?.()
  }, [workspaceWidth, showAuxPanel])

  useEffect(() => {
    return () => {
      stopAuxPanelResizeRef.current?.()
    }
  }, [])

  const handleAuxPanelResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!showAuxPanel || isAuxPanelStacked) {
      return
    }

    event.preventDefault()
    stopAuxPanelResizeRef.current?.()

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
      stopAuxPanelResizeRef.current = null
    }

    stopAuxPanelResizeRef.current = stopResizing
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResizing)
    window.addEventListener('pointercancel', stopResizing)
  }, [clampAuxPanelWidth, effectiveAuxPanelWidth, isAuxPanelStacked, onAuxPanelWidthChange, showAuxPanel])

  const handleAuxPanelResizeKeyDown: KeyboardEventHandler<HTMLDivElement> = useCallback((event) => {
    if (!showAuxPanel || isAuxPanelStacked) {
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
  }, [clampAuxPanelWidth, effectiveAuxPanelWidth, isAuxPanelStacked, onAuxPanelWidthChange, showAuxPanel])

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
      className={`workspace-grid${showAuxPanel ? ' workspace-grid-with-aux' : ''}${isAuxPanelStacked ? ' workspace-grid-stacked-aux' : ''}${isResizingAuxPanel ? ' workspace-grid-resizing' : ''}`}
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
          <DocumentPreviewHeader {...previewHeaderProps}
            onRename={previewHeaderProps.onRename ? opener => {
              const restore = viewport.captureLayoutPosition()
              previewHeaderProps.onRename?.(opener, restore)
            } : undefined} />
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
              ? openingTitleIndex === null ? <div className="document-reading-summary"><h1>{summaryCardProps.title.trim() || 'Untitled'}</h1>{readingSummary ? <p>{readingSummary}</p> : null}</div> : null
              : <DocumentSummaryCard key={selectedDocument.id} {...summaryCardProps}
                compactTitleLabel={openingTitleIndex !== null ? (previewHeaderProps.isZh ? '文档名称' : 'Document name') : undefined} /> : null}

              <div className={`preview-section${isWideMode ? ' preview-section-wide' : ''}`} role="region" aria-label={blocksPanelLabel} ref={viewport.contentRef}>
               <MarkdownReferencesContext.Provider value={blockEditorRowSharedProps?.markdownReferences}>
               <MarkdownDocumentProvider key={selectedDocument.id} documentId={selectedDocument.id}
                 model={blockEditorRowSharedProps?.markdownDocument} isZh={previewHeaderProps.isZh}
                 containerRef={viewport.contentRef} onRevealBlock={onRevealBlock} onToggleTask={onToggleMarkdownTask}>
               <div className="block-editor-list" onKeyDown={onEditorKeyDown}>
                {!isReadingMode && selectionToolbarProps ? <BlockSelectionToolbar {...selectionToolbarProps} /> : null}
                {blockEditorRowSharedProps
                  ? visibleEditorRows.map((row) => {
                     if (isReadingMode) {
                       const group = readingGroups.get(row.index)
                       if (!group) return row.index === openingTitleIndex && showReadingMetadata && readingSummary
                         ? <div key={row.block.id ?? row.index} className="document-reading-opening">
                           {renderReadingRow(row)}
                           <div className="document-reading-summary"><p>{readingSummary}</p></div>
                         </div> : renderReadingRow(row)
                       if (group.first !== row.index) return null
                       return <Suspense key={row.block.id ?? row.index} fallback={renderReadingRow(row)}>
                         <MarkdownReadingList node={group.node} owners={blockEditorRowSharedProps.markdownDocument!.listItemOwners}
                           visible={visibleReadingIndices} renderBlock={(index) => { const item = readingRows.get(index); return item ? renderReadingRow(item, true) : null }} />
                       </Suspense>
                     }
                     const nodes = blockEditorRowSharedProps.markdownDocument?.blockNodes[row.index]
                     // Plain source rows do not render document tokens. Keep
                     // their context stable when another paragraph changes;
                     // tables and advanced previews still receive full tokens.
                     const previewNodes = nodes && (row.block.type === 'table' || hasAdvancedMarkdown(nodes)) ? nodes : undefined
                     return (
                     <MarkdownBlockNodesContext.Provider key={row.block.id ?? `${selectedDocument.id}-draft-${row.index}`} value={previewNodes}>
                     <BlockEditorRow
                       {...blockEditorRowSharedProps}
                       markdownDocument={undefined}
                       block={row.block}
                       dropPreview={row.dropPreview}
                       hasChildren={row.hasChildren}
                       indentPx={row.indentPx}
                        index={row.index}
                        isHighlighted={row.isHighlighted}
                        isSelected={row.isSelected}
                       isSearchMatch={row.isSearchMatch}
                       numberLabel={row.numberLabel}
                     />
                     </MarkdownBlockNodesContext.Provider>
                  )})
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
                  <div className="document-editor-help">
                    <span>{previewHeaderProps.isZh ? '输入 / 插入内容 · [[ 链接文档' : 'Type / to insert · [[ to link a document'}</span>
                    <button type="button" className="document-editor-help-button" aria-keyshortcuts="F1"
                      onClick={() => { void openShortcutHelp() }}>
                      {previewHeaderProps.isZh ? '快捷键帮助' : 'Keyboard shortcuts'} <kbd>F1</kbd>
                    </button>
                  </div>
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

      {showAuxPanel && !isAuxPanelStacked ? (
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
