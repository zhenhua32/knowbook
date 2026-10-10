import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, StrictMode } from 'react'
import { JSDOM } from 'jsdom'
import { AssistantConversation } from '../src/renderer/src/components/AssistantConversation'
import {
  ASSISTANT_EVENT_SURFACES,
  assistantApprovalId,
  assistantSessionId,
  assistantStepId,
  assistantToolCallId,
  assistantTurnId,
  type AssistantEvent,
  type AssistantEventPayloadMap,
  type AssistantEventType,
  type AssistantSessionChangedEvent,
  type AssistantSessionSummary
} from '../src/shared/assistant-session'

const createdAt = '2026-10-10T00:00:00Z'
const turnId = assistantTurnId('turn')
const stepId = assistantStepId('stream')
const toolCallId = assistantToolCallId('call')

function event<Type extends AssistantEventType>(
  sessionId: string,
  seq: number,
  type: Type,
  payload: AssistantEventPayloadMap[Type]
): AssistantEvent<Type> {
  return { id: `${sessionId}-${seq}`, sessionId: assistantSessionId(sessionId), seq, type,
    surface: ASSISTANT_EVENT_SURFACES[type], payload, createdAt } as AssistantEvent<Type>
}

function message(sessionId: string, seq: number, text: string): AssistantEvent<'assistant.message'> {
  return event(sessionId, seq, 'assistant.message', { turnId, stepId: assistantStepId(`step-${seq}`), text })
}

function approval(sessionId: string, seq: number, id: string, summary: string): AssistantEvent<'approval.requested'> {
  return event(sessionId, seq, 'approval.requested', {
    turnId, toolCallId, approvalId: assistantApprovalId(id), pluginId: 'sample', revisionId: 'revision',
    scope: { kind: 'session', workspaceId: 'workspace', sessionId }, permissions: [], summary,
    risk: 'low', expiresAt: '2099-01-01T00:00:00Z'
  })
}

function history(sessionId: string, count: number, firstSeq = 1): AssistantEvent[] {
  return Array.from({ length: count }, (_, index) =>
    event(sessionId, firstSeq + index, 'session.title.updated', { title: '历史标题' }))
}

type EventRequest = {
  sessionId: string
  afterSeq: number
  limit: number
  resolve: (events: AssistantEvent[]) => void
  reject: (reason: Error) => void
}

function eventRequests() {
  const requests: EventRequest[] = []
  const readEvents = (sessionId: string, afterSeq = 0, limit = 500) =>
    new Promise<AssistantEvent[]>((resolve, reject) => { requests.push({ sessionId, afterSeq, limit, resolve, reject }) })
  return { requests, readEvents }
}

async function resolve(request: EventRequest, events: AssistantEvent[]) {
  await act(async () => request.resolve(events))
}

