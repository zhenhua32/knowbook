import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_WEBDAV_SYNC_CONFIG, type ResolveWebDavProtocol5Conflict, type ResolveWebDavProtocol5Deletion, type ResolveWebDavSyncConflict, type WebDavSyncConfig, type WebDavSyncStatus } from '@shared/webdav-sync'
import { getErrorMessage } from '../utils/errorMessage'

type Draft = Omit<WebDavSyncConfig, 'intervalMinutes'> & { intervalDraft: string; password: string; clearPassword: boolean; protocol5: boolean }
type ActionKind = 'save' | 'test' | 'sync' | 'resolve' | 'cancel'
type ConflictActionTarget = Pick<ResolveWebDavSyncConflict, 'key' | 'localHash' | 'remoteHash'>
  & Pick<WebDavSyncConfig, 'url' | 'username' | 'directory'>
type PendingAction = { kind: ActionKind; session: number }

function createDraft(config: WebDavSyncConfig, protocol5 = false): Draft {
  const { intervalMinutes, ...settings } = config
  return { ...settings, intervalDraft: String(intervalMinutes), password: '', clearPassword: false, protocol5 }
}

function parseInterval(value: string): number | null {
  const trimmed = value.trim()
  if (!/^[0-9]+$/.test(trimmed)) return null
  const minutes = Number(trimmed)
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : null
}

function isDirty(draft: Draft, saved: WebDavSyncConfig, protocol5: boolean): boolean {
  return draft.protocol5 !== protocol5 || draft.enabled !== saved.enabled || draft.url !== saved.url || draft.username !== saved.username
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
  const [actionErrorTarget, setActionErrorTarget] = useState<ConflictActionTarget | null>(null)
  const [actionTarget, setActionTarget] = useState<ConflictActionTarget | null>(null)
  const [actionKind, setActionKind] = useState<ActionKind | null>(null)
  const draftRef = useRef(draft), statusRef = useRef(status)
  const savedRef = useRef(DEFAULT_WEBDAV_SYNC_CONFIG), savedProtocol5 = useRef(false)
  const mountedRef = useRef(false), sessionRef = useRef(0), readBarrierRef = useRef(0)
  const readingRef = useRef<object | null>(null), actionRef = useRef<PendingAction | null>(null)
  const languageRef = useRef(isZh)
  languageRef.current = isZh

  const applyStatus = useCallback((value: WebDavSyncStatus, saved = false) => {
    const current = draftRef.current, previous = savedRef.current, config = value.config
    const mode = value.protocol5 === true
    const next: Draft = saved ? createDraft(config, mode) : {
      protocol5: current.protocol5 === savedProtocol5.current ? mode : current.protocol5,
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
    savedProtocol5.current = mode
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
  const setProtocol5 = useCallback((protocol5: boolean) => updateDraft({ protocol5 }), [updateDraft])
  const setPassword = useCallback((password: string) => updateDraft({ password, clearPassword: false }), [updateDraft])
  const setClearPassword = useCallback((clearPassword: boolean) => updateDraft({ clearPassword, password: '' }), [updateDraft])
  const setIntervalDraft = useCallback((intervalDraft: string) => updateDraft({ intervalDraft }), [updateDraft])

  const run = useCallback(async (kind: ActionKind, operation: () => Promise<WebDavSyncStatus>, conflict?: ResolveWebDavSyncConflict): Promise<boolean> => {
    if (!mountedRef.current || !statusRef.current) return false
    const currentAction = actionRef.current
    if (kind === 'cancel') {
      if (!(currentAction?.kind === 'test' || currentAction?.kind === 'sync'
        || (!currentAction && isRunning(statusRef.current)))) return false
    } else if (currentAction || isRunning(statusRef.current)) return false
    if ((kind === 'test' || kind === 'sync' || kind === 'resolve') && isDirty(draftRef.current, savedRef.current, savedProtocol5.current)) return false
    if ((kind === 'test' || kind === 'sync') && !statusRef.current.hasPassword) return false
    const pending = { kind, session: sessionRef.current }
    const target = conflict ? { key: conflict.key, localHash: conflict.localHash, remoteHash: conflict.remoteHash,
      url: savedRef.current.url, username: savedRef.current.username, directory: savedRef.current.directory } : null
    actionRef.current = pending
    readBarrierRef.current += 1
    setActionKind(kind)
    setActionTarget(target)
    setActionError('')
    setActionErrorTarget(null)
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
        setActionErrorTarget(target)
      }
      return false
    } finally {
      if (isCurrent()) {
        readBarrierRef.current += 1
        actionRef.current = null
        setActionKind(null)
        setActionTarget(null)
        if (failed) void refreshStatus()
      }
    }
  }, [applyStatus, refreshStatus])

  const save = useCallback((): Promise<boolean> => {
    const current = draftRef.current, intervalMinutes = parseInterval(current.intervalDraft)
    if (intervalMinutes === null) return Promise.resolve(false)
    const { intervalDraft: _intervalDraft, password, clearPassword, protocol5, ...settings } = current
    return run('save', () => window.knowbook.saveWebDavSyncConfig({ ...settings, intervalMinutes,
      ...(protocol5 || savedProtocol5.current ? { protocol5 } : {}),
      ...(clearPassword ? { password: '' } : password ? { password } : {}) }))
  }, [run])
  const testConnection = useCallback(() => run('test', () => window.knowbook.testWebDavConnection()), [run])
  const syncNow = useCallback(() => run('sync', () => window.knowbook.syncWebDavNow()), [run])
  const previewProtocol5 = useCallback(() => run('sync', () => window.knowbook.previewWebDavProtocol5Conflicts()), [run])
  const resolveProtocol5 = useCallback((input: ResolveWebDavProtocol5Conflict) =>
    run('sync', () => window.knowbook.resolveWebDavProtocol5Conflict(input)), [run])
  const previewProtocol5Deletions = useCallback(() => run('sync', () => window.knowbook.previewWebDavProtocol5Deletions()), [run])
  const resolveProtocol5Deletion = useCallback((input: ResolveWebDavProtocol5Deletion) =>
    run('sync', () => window.knowbook.resolveWebDavProtocol5Deletion(input)), [run])
  const resolve = useCallback((input: ResolveWebDavSyncConflict) => run('resolve', () => window.knowbook.resolveWebDavSyncConflict(input), input), [run])
  const cancel = useCallback(() => run('cancel', () => window.knowbook.cancelWebDavSync()), [run])

  const intervalMinutes = parseInterval(draft.intervalDraft)
  const intervalError = intervalMinutes === null
    ? (isZh ? '同步间隔应为 1–1440 分钟的整数。' : 'Sync interval must be a whole number from 1 to 1440 minutes.') : null
  const { intervalDraft, password, clearPassword, protocol5, ...settings } = draft
  const config: WebDavSyncConfig = { ...settings, intervalMinutes: intervalMinutes ?? savedRef.current.intervalMinutes }
  const working = actionKind !== null || isRunning(status)
  const canStop = actionKind === 'test' || actionKind === 'sync' || (actionKind === null && isRunning(status))

  return { status, config, password, clearPassword, intervalDraft, intervalError,
    dirty: isDirty(draft, savedRef.current, savedProtocol5.current), readLoading, readError, actionError, actionErrorTarget, actionTarget, actionKind, working, canStop,
    edit, setProtocol5, protocol5, setPassword, setClearPassword, setIntervalDraft, refreshStatus, save, testConnection, syncNow,
    previewProtocol5, resolveProtocol5, previewProtocol5Deletions, resolveProtocol5Deletion, resolve, cancel }
}
