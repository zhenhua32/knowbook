import { Suspense, useState, type ReactNode } from 'react'
import { lazyWithRetry as lazy } from '../utils/lazyWithRetry'
import { RecoveryState } from '../components/RecoveryState'
import { areDocumentDraftBlocksEqual } from '../utils/documentDraftComparison'
import '../document-experience.css'
import type { ClipWebPageInput, DocumentBlockDraft, HomeData } from '@shared/contracts'
import type { UiText } from '../i18n'
import { DocumentSelectionAiPanel } from '../components/DocumentSelectionAiPanel'
import { useDocumentSelectionAiState } from '../hooks/useDocumentSelectionAiState'
import { useDocumentsBlockEditorPresentation } from '../hooks/useDocumentsBlockEditorPresentation'
import { MarkdownNavigationContext } from '../components/MarkdownNavigationContext'
import { useDocumentsDetailPresentation } from '../hooks/useDocumentsDetailPresentation'
import type { AiDomainState, DocumentsDomainState, PluginsDomainState } from '../types/appDomains'
import { DocumentsSection } from '../sections/DocumentsSection'

const BLOCK_INDENT_SIZE = 24
const DocumentLinkCheckDialog = lazy(() => import('../components/DocumentLinkCheckDialog'))
const DocumentMarkdownSourceDialog = lazy(() => import('../components/DocumentMarkdownSourceDialog'))

type DocumentsPageProps = {
  ai: AiDomainState
  aiConfig: HomeData['aiConfig']
  documentTree: HomeData['documentTree']
  documents: DocumentsDomainState
  isZh: boolean
  onClipWebPage: (input: ClipWebPageInput) => Promise<unknown> | void
  onCreateDocument: (parentId: string | null) => Promise<unknown> | void
  onDeleteSelectedDocument: () => Promise<unknown> | void
  onMoveSelectedDocument: () => Promise<unknown> | void
  plugins: PluginsDomainState
  pluginMenuContent?: ReactNode
  ui: UiText
}

