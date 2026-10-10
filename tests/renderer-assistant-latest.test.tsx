import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
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
const draft = 'Unsent extension request stays here'

function event<Type extends AssistantEventType>(sessionId: string, seq: number, type: Type,
  payload: AssistantEventPayloadMap[Type]): AssistantEvent<Type> {
  return { id: `${sessionId}-${seq}`, sessionId: assistantSessionId(sessionId), seq, type,
    surface: ASSISTANT_EVENT_SURFACES[type], payload, createdAt } as AssistantEvent<Type>
}

function message(sessionId: string, seq: number, text: string, step = `${sessionId}-step-${seq}`) {
  return event(sessionId, seq, 'assistant.message', { turnId, stepId: assistantStepId(step), text })
}

function history(sessionId: string, count = 20): AssistantEvent[] {
  return Array.from({ length: count }, (_, index) => message(sessionId, index + 1,
    `${sessionId} history ${index + 1}: ${'A saved paragraph worth reading. '.repeat(3)}`))
}

function pendingApproval(sessionId: string, seq: number) {
  return event(sessionId, seq, 'approval.requested', {
    turnId, toolCallId: assistantToolCallId('call'), approvalId: assistantApprovalId('pending'), pluginId: 'sample', revisionId: 'revision',
    scope: { kind: 'session', workspaceId: 'workspace', sessionId }, permissions: [], summary: 'Review the prepared extension',
    risk: 'low', expiresAt: '2099-01-01T00:00:00Z'
  })
}

function latestButton(document: Document): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => /Jump to latest|回到最新/.test(button.textContent ?? '')) ?? null
}

function newContentHint(document: Document): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[role="status"]')]
    .find(status => /New content|有新内容/.test(status.textContent ?? '')) ?? null
}

type DeferredRead = { resolve: () => Promise<void>; reject: (reason: Error) => Promise<void> }
type PendingEventRead = { sessionId: string; resolve?: () => void; reject?: (reason: Error) => void }

