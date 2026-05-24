import { useCallback, useEffect, useState } from 'react'
import type { AppUpdateState } from '@shared/contracts'
import type { UiText } from '../i18n'

type UseSettingsStateParams = {
  isSettingsPageActive: boolean
  ui: UiText
  onMessage: (message: string) => void
}

export function useSettingsState({ isSettingsPageActive, ui, onMessage }: UseSettingsStateParams) {
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState | null>(null)
  const [appUpdateRefreshing, setAppUpdateRefreshing] = useState(false)

  useEffect(() => {
    let mounted = true

    window.knowbook.getAppUpdateState().then((state) => {
      if (mounted) {
        setAppUpdateState(state)
      }
    }).catch((error) => {
      console.warn('Failed to load app update state.', error)
    })

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!isSettingsPageActive) {
      return
    }

    let cancelled = false

    const refresh = async () => {
      try {
        const state = await window.knowbook.getAppUpdateState()
        if (!cancelled) {
          setAppUpdateState(state)
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Failed to refresh app update state.', error)
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

  return {
    appUpdateState,
    appUpdateRefreshing,
    checkForAppUpdates,
    installAppUpdate
  }
}