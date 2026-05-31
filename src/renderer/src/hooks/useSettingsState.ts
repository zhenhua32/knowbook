import { useCallback, useEffect, useState } from 'react'
import type { AppUpdateState, WebClipBridgeStatus } from '@shared/contracts'
import type { UiText } from '../i18n'

type UseSettingsStateParams = {
  isSettingsPageActive: boolean
  ui: UiText
  onMessage: (message: string) => void
}

export function useSettingsState({ isSettingsPageActive, ui, onMessage }: UseSettingsStateParams) {
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState | null>(null)
  const [appUpdateRefreshing, setAppUpdateRefreshing] = useState(false)
  const [webClipBridgeStatus, setWebClipBridgeStatus] = useState<WebClipBridgeStatus | null>(null)
  const [webClipBridgeEnabledDraft, setWebClipBridgeEnabledDraft] = useState(false)
  const [webClipBridgePortDraft, setWebClipBridgePortDraft] = useState('3210')
  const [webClipBridgeSaving, setWebClipBridgeSaving] = useState(false)

  const loadWebClipBridgeStatus = useCallback(async (syncDrafts: boolean) => {
    const status = await window.knowbook.getWebClipBridgeStatus()
    setWebClipBridgeStatus(status)
    if (syncDrafts) {
      setWebClipBridgeEnabledDraft(status.enabled)
      setWebClipBridgePortDraft(status.port ? `${status.port}` : '3210')
    }
    return status
  }, [])

  useEffect(() => {
    let mounted = true

    window.knowbook.getAppUpdateState().then((state) => {
      if (mounted) {
        setAppUpdateState(state)
      }
    }).catch((error) => {
      console.warn('Failed to load app update state.', error)
    })

    void loadWebClipBridgeStatus(true).catch((error) => {
      console.warn('Failed to load web clip bridge status.', error)
    })

    return () => {
      mounted = false
    }
  }, [loadWebClipBridgeStatus])

  useEffect(() => {
    if (!isSettingsPageActive) {
      return
    }

    let cancelled = false

    const refresh = async () => {
      try {
        const [state, bridgeStatus] = await Promise.all([
          window.knowbook.getAppUpdateState(),
          window.knowbook.getWebClipBridgeStatus()
        ])
        if (!cancelled) {
          setAppUpdateState(state)
          setWebClipBridgeStatus(bridgeStatus)
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Failed to refresh settings state.', error)
        }
      }
    }

    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 4000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [isSettingsPageActive])

  const checkForAppUpdates = useCallback(async () => {
    setAppUpdateRefreshing(true)

    try {
      const nextState = await window.knowbook.checkForAppUpdates()
      setAppUpdateState(nextState)
      onMessage(ui.appUpdateCheckStarted)
    } catch (error) {
      const message = error instanceof Error
        ? `${ui.appUpdateCheckFailed} ${error.message}`
        : ui.appUpdateCheckFailed
      onMessage(message)
    } finally {
      setAppUpdateRefreshing(false)
    }
  }, [onMessage, ui])

  const installAppUpdate = useCallback(async () => {
    try {
      await window.knowbook.installAppUpdate()
    } catch (error) {
      const message = error instanceof Error
        ? `${ui.appUpdateInstallFailed} ${error.message}`
        : ui.appUpdateInstallFailed
      onMessage(message)
    }
  }, [onMessage, ui])

  const saveWebClipBridgeSettings = useCallback(async (regenerateToken = false) => {
    setWebClipBridgeSaving(true)

    try {
      const parsedPort = Number.parseInt(webClipBridgePortDraft, 10)
      const status = await window.knowbook.updateWebClipBridgeSettings({
        enabled: webClipBridgeEnabledDraft,
        port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3210,
        regenerateToken
      })
      setWebClipBridgeStatus(status)
      setWebClipBridgeEnabledDraft(status.enabled)
      setWebClipBridgePortDraft(status.port ? `${status.port}` : '3210')
      onMessage(regenerateToken ? ui.webClipBridgeTokenRefreshed : ui.webClipBridgeSaved(status.running))
    } catch (error) {
      const message = error instanceof Error
        ? `${ui.webClipBridgeSaveFailed} ${error.message}`
        : ui.webClipBridgeSaveFailed
      onMessage(message)
    } finally {
      setWebClipBridgeSaving(false)
    }
  }, [onMessage, ui, webClipBridgeEnabledDraft, webClipBridgePortDraft])

  const copyWebClipBridgeEndpoint = useCallback(async () => {
    if (!webClipBridgeStatus?.endpoint) {
      return
    }

    try {
      await window.knowbook.writeClipboardText(webClipBridgeStatus.endpoint)
      onMessage(ui.webClipBridgeEndpointCopied)
    } catch (error) {
      const message = error instanceof Error ? `${ui.copyFailed} ${error.message}` : ui.copyFailed
      onMessage(message)
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
      const message = error instanceof Error ? `${ui.copyFailed} ${error.message}` : ui.copyFailed
      onMessage(message)
    }
  }, [onMessage, ui, webClipBridgeStatus?.token])

  return {
    appUpdateState,
    appUpdateRefreshing,
    checkForAppUpdates,
    copyWebClipBridgeEndpoint,
    copyWebClipBridgeToken,
    installAppUpdate,
    saveWebClipBridgeSettings,
    setWebClipBridgeEnabledDraft,
    setWebClipBridgePortDraft,
    webClipBridgeEnabledDraft,
    webClipBridgePortDraft,
    webClipBridgeSaving,
    webClipBridgeStatus
  }
}