async function withConversation(options: { isZh?: boolean; visible?: boolean; sessions?: Record<string, AssistantEvent[]> }, run: (context: {
  document: Document
  window: JSDOM['window']
  transcript: HTMLElement
  sent: unknown[]
  resolvedApprovals: unknown[]
  append: (events: AssistantEvent[]) => Promise<void>
  notify: (sessionId: string) => Promise<void>
  scroll: (top: number) => Promise<void>
  setVisible: (visible: boolean) => Promise<void>
  selectSession: (sessionId: string) => Promise<void>
  deferNextRead: (sessionId: string) => DeferredRead
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const scrollPositions = new WeakMap<HTMLElement, number>()
  const laidOut = (element: HTMLElement) => element.classList.contains('assistant-transcript') && !element.closest('[hidden]')
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: { configurable: true, get(this: HTMLElement) { return laidOut(this) ? 400 : 0 } },
    scrollHeight: { configurable: true, get(this: HTMLElement) {
      if (!laidOut(this)) return 0
      const rows = [...this.querySelectorAll('.assistant-message, .assistant-tool-event, .assistant-lifecycle-event, .assistant-approval')]
      // Streaming changes the height of the same message element, not only the
      // number of rows. Hidden panels have no geometry, as in Chromium.
      return rows.length ? rows.reduce((height, row) => height + 140 + (row.textContent?.length ?? 0) * 2, 0) : this.clientHeight
    } },
    scrollTop: { configurable: true, get(this: HTMLElement) { return laidOut(this) ? scrollPositions.get(this) ?? 0 : 0 },
      set(this: HTMLElement, top: number) { scrollPositions.set(this, Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight))) } }
  })
  const sessions = new Map(Object.entries(options.sessions ?? { a: [...history('a'), pendingApproval('a', 21)] }))
  const listeners = new Set<(change: AssistantSessionChangedEvent) => void>()
  const sent: unknown[] = []
  const resolvedApprovals: unknown[] = []
  let deferred: PendingEventRead | undefined
  const emit = (sessionId: string) => {
    const events = sessions.get(sessionId)!
    for (const listener of [...listeners]) listener({ sessionId: assistantSessionId(sessionId), lastSeq: events.at(-1)?.seq ?? 0 })
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    listAssistantSessions: async (): Promise<AssistantSessionSummary[]> => [...sessions].map(([id, events]) => ({
      id: assistantSessionId(id), workspaceId: 'workspace',
      title: events.reduce((title, item) => item.type === 'session.title.updated' ? item.payload.title : title, id),
      activeDocumentId: null, modelConfig: {}, status: 'active',
      activeTurnId: null, lastSeq: events.at(-1)?.seq ?? 0, createdAt, updatedAt: createdAt
    })),
    getAssistantSessionEvents: (id: string, afterSeq = 0, limit = 500): Promise<AssistantEvent[]> => {
      const snapshot = sessions.get(id)!.filter(item => item.seq > afterSeq).slice(0, limit)
      if (deferred?.sessionId === id && !deferred.resolve) {
        const pending = deferred
        return new Promise((resolve, reject) => { pending.resolve = () => resolve(snapshot); pending.reject = reject })
      }
      return Promise.resolve(snapshot)
    },
    onAssistantSessionChanged: (listener: (change: AssistantSessionChangedEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    sendAssistantMessage: async (input: unknown) => { sent.push(input); return { status: 'completed' } },
    resolveAssistantApproval: async (input: unknown) => { resolvedApprovals.push(input); return { status: 'completed' } }
  } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let visible = options.visible ?? true
  const render = async () => {
    await act(async () => root.render(createElement('div', { hidden: !visible }, createElement(AssistantConversation,
      { activeDocumentId: null, aiEnabled: true, hasApiKey: true, isZh: options.isZh ?? false, isVisible: visible, initialDraft: draft }))))
  }
  try {
    await render()
    const transcript = dom.window.document.querySelector<HTMLElement>('.assistant-transcript')!
    await run({ document: dom.window.document, window: dom.window, transcript, sent, resolvedApprovals,
      append: async additions => {
        const id = additions[0].sessionId
        const existing = sessions.get(id)!
        assert.equal(additions[0].seq, (existing.at(-1)?.seq ?? 0) + 1, 'the fixture only appends immutable event facts')
        sessions.set(id, [...existing, ...additions])
        await act(async () => emit(id))
      },
      notify: async id => { await act(async () => emit(id)) },
      scroll: async top => { await act(async () => { transcript.scrollTop = top; transcript.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })) }) },
      setVisible: async next => { visible = next; await render() },
      selectSession: async id => {
        const select = dom.window.document.querySelector<HTMLSelectElement>('.assistant-session-select')!
        await act(async () => { select.value = id; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
      },
      deferNextRead: id => {
        assert.equal(deferred, undefined)
        const pending: PendingEventRead = { sessionId: id }
        deferred = pending
        return {
          resolve: async () => { assert.ok(pending.resolve); deferred = undefined; await act(async () => pending.resolve!()) },
          reject: async reason => { assert.ok(pending.reject); deferred = undefined; await act(async () => pending.reject!(reason)) }
        }
      }
    })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('history reading exposes a latest entry and streaming updates wait there until the reader explicitly resumes following', async () => {
  await withConversation({}, async ({ document, transcript, append, notify, scroll, sent, resolvedApprovals }) => {
    assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight)
    assert.equal(latestButton(document), null)
    assert.equal(newContentHint(document), null, 'restored history is the baseline, not unread live content')
    const status = document.querySelector('.assistant-latest-status')
    assert.equal(status?.getAttribute('role'), 'status')
    assert.equal(transcript.contains(status), false, 'the new-content announcement stays outside the transcript live region')
    await scroll(300)
    const jump = latestButton(document)
    assert.ok(jump)
    assert.equal(jump.type, 'button')
    assert.match(jump.textContent ?? '', /Jump to latest/)
    assert.equal(newContentHint(document), null)
    await notify('a')
    assert.equal(transcript.scrollTop, 300)
    assert.equal(newContentHint(document), null, 'duplicate notifications at the same sequence are not new content')
    await append([event('a', 22, 'session.title.updated', { title: 'Renamed existing conversation' })])
    assert.equal(transcript.scrollTop, 300)
    assert.equal(newContentHint(document), null, 'audit-only events cannot be mistaken for unread transcript content')
    assert.match(latestButton(document)?.textContent ?? '', /Jump to latest/)
    await append([event('a', 23, 'assistant.chunk', { turnId, stepId: assistantStepId('live-step'), text: 'Beginning' })])
    assert.equal(transcript.scrollTop, 300)
    assert.match(newContentHint(document)?.textContent ?? '', /New content/)
    assert.match(latestButton(document)?.textContent ?? '', /New content.*Jump to latest/)
    await append([event('a', 24, 'assistant.chunk', { turnId, stepId: assistantStepId('live-step'), text: ' continued' })])
    assert.equal(transcript.scrollTop, 300)
    assert.equal(document.querySelectorAll('.assistant-message').length, 21)
    assert.equal([...document.querySelectorAll('.assistant-message p')].at(-1)?.textContent, 'Beginning continued')
    await append([message('a', 25, 'Completed streamed answer', 'live-step')])
    assert.equal(transcript.scrollTop, 300)
    assert.equal(document.querySelectorAll('.assistant-message').length, 21)
    assert.equal([...document.querySelectorAll('.assistant-message p')].at(-1)?.textContent, 'Completed streamed answer')
    assert.match(newContentHint(document)?.textContent ?? '', /New content/)
    const currentJump = latestButton(document)!
    await act(async () => { currentJump.focus(); currentJump.click() })
    assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight)
    assert.equal(newContentHint(document), null)
    assert.equal(latestButton(document), null)
    assert.equal(document.activeElement, transcript, 'removing the focused jump button leaves focus on the keyboard-scrollable conversation')
    await append([message('a', 26, 'Later content follows automatically')])
    assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight)
    assert.equal(newContentHint(document), null)
    assert.equal(latestButton(document), null)
    assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, draft)
    assert.equal(document.querySelectorAll('.assistant-approval button').length, 2)
    assert.deepEqual(sent, [])
    assert.deepEqual(resolvedApprovals, [])
  })
})