async function withConversation(
  readEvents: ReturnType<typeof eventRequests>['readEvents'],
  run: (context: {
    document: Document
    notify: (lastSeq: number) => void
    notifySession: (id: string, lastSeq: number) => void
    refresh: (lastSeq: number) => Promise<void>
    selectSession: (id: string, changedLastSeq?: number) => Promise<void>
    deferNextSessionList: () => void
    resolveDeferredSessionList: () => Promise<void>
    remount: () => Promise<void>
    resolveFirstList: (sessions: Record<string, number>) => Promise<void>
    unmount: () => Promise<void>
    subscriptionCount: () => number
  }) => Promise<void>,
  options: { sessions: Record<string, number>; strict?: boolean; holdFirstList?: boolean }
) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const lastSequences = new Map(Object.entries(options.sessions))
  const summaries = (sequences: Record<string, number>): AssistantSessionSummary[] => Object.entries(sequences).map(([id, lastSeq]) => ({
    id: assistantSessionId(id), workspaceId: 'workspace', title: id, activeDocumentId: null, modelConfig: {},
    status: 'active', activeTurnId: null, lastSeq, createdAt, updatedAt: createdAt
  }))
  let listCalls = 0
  let resolveFirstList: ((sessions: AssistantSessionSummary[]) => void) | undefined
  let deferNextList = false
  let resolveDeferredList: (() => void) | undefined
  const listeners = new Set<(change: AssistantSessionChangedEvent) => void>()
  Object.defineProperty(dom.window, 'knowbook', { value: {
    listAssistantSessions: (): Promise<AssistantSessionSummary[]> => {
      listCalls += 1
      if (options.holdFirstList && listCalls === 1) return new Promise(resolve => { resolveFirstList = resolve })
      const snapshot = summaries(Object.fromEntries(lastSequences))
      if (deferNextList) {
        deferNextList = false
        return new Promise(resolve => { resolveDeferredList = () => resolve(snapshot) })
      }
      return Promise.resolve(snapshot)
    },
    getAssistantSessionEvents: readEvents,
    onAssistantSessionChanged: (listener: (change: AssistantSessionChangedEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let mounted = true
  let mountKey = 0
  const render = async () => {
    const element = createElement(AssistantConversation,
      { key: mountKey, activeDocumentId: null, aiEnabled: true, hasApiKey: true, isZh: true, initialDraft: '未发送需求' })
    await act(async () => root.render(options.strict ? createElement(StrictMode, null, element) : element))
  }
  const unmount = async () => {
    if (!mounted) return
    mounted = false
    await act(async () => root.unmount())
  }
  const notifySession = (id: string, lastSeq: number) => {
    lastSequences.set(id, Math.max(lastSequences.get(id) ?? 0, lastSeq))
    for (const listener of [...listeners]) listener({ sessionId: assistantSessionId(id), lastSeq })
  }
  const notify = (lastSeq: number) => {
    const id = dom.window.document.querySelector<HTMLSelectElement>('.assistant-session-select')!.value
    notifySession(id, lastSeq)
  }
  try {
    await render()
    await run({ document: dom.window.document, unmount, notify, notifySession, subscriptionCount: () => listeners.size,
      refresh: async lastSeq => { await act(async () => notify(lastSeq)) },
      deferNextSessionList: () => {
        assert.equal(resolveDeferredList, undefined)
        deferNextList = true
      },
      resolveDeferredSessionList: async () => {
        assert.ok(resolveDeferredList)
        const resolve = resolveDeferredList
        resolveDeferredList = undefined
        await act(async () => resolve())
      },
      remount: async () => { mountKey += 1; await render() },
      resolveFirstList: async sessions => {
        assert.ok(resolveFirstList)
        await act(async () => resolveFirstList!(summaries(sessions)))
      },
      selectSession: async (id, changedLastSeq) => {
        const select = dom.window.document.querySelector<HTMLSelectElement>('.assistant-session-select')!
        await act(async () => {
          select.value = id
          select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
          if (changedLastSeq !== undefined) notify(changedLastSeq)
        })
      }
    })
  } finally {
    await unmount()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

function cursorCalls(requests: readonly EventRequest[]) {
  return requests.map(({ sessionId, afterSeq, limit }) => ({ sessionId, afterSeq, limit }))
}

test('assistant loads over two event pages atomically and pairs streaming, tools and approvals across page boundaries', async () => {
  const events = history('a', 2_003)
  events[0] = event('a', 1, 'user.message', { turnId, text: '长会话最初问题' })
  events[997] = event('a', 998, 'assistant.chunk', { turnId, stepId, text: '跨页' })
  events[998] = event('a', 999, 'tool.call', { turnId, stepId, toolCallId, tool: 'notes.search', version: 1, arguments: {} })
  events[999] = approval('a', 1_000, 'resolved', '已决审批')
  events[1_000] = event('a', 1_001, 'assistant.chunk', { turnId, stepId, text: '流式' })
  events[1_001] = event('a', 1_002, 'approval.resolved', { approvalId: assistantApprovalId('resolved'), decision: 'allowed-once' })
  events[1_999] = approval('a', 2_000, 'pending', '最新审批')
  events[2_000] = event('a', 2_001, 'assistant.message', { turnId, stepId, text: '跨页流式完整回答' })
  events[2_001] = event('a', 2_002, 'tool.result', { turnId, stepId, toolCallId, status: 'succeeded', result: {} })
  events[2_002] = message('a', 2_003, '末页最新消息')
  const { requests, readEvents } = eventRequests()
  await withConversation(readEvents, async ({ document }) => {
    await resolve(requests[0], events.slice(0, 1_000))
    assert.equal(requests.length, 2)
    assert.equal(document.querySelectorAll('.assistant-message, .assistant-tool-event, .assistant-approval').length, 0,
      'the first page must not expose incomplete streaming, a running tool or an already resolved approval')
    await resolve(requests[1], events.slice(1_000, 2_000))
    assert.equal(requests.length, 3)
    assert.equal(document.querySelectorAll('.assistant-message, .assistant-tool-event, .assistant-approval').length, 0,
      'the second page remains private until the complete event snapshot is available')
    await resolve(requests[2], events.slice(2_000))
    assert.deepEqual(cursorCalls(requests), [
      { sessionId: 'a', afterSeq: 0, limit: 1_000 },
      { sessionId: 'a', afterSeq: 1_000, limit: 1_000 },
      { sessionId: 'a', afterSeq: 2_000, limit: 1_000 }
    ])
    assert.deepEqual([...document.querySelectorAll('.assistant-message p')].map(node => node.textContent),
      ['长会话最初问题', '跨页流式完整回答', '末页最新消息'])
    const tools = [...document.querySelectorAll('.assistant-tool-event')]
    assert.equal(tools.length, 1)
    assert.equal(tools[0].querySelector('code')?.textContent, 'notes.search')
    assert.equal(tools[0].querySelector('span')?.textContent, '已完成')
    assert.deepEqual([...document.querySelectorAll('.assistant-approval p')].map(node => node.textContent), ['最新审批'])
    assert.equal(document.querySelectorAll('.assistant-approval button').length, 2)
  }, { sessions: { a: 2_003 } })
})

test('assistant publishes exactly one full event page at its known high water without an unnecessary empty-tail read', async () => {
  const events = history('a', 1_000)
  events[999] = message('a', 1_000, '恰好一千条事件的末尾')
  const { requests, readEvents } = eventRequests()
  await withConversation(readEvents, async ({ document }) => {
    await resolve(requests[0], events)
    assert.deepEqual(cursorCalls(requests), [{ sessionId: 'a', afterSeq: 0, limit: 1_000 }])
    assert.equal(document.querySelector('.assistant-message p')?.textContent, '恰好一千条事件的末尾')
  }, { sessions: { a: 1_000 } })
})

test('a later-page refresh failure preserves the complete transcript and approvals until a complete retry succeeds', async () => {
  const saved = [message('a', 1, '已加载的完整回答'), approval('a', 2, 'existing', '原有待审批扩展')]
  const next = history('a', 1_001, 3)
  next[0] = message('a', 3, '刷新后新增完整回答')
  next[1] = event('a', 4, 'approval.resolved', { approvalId: assistantApprovalId('existing'), decision: 'allowed-once' })
  next[1_000] = message('a', 1_003, '刷新末页完整回答')
  const { requests, readEvents } = eventRequests()
  await withConversation(readEvents, async ({ document, refresh }) => {
    await resolve(requests[0], saved)
    const oldMessage = document.querySelector('.assistant-message')
    const oldApproval = document.querySelector('.assistant-approval')
    await refresh(1_003)
    await resolve(requests[1], next.slice(0, 1_000))
    assert.equal(document.querySelector('.assistant-message'), oldMessage)
    assert.equal(document.querySelector('.assistant-message p')?.textContent, '已加载的完整回答')
    assert.equal(document.querySelector('.assistant-approval'), oldApproval)
    await act(async () => requests[2].reject(new Error('读取第二页失败')))
    assert.equal(document.querySelector('.assistant-message'), oldMessage)
    assert.equal(document.querySelector('.assistant-message p')?.textContent, '已加载的完整回答')
    assert.equal(document.querySelector('.assistant-approval'), oldApproval)
    assert.equal(document.querySelector('[role="alert"]')?.textContent, '读取第二页失败')
    await refresh(1_003)
    await resolve(requests[3], next.slice(0, 1_000))
    assert.equal(document.querySelector('.assistant-message'), oldMessage)
    assert.equal(document.querySelector('.assistant-message p')?.textContent, '已加载的完整回答')
    assert.equal(document.querySelector('.assistant-approval'), oldApproval)
    await resolve(requests[4], next.slice(1_000))
    assert.deepEqual([...document.querySelectorAll('.assistant-message p')].map(node => node.textContent),
      ['已加载的完整回答', '刷新后新增完整回答', '刷新末页完整回答'])
    assert.equal(document.querySelector('.assistant-approval'), null)
    assert.equal(document.querySelector('[role="alert"]'), null, 'successful event reading clears only its earlier load error')
    assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, '未发送需求')
    assert.deepEqual(cursorCalls(requests).map(call => call.afterSeq), [0, 2, 1_002, 2, 1_002])
  }, { sessions: { a: 2 } })
})

test('continuous assistant notifications finish bounded snapshots and catch up serially without losing the completion-boundary notification', async () => {
  const initial = history('a', 1_000)
  initial[999] = message('a', 1_000, '初始界限完整回答')
  const { requests, readEvents } = eventRequests()
  await withConversation(readEvents, async ({ document, refresh, notify }) => {
    await refresh(1_001)
    await refresh(1_002)
    assert.equal(requests.length, 1, 'new stream notifications share the existing initial read')
    await resolve(requests[0], initial)
    assert.equal(document.querySelector('.assistant-message p')?.textContent, '初始界限完整回答',
      'continuous streaming must not starve publication of the already bounded initial history')
    assert.deepEqual(cursorCalls(requests).map(call => call.afterSeq), [0, 1_000])
    await refresh(1_003)
    await refresh(1_001)
    assert.equal(requests.length, 2, 'a later notification queues behind the existing catch-up read')
    await resolve(requests[1], [message('a', 1_001, '第一条增量'), message('a', 1_002, '第二条增量'), message('a', 1_003, '下一界限增量')])
    assert.deepEqual([...document.querySelectorAll('.assistant-message p')].map(node => node.textContent),
      ['初始界限完整回答', '第一条增量', '第二条增量'],
      'events appended beyond this read\'s fixed high water wait for the next complete snapshot')
    assert.deepEqual(cursorCalls(requests).map(call => call.afterSeq), [0, 1_000, 1_002])
    await act(async () => {
      requests[2].resolve([message('a', 1_003, '下一界限增量')])
      // The page continuation runs before this notification, while any promise
      // cleanup reaction may still be pending. A finished flight cannot swallow it.
      await Promise.resolve()
      notify(1_004)
    })
    assert.equal(document.querySelectorAll('.assistant-message p').length, 4)
    assert.deepEqual(cursorCalls(requests).map(call => call.afterSeq), [0, 1_000, 1_002, 1_003])
    await resolve(requests[3], [message('a', 1_004, '完成边界新增消息')])
    assert.deepEqual([...document.querySelectorAll('.assistant-message p')].map(node => node.textContent),
      ['初始界限完整回答', '第一条增量', '第二条增量', '下一界限增量', '完成边界新增消息'])
    assert.equal(document.querySelector('[role="alert"]'), null)
    assert.equal(requests.length, 4, 'each committed cursor advances without restarting from zero or duplicating requests')
  }, { sessions: { a: 1_000 } })
})

test('a queued catch-up failure keeps the just-completed snapshot and a failure-boundary notification restarts from its committed cursor', async () => {
  const initial = [message('a', 1, '最初完整回答'), approval('a', 2, 'existing', '原有审批')]
  const appended = history('a', 1_000, 3)
  appended[0] = event('a', 3, 'approval.resolved', { approvalId: assistantApprovalId('existing'), decision: 'allowed-once' })
  appended[1] = message('a', 4, '已提交的增量回答')
  const { requests, readEvents } = eventRequests()
  await withConversation(readEvents, async ({ document, refresh, notify }) => {
    await resolve(requests[0], initial)
    await refresh(1_002)
    await refresh(1_003)
    assert.equal(requests.length, 2)
    await resolve(requests[1], appended)
    assert.deepEqual([...document.querySelectorAll('.assistant-message p')].map(node => node.textContent),
      ['最初完整回答', '已提交的增量回答'])
    assert.equal(document.querySelector('.assistant-approval'), null)
    assert.deepEqual(cursorCalls(requests).map(call => call.afterSeq), [0, 2, 1_002])
    await act(async () => {
      requests[2].reject(new Error('追赶最新事件失败'))
      await Promise.resolve()
      notify(1_004)
    })
    assert.deepEqual([...document.querySelectorAll('.assistant-message p')].map(node => node.textContent),
      ['最初完整回答', '已提交的增量回答'])
    assert.equal(document.querySelector('[role="alert"]')?.textContent, '追赶最新事件失败')
    assert.equal(requests.length, 4, 'a new notification cannot join a failed flight waiting for promise cleanup')
    await resolve(requests[3], [message('a', 1_003, '追赶重试完整回答'), message('a', 1_004, '失败边界新消息')])
    assert.equal(document.querySelector('[role="alert"]'), null)
    assert.deepEqual([...document.querySelectorAll('.assistant-message p')].map(node => node.textContent),
      ['最初完整回答', '已提交的增量回答', '追赶重试完整回答', '失败边界新消息'])
    assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, '未发送需求')
    assert.deepEqual(cursorCalls(requests).map(call => call.afterSeq), [0, 2, 1_002, 1_002])
  }, { sessions: { a: 2 } })
})

for (const outcome of ['success', 'failure'] as const) {
  test('an A to B to A session switch rejects an earlier A page ' + outcome + ' while the new A snapshot is pending', async () => {
    const { requests, readEvents } = eventRequests()
    await withConversation(readEvents, async ({ document, selectSession, deferNextSessionList, resolveDeferredSessionList }) => {
      await resolve(requests[0], history('a', 1_000))
      deferNextSessionList()
      await selectSession('b', 2)
      await resolve(requests[2], [message('b', 1, '会话 B 最初回答'), message('b', 2, '切换窗口里的 B 最新消息')])
      assert.deepEqual([...document.querySelectorAll('.assistant-message p')].map(node => node.textContent),
        ['会话 B 最初回答', '切换窗口里的 B 最新消息'],
        'a notification between native selection change and effects must read the new selected ref, before its list ACK arrives')
      await resolveDeferredSessionList()
      await selectSession('a')
      assert.equal(document.querySelector('.assistant-message'), null)
      if (outcome === 'success') {
        const stale = history('a', 1_000, 1_001)
        stale[0] = message('a', 1_001, '上次选中 A 的第二页')
        await resolve(requests[1], stale)
      } else {
        await act(async () => requests[1].reject(new Error('上次选中 A 的分页错误')))
      }
      assert.equal(document.querySelector('.assistant-message'), null,
        'matching the session id again must not revive a request from its earlier selection')
      assert.equal(document.querySelector('[role="alert"]'), null)
      assert.equal(requests.length, 4)
      const first = history('a', 1_000)
      first[0] = message('a', 1, '重新选中 A 的最初回答')
      await resolve(requests[3], first)
      assert.equal(document.querySelector('.assistant-message'), null)
      const last = history('a', 1_000, 1_001)
      last[999] = message('a', 2_000, '重新选中 A 的末页完整回答')
      await resolve(requests[4], last)
      assert.deepEqual([...document.querySelectorAll('.assistant-message p')].map(node => node.textContent),
        ['重新选中 A 的最初回答', '重新选中 A 的末页完整回答'])
      assert.deepEqual(cursorCalls(requests), [
        { sessionId: 'a', afterSeq: 0, limit: 1_000 }, { sessionId: 'a', afterSeq: 1_000, limit: 1_000 },
        { sessionId: 'b', afterSeq: 0, limit: 1_000 }, { sessionId: 'a', afterSeq: 0, limit: 1_000 },
        { sessionId: 'a', afterSeq: 1_000, limit: 1_000 }
      ])
    }, { sessions: { a: 2_000, b: 1 } })
  })
}

test('a delayed session summary ACK catches up a reselected conversation even when its earlier notification arrived in the background', async () => {
  const { requests, readEvents } = eventRequests()
  await withConversation(readEvents, async ({ document, selectSession, notifySession, deferNextSessionList, resolveDeferredSessionList }) => {
    await resolve(requests[0], [message('a', 1, '会话 A 最初完整回答')])
    await selectSession('b')
    await resolve(requests[1], [message('b', 1, '会话 B 完整回答')])
    deferNextSessionList()
    await act(async () => notifySession('a', 2))
    assert.equal(requests.length, 2, 'background events do not replace the selected transcript')
    await selectSession('a')
    await resolve(requests[2], [message('a', 1, '会话 A 最初完整回答')])
    assert.equal(document.querySelector('.assistant-message p')?.textContent, '会话 A 最初完整回答')
    await resolveDeferredSessionList()
    assert.deepEqual(cursorCalls(requests), [
      { sessionId: 'a', afterSeq: 0, limit: 1_000 }, { sessionId: 'b', afterSeq: 0, limit: 1_000 },
      { sessionId: 'a', afterSeq: 0, limit: 1_000 }, { sessionId: 'a', afterSeq: 1, limit: 1_000 }
    ], 'the newly acknowledged summary must catch up from the committed cursor without requiring another event notification')
    assert.equal(document.querySelector('.assistant-message p')?.textContent, '会话 A 最初完整回答')
    await resolve(requests[3], [message('a', 2, '延迟摘要确认的 A 最新回答')])
    assert.deepEqual([...document.querySelectorAll('.assistant-message p')].map(node => node.textContent),
      ['会话 A 最初完整回答', '延迟摘要确认的 A 最新回答'])
    assert.equal(document.querySelector('[role="alert"]'), null)
  }, { sessions: { a: 1, b: 1 } })
})

test('StrictMode ignores obsolete session summaries and pages across cleanup and remount without leaking subscriptions', async () => {
  const { requests, readEvents } = eventRequests()
  await withConversation(readEvents, async ({ document, unmount, remount, resolveFirstList, subscriptionCount }) => {
    await resolve(requests[0], history('a', 1_000))
    assert.equal(requests.length, 2)
    assert.equal(subscriptionCount(), 1)
    await resolveFirstList({ b: 1 })
    assert.equal(document.querySelector<HTMLSelectElement>('.assistant-session-select')?.value, 'a',
      'the abandoned StrictMode list request cannot change selection or its event high water')
    await remount()
    assert.equal(subscriptionCount(), 1)
    assert.equal(requests.length, 3)
    await resolve(requests[1], history('a', 1_000, 1_001))
    assert.equal(requests.length, 3, 'an old full page cannot continue after cleanup even when the same session is mounted again')
    assert.equal(document.querySelector('.assistant-message'), null)
    await resolve(requests[2], history('a', 1_000))
    const last = history('a', 1_000, 1_001)
    last[999] = message('a', 2_000, '重挂载后完整会话')
    await resolve(requests[3], last)
    assert.equal(document.querySelector('.assistant-message p')?.textContent, '重挂载后完整会话')
    await unmount()
    assert.equal(subscriptionCount(), 0)
    assert.equal(document.getElementById('mount')?.childElementCount, 0)
    assert.deepEqual(cursorCalls(requests).map(call => call.afterSeq), [0, 1_000, 0, 1_000])
  }, { sessions: { a: 2_000 }, strict: true, holdFirstList: true })
})

test('empty or non-advancing event pages cannot be mistaken for a complete high-water snapshot', async () => {
  const { requests, readEvents } = eventRequests()
  await withConversation(readEvents, async ({ document, refresh }) => {
    const first = message('a', 1, '已有完整回答')
    await resolve(requests[0], [first])
    await refresh(2)
    await resolve(requests[1], [])
    assert.ok(document.querySelector('[role="alert"]')?.textContent)
    assert.equal(document.querySelector('.assistant-message p')?.textContent, '已有完整回答')
    assert.equal(requests.length, 2, 'a missing page fails once instead of looping or silently truncating')
    await refresh(2)
    await resolve(requests[2], [first])
    assert.ok(document.querySelector('[role="alert"]')?.textContent)
    assert.equal(document.querySelectorAll('.assistant-message').length, 1)
    assert.equal(requests.length, 3, 'a repeated cursor fails once instead of rereading the same page indefinitely')
    await refresh(2)
    await resolve(requests[3], [message('a', 2, '恢复后的完整回答')])
    assert.equal(document.querySelector('[role="alert"]'), null)
    assert.deepEqual([...document.querySelectorAll('.assistant-message p')].map(node => node.textContent),
      ['已有完整回答', '恢复后的完整回答'])
    assert.deepEqual(cursorCalls(requests).map(call => call.afterSeq), [0, 1, 1, 1])
  }, { sessions: { a: 1 } })
})
