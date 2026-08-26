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
}

export function AssistantConversation({
  activeDocumentId,
  aiEnabled,
  hasApiKey,
  isZh
}: AssistantConversationProps) {
  const [sessions, setSessions] = useState<AssistantSessionSummary[]>([])
  const [selectedId, setSelectedId] = useState<AssistantSessionId | null>(null)
  const [events, setEvents] = useState<AssistantEvent[]>([])
  const [draft, setDraft] = useState('')
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
    const created = await window.knowbook.createAssistantSession({ activeDocumentId })
    setSelectedId(created.id)
    setSessions((current) => [created, ...current.filter((session) => session.id !== created.id)])
    setEvents(await window.knowbook.getAssistantSessionEvents(created.id, 0, 1_000))
    return created
  }, [activeDocumentId])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || busy || !canUseAi) return
    setBusy(true)
    setError('')
    setDraft('')
    try {
      const session = selected ?? await createSession()
      await window.knowbook.sendAssistantMessage({ sessionId: session.id, text })
      await Promise.all([refreshSessions(), refreshEvents(session.id)])
    } catch (reason) {
      setDraft((current) => current || text)
      setError(errorMessage(reason))
    } finally {
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
      await window.knowbook.resolveAssistantApproval({ sessionId: selectedId, approvalId, decision })
      await Promise.all([refreshSessions(), refreshEvents(selectedId)])
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
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
          ) : (
            <div className="assistant-tool-event" key={item.key}>
              <code>{item.tool}</code>
              <span>{toolStatusText(item.status, isZh)}</span>
            </div>
          )
        ))}
        {busy ? <p className="mini-hint">{isZh ? '助手正在工作…' : 'Assistant is working…'}</p> : null}
      </div>

      {projection.approvals.map((approval) => (
        <div className={`assistant-approval assistant-approval-${approval.payload.risk}`} key={approval.payload.approvalId}>
          <div>
            <strong>{isZh ? '插件激活审批' : 'Plugin activation approval'}</strong>
            <p>{approval.payload.summary}</p>
            <code>{approval.payload.pluginId} · {shortRevision(approval.payload.revisionId)}</code>
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
          disabled={busy || Boolean(selected?.activeTurnId && projection.approvals.length > 0)}
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
  | { kind: 'message'; key: string; role: 'user' | 'assistant'; text: string }
  | { kind: 'tool'; key: string; tool: string; status: string }

function projectEvents(events: readonly AssistantEvent[]): {
  items: ProjectionItem[]
  approvals: Array<Extract<AssistantEvent, { type: 'approval.requested' }>>
} {
  const items: ProjectionItem[] = []
  const toolNames = new Map<string, string>()
  const pending = new Map<string, Extract<AssistantEvent, { type: 'approval.requested' }>>()
  for (const event of events) {
    if (event.type === 'user.message' || event.type === 'assistant.message') {
      items.push({
        kind: 'message',
        key: event.id,
        role: event.type === 'user.message' ? 'user' : 'assistant',
        text: event.payload.text
      })
    } else if (event.type === 'tool.call') {
      toolNames.set(event.payload.toolCallId, event.payload.tool)
    } else if (event.type === 'tool.result') {
      items.push({
        kind: 'tool',
        key: event.id,
        tool: toolNames.get(event.payload.toolCallId) ?? 'tool',
        status: event.payload.status
      })
    } else if (event.type === 'approval.requested') {
      pending.set(event.payload.approvalId, event)
    } else if (event.type === 'approval.resolved') {
      pending.delete(event.payload.approvalId)
    }
  }
  return { items, approvals: [...pending.values()] }
}

function toolStatusText(status: string, isZh: boolean): string {
  const zh: Record<string, string> = {
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
