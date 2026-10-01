import type { AppMessageHandler } from '../notify'
import type { ComponentProps, Dispatch, SetStateAction } from 'react'
import type { DocumentDetail, HomeData } from '@shared/contracts'
import type { UiText } from '../i18n'
import { AISection } from '../sections/AISection'
import { useAiState } from './useAiState'

type AISectionProps = ComponentProps<typeof AISection>

type UseAiDomainParams = {
  aiConfig: HomeData['aiConfig']
  isZh: boolean
  onDraftSummaryChange: Dispatch<SetStateAction<string>>
  onHomeDataChange: Dispatch<SetStateAction<HomeData>>
  onMessage: AppMessageHandler
  onOpenDocument: (documentId: string) => void
  onSelectedDocumentChange: Dispatch<SetStateAction<DocumentDetail | null>>
  selectedDocument: DocumentDetail | null
  selectedDocumentId: string | null
  documentOptions: AISectionProps['documentOptions']
  contextDocumentId: string | null
  contextDocumentLoading: boolean
  onSelectContextDocument: AISectionProps['onSelectContextDocument']
  onOpenAiSettings: AISectionProps['onOpenAiSettings']
  ui: UiText
}

export function useAiDomain({
  aiConfig,
  isZh,
  onDraftSummaryChange,
  onHomeDataChange,
  onMessage,
  onOpenDocument,
  onSelectedDocumentChange,
  selectedDocument,
  selectedDocumentId,
  documentOptions,
  contextDocumentId,
  contextDocumentLoading,
  onSelectContextDocument,
  onOpenAiSettings,
  ui
}: UseAiDomainParams) {
  const aiState = useAiState({
    aiConfig,
    selectedDocumentId,
    ui,
    onHomeDataChange,
    onSelectedDocumentChange,
    onDraftSummaryChange,
    onMessage
  })

  const sectionProps: AISectionProps = {
    aiAnswer: aiState.aiAnswer,
    aiAnswerError: aiState.aiAnswerError,
    aiFailedPrompt: aiState.aiFailedPrompt,
    aiAsking: aiState.aiAsking,
    aiAutomationsRunning: aiState.aiAutomationsRunning,
    aiContextError: aiState.aiContextError,
    aiContextResults: aiState.aiContextResults,
    aiContextSearching: aiState.aiContextSearching,
    aiContextHasSearched: aiState.aiContextHasSearched,
    aiEnabled: aiConfig.enabled,
    aiPromptDraft: aiState.aiPromptDraft,
    hasApiKey: aiConfig.hasApiKey,
    isZh,
    onAiPromptChange: aiState.setAiPromptDraft,
    onAskAi: () => {
      void aiState.askAiOnSelectedDocument()
    },
    onRetryAi: () => { void aiState.retryFailedAiRequest() },
    onFindRelatedNotes: () => {
      void aiState.findRelatedNotesForPrompt()
    },
    onOpenDocument,
    onRunEnabledAutomations: () => {
      void aiState.runEnabledAiAutomationsOnSelectedDocument()
    },
    selectedDocument,
    documentOptions,
    contextDocumentId,
    contextDocumentLoading,
    onSelectContextDocument,
    onOpenAiSettings,
    ui
  }

  return {
    ...aiState,
    sectionProps
  }
}
