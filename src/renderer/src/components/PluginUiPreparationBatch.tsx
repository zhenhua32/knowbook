import { useCallback, useEffect, useRef } from 'react'
import type { PluginUiPreparationFrame, PluginUiPreparationRequest, PluginUiPreparationResult } from '@shared/plugin-ui'
import { readPluginFrameReadiness } from '@shared/plugin-frame-protocol'

export type PluginUiPreparationBatchProps = {
  finish: (result: PluginUiPreparationResult) => void
  request: PluginUiPreparationRequest
}

export default function PluginUiPreparationBatch({ finish, request }: PluginUiPreparationBatchProps) {
  const ready = useRef(new Set<string>())
  const completed = useRef(false)
  const complete = useCallback((status: 'ready' | 'failed', error?: string) => {
    if (completed.current) return
    completed.current = true
    finish({
      requestId: request.requestId, identity: request.identity, status,
      ...(error ? { error: error.slice(0, 2_000) } : {})
    })
  }, [finish, request.identity, request.requestId])

  const markReady = (frame: PluginUiPreparationFrame) => {
    ready.current.add(`${frame.slot}\0${frame.contributionId}`)
    if (ready.current.size === request.frames.length) complete('ready')
  }

  return request.frames.map((frame) => (
    <PluginUiPreparationFrameView
      fail={(error) => complete('failed', error)} frame={frame} identity={request.identity}
      key={`${frame.slot}:${frame.contributionId}`} ready={() => markReady(frame)}
    />
  ))
}

function PluginUiPreparationFrameView({ fail, frame, identity, ready }: {
  fail: (error: string) => void
  frame: PluginUiPreparationFrame
  identity: PluginUiPreparationRequest['identity']
  ready: () => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const portRef = useRef<MessagePort | null>(null)
  const closePort = () => {
    if (portRef.current) {
      portRef.current.onmessage = null
      portRef.current.close()
      portRef.current = null
    }
  }
  useEffect(() => closePort, [])

  const connect = () => {
    const frameWindow = frameRef.current?.contentWindow
    if (!frameWindow) { fail('Plugin iframe window is unavailable.'); return }
    closePort()
    const channel = new MessageChannel()
    portRef.current = channel.port1
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const status = readPluginFrameReadiness(event.data, {
        owner: identity, contributionId: frame.contributionId, slot: frame.slot
      })
      if (!status) return
      if (status.status === 'ready') ready()
      else fail(status.error)
    }
    channel.port1.start()
    try {
      frameWindow.postMessage({
        type: 'knowbook:init', owner: identity, contributionId: frame.contributionId, slot: frame.slot
      }, '*', [channel.port2])
    } catch {
      channel.port2.close()
      closePort()
      fail('Plugin iframe initialization failed.')
    }
  }

  return (
    <iframe
      aria-label={`Preparing ${frame.title}`} onError={() => fail('Plugin iframe failed to load.')}
      onLoad={connect} ref={frameRef} referrerPolicy="no-referrer" sandbox="allow-scripts"
      src={frame.src} title={`Preparing ${frame.title}`}
    />
  )
}
