import type { DocumentBlock } from '@shared/contracts'
import { BLOCK_CONVERSION_TYPES } from '../utils/blockConversionTypes'

type BlockSelectionToolbarProps = {
  disabled?: boolean
  onWrapInColumns?: () => void
  wrapInColumnsLabel?: string
  onCopyBlockLinks?: () => void
  onMoveToDocument?: () => void
  copyBlockLinksLabel?: string
  moveToDocumentLabel?: string
  moveDisabledReason?: string | null
  selectedBlockCount: number
  selectedVisibleBlockCount: number
  selectedBlockActionCount: number
  isIncoherent: boolean
  hasHiddenCollapsedContent: boolean
  interactionIssue: string | null
  hasCrossParent: boolean
  selectedBlockConversionType: DocumentBlock['type']
  canMoveUp: boolean
  canMoveDown: boolean
  summaryLabel: string
  hintLabel: string
  convertLabel: string
  copyBlocksLabel: string
  copyTextLabel: string
  cutLabel: string
  duplicateLabel: string
  aiEditLabel: string
  deleteLabel: string
  moveUpLabel: string
  moveDownLabel: string
  clearLabel: string
  onConversionTypeChange: (type: DocumentBlock['type']) => void
  onConvert: () => void
  onCopyBlocks: () => void
  onCopyText: () => void
  onCut: () => void
  onDuplicate: () => void
  onOpenAiEdit: () => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onClear: () => void
  conversionOptions: Record<string, string>
  rangeStart: number
  rangeEnd: number
}

export function BlockSelectionToolbar(props: BlockSelectionToolbarProps) {
  const {
    disabled = false,
    onCopyBlockLinks,
    onMoveToDocument,
    copyBlockLinksLabel,
    moveToDocumentLabel,
    moveDisabledReason,
    selectedBlockCount,
    selectedVisibleBlockCount,
    selectedBlockActionCount,
    isIncoherent,
    hasHiddenCollapsedContent,
    interactionIssue,
    hasCrossParent,
    selectedBlockConversionType,
    canMoveUp,
    canMoveDown,
    summaryLabel,
    hintLabel,
    convertLabel,
    copyBlocksLabel,
    copyTextLabel,
    cutLabel,
    duplicateLabel,
    aiEditLabel,
    deleteLabel,
    moveUpLabel,
    moveDownLabel,
    clearLabel,
    onConversionTypeChange,
    onConvert,
    onCopyBlocks,
    onCopyText,
    onCut,
    onDuplicate,
    onOpenAiEdit,
    onDelete,
    onMoveUp,
    onMoveDown,
    onClear,
    conversionOptions,
    rangeStart,
    rangeEnd
  } = props

  return (
    <div className="block-selection-toolbar" aria-busy={disabled}>
      <div>
        <strong>{summaryLabel}</strong>
        <p className="mini-hint">{hintLabel}</p>
        {moveDisabledReason ? <p className="mini-hint" role="status">{moveDisabledReason}</p> : null}
      </div>
      <div className="block-selection-actions">
        {props.onWrapInColumns ? <button className="secondary-button" disabled={disabled} type="button" onClick={props.onWrapInColumns}>{props.wrapInColumnsLabel}</button> : null}
        <select
          className="editor-select compact-select" disabled={disabled} aria-label={convertLabel}
          onChange={(event) => onConversionTypeChange(event.target.value as DocumentBlock['type'])}
          value={selectedBlockConversionType}
        >
          {BLOCK_CONVERSION_TYPES.map(type => <option key={type} value={type}>{conversionOptions[type] ?? type}</option>)}
        </select>
        <button className="secondary-button" disabled={disabled} onClick={onConvert} type="button">
          {convertLabel}
        </button>
        <button className="secondary-button" disabled={disabled} onClick={onCopyBlocks} type="button">
          {copyBlocksLabel}
        </button>
        {onCopyBlockLinks ? <button className="secondary-button" disabled={disabled} onClick={onCopyBlockLinks} type="button">
          {copyBlockLinksLabel}
        </button> : null}
        {onMoveToDocument ? <button className="secondary-button" disabled={disabled || Boolean(moveDisabledReason)} title={moveDisabledReason ?? undefined} onClick={onMoveToDocument} type="button">
          {moveToDocumentLabel}
        </button> : null}
        <button className="secondary-button" disabled={disabled} onClick={onCopyText} type="button">
          {copyTextLabel}
        </button>
        <button className="secondary-button" disabled={disabled} onClick={onCut} type="button">
          {cutLabel}
        </button>
        <button className="secondary-button" disabled={disabled} onClick={onDuplicate} type="button">
          {duplicateLabel}
        </button>
        <button className="secondary-button" disabled={disabled} onClick={onOpenAiEdit} type="button">
          {aiEditLabel}
        </button>
        <button className="danger-button" disabled={disabled} onClick={onDelete} type="button">
          {deleteLabel}
        </button>
        <button className="secondary-button" disabled={disabled || !canMoveUp} onClick={onMoveUp} type="button">
          {moveUpLabel}
        </button>
        <button className="secondary-button" disabled={disabled || !canMoveDown} onClick={onMoveDown} type="button">
          {moveDownLabel}
        </button>
        <button className="secondary-button" disabled={disabled} onClick={onClear} type="button">
          {clearLabel}
        </button>
      </div>
    </div>
  )
}