test('the Chinese latest entry clears unread content when manual scrolling reaches the existing near-bottom threshold', async () => {
  await withConversation({ isZh: true }, async ({ document, transcript, append, scroll }) => {
    await scroll(transcript.scrollHeight - transcript.clientHeight - 49)
    assert.match(latestButton(document)?.textContent ?? '', /回到最新/)
    await append([message('a', 22, '中文界面的新回答')])
    assert.match(newContentHint(document)?.textContent ?? '', /有新内容/)
    assert.match(latestButton(document)?.textContent ?? '', /有新内容.*回到最新/)
    await scroll(transcript.scrollHeight - transcript.clientHeight - 48)
    assert.equal(latestButton(document), null)
    assert.equal(newContentHint(document), null)
    await append([message('a', 23, '已经回到底部后继续跟随')])
    assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight)
    assert.equal(newContentHint(document), null)
  })
})

test('tool results and a newly requested approval announce unread changes without moving the reader or taking actions', async () => {
  const stepId = assistantStepId('tool-step')
  const inspectCall = assistantToolCallId('inspect-call')
  const activationCall = assistantToolCallId('activation-call')
  const events = [...history('a'),
    event('a', 21, 'tool.call', { turnId, stepId, toolCallId: inspectCall, tool: 'plugins.inspect', version: 1, arguments: {} }),
    event('a', 22, 'tool.call', { turnId, stepId, toolCallId: activationCall, tool: 'plugins.activate_revision', version: 1,
      arguments: { pluginId: 'sample', revisionId: 'revision' } })]
  await withConversation({ sessions: { a: events } }, async ({ document, transcript, append, scroll, sent, resolvedApprovals }) => {
    const tools = () => [...document.querySelectorAll('.assistant-tool-event')]
    assert.equal(tools().length, 2)
    assert.equal(newContentHint(document), null)
    await scroll(300)
    await append([event('a', 23, 'tool.result', { turnId, stepId, toolCallId: inspectCall, status: 'succeeded', result: {} })])
    assert.equal(transcript.scrollTop, 300)
    assert.equal(tools().length, 2, 'completing an existing tool changes its card rather than appending a message')
    assert.match(tools()[0].textContent ?? '', /succeeded/)
    assert.ok(newContentHint(document), 'an updated tool card is unread content even when the number of rows is unchanged')
    await act(async () => latestButton(document)!.click())
    assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight)
    assert.equal(newContentHint(document), null)

    await scroll(300)
    await append([event('a', 24, 'approval.requested', {
      ...pendingApproval('a', 24).payload, toolCallId: activationCall, approvalId: assistantApprovalId('new-pending'),
      summary: 'Activate the prepared extension'
    })])
    assert.equal(transcript.scrollTop, 300)
    assert.match(newContentHint(document)?.textContent ?? '', /New content/)
    assert.match(latestButton(document)?.textContent ?? '', /New content.*Jump to latest/)
    assert.equal(document.querySelectorAll('.assistant-approval').length, 1)
    assert.match(document.querySelector('.assistant-approval')?.textContent ?? '', /Activate the prepared extension/)
    await act(async () => latestButton(document)!.click())
    assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight)
    assert.equal(latestButton(document), null)
    assert.equal(newContentHint(document), null)
    assert.equal(document.querySelectorAll('.assistant-approval button').length, 2, 'navigation leaves the new approval pending')
    assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, draft)
    assert.deepEqual(sent, [])
    assert.deepEqual(resolvedApprovals, [])
  })
})

