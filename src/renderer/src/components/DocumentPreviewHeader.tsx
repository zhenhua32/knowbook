import { useState, type MouseEvent, type MouseEventHandler, type ReactNode } from 'react'
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
  documentsWideMode: boolean
  onToggleWideMode: () => void
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
    documentsWideMode,
    onToggleWideMode,
    detailLoading
  } = props

  const hasDocument = Boolean(selectedDocumentId)
  const hasHeaderStatus = mdCopyFlash || detailLoading
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [actionMenuPosition, setActionMenuPosition] = useState({ x: 0, y: 0 })
  const auxButtonLabel = documentsAuxPanelOpen
    ? (isZh ? '收起辅助区' : 'Hide auxiliary')
    : (isZh ? '展开辅助区' : 'Show auxiliary')
  const pinButtonLabel = isPinned ? ui.unpinDocument : ui.pinDocument
  const saveButtonLabel = isSaving ? ui.common.saving : ui.common.save

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
        {hasHeaderStatus ? (
          <div className="document-header-status-row">
            <div className="document-header-status">
              {mdCopyFlash ? <span className="autosave-flash autosave-flash-copy">{ui.markdownCopied}</span> : null}
              {detailLoading ? <span className="pill document-header-pill">{ui.common.loading}</span> : null}
            </div>
          </div>
        ) : null}
        <span className="document-header-kicker">{isZh ? '当前文档' : 'Current document'}</span>
        <div className="document-header-title-row">
          {hasDocument ? (
            <DocumentHeaderIconButton
              active={isPinned}
              ariaPressed={isPinned}
              className="document-header-pin-button"
              label={pinButtonLabel}
              onClick={onTogglePin}
            >
              <StarIcon filled={isPinned} />
            </DocumentHeaderIconButton>
          ) : null}
          <h3 className="document-header-title">{selectedDocumentTitle ?? ui.selectDocument}</h3>
        </div>
      </div>
      {hasDocument ? (
        <div className="document-header-actions">
          <DocumentHeaderIconButton
            active={documentsAuxPanelOpen}
            ariaPressed={documentsAuxPanelOpen}
            className="document-header-aux-button"
            label={auxButtonLabel}
            onClick={onToggleAuxPanel}
          >
            <AuxiliaryPanelIcon />
          </DocumentHeaderIconButton>
          <DocumentHeaderIconButton label={ui.addChild} onClick={onAddChild}>
            <AddChildIcon />
          </DocumentHeaderIconButton>
          <DocumentHeaderIconButton
            className="document-header-save-button"
            disabled={isSaving}
            label={saveButtonLabel}
            onClick={onSave}
            showLabel
          >
            <SaveIcon />
          </DocumentHeaderIconButton>
          <DocumentHeaderIconButton
            className="document-header-more-button"
            label={ui.moreActions}
            onClick={handleOpenActionMenu}
          >
            <MoreIcon />
          </DocumentHeaderIconButton>
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
          documentsWideMode={documentsWideMode}
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
          onToggleWideMode={onToggleWideMode}
          onDelete={onDelete}
        />
      ) : null}
    </div>
  )
}

type DocumentHeaderIconButtonProps = {
  active?: boolean
  ariaPressed?: boolean
  children: ReactNode
  className?: string
  danger?: boolean
  disabled?: boolean
  label: string
  onClick: MouseEventHandler<HTMLButtonElement>
  showLabel?: boolean
}

function DocumentHeaderIconButton({
  active = false,
  ariaPressed,
  children,
  className,
  danger = false,
  disabled = false,
  label,
  onClick,
  showLabel = false
}: DocumentHeaderIconButtonProps) {
  return (
    <button
      aria-label={label}
      aria-pressed={ariaPressed}
      className={`icon-btn document-header-icon-button${active ? ' active' : ''}${danger ? ' document-header-icon-button-danger' : ''}${className ? ` ${className}` : ''}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
      {showLabel ? <span className="document-header-button-label">{label}</span> : null}
    </button>
  )
}

function AuxiliaryPanelIcon() {
  return (
    <svg aria-hidden="true" className="document-header-icon-svg" viewBox="0 0 20 20">
      <rect height="12" rx="2.5" width="14" x="3" y="4" />
      <path d="M8 4v12" />
    </svg>
  )
}

function AddChildIcon() {
  return (
    <svg aria-hidden="true" className="document-header-icon-svg" viewBox="0 0 20 20">
      <path d="M10 5v10" />
      <path d="M5 10h10" />
    </svg>
  )
}

function SaveIcon() {
  return (
    <svg aria-hidden="true" className="document-header-icon-svg" viewBox="0 0 20 20">
      <path d="M10 4v8" />
      <path d="M6.5 9.5 10 13l3.5-3.5" />
      <path d="M4 15h12" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg aria-hidden="true" className="document-header-icon-svg document-header-icon-fill" viewBox="0 0 20 20">
      <circle cx="5" cy="10" r="1.5" />
      <circle cx="10" cy="10" r="1.5" />
      <circle cx="15" cy="10" r="1.5" />
    </svg>
  )
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg aria-hidden="true" className={`document-header-icon-svg${filled ? ' document-header-icon-fill' : ''}`} viewBox="0 0 20 20">
      <path d="m10 3 2.1 4.3 4.7.7-3.4 3.3.8 4.7-4.2-2.2-4.2 2.2.8-4.7L3.2 8l4.7-.7Z" />
    </svg>
  )
}
