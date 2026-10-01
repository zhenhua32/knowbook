import type { AppMessageHandler } from '../notify'
import { confirmAction } from '../confirmAction'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  onMessage: AppMessageHandler
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
  const [aiAnsweredPrompt, setAiAnsweredPrompt] = useState('')
  const [aiAnswerError, setAiAnswerError] = useState('')
  const [aiFailedPrompt, setAiFailedPrompt] = useState('')
  const [aiAsking, setAiAsking] = useState(false)
  const [aiAutomationsRunning, setAiAutomationsRunning] = useState(false)
  const [aiContextResults, setAiContextResults] = useState<SemanticSearchResult[]>([])
  const [aiContextSearching, setAiContextSearching] = useState(false)
  const [aiContextError, setAiContextError] = useState('')
  const [aiContextHasSearched, setAiContextHasSearched] = useState(false)
  const selectedDocumentIdRef = useRef(selectedDocumentId)
  const aiAnswerRequestIdRef = useRef(0)
  const aiContextRequestIdRef = useRef(0)

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
    aiAnswerRequestIdRef.current += 1
    aiContextRequestIdRef.current += 1
    setAiAnswer('')
    setAiAnsweredPrompt('')
    setAiAnswerError('')
    setAiFailedPrompt('')
    setAiAsking(false)
    setAiContextResults([])
    setAiContextSearching(false)
    setAiContextError('')
    setAiContextHasSearched(false)
  }, [])

  useLayoutEffect(() => {
    selectedDocumentIdRef.current = selectedDocumentId
    resetAiSession()

    return () => {
      aiAnswerRequestIdRef.current += 1
      aiContextRequestIdRef.current += 1
    }
  }, [resetAiSession, selectedDocumentId])

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
      onMessage(message, 'error')
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

  const clearAiApiKey = useCallback(async () => {
    await confirmAction({ title: ui.clearAiApiKey, description: ui.confirmClearAiApiKey,
      note: ui.language === 'zh-CN' ? '清除后，AI 请求需要重新配置 API Key。' : 'AI requests will require a new API key.',
      onConfirm: async () => {
        setAiSaving(true)
        try {
          await window.knowbook.updateAiConfig({
            enabled: aiEnabledDraft,
            baseUrl: aiBaseUrlDraft,
            model: aiModelDraft,
            autoSummaryOnSave: aiAutoSummaryOnSaveDraft,
            relatedNotesEnabled: aiRelatedNotesEnabledDraft,
            clearApiKey: true
          })
          const refreshed = await window.knowbook.getHomeData()
          setAiApiKeyDraft('')
          onHomeDataChange(refreshed)
          onMessage(ui.aiApiKeyCleared)
        } finally {
          setAiSaving(false)
        }
      }
    })
  }, [
    aiAutoSummaryOnSaveDraft,
    aiBaseUrlDraft,
    aiEnabledDraft,
    aiModelDraft,
    aiRelatedNotesEnabledDraft,
    onHomeDataChange,
    onMessage,
    ui
  ])

  const findRelatedNotesForPrompt = useCallback(async () => {
    const requestedDocumentId = selectedDocumentId
    if (!requestedDocumentId || requestedDocumentId !== selectedDocumentIdRef.current || !aiPromptDraft.trim()) {
      return
    }

    const requestId = ++aiContextRequestIdRef.current
    const isCurrentRequest = () => (
      aiContextRequestIdRef.current === requestId && selectedDocumentIdRef.current === requestedDocumentId
    )
    setAiContextSearching(true)
    setAiContextError('')

    try {
      const results = await window.knowbook.searchSemanticNotes({
        query: aiPromptDraft.trim(),
        excludeDocumentId: requestedDocumentId,
        limit: 4
      })
      if (isCurrentRequest()) {
        setAiContextResults(results)
        setAiContextHasSearched(true)
      }
    } catch (error) {
      if (isCurrentRequest()) {
        const message = getErrorMessage(error, ui.semanticSearchFailed)
        setAiContextResults([])
        setAiContextError(message)
        setAiContextHasSearched(true)
      }
    } finally {
      if (isCurrentRequest()) {
        setAiContextSearching(false)
      }
    }
  }, [aiPromptDraft, selectedDocumentId, ui])

  const askAiWithPrompt = useCallback(async (prompt: string) => {
    const requestedDocumentId = selectedDocumentId
    const requestedPrompt = prompt.trim()
    if (!requestedDocumentId || requestedDocumentId !== selectedDocumentIdRef.current || !requestedPrompt || !aiConfig.enabled || !aiConfig.hasApiKey) {
      return
    }

    const requestId = ++aiAnswerRequestIdRef.current
    const isCurrentRequest = () => (
      aiAnswerRequestIdRef.current === requestId && selectedDocumentIdRef.current === requestedDocumentId
    )
    setAiAsking(true)
    setAiAnswer('')
    setAiAnsweredPrompt('')
    setAiAnswerError('')
    setAiFailedPrompt('')
    setAiContextError('')
    setAiContextResults([])
    setAiContextHasSearched(false)

    try {
      const result = await window.knowbook.askAiAboutDocument({
        documentId: requestedDocumentId,
        prompt: requestedPrompt
      })
      if (isCurrentRequest()) {
        setAiAnswer(result.answer)
        setAiAnsweredPrompt(requestedPrompt)
      }
    } catch (error) {
      if (isCurrentRequest()) {
        const message = getErrorMessage(error, ui.aiRequestFailed)
        setAiAnswerError(message)
        setAiFailedPrompt(requestedPrompt)
      }
    } finally {
      if (isCurrentRequest()) {
        setAiAsking(false)
      }
    }
  }, [aiConfig.enabled, aiConfig.hasApiKey, selectedDocumentId, ui])

  const askAiOnSelectedDocument = useCallback(() => askAiWithPrompt(aiPromptDraft), [aiPromptDraft, askAiWithPrompt])
  const retryFailedAiRequest = useCallback(() => askAiWithPrompt(aiFailedPrompt), [aiFailedPrompt, askAiWithPrompt])

  const runEnabledAiAutomationsOnSelectedDocument = useCallback(async () => {
    const requestedDocumentId = selectedDocumentId
    if (!requestedDocumentId) {
      return
    }

    setAiAutomationsRunning(true)

    try {
      const result = await window.knowbook.runDocumentAiAutomations(requestedDocumentId)
      const [refreshedHome, refreshedDetail] = await Promise.all([
        window.knowbook.getHomeData(),
        window.knowbook.getDocumentDetail(requestedDocumentId)
      ])

      onHomeDataChange(refreshedHome)

      if (selectedDocumentIdRef.current === requestedDocumentId) {
        onSelectedDocumentChange(refreshedDetail)
        onDraftSummaryChange(refreshedDetail?.summary ?? '')
      }
      onMessage(ui.aiAutomationResult(result))
    } catch (error) {
      const message = getErrorMessage(error, ui.aiAutomationFailed)
      onMessage(message, 'error')
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
    aiAnsweredPrompt,
    aiAnswerError,
    aiFailedPrompt,
    aiAsking,
    aiAutomationsRunning,
    aiContextResults,
    aiContextSearching,
    aiContextError,
    aiContextHasSearched,
    saveAiConfig,
    clearAiApiKey,
    findRelatedNotesForPrompt,
    askAiOnSelectedDocument,
    retryFailedAiRequest,
    runEnabledAiAutomationsOnSelectedDocument,
    resetAiSession
  }
}
