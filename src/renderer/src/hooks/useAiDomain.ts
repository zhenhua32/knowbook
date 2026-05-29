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
  onMessage: (message: string | null) => void
  onOpenDocument: (documentId: string) => void
  onSelectedDocumentChange: Dispatch<SetStateAction<DocumentDetail | null>>
  selectedDocument: DocumentDetail | null
  selectedDocumentId: string | null
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
    aiAsking: aiState.aiAsking,
    aiAutomationsRunning: aiState.aiAutomationsRunning,
    aiContextError: aiState.aiContextError,
    aiContextResults: aiState.aiContextResults,
    aiContextSearching: aiState.aiContextSearching,
    aiEnabled: aiConfig.enabled,
    aiPromptDraft: aiState.aiPromptDraft,
    hasApiKey: aiConfig.hasApiKey,
    isZh,
    onAiPromptChange: aiState.setAiPromptDraft,
    onAskAi: () => {
      void aiState.askAiOnSelectedDocument()
    },
    onFindRelatedNotes: () => {
      void aiState.findRelatedNotesForPrompt()
    },
    onOpenDocument,
    onRunEnabledAutomations: () => {
      void aiState.runEnabledAiAutomationsOnSelectedDocument()
    },
    selectedDocument,
    ui
  }

  return {
    ...aiState,
    sectionProps
  }
}