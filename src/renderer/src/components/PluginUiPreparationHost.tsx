import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import type {
  PluginUiPreparationRequest,
  PluginUiPreparationResult
} from '@shared/plugin-ui'
import type { PluginUiPreparationBatchProps } from './PluginUiPreparationBatch'

const FRAME_READY_TIMEOUT_MS = 8_000
const HANDSHAKE_TIMEOUT_ERROR = 'Plugin iframe ready handshake timed out.'
type BatchModule = { default: ComponentType<PluginUiPreparationBatchProps> }
const loadPreparationBatch = () => import('./PluginUiPreparationBatch')
type PendingRequest = { request: PluginUiPreparationRequest; deadline: number; timer: ReturnType<typeof setTimeout> | null }

export function PluginUiPreparationHost({ loadBatch = loadPreparationBatch }: { loadBatch?: () => Promise<BatchModule> }) {
  const [requests, setRequests] = useState<PluginUiPreparationRequest[]>([])
  const [Batch, setBatch] = useState<BatchModule['default'] | null>(null)
  const pending = useRef(new Map<string, PendingRequest>())
  const completed = useRef(new Set<string>())
  const loading = useRef<Promise<BatchModule> | null>(null)
  const mounted = useRef(false)

  const finish = useCallback((result: PluginUiPreparationResult) => {
    const entry = pending.current.get(result.requestId)
    if (!mounted.current || !entry) return
    pending.current.delete(result.requestId)
    if (entry.timer !== null) clearTimeout(entry.timer)
    completed.current.add(result.requestId)
    // Keep replay protection bounded over long-running workspaces.
    if (completed.current.size > 128) completed.current.delete(completed.current.values().next().value!)
    setRequests((current) => current.filter((request) => request.requestId !== result.requestId))
    // The main-process deadline can already have expired, or the window can be closing.
    const report = result.status === 'ready' && Date.now() >= entry.deadline
      ? { ...result, status: 'failed' as const, error: HANDSHAKE_TIMEOUT_ERROR }
      : result
    void window.knowbook.reportPluginUiPreparation(report).catch(() => {})
  }, [])

  useEffect(() => {
    mounted.current = true
    const armDeadline = (entry: PendingRequest) => {
      entry.timer = setTimeout(() => finish({
        requestId: entry.request.requestId, identity: entry.request.identity,
        status: 'failed', error: HANDSHAKE_TIMEOUT_ERROR
      }), Math.max(0, entry.deadline - Date.now()))
    }
    // StrictMode replays this subscription; preserve the original request deadline.
    for (const entry of pending.current.values()) armDeadline(entry)
    const unsubscribe = window.knowbook.onPluginUiPreparation((request) => {
      if (pending.current.has(request.requestId) || completed.current.has(request.requestId)) return
      const entry: PendingRequest = { request, deadline: Date.now() + FRAME_READY_TIMEOUT_MS, timer: null }
      pending.current.set(request.requestId, entry)
      if (request.frames.length === 0) {
        finish({ requestId: request.requestId, identity: request.identity, status: 'ready' })
      } else {
        armDeadline(entry)
        setRequests((current) => [...current, request])
      }
    })
    return () => {
      mounted.current = false
      unsubscribe()
      for (const entry of pending.current.values()) {
        if (entry.timer !== null) clearTimeout(entry.timer)
        entry.timer = null
      }
    }
  }, [finish])

  useEffect(() => {
    if (requests.length === 0 || Batch) return
    let active = true
    const promise = loading.current ??= Promise.resolve().then(loadBatch)
    void promise.then((module) => {
      if (active) setBatch(() => module.default)
    }).catch(() => {
      if (loading.current === promise) loading.current = null
      if (!active) return
      for (const { request } of [...pending.current.values()]) finish({
        requestId: request.requestId, identity: request.identity,
        status: 'failed', error: 'Plugin iframe preparation component failed to load.'
      })
    })
    return () => { active = false }
  }, [Batch, finish, loadBatch, requests.length])

  return (
    <div
      aria-hidden="true"
      data-plugin-ui-preparation-host="true"
      style={{ height: 1, left: -10_000, opacity: 0, overflow: 'hidden', pointerEvents: 'none', position: 'fixed', top: 0, width: 1 }}
    >
      {Batch && requests.map((request) => (
        <Batch finish={finish} key={request.requestId} request={request} />
      ))}
    </div>
  )
}
