import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_WEBDAV_SYNC_CONFIG, type ResolveWebDavSyncConflict, type WebDavSyncConfig, type WebDavSyncStatus } from '@shared/webdav-sync'
import { getErrorMessage } from '../utils/errorMessage'

type Draft = Omit<WebDavSyncConfig, 'intervalMinutes'> & { intervalDraft: string; password: string; clearPassword: boolean }
type ActionKind = 'save' | 'test' | 'sync' | 'resolve' | 'cancel'
type PendingAction = { kind: ActionKind; session: number }

function createDraft(config: WebDavSyncConfig): Draft {
  const { intervalMinutes, ...settings } = config
  return { ...settings, intervalDraft: String(intervalMinutes), password: '', clearPassword: false }
}

function parseInterval(value: string): number | null {
  const trimmed = value.trim()
  if (!/^[0-9]+$/.test(trimmed)) return null
  const minutes = Number(trimmed)
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : null
}

function isDirty(draft: Draft, saved: WebDavSyncConfig): boolean {
  return draft.enabled !== saved.enabled || draft.url !== saved.url || draft.username !== saved.username
    || draft.directory !== saved.directory || draft.allowInsecureHttp !== saved.allowInsecureHttp
    || parseInterval(draft.intervalDraft) !== saved.intervalMinutes || draft.password !== '' || draft.clearPassword
}

function isRunning(status: WebDavSyncStatus | null): boolean {
  return status?.phase === 'syncing' || status?.phase === 'testing'
}

