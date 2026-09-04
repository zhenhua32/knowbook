import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode
} from 'react'
import type { PluginJsonValue } from '@shared/plugin-platform'
import {
  readPluginFrameAction,
  readPluginFrameReadiness
} from '@shared/plugin-frame-protocol'
import type {
  PluginUiContribution,
  PluginUiSlot,
  PluginViewAction,
  PluginViewNode,
  RunPluginUiActionInput
} from '@shared/plugin-ui'
import {
  useFullTrustSlotContributions,
  type FullTrustReactSlotContribution
} from '../full-trust-plugin-registry'

export type PluginUiContext = NonNullable<RunPluginUiActionInput['context']>

type PluginSlotProps = {
  contributions?: PluginUiContribution[]
  slot: PluginUiSlot
  context?: PluginUiContext
  className?: string
}

const MAX_PENDING_IFRAME_ACTIONS = 8
const MAX_IFRAME_ACTIONS_PER_MINUTE = 120

export function PluginSlot({ contributions = [], slot, context, className }: PluginSlotProps) {
  const visible = useMemo(
    () => contributions.filter((contribution) => contribution.slot === slot),
    [contributions, slot]
  )
  const fullTrustContributions = useFullTrustSlotContributions(slot)
  if (visible.length === 0 && fullTrustContributions.length === 0) return null
  return (
    <section
      aria-label={`Plugin slot ${slot}`}
      className={`plugin-slot plugin-slot-${slot.replaceAll('.', '-')}${className ? ` ${className}` : ''}`}
      data-plugin-slot={slot}
      data-plugin-slot-version="1"
    >
      {visible.map((contribution) => (
        <PluginContributionBoundary
          contributionId={contribution.id}
          key={`${contribution.owner.runId}:${contribution.owner.epoch}:${contribution.id}`}
        >
          <PluginContributionView contribution={contribution} context={context} />
        </PluginContributionBoundary>
      ))}
      {fullTrustContributions.map((contribution) => (
        <PluginContributionBoundary
          contributionId={`${contribution.plugin.id}:${contribution.id}`}
          key={`${contribution.plugin.id}:${contribution.plugin.revisionHash}:${contribution.id}`}
        >
          <FullTrustContributionView contribution={contribution} context={context} />
        </PluginContributionBoundary>
      ))}
    </section>
  )
}

function FullTrustContributionView({
  contribution,
  context
}: {
  contribution: FullTrustReactSlotContribution
  context?: PluginUiContext
}) {
  const Contribution = contribution.component
  return (
    <div
      className="plugin-view plugin-full-trust-view"
      data-full-trust-plugin={contribution.plugin.id}
      data-full-trust-plugin-revision={contribution.plugin.revisionHash}
      data-plugin-contribution={contribution.id}
    >
      <Contribution plugin={contribution.plugin} slot={contribution.slot} context={context} />
    </div>
  )
}

function PluginContributionView({
  contribution,
  context
}: {
  contribution: PluginUiContribution
  context?: PluginUiContext
}) {
  const runAction = async (
    action: PluginViewAction,
    control?: RunPluginUiActionInput['control']
  ): Promise<PluginJsonValue> => {
    const response = await window.knowbook.runPluginUiAction({
      owner: contribution.owner,
      slot: contribution.slot,
      contributionId: contribution.id,
      handler: action.handler,
      ...(action.arguments === undefined ? {} : { arguments: action.arguments }),
      ...(control === undefined ? {} : { control }),
      ...(context === undefined ? {} : { context })
    })
    return response.result
  }
  if (contribution.value.kind === 'iframe') {
    return <PluginSandboxFrame contribution={contribution} context={context} />
  }
  return (
    <div className="plugin-view" data-plugin-contribution={contribution.id}>
      <PluginViewNodeRenderer node={contribution.value.view.root} runAction={runAction} />
    </div>
  )
}

