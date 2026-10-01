import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppUpdateState } from '@shared/contracts'
import type { UiText } from '../i18n'
import type { AppMessageHandler } from '../notify'
import { getErrorMessage } from '../utils/errorMessage'

type Params = { ui: UiText; onMessage: AppMessageHandler }

export function useAppUpdateSettingsState({ ui, onMessage }: Params) {
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState | null>(null)
  const [appUpdateLoading, setAppUpdateLoading] = useState(true)
  const [appUpdateLoadError, setAppUpdateLoadError] = useState<string | null>(null)
  const [appUpdateRefreshing, setAppUpdateRefreshing] = useState(false)
  const [appUpdateCheckError, setAppUpdateCheckError] = useState<string | null>(null)
  const mounted = useRef(false), session = useRef(0), readGeneration = useRef(0)
  const stateRef = useRef<AppUpdateState | null>(null)
  const readPromise = useRef<Promise<void> | null>(null)
  const checking = useRef<{ session: number } | null>(null)
  const currentUi = useRef(ui), currentMessage = useRef(onMessage)
  currentUi.current = ui; currentMessage.current = onMessage

  const reloadAppUpdateState = useCallback((): Promise<void> => {
    if (!mounted.current || checking.current) return Promise.resolve()
    if (readPromise.current) return readPromise.current
    const generation = ++readGeneration.current, readSession = session.current
    const isCurrent = () => mounted.current && session.current === readSession && readGeneration.current === generation
    setAppUpdateLoading(true)
    const request = Promise.resolve().then(async () => {
      if (!isCurrent()) return
      try {
        const state = await window.knowbook.getAppUpdateState()
        if (!isCurrent()) return
        stateRef.current = state
        setAppUpdateState(state)
        setAppUpdateLoadError(null)
      } catch (error) {
        if (!isCurrent()) return
        const detail = getErrorMessage(error, '')
        const prefix = currentUi.current.appUpdateLoadFailed
        setAppUpdateLoadError(detail ? `${prefix} ${detail}` : prefix)
      } finally {
        if (isCurrent()) {
          readPromise.current = null
          setAppUpdateLoading(false)
        }
      }
    })
    readPromise.current = request
    return request
  }, [])

  useEffect(() => {
    mounted.current = true
    void reloadAppUpdateState()
    return () => {
      mounted.current = false
      session.current++
      readGeneration.current++
      readPromise.current = null
      checking.current = null
    }
  }, [reloadAppUpdateState])

  const checkForAppUpdates = useCallback(async (): Promise<void> => {
    const known = stateRef.current
    if (!mounted.current || checking.current || !known?.updatesEnabled
      || known.status === 'checking') return
    const pending = { session: session.current }
    checking.current = pending
    // In-flight reads belong to the previous operation, even if they settle after this check.
    readGeneration.current++
    readPromise.current = null
    setAppUpdateLoading(false)
    setAppUpdateRefreshing(true)
    setAppUpdateCheckError(null)
    const isCurrent = () => mounted.current && session.current === pending.session && checking.current === pending
    let failed = false
    try {
      const nextState = await window.knowbook.checkForAppUpdates()
      if (!isCurrent()) return
      stateRef.current = nextState
      setAppUpdateState(nextState)
      setAppUpdateLoadError(null)
      if (nextState.updatesEnabled && nextState.status !== 'unsupported') currentMessage.current(currentUi.current.appUpdateCheckStarted)
    } catch (error) {
      if (!isCurrent()) return
      failed = true
      const detail = getErrorMessage(error, '')
      const prefix = currentUi.current.appUpdateCheckFailed
      const message = detail ? `${prefix} ${detail}` : prefix
      setAppUpdateCheckError(message)
      currentMessage.current(message, 'error')
    } finally {
      if (isCurrent()) {
        readGeneration.current++
        checking.current = null
        setAppUpdateRefreshing(false)
        if (failed) void reloadAppUpdateState()
      }
    }
  }, [reloadAppUpdateState])

  const appUpdateCanCheck = Boolean(appUpdateState?.updatesEnabled && !appUpdateRefreshing
    && appUpdateState.status !== 'checking')

  return { appUpdateState, appUpdateLoading, appUpdateLoadError, appUpdateRefreshing, appUpdateCheckError,
    appUpdateCanCheck, reloadAppUpdateState, checkForAppUpdates }
}
