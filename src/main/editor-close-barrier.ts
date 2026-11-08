import { randomUUID } from 'node:crypto'
import { EDITOR_CLOSE_REQUEST_CHANNEL, EDITOR_CLOSE_CANCELLED_CHANNEL,
  type EditorCloseReason, type EditorCloseAcknowledgement } from '../shared/editor-close'
import type { EditorRecoveryDraftWrite, EditorRecoveryReceipt, EditorRecoveryWorkspace } from '../shared/editor-recovery-drafts'

// Structural Electron ports keep this state machine testable without opening
// a BrowserWindow. Main alone registers actual editor windows and IPC senders.
export interface EditorCloseFrame { readonly processId: number; readonly routingId: number; readonly detached?: boolean }
export interface EditorCloseWebContents {
  readonly id: number; readonly mainFrame: EditorCloseFrame
  isDestroyed(): boolean
  getOSProcessId(): number
  send(channel: string, value: unknown): void
  on(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
}
export interface EditorCloseWindow {
  readonly webContents: EditorCloseWebContents
  isDestroyed(): boolean
  close(): void
  on(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
}
export interface EditorCloseIpcEvent { readonly sender: EditorCloseWebContents; readonly senderFrame: EditorCloseFrame | null }
interface FrameIdentity {
  readonly contents: EditorCloseWebContents; readonly contentsId: number; readonly frame: EditorCloseFrame
  readonly processId: number; readonly routingId: number; readonly osProcessId: number; readonly lifecycle: number
}
interface Registered {
  readonly window: EditorCloseWindow; readonly contents: EditorCloseWebContents
  lifecycle: number; writes: number; approvedClose: string | null
  approvedReload: string | null; afterReload: 'window' | 'quit' | null
}
interface Target {
  readonly registered: Registered; readonly frame: FrameIdentity; state: 'waiting' | 'flushed' | 'closed'
  receipt?: EditorRecoveryReceipt
}
interface Attempt {
  readonly requestId: string; readonly reason: EditorCloseReason; readonly targets: Map<Registered, Target>
  readonly workspace: EditorRecoveryWorkspace | null
  phase: 'waiting' | 'closing' | 'reloading'; timer: unknown; dispatching: number
  reloadIgnoringCache: boolean
}
export interface EditorCloseBarrierOptions {
  /** Called once, only after every current editor frame has acknowledged.
   * This begins the existing irreversible services/plugin shutdown policy. */
  beginShutdown: () => void | Promise<void>
  /** Main's actual registered editor only, after its real complete drain ACK.
   * This must synchronously call webContents.reload[IgnoringCache], not await. */
  reloadEditor?: (window: EditorCloseWindow, ignoreCache: boolean) => void
  readRecoveryWorkspace?: () => EditorRecoveryWorkspace
  confirmRecoveryReceipt?: (workspace: EditorRecoveryWorkspace, receipt: EditorRecoveryReceipt) => boolean
  onShutdownError?: (error: unknown) => void
  timeoutMs?: number
  setTimer?: (callback: () => void, milliseconds: number) => unknown
  clearTimer?: (timer: unknown) => void
}
export interface EditorCloseBarrier {
  registerWindow(window: EditorCloseWindow): void
  replayPending(event: EditorCloseIpcEvent): boolean
  requestQuit(): string | null
  requestReload(event: EditorCloseIpcEvent, ignoreCache?: boolean): string | null
  acknowledge(event: EditorCloseIpcEvent, input: unknown): boolean
  journalRecoveryDrafts(event: EditorCloseIpcEvent, input: EditorRecoveryDraftWrite, write: () => EditorRecoveryReceipt): EditorRecoveryReceipt
  assertEditorMutationAllowed(event: EditorCloseIpcEvent): void
  runEditorMutation<T>(event: EditorCloseIpcEvent, operation: () => T | Promise<T>): Promise<T>
  isShuttingDown(): boolean
}

function acknowledgement(value: unknown): EditorCloseAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
  if (keys.some(key => typeof key !== 'string' || !['requestId','status','message','receiptId','closeGeneration'].includes(key))
    || !Object.hasOwn(descriptors, 'requestId') || !Object.hasOwn(descriptors, 'status')) return null
  for (const key of keys) {
    const descriptor = descriptors[key as string]
    if (!descriptor.enumerable || !('value' in descriptor)) return null
  }
  const requestId = descriptors.requestId.value, status = descriptors.status.value, message = descriptors.message?.value
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
  if (typeof requestId !== 'string' || !uuid.test(requestId)) return null
  if (status === 'draft-journaled') {
    const receiptId = descriptors.receiptId?.value, closeGeneration = descriptors.closeGeneration?.value
    if (keys.length !== 4 || typeof receiptId !== 'string' || !uuid.test(receiptId) || !Number.isSafeInteger(closeGeneration) || closeGeneration < 1) return null
    return { requestId, status, receiptId, closeGeneration }
  }
  if ((status !== 'flushed' && status !== 'blocked') || Object.hasOwn(descriptors, 'receiptId') || Object.hasOwn(descriptors, 'closeGeneration')
    || message !== undefined && (typeof message !== 'string' || message.length > 2048)) return null
  return { requestId, status, ...(message === undefined ? {} : { message }) }
}

/** Close admission only. It never clears drafts, executes a plugin hook,
 * stops a service, invents an ACK or treats a timeout as permission to quit. */
export function createEditorCloseBarrier(options: EditorCloseBarrierOptions): EditorCloseBarrier {
  const windows = new Map<EditorCloseWindow, Registered>(), contents = new WeakMap<EditorCloseWebContents, Registered>()
  const timeoutMs = options.timeoutMs ?? 8000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) throw new Error('Editor close ACK budget must be within 1..8000 ms.')
  const setTimer = options.setTimer ?? ((callback: () => void, milliseconds: number) => { const timer = setTimeout(callback, milliseconds); timer.unref(); return timer })
  const clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let attempt: Attempt | null = null, shuttingDown = false, activeWrites = 0
  let reloadLanding: { entry: Registered; requestId: string } | null = null

