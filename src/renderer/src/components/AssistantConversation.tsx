import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { AiAnswerContent } from './AiAnswerContent'
import type {
  AssistantApprovalId,
  AssistantEvent,
  AssistantSessionId,
  AssistantSessionSummary
} from '@shared/assistant-session'

type AssistantEventSnapshot = {
  sessionId: AssistantSessionId
  selectionVersion: number
  lastSeq: number
  events: AssistantEvent[]
}

type AssistantEventRead = {
  sessionId: AssistantSessionId
  selectionVersion: number
  targetSeq: number
  promise: Promise<void>
}

type AssistantConversationProps = {
  activeDocumentId: string | null
  aiEnabled: boolean
  hasApiKey: boolean
  isZh: boolean
  initialDraft?: string
  newSessionTitle?: string
  onDraftChange?: (draft: string) => void
  showConfigurationHint?: boolean
  isVisible?: boolean
  transcriptBefore?: ReactNode
  transcriptAfter?: ReactNode
}

export function AssistantConversation({
  activeDocumentId,
  aiEnabled,
  hasApiKey,
  isZh,
  initialDraft = '',
  newSessionTitle,
  onDraftChange,
  showConfigurationHint = true,
  isVisible = true,
  transcriptBefore,
  transcriptAfter
}: AssistantConversationProps) {
  const [sessions, setSessions] = useState<AssistantSessionSummary[]>([])
  const [selectedId, setSelectedId] = useState<AssistantSessionId | null>(null)
  const [events, setEvents] = useState<AssistantEvent[]>([])
  const [draft, setDraft] = useState(initialDraft)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [eventLoadError, setEventLoadError] = useState('')
  const [transcriptNavigation, setTranscriptNavigation] = useState({ pinned: true, hasNewContent: false })
  const mountedRef = useRef(false)
  const sessionsRef = useRef<AssistantSessionSummary[]>([])
  const eventSnapshotRef = useRef<AssistantEventSnapshot | null>(null)
  const eventReadRef = useRef<AssistantEventRead | null>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const keepTranscriptPinnedRef = useRef(true)
  const transcriptScrollTopRef = useRef(0)
  const transcriptWasVisibleRef = useRef(isVisible)
  const layoutScrollRef = useRef<{ selectionVersion: number; scrollTop: number } | null>(null)
  const readingPositionRef = useRef<ReadingPosition | null>(null)
  const transcriptContentRef = useRef({ selectionVersion: 0, lastRenderedSeq: 0, lastReadSeq: 0 })
  const draftRef = useRef(initialDraft)
  const onDraftChangeRef = useRef(onDraftChange)
  const selectedIdRef = useRef(selectedId)
  const eventsRequestId = useRef(0)
  const sessionsRequestId = useRef(0)
  const selectionVersion = useRef(0)
  const composingRef = useRef(false)
  if (selectedIdRef.current !== selectedId) {
    selectedIdRef.current = selectedId
    selectionVersion.current += 1
  }

  useEffect(() => {
    onDraftChangeRef.current = onDraftChange
  }, [onDraftChange])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      eventsRequestId.current += 1
      sessionsRequestId.current += 1
      eventReadRef.current = null
      eventSnapshotRef.current = null
    }
  }, [])

  const commitDraft = useCallback((next: string) => {
    draftRef.current = next
    setDraft(next)
    onDraftChangeRef.current?.(next)
  }, [])

  const updateTranscriptNavigation = useCallback((pinned: boolean, readLatest = false) => {
    if (pinned) {
      layoutScrollRef.current = null
      readingPositionRef.current = null
    }
    keepTranscriptPinnedRef.current = pinned
    const content = transcriptContentRef.current
    if (readLatest) content.lastReadSeq = content.lastRenderedSeq
    const hasNewContent = !pinned && content.lastRenderedSeq > content.lastReadSeq
    setTranscriptNavigation(current => current.pinned === pinned && current.hasNewContent === hasNewContent
      ? current : { pinned, hasNewContent })
  }, [])

  const refreshSessions = useCallback(async () => {
    if (!mountedRef.current) return
    const requestId = ++sessionsRequestId.current
    try {
      const next = await window.knowbook.listAssistantSessions()
      if (!mountedRef.current || sessionsRequestId.current !== requestId) return
      sessionsRef.current = next
      setSessions(next)
      setSelectedId((current) => current && next.some((session) => session.id === current)
        ? current
        : next[0]?.id ?? null)
    } catch (reason) {
      if (mountedRef.current && sessionsRequestId.current === requestId) throw reason
    }
  }, [])

  const refreshEvents = useCallback((sessionId: AssistantSessionId, throughSeq?: number): Promise<void> => {
    if (!mountedRef.current || selectedIdRef.current !== sessionId) return Promise.resolve()
    const version = selectionVersion.current
    const targetSeq = throughSeq ?? sessionsRef.current.find(session => session.id === sessionId)?.lastSeq ?? 0
    const active = eventReadRef.current
    if (active?.sessionId === sessionId && active.selectionVersion === version) {
      active.targetSeq = Math.max(active.targetSeq, targetSeq)
      return active.promise
    }
    const snapshot = eventSnapshotRef.current
    if (snapshot?.sessionId === sessionId && snapshot.selectionVersion === version && snapshot.lastSeq >= targetSeq) {
      return Promise.resolve()
    }
    const requestId = ++eventsRequestId.current
    const read: AssistantEventRead = { sessionId, selectionVersion: version, targetSeq, promise: Promise.resolve() }
    const isCurrent = () => mountedRef.current && selectedIdRef.current === sessionId
      && selectionVersion.current === version && eventsRequestId.current === requestId
    const finish = () => { if (eventReadRef.current === read) eventReadRef.current = null }
    eventReadRef.current = read
    read.promise = Promise.resolve().then(async () => {
      try {
        // Notifications extend the next finite snapshot instead of interrupting
        // every page of an active stream. Publish only complete snapshots.
        while (isCurrent()) {
          const through = read.targetSeq
          const saved = eventSnapshotRef.current
          const base = saved?.sessionId === sessionId && saved.selectionVersion === version ? saved : null
          const next = [...(base?.events ?? [])]
          let afterSeq = base?.lastSeq ?? 0
          while (afterSeq < through) {
            const page = await window.knowbook.getAssistantSessionEvents(sessionId, afterSeq, 1_000)
            if (!isCurrent()) return
            const included = page.filter(event => event.seq <= through)
            const lastSeq = included.at(-1)?.seq ?? afterSeq
            if (lastSeq <= afterSeq) throw new Error('Assistant event history could not be read completely.')
            next.push(...included)
            afterSeq = lastSeq
          }
          if (!isCurrent()) return
          eventSnapshotRef.current = { sessionId, selectionVersion: version, lastSeq: afterSeq, events: next }
          setEvents(next)
          setEventLoadError('')
          if (read.targetSeq <= afterSeq) return
        }
      } catch (reason) {
        if (isCurrent()) setEventLoadError(errorMessage(reason))
      } finally {
        finish()
      }
    })
    return read.promise
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
    updateTranscriptNavigation(true)
    const saved = eventSnapshotRef.current
    setEvents(saved?.sessionId === selectedId && saved.selectionVersion === selectionVersion.current ? saved.events : [])
    setError('')
    setEventLoadError('')
    if (!selectedId) {
      return
    }
    void refreshEvents(selectedId)
  }, [refreshEvents, selectedId, updateTranscriptNavigation])

  useEffect(() => window.knowbook.onAssistantSessionChanged((change) => {
    void refreshSessions().catch((reason) => setError(errorMessage(reason)))
    if (change.sessionId === selectedIdRef.current) {
      void refreshEvents(change.sessionId, change.lastSeq)
    }
  }), [refreshEvents, refreshSessions])

  const projection = useMemo(() => projectEvents(events), [events])
  const latestContentSeq = useMemo(() => lastTranscriptContentSeq(events), [events])
  const selected = sessions.find((session) => session.id === selectedId) ?? null
  const canUseAi = aiEnabled && hasApiKey

  useEffect(() => {
    if (selected) void refreshEvents(selected.id, selected.lastSeq)
  }, [refreshEvents, selected?.id, selected?.lastSeq])

  const jumpToLatest = useCallback(() => {
    const transcript = transcriptRef.current
    if (!isVisible || !transcript || transcript.clientHeight === 0) return
    updateTranscriptNavigation(true, true)
    transcript.scrollTop = transcript.scrollHeight
    transcriptScrollTopRef.current = transcript.scrollTop
    transcript.focus({ preventScroll: true })
  }, [isVisible, updateTranscriptNavigation])

  const captureReadingPosition = useCallback((): ReadingPosition | null => {
    const transcript = transcriptRef.current
    if (!isVisible || !transcript || !transcript.clientHeight) return null
    const focusedSummary = transcript.querySelector<HTMLElement>('.assistant-activity-group > summary:focus')
    if (keepTranscriptPinnedRef.current) return focusedSummary
      ? { selectionVersion: selectionVersion.current, anchors: [], scrollTop: transcript.scrollTop, focusedSummary } : null
    const bounds = transcript.getBoundingClientRect()
    const candidates = [...transcript.querySelectorAll<HTMLElement>(
      '.assistant-message, .assistant-activity-group > summary, .assistant-tool-event, .assistant-lifecycle-event, .assistant-approval'
    )].filter(node => {
      const group = node.closest<HTMLDetailsElement>('details.assistant-activity-group')
      return !group || node.tagName === 'SUMMARY' || group.open
    })
    // Locate the visible slice without measuring every earlier message on each
    // streaming update. Cards and disclosure summaries remain in document order.
    let first = 0
    let end = candidates.length
    while (first < end) {
      const middle = (first + end) >>> 1
      if (candidates[middle].getBoundingClientRect().bottom <= bounds.top) first = middle + 1
      else end = middle
    }
    const anchors: ReadingPosition['anchors'] = []
    for (let index = first; index < candidates.length; index += 1) {
      const node = candidates[index]
      const rect = node.getBoundingClientRect()
      if (rect.top >= bounds.bottom) break
      if (rect.height && rect.bottom > bounds.top) anchors.push({ node, offset: rect.top - bounds.top })
    }
    // Preserve the content being read, rather than an earlier status row that
    // survives while an operation between it and the content collapses.
    const center = bounds.height / 2
    const distance = (anchor: ReadingPosition['anchors'][number]) => {
      const rect = anchor.node.getBoundingClientRect()
      return Math.max(anchor.offset - center, center - anchor.offset - rect.height, 0)
    }
    anchors.sort((a, b) => Number(!a.node.matches('.assistant-message, .assistant-approval'))
      - Number(!b.node.matches('.assistant-message, .assistant-approval')) || distance(a) - distance(b))
    const position = { selectionVersion: selectionVersion.current, anchors, scrollTop: transcript.scrollTop, focusedSummary }
    readingPositionRef.current = position
    return position
  }, [isVisible])

  const restoreReadingPosition = useCallback((position: ReadingPosition | null) => {
    const transcript = transcriptRef.current
    if (!position || !isVisible || !transcript?.clientHeight
      || position.selectionVersion !== selectionVersion.current) return
    if (position.focusedSummary && !position.focusedSummary.isConnected && document.activeElement === document.body) {
      transcript.focus({ preventScroll: true })
    }
    if (keepTranscriptPinnedRef.current) return
    const anchor = position.anchors.find(({ node }) => node.isConnected && node.getBoundingClientRect().height > 0)
    if (anchor) {
      transcript.scrollTop += anchor.node.getBoundingClientRect().top - transcript.getBoundingClientRect().top - anchor.offset
    } else transcript.scrollTop = position.scrollTop
    transcriptScrollTopRef.current = transcript.scrollTop
    layoutScrollRef.current = { selectionVersion: selectionVersion.current, scrollTop: transcript.scrollTop }
  }, [isVisible])

  const onActivityToggle = useCallback((event: SyntheticEvent<HTMLDetailsElement>) => {
    const transcript = transcriptRef.current
    if (!isVisible || !transcript?.clientHeight) return
    transcriptScrollTopRef.current = transcript.scrollTop
    if (event.currentTarget.contains(document.activeElement)) updateTranscriptNavigation(false)
  }, [isVisible, updateTranscriptNavigation])

  useLayoutEffect(() => {
    const transcript = transcriptRef.current
    const becameVisible = isVisible && !transcriptWasVisibleRef.current
    transcriptWasVisibleRef.current = isVisible
    const content = transcriptContentRef.current
    if (content.selectionVersion !== selectionVersion.current) {
      content.selectionVersion = selectionVersion.current
      content.lastRenderedSeq = 0
      content.lastReadSeq = 0
      keepTranscriptPinnedRef.current = true
      readingPositionRef.current = null
    }
    const snapshot = eventSnapshotRef.current
    if (snapshot?.sessionId === selectedId && snapshot.selectionVersion === content.selectionVersion
      && (events.length === 0 || events[0].sessionId === selectedId)) {
      // The cache can already contain the next batch. Only this committed
      // render may become the read baseline, including streaming updates.
      content.lastRenderedSeq = latestContentSeq
    }
    // Hidden task panels have no scroll geometry. Apply the existing pin or
    // reading anchor after the panel is laid out, without resetting intent.
    if (!isVisible || !transcript || transcript.clientHeight === 0) {
      updateTranscriptNavigation(keepTranscriptPinnedRef.current)
      return
    }
    if (keepTranscriptPinnedRef.current) {
      transcript.scrollTop = transcript.scrollHeight
    } else if (becameVisible) {
      if (readingPositionRef.current) restoreReadingPosition(readingPositionRef.current)
      else transcript.scrollTop = transcriptScrollTopRef.current
    }
    transcriptScrollTopRef.current = transcript.scrollTop
    updateTranscriptNavigation(keepTranscriptPinnedRef.current, keepTranscriptPinnedRef.current)
  }, [projection, latestContentSeq, selectedId, selected?.activeTurnId, error, eventLoadError,
    isVisible, transcriptNavigation.pinned, restoreReadingPosition, updateTranscriptNavigation])

  const createSession = useCallback(async (): Promise<AssistantSessionSummary> => {
    updateTranscriptNavigation(true)
    // An initial list request must not replace a newly created session.
    sessionsRequestId.current += 1
    const created = await window.knowbook.createAssistantSession({
      activeDocumentId,
      ...(newSessionTitle ? { title: newSessionTitle } : {})
    })
    sessionsRequestId.current += 1
    selectedIdRef.current = created.id
    selectionVersion.current += 1
    setSelectedId(created.id)
    sessionsRef.current = [created, ...sessionsRef.current.filter(session => session.id !== created.id)]
    setSessions(sessionsRef.current)
    setLoading(false)
    setEvents([])
    return created
  }, [activeDocumentId, newSessionTitle, updateTranscriptNavigation])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || busy || !canUseAi) return
    updateTranscriptNavigation(true)
    setBusy(true)
    setError('')
    commitDraft('')
    let sessionId = selected?.id ?? null
    let version = selectionVersion.current
    const isCurrent = () => selectedIdRef.current === sessionId && selectionVersion.current === version
    try {
      const session = selected ?? await createSession()
      sessionId = session.id
      version = selectionVersion.current
      const request = window.knowbook.sendAssistantMessage({ sessionId: session.id, text, mode: 'auto' })
      setBusy(false)
      void request
        .then(async () => { await refreshSessions(); await refreshEvents(session.id) })
        .catch((reason) => {
          if (!isCurrent()) return
          if (!draftRef.current) commitDraft(text)
          setError(errorMessage(reason))
        })
    } catch (reason) {
      if (!isCurrent()) return
      if (!draftRef.current) commitDraft(text)
      setError(errorMessage(reason))
      setBusy(false)
    }
  }, [busy, canUseAi, commitDraft, createSession, draft, refreshEvents, refreshSessions, selected, updateTranscriptNavigation])

  const resolveApproval = useCallback(async (
    approvalId: AssistantApprovalId,
    decision: 'allowed-once' | 'rejected' | 'cancelled'
  ) => {
    if (!selectedId || busy) return
    setBusy(true)
    setError('')
    const version = selectionVersion.current
    const isCurrent = () => selectedIdRef.current === selectedId && selectionVersion.current === version
    try {
      const request = window.knowbook.resolveAssistantApproval({ sessionId: selectedId, approvalId, decision })
      setBusy(false)
      void request
        .then(async () => { await refreshSessions(); await refreshEvents(selectedId) })
        .catch((reason) => { if (isCurrent()) setError(errorMessage(reason)) })
    } catch (reason) {
      if (!isCurrent()) return
      setError(errorMessage(reason))
      setBusy(false)
    }
  }, [busy, refreshEvents, refreshSessions, selectedId])

  const cancelTurn = useCallback(async () => {
    if (!selectedId || busy) return
    setBusy(true)
    setError('')
    const version = selectionVersion.current
    const isCurrent = () => selectedIdRef.current === selectedId && selectionVersion.current === version
    try {
      await window.knowbook.cancelAssistantTurn(selectedId)
      await refreshSessions()
      await refreshEvents(selectedId)
    } catch (reason) {
      if (isCurrent()) setError(errorMessage(reason))
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }, [busy, refreshEvents, refreshSessions, selectedId])

  return (
    <div className="assistant-workbench">
      <div className="assistant-session-toolbar">
        <select
          aria-label={isZh ? '助手对话' : 'Assistant session'}
          className="editor-select assistant-session-select"
          disabled={busy || loading}
          onChange={(event) => {
            updateTranscriptNavigation(true)
            const next = (event.target.value || null) as AssistantSessionId | null
            if (selectedIdRef.current !== next) selectionVersion.current += 1
            selectedIdRef.current = next
            setSelectedId(next)
          }}
          value={selectedId ?? ''}
        >
          {sessions.length === 0 ? <option value="">{isZh ? '尚无对话' : 'No sessions yet'}</option> : null}
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>{assistantSessionLabel(session)}</option>
          ))}
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

      <div className="assistant-transcript-region">
        {!transcriptNavigation.pinned ? (
          <button className="assistant-latest-button" onClick={jumpToLatest} type="button">
            <span aria-hidden="true">↓</span>
            {transcriptNavigation.hasNewContent ? (isZh ? '有新内容 · ' : 'New content · ') : ''}
            {isZh ? '回到最新' : 'Jump to latest'}
          </button>
        ) : null}
        <span className="assistant-latest-status" role="status">
          {transcriptNavigation.hasNewContent ? (isZh ? '有新内容' : 'New content') : ''}
        </span>
        <div
          aria-live="polite"
          aria-label={isZh ? '扩展助手对话' : 'Extension assistant conversation'}
          className={`assistant-transcript${projection.items.length === 0 ? ' is-empty' : ''}`}
          onScroll={(event) => {
            if (!isVisible || event.currentTarget.clientHeight === 0) return
            transcriptScrollTopRef.current = event.currentTarget.scrollTop
            const layoutScroll = layoutScrollRef.current
            layoutScrollRef.current = null
            if (layoutScroll?.selectionVersion === selectionVersion.current
              && Math.abs(layoutScroll.scrollTop - event.currentTarget.scrollTop) < 1) return
            const pinned = isTranscriptNearBottom(event.currentTarget)
            updateTranscriptNavigation(pinned, pinned)
          }}
          ref={transcriptRef}
          tabIndex={0}
        >
          {transcriptBefore}
          {projection.items.length === 0 ? (
            <p className="mini-hint">
              {isZh
                ? '描述你想添加的功能，例如整理文档、生成首页卡片或自动处理笔记。助手会准备扩展，并在启用前让你确认。'
                : 'Describe a feature you need, such as organizing notes or adding a dashboard card. The assistant will prepare an extension for you to review before enabling it.'}
            </p>
          ) : <AssistantTranscriptItems
            captureReadingPosition={captureReadingPosition}
            isVisible={isVisible}
            isZh={isZh}
            items={projection.items}
            key={`${selectedId}:${selectionVersion.current}`}
            onActivityToggle={onActivityToggle}
            restoreReadingPosition={restoreReadingPosition}
          />}
          {selected?.activeTurnId ? <p className="mini-hint">{isZh ? '助手任务进行中；继续发送会转向当前任务，审批等待时会排入下一轮。' : 'The turn is active. New messages steer it, or queue behind an approval.'}</p> : null}
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

        {!canUseAi && showConfigurationHint ? (
          <p className="mini-hint ai-context-error" role="status">
            {isZh ? '请先在设置中启用 AI 并保存 API Key。' : 'Enable AI and save an API key in Settings first.'}
          </p>
        ) : null}
        {error || eventLoadError ? <p className="mini-hint ai-context-error" role="alert">{error || eventLoadError}</p> : null}
        {transcriptAfter}
        </div>
      </div>
      <div className="assistant-composer">
        <textarea
          aria-label={isZh ? '扩展需求' : 'Extension request'}
          className="editor-textarea"
          disabled={!canUseAi}
          onChange={(event) => commitDraft(event.target.value)}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onBlur={() => { composingRef.current = false }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !isImeKeyboardEvent(event.nativeEvent, composingRef.current)) {
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
      <p className="assistant-composer-hint">{isZh ? 'Enter 发送 · Shift + Enter 换行' : 'Enter to send · Shift + Enter for a new line'}</p>
    </div>
  )
}

