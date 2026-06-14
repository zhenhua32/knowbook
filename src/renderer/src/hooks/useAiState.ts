import { useCallback, useEffect, useState } from 'react'
import type { AiConfig, DocumentDetail, HomeData, SemanticSearchResult } from '@shared/contracts'
import type { UiText } from '../i18n'
import { getErrorMessage } from '../utils/errorMessage'

type UseAiStateParams = {
  aiConfig: AiConfig
  selectedDocumentId: string | null
  ui: UiText
  onHomeDataChange: (homeData: HomeData) => void
  onSelectedDocumentChange: (detail: DocumentDetail | null) => void
  onDraftSummaryChange: (summary: string) => void
  onMessage: (message: string) => void
}

export function useAiState({
  aiConfig,
  selectedDocumentId,
  ui,
  onHomeDataChange,
  onSelectedDocumentChange,
  onDraftSummaryChange,
  onMessage
}: UseAiStateParams) {
  const [aiEnabledDraft, setAiEnabledDraft] = useState(aiConfig.enabled)
  const [aiBaseUrlDraft, setAiBaseUrlDraft] = useState(aiConfig.baseUrl)
  const [aiModelDraft, setAiModelDraft] = useState(aiConfig.model)
  const [aiAutoSummaryOnSaveDraft, setAiAutoSummaryOnSaveDraft] = useState(aiConfig.autoSummaryOnSave)
  const [aiRelatedNotesEnabledDraft, setAiRelatedNotesEnabledDraft] = useState(aiConfig.relatedNotesEnabled)
  const [aiApiKeyDraft, setAiApiKeyDraft] = useState('')
  const [aiSaving, setAiSaving] = useState(false)
  const [aiPromptDraft, setAiPromptDraft] = useState('')
  const [aiAnswer, setAiAnswer] = useState('')
  const [aiAsking, setAiAsking] = useState(false)
  const [aiAutomationsRunning, setAiAutomationsRunning] = useState(false)
  const [aiContextResults, setAiContextResults] = useState<SemanticSearchResult[]>([])
  const [aiContextSearching, setAiContextSearching] = useState(false)
  const [aiContextError, setAiContextError] = useState('')

  useEffect(() => {
    setAiEnabledDraft(aiConfig.enabled)
    setAiBaseUrlDraft(aiConfig.baseUrl)
    setAiModelDraft(aiConfig.model)
     setAiAutoSummaryOnSaveDraft(aiConfig.autoSummaryOnSave)
     setAiRelatedNotesEnabledDraft(aiConfig.relatedNotesEnabled)
     setAiApiKeyDraft('')
   }, [
     aiConfig.autoSummaryOnSave,
     aiConfig.baseUrl,
     aiConfig.enabled,
     aiConfig.model,
     aiConfig.relatedNotesEnabled
   ])

  const resetAiSession = useCallback(() => {
    setAiAnswer('')
    setAiContextResults([])
    setAiContextError('')
  }, [])

  const saveAiConfig = useCallback(async () => {
    setAiSaving(true)

    try {
       await window.knowbook.updateAiConfig({
         enabled: aiEnabledDraft,
         baseUrl: aiBaseUrlDraft,
         model: aiModelDraft,
         autoSummaryOnSave: aiAutoSummaryOnSaveDraft,
         relatedNotesEnabled: aiRelatedNotesEnabledDraft,
         apiKey: aiApiKeyDraft
       })

      const refreshed = await window.knowbook.getHomeData()
      onHomeDataChange(refreshed)
      onMessage(ui.aiSettingsSaved)
    } catch (error) {
      const message = getErrorMessage(error, ui.aiRequestFailed)
      onMessage(message)
    } finally {
      setAiSaving(false)
    }
  }, [
    aiAutoSummaryOnSaveDraft,
    aiApiKeyDraft,
    aiBaseUrlDraft,
    aiEnabledDraft,
    aiModelDraft,
     aiRelatedNotesEnabledDraft,
     onHomeDataChange,
     onMessage,
     ui
   ])

  const findRelatedNotesForPrompt = useCallback(async () => {
    if (!selectedDocumentId || !aiPromptDraft.trim()) {
      return
    }

    setAiContextSearching(true)
    setAiContextError('')

    try {
      const results = await window.knowbook.searchSemanticNotes({
        query: aiPromptDraft.trim(),
        excludeDocumentId: selectedDocumentId,
        limit: 4
      })
      setAiContextResults(results)
    } catch (error) {
      const message = getErrorMessage(error, ui.semanticSearchFailed)
      setAiContextResults([])
      setAiContextError(message)
    } finally {
      setAiContextSearching(false)
    }
  }, [aiPromptDraft, selectedDocumentId, ui])

  const askAiOnSelectedDocument = useCallback(async () => {
    if (!selectedDocumentId || !aiPromptDraft.trim()) {
      return
    }

    setAiAsking(true)
    setAiContextError('')
    setAiContextResults([])

    try {
      const result = await window.knowbook.askAiAboutDocument({
        documentId: selectedDocumentId,
        prompt: aiPromptDraft.trim()
      })
      setAiAnswer(result.answer)
    } catch (error) {
      const message = getErrorMessage(error, ui.aiRequestFailed)
      setAiAnswer(message)
      setAiContextResults([])
    } finally {
      setAiAsking(false)
    }
  }, [aiPromptDraft, selectedDocumentId, ui])

  const runEnabledAiAutomationsOnSelectedDocument = useCallback(async () => {
    if (!selectedDocumentId) {
      return
    }

    setAiAutomationsRunning(true)

    try {
      const result = await window.knowbook.runDocumentAiAutomations(selectedDocumentId)
      const [refreshedHome, refreshedDetail] = await Promise.all([
        window.knowbook.getHomeData(),
        window.knowbook.getDocumentDetail(selectedDocumentId)
      ])

      onHomeDataChange(refreshedHome)
      onSelectedDocumentChange(refreshedDetail)
      onDraftSummaryChange(refreshedDetail?.summary ?? '')
      onMessage(ui.aiAutomationResult(result))
    } catch (error) {
      const message = getErrorMessage(error, ui.aiAutomationFailed)
      onMessage(message)
    } finally {
      setAiAutomationsRunning(false)
    }
  }, [onDraftSummaryChange, onHomeDataChange, onMessage, onSelectedDocumentChange, selectedDocumentId, ui])

  return {
    aiEnabledDraft,
    setAiEnabledDraft,
    aiBaseUrlDraft,
    setAiBaseUrlDraft,
    aiModelDraft,
    setAiModelDraft,
     aiAutoSummaryOnSaveDraft,
     setAiAutoSummaryOnSaveDraft,
     aiRelatedNotesEnabledDraft,
     setAiRelatedNotesEnabledDraft,
     aiApiKeyDraft,
    setAiApiKeyDraft,
    aiSaving,
    aiPromptDraft,
    setAiPromptDraft,
    aiAnswer,
    aiAsking,
    aiAutomationsRunning,
    aiContextResults,
    aiContextSearching,
    aiContextError,
    saveAiConfig,
    findRelatedNotesForPrompt,
    askAiOnSelectedDocument,
    runEnabledAiAutomationsOnSelectedDocument,
    resetAiSession
  }
}