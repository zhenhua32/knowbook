import type { AppMessageHandler } from '../notify'
import { confirmAction } from '../confirmAction'
import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from 'react'
import type { AiConfig, DocumentDetail, HomeData, SemanticSearchResult } from '@shared/contracts'
import type { UiText } from '../i18n'
import { getErrorMessage } from '../utils/errorMessage'

type UseAiStateParams = {
  aiConfig: AiConfig
  selectedDocumentId: string | null
  ui: UiText
  onHomeDataChange: (homeData: HomeData) => void
  onAiConfigChange: (config: AiConfig) => void
  onSelectedDocumentChange: (detail: DocumentDetail | null) => void
  onDraftSummaryChange: (summary: string) => void
  onMessage: AppMessageHandler
}

type AiSettingsDraft = Omit<AiConfig, 'hasApiKey'> & { apiKey: string }

function createAiSettingsDraft(config: AiConfig): AiSettingsDraft {
  return {
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    model: config.model,
    autoSummaryOnSave: config.autoSummaryOnSave,
    relatedNotesEnabled: config.relatedNotesEnabled,
    apiKey: ''
  }
}

export function useAiState({
  aiConfig,
  selectedDocumentId,
  ui,
  onHomeDataChange,
  onAiConfigChange,
  onSelectedDocumentChange,
  onDraftSummaryChange,
  onMessage
}: UseAiStateParams) {
  const [settingsDraft, setSettingsDraft] = useState(() => createAiSettingsDraft(aiConfig))
  const settingsDraftRef = useRef(settingsDraft)
  const savedConfigRef = useRef(aiConfig)
  const settingsMountedRef = useRef(false)
  const settingsLockedRef = useRef(false)
  const settingsRequestIdRef = useRef(0)
  const settingsUiRef = useRef(ui)
  settingsUiRef.current = ui
  const {
    enabled: aiEnabledDraft, baseUrl: aiBaseUrlDraft, model: aiModelDraft,
    autoSummaryOnSave: aiAutoSummaryOnSaveDraft, relatedNotesEnabled: aiRelatedNotesEnabledDraft,
    apiKey: aiApiKeyDraft
  } = settingsDraft
  const [aiSaving, setAiSaving] = useState(false)
  const [aiClearingApiKey, setAiClearingApiKey] = useState(false)
  const [aiSaveError, setAiSaveError] = useState('')
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

  useLayoutEffect(() => {
    settingsMountedRef.current = true
    return () => {
      settingsMountedRef.current = false
      settingsLockedRef.current = false
      settingsRequestIdRef.current += 1
    }
  }, [])

  const applyAiConfig = useCallback((config: AiConfig, mode: 'save' | 'clear' | 'external') => {
    const draft = settingsDraftRef.current
    const previous = savedConfigRef.current
    const next = mode === 'save' ? createAiSettingsDraft(config) : {
      enabled: draft.enabled === previous.enabled ? config.enabled : draft.enabled,
      baseUrl: draft.baseUrl === previous.baseUrl ? config.baseUrl : draft.baseUrl,
      model: draft.model === previous.model ? config.model : draft.model,
      autoSummaryOnSave: draft.autoSummaryOnSave === previous.autoSummaryOnSave ? config.autoSummaryOnSave : draft.autoSummaryOnSave,
      relatedNotesEnabled: draft.relatedNotesEnabled === previous.relatedNotesEnabled ? config.relatedNotesEnabled : draft.relatedNotesEnabled,
      apiKey: mode === 'clear' ? '' : draft.apiKey
    }
    savedConfigRef.current = config
    if ((Object.keys(next) as Array<keyof AiSettingsDraft>).some((key) => next[key] !== draft[key])) {
      settingsDraftRef.current = next
      setSettingsDraft(next)
    }
  }, [])

  useLayoutEffect(() => {
    applyAiConfig(aiConfig, 'external')
  }, [aiConfig.autoSummaryOnSave, aiConfig.baseUrl, aiConfig.enabled, aiConfig.hasApiKey,
    aiConfig.model, aiConfig.relatedNotesEnabled, applyAiConfig])

  const updateAiDraft = useCallback(<K extends keyof AiSettingsDraft>(key: K, value: SetStateAction<AiSettingsDraft[K]>) => {
    if (!settingsMountedRef.current || settingsLockedRef.current) return
    const previous = settingsDraftRef.current
    const resolved = typeof value === 'function' ? value(previous[key]) : value
    if (resolved === previous[key]) return
    const next = { ...previous, [key]: resolved }
    settingsDraftRef.current = next
    setSettingsDraft(next)
  }, [])
  const setAiEnabledDraft = useCallback((value: SetStateAction<boolean>) => updateAiDraft('enabled', value), [updateAiDraft])
  const setAiBaseUrlDraft = useCallback((value: SetStateAction<string>) => updateAiDraft('baseUrl', value), [updateAiDraft])
  const setAiModelDraft = useCallback((value: SetStateAction<string>) => updateAiDraft('model', value), [updateAiDraft])
  const setAiAutoSummaryOnSaveDraft = useCallback((value: SetStateAction<boolean>) => updateAiDraft('autoSummaryOnSave', value), [updateAiDraft])
  const setAiRelatedNotesEnabledDraft = useCallback((value: SetStateAction<boolean>) => updateAiDraft('relatedNotesEnabled', value), [updateAiDraft])
  const setAiApiKeyDraft = useCallback((value: SetStateAction<string>) => updateAiDraft('apiKey', value), [updateAiDraft])

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
    if (!settingsMountedRef.current || settingsLockedRef.current) return
    settingsLockedRef.current = true
    const requestId = ++settingsRequestIdRef.current
    const isCurrentRequest = () => settingsMountedRef.current && settingsRequestIdRef.current === requestId
    setAiSaving(true)
    setAiSaveError('')

    try {
      const savedConfig = await window.knowbook.updateAiConfig({ ...settingsDraftRef.current })
      if (isCurrentRequest()) {
        applyAiConfig(savedConfig, 'save')
        onAiConfigChange(savedConfig)
        onMessage(ui.aiSettingsSaved)
      }
    } catch (error) {
      if (isCurrentRequest()) {
        const message = getErrorMessage(error, settingsUiRef.current.aiSettingsSaveFailed)
        setAiSaveError(message)
        onMessage(message, 'error')
      }
    } finally {
      if (isCurrentRequest()) {
        settingsLockedRef.current = false
        setAiSaving(false)
      }
    }
  }, [applyAiConfig, onAiConfigChange, onMessage, ui])

  const clearAiApiKey = useCallback(async () => {
    if (!settingsMountedRef.current || settingsLockedRef.current) return
    settingsLockedRef.current = true
    const requestId = ++settingsRequestIdRef.current
    const isCurrentRequest = () => settingsMountedRef.current && settingsRequestIdRef.current === requestId
    try {
      await confirmAction({ title: ui.clearAiApiKey, description: ui.confirmClearAiApiKey,
        note: ui.language === 'zh-CN' ? '仅清除已保存的 API Key，其他未保存的修改会保留。清除后，AI 请求需要重新配置 API Key。' : 'Only the saved API key will be cleared. Other unsaved changes will be kept. AI requests will require a new API key.',
        onConfirm: async () => {
          if (!isCurrentRequest()) return
          setAiSaveError('')
          setAiSaving(true)
          setAiClearingApiKey(true)
          try {
            const { hasApiKey: _hasApiKey, ...savedSettings } = savedConfigRef.current
            const savedConfig = await window.knowbook.updateAiConfig({ ...savedSettings, clearApiKey: true })
            if (isCurrentRequest()) {
              applyAiConfig(savedConfig, 'clear')
              onAiConfigChange(savedConfig)
              onMessage(ui.aiApiKeyCleared)
            }
          } catch (error) {
            if (isCurrentRequest()) throw error
          } finally {
            if (isCurrentRequest()) {
              setAiSaving(false)
              setAiClearingApiKey(false)
            }
          }
        }
      })
    } catch (error) {
      if (isCurrentRequest()) onMessage(getErrorMessage(error, ui.aiRequestFailed), 'error')
    } finally {
      if (isCurrentRequest()) settingsLockedRef.current = false
    }
  }, [applyAiConfig, onAiConfigChange, onMessage, ui])

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
    // A new question also replaces its reference context. Late results or
    // errors from the previous note search must not repopulate that context.
    aiContextRequestIdRef.current += 1
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
    setAiContextSearching(false)
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
    aiClearingApiKey,
    aiSaveError,
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