export function isTranscriptNearBottom(
  transcript: Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>,
  threshold = 48
): boolean {
  return transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= threshold
}

function lastTranscriptContentSeq(events: readonly AssistantEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'user.message' || event.type === 'assistant.chunk' || event.type === 'assistant.message'
      || event.type === 'tool.call' || event.type === 'tool.result' || event.type === 'approval.requested'
      || event.type === 'approval.resolved' || lifecycleProjection(event)) return event.seq
  }
  return 0
}

export function assistantSessionLabel(session: Pick<AssistantSessionSummary, 'createdAt' | 'title'>): string {
  const createdAt = new Date(session.createdAt)
  if (Number.isNaN(createdAt.getTime())) return session.title
  const pad = (value: number) => String(value).padStart(2, '0')
  const timestamp = [
    createdAt.getFullYear(),
    pad(createdAt.getMonth() + 1),
    pad(createdAt.getDate())
  ].join('-')
  const time = `${pad(createdAt.getHours())}:${pad(createdAt.getMinutes())}`
  return `${timestamp} ${time} · ${session.title}`
}

type LifecycleRecord = { eventType: AssistantEvent['type']; status: string; detail: string }

type ProjectionItem =
  | { kind: 'message'; key: string; role: 'user' | 'assistant'; text: string; streaming?: boolean }
  | { kind: 'tool'; key: string; toolCallId: string; tool: string; status: string; detail?: string }
  | ({ kind: 'lifecycle'; key: string; runId?: string; history?: LifecycleRecord[] } & LifecycleRecord)

