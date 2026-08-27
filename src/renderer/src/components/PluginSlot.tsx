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
import type {
  PluginUiContribution,
  PluginUiSlot,
  PluginViewAction,
  PluginViewNode,
  RunPluginUiActionInput
} from '@shared/plugin-ui'

export type PluginUiContext = NonNullable<RunPluginUiActionInput['context']>

type PluginSlotProps = {
  contributions?: PluginUiContribution[]
  slot: PluginUiSlot
  context?: PluginUiContext
  className?: string
}

export function PluginSlot({ contributions = [], slot, context, className }: PluginSlotProps) {
  const visible = useMemo(
    () => contributions.filter((contribution) => contribution.slot === slot),
    [contributions, slot]
  )
  if (visible.length === 0) return null
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
    </section>
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
  const [error, setError] = useState<string | null>(null)
  useEffect(() => () => {
    portRef.current?.close()
    portRef.current = null
  }, [contribution.owner.runId, contribution.owner.epoch])
  const connect = () => {
    portRef.current?.close()
    const frameWindow = frameRef.current?.contentWindow
    if (!frameWindow) return
    const channel = new MessageChannel()
    portRef.current = channel.port1
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const request = readFrameAction(event.data, contribution)
      if (!request) return
      void window.knowbook.runPluginUiAction({
        owner: contribution.owner,
        slot: contribution.slot,
        contributionId: contribution.id,
        handler: request.handler,
        ...(request.arguments === undefined ? {} : { arguments: request.arguments }),
        ...(request.control === undefined ? {} : { control: request.control }),
        ...(context === undefined ? {} : { context })
      }).then(({ result }) => {
        channel.port1.postMessage({ type: 'knowbook:action-result', owner: contribution.owner, requestId: request.requestId, result })
      }).catch((reason: unknown) => {
        setError(errorMessage(reason))
        channel.port1.postMessage({ type: 'knowbook:action-error', owner: contribution.owner, requestId: request.requestId, error: 'Action failed.' })
      })
    }
    channel.port1.start()
    frameWindow.postMessage({ type: 'knowbook:init', owner: contribution.owner, contributionId: contribution.id, slot: contribution.slot }, '*', [channel.port2])
  }
  return <div className="plugin-sandbox"><iframe aria-label={contribution.value.title} height={contribution.value.height} onLoad={connect} ref={frameRef} referrerPolicy="no-referrer" sandbox="allow-scripts" srcDoc={contribution.value.srcdoc} title={contribution.value.title} />{error ? <p role="alert">{error}</p> : null}</div>
}

function readFrameAction(value: unknown, contribution: PluginUiContribution): {
  requestId: string
  handler: string
  arguments?: PluginJsonValue
  control?: RunPluginUiActionInput['control']
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const allowed = new Set(['type', 'owner', 'contributionId', 'requestId', 'handler', 'arguments', 'control'])
  if (Object.keys(candidate).some((key) => !allowed.has(key))) return null
  if (candidate.type !== 'knowbook:action' || candidate.contributionId !== contribution.id) return null
  if (typeof candidate.requestId !== 'string' || candidate.requestId.length === 0 || candidate.requestId.length > 200) return null
  if (typeof candidate.handler !== 'string' || candidate.handler.length === 0 || candidate.handler.length > 200) return null
  if (!sameOwner(candidate.owner, contribution.owner)) return null
  if (!isJson(candidate.arguments) || !isControl(candidate.control)) return null
  return {
    requestId: candidate.requestId,
    handler: candidate.handler,
    ...(candidate.arguments === undefined ? {} : { arguments: candidate.arguments }),
    ...(candidate.control === undefined ? {} : { control: candidate.control })
  }
}

function sameOwner(value: unknown, expected: PluginUiContribution['owner']): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate.pluginId === expected.pluginId
    && candidate.revisionId === expected.revisionId
    && candidate.runId === expected.runId
    && candidate.grantSetId === expected.grantSetId
    && candidate.epoch === expected.epoch
    && JSON.stringify(candidate.scope) === JSON.stringify(expected.scope)
}

function isControl(value: unknown): value is RunPluginUiActionInput['control'] | undefined {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return Object.keys(candidate).every((key) => key === 'id' || key === 'value')
    && typeof candidate.id === 'string'
    && candidate.id.length > 0
    && candidate.id.length <= 200
    && isJson(candidate.value)
}

function isJson(value: unknown): value is PluginJsonValue | undefined {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 1_000 && value.every(isJson)
  if (typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).length <= 1_000
    && Object.entries(value as Record<string, unknown>).every(([key, child]) => key.length <= 500 && isJson(child))
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
