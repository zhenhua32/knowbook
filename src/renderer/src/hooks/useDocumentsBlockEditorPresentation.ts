import { isOrderedListBlockType } from '@shared/blockTypes'
import { getHeadingLevel } from '@shared/markdownEngine'
import { getMarkdownListNumbers } from '@shared/markdown'
import { parseMarkdownDocumentBlocks } from '@shared/markdownDocument'
import type { MarkdownHeading } from '@shared/markdownAdvanced'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps, Dispatch, SetStateAction } from 'react'
import type { DocumentBlock, DocumentBlockDraft } from '@shared/contracts'
import { getActiveUiText } from '../i18n'
import { isNestableBlock } from '../utils/draftBlockShape'
import { getBlockDropPreview } from '../utils/draftTreePlacement'
import { BlockEditorRow } from '../components/BlockEditorRow'
import { BlockSelectionToolbar } from '../components/BlockSelectionToolbar'
import { DocumentOutlinePanel } from '../components/DocumentOutlinePanel'
import { FloatingSlashCommandPanel } from '../components/FloatingSlashCommandPanel'
import { LinkSuggestionPanel } from '../components/LinkSuggestionPanel'

type VisibleEditorRow = Pick<ComponentProps<typeof BlockEditorRow>, 'block' | 'dropPreview' | 'hasChildren' | 'indentPx' | 'index' | 'isHighlighted' | 'isSelected' | 'numberLabel'>
type SharedBlockEditorRowProps = Omit<ComponentProps<typeof BlockEditorRow>, 'block' | 'dropPreview' | 'hasChildren' | 'indentPx' | 'index' | 'isHighlighted' | 'isSelected' | 'numberLabel'>
type SharedBlockEditorRowBaseProps = Omit<SharedBlockEditorRowProps, 'draftBlockCount' | 'getDraftBlocks' | 'isHighlighted' | 'selectedDocument' | 'setSelectedSlashCommandIndex' | 'handleLinkSuggestionKeyDown'> & {
  setSelectedSlashCommandIndex: Dispatch<SetStateAction<number>>
}
type OutlinePanelProps = ComponentProps<typeof DocumentOutlinePanel>
type SelectionToolbarProps = ComponentProps<typeof BlockSelectionToolbar>
type LinkSuggestionPanelProps = ComponentProps<typeof LinkSuggestionPanel>
type FloatingSlashCommandPanelProps = ComponentProps<typeof FloatingSlashCommandPanel>

type UseDocumentsBlockEditorPresentationParams = SharedBlockEditorRowBaseProps & {
  activeLinkContext: { query: string; start: number } | null
  blockSearchQuery: string
  blockSuggestions: DocumentBlockDraft[]
  canMoveSelectionDown: boolean
  canMoveSelectionUp: boolean
  clearBlockSelection: () => void
  convertSelectedBlocks: (type: DocumentBlock['type']) => void
  copySelectedBlocks: () => void
  copySelectedBlocksAsPlainText: () => void
  cutSelectedBlocks: () => void
  onOpenSelectionAiEditor: () => void
  dragOverBlockDepth: number | null
  dragOverBlockIndex: number | null
  draggingBlockIndex: number | null
  draftBlocks: DocumentBlockDraft[]
  getDraftBlocks: () => DocumentBlockDraft[]
  getVisibleBlockEntries: (blocks: DocumentBlockDraft[]) => Array<{ block: DocumentBlockDraft; index: number }>
  highlightedBlockId: string | null
  insertBlockSuggestion: LinkSuggestionPanelProps['onSelectBlockSuggestion']
  insertLinkSuggestion: LinkSuggestionPanelProps['onSelectLinkSuggestion']
  isBlockSelected: (index: number) => boolean
  linkSuggestions: LinkSuggestionPanelProps['linkSuggestions']
  linkSuggestionContextKey: string | null
  linkSuggestionsLoading: boolean
  linkSuggestionsError: string | null
  retryLinkSuggestions: () => void
  onSelectOutlineBlock: (blockIndex: number) => void
  blockHasChildren: (index: number) => boolean
  focusedHeadingId: string | null
  collapseAllSections: () => void
  expandAllSections: () => void
  focusSection: (index: number) => void
  exitSectionFocus: () => void
  selectedDocument: SharedBlockEditorRowProps['selectedDocument'] | null
  selectedBlockActionCount: number
  selectedBlockConversionType: DocumentBlock['type']
  selectedBlockHasHiddenCollapsedContent: boolean
  selectedBlockInteractionIssue: string | null
  selectedVisibleBlockCount: number
  selectedVisibleSiblingSlice: unknown
  setSelectedBlockConversionType: (type: DocumentBlock['type']) => void
  slashPanelPos: { x: number; y: number } | null
}

