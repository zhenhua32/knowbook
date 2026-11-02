import { randomUUID } from 'node:crypto'
import { EDITOR_CLOSE_REQUEST_CHANNEL, EDITOR_CLOSE_CANCELLED_CHANNEL,
  type EditorCloseReason, type EditorCloseAcknowledgement } from '../shared/editor-close'

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
}
interface Target { readonly registered: Registered; readonly frame: FrameIdentity; state: 'waiting' | 'flushed' | 'closed' }
interface Attempt {
  readonly requestId: string; readonly reason: EditorCloseReason; readonly targets: Map<Registered, Target>
  phase: 'waiting' | 'closing'; timer: unknown; dispatching: number
}
export interface EditorCloseBarrierOptions {
  /** Called once, only after every current editor frame has acknowledged.
   * This begins the existing irreversible services/plugin shutdown policy. */
  beginShutdown: () => void | Promise<void>
  onShutdownError?: (error: unknown) => void
  timeoutMs?: number
  setTimer?: (callback: () => void, milliseconds: number) => unknown
  clearTimer?: (timer: unknown) => void
}
export interface EditorCloseBarrier {
  registerWindow(window: EditorCloseWindow): void
  replayPending(event: EditorCloseIpcEvent): boolean
  requestQuit(): string | null
  acknowledge(event: EditorCloseIpcEvent, input: unknown): boolean
  assertEditorMutationAllowed(event: EditorCloseIpcEvent): void
  runEditorMutation<T>(event: EditorCloseIpcEvent, operation: () => T | Promise<T>): Promise<T>
  isShuttingDown(): boolean
}

function acknowledgement(value: unknown): EditorCloseAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
  if (keys.some(key => typeof key !== 'string' || !['requestId','status','message'].includes(key))
    || !Object.hasOwn(descriptors, 'requestId') || !Object.hasOwn(descriptors, 'status')) return null
  for (const key of keys) {
    const descriptor = descriptors[key as string]
    if (!descriptor.enumerable || !('value' in descriptor)) return null
  }
  const requestId = descriptors.requestId.value, status = descriptors.status.value, message = descriptors.message?.value
  if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId)
    || status !== 'flushed' && status !== 'blocked' || message !== undefined && (typeof message !== 'string' || message.length > 2048)) return null
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
    for (const target of cancelled.targets.values()) {
      if (target.registered.approvedClose === cancelled.requestId) target.registered.approvedClose = null
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
  const start = (reason: EditorCloseReason, entries: readonly Registered[]) => {
    const current: Attempt = { requestId: randomUUID(), reason, targets: new Map(), phase: 'waiting', timer: null, dispatching: 1 }
    attempt = current
    current.timer = setTimer(() => { if (attempt === current) cancel('Saving the editor did not finish before the close timeout.'); }, timeoutMs)
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
    if (attempt?.targets.has(entry)) return attempt.requestId
    if (attempt?.reason === 'quit') { addTarget(attempt, entry); return attempt?.requestId ?? null }
    const entries = attempt ? [...attempt.targets.keys(), entry] : [entry]
    if (attempt) cancel('The set of closing editor windows changed.')
    return start('window', entries)
  }
  const requestQuit = () => {
    if (shuttingDown) return null
    if (attempt?.reason === 'quit') return attempt.requestId
    if (attempt) cancel('Application quit replaced the window close request.')
    return start('quit', [...windows.values()].filter(entry => !entry.window.isDestroyed()))
  }
  const mutationAllowed = (event: EditorCloseIpcEvent) => {
    const entry = currentEntry(event)
    if (!entry || shuttingDown) return false
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
      const entry: Registered = { window, contents: window.webContents, lifecycle: 0, writes: 0, approvedClose: null }
      windows.set(window, entry); contents.set(entry.contents, entry)
      const closed = () => {
        const current = attempt, target = current?.targets.get(entry)
        windows.delete(window); contents.delete(entry.contents)
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
      const navigation = (_event: unknown, _url: unknown, _inPlace: unknown, mainFrame: unknown) => { if (mainFrame === true) invalidated(true) }
      const exited = () => invalidated()
      const listeners: Array<[EditorCloseWindow | EditorCloseWebContents, string, (...args: any[]) => void]> = [
        [window,'close',close], [window,'closed',closed], [entry.contents,'did-start-navigation',navigation],
        [entry.contents,'render-process-gone',exited], [entry.contents,'destroyed',exited]
      ]
      for (const [emitter, event, listener] of listeners) emitter.on(event, listener)
      if (attempt?.reason === 'quit' && !shuttingDown) addTarget(attempt, entry)
    },
    requestQuit,
    replayPending(event) {
      const current = attempt, entry = currentEntry(event)
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
      target.state = 'flushed'; complete(); return true
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