type ReadingPosition = {
  selectionVersion: number
  anchors: Array<{ node: HTMLElement; offset: number }>
  scrollTop: number
  focusedSummary: HTMLElement | null
}

type ActivityGroup = { kind: 'completed'; key: string; items: ProjectionItem[] }
type ActivityGrouping = {
  items: readonly ProjectionItem[]
  rows: Array<ProjectionItem | ActivityGroup>
  assignments: Map<string, string>
}

function completedActivity(item: ProjectionItem): boolean {
  return item.kind !== 'message' && (item.status === 'succeeded' || item.status === 'passed')
    && !(item.kind === 'lifecycle' && item.history?.some(step => ['failed', 'warning', 'cancelled'].includes(step.status)))
}

function groupCompletedActivities(items: readonly ProjectionItem[], previous: ReadonlyMap<string, string>): ActivityGrouping {
  const rows: ActivityGrouping['rows'] = []
  const assignments = new Map<string, string>()
  const usedGroups = new Set<string>()
  let current: ActivityGroup | null = null
  for (const item of items) {
    if (!completedActivity(item)) {
      rows.push(item)
      current = null
      continue
    }
    const assigned = previous.get(item.key)
    // Keep existing disclosures separate when an intervening operation finishes.
    // Merging them would remove the reader's open state and keyboard focus.
    const key: string = assigned && (!usedGroups.has(assigned) || current?.key === assigned)
      ? assigned : current?.key ?? `completed-${item.key}`
    if (!current || current.key !== key) {
      current = { kind: 'completed', key, items: [] }
      rows.push(current)
      usedGroups.add(key)
    }
    current.items.push(item)
    assignments.set(item.key, key)
  }
  return { items, rows, assignments }
}

