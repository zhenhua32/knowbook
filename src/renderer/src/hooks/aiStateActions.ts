import type { AiConfig, DocumentDetail, HomeData, SemanticSearchResult } from '@shared/contracts'
import type { AppMessageHandler } from '../notify'
import type { UiText } from '../i18n'
import { confirmAction } from '../confirmAction'
import { getErrorMessage } from '../utils/errorMessage'

type SettingsDraft = Omit<AiConfig, 'hasApiKey'> & { apiKey: string }
type Ref<T> = { current: T }
type Set<T> = (value: T) => void
export interface AiStateActionContext {
  settingsDraftRef: Ref<SettingsDraft>; savedConfigRef: Ref<AiConfig>; settingsUiRef: Ref<UiText>
  settingsLockedRef: Ref<boolean>; selectedDocumentIdRef: Ref<string | null>
  applyAiConfig: (config: AiConfig, mode: 'save' | 'clear' | 'external') => void
  onAiConfigChange: (config: AiConfig) => void; onMessage: AppMessageHandler
  onHomeDataChange: (home: HomeData) => void; onSelectedDocumentChange: (detail: DocumentDetail | null) => void
  onDraftSummaryChange: (summary: string) => void
  setAiSaveError: Set<string>; setAiSaving: Set<boolean>; setAiClearingApiKey: Set<boolean>
  setAiContextResults: Set<SemanticSearchResult[]>; setAiContextHasSearched: Set<boolean>
  setAiContextError: Set<string>; setAiContextSearching: Set<boolean>
  setAiAnswer: Set<string>; setAiAnsweredPrompt: Set<string>; setAiAnswerError: Set<string>
  setAiFailedPrompt: Set<string>; setAiAsking: Set<boolean>; setAiAutomationsRunning: Set<boolean>
  ui: UiText
}
type CurrentRequest = { isCurrentRequest: () => boolean }
export type AiStateActionRequest = CurrentRequest & (
  | { kind: 'save'; submittedDraft: SettingsDraft }
  | { kind: 'clear' }
  | { kind: 'related' | 'ask'; requestedDocumentId: string; requestedPrompt: string }
  | { kind: 'automation'; requestedDocumentId: string }
)

async function completeSaveAiConfig(context: AiStateActionContext, prepared: CurrentRequest & { submittedDraft: SettingsDraft }): Promise<void> {
  const { settingsUiRef, settingsLockedRef, applyAiConfig, onAiConfigChange, onMessage, setAiSaveError, setAiSaving, ui } = context
  const { isCurrentRequest , submittedDraft } = prepared
  try {
      const savedConfig = await window.knowbook.updateAiConfig(submittedDraft)
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
}

async function completeClearAiApiKey(context: AiStateActionContext, prepared: CurrentRequest): Promise<void> {
  const { savedConfigRef, settingsLockedRef, applyAiConfig, onAiConfigChange, onMessage, setAiSaveError, setAiSaving, setAiClearingApiKey, ui } = context
  const { isCurrentRequest } = prepared
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
}

async function completeFindRelatedNotes(context: AiStateActionContext, prepared: CurrentRequest & { requestedDocumentId: string; requestedPrompt: string }): Promise<void> {
  const { setAiContextResults, setAiContextHasSearched, setAiContextError, setAiContextSearching, ui } = context
  const { isCurrentRequest, requestedDocumentId, requestedPrompt } = prepared
  try {
      const results = await window.knowbook.searchSemanticNotes({
        query: requestedPrompt,
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
}

async function completeAskAi(context: AiStateActionContext, prepared: CurrentRequest & { requestedDocumentId: string; requestedPrompt: string }): Promise<void> {
  const { setAiAnswer, setAiAnsweredPrompt, setAiAnswerError, setAiFailedPrompt, setAiAsking, ui } = context
  const { isCurrentRequest, requestedDocumentId, requestedPrompt } = prepared
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
}

async function completeRunAutomations(context: AiStateActionContext, prepared: { requestedDocumentId: string }): Promise<void> {
  const { selectedDocumentIdRef, onMessage, onHomeDataChange, onSelectedDocumentChange, onDraftSummaryChange, setAiAutomationsRunning, ui } = context
  const { requestedDocumentId } = prepared
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
}

export async function completeAiAction(context: AiStateActionContext, request: AiStateActionRequest): Promise<void> {
  switch (request.kind) {
    case 'save': return completeSaveAiConfig(context, request)
    case 'clear': return completeClearAiApiKey(context, request)
    case 'related': return completeFindRelatedNotes(context, request)
    case 'ask': return completeAskAi(context, request)
    case 'automation': return completeRunAutomations(context, request)
  }
}
