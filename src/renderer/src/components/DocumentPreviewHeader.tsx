import { useRef, useState, type MouseEvent, type MouseEventHandler, type ReactNode } from 'react'
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
  onCheckLinks?: () => void
  onEditMarkdownSource?: () => void
  onOpenHistory?: () => void
  onOpenAttachments?: () => void
  onAddChild: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  isSaving: boolean
  saveStatus?: 'saved' | 'pending' | 'saving' | 'error'
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
  pluginMenuContent?: ReactNode
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
    onCheckLinks,
    onEditMarkdownSource,
    onAddChild,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    isSaving,
    saveStatus,
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
    detailLoading,
    pluginMenuContent
  } = props

  const hasDocument = Boolean(selectedDocumentId)
  const hasHeaderStatus = mdCopyFlash || detailLoading
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const actionMenuTrigger = useRef<HTMLButtonElement | null>(null)
  const [actionMenuPosition, setActionMenuPosition] = useState({ x: 0, y: 0 })
  const auxButtonLabel = documentsAuxPanelOpen
    ? (isZh ? '收起辅助区' : 'Hide auxiliary')
    : (isZh ? '展开辅助区' : 'Show auxiliary')
  const pinButtonLabel = isPinned ? ui.unpinDocument : ui.pinDocument
  const saveButtonLabel = isSaving ? ui.common.saving : ui.common.save

  const handleOpenActionMenu = (event: MouseEvent<HTMLButtonElement>) => {
    actionMenuTrigger.current = event.currentTarget
    const rect = event.currentTarget.getBoundingClientRect()
    const menuWidth = 280
    const nextX = Math.min(Math.max(12, rect.right - menuWidth), window.innerWidth - menuWidth - 12)
    setActionMenuPosition({ x: nextX, y: rect.bottom + 8 })
    setActionMenuOpen(true)
  }

  return (
    <div className="panel-head document-header-shell">
      <div className="document-header-main">
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
          <span className="document-header-title" title={selectedDocumentTitle ?? ui.selectDocument}>
            {selectedDocumentTitle ?? ui.selectDocument}
          </span>
        </div>
        {hasHeaderStatus || (hasDocument && saveStatus) ? (
          <div className="document-header-status">
            {hasDocument && !detailLoading && saveStatus ? (
              <span className={`document-save-status status-${saveStatus}`} role="status"
                title={saveStatus === 'error' ? (isZh ? '草稿仍在，可点击保存重试或导出 Markdown。' : 'Your draft is available. Retry Save or export Markdown.') : undefined}>
                {saveStatus === 'saving' ? ui.common.saving : saveStatus === 'pending'
                  ? (isZh ? '待保存' : 'Unsaved changes') : saveStatus === 'error'
                    ? (isZh ? '保存失败 · 可重试' : 'Save failed · Retry') : (isZh ? '已保存' : 'Saved')}
              </span>
            ) : null}
            {mdCopyFlash ? <span className="autosave-flash autosave-flash-copy" role="status">{ui.markdownCopied}</span> : null}
            {detailLoading ? <span className="pill document-header-pill" role="status">{ui.common.loading}</span> : null}
          </div>
        ) : null}
      </div>
      {hasDocument ? (
        <div className="document-header-actions">
          {props.onOpenAttachments && <DocumentHeaderIconButton label={isZh ? '图片与附件' : 'Images and attachments'} onClick={props.onOpenAttachments}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2a2 2 0 0 1 3 3L5 16" /></svg>
          </DocumentHeaderIconButton>}
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
          />
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
          pluginMenuContent={pluginMenuContent}
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
          onClose={() => { setActionMenuOpen(false); actionMenuTrigger.current?.focus({ preventScroll: true }) }}
          onCopyMarkdown={onCopyMarkdown}
          onSaveMarkdown={onSaveMarkdown}
          onCheckLinks={onCheckLinks}
          onEditMarkdownSource={onEditMarkdownSource}
          onOpenHistory={props.onOpenHistory}
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
  children?: ReactNode
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
