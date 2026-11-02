import type { AppMessageHandler } from '../notify'
import type { AiStateActionContext, AiStateActionRequest } from './aiStateActions'
import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from 'react'
import type { AiConfig, DocumentDetail, HomeData, SemanticSearchResult } from '@shared/contracts'
import type { UiText } from '../i18n'
import { getErrorMessage } from '../utils/errorMessage'


type DeferredAiActions = typeof import('./aiStateActions')
const loadAiActions = () => import('./aiStateActions')
async function runDeferredAiAction(
  context: AiStateActionContext, request: AiStateActionRequest,
  loadActions: () => Promise<DeferredAiActions>
): Promise<void> {
  let began = false
  try {
    const actions = await loadActions()
    if (!request.isCurrentRequest()) return
    began = true
    await actions.completeAiAction(context, request)
  } catch (error) {
    if (began) throw error
    if (!request.isCurrentRequest()) return
    const fallback = request.kind === 'save' ? context.settingsUiRef.current.aiSettingsSaveFailed
      : request.kind === 'related' ? context.ui.semanticSearchFailed
      : request.kind === 'automation' ? context.ui.aiAutomationFailed : context.ui.aiRequestFailed
    const message = getErrorMessage(error, fallback)
    if (request.kind === 'save') context.setAiSaveError(message)
    if (request.kind === 'related') { context.setAiContextResults([]); context.setAiContextError(message); context.setAiContextHasSearched(true) }
    if (request.kind === 'ask') { context.setAiAnswerError(message); context.setAiFailedPrompt(request.requestedPrompt) }
    if (request.kind === 'save' || request.kind === 'clear' || request.kind === 'automation') context.onMessage(message, 'error')
  } finally {
    if (!began) {
      if (request.isCurrentRequest()) {
        if (request.kind === 'save' || request.kind === 'clear') context.settingsLockedRef.current = false
        if (request.kind === 'save') context.setAiSaving(false)
        if (request.kind === 'related') context.setAiContextSearching(false)
        if (request.kind === 'ask') context.setAiAsking(false)
      }
      if (request.kind === 'automation') context.setAiAutomationsRunning(false)
    }
  }
}

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

function aiDraftsDiffer(draft: AiSettingsDraft, saved: AiSettingsDraft): boolean {
  return (Object.keys(draft) as Array<keyof AiSettingsDraft>).some(key => draft[key] !== saved[key])
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
}: UseAiStateParams, loadActions: () => Promise<DeferredAiActions> = loadAiActions) {
  const [settingsDraft, setSettingsDraft] = useState(() => createAiSettingsDraft(aiConfig))
  const [savedSettings, setSavedSettings] = useState(() => createAiSettingsDraft(aiConfig))
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
  const aiSettingsDirty = aiDraftsDiffer(settingsDraft, savedSettings)
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
  const aiDocumentSessionRef = useRef(0)
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
    setSavedSettings(previousSettings => {
      const nextSettings = createAiSettingsDraft(config)
      return aiDraftsDiffer(nextSettings, previousSettings) ? nextSettings : previousSettings
    })
    if (aiDraftsDiffer(next, draft)) {
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

  const resetAiSettingsDraft = useCallback(() => {
    if (!settingsMountedRef.current || settingsLockedRef.current) return
    const next = createAiSettingsDraft(savedConfigRef.current)
    settingsDraftRef.current = next
    setSettingsDraft(next)
    setAiSaveError('')
  }, [])

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
    aiDocumentSessionRef.current += 1
    resetAiSession()

    return () => {
      aiAnswerRequestIdRef.current += 1
      aiContextRequestIdRef.current += 1
    }
  }, [resetAiSession, selectedDocumentId])

  // Each original callback captures this same render closure and its original
  // request/session refs; no latest render can replace a queued operation.
  const createActionContext = (): AiStateActionContext => ({ settingsDraftRef, savedConfigRef, settingsUiRef, settingsLockedRef, selectedDocumentIdRef, applyAiConfig, onAiConfigChange, onMessage, onHomeDataChange, onSelectedDocumentChange, onDraftSummaryChange, setAiSaveError, setAiSaving, setAiClearingApiKey, setAiContextResults, setAiContextHasSearched, setAiContextError, setAiContextSearching, setAiAnswer, setAiAnsweredPrompt, setAiAnswerError, setAiFailedPrompt, setAiAsking, setAiAutomationsRunning, ui })

  const saveAiConfig = useCallback(async () => {
    if (!settingsMountedRef.current || settingsLockedRef.current) return
    if (!aiDraftsDiffer(settingsDraftRef.current, createAiSettingsDraft(savedConfigRef.current))) return
    settingsLockedRef.current = true
    const requestId = ++settingsRequestIdRef.current
    const isCurrentRequest = () => settingsMountedRef.current && settingsRequestIdRef.current === requestId
    setAiSaving(true)
    setAiSaveError('')

    const submittedDraft = { ...settingsDraftRef.current }
    await runDeferredAiAction(createActionContext(), { kind: 'save', isCurrentRequest, submittedDraft }, loadActions)
  }, [applyAiConfig, onAiConfigChange, onMessage, ui, loadActions])

  const clearAiApiKey = useCallback(async () => {
    if (!settingsMountedRef.current || settingsLockedRef.current) return
    settingsLockedRef.current = true
    const requestId = ++settingsRequestIdRef.current
    const isCurrentRequest = () => settingsMountedRef.current && settingsRequestIdRef.current === requestId
    await runDeferredAiAction(createActionContext(), { kind: 'clear', isCurrentRequest }, loadActions)
  }, [applyAiConfig, onAiConfigChange, onMessage, ui, loadActions])

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

    const requestedPrompt = aiPromptDraft.trim()
    await runDeferredAiAction(createActionContext(), { kind: 'related', isCurrentRequest, requestedDocumentId, requestedPrompt }, loadActions)
  }, [aiPromptDraft, selectedDocumentId, ui, loadActions])

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

    await runDeferredAiAction(createActionContext(), { kind: 'ask', isCurrentRequest, requestedDocumentId, requestedPrompt }, loadActions)
  }, [aiConfig.enabled, aiConfig.hasApiKey, selectedDocumentId, ui, loadActions])

  const askAiOnSelectedDocument = useCallback(() => askAiWithPrompt(aiPromptDraft), [aiPromptDraft, askAiWithPrompt])
  const retryFailedAiRequest = useCallback(() => askAiWithPrompt(aiFailedPrompt), [aiFailedPrompt, askAiWithPrompt])

  const runEnabledAiAutomationsOnSelectedDocument = useCallback(async () => {
    const requestedDocumentId = selectedDocumentId
    if (!requestedDocumentId) {
      return
    }

    setAiAutomationsRunning(true)

    const requestedSession = aiDocumentSessionRef.current
    const isCurrentRequest = () => settingsMountedRef.current && aiDocumentSessionRef.current === requestedSession && selectedDocumentIdRef.current === requestedDocumentId
    await runDeferredAiAction(createActionContext(), { kind: 'automation', isCurrentRequest, requestedDocumentId }, loadActions)
  }, [onDraftSummaryChange, onHomeDataChange, onMessage, onSelectedDocumentChange, selectedDocumentId, ui, loadActions])

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
    aiSettingsDirty,
    resetAiSettingsDraft,
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