type TranscriptItemsProps = {
  items: readonly ProjectionItem[]
  isVisible: boolean
  isZh: boolean
  onActivityToggle: (event: SyntheticEvent<HTMLDetailsElement>) => void
  captureReadingPosition: () => ReadingPosition | null
  restoreReadingPosition: (position: ReadingPosition | null) => void
}

class AssistantTranscriptItems extends Component<TranscriptItemsProps, ActivityGrouping, ReadingPosition | null> {
  state = groupCompletedActivities(this.props.items, new Map())

  static getDerivedStateFromProps(props: TranscriptItemsProps, state: ActivityGrouping): ActivityGrouping | null {
    return props.items === state.items ? null : groupCompletedActivities(props.items, state.assignments)
  }

  getSnapshotBeforeUpdate(previous: TranscriptItemsProps): ReadingPosition | null {
    // React captures this before DOM mutations, while the reading anchor still
    // has its old geometry. Scroll anchoring alone cannot cover every regrouping.
    return previous.items !== this.props.items || previous.isZh !== this.props.isZh || previous.isVisible !== this.props.isVisible
      ? previous.captureReadingPosition() : null
  }

  componentDidUpdate(_props: TranscriptItemsProps, _state: ActivityGrouping, position: ReadingPosition | null): void {
    this.props.restoreReadingPosition(position)
  }

