import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { WebClipExtensionExportResult } from '@shared/contracts'
import { getErrorMessage } from '../utils/errorMessage'

type ActionKind = 'export' | 'open'
type PendingAction = { session: number; view: number; generation: number }
type Snapshot = { exportedExtension: WebClipExtensionExportResult | null; pending: ActionKind | null }
const emptySnapshot: Snapshot = { exportedExtension: null, pending: null }
const getEmptySnapshot = () => emptySnapshot
const subscribeEmpty = (_listener: () => void) => () => {}

function createController(browser: Window) {
  let snapshot = emptySnapshot, generation = 0
  const listeners = new Set<() => void>()
  const publish = (next: Snapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => snapshot,
    getGeneration: () => generation,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: (kind: ActionKind): { generation: number; completion: Promise<boolean> } | null => {
      if (snapshot.pending || (kind === 'open' && !snapshot.exportedExtension)) return null
      const owner = ++generation
      publish({ ...snapshot, pending: kind })
      const completion = (async () => {
        let exportedExtension = snapshot.exportedExtension
        try {
          if (kind === 'export') {
            const result = await browser.knowbook.exportWebClipExtension()
            if (!result) return false
            exportedExtension = result
          } else await browser.knowbook.openWebClipExtensionDirectory()
          return true
        } finally {
          // The operation outlives any settings view; returning subscribers must
          // see the same last successful directory that the main service opens.
          publish({ exportedExtension, pending: null })
        }
      })()
      return { generation: owner, completion }
    }
  }
}

const controllers = new WeakMap<Window, ReturnType<typeof createController>>()
function controllerFor(browser: Window) {
  let controller = controllers.get(browser)
  if (!controller) { controller = createController(browser); controllers.set(browser, controller) }
  return controller
}

export function useWebClipExtensionSetup({ isZh, active }: { isZh: boolean; active: boolean }) {
  const controller = typeof window === 'undefined' ? null : controllerFor(window)
  const { exportedExtension, pending } = useSyncExternalStore(controller?.subscribe ?? subscribeEmpty,
    controller?.getSnapshot ?? getEmptySnapshot, getEmptySnapshot)
  const [error, setError] = useState<{ kind: ActionKind; message: string } | null>(null)
  const [completed, setCompleted] = useState<ActionKind | null>(null)
  const actionRef = useRef<PendingAction | null>(null)
  const mountedRef = useRef(false), sessionRef = useRef(0), viewRef = useRef(0)
  const settingsRef = useRef({ isZh, active })
  settingsRef.current = { isZh, active }

  useLayoutEffect(() => {
    mountedRef.current = true
    sessionRef.current += 1
    return () => {
      mountedRef.current = false
      sessionRef.current += 1
      actionRef.current = null
    }
  }, [])

  useLayoutEffect(() => {
    viewRef.current += 1
    setError(null)
    setCompleted(null)
  }, [active])

  const run = useCallback(async (kind: ActionKind): Promise<void> => {
    if (!controller || !mountedRef.current || !settingsRef.current.active) return
    const operation = controller.start(kind)
    if (!operation) return
    const action = { session: sessionRef.current, view: viewRef.current, generation: operation.generation }
    actionRef.current = action
    setError(null)
    setCompleted(null)
    const isOwner = () => mountedRef.current && sessionRef.current === action.session && actionRef.current === action
    const canPublish = () => isOwner() && settingsRef.current.active && viewRef.current === action.view
      && controller.getGeneration() === action.generation
    try {
      const success = await operation.completion
      if (success && canPublish()) setCompleted(kind)
    } catch (reason) {
      if (canPublish()) {
        const fallback = settingsRef.current.isZh
          ? (kind === 'export' ? '无法导出浏览器扩展，请重试。' : '无法打开导出目录，请重试。')
          : (kind === 'export' ? 'Could not export the browser extension. Retry.' : 'Could not open the export folder. Retry.')
        setError({ kind, message: getErrorMessage(reason, fallback) })
      }
    } finally {
      if (isOwner()) actionRef.current = null
    }
  }, [controller])

  const exportExtension = useCallback(() => run('export'), [run])
  const openDirectory = useCallback(() => run('open'), [run])
  return { exportedExtension, pending, error, completed, exportExtension, openDirectory }
}
