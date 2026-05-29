import type { HomeData } from '@shared/contracts'
import type { UiText } from '../i18n'
import type { useAiDomain } from '../hooks/useAiDomain'
import { useDocumentsBlockEditorPresentation } from '../hooks/useDocumentsBlockEditorPresentation'
import { useDocumentsDetailPresentation } from '../hooks/useDocumentsDetailPresentation'
import type { useDocumentsDomainState } from '../hooks/useDocumentsDomainState'
import type { usePluginsDomain } from '../hooks/usePluginsDomain'
import { DocumentsSection } from '../sections/DocumentsSection'

const BLOCK_INDENT_SIZE = 24

type DocumentsDomain = ReturnType<typeof useDocumentsDomainState>
type AiDomain = ReturnType<typeof useAiDomain>
type PluginsDomain = ReturnType<typeof usePluginsDomain>

type DocumentsPageProps = {
  ai: Pick<AiDomain,
    'aiAnswer'
    | 'aiAsking'
    | 'aiAutomationsRunning'
    | 'aiContextError'
    | 'aiContextResults'
    | 'aiContextSearching'
    | 'aiPromptDraft'
    | 'askAiOnSelectedDocument'
    | 'findRelatedNotesForPrompt'
    | 'runEnabledAiAutomationsOnSelectedDocument'
    | 'setAiPromptDraft'
  >
  aiConfig: HomeData['aiConfig']
  documentTree: HomeData['documentTree']
  documents: DocumentsDomain
  isZh: boolean
  onCreateDocument: (parentId: string | null) => Promise<unknown> | void
  onDeleteSelectedDocument: () => Promise<unknown> | void
  onMoveSelectedDocument: () => Promise<unknown> | void
  plugins: Pick<PluginsDomain, 'pluginActionBusyKey' | 'pluginDocumentActions' | 'runPluginDocumentAction'>
  ui: UiText
}

