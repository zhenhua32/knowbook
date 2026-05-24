import { useMemo } from 'react'
import type { ComponentProps } from 'react'
import type { DocumentBlockDraft, DocumentDetail, LinkedDocument, PluginDocumentAction } from '@shared/contracts'
import { DocumentsAuxPanel } from '../components/DocumentsAuxPanel'
import { DocumentStatsBar } from '../components/DocumentStatsBar'
import { DocumentSummaryCard } from '../components/DocumentSummaryCard'

type DocumentsAuxPanelProps = Omit<ComponentProps<typeof DocumentsAuxPanel>, 'relationContent'>
type DocumentStatsBarProps = ComponentProps<typeof DocumentStatsBar>
type DocumentSummaryCardProps = ComponentProps<typeof DocumentSummaryCard>

export type DocumentsRelationGroup = {
  title: string
  emptyText: string
  links: LinkedDocument[]
}

type UseDocumentsDetailPresentationParams = {
  aiAnswer: string
  aiAsking: boolean
  aiAutomationsRunning: boolean
  aiContextError: string
  aiContextResults: DocumentsAuxPanelProps['aiContextResults']
  aiContextSearching: boolean
  aiEnabled: boolean
  aiPromptDraft: string
  documentsAuxPanelOpen: boolean
  draftBlocks: DocumentBlockDraft[]
  draftSummary: string
  draftTitle: string
  hasApiKey: boolean
  isZh: boolean
  onAiPromptChange: DocumentsAuxPanelProps['onAiPromptChange']
  onAskAi: DocumentsAuxPanelProps['onAskAi']
  onFindRelatedNotes: DocumentsAuxPanelProps['onFindRelatedNotes']
  onOpenDocument: DocumentsAuxPanelProps['onOpenDocument']
  onRunEnabledAutomations: DocumentsAuxPanelProps['onRunEnabledAutomations']
  onRunPluginAction: (action: PluginDocumentAction) => void
  onSummaryChange: DocumentSummaryCardProps['onSummaryChange']
  onTitleChange: DocumentSummaryCardProps['onTitleChange']
  pluginActionBusyKey: string | null
  pluginDocumentActions: PluginDocumentAction[]
  selectedDocument: DocumentDetail | null
  ui: DocumentsAuxPanelProps['ui']
}

export function useDocumentsDetailPresentation({
  aiAnswer,
  aiAsking,
  aiAutomationsRunning,
  aiContextError,
  aiContextResults,
  aiContextSearching,
  aiEnabled,
  aiPromptDraft,
  documentsAuxPanelOpen,
  draftBlocks,
  draftSummary,
  draftTitle,
  hasApiKey,
  isZh,
  onAiPromptChange,
  onAskAi,
  onFindRelatedNotes,
  onOpenDocument,
  onRunEnabledAutomations,
  onRunPluginAction,
  onSummaryChange,
  onTitleChange,
  pluginActionBusyKey,
  pluginDocumentActions,
  selectedDocument,
  ui
}: UseDocumentsDetailPresentationParams) {
  const relationGroups = useMemo<DocumentsRelationGroup[]>(() => {
    if (!selectedDocument) {
      return []
    }

    return [
      {
        emptyText: ui.relationChildrenEmpty,
        links: selectedDocument.children.map((child) => ({
          id: child.id,
          title: child.title,
          path: child.path,
          label: 'child'
        })),
        title: ui.relationChildrenTitle
      },
      {
        emptyText: ui.relationOutgoingEmpty,
        links: selectedDocument.outgoingLinks,
        title: ui.relationOutgoingTitle
      },
      {
        emptyText: ui.relationBacklinksEmpty,
        links: selectedDocument.backlinks,
        title: ui.relationBacklinksTitle
      }
    ]
  }, [selectedDocument, ui.relationBacklinksEmpty, ui.relationBacklinksTitle, ui.relationChildrenEmpty, ui.relationChildrenTitle, ui.relationOutgoingEmpty, ui.relationOutgoingTitle])

  const statsBarProps = useMemo<DocumentStatsBarProps | null>(() => {
    if (!selectedDocument) {
      return null
    }

    const blockCount = draftBlocks.length
    const allText = draftBlocks.map((block) => block.content).join(' ')
    const wordCount = allText.trim() === '' ? 0 : allText.trim().split(/\s+/).length
    const charCount = allText.length
    const codeBlockCount = draftBlocks.filter((block) => block.type === 'code').length
    const todoCount = draftBlocks.filter((block) => block.type === 'todo').length

    return {
      blockCount,
      blocksLabel: ui.docStatBlocks,
      charCount,
      charsLabel: ui.docStatCharacters,
      codeBlockCount,
      codeBlocksLabel: ui.docStatCodeBlocks,
      todoCount,
      todosLabel: ui.docStatTodos,
      wordCount,
      wordsLabel: ui.docStatWords
    }
  }, [draftBlocks, selectedDocument, ui.docStatBlocks, ui.docStatCharacters, ui.docStatCodeBlocks, ui.docStatTodos, ui.docStatWords])

  const summaryCardProps: DocumentSummaryCardProps | null = selectedDocument
    ? {
        onSummaryChange,
        onTitleChange,
        path: selectedDocument.path,
        summary: draftSummary,
        summaryLabel: ui.common.summary,
        title: draftTitle,
        titleLabel: ui.common.title,
        updatedText: ui.updatedAt(selectedDocument.updatedAt)
      }
    : null

  const auxPanelProps: DocumentsAuxPanelProps | null = selectedDocument
    ? {
        aiAnswer,
        aiAsking,
        aiAutomationsRunning,
        aiContextError,
        aiContextResults,
        aiContextSearching,
        aiEnabled,
        aiPromptDraft,
        hasApiKey,
        isOpen: documentsAuxPanelOpen,
        isZh,
        onAiPromptChange,
        onAskAi,
        onFindRelatedNotes,
        onOpenDocument,
        onRunEnabledAutomations,
        onRunPluginAction,
        pluginActionBusyKey,
        pluginDocumentActions,
        ui
      }
    : null

  return {
    auxPanelProps,
    relationGroups,
    statsBarProps,
    summaryCardProps
  }
}