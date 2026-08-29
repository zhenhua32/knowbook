import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AssistantApprovalId,
  AssistantEvent,
  AssistantSessionId,
  AssistantSessionSummary
} from '@shared/assistant-session'

type AssistantConversationProps = {
  activeDocumentId: string | null
  aiEnabled: boolean
  hasApiKey: boolean
  isZh: boolean
  initialDraft?: string
  newSessionTitle?: string
}

export function AssistantConversation({
  activeDocumentId,
  aiEnabled,
  hasApiKey,
  isZh,
  initialDraft = '',
  newSessionTitle
}: AssistantConversationProps) {
  const [sessions, setSessions] = useState<AssistantSessionSummary[]>([])
  const [selectedId, setSelectedId] = useState<AssistantSessionId | null>(null)
  const [events, setEvents] = useState<AssistantEvent[]>([])
  const [draft, setDraft] = useState(initialDraft)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refreshSessions = useCallback(async () => {
    const next = await window.knowbook.listAssistantSessions()
    setSessions(next)
    setSelectedId((current) => current && next.some((session) => session.id === current)
      ? current
      : next[0]?.id ?? null)
  }, [])

  const refreshEvents = useCallback(async (sessionId: AssistantSessionId) => {
    const next = await window.knowbook.getAssistantSessionEvents(sessionId, 0, 1_000)
    setEvents(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    void refreshSessions()
      .catch((reason) => {
        if (!cancelled) setError(errorMessage(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshSessions])

  useEffect(() => {
    if (!selectedId) {
      setEvents([])
      return
    }
    void refreshEvents(selectedId).catch((reason) => setError(errorMessage(reason)))
  }, [refreshEvents, selectedId])

  useEffect(() => window.knowbook.onAssistantSessionChanged((change) => {
    void refreshSessions().catch((reason) => setError(errorMessage(reason)))
    if (change.sessionId === selectedId) {
      void refreshEvents(change.sessionId).catch((reason) => setError(errorMessage(reason)))
    }
  }), [refreshEvents, refreshSessions, selectedId])

  const projection = useMemo(() => projectEvents(events), [events])
  const selected = sessions.find((session) => session.id === selectedId) ?? null
  const canUseAi = aiEnabled && hasApiKey

  const createSession = useCallback(async (): Promise<AssistantSessionSummary> => {
    const created = await window.knowbook.createAssistantSession({
      activeDocumentId,
      ...(newSessionTitle ? { title: newSessionTitle } : {})
    })
    setSelectedId(created.id)
    setSessions((current) => [created, ...current.filter((session) => session.id !== created.id)])
    setEvents(await window.knowbook.getAssistantSessionEvents(created.id, 0, 1_000))
    return created
  }, [activeDocumentId, newSessionTitle])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || busy || !canUseAi) return
    setBusy(true)
    setError('')
    setDraft('')
    try {
      const session = selected ?? await createSession()
      const request = window.knowbook.sendAssistantMessage({ sessionId: session.id, text, mode: 'auto' })
      setBusy(false)
      void request
        .then(() => Promise.all([refreshSessions(), refreshEvents(session.id)]))
        .catch((reason) => {
          setDraft((current) => current || text)
          setError(errorMessage(reason))
        })
    } catch (reason) {
      setDraft((current) => current || text)
      setError(errorMessage(reason))
      setBusy(false)
    }
  }, [busy, canUseAi, createSession, draft, refreshEvents, refreshSessions, selected])

  const resolveApproval = useCallback(async (
    approvalId: AssistantApprovalId,
    decision: 'allowed-once' | 'rejected' | 'cancelled'
  ) => {
    if (!selectedId || busy) return
    setBusy(true)
    setError('')
    try {
      const request = window.knowbook.resolveAssistantApproval({ sessionId: selectedId, approvalId, decision })
      setBusy(false)
      void request
        .then(() => Promise.all([refreshSessions(), refreshEvents(selectedId)]))
        .catch((reason) => setError(errorMessage(reason)))
    } catch (reason) {
      setError(errorMessage(reason))
      setBusy(false)
    }
  }, [busy, refreshEvents, refreshSessions, selectedId])

  const cancelTurn = useCallback(async () => {
    if (!selectedId || busy) return
    setBusy(true)
    setError('')
    try {
      await window.knowbook.cancelAssistantTurn(selectedId)
      await Promise.all([refreshSessions(), refreshEvents(selectedId)])
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }, [busy, refreshEvents, refreshSessions, selectedId])

  return (
    <div className="assistant-workbench">
      <div className="assistant-session-toolbar">
        <select
          aria-label={isZh ? '助手对话' : 'Assistant session'}
          className="editor-select assistant-session-select"
          disabled={busy || loading}
          onChange={(event) => setSelectedId((event.target.value || null) as AssistantSessionId | null)}
          value={selectedId ?? ''}
        >
          {sessions.length === 0 ? <option value="">{isZh ? '尚无对话' : 'No sessions yet'}</option> : null}
          {sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
        </select>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setError('')
            void createSession().catch((reason) => setError(errorMessage(reason))).finally(() => setBusy(false))
          }}
          type="button"
        >
          {isZh ? '新对话' : 'New session'}
        </button>
        {selected?.activeTurnId ? (
          <button className="danger-button" disabled={busy} onClick={() => void cancelTurn()} type="button">
            {isZh ? '取消当前任务' : 'Cancel turn'}
          </button>
        ) : null}
      </div>

      <div className="assistant-transcript" aria-live="polite">
        {projection.items.length === 0 ? (
          <p className="mini-hint">
            {isZh
              ? '告诉助手你想怎样改变 KnowBook。它会检查平台能力、生成不可变插件 revision，并在激活前请求你的批准。'
              : 'Describe how you want to change KnowBook. The assistant will define an immutable plugin revision and ask before activation.'}
          </p>
        ) : projection.items.map((item) => (
          item.kind === 'message' ? (
            <div className={`assistant-message assistant-message-${item.role}`} key={item.key}>
              <span>{item.role === 'user' ? (isZh ? '你' : 'You') : 'KnowBook AI'}</span>
              <p>{item.text}</p>
            </div>
          ) : item.kind === 'tool' ? (
            <div className="assistant-tool-event" key={item.key}>
              <code>{item.tool}</code>
              {item.detail ? <small>{item.detail}</small> : null}
              <span>{toolStatusText(item.status, isZh)}</span>
            </div>
          ) : (
            <div className={`assistant-lifecycle-event assistant-lifecycle-${item.status}`} key={item.key}>
              <strong>{assistantEventTitle(item.eventType, isZh)}</strong>
              {item.detail ? <code>{item.detail}</code> : null}
              <span>{toolStatusText(item.status, isZh)}</span>
            </div>
          )
        ))}
        {selected?.activeTurnId ? <p className="mini-hint">{isZh ? '助手任务进行中；继续发送会转向当前任务，审批等待时会排入下一轮。' : 'The turn is active. New messages steer it, or queue behind an approval.'}</p> : null}
      </div>

      {projection.approvals.map((approval) => (
        <div className={`assistant-approval assistant-approval-${approval.payload.risk}`} key={approval.payload.approvalId}>
          <div>
            <strong>{isZh ? '插件激活审批' : 'Plugin activation approval'}</strong>
            <p>{approval.payload.summary}</p>
            <code>{approval.payload.pluginId} · {shortRevision(approval.payload.revisionId)}</code>
            <code>{isZh ? '权限' : 'Permissions'}: {JSON.stringify(approval.payload.permissions)}</code>
            {approval.payload.revisionPreview !== undefined ? (
              <details className="assistant-revision-preview">
                <summary>{isZh ? '查看代码、权限与贡献差异' : 'Review code, permission, and contribution diff'}</summary>
                <pre>{JSON.stringify(approval.payload.revisionPreview, null, 2)}</pre>
              </details>
            ) : null}
          </div>
          <div className="toolbar-inline">
            <button className="primary-button" disabled={busy} onClick={() => void resolveApproval(approval.payload.approvalId, 'allowed-once')} type="button">
              {isZh ? '仅本次允许' : 'Allow once'}
            </button>
            <button className="secondary-button" disabled={busy} onClick={() => void resolveApproval(approval.payload.approvalId, 'rejected')} type="button">
              {isZh ? '拒绝' : 'Reject'}
            </button>
          </div>
        </div>
      ))}

      {!canUseAi ? (
        <p className="mini-hint ai-context-error">
          {isZh ? '请先在设置中启用 AI 并保存 API Key。' : 'Enable AI and save an API key in Settings first.'}
        </p>
      ) : null}
      {error ? <p className="mini-hint ai-context-error">{error}</p> : null}
      <div className="assistant-composer">
        <textarea
          className="editor-textarea"
          disabled={!canUseAi}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder={isZh ? '例如：做一个首页卡片，显示最近编辑的文档…' : 'For example: add a dashboard card for recently edited notes…'}
          rows={3}
          value={draft}
        />
        <button className="primary-button" disabled={busy || !canUseAi || !draft.trim()} onClick={() => void send()} type="button">
          {busy ? (isZh ? '执行中' : 'Working') : (isZh ? '发送' : 'Send')}
        </button>
      </div>
    </div>
  )
}

type ProjectionItem =
  | { kind: 'message'; key: string; role: 'user' | 'assistant'; text: string; streaming?: boolean }
  | { kind: 'tool'; key: string; tool: string; status: string; detail?: string }
  | { kind: 'lifecycle'; key: string; eventType: AssistantEvent['type']; status: string; detail: string }

export function projectEvents(events: readonly AssistantEvent[]): {
  items: ProjectionItem[]
  approvals: Array<Extract<AssistantEvent, { type: 'approval.requested' }>>
} {
  const items: ProjectionItem[] = []
  const toolNames = new Map<string, string>()
  const toolIndexes = new Map<string, number>()
  const streamingIndexes = new Map<string, number>()
  const pending = new Map<string, Extract<AssistantEvent, { type: 'approval.requested' }>>()
  for (const event of events) {
    if (event.type === 'user.message') {
      items.push({
        kind: 'message',
        key: event.id,
        role: 'user',
        text: event.payload.text
      })
    } else if (event.type === 'assistant.chunk') {
      const index = streamingIndexes.get(event.payload.stepId)
      if (index === undefined) {
        streamingIndexes.set(event.payload.stepId, items.length)
        items.push({ kind: 'message', key: `stream-${event.payload.stepId}`, role: 'assistant', text: event.payload.text, streaming: true })
      } else {
        const item = items[index]
        if (item?.kind === 'message') item.text += event.payload.text
      }
    } else if (event.type === 'assistant.message') {
      const index = streamingIndexes.get(event.payload.stepId)
      if (index === undefined) {
        items.push({ kind: 'message', key: event.id, role: 'assistant', text: event.payload.text })
      } else {
        items[index] = { kind: 'message', key: event.id, role: 'assistant', text: event.payload.text }
        streamingIndexes.delete(event.payload.stepId)
      }
    } else if (event.type === 'tool.call') {
      toolNames.set(event.payload.toolCallId, event.payload.tool)
      toolIndexes.set(event.payload.toolCallId, items.length)
      items.push({ kind: 'tool', key: event.id, tool: event.payload.tool, status: 'running' })
    } else if (event.type === 'tool.result') {
      const index = toolIndexes.get(event.payload.toolCallId)
      const item = index === undefined ? undefined : items[index]
      if (item?.kind === 'tool') {
        item.status = event.payload.status
        if (event.payload.status === 'failed') item.detail = safeErrorDetail(event.payload.result)
      } else {
        items.push({
          kind: 'tool',
          key: event.id,
          tool: toolNames.get(event.payload.toolCallId) ?? 'tool',
          status: event.payload.status,
          ...(event.payload.status === 'failed' ? { detail: safeErrorDetail(event.payload.result) } : {})
        })
      }
    } else if (event.type === 'approval.requested') {
      pending.set(event.payload.approvalId, event)
    } else if (event.type === 'approval.resolved') {
      pending.delete(event.payload.approvalId)
    } else {
      const lifecycle = lifecycleProjection(event)
      if (lifecycle) items.push(lifecycle)
    }
  }
  return { items, approvals: [...pending.values()] }
}

function lifecycleProjection(event: AssistantEvent): Extract<ProjectionItem, { kind: 'lifecycle' }> | null {
  const base = { kind: 'lifecycle' as const, key: event.id, eventType: event.type }
  switch (event.type) {
    case 'inbox.message':
      return { ...base, status: event.payload.mode === 'next-turn' ? 'queued' : 'running', detail: event.payload.text.slice(0, 160) }
    case 'plugin.revision.defined':
      return { ...base, status: 'succeeded', detail: `${event.payload.pluginId} · ${shortRevision(event.payload.revisionId)}` }
    case 'plugin.validation.completed':
      return { ...base, status: event.payload.status, detail: `${event.payload.pluginId} · ${shortRevision(event.payload.revisionId)}` }
    case 'plugin.run.requested':
    case 'plugin.run.started':
    case 'plugin.run.succeeded':
    case 'plugin.run.failed':
    case 'plugin.run.stopped':
      return {
        ...base,
        status: event.type === 'plugin.run.failed' ? 'failed'
          : event.type === 'plugin.run.stopped' ? 'cancelled'
            : event.type === 'plugin.run.succeeded' ? 'succeeded'
              : 'running',
        detail: `${event.payload.pluginId} · ${shortRevision(event.payload.revisionId)}${event.type === 'plugin.run.failed' ? ` · ${safeErrorDetail(event.payload.error)}` : ''}`
      }
    case 'plugin.rollback.completed':
      return { ...base, status: 'succeeded', detail: `${event.payload.pluginId} · ${shortRevision(event.payload.fromRevisionId)} → ${shortRevision(event.payload.toRevisionId)}` }
    case 'turn.ended':
      return event.payload.status === 'interrupted'
        ? { ...base, status: 'failed', detail: 'interrupted' }
        : null
    case 'session.error':
      return { ...base, status: 'failed', detail: safeErrorDetail(event.payload.error) }
    default:
      return null
  }
}

function assistantEventTitle(type: AssistantEvent['type'], isZh: boolean): string {
  const labels: Partial<Record<AssistantEvent['type'], [string, string]>> = {
    'inbox.message': ['消息队列', 'Message inbox'],
    'plugin.revision.defined': ['插件 revision 已定义', 'Plugin revision defined'],
    'plugin.validation.completed': ['插件验证', 'Plugin validation'],
    'plugin.run.requested': ['插件运行已请求', 'Plugin run requested'],
    'plugin.run.started': ['插件运行已启动', 'Plugin run started'],
    'plugin.run.succeeded': ['插件运行成功', 'Plugin run succeeded'],
    'plugin.run.failed': ['插件运行失败', 'Plugin run failed'],
    'plugin.run.stopped': ['插件已停止', 'Plugin stopped'],
    'plugin.rollback.completed': ['插件回滚完成', 'Plugin rollback completed'],
    'turn.ended': ['任务恢复诊断', 'Turn recovery diagnostic'],
    'session.error': ['会话错误', 'Session error']
  }
  const label = labels[type] ?? [type, type]
  return isZh ? label[0] : label[1]
}

function safeErrorDetail(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 240)
  if (Array.isArray(value)) {
    const detail = value.map((entry) => safeErrorDetail(entry)).find((entry) => entry !== 'error')
    return detail ?? 'error'
  }
  if (!value || typeof value !== 'object') return 'error'
  const record = value as Record<string, unknown>
  const message = record.message
  if (typeof message === 'string') return message.slice(0, 240)
  for (const key of ['error', 'details', 'cause', 'result', 'value']) {
    const detail = safeErrorDetail(record[key])
    if (detail !== 'error') return detail
  }
  return 'error'
}

function toolStatusText(status: string, isZh: boolean): string {
  const zh: Record<string, string> = {
    running: '进行中',
    queued: '已排队',
    passed: '通过',
    warning: '有警告',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    'awaiting-approval': '等待审批'
  }
  return isZh ? zh[status] ?? status : status.replaceAll('-', ' ')
}

function shortRevision(revisionId: string): string {
  return revisionId.length > 28 ? `${revisionId.slice(0, 25)}…` : revisionId
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