export function DocumentsPage({
  ai,
  aiConfig,
  documentTree,
  documents,
  isZh,
  onCreateDocument,
  onDeleteSelectedDocument,
  onMoveSelectedDocument,
  plugins,
  ui
}: DocumentsPageProps) {
  const {
    blockEditorRowSharedProps,
    floatingSlashCommandPanelProps,
    linkSuggestionPanelProps,
    outlinePanelProps,
    selectionToolbarProps,
    visibleEditorRows
  } = useDocumentsBlockEditorPresentation({
    activeBlockIndex: documents.activeBlockIndex,
    activeLinkContext: documents.activeLinkContext,
    activeSlashCommand: documents.activeSlashCommand,
    activeSlashContext: documents.activeSlashContext,
    adjustBlockDepth: documents.adjustBlockDepth,
    adjustSelectedBlocksDepth: documents.adjustSelectedBlocksDepth,
    applySlashCommand: documents.applySlashCommand,
    beginBlockDrag: documents.beginBlockDrag,
    blockSuggestions: documents.blockSuggestions,
    blockHasChildren: documents.blockHasChildren,
    blockTextareaRefs: documents.blockTextareaRefs,
    BLOCK_INDENT_SIZE,
    canMoveSelectedRange: documents.canMoveSelectedRange,
    canMoveSelectionDown: documents.canMoveSelectionDown,
    canMoveSelectionUp: documents.canMoveSelectionUp,
    captureBlockCursor: documents.captureBlockCursor,
    collapsedBlockIds: documents.collapsedBlockIds,
    clearBlockSelection: documents.clearBlockSelection,
    continueBlockAt: documents.continueBlockAt,
    convertSelectedBlocks: documents.convertSelectedBlocks,
    copySelectedBlocks: documents.copySelectedBlocks,
    copySelectedBlocksAsPlainText: documents.copySelectedBlocksAsPlainText,
    cutSelectedBlocks: documents.cutSelectedBlocks,
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
    getVisibleBlockCountInRange: documents.getVisibleBlockCountInRange,
    getVisibleBlocks: documents.getVisibleBlocks,
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
    onSelectOutlineBlock: (blockIndex) => {
      documents.setActiveBlockIndex(blockIndex)
      documents.setPendingFocusBlockIndex(blockIndex)
    },
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
    autoSaveFlash: documents.autoSaveFlash,
    canRedo: documents.canRedo,
    canUndo: documents.canUndo,
    detailLoading: documents.detailLoading,
    documentTree,
    documentsAuxPanelOpen: documents.documentsAuxPanelOpen,
    draftBlocks: documents.draftBlocks,
    draftSummary: documents.draftSummary,
    draftTitle: documents.draftTitle,
    hasApiKey: aiConfig.hasApiKey,
    isZh,
    isSaving: documents.isSaving,
    mdCopyFlash: documents.mdCopyFlash,
    moveTargetId: documents.moveTargetId,
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
    ui
  })

  return (
    <>
      <DocumentsSection
        addBlockLabel={ui.addBlock}
        blockEditorRowSharedProps={blockEditorRowSharedProps}
        blockSearchPanelProps={{
          isOpen: documents.isBlockSearchOpen,
          items: documents.blockSearchItems,
          noMatchText: ui.noBlocksMatchSearch,
          onClose: documents.closeBlockSearch,
          onQueryChange: documents.setBlockSearchQuery,
          onSelect: documents.handleBlockSearchSelect,
          placeholder: ui.searchBlocksPlaceholder,
          query: documents.blockSearchQuery
        }}
        blocksPanelLabel={ui.blocksPanelLabel}
        documentStatsBarProps={statsBarProps}
        documentsAuxPanelProps={auxPanelProps}
        editorHelpText={ui.editorHelpText}
        emptyDocumentStateText={ui.emptyDocumentState}
        floatingSlashCommandPanelProps={floatingSlashCommandPanelProps}
        linkSuggestionPanelProps={linkSuggestionPanelProps}
        onAddBlock={documents.addDraftBlock}
        onEditorKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
            event.preventDefault()
            documents.openBlockSearch()
          }
        }}
        outlinePanelProps={outlinePanelProps}
        previewHeaderProps={previewHeaderProps}
        relationGroups={relationGroups}
        selectedDocument={documents.selectedDocument}
        selectionToolbarProps={selectionToolbarProps}
        summaryCardProps={summaryCardProps}
        visibleEditorRows={visibleEditorRows}
      />

      {documents.isGlobalSearchOpen && (
        <div className="global-search-overlay" onClick={documents.closeGlobalSearch}>
          <div className="global-search-modal" onClick={(event) => event.stopPropagation()}>
            <div className="global-search-header">
              <input
                autoFocus
                className="global-search-input"
                placeholder={ui.globalSearchPlaceholder}
                type="text"
                value={documents.globalSearchQuery}
                onChange={(event) => {
                  void documents.updateGlobalSearchQuery(event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    documents.closeGlobalSearch()
                  }
                }}
              />
              <button className="secondary-button" onClick={documents.closeGlobalSearch} type="button">✕</button>
            </div>
            <div className="global-search-results">
              {documents.globalSearchLoading && <p className="mini-hint">{ui.globalSearchLoading}</p>}
              {!documents.globalSearchLoading && documents.globalSearchQuery && documents.globalSearchResults.length === 0 && (
                <p className="mini-hint">{ui.globalSearchNoResults}</p>
              )}
              {!documents.globalSearchLoading && !documents.globalSearchQuery && (
                <p className="mini-hint">{ui.globalSearchPrompt}</p>
              )}
              {documents.globalSearchResults.map((result, index) => (
                <button
                  className="global-search-result"
                  key={index}
                  onClick={() => documents.handleGlobalSearchNavigate(result)}
                  type="button"
                >
                  <div className="global-search-result-header">
                    <span className="global-search-doc-path">{result.documentPath}</span>
                    <span className={`global-search-match-badge ${result.matchType === 'title' ? 'global-search-match-title' : 'global-search-match-block'}`}>
                      {result.matchType === 'title' ? ui.titleMatchLabel : result.blockType ?? ui.blockMatchFallback}
                    </span>
                  </div>
                  <strong className="global-search-doc-title">{result.documentTitle}</strong>
                  {result.snippet ? <p className="global-search-snippet">{result.snippet}</p> : null}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}