test('hidden assistant updates preserve the history position and unread hint, while a pinned hidden conversation still follows on return', async () => {
  await withConversation({ visible: false }, async ({ document, window, transcript, append, scroll, setVisible }) => {
    assert.equal(transcript.scrollHeight, 0)
    assert.equal(transcript.scrollTop, 0)
    assert.equal(newContentHint(document), null)
    await setVisible(true)
    assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight)
    assert.equal(latestButton(document), null)
    await scroll(220)
    await setVisible(false)
    await act(async () => transcript.dispatchEvent(new window.Event('scroll', { bubbles: true })))
    await append([event('a', 22, 'assistant.chunk', { turnId, stepId: assistantStepId('hidden-live'), text: 'Background update' })])
    await setVisible(true)
    assert.equal(transcript.scrollTop, 220)
    assert.match(newContentHint(document)?.textContent ?? '', /New content/)
    const jump = latestButton(document)!
    await act(async () => { jump.focus(); jump.click() })
    assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight)
    assert.equal(newContentHint(document), null)
    await setVisible(false)
    await append([message('a', 23, 'Background update completed', 'hidden-live')])
    await setVisible(true)
    assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight)
    assert.equal(newContentHint(document), null)
    assert.equal(latestButton(document), null)
    assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, draft)
  })
})

for (const outcome of ['success', 'failure'] as const) {
  test('a late ' + outcome + ' from another assistant session cannot change the current reading position or unread prompt', async () => {
    await withConversation({ sessions: { a: [...history('a'), pendingApproval('a', 21)], b: history('b') } },
      async ({ document, transcript, append, scroll, selectSession, deferNextRead, sent, resolvedApprovals }) => {
        await scroll(300)
        await append([message('a', 22, 'New content in A')])
        assert.ok(newContentHint(document))
        const pending = deferNextRead('a')
        await append([message('a', 23, 'Late content belonging only to A')])
        await selectSession('b')
        assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight)
        assert.equal(latestButton(document), null)
        assert.equal(newContentHint(document), null, 'switching sessions starts a fresh unread baseline')
        await scroll(300)
        assert.ok(latestButton(document))
        if (outcome === 'success') await pending.resolve()
        else await pending.reject(new Error('Obsolete A read failure'))
        assert.equal(transcript.scrollTop, 300)
        assert.equal(newContentHint(document), null)
        assert.ok(latestButton(document))
        assert.equal(document.querySelector('[role="alert"]'), null)
        assert.equal(transcript.textContent?.includes('Late content belonging only to A'), false)
        await append([message('b', 21, 'New content in the selected B')])
        assert.ok(newContentHint(document))
        await selectSession('a')
        assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight)
        assert.equal(latestButton(document), null)
        assert.equal(newContentHint(document), null, 'previously saved A content is not misreported as new on re-selection')
        assert.equal(transcript.textContent?.includes('Late content belonging only to A'), true)
        assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, draft)
        assert.deepEqual(sent, [])
        assert.deepEqual(resolvedApprovals, [])
      })
  })
}