export function useDocumentsBlockEditorPresentation({
  blockHasChildren,
  focusedHeadingId,
  collapseAllSections,
  expandAllSections,
  focusSection,
  exitSectionFocus,
  activeBlockIndex,
  activeLinkContext,
  activeSlashCommand,
  activeSlashContext,
  adjustBlockDepth,
  adjustSelectedBlocksDepth,
  applySlashCommand,
  beginBlockDrag,
  blockSearchQuery,
  blockSuggestions,
  blockTextareaRefs,
  BLOCK_INDENT_SIZE,
  canMoveSelectedRange,
  canMoveSelectionDown,
  canMoveSelectionUp,
  captureBlockCursor,
  checkpointDraft,
  collapsedBlockIds,
  clearBlockSelection,
  continueBlockAt,
  convertSelectedBlocks,
  copySelectedBlocks,
  copySelectedBlocksAsPlainText,
  cutSelectedBlocks,
  onOpenSelectionAiEditor,
  deleteSelectedBlocks,
  dismissSlashCommand,
  draftBlocks,
  getDraftBlocks,
  dragOverBlockDepth,
  dragOverBlockIndex,
  draggingBlockIndex,
  downgradeBlockAt,
  dropBlockAt,
  duplicateDraftBlock,
  duplicateSelectedBlocks,
  endBlockDrag,
  endBlockRangeSelection,
  filteredSlashCommands,
  getDraggedBlockDepthPreview,
  getMultiBlockOperationRange,
  getVisibleBlockCountInRange,
  getVisibleBlockEntries,
  handleBlockContentChange,
  highlightedBlockId,
  handleBlockMouseEnter,
  handleBlockPaste,
  insertDraftBlockAt,
  insertBlockSuggestion,
  insertLinkSuggestion,
  isBlockRangeSelecting,
  isBlockSelected,
  isSelectionCoherent,
  isZh,
  linkSuggestions,
  linkSuggestionContextKey,
  linkSuggestionsLoading,
  linkSuggestionsError,
  retryLinkSuggestions,
  mergeWithPreviousBlock,
  moveDraftBlockBySibling,
  moveSelectedBlocks,
  navigateInlineReferenceAtCursor,
  notifyBlockMouseDown,
  onSelectOutlineBlock,
  removeSelectedBlockRange,
  selectAllBlocks,
  selectBlockRange,
  selectedBlockActionCount,
  selectedBlockCount,
  selectedBlockConversionType,
  selectedBlockHasHiddenCollapsedContent,
  selectedBlockInteractionIssue,
  selectedBlockRange,
  selectedDocument,
  selectedVisibleBlockCount,
  selectedVisibleSiblingSlice,
  setDragOverBlockDepth,
  setDragOverBlockIndex,
  setSelectedBlockConversionType,
  setSelectedSlashCommandIndex,
  slashPanelPos,
  splitDraftBlock,
  toggleBlockCollapse,
  ui,
  updateBlockHighlight,
  updateDraftBlock
}: UseDocumentsBlockEditorPresentationParams) {
  const [selectedLinkSuggestionKey, setSelectedLinkSuggestionKey] = useState<string | null>(null)
  const [dismissedLinkContextKey, setDismissedLinkContextKey] = useState<string | null>(null)
  const linkContextKey = linkSuggestionContextKey
  useEffect(() => {
    setSelectedLinkSuggestionKey(null)
    setDismissedLinkContextKey(null)
  }, [linkContextKey])
  const linkCandidates = [
    ...blockSuggestions.filter((block) => block.id).map((block) => ({ key: `block-${block.id}`, select: () => insertBlockSuggestion(block) })),
    ...linkSuggestions.map((suggestion) => ({ key: `document-${suggestion.id}`, select: () => insertLinkSuggestion(suggestion) })),
    ...(linkSuggestionsError ? [{ key: 'retry', select: retryLinkSuggestions }] : [])
  ]
  const activeLinkCandidate = linkCandidates.find((candidate) => candidate.key === selectedLinkSuggestionKey) ?? linkCandidates[0]
  const selectLinkCandidate = (select: () => void) => { checkpointDraft?.(); select() }
  const handleLinkSuggestionKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!activeLinkContext || dismissedLinkContextKey === linkContextKey || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      setDismissedLinkContextKey(linkContextKey)
      return true
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation()
      if (linkCandidates.length) {
        const currentIndex = linkCandidates.indexOf(activeLinkCandidate)
        setSelectedLinkSuggestionKey(linkCandidates[(currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + linkCandidates.length) % linkCandidates.length].key)
      }
      return true
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && activeLinkCandidate) {
      event.preventDefault(); event.stopPropagation()
      if (activeLinkCandidate.key === 'retry') activeLinkCandidate.select()
      else selectLinkCandidate(activeLinkCandidate.select)
      return true
    }
    return false
  }
  const markdownDocument = useMemo(() => parseMarkdownDocumentBlocks(draftBlocks, selectedDocument?.title), [draftBlocks, selectedDocument?.title])
  const markdownReferences = markdownDocument.environment.references
  const visibleEditorRows = useMemo<VisibleEditorRow[]>(() => {
    if (!selectedDocument) {
      return []
    }

    const numbers = getMarkdownListNumbers(draftBlocks)

    return getVisibleBlockEntries(draftBlocks).map(({ block, index }) => {
      const dropPreview =
        draggingBlockIndex !== null && dragOverBlockIndex === index
          ? getBlockDropPreview(draftBlocks, draggingBlockIndex, index, dragOverBlockDepth)
          : null
      const isSelected = isBlockSelected(index)
      const isHighlighted = Boolean(block.id) && block.id === highlightedBlockId
      const indentPx = isNestableBlock(block.type) ? block.depth * BLOCK_INDENT_SIZE : 0

      const numberLabel = isOrderedListBlockType(block.type) ? `${numbers[index]}.` : ''

      return {
        block,
        dropPreview,
        hasChildren: blockHasChildren(index),
        indentPx,
        index,
        isSelected,
        isHighlighted,
        isSearchMatch: blockSearchQuery.trim().length > 0 && (
          block.content.toLocaleLowerCase().includes(blockSearchQuery.trim().toLocaleLowerCase()) ||
          block.type.toLocaleLowerCase().includes(blockSearchQuery.trim().toLocaleLowerCase())
        ),
        numberLabel
      }
    })
  }, [
    BLOCK_INDENT_SIZE,
    blockHasChildren,
    dragOverBlockDepth,
    dragOverBlockIndex,
    draggingBlockIndex,
    draftBlocks,
    getBlockDropPreview,
    getVisibleBlockEntries,
    blockSearchQuery,
    isBlockSelected,
    highlightedBlockId,
    isNestableBlock,
    selectedDocument
  ])

  const outlineItems = useMemo<OutlinePanelProps['items']>(() => {
    return draftBlocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => getHeadingLevel(block.type))
      .map(({ block, index }) => ({
        id: block.id,
        index,
        collapsed: Boolean(block.id && collapsedBlockIds.has(block.id)),
        hasChildren: blockHasChildren(index),
        level: getHeadingLevel(block.type)!,
        title: (markdownDocument.blockNodes[index]?.find((node) => node.token.type === 'heading_open')?.token.meta?.heading as MarkdownHeading | undefined)?.text ?? block.content
      }))
  }, [draftBlocks, collapsedBlockIds, blockHasChildren, markdownDocument])

  const outlinePanelProps: OutlinePanelProps | null = selectedDocument
    ? {
        isZh,
        focusedHeadingId,
        onToggleFold: (index) => { const id = draftBlocks[index]?.id; if (id) toggleBlockCollapse(id) },
        onCollapseAll: collapseAllSections,
        onExpandAll: expandAllSections,
        onFocusSection: focusSection,
        onExitFocus: exitSectionFocus,
        emptyHeadingTitleLevel1: isZh ? '标题 1' : 'Heading 1',
        emptyHeadingTitleLevel2: isZh ? '标题 2' : 'Heading 2',
        filterPlaceholder: isZh ? '筛选章节…' : 'Filter headings…',
        noMatchText: isZh ? '没有匹配的章节' : 'No matching headings',
        items: outlineItems,
        onSelect: onSelectOutlineBlock,
        title: isZh ? '大纲' : 'Outline'
      }
    : null

  const selectionToolbarProps: SelectionToolbarProps | null = selectedBlockRange
    ? {
        canMoveDown: canMoveSelectionDown,
        canMoveUp: canMoveSelectionUp,
        clearLabel: ui.clear,
         conversionOptions: {
           paragraph: getBlockConversionLabel('paragraph'),
           todo: getBlockConversionLabel('todo'),
           'numbered-todo': getBlockConversionLabel('numbered-todo'),
           quote: getBlockConversionLabel('quote'),
           'bulleted-list': getBlockConversionLabel('bulleted-list'),
           'numbered-list': getBlockConversionLabel('numbered-list'),
           table: getBlockConversionLabel('table')
         },
        convertLabel: ui.convert,
        copyBlocksLabel: ui.copyBlocks,
        copyTextLabel: ui.copyText,
        cutLabel: ui.cut,
        deleteLabel: ui.common.delete,
        duplicateLabel: ui.duplicate,
        aiEditLabel: ui.aiEditSelection,
        hasCrossParent: selectedBlockCount > 1 && !selectedBlockInteractionIssue && !selectedVisibleSiblingSlice,
        hasHiddenCollapsedContent: selectedBlockHasHiddenCollapsedContent,
        hintLabel: ui.blockSelectionHint({
          start: selectedBlockRange.start,
          end: selectedBlockRange.end,
          actionCount: selectedBlockActionCount,
          selectedCount: selectedBlockCount,
          incoherent: !isSelectionCoherent(selectedBlockRange),
          hasHiddenCollapsedContent: selectedBlockHasHiddenCollapsedContent,
          selectedBlockInteractionIssue: selectedBlockCount > 1 ? selectedBlockInteractionIssue : null
        }),
        interactionIssue: selectedBlockInteractionIssue,
        isIncoherent: !isSelectionCoherent(selectedBlockRange),
        moveDownLabel: ui.moveDown,
        moveUpLabel: ui.moveUp,
        onClear: clearBlockSelection,
        onConvert: () => convertSelectedBlocks(selectedBlockConversionType),
        onConversionTypeChange: setSelectedBlockConversionType,
        onCopyBlocks: copySelectedBlocks,
        onCopyText: copySelectedBlocksAsPlainText,
        onCut: cutSelectedBlocks,
        onDelete: deleteSelectedBlocks,
        onDuplicate: duplicateSelectedBlocks,
        onOpenAiEdit: onOpenSelectionAiEditor,
        onMoveDown: () => moveSelectedBlocks(1),
        onMoveUp: () => moveSelectedBlocks(-1),
        rangeEnd: selectedBlockRange.end,
        rangeStart: selectedBlockRange.start,
        selectedBlockActionCount,
        selectedBlockConversionType,
        selectedBlockCount,
        selectedVisibleBlockCount,
        summaryLabel: ui.blockSelectionSummary({
          visibleCount: selectedVisibleBlockCount,
          selectedCount: selectedBlockCount,
          actionCount: selectedBlockActionCount,
          incoherent: !isSelectionCoherent(selectedBlockRange),
          hasHiddenCollapsedContent: selectedBlockHasHiddenCollapsedContent,
          selectedBlockInteractionIssue,
          hasCrossParent: selectedBlockCount > 1 && !selectedBlockInteractionIssue && !selectedVisibleSiblingSlice
        })
      }
    : null

  const linkSuggestionPanelProps: LinkSuggestionPanelProps | null = activeLinkContext && linkContextKey && dismissedLinkContextKey !== linkContextKey
    ? {
        blockSuggestions,
        blocksLabel: ui.blocksInDocument,
        linkedDocsLabel: ui.linkedDocuments,
        titleLabel: ui.linkSuggestionsLabel,
        linkSuggestions,
        linkSuggestionsLoading,
        linkSuggestionsError,
        loadingLabel: ui.linkSuggestionsLoading,
        retryLabel: ui.retryLinkSuggestions,
        onRetry: retryLinkSuggestions,
        noMatchingLabel: ui.noMatchingSuggestions,
        onSelectBlockSuggestion: (block) => selectLinkCandidate(() => insertBlockSuggestion(block)),
        onSelectLinkSuggestion: (suggestion) => selectLinkCandidate(() => insertLinkSuggestion(suggestion)),
        activeSuggestionKey: activeLinkCandidate?.key,
        onHoverSuggestion: setSelectedLinkSuggestionKey,
        query: activeLinkContext.query,
        queryLabel: ui.linkQuery
      }
    : null

  const floatingSlashCommandPanelProps: FloatingSlashCommandPanelProps | null = activeSlashContext && slashPanelPos
    ? {
        activeCommandId: activeSlashCommand?.id,
        commands: filteredSlashCommands.map((command) => ({
          id: command.id,
          label: command.label,
          description: command.description
        })),
        noMatchingLabel: ui.noMatchingCommands,
        onHoverCommand: setSelectedSlashCommandIndex,
        onSelectCommand: (command) => {
          const fullCommand = filteredSlashCommands.find((candidate) => candidate.id === command.id)
          if (fullCommand) {
            applySlashCommand(fullCommand)
          }
        },
        query: activeSlashContext.query,
        x: slashPanelPos.x,
        y: slashPanelPos.y
      }
    : null

  const rowActions = useStableCallbackProps({
    adjustBlockDepth,
    adjustSelectedBlocksDepth,
    applySlashCommand,
    beginBlockDrag,
    canMoveSelectedRange,
    captureBlockCursor,
    checkpointDraft: checkpointDraft ?? (() => {}),
    continueBlockAt,
    deleteSelectedBlocks,
    dismissSlashCommand,
    downgradeBlockAt,
    dropBlockAt,
    duplicateDraftBlock,
    duplicateSelectedBlocks,
    endBlockDrag,
    endBlockRangeSelection,
    getDraggedBlockDepthPreview,
    getMultiBlockOperationRange,
    getVisibleBlockCountInRange,
    handleBlockContentChange,
    handleLinkSuggestionKeyDown,
    handleBlockMouseEnter,
    handleBlockPaste,
    insertDraftBlockAt,
    isSelectionCoherent,
    mergeWithPreviousBlock,
    moveDraftBlockBySibling,
    moveSelectedBlocks,
    navigateInlineReferenceAtCursor,
    notifyBlockMouseDown,
    onOpenSelectionAiEditor,
    removeSelectedBlockRange,
    selectAllBlocks,
    selectBlockRange,
    setDragOverBlockDepth,
    setDragOverBlockIndex,
    setSelectedSlashCommandIndex,
    splitDraftBlock,
    toggleBlockCollapse,
    updateBlockHighlight,
    updateDraftBlock
  })

  const blockEditorRowSharedProps: SharedBlockEditorRowProps | null = selectedDocument
    ? {
        ...rowActions,
        markdownReferences,
        markdownDocument,
        activeBlockIndex,
        activeSlashCommand,
        activeSlashContext,
        blockTextareaRefs,
        BLOCK_INDENT_SIZE,
        collapsedBlockIds,
        draftBlockCount: draftBlocks.length,
        filteredSlashCommands,
        getDraftBlocks,
        isBlockRangeSelecting,
        isZh,
        selectedBlockCount,
        selectedBlockRange,
        selectedDocument,
        ui
      }
    : null

  return {
    blockEditorRowSharedProps,
    floatingSlashCommandPanelProps,
    linkSuggestionPanelProps,
    outlinePanelProps,
    selectionToolbarProps,
    visibleEditorRows
  }
}

function useStableCallbackProps<T extends Record<string, (...args: any[]) => any>>(callbacks: T): T {
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  return useMemo(() => Object.fromEntries(
    Object.keys(callbacks).map((key) => [
      key,
      (...args: any[]) => callbacksRef.current[key](...args)
    ])
  ) as T, [])
}

function getBlockConversionLabel(type: DocumentBlock['type']): string {
  return getActiveUiText().conversionOptions[type] ?? type
}