export function DocumentsPage({
  ai,
  aiConfig,
  documentTree,
  documents,
  isZh,
  onClipWebPage,
  onCreateDocument,
  onDeleteSelectedDocument,
  onMoveSelectedDocument,
  plugins,
  pluginMenuContent,
  ui
}: DocumentsPageProps) {
  const [webClipBusy, setWebClipBusy] = useState(false)
  const [webClipUrlDraft, setWebClipUrlDraft] = useState('')
  const [linkCheckDocumentId, setLinkCheckDocumentId] = useState<string | null>(null)
  const [sourceEditor, setSourceEditor] = useState<{ documentId: string; blocks: DocumentBlockDraft[] } | null>(null)

  const selectionAi = useDocumentSelectionAiState({
    aiEnabled: aiConfig.enabled,
    documentsAuxPanelOpen: documents.documentsAuxPanelOpen,
    draftBlocks: documents.draftBlocks,
    draftSummary: documents.draftSummary,
    draftTitle: documents.draftTitle,
    getMultiBlockOperationRange: documents.getMultiBlockOperationRange,
    handleBlockPaste: documents.handleBlockPaste,
    hasApiKey: aiConfig.hasApiKey,
    onOpenAuxPanel: documents.toggleDocumentsAuxPanel,
    selectedBlockRange: documents.selectedBlockRange,
    selectedDocument: documents.selectedDocument,
    ui
  })

  const handleClipWebPage = async () => {
    if (!documents.selectedDocument || !webClipUrlDraft.trim() || webClipBusy) {
      return
    }

    setWebClipBusy(true)
    try {
      await onClipWebPage({
        url: webClipUrlDraft,
        parentId: documents.selectedDocument.id
      })
      setWebClipUrlDraft('')
    } finally {
      setWebClipBusy(false)
    }
  }

  const {
    blockEditorRowSharedProps,
    floatingSlashCommandPanelProps,
    linkSuggestionPanelProps,
    outlinePanelProps,
    selectionToolbarProps,
    visibleEditorRows
  } = useDocumentsBlockEditorPresentation({
    blockHasChildren: documents.blockHasChildren,
    focusedHeadingId: documents.focusedHeadingId,
    collapseAllSections: documents.collapseAllSections,
    expandAllSections: documents.expandAllSections,
    focusSection: documents.focusSection,
    exitSectionFocus: documents.exitSectionFocus,
    activeBlockIndex: documents.activeBlockIndex,
    activeLinkContext: documents.activeLinkContext,
    activeSlashCommand: documents.activeSlashCommand,
    activeSlashContext: documents.activeSlashContext,
    adjustBlockDepth: documents.adjustBlockDepth,
    adjustSelectedBlocksDepth: documents.adjustSelectedBlocksDepth,
    applySlashCommand: documents.applySlashCommand,
    beginBlockDrag: documents.beginBlockDrag,
    blockSearchQuery: documents.blockSearchQuery,
    blockSuggestions: documents.blockSuggestions,
    blockTextareaRefs: documents.blockTextareaRefs,
    BLOCK_INDENT_SIZE,
    canMoveSelectedRange: documents.canMoveSelectedRange,
    canMoveSelectionDown: documents.canMoveSelectionDown,
    canMoveSelectionUp: documents.canMoveSelectionUp,
    captureBlockCursor: documents.captureBlockCursor,
    checkpointDraft: documents.checkpointDraft,
    collapsedBlockIds: documents.collapsedBlockIds,
    clearBlockSelection: documents.clearBlockSelection,
    continueBlockAt: documents.continueBlockAt,
    convertSelectedBlocks: documents.convertSelectedBlocks,
    copySelectedBlocks: documents.copySelectedBlocks,
    copySelectedBlocksAsPlainText: documents.copySelectedBlocksAsPlainText,
    cutSelectedBlocks: documents.cutSelectedBlocks,
    onOpenSelectionAiEditor: selectionAi.openSelectionAiEditor,
    deleteSelectedBlocks: documents.deleteSelectedBlocks,
    dismissSlashCommand: documents.dismissSlashCommand,
    draftBlocks: documents.draftBlocks,
    dragOverBlockDepth: documents.dragOverBlockDepth,
    dragOverBlockIndex: documents.dragOverBlockIndex,
    draggingBlockIndex: documents.draggingBlockIndex,
    downgradeBlockAt: documents.downgradeBlockAt,
    dropBlockAt: documents.dropBlockAt,
    duplicateDraftBlock: documents.duplicateDraftBlock,
    duplicateSelectedBlocks: documents.duplicateSelectedBlocks,
    endBlockDrag: documents.endBlockDrag,
    endBlockRangeSelection: documents.endBlockRangeSelection,
    filteredSlashCommands: documents.filteredSlashCommands,
    getDraggedBlockDepthPreview: documents.getDraggedBlockDepthPreview,
    getMultiBlockOperationRange: documents.getMultiBlockOperationRange,
    getDraftBlocks: documents.getDraftBlocks,
    getVisibleBlockEntries: documents.getVisibleBlockEntries,
    highlightedBlockId: documents.highlightedBlockId,
    getVisibleBlockCountInRange: documents.getVisibleBlockCountInRange,
    handleBlockContentChange: documents.handleBlockContentChange,
    handleBlockMouseEnter: documents.handleBlockMouseEnter,
    handleBlockPaste: documents.handleBlockPaste,
    insertDraftBlockAt: documents.insertDraftBlockAt,
    insertBlockSuggestion: documents.insertBlockSuggestion,
    insertLinkSuggestion: documents.insertLinkSuggestion,
    isBlockRangeSelecting: documents.isBlockRangeSelecting,
    isBlockSelected: documents.isBlockSelected,
    isSelectionCoherent: documents.isSelectionCoherent,
    isZh,
    linkSuggestions: documents.linkSuggestions,
    mergeWithPreviousBlock: documents.mergeWithPreviousBlock,
    moveDraftBlockBySibling: documents.moveDraftBlockBySibling,
    moveSelectedBlocks: documents.moveSelectedBlocks,
    navigateInlineReferenceAtCursor: documents.navigateInlineReferenceAtCursor,
    notifyBlockMouseDown: documents.notifyBlockMouseDown,
    onSelectOutlineBlock: documents.navigateToBlock,
    removeSelectedBlockRange: documents.removeSelectedBlockRange,
    selectAllBlocks: documents.selectAllBlocks,
    selectBlockRange: documents.selectBlockRange,
    selectedBlockActionCount: documents.selectedBlockActionCount,
    selectedBlockCount: documents.selectedBlockCount,
    selectedBlockConversionType: documents.selectedBlockConversionType,
    selectedBlockHasHiddenCollapsedContent: documents.selectedBlockHasHiddenCollapsedContent,
    selectedBlockInteractionIssue: documents.selectedBlockInteractionIssue,
    selectedBlockRange: documents.selectedBlockRange,
    selectedDocument: documents.selectedDocument,
    selectedVisibleBlockCount: documents.selectedVisibleBlockCount,
    selectedVisibleSiblingSlice: documents.selectedVisibleSiblingSlice,
    setDragOverBlockDepth: documents.setDragOverBlockDepth,
    setDragOverBlockIndex: documents.setDragOverBlockIndex,
    setSelectedBlockConversionType: documents.setSelectedBlockConversionType,
    setSelectedSlashCommandIndex: documents.setSelectedSlashCommandIndex,
    slashPanelPos: documents.slashPanelPos,
    splitDraftBlock: documents.splitDraftBlock,
    toggleBlockCollapse: documents.toggleBlockCollapse,
    ui,
    updateBlockHighlight: documents.updateBlockHighlight,
    updateDraftBlock: documents.updateDraftBlock
  })

  const {
    auxPanelProps,
    previewHeaderProps,
    relationGroups,
    statsBarProps,
    summaryCardProps
  } = useDocumentsDetailPresentation({
    aiAnswer: ai.aiAnswer,
    aiAsking: ai.aiAsking,
    aiAutomationsRunning: ai.aiAutomationsRunning,
    aiContextError: ai.aiContextError,
    aiContextResults: ai.aiContextResults,
    aiContextSearching: ai.aiContextSearching,
    aiEnabled: aiConfig.enabled,
    aiPromptDraft: ai.aiPromptDraft,
    canRedo: documents.canRedo,
    canUndo: documents.canUndo,
    detailLoading: documents.detailLoading,
    documentTree,
    documentsAuxPanelOpen: documents.documentsAuxPanelOpen,
    documentsWideMode: documents.documentsWideMode,
    draftBlocks: documents.draftBlocks,
    draftSummary: documents.draftSummary,
    draftTitle: documents.draftTitle,
    hasApiKey: aiConfig.hasApiKey,
    isZh,
    isSaving: documents.isSaving,
    saveStatus: documents.saveStatus,
    mdCopyFlash: documents.mdCopyFlash,
    moveTargetId: documents.moveTargetId,
    onClipWebPage: () => {
      void handleClipWebPage()
    },
    onAddChild: () => {
      if (documents.selectedDocument) {
        void onCreateDocument(documents.selectedDocument.id)
      }
    },
    onAiPromptChange: ai.setAiPromptDraft,
    onAskAi: () => {
      void ai.askAiOnSelectedDocument()
    },
    onCopyMarkdown: () => {
      void documents.copyDocumentAsMarkdown()
    },
    onDelete: () => {
      void onDeleteSelectedDocument()
    },
    onFindRelatedNotes: () => {
      void ai.findRelatedNotesForPrompt()
    },
    onMove: () => {
      void onMoveSelectedDocument()
    },
    onMoveTargetChange: documents.setMoveTargetId,
    onOpenDocument: documents.openDocumentInDocumentsPage,
    onRedo: documents.redoEdit,
    onRunEnabledAutomations: () => {
      void ai.runEnabledAiAutomationsOnSelectedDocument()
    },
    onRunPluginAction: (action) => {
      void plugins.runPluginDocumentAction(action)
    },
    onSave: () => {
      void documents.saveDocument()
    },
    onSaveMarkdown: () => {
      void documents.saveDocumentAsMarkdown()
    },
    onSummaryChange: documents.setDraftSummary,
    onToggleAuxPanel: documents.toggleDocumentsAuxPanel,
    onToggleWideMode: documents.toggleDocumentsWideMode,
    onTogglePin: () => {
      if (documents.selectedDocument) {
        documents.togglePinDocument(documents.selectedDocument.id)
      }
    },
    onTitleChange: documents.setDraftTitle,
    onUndo: documents.undoEdit,
    pinnedDocumentIds: documents.pinnedDocumentIds,
    pluginActionBusyKey: plugins.pluginActionBusyKey,
    pluginDocumentActions: plugins.pluginDocumentActions,
    selectedDocument: documents.selectedDocument,
    selectedDocumentId: documents.selectedDocumentId,
    ui,
    webClipBusy,
    webClipUrlDraft,
    onWebClipUrlChange: setWebClipUrlDraft
  })

  const selectionAiContent = documents.selectedBlockRange && selectionAi.selectedBlocksAvailable
    ? (
        <DocumentSelectionAiPanel
          aiEnabled={aiConfig.enabled}
          canApplyPreview={selectionAi.canApplyPreview}
          canGeneratePreview={selectionAi.canGeneratePreview}
          customInstruction={selectionAi.customInstruction}
          hasApiKey={aiConfig.hasApiKey}
          isPreviewStale={selectionAi.isPreviewStale}
          mode={selectionAi.mode}
          onApplyPreview={() => {
            selectionAi.applyPreview()
          }}
          onClearPreview={selectionAi.clearPreview}
          onCustomInstructionChange={selectionAi.setCustomInstruction}
          onGeneratePreview={() => {
            void selectionAi.generatePreview()
          }}
          onModeChange={selectionAi.setMode}
          previewBusy={selectionAi.previewBusy}
          previewError={selectionAi.previewError}
          previewText={selectionAi.previewText}
          selectedBlockActionCount={selectionAi.selectedBlockActionCount}
          selectedBlockCount={selectionAi.selectedBlockCount}
          ui={ui}
        />
      )
    : null

  return (
    <>
      <MarkdownNavigationContext.Provider value={documents.navigateMarkdownLink}>
      {documents.documentLoadError ? <RecoveryState
        title={documents.documentLoadError.missing ? (isZh ? '文档不存在' : 'Document not found') : (isZh ? '无法加载文档' : 'Unable to load document')}
        description={isZh ? '可以重试，或从左侧选择其他文档。' : 'Retry or select another document from the sidebar.'}
        error={documents.documentLoadError.message} onRetry={documents.retryDocumentLoad} busy={documents.detailLoading} /> : <DocumentsSection
        isReadingMode={documents.isReadingMode}
        navigationRequest={documents.blockNavigationRequest}
        onRevealBlock={documents.revealBlockAncestors}
        highlightedBlockId={documents.highlightedBlockId}
        onToggleReadingMode={() => {
          documents.clearBlockSelection()
          documents.dismissSlashCommand()
          documents.setPendingFocusBlockIndex(null)
          documents.setIsReadingMode(!documents.isReadingMode)
        }}
        onOpenBlockSearch={documents.openBlockSearch}
        addBlockLabel={ui.addBlock}
        auxPanelWidth={documents.documentsAuxPanelWidth}
        blockEditorRowSharedProps={blockEditorRowSharedProps}
        blockSearchPanelProps={{
          isZh,
          isOpen: documents.isBlockSearchOpen,
          items: documents.blockSearchItems,
          noMatchText: ui.noBlocksMatchSearch,
          onClose: documents.closeBlockSearch,
          onQueryChange: documents.setBlockSearchQuery,
          onSelect: documents.navigateToBlock,
          placeholder: ui.searchBlocksPlaceholder,
          query: documents.blockSearchQuery
        }}
        blocksPanelLabel={ui.blocksPanelLabel}
        documentStatsBarProps={statsBarProps}
        documentsAuxPanelProps={auxPanelProps}
        editorHelpText={ui.editorHelpText}
        emptyDocumentStateText={ui.emptyDocumentState}
        floatingSlashCommandPanelProps={floatingSlashCommandPanelProps}
        isWideMode={documents.documentsWideMode}
        linkSuggestionPanelProps={linkSuggestionPanelProps}
        onAddBlock={() => {
          const section = documents.focusedSection
          if (section) documents.insertDraftBlockAt(section.end)
          else documents.addDraftBlock()
        }}
        onAuxPanelWidthChange={documents.setDocumentsAuxPanelWidth}
        onEditorKeyDown={() => {}}
        outlinePanelProps={outlinePanelProps}
        previewHeaderProps={{ ...previewHeaderProps, pluginMenuContent, onCheckLinks: () => setLinkCheckDocumentId(documents.selectedDocumentId),
          onEditMarkdownSource: () => {
            if (documents.selectedDocumentId) setSourceEditor({ documentId: documents.selectedDocumentId, blocks: documents.getDraftBlocks() })
          } }}
        relationGroups={relationGroups}
        selectedDocument={documents.selectedDocument}
        selectionAiContent={selectionAiContent}
        selectionToolbarProps={selectionToolbarProps}
        summaryCardProps={summaryCardProps}
        visibleEditorRows={visibleEditorRows}
      />}
      </MarkdownNavigationContext.Provider>

      {sourceEditor && sourceEditor.documentId === documents.selectedDocumentId && <Suspense fallback={null}>
        <DocumentMarkdownSourceDialog key={sourceEditor.documentId} blocks={sourceEditor.blocks} isZh={isZh}
          onClose={() => setSourceEditor(null)} onApply={(blocks) => {
            if (!areDocumentDraftBlocksEqual(documents.getDraftBlocks(), sourceEditor.blocks)) return false
            documents.checkpointDraft()
            documents.clearBlockSelection()
            documents.setIsReadingMode(false)
            documents.setDraftBlocks(blocks)
            return true
          }} />
      </Suspense>}

      {linkCheckDocumentId && linkCheckDocumentId === documents.selectedDocumentId && <Suspense fallback={null}>
        <DocumentLinkCheckDialog documentId={linkCheckDocumentId} isZh={isZh} onFlush={documents.flushPendingChanges}
          onClose={() => setLinkCheckDocumentId(null)} onLocate={(blockId) => {
            const index = documents.draftBlocks.findIndex((block) => block.id === blockId)
            if (index >= 0) documents.navigateToBlock(index)
          }} />
      </Suspense>}

    </>
  )
}