  render(): ReactNode {
    const { isZh, onActivityToggle } = this.props
    return this.state.rows.map(row => row.kind === 'completed' ? (
      <details className="assistant-activity-group" key={row.key} onToggle={onActivityToggle}>
        <summary className="mini-hint">
          {isZh ? `已完成 ${row.items.length} 项操作`
            : `${row.items.length} completed ${row.items.length === 1 ? 'action' : 'actions'}`}
        </summary>
        <div>{row.items.map(item => renderTranscriptItem(item, isZh))}</div>
      </details>
    ) : renderTranscriptItem(row, isZh))
  }
}

function renderTranscriptItem(item: ProjectionItem, isZh: boolean): ReactNode {
  if (item.kind === 'message') return (
    <div className={`assistant-message assistant-message-${item.role}`} key={item.key}>
      <span>{item.role === 'user' ? (isZh ? '你' : 'You') : 'KnowBook AI'}</span>
      {item.role === 'assistant' ? <AiAnswerContent content={item.text} /> : <p>{item.text}</p>}
    </div>
  )
  if (item.kind === 'tool') return (
    <div className={`assistant-tool-event assistant-tool-${item.status}`} data-tool-call-id={item.toolCallId} key={item.key}>
      <code>{item.tool}</code>
      {item.detail ? <small>{item.detail}</small> : null}
      <span>{toolStatusText(item.status, isZh)}</span>
    </div>
  )
  return (
    <div className={`assistant-lifecycle-event assistant-lifecycle-${item.status}`} data-run-id={item.runId} key={item.key}>
      <strong>{assistantEventTitle(item.eventType, isZh)}</strong>
      {item.detail ? <code>{item.detail}</code> : null}
      <span>{toolStatusText(item.status, isZh)}</span>
      {item.history && item.history.length > 1 ? (
        <div className="assistant-run-history">
          {item.history.map((step, index) => (
            <p className="mini-hint" key={index}>
              {assistantEventTitle(step.eventType, isZh)} · {toolStatusText(step.status, isZh)} · {step.detail}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function projectEvents(events: readonly AssistantEvent[]): {
  items: ProjectionItem[]
  approvals: Array<Extract<AssistantEvent, { type: 'approval.requested' }>>
} {
  const items: ProjectionItem[] = []
  const toolNames = new Map<string, string>()
  const toolIndexes = new Map<string, number>()
  const streamingIndexes = new Map<string, number>()
  const pending = new Map<string, Extract<AssistantEvent, { type: 'approval.requested' }>>()
  const runIndexes = new Map<string, number>()
  const runRequests = new Map<string, string>()
  const updateApprovalStatus = (request: Extract<AssistantEvent, { type: 'approval.requested' }>, status: string, decision?: string) => {
    const toolIndex = toolIndexes.get(request.payload.toolCallId)
    const tool = toolIndex === undefined ? undefined : items[toolIndex]
    if (tool?.kind === 'tool' && (tool.status === 'running' || tool.status === 'awaiting-approval')) tool.status = status
    const runId = runRequests.get(request.payload.toolCallId)
    const runIndex = runId === undefined ? undefined : runIndexes.get(runId)
    const run = runIndex === undefined ? undefined : items[runIndex]
    if (run?.kind === 'lifecycle' && run.eventType === 'plugin.run.requested') {
      run.status = status
      if (decision && decision !== 'allowed-once') run.detail += ` · ${decision}`
    }
  }
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
      items.push({ kind: 'tool', key: event.id, toolCallId: event.payload.toolCallId, tool: event.payload.tool, status: 'running' })
    } else if (event.type === 'tool.result') {
      const index = toolIndexes.get(event.payload.toolCallId)
      const item = index === undefined ? undefined : items[index]
      if (item?.kind === 'tool') {
        Object.assign(item, toolResultStatus(item.tool, event))
      } else {
        items.push({
          kind: 'tool',
          key: event.id,
          toolCallId: event.payload.toolCallId,
          tool: toolNames.get(event.payload.toolCallId) ?? 'tool',
          ...toolResultStatus(toolNames.get(event.payload.toolCallId) ?? 'tool', event)
        })
      }
      const runId = runRequests.get(event.payload.toolCallId)
      const runIndex = runId === undefined ? undefined : runIndexes.get(runId)
      const run = runIndex === undefined ? undefined : items[runIndex]
      if (run?.kind === 'lifecycle' && (run.eventType === 'plugin.run.requested' || run.eventType === 'plugin.run.started')) {
        run.status = event.payload.status
        const detail = event.payload.status === 'failed' ? safeErrorDetail(event.payload.result) : ''
        if (detail) run.detail += ` · ${detail}`
        run.history = [...(run.history ?? []), { eventType: 'tool.result', status: event.payload.status, detail }]
      }
    } else if (event.type === 'approval.requested') {
      pending.set(event.payload.approvalId, event)
      updateApprovalStatus(event, 'awaiting-approval')
    } else if (event.type === 'approval.resolved') {
      const request = pending.get(event.payload.approvalId)
      if (request) updateApprovalStatus(request, event.payload.decision === 'allowed-once' ? 'running'
        : event.payload.decision === 'cancelled' ? 'cancelled' : 'failed', event.payload.decision)
      pending.delete(event.payload.approvalId)
    } else {
      const lifecycle = lifecycleProjection(event)
      if (!lifecycle) continue
      if (event.type === 'plugin.run.requested') runRequests.set(event.payload.toolCallId, event.payload.runId)
      if (event.type === 'plugin.run.requested' || event.type === 'plugin.run.started'
        || event.type === 'plugin.run.succeeded' || event.type === 'plugin.run.failed'
        || event.type === 'plugin.run.stopped' || event.type === 'plugin.rollback.completed') {
        const runId = event.payload.runId
        const index = runIndexes.get(runId)
        const previous = index === undefined ? undefined : items[index]
        const history = [...(previous?.kind === 'lifecycle' ? previous.history ?? [] : []), {
          eventType: lifecycle.eventType, status: lifecycle.status, detail: lifecycle.detail
        }]
        if (previous?.kind === 'lifecycle' && index !== undefined) {
          items[index] = { ...lifecycle, key: previous.key, runId, history }
        } else {
          runIndexes.set(runId, items.length)
          items.push({ ...lifecycle, runId, history })
        }
      } else items.push(lifecycle)
    }
  }
  return { items, approvals: [...pending.values()] }
}

function toolResultStatus(tool: string, event: Extract<AssistantEvent, { type: 'tool.result' }>): { status: string; detail?: string } {
  let status: string = event.payload.status
  const result = event.payload.result
  let diagnostics = result
  if (status === 'succeeded' && (tool === 'plugins.validate_revision' || tool === 'plugins_validate_revision')
    && result && typeof result === 'object' && !Array.isArray(result)
    && (result.status === 'warning' || result.status === 'failed')) {
    status = result.status
    diagnostics = result.diagnostics ?? result
  }
  const detail = status === 'failed' || status === 'warning' ? safeErrorDetail(diagnostics) : undefined
  return { status, detail: detail === 'error' && status === 'warning' ? undefined : detail }
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
    'session.error': ['会话错误', 'Session error'],
    'tool.result': ['操作结果', 'Operation result']
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
