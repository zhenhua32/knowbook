import type { AppMessageHandler } from '../notify'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WebClipBridgeStatus } from '@shared/contracts'
import { parseWebClipBridgePortDraft } from '@shared/web-clip-bridge-settings'
import type { UiText } from '../i18n'
import { getErrorMessage } from '../utils/errorMessage'
import { useAppUpdateSettingsState } from './useAppUpdateSettingsState'

type UseSettingsStateParams = {
  isSettingsPageActive: boolean
  ui: UiText
  onMessage: AppMessageHandler
}

export function useSettingsState({ isSettingsPageActive, ui, onMessage }: UseSettingsStateParams) {
  const appUpdates = useAppUpdateSettingsState({ ui, onMessage })
  const { reloadAppUpdateState } = appUpdates
  const [webClipBridgeStatus, setWebClipBridgeStatus] = useState<WebClipBridgeStatus | null>(null)
  const [webClipBridgeLoading, setWebClipBridgeLoading] = useState(true)
  const [webClipBridgeLoadError, setWebClipBridgeLoadError] = useState<string | null>(null)
  const [webClipBridgeEnabledDraft, setWebClipBridgeEnabledDraft] = useState(false)
  const [webClipBridgePortDraft, setWebClipBridgePortDraft] = useState('3210')
  const [webClipBridgeSaving, setWebClipBridgeSaving] = useState(false)
  const [webClipBridgeRegenerating, setWebClipBridgeRegenerating] = useState(false)
  const [webClipBridgeActionError, setWebClipBridgeActionError] = useState<{ kind: 'save' | 'regenerate'; message: string } | null>(null)
  const mounted = useRef(false)
  const session = useRef(0)
  const bridgeStatus = useRef<WebClipBridgeStatus | null>(null)
  const bridgeInitialized = useRef(false)
  const bridgeReadGeneration = useRef(0)
  const bridgeReadPromise = useRef<Promise<void> | null>(null)
  const bridgeSaveGeneration = useRef(0)
  const bridgeSaving = useRef(false)
  const currentUi = useRef(ui)
  currentUi.current = ui
  const webClipBridgePortError = webClipBridgeStatus && parseWebClipBridgePortDraft(webClipBridgePortDraft) === null
    ? ui.webClipBridgePortInvalid
    : null

  const reloadWebClipBridgeStatus = useCallback((): Promise<void> => {
    if (!mounted.current || bridgeSaving.current) return Promise.resolve()
    if (bridgeReadPromise.current) return bridgeReadPromise.current

    const generation = ++bridgeReadGeneration.current
    const readSession = session.current
    const isCurrent = () => mounted.current && session.current === readSession && bridgeReadGeneration.current === generation
    setWebClipBridgeLoading(true)
    const request = Promise.resolve().then(async () => {
      if (!isCurrent()) return
      try {
        const status = await window.knowbook.getWebClipBridgeStatus()
        if (!isCurrent()) return
        bridgeStatus.current = status
        setWebClipBridgeStatus(status)
        setWebClipBridgeLoadError(null)
        if (!bridgeInitialized.current) {
          bridgeInitialized.current = true
          setWebClipBridgeEnabledDraft(status.enabled)
          setWebClipBridgePortDraft(`${status.configuredPort}`)
        }
      } catch (error) {
        if (!isCurrent()) return
        const detail = getErrorMessage(error, '')
        const prefix = currentUi.current.webClipBridgeLoadFailed
        setWebClipBridgeLoadError(detail ? `${prefix} ${detail}` : prefix)
      } finally {
        if (isCurrent()) {
          bridgeReadPromise.current = null
          setWebClipBridgeLoading(false)
        }
      }
    })
    bridgeReadPromise.current = request
    return request
  }, [])

  useEffect(() => {
    mounted.current = true
    void reloadWebClipBridgeStatus()

    return () => {
      mounted.current = false
      session.current++
      bridgeReadGeneration.current++
      bridgeSaveGeneration.current++
      bridgeReadPromise.current = null
      bridgeSaving.current = false
    }
  }, [reloadWebClipBridgeStatus])

  useEffect(() => {
    if (!isSettingsPageActive) {
      return
    }

    void reloadAppUpdateState()
    void reloadWebClipBridgeStatus()
    const timer = setInterval(() => {
      void reloadAppUpdateState()
      void reloadWebClipBridgeStatus()
    }, 4000)

    return () => {
      clearInterval(timer)
    }
  }, [isSettingsPageActive, reloadAppUpdateState, reloadWebClipBridgeStatus])

  const installAppUpdate = useCallback(async () => {
    try {
      await window.knowbook.installAppUpdate()
    } catch (error) {
      const detail = getErrorMessage(error, '')
      const message = detail ? `${ui.appUpdateInstallFailed} ${detail}` : ui.appUpdateInstallFailed
      onMessage(message, 'error')
    }
  }, [onMessage, ui])

  const saveWebClipBridgeSettings = useCallback(async (regenerateToken = false) => {
    if (!mounted.current || !bridgeStatus.current || bridgeSaving.current) return
    const savedSettings = bridgeStatus.current
    const port = regenerateToken ? savedSettings.configuredPort : parseWebClipBridgePortDraft(webClipBridgePortDraft)
    if (port === null) return
    bridgeSaving.current = true
    const generation = ++bridgeSaveGeneration.current
    const saveSession = session.current
    const isCurrent = () => mounted.current && session.current === saveSession && bridgeSaveGeneration.current === generation
    // A read started before this mutation must not restore the previous configuration.
    bridgeReadGeneration.current++
    bridgeReadPromise.current = null
    setWebClipBridgeLoading(false)
    setWebClipBridgeSaving(true)
    setWebClipBridgeRegenerating(regenerateToken)
    setWebClipBridgeActionError(null)

    try {
      const status = await window.knowbook.updateWebClipBridgeSettings({
        enabled: regenerateToken ? savedSettings.enabled : webClipBridgeEnabledDraft,
        port,
        regenerateToken
      })
      if (!isCurrent()) return
      bridgeStatus.current = status
      setWebClipBridgeLoadError(null)
      setWebClipBridgeStatus(status)
      if (!regenerateToken) {
        setWebClipBridgeEnabledDraft(status.enabled)
        setWebClipBridgePortDraft(`${status.configuredPort}`)
      }
      onMessage(regenerateToken ? ui.webClipBridgeTokenRefreshed : ui.webClipBridgeSaved(status.running))
    } catch (error) {
      if (!isCurrent()) return
      const detail = getErrorMessage(error, '')
      const prefix = regenerateToken ? currentUi.current.webClipBridgeTokenRefreshFailed : currentUi.current.webClipBridgeSaveFailed
      const message = detail ? `${prefix} ${detail}` : prefix
      setWebClipBridgeActionError({ kind: regenerateToken ? 'regenerate' : 'save', message })
      onMessage(message, 'error')
    } finally {
      if (isCurrent()) {
        bridgeSaving.current = false
        setWebClipBridgeSaving(false)
        setWebClipBridgeRegenerating(false)
      }
    }
  }, [onMessage, ui, webClipBridgeEnabledDraft, webClipBridgePortDraft])

  const changeWebClipBridgeEnabledDraft = useCallback((enabled: boolean) => {
    if (mounted.current && bridgeStatus.current && !bridgeSaving.current) setWebClipBridgeEnabledDraft(enabled)
  }, [])
  const changeWebClipBridgePortDraft = useCallback((port: string) => {
    if (mounted.current && bridgeStatus.current && !bridgeSaving.current) setWebClipBridgePortDraft(port)
  }, [])

  const copyWebClipBridgeEndpoint = useCallback(async () => {
    if (!webClipBridgeStatus?.endpoint) {
      return
    }

    try {
      await window.knowbook.writeClipboardText(webClipBridgeStatus.endpoint)
      onMessage(ui.webClipBridgeEndpointCopied)
    } catch (error) {
      const detail = getErrorMessage(error, '')
      const message = detail ? `${ui.copyFailed} ${detail}` : ui.copyFailed
      onMessage(message, 'error')
    }
  }, [onMessage, ui, webClipBridgeStatus?.endpoint])

  const copyWebClipBridgeToken = useCallback(async () => {
    if (!webClipBridgeStatus?.token) {
      return
    }

    try {
      await window.knowbook.writeClipboardText(webClipBridgeStatus.token)
      onMessage(ui.webClipBridgeTokenCopied)
    } catch (error) {
      const detail = getErrorMessage(error, '')
      const message = detail ? `${ui.copyFailed} ${detail}` : ui.copyFailed
      onMessage(message, 'error')
    }
  }, [onMessage, ui, webClipBridgeStatus?.token])

  return {
    ...appUpdates,
    copyWebClipBridgeEndpoint,
    copyWebClipBridgeToken,
    installAppUpdate,
    reloadWebClipBridgeStatus,
    saveWebClipBridgeSettings,
    setWebClipBridgeEnabledDraft: changeWebClipBridgeEnabledDraft,
    setWebClipBridgePortDraft: changeWebClipBridgePortDraft,
    webClipBridgeEnabledDraft,
    webClipBridgePortDraft,
    webClipBridgePortError,
    webClipBridgeSaving,
    webClipBridgeRegenerating,
    webClipBridgeActionError,
    webClipBridgeLoading,
    webClipBridgeLoadError,
    webClipBridgeStatus
  }
}
