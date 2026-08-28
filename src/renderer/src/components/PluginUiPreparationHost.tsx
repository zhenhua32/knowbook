import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PluginUiPreparationFrame,
  PluginUiPreparationRequest,
  PluginUiPreparationResult
} from '@shared/plugin-ui'
import { readPluginFrameReadiness } from '@shared/plugin-frame-protocol'

const FRAME_READY_TIMEOUT_MS = 8_000

export function PluginUiPreparationHost() {
  const [requests, setRequests] = useState<PluginUiPreparationRequest[]>([])

  useEffect(() => window.knowbook.onPluginUiPreparation((request) => {
    setRequests((current) => [
      ...current.filter((candidate) => candidate.requestId !== request.requestId),
      request
    ])
  }), [])

  const finish = useCallback((result: PluginUiPreparationResult) => {
    void window.knowbook.reportPluginUiPreparation(result).finally(() => {
      setRequests((current) => current.filter((request) => request.requestId !== result.requestId))
    })
  }, [])

  return (
    <div
      aria-hidden="true"
      data-plugin-ui-preparation-host="true"
      style={{ height: 1, left: -10_000, opacity: 0, overflow: 'hidden', pointerEvents: 'none', position: 'fixed', top: 0, width: 1 }}
    >
      {requests.map((request) => (
        <PluginUiPreparationBatch finish={finish} key={request.requestId} request={request} />
      ))}
    </div>
  )
}

function PluginUiPreparationBatch({
  finish,
  request
}: {
  finish: (result: PluginUiPreparationResult) => void
  request: PluginUiPreparationRequest
}) {
  const ready = useRef(new Set<string>())
  const completed = useRef(false)
  const complete = useCallback((status: 'ready' | 'failed', error?: string) => {
    if (completed.current) return
    completed.current = true
    finish({
      requestId: request.requestId,
      identity: request.identity,
      status,
      ...(error ? { error: error.slice(0, 2_000) } : {})
    })
  }, [finish, request.identity, request.requestId])

  useEffect(() => {
    if (request.frames.length === 0) {
      complete('ready')
      return
    }
    const timeout = setTimeout(() => complete('failed', 'Plugin iframe ready handshake timed out.'), FRAME_READY_TIMEOUT_MS)
    return () => clearTimeout(timeout)
  }, [complete, request.frames.length])

  const markReady = (frame: PluginUiPreparationFrame) => {
    ready.current.add(`${frame.slot}\0${frame.contributionId}`)
    if (ready.current.size === request.frames.length) complete('ready')
  }

  return request.frames.map((frame) => (
    <PluginUiPreparationFrameView
      fail={(error) => complete('failed', error)}
      frame={frame}
      identity={request.identity}
      key={`${frame.slot}:${frame.contributionId}`}
      ready={() => markReady(frame)}
    />
  ))
}

function PluginUiPreparationFrameView({
  fail,
  frame,
  identity,
  ready
}: {
  fail: (error: string) => void
  frame: PluginUiPreparationFrame
  identity: PluginUiPreparationRequest['identity']
  ready: () => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const portRef = useRef<MessagePort | null>(null)
  useEffect(() => () => {
    portRef.current?.close()
    portRef.current = null
  }, [])

  const connect = () => {
    const frameWindow = frameRef.current?.contentWindow
    if (!frameWindow) {
      fail('Plugin iframe window is unavailable.')
      return
    }
    portRef.current?.close()
    const channel = new MessageChannel()
    portRef.current = channel.port1
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const status = readPluginFrameReadiness(event.data, {
        owner: identity,
        contributionId: frame.contributionId,
        slot: frame.slot
      })
      if (!status) return
      if (status.status === 'ready') ready()
      else fail(status.error)
    }
    channel.port1.start()
    frameWindow.postMessage({
      type: 'knowbook:init',
      owner: identity,
      contributionId: frame.contributionId,
      slot: frame.slot
    }, '*', [channel.port2])
  }

  return (
    <iframe
      aria-label={`Preparing ${frame.title}`}
      onError={() => fail('Plugin iframe failed to load.')}
      onLoad={connect}
      ref={frameRef}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
      src={frame.src}
      title={`Preparing ${frame.title}`}
    />
  )
}
