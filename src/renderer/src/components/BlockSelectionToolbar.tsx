import type { DocumentBlock } from '@shared/contracts'

type BlockSelectionToolbarProps = {
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
    <div className="block-selection-toolbar">
      <div>
        <strong>{summaryLabel}</strong>
        <p className="mini-hint">{hintLabel}</p>
      </div>
      <div className="block-selection-actions">
        <select
          className="editor-select compact-select"
          onChange={(event) => onConversionTypeChange(event.target.value as DocumentBlock['type'])}
          value={selectedBlockConversionType}
        >
          <option value="paragraph">{conversionOptions.paragraph}</option>
          <option value="todo">{conversionOptions.todo}</option>
          <option value="quote">{conversionOptions.quote}</option>
          <option value="bulleted-list">{conversionOptions['bulleted-list']}</option>
          <option value="numbered-list">{conversionOptions['numbered-list']}</option>
        </select>
        <button className="secondary-button" onClick={onConvert} type="button">
          {convertLabel}
        </button>
        <button className="secondary-button" onClick={onCopyBlocks} type="button">
          {copyBlocksLabel}
        </button>
        <button className="secondary-button" onClick={onCopyText} type="button">
          {copyTextLabel}
        </button>
        <button className="secondary-button" onClick={onCut} type="button">
          {cutLabel}
        </button>
        <button className="secondary-button" onClick={onDuplicate} type="button">
          {duplicateLabel}
        </button>
        <button className="secondary-button" onClick={onOpenAiEdit} type="button">
          {aiEditLabel}
        </button>
        <button className="danger-button" onClick={onDelete} type="button">
          {deleteLabel}
        </button>
        <button className="secondary-button" disabled={!canMoveUp} onClick={onMoveUp} type="button">
          {moveUpLabel}
        </button>
        <button className="secondary-button" disabled={!canMoveDown} onClick={onMoveDown} type="button">
          {moveDownLabel}
        </button>
        <button className="secondary-button" onClick={onClear} type="button">
          {clearLabel}
        </button>
      </div>
    </div>
  )
}
