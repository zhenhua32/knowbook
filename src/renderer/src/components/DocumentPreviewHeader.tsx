import { useState, type MouseEvent } from 'react'
import type { UiText } from '../i18n'
import { DocumentHeaderActionMenu } from './DocumentHeaderActionMenu'

type MoveOption = {
  id: string
  label: string
}

type DocumentPreviewHeaderProps = {
  ui: UiText
  isZh: boolean
  selectedDocumentTitle: string | null
  selectedDocumentId: string | null
  isPinned: boolean
  onTogglePin: () => void
  mdCopyFlash: boolean
  onCopyMarkdown: () => void
  onSaveMarkdown: () => void
  onAddChild: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  isSaving: boolean
  onSave: () => void
  onDelete: () => void
  moveTargetId: string
  moveOptions: MoveOption[]
  onMoveTargetChange: (value: string) => void
  onMove: () => void
  documentsAuxPanelOpen: boolean
  onToggleAuxPanel: () => void
  detailLoading: boolean
}

export function DocumentPreviewHeader(props: DocumentPreviewHeaderProps) {
  const {
    ui,
    isZh,
    selectedDocumentTitle,
    selectedDocumentId,
    isPinned,
    onTogglePin,
    mdCopyFlash,
    onCopyMarkdown,
    onSaveMarkdown,
    onAddChild,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    isSaving,
    onSave,
    onDelete,
    moveTargetId,
    moveOptions,
    onMoveTargetChange,
    onMove,
    documentsAuxPanelOpen,
    onToggleAuxPanel,
    detailLoading
  } = props

  const hasDocument = Boolean(selectedDocumentId)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [actionMenuPosition, setActionMenuPosition] = useState({ x: 0, y: 0 })
  const auxButtonLabel = documentsAuxPanelOpen
    ? (isZh ? '收起辅助区' : 'Hide auxiliary')
    : (isZh ? '展开辅助区' : 'Show auxiliary')

  const handleOpenActionMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const menuWidth = 280
    const nextX = Math.min(Math.max(12, rect.right - menuWidth), window.innerWidth - menuWidth - 12)
    setActionMenuPosition({ x: nextX, y: rect.bottom + 8 })
    setActionMenuOpen(true)
  }

  return (
    <div className="panel-head document-header-shell">
      <div className="document-header-main">
        <div className="document-header-meta">
          <p className="panel-label">{ui.documentPreviewLabel}</p>
          <div className="document-header-status">
            {mdCopyFlash ? <span className="autosave-flash autosave-flash-copy">{ui.markdownCopied}</span> : null}
            {detailLoading ? <span className="pill document-header-pill">{ui.common.loading}</span> : null}
          </div>
        </div>
        <div className="document-header-title-row">
          {hasDocument ? (
            <button
              className={`secondary-button pin-button document-header-pin-button${isPinned ? ' pin-button-active' : ''}`}
              onClick={onTogglePin}
              type="button"
              title={isPinned ? ui.unpinDocument : ui.pinDocument}
              aria-label={isPinned ? ui.unpinDocument : ui.pinDocument}
            >
              {isPinned ? '★' : '☆'}
            </button>
          ) : null}
          <h3 className="document-header-title">{selectedDocumentTitle ?? ui.selectDocument}</h3>
        </div>
      </div>
      {hasDocument ? (
        <div className="document-header-actions">
          <button
            className="secondary-button document-header-action document-header-aux-button"
            onClick={onToggleAuxPanel}
            type="button"
            title={auxButtonLabel}
            aria-label={auxButtonLabel}
          >
            {ui.auxiliaryPanelShort}
          </button>
          <button className="secondary-button document-header-action" onClick={onAddChild} type="button">
            {ui.addChild}
          </button>
          <button className="secondary-button document-header-action" disabled={isSaving} onClick={onSave} type="button">
            {isSaving ? ui.common.saving : ui.common.save}
          </button>
          <button className="danger-button document-header-action" onClick={onDelete} type="button">
            {ui.common.delete}
          </button>
          <button
            className="secondary-button document-header-action document-header-more-button"
            onClick={handleOpenActionMenu}
            type="button"
            title={ui.moreActions}
            aria-label={ui.moreActions}
          >
            ⋯
          </button>
        </div>
      ) : null}

      {actionMenuOpen && hasDocument ? (
        <DocumentHeaderActionMenu
          x={actionMenuPosition.x}
          y={actionMenuPosition.y}
          ui={ui}
          isZh={isZh}
          canUndo={canUndo}
          canRedo={canRedo}
          documentsAuxPanelOpen={documentsAuxPanelOpen}
          moveTargetId={moveTargetId}
          moveOptions={moveOptions}
          onClose={() => setActionMenuOpen(false)}
          onCopyMarkdown={onCopyMarkdown}
          onSaveMarkdown={onSaveMarkdown}
          onUndo={onUndo}
          onRedo={onRedo}
          onMoveTargetChange={onMoveTargetChange}
          onMove={onMove}
          onToggleAuxPanel={onToggleAuxPanel}
        />
      ) : null}
    </div>
  )
}