  const frameIdentity = (entry: Registered): FrameIdentity | null => {
    try {
      if (entry.window.isDestroyed() || entry.contents.isDestroyed()) return null
      const frame = entry.contents.mainFrame, osProcessId = entry.contents.getOSProcessId()
      if (!frame || frame.detached || !Number.isSafeInteger(frame.processId) || frame.processId < 0
        || !Number.isSafeInteger(frame.routingId) || frame.routingId < 0 || !Number.isSafeInteger(osProcessId) || osProcessId <= 0) return null
      return { contents: entry.contents, contentsId: entry.contents.id, frame, processId: frame.processId,
        routingId: frame.routingId, osProcessId, lifecycle: entry.lifecycle }
    } catch { return null }
  }
  const sameFrame = (entry: Registered, expected: FrameIdentity) => {
    const actual = frameIdentity(entry)
    return !!actual && actual.contents === expected.contents && actual.contentsId === expected.contentsId && actual.frame === expected.frame
      && actual.processId === expected.processId && actual.routingId === expected.routingId && actual.osProcessId === expected.osProcessId
      && actual.lifecycle === expected.lifecycle
  }
  const currentEntry = (event: EditorCloseIpcEvent) => {
    const entry = contents.get(event.sender), frame = entry && frameIdentity(entry)
    return entry && frame && event.senderFrame === frame.frame ? entry : null
  }
  const send = (entry: Registered, channel: string, value: unknown) => {
    if (entry.window.isDestroyed() || entry.contents.isDestroyed()) return
    entry.contents.send(channel, value)
  }
  const cancel = (message: string) => {
    const cancelled = attempt
    if (!cancelled || shuttingDown) return
    attempt = null; clearTimer(cancelled.timer)
    if (reloadLanding?.requestId === cancelled.requestId) reloadLanding = null
    for (const target of cancelled.targets.values()) {
      if (target.registered.approvedClose === cancelled.requestId) target.registered.approvedClose = null
      if (target.registered.approvedReload === cancelled.requestId) target.registered.approvedReload = null
      target.registered.afterReload = null
      try { send(target.registered, EDITOR_CLOSE_CANCELLED_CHANNEL, { requestId: cancelled.requestId, reason: cancelled.reason, message }) } catch { /* The frame may have exited; its peers must still unfreeze. */ }
    }
  }
  const beginShutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    if (attempt) clearTimer(attempt.timer)
    attempt = null
    // Once service teardown starts, neither a renderer reload nor a plugin
    // failure can honestly restore the old running state. Preserve that phase.
    const report = (error: unknown) => { try { options.onShutdownError?.(error) } catch { /* Reporting cannot undo teardown. */ } }
    try { void Promise.resolve(options.beginShutdown()).catch(report) }
    catch (error) { report(error) }
  }
  const finishWindowAttempt = () => {
    const current = attempt
    if (!current || current.reason !== 'window' || current.phase !== 'closing') return
    if ([...current.targets.values()].every(target => target.state === 'closed')) { clearTimer(current.timer); attempt = null }
  }
  const complete = () => {
    const current = attempt
    if (!current || shuttingDown || current.phase !== 'waiting' || current.dispatching) return
    if ([...current.targets.values()].some(target => target.state !== 'flushed')) return
    if (activeWrites || [...current.targets.values()].some(target => target.registered.writes || !sameFrame(target.registered, target.frame))) {
      cancel('Editor state changed before close admission completed.'); return
    }
    if (current.reason === 'quit') {
      if ([...windows.values()].some(entry => !entry.window.isDestroyed() && !current.targets.has(entry))) {
        cancel('Another editor window appeared before application quit.'); return
      }
      beginShutdown(); return
    }
    if (current.reason === 'reload') {
      const target = [...current.targets.values()][0]
      if (current.targets.size !== 1 || !target || !options.reloadEditor) { cancel('The registered editor cannot reload safely.'); return }
      current.phase = 'reloading'
      target.registered.approvedReload = current.requestId
      reloadLanding = { entry: target.registered, requestId: current.requestId }
      // Admission is now committed: every W is saved and the old renderer is
      // still frozen. The 8s budget only cancels a WAITING drain. Unfreezing
      // after invoking reload could accept new W before queued navigation.
      clearTimer(current.timer)
      try { options.reloadEditor(target.registered.window, current.reloadIgnoringCache) }
      catch { if (attempt === current) cancel('The editor reload could not start; the saved editor remains open.') }
      return
    }
    current.phase = 'closing'
    for (const target of [...current.targets.values()]) {
      if (attempt !== current || shuttingDown) break
      target.registered.approvedClose = current.requestId
      try { target.registered.window.close() } catch { cancel('The editor window could not close.'); break }
    }
    finishWindowAttempt()
  }
  const addTarget = (current: Attempt, entry: Registered) => {
    if (attempt !== current || shuttingDown) return false
    if (current.targets.has(entry)) return true
    const frame = frameIdentity(entry)
    if (!frame) { cancel('The editor frame is unavailable; reopen it before closing.'); return false }
    current.targets.set(entry, { registered: entry, frame, state: 'waiting' })
    current.dispatching++
    try { send(entry, EDITOR_CLOSE_REQUEST_CHANNEL, { requestId: current.requestId, reason: current.reason }) }
    catch { cancel('The editor frame could not receive the close request.'); return false }
    finally { current.dispatching-- }
    if (attempt === current) complete()
    return attempt === current
  }
  const start = (reason: EditorCloseReason, entries: readonly Registered[], reloadIgnoringCache = false) => {
    let workspace: EditorRecoveryWorkspace | null = null
    try { if (reason !== 'reload') workspace = options.readRecoveryWorkspace?.() ?? null } catch { /* A failed boundary read cannot authorize a recovery journal. */ }
    const current: Attempt = { requestId: randomUUID(), reason, targets: new Map(), workspace, phase: 'waiting', timer: null, dispatching: 1, reloadIgnoringCache }
    attempt = current
    current.timer = setTimer(() => {
      if (attempt === current && (current.reason !== 'reload' || current.phase === 'waiting')) cancel('Saving the editor did not finish before the close timeout.')
    }, timeoutMs)
    for (const entry of entries) if (!addTarget(current, entry)) { current.dispatching--; return current.requestId }
    current.dispatching--
    if (!current.targets.size) {
      // This is the normal final-window path after its own successful ACK.
      // An unexpected destroyed frame must never be omitted while still live.
      if (!activeWrites && reason === 'quit') beginShutdown()
    } else complete()
    return current.requestId
  }
  const requestWindow = (entry: Registered) => {
    if (shuttingDown) return null
    if (reloadLanding) {
      if (entry.afterReload !== 'quit') entry.afterReload = 'window'
      return reloadLanding.requestId
    }
    if (attempt?.reason === 'reload') cancel('Window close replaced the pending editor reload.')
    if (attempt?.targets.has(entry)) return attempt.requestId
    if (attempt?.reason === 'quit') { addTarget(attempt, entry); return attempt?.requestId ?? null }
    const entries = attempt ? [...attempt.targets.keys(), entry] : [entry]
    if (attempt) cancel('The set of closing editor windows changed.')
    return start('window', entries)
  }
  const requestQuit = () => {
    if (shuttingDown) return null
    if (reloadLanding) {
      reloadLanding.entry.afterReload = 'quit'
      return reloadLanding.requestId
    }
    if (attempt?.reason === 'quit') return attempt.requestId
    if (attempt) cancel('Application quit replaced the window close request.')
    return start('quit', [...windows.values()].filter(entry => !entry.window.isDestroyed()))
  }
  const mutationAllowed = (event: EditorCloseIpcEvent) => {
    const entry = currentEntry(event)
    if (!entry || shuttingDown) return false
    // A navigation start does not yet establish the new realm's listeners.
    if (reloadLanding?.entry === entry) return false
    const target = attempt?.targets.get(entry)
    return !target || target.state === 'waiting'
  }
  const assertEditorMutationAllowed = (event: EditorCloseIpcEvent) => {
    if (!mutationAllowed(event)) throw new Error('Editor writes are frozen after close acknowledgement; wait for cancellation or close.')
  }
  return {
    registerWindow(window) {
      if (windows.has(window)) return
      if (shuttingDown) throw new Error('Cannot register an editor after service shutdown begins.')
      const entry: Registered = { window, contents: window.webContents, lifecycle: 0, writes: 0, approvedClose: null, approvedReload: null, afterReload: null }
      windows.set(window, entry); contents.set(entry.contents, entry)
      const closed = () => {
        const current = attempt, target = current?.targets.get(entry)
        windows.delete(window); contents.delete(entry.contents)
        if (reloadLanding?.entry === entry) reloadLanding = null
        if (target && current?.phase === 'closing' && entry.approvedClose === current.requestId) { target.state = 'closed'; finishWindowAttempt() }
        else if (target && !shuttingDown) cancel('The editor exited before its close request completed.')
        for (const [emitter, event, listener] of listeners) emitter.removeListener(event, listener)
      }
      const invalidated = (navigation = false) => {
        entry.lifecycle++
        const expectedWindowClose = attempt?.phase === 'closing' && entry.approvedClose === attempt.requestId
        if (!shuttingDown && (navigation || !expectedWindowClose) && attempt?.targets.has(entry)) cancel('The editor reloaded or exited before close completed.')
      }
      const close = (event: { preventDefault(): void }) => {
        if (shuttingDown) return
        if (attempt?.phase === 'closing' && entry.approvedClose === attempt.requestId) {
          const target = attempt.targets.get(entry)
          if (target && sameFrame(entry, target.frame)) return
          event.preventDefault(); cancel('The editor frame changed before its window closed.'); return
        }
        event.preventDefault(); requestWindow(entry)
      }
      const navigation = (_event: unknown, _url: unknown, inPlace: unknown, mainFrame: unknown) => {
        if (mainFrame !== true) return
        if (attempt?.reason === 'reload' && attempt.phase === 'reloading' && entry.approvedReload === attempt.requestId) {
          if (inPlace === true) return // A hash change cannot unfreeze the realm awaiting its admitted full reload.
          // The actual Main call has begun navigation. No old-frame cancel or
          // ACK is sent; its complete saved realm remains frozen until gone.
          entry.lifecycle++; entry.approvedReload = null
          clearTimer(attempt.timer); attempt = null
          return
        }
        invalidated(true)
      }
      const exited = () => { invalidated(); if (reloadLanding?.entry === entry) reloadLanding = null }
      const listeners: Array<[EditorCloseWindow | EditorCloseWebContents, string, (...args: any[]) => void]> = [
        [window,'close',close], [window,'closed',closed], [entry.contents,'did-start-navigation',navigation],
        [entry.contents,'render-process-gone',exited], [entry.contents,'destroyed',exited]
      ]
      for (const [emitter, event, listener] of listeners) emitter.on(event, listener)
      if (attempt?.reason === 'quit' && !shuttingDown) addTarget(attempt, entry)
    },
    requestQuit,
    requestReload(event, ignoreCache = false) {
      const entry = currentEntry(event)
      if (!entry || shuttingDown || !options.reloadEditor || typeof ignoreCache !== 'boolean') return null
      // A repeated key/menu request never extends the deadline, upgrades cache
      // mode or replaces an already admitted close/quit action.
      if (reloadLanding) return reloadLanding.requestId
      if (attempt) return attempt.requestId
      return start('reload', [entry], ignoreCache)
    },
    replayPending(event) {
      const entry = currentEntry(event)
      if (!attempt && entry && reloadLanding?.entry === entry && !shuttingDown) {
        reloadLanding = null
        const queued = [...windows.values()].filter(item => item.afterReload !== null && !item.window.isDestroyed())
        const quit = queued.some(item => item.afterReload === 'quit')
        for (const item of queued) item.afterReload = null
        if (quit) return requestQuit() !== null
        if (queued.length) return start('window', queued) !== null
      }
      const current = attempt
      if (!current || !entry || shuttingDown || current.phase !== 'waiting') return false
      const target = current.targets.get(entry)
      if (!target || target.state !== 'waiting' || !sameFrame(entry, target.frame)) return false
      // A real preload listener is now installed in this exact current frame.
      // Replay the original live attempt; do not mint a request or an ACK.
      current.dispatching++
      try { send(entry, EDITOR_CLOSE_REQUEST_CHANNEL, { requestId: current.requestId, reason: current.reason }) }
      catch { cancel('The ready editor frame could not receive its pending close request.'); return false }
      finally { current.dispatching-- }
      if (attempt === current) complete()
      return attempt === current
    },
    acknowledge(event, input) {
      const value = acknowledgement(input), current = attempt, entry = currentEntry(event)
      if (!value || !current || shuttingDown || current.phase !== 'waiting' || value.requestId !== current.requestId || !entry) return false
      const target = current.targets.get(entry)
      if (!target || target.state !== 'waiting' || !sameFrame(entry, target.frame)) return false
      if (value.status === 'blocked') { cancel(value.message || 'The editor has changes that could not be saved.'); return true }
      if (entry.writes) { cancel('Editor writes are still running; finish them before closing.'); return false }
      if (value.status === 'draft-journaled') {
        const receipt = target.receipt
        if (!current.workspace || !receipt || receipt.receiptId !== value.receiptId || receipt.closeGeneration !== value.closeGeneration) return false
        try {
          if (!options.confirmRecoveryReceipt?.(current.workspace, receipt)) {
            cancel('Editor recovery changed before close admission completed.'); return false
          }
        } catch { cancel('The editor recovery journal could not be verified.'); return false }
      }
      target.state = 'flushed'; complete(); return true
    },
    journalRecoveryDrafts(event, input, write) {
      const current = attempt, entry = currentEntry(event), close = input.close
      const target = entry ? current?.targets.get(entry) : undefined
      if (!current?.workspace || !entry || shuttingDown || current.phase !== 'waiting' || !target || target.state !== 'waiting'
        || !sameFrame(entry, target.frame) || close?.requestId !== current.requestId
        || input.workspace.workspaceScope !== current.workspace.workspaceScope || input.workspace.recoveryEpoch !== current.workspace.recoveryEpoch
        || close.closeGeneration <= (target.receipt?.closeGeneration ?? 0)) throw new Error('The editor recovery close token is stale or unavailable.')
      const receipt = write()
      target.receipt = receipt
      return receipt
    },
    assertEditorMutationAllowed,
    async runEditorMutation(event, operation) {
      assertEditorMutationAllowed(event)
      const entry = currentEntry(event)!
      entry.writes++; activeWrites++
      try { return await operation() }
      finally {
        entry.writes--; activeWrites--
        if (attempt?.reason === 'quit' && !attempt.targets.size && !activeWrites) beginShutdown()
      }
    },
    isShuttingDown: () => shuttingDown
  }
}