function PluginViewNodeRenderer({
  node,
  runAction
}: {
  node: PluginViewNode
  runAction: (action: PluginViewAction, control?: RunPluginUiActionInput['control']) => Promise<PluginJsonValue>
}): ReactNode {
  switch (node.type) {
    case 'stack':
    case 'row':
      return <div className={`plugin-view-${node.type}`} style={{ gap: node.gap }}>{node.children.map((child, index) => <PluginViewNodeRenderer key={index} node={child} runAction={runAction} />)}</div>
    case 'grid':
      return <div className="plugin-view-grid" style={{ gap: node.gap, gridTemplateColumns: `repeat(${node.columns ?? 2}, minmax(0, 1fr))` }}>{node.children.map((child, index) => <PluginViewNodeRenderer key={index} node={child} runAction={runAction} />)}</div>
    case 'divider':
      return <hr className="plugin-view-divider" />
    case 'scroll':
      return <div className="plugin-view-scroll" style={{ maxHeight: node.maxHeight }}><PluginViewNodeRenderer node={node.child} runAction={runAction} /></div>
    case 'text':
      return <p className={`plugin-view-text tone-${node.tone ?? 'default'} size-${node.size ?? 'medium'}`}>{node.text}</p>
    case 'markdown':
      return <pre className="plugin-view-markdown">{node.markdown}</pre>
    case 'badge':
      return <span className={`plugin-view-badge tone-${node.tone ?? 'default'}`}>{node.label}</span>
    case 'icon':
      return <span aria-label={node.label ?? node.name} className="plugin-view-icon" role="img">{iconGlyph(node.name)}</span>
    case 'image':
      return <img alt={node.alt} className="plugin-view-image" height={node.height} src={node.src} width={node.width} />
    case 'empty-state':
      return <div className="plugin-view-empty"><strong>{node.title}</strong>{node.description ? <p>{node.description}</p> : null}</div>
    case 'button':
      return <PluginActionButton action={node.action} label={node.label} runAction={runAction} variant={node.variant} />
    case 'text-field':
    case 'textarea':
    case 'date':
    case 'checkbox':
    case 'select':
      return <PluginControlNode node={node} runAction={runAction} />
    case 'list':
      return <ul className="plugin-view-list">{node.items.map((item, index) => <li key={index}><PluginViewNodeRenderer node={item} runAction={runAction} /></li>)}</ul>
    case 'table':
      return <div className="plugin-view-table-wrap"><table className="plugin-view-table"><thead><tr>{node.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{node.rows.map((row, rowIndex) => <tr key={rowIndex}>{node.columns.map((column) => <td key={column.key}>{displayJson(row[column.key])}</td>)}</tr>)}</tbody></table></div>
    case 'stat':
      return <div className="plugin-view-stat"><span>{node.label}</span><strong>{node.value}</strong>{node.trend ? <small>{node.trend}</small> : null}</div>
    case 'progress':
      return <label className="plugin-view-progress">{node.label ? <span>{node.label}</span> : null}<progress max={100} value={node.value} /></label>
    case 'simple-chart': {
      const max = Math.max(1, ...node.points.map((point) => Math.abs(point.value)))
      return <figure aria-label={node.label ?? 'Chart'} className="plugin-view-chart">{node.label ? <figcaption>{node.label}</figcaption> : null}{node.points.map((point) => <div className="plugin-view-chart-row" key={point.label}><span>{point.label}</span><i style={{ '--plugin-chart-value': `${Math.abs(point.value) / max * 100}%` } as CSSProperties}>{point.value}</i></div>)}</figure>
    }
    case 'loading':
      return <p aria-live="polite" className="plugin-view-loading">{node.label ?? 'Loading…'}</p>
    case 'error':
      return <div className="plugin-view-error" role="alert"><strong>{node.title}</strong><p>{node.message}</p></div>
    case 'confirmation':
      return <div className="plugin-view-confirmation"><strong>{node.title}</strong><p>{node.message}</p><div className="plugin-view-row"><PluginActionButton action={node.confirmAction} label={node.confirmLabel ?? 'Confirm'} runAction={runAction} variant="primary" />{node.cancelAction ? <PluginActionButton action={node.cancelAction} label={node.cancelLabel ?? 'Cancel'} runAction={runAction} variant="secondary" /> : null}</div></div>
  }
}

function PluginActionButton({ action, label, runAction, variant = 'secondary' }: {
  action: PluginViewAction
  label: string
  variant?: 'primary' | 'secondary' | 'danger'
  runAction: (action: PluginViewAction) => Promise<PluginJsonValue>
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return <span className="plugin-view-action"><button className={`plugin-action-${variant}`} disabled={pending} onClick={() => {
    setPending(true)
    setError(null)
    void runAction(action).catch((reason: unknown) => setError(errorMessage(reason))).finally(() => setPending(false))
  }} type="button">{pending ? '…' : label}</button>{error ? <small role="alert">{error}</small> : null}</span>
}

function PluginControlNode({ node, runAction }: {
  node: Extract<PluginViewNode, { type: 'text-field' | 'textarea' | 'date' | 'checkbox' | 'select' }>
  runAction: (action: PluginViewAction, control?: RunPluginUiActionInput['control']) => Promise<PluginJsonValue>
}) {
  const initial: string | boolean = node.type === 'checkbox' ? (node.checked ?? false) : (node.value ?? '')
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const commit = (next: string | boolean) => {
    setValue(next)
    if (!node.action) return
    setError(null)
    void runAction(node.action, { id: node.id, value: next }).catch((reason: unknown) => setError(errorMessage(reason)))
  }
  let control: ReactNode
  if (node.type === 'checkbox') {
    control = <input checked={Boolean(value)} onChange={(event) => commit(event.currentTarget.checked)} type="checkbox" />
  } else if (node.type === 'select') {
    control = <select onChange={(event) => commit(event.currentTarget.value)} value={String(value)}>{node.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
  } else if (node.type === 'textarea') {
    control = <textarea onBlur={(event) => commit(event.currentTarget.value)} onChange={(event) => setValue(event.currentTarget.value)} placeholder={node.placeholder} value={String(value)} />
  } else {
    control = <input onBlur={(event) => commit(event.currentTarget.value)} onChange={(event) => setValue(event.currentTarget.value)} placeholder={node.placeholder} type={node.type === 'date' ? 'date' : 'text'} value={String(value)} />
  }
  return <label className="plugin-view-control"><span>{node.label}</span>{control}{error ? <small role="alert">{error}</small> : null}</label>
}

function PluginSandboxFrame({ contribution, context }: {
  contribution: Extract<PluginUiContribution, { value: { kind: 'iframe' } }> | PluginUiContribution
  context?: PluginUiContext
}) {
  if (contribution.value.kind !== 'iframe') return null
  const frameRef = useRef<HTMLIFrameElement>(null)
  const portRef = useRef<MessagePort | null>(null)
  const readyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const failureReportedRef = useRef(false)
  const pendingActionIdsRef = useRef(new Set<string>())
  const actionTimesRef = useRef<number[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => () => {
    if (readyTimeoutRef.current) clearTimeout(readyTimeoutRef.current)
    portRef.current?.close()
    portRef.current = null
    pendingActionIdsRef.current.clear()
    actionTimesRef.current = []
  }, [contribution.owner.runId, contribution.owner.epoch])
  const reportFailure = (message: string) => {
    if (failureReportedRef.current) return
    failureReportedRef.current = true
    const normalized = message.slice(0, 2_000)
    setError(normalized)
    void window.knowbook.reportPluginUiRuntimeFailure({
      owner: contribution.owner,
      contributionId: contribution.id,
      error: normalized
    }).catch((reason: unknown) => setError(errorMessage(reason)))
  }
  const connect = () => {
    failureReportedRef.current = false
    pendingActionIdsRef.current.clear()
    actionTimesRef.current = []
    if (readyTimeoutRef.current) clearTimeout(readyTimeoutRef.current)
    portRef.current?.close()
    const frameWindow = frameRef.current?.contentWindow
    if (!frameWindow) return
    const channel = new MessageChannel()
    portRef.current = channel.port1
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const address = {
        owner: contribution.owner,
        contributionId: contribution.id,
        slot: contribution.slot
      }
      const readiness = readPluginFrameReadiness(event.data, address)
      if (readiness?.status === 'ready') {
        if (readyTimeoutRef.current) clearTimeout(readyTimeoutRef.current)
        readyTimeoutRef.current = null
        return
      }
      if (readiness?.status === 'failed') {
        reportFailure(readiness.error)
        return
      }
      const request = readPluginFrameAction(event.data, address)
      if (!request) return
      const now = Date.now()
      actionTimesRef.current = actionTimesRef.current.filter((timestamp) => timestamp > now - 60_000)
      if (
        pendingActionIdsRef.current.has(request.requestId)
        || pendingActionIdsRef.current.size >= MAX_PENDING_IFRAME_ACTIONS
        || actionTimesRef.current.length >= MAX_IFRAME_ACTIONS_PER_MINUTE
      ) {
        const message = 'Plugin iframe action rate or concurrency limit exceeded.'
        channel.port1.postMessage({
          type: 'knowbook:action-error',
          owner: contribution.owner,
          contributionId: contribution.id,
          slot: contribution.slot,
          requestId: request.requestId,
          error: message
        })
        reportFailure(message)
        return
      }
      pendingActionIdsRef.current.add(request.requestId)
      actionTimesRef.current.push(now)
      void window.knowbook.runPluginUiAction({
        owner: contribution.owner,
        slot: contribution.slot,
        contributionId: contribution.id,
        handler: request.handler,
        ...(request.arguments === undefined ? {} : { arguments: request.arguments }),
        ...(request.control === undefined ? {} : { control: request.control }),
        ...(context === undefined ? {} : { context })
      }).then(({ result }) => {
        channel.port1.postMessage({
          type: 'knowbook:action-result',
          owner: contribution.owner,
          contributionId: contribution.id,
          slot: contribution.slot,
          requestId: request.requestId,
          result
        })
      }).catch((reason: unknown) => {
        setError(errorMessage(reason))
        channel.port1.postMessage({
          type: 'knowbook:action-error',
          owner: contribution.owner,
          contributionId: contribution.id,
          slot: contribution.slot,
          requestId: request.requestId,
          error: 'Action failed.'
        })
      }).finally(() => {
        pendingActionIdsRef.current.delete(request.requestId)
      })
    }
    channel.port1.start()
    frameWindow.postMessage({ type: 'knowbook:init', owner: contribution.owner, contributionId: contribution.id, slot: contribution.slot }, '*', [channel.port2])
    readyTimeoutRef.current = setTimeout(() => {
      reportFailure('Plugin iframe ready handshake timed out after activation.')
    }, 8_000)
  }
  return <div className="plugin-sandbox"><iframe aria-label={contribution.value.title} height={contribution.value.height} onError={() => reportFailure('Plugin iframe failed to load after activation.')} onLoad={connect} ref={frameRef} referrerPolicy="no-referrer" sandbox="allow-scripts" src={contribution.value.src} title={contribution.value.title} />{error ? <p role="alert">{error}</p> : null}</div>
}

class PluginContributionBoundary extends Component<{
  contributionId: string
  children: ReactNode
}, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(`Plugin UI contribution ${this.props.contributionId} failed to render.`, error, info)
  }

  render(): ReactNode {
    return this.state.failed
      ? <p className="plugin-view-error" role="alert">Plugin view unavailable.</p>
      : this.props.children
  }
}

function displayJson(value: PluginJsonValue | undefined): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function iconGlyph(name: Extract<PluginViewNode, { type: 'icon' }>['name']): string {
  return ({ book: '▤', calendar: '▦', check: '✓', database: '▥', document: '▧', info: 'ⓘ', sparkles: '✦', warning: '⚠' })[name]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Plugin action failed.'
}
