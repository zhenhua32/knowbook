import type { ComponentProps, KeyboardEventHandler, ReactNode } from 'react'
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
  return (
    <section className="workspace-grid" data-testid="workspace-grid">
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

      {documentsAuxPanelProps?.isOpen && selectedDocument ? (
        <aside className="panel document-aux-sidebar">
          <DocumentsAuxPanel
            {...documentsAuxPanelProps}
            selectionAiContent={selectionAiContent}
             relationContent={(
               <div className="document-aux-relation-grid">
                 {relationGroups.map((group) => (
                   <RelationList
                    emptyText={group.emptyText}
                    key={group.title}
                    links={group.links}
                    onSelect={documentsAuxPanelProps.onOpenDocument}
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