export function useWebDavSettingsState(isZh: boolean) {
  const [status, setStatus] = useState<WebDavSyncStatus | null>(null)
  const [draft, setDraft] = useState(() => createDraft(DEFAULT_WEBDAV_SYNC_CONFIG))
  const [readLoading, setReadLoading] = useState(true)
  const [readError, setReadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionKind, setActionKind] = useState<ActionKind | null>(null)
  const draftRef = useRef(draft), statusRef = useRef(status)
  const savedRef = useRef(DEFAULT_WEBDAV_SYNC_CONFIG)
  const mountedRef = useRef(false), sessionRef = useRef(0), readBarrierRef = useRef(0)
  const readingRef = useRef<object | null>(null), actionRef = useRef<PendingAction | null>(null)
  const languageRef = useRef(isZh)
  languageRef.current = isZh

  const applyStatus = useCallback((value: WebDavSyncStatus, saved = false) => {
    const current = draftRef.current, previous = savedRef.current, config = value.config
    const next: Draft = saved ? createDraft(config) : {
      enabled: current.enabled === previous.enabled ? config.enabled : current.enabled,
      url: current.url === previous.url ? config.url : current.url,
      username: current.username === previous.username ? config.username : current.username,
      directory: current.directory === previous.directory ? config.directory : current.directory,
      allowInsecureHttp: current.allowInsecureHttp === previous.allowInsecureHttp ? config.allowInsecureHttp : current.allowInsecureHttp,
      intervalDraft: parseInterval(current.intervalDraft) === previous.intervalMinutes && config.intervalMinutes !== previous.intervalMinutes
        ? String(config.intervalMinutes) : current.intervalDraft,
      password: current.password,
      clearPassword: current.clearPassword
    }
    savedRef.current = config
    statusRef.current = value
    setStatus(value)
    setReadError('')
    if ((Object.keys(next) as Array<keyof Draft>).some(key => next[key] !== current[key])) {
      draftRef.current = next
      setDraft(next)
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    const kind = actionRef.current?.kind
    if (!mountedRef.current || readingRef.current || kind === 'save' || kind === 'resolve' || kind === 'cancel') return
    const request = {}, session = sessionRef.current, barrier = readBarrierRef.current
    readingRef.current = request
    const isCurrent = () => mountedRef.current && sessionRef.current === session
      && readingRef.current === request && readBarrierRef.current === barrier
    setReadLoading(true)
    try {
      const value = await window.knowbook.getWebDavSyncStatus()
      if (isCurrent()) applyStatus(value)
    } catch (reason) {
      if (isCurrent()) setReadError(getErrorMessage(reason, languageRef.current
        ? '无法读取同步设置，请重试。' : 'Could not load sync settings. Retry.'))
    } finally {
      if (readingRef.current === request) {
        readingRef.current = null
        if (mountedRef.current && sessionRef.current === session) setReadLoading(false)
      }
    }
  }, [applyStatus])

  useEffect(() => {
    mountedRef.current = true
    sessionRef.current += 1
    void refreshStatus()
    const timer = setInterval(() => { void refreshStatus() }, 1000)
    return () => {
      mountedRef.current = false
      sessionRef.current += 1
      readBarrierRef.current += 1
      readingRef.current = null
      actionRef.current = null
      clearInterval(timer)
    }
  }, [refreshStatus])

  const updateDraft = useCallback((patch: Partial<Draft>) => {
    if (!mountedRef.current || !statusRef.current || actionRef.current || isRunning(statusRef.current)) return
    const next = { ...draftRef.current, ...patch }
    draftRef.current = next
    setDraft(next)
  }, [])
  const edit = useCallback((patch: Partial<Omit<WebDavSyncConfig, 'intervalMinutes'>>) => updateDraft(patch), [updateDraft])
  const setPassword = useCallback((password: string) => updateDraft({ password, clearPassword: false }), [updateDraft])
  const setClearPassword = useCallback((clearPassword: boolean) => updateDraft({ clearPassword, password: '' }), [updateDraft])
  const setIntervalDraft = useCallback((intervalDraft: string) => updateDraft({ intervalDraft }), [updateDraft])

  const run = useCallback(async (kind: ActionKind, operation: () => Promise<WebDavSyncStatus>): Promise<boolean> => {
    if (!mountedRef.current || !statusRef.current) return false
    const currentAction = actionRef.current
    if (kind === 'cancel') {
      if (!(currentAction?.kind === 'test' || currentAction?.kind === 'sync'
        || (!currentAction && isRunning(statusRef.current)))) return false
    } else if (currentAction || isRunning(statusRef.current)) return false
    if ((kind === 'test' || kind === 'sync' || kind === 'resolve') && isDirty(draftRef.current, savedRef.current)) return false
    if ((kind === 'test' || kind === 'sync') && !statusRef.current.hasPassword) return false
    const pending = { kind, session: sessionRef.current }
    actionRef.current = pending
    readBarrierRef.current += 1
    setActionKind(kind)
    setActionError('')
    const isCurrent = () => mountedRef.current && sessionRef.current === pending.session && actionRef.current === pending
    let failed = false
    try {
      const value = await operation()
      if (!isCurrent()) return false
      readBarrierRef.current += 1
      applyStatus(value, kind === 'save')
      return true
    } catch (reason) {
      if (isCurrent()) {
        failed = true
        setActionError(getErrorMessage(reason, languageRef.current ? '操作失败，请重试。' : 'Action failed. Retry.'))
      }
      return false
    } finally {
      if (isCurrent()) {
        readBarrierRef.current += 1
        actionRef.current = null
        setActionKind(null)
        if (failed) void refreshStatus()
      }
    }
  }, [applyStatus, refreshStatus])

  const save = useCallback((): Promise<boolean> => {
    const current = draftRef.current, intervalMinutes = parseInterval(current.intervalDraft)
    if (intervalMinutes === null) return Promise.resolve(false)
    const { intervalDraft: _intervalDraft, password, clearPassword, ...settings } = current
    return run('save', () => window.knowbook.saveWebDavSyncConfig({ ...settings, intervalMinutes,
      ...(clearPassword ? { password: '' } : password ? { password } : {}) }))
  }, [run])
  const testConnection = useCallback(() => run('test', () => window.knowbook.testWebDavConnection()), [run])
  const syncNow = useCallback(() => run('sync', () => window.knowbook.syncWebDavNow()), [run])
  const resolve = useCallback((input: ResolveWebDavSyncConflict) => run('resolve', () => window.knowbook.resolveWebDavSyncConflict(input)), [run])
  const cancel = useCallback(() => run('cancel', () => window.knowbook.cancelWebDavSync()), [run])

  const intervalMinutes = parseInterval(draft.intervalDraft)
  const intervalError = intervalMinutes === null
    ? (isZh ? '同步间隔应为 1–1440 分钟的整数。' : 'Sync interval must be a whole number from 1 to 1440 minutes.') : null
  const { intervalDraft, password, clearPassword, ...settings } = draft
  const config: WebDavSyncConfig = { ...settings, intervalMinutes: intervalMinutes ?? savedRef.current.intervalMinutes }
  const working = actionKind !== null || isRunning(status)
  const canStop = actionKind === 'test' || actionKind === 'sync' || (actionKind === null && isRunning(status))

  return { status, config, password, clearPassword, intervalDraft, intervalError,
    dirty: isDirty(draft, savedRef.current), readLoading, readError, actionError, actionKind, working, canStop,
    edit, setPassword, setClearPassword, setIntervalDraft, refreshStatus, save, testConnection, syncNow, resolve, cancel }
}
