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
import type { PluginJsonValue } from '../src/shared/plugin-platform'

const createdAt = '2026-10-10T00:00:00Z'
const turnId = assistantTurnId('activity-turn')
const stepId = assistantStepId('activity-step')
const draft = 'Keep this unsent extension request. 保留尚未发送的需求。'
const recordSelector = '.assistant-tool-event, .assistant-lifecycle-event'

function event<Type extends AssistantEventType>(sessionId: string, seq: number, type: Type,
  payload: AssistantEventPayloadMap[Type]): AssistantEvent {
  // Inputs retain their type/payload coupling; the heterogeneous event log
  // stores the complete discriminated union rather than a generic map lookup.
  return { id: `${sessionId}-activity-${seq}`, sessionId: assistantSessionId(sessionId), seq, type,
    surface: ASSISTANT_EVENT_SURFACES[type], payload, createdAt } as AssistantEvent
}

function eventList(sessionId: string) {
  const events: AssistantEvent[] = []
  const add = <Type extends AssistantEventType>(type: Type, payload: AssistantEventPayloadMap[Type]) => {
    const next = event(sessionId, events.length + 1, type, payload)
    events.push(next)
    return next
  }
  const call = (id: string, tool: string) => add('tool.call', {
    turnId, stepId, toolCallId: assistantToolCallId(id), tool, version: 1,
    arguments: { pluginId: 'sample', revisionId: 'revision' }
  })
  const result = (id: string, status: AssistantEventPayloadMap['tool.result']['status'], value: PluginJsonValue = {}) => add('tool.result', {
    turnId, stepId, toolCallId: assistantToolCallId(id), status, result: value
  })
  const message = (text: string) => add('assistant.message', {
    turnId, stepId: assistantStepId(`${sessionId}-message-${events.length + 1}`), text
  })
  const approval = (id: string, callId: string) => add('approval.requested', {
    turnId, toolCallId: assistantToolCallId(callId), approvalId: assistantApprovalId(id),
    pluginId: 'sample', revisionId: 'revision', permissions: [], summary: `Review ${id}`,
    scope: { kind: 'session', workspaceId: 'workspace', sessionId }, risk: 'low', expiresAt: '2099-01-01T00:00:00Z'
  })
  return { events, add, call, result, message, approval }
}

function groups(document: Document): HTMLDetailsElement[] {
  return [...document.querySelectorAll<HTMLDetailsElement>('details.assistant-activity-group')]
}

function summary(group: HTMLDetailsElement): HTMLElement {
  const element = group.querySelector<HTMLElement>(':scope > summary')
  assert.ok(element, 'completed records use the native details summary')
  return element
}

function isPresented(element: Element): boolean {
  if (element.closest('[hidden]')) return false
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.tagName === 'DETAILS' && !ancestor.hasAttribute('open')) {
      const firstSummary = [...ancestor.children].find(child => child.tagName === 'SUMMARY')
      if (firstSummary !== element && !firstSummary?.contains(element)) return false
    }
  }
  return true
}

function currentStatus(element: Element): string {
  return element.querySelector(':scope > span')?.textContent?.trim() ?? ''
}

type PendingEventRead = { sessionId: string; resolve?: () => void }

async function withConversation(options: { sessions: Record<string, AssistantEvent[]>; isZh?: boolean; verticalGeometry?: boolean }, run: (context: {
  document: Document
  transcript: HTMLElement
  sent: unknown[]
  resolvedApprovals: unknown[]
  draftChanges: string[]
  append: (events: AssistantEvent[]) => Promise<void>
  notify: (sessionId: string) => Promise<void>
  scroll: (top: number) => Promise<void>
  toggle: (group: HTMLDetailsElement, open: boolean) => Promise<void>
  setVisible: (visible: boolean) => Promise<void>
  selectSession: (sessionId: string) => Promise<void>
  deferNextRead: (sessionId: string) => { resolve: () => Promise<void> }
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const scrollPositions = new WeakMap<HTMLElement, number>()
  const laidOut = (element: HTMLElement) => element.classList.contains('assistant-transcript') && isPresented(element)
  const presentedRows = (element: HTMLElement): Element[] => [...element.querySelectorAll(
    `${recordSelector}, .assistant-message, .assistant-approval, .assistant-activity-group > summary`
  )].filter(isPresented)
  const rowHeight = (row: Element) => 140 + (row.textContent?.length ?? 0) * 2
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: { configurable: true, get(this: HTMLElement) { return laidOut(this) ? 400 : 0 } },
    scrollHeight: { configurable: true, get(this: HTMLElement) {
      if (!laidOut(this)) return 0
      // A closed native details body has no layout height. Opening it and
      // collapsing a completed card therefore change real scroll geometry.
      return Math.max(this.clientHeight, presentedRows(this).reduce((height, row) => height + rowHeight(row), 0))
    } },
    scrollTop: { configurable: true, get(this: HTMLElement) {
      return laidOut(this) ? Math.min(scrollPositions.get(this) ?? 0, this.scrollHeight - this.clientHeight) : 0
    }, set(this: HTMLElement, top: number) {
      scrollPositions.set(this, Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight)))
    } }
  })
  if (options.verticalGeometry) {
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value(this: HTMLElement) {
      if (laidOut(this)) return new dom.window.DOMRect(0, 100, 640, this.clientHeight)
      const transcript = this.closest<HTMLElement>('.assistant-transcript')
      if (!transcript || !laidOut(transcript) || !isPresented(this)) return new dom.window.DOMRect()
      const rows = presentedRows(transcript)
      const index = rows.indexOf(this)
      if (index < 0) return new dom.window.DOMRect()
      const precedingHeight = rows.slice(0, index).reduce((height, row) => height + rowHeight(row), 0)
      return new dom.window.DOMRect(0, 100 + precedingHeight - transcript.scrollTop, 640, rowHeight(this))
    } })
  }
  const sessions = new Map(Object.entries(options.sessions).map(([id, events]) => [id, [...events]]))
  const listeners = new Set<(change: AssistantSessionChangedEvent) => void>()
  const sent: unknown[] = []
  const resolvedApprovals: unknown[] = []
  const draftChanges: string[] = []
  let deferred: PendingEventRead | undefined
  const emit = (id: string) => {
    for (const listener of [...listeners]) listener({ sessionId: assistantSessionId(id), lastSeq: sessions.get(id)!.at(-1)?.seq ?? 0 })
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    listAssistantSessions: async (): Promise<AssistantSessionSummary[]> => [...sessions].map(([id, events]) => ({
      id: assistantSessionId(id), workspaceId: 'workspace', title: id, activeDocumentId: null, modelConfig: {}, status: 'active',
      activeTurnId: null, lastSeq: events.at(-1)?.seq ?? 0, createdAt, updatedAt: createdAt
    })),
    getAssistantSessionEvents: (id: string, afterSeq = 0, limit = 500): Promise<AssistantEvent[]> => {
      const snapshot = sessions.get(id)!.filter(item => item.seq > afterSeq).slice(0, limit)
      if (deferred?.sessionId === id && !deferred.resolve) {
        const pending = deferred
        return new Promise(resolve => { pending.resolve = () => resolve(snapshot) })
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
  let visible = true
  const render = async () => {
    await act(async () => root.render(createElement('div', { hidden: !visible }, createElement(AssistantConversation, {
      activeDocumentId: null, aiEnabled: true, hasApiKey: true, isZh: options.isZh ?? false, isVisible: visible, initialDraft: draft,
      onDraftChange: (value: string) => { draftChanges.push(value) }
    }))))
  }
  try {
    await render()
    const transcript = dom.window.document.querySelector<HTMLElement>('.assistant-transcript')!
    await run({ document: dom.window.document, transcript, sent, resolvedApprovals, draftChanges,
      append: async additions => {
        assert.ok(additions.length)
        const id = additions[0].sessionId
        const existing = sessions.get(id)!
        for (const [index, item] of additions.entries()) {
          assert.equal(item.sessionId, id)
          assert.equal(item.seq, (existing.at(-1)?.seq ?? 0) + index + 1, 'the fixture only appends immutable, ascending event facts')
        }
        sessions.set(id, [...existing, ...additions])
        await act(async () => emit(id))
      },
      notify: async id => { await act(async () => emit(id)) },
      scroll: async top => { await act(async () => {
        transcript.scrollTop = top
        transcript.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }))
      }) },
      toggle: async (group, open) => { await act(async () => {
        // JSDOM does not implement native keyboard activation. Model the
        // browser's open state and toggle event; Electron covers Enter/Space.
        group.open = open
        group.dispatchEvent(new dom.window.Event('toggle'))
      }) },
      setVisible: async next => { visible = next; await render() },
      selectSession: async id => { await act(async () => {
        const select = dom.window.document.querySelector<HTMLSelectElement>('.assistant-session-select')!
        select.value = id
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      }) },
      deferNextRead: id => {
        assert.equal(deferred, undefined)
        const pending: PendingEventRead = { sessionId: id }
        deferred = pending
        return { resolve: async () => {
          assert.ok(pending.resolve)
          deferred = undefined
          await act(async () => pending.resolve!())
        } }
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

for (const isZh of [false, true]) {
  test(`completed activities collapse in place and expose their original ordered details (${isZh ? 'Chinese' : 'English'})`, async () => {
    const a = eventList('a')
    a.add('user.message', { turnId, text: 'Requested extension' })
    a.call('inspect', 'documents.get'); a.result('inspect', 'succeeded')
    a.add('plugin.revision.defined', { turnId, pluginId: 'sample', revisionId: 'revision', previousRevisionId: null })
    a.add('plugin.validation.completed', { turnId, pluginId: 'sample', revisionId: 'revision', status: 'passed', diagnostics: [] })
    a.message('First answer remains here')
    a.call('search', 'documents.search'); a.result('search', 'succeeded')
    a.message('Final answer remains here')
    await withConversation({ sessions: { a: a.events }, isZh }, async ({ document, transcript, toggle, sent, resolvedApprovals, draftChanges }) => {
      const [first, second] = groups(document)
      assert.equal(groups(document).length, 2)
      assert.equal(first.open, false)
      assert.equal(second.open, false)
      assert.match(summary(first).textContent ?? '', isZh ? /已完成 3 项操作/ : /3 completed actions/)
      assert.match(summary(second).textContent ?? '', isZh ? /已完成 1 项操作/ : /1 completed action/)
      const messages = [...document.querySelectorAll('.assistant-message')]
      assert.equal(messages.length, 3)
      for (const message of messages) assert.equal(isPresented(message), true)
      const order = [messages[0], first, messages[1], second, messages[2]]
      for (let index = 1; index < order.length; index++) {
        assert.ok(order[index - 1].compareDocumentPosition(order[index]) & 4, 'folding keeps activities between their original neighboring messages')
      }
      const records = [...first.querySelectorAll(recordSelector)]
      assert.equal(records.length, 3)
      assert.equal(records.every(record => !isPresented(record)), true)
      const foldedHeight = transcript.scrollHeight
      summary(first).focus()
      await toggle(first, true)
      assert.equal(groups(document)[0], first)
      assert.equal(document.activeElement, summary(first))
      assert.equal(records.every(isPresented), true)
      assert.equal(records[0].querySelector('code')?.textContent, 'documents.get')
      assert.match(records[1].textContent ?? '', /sample.*revision/)
      assert.equal(currentStatus(records[2]), isZh ? '通过' : 'passed')
      assert.ok(transcript.scrollHeight > foldedHeight)
      await toggle(first, false)
      assert.equal(first.open, false)
      assert.equal(transcript.scrollHeight, foldedHeight)
      assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, draft)
      assert.deepEqual(sent, []); assert.deepEqual(resolvedApprovals, []); assert.deepEqual(draftChanges, [])
    })
  })
}

test('failed, warning, running, queued, cancelled and approval records remain presented beside collapsed successes', async () => {
  const a = eventList('a')
  a.call('complete', 'completed.tool'); a.result('complete', 'succeeded')
  a.call('failed', 'failed.tool'); a.result('failed', 'failed', { error: { message: 'Required document is missing' } })
  a.call('running', 'running.tool')
  a.call('cancelled', 'cancelled.tool'); a.result('cancelled', 'cancelled')
  a.call('waiting', 'waiting.tool'); a.result('waiting', 'awaiting-approval')
  a.approval('visible-approval', 'waiting')
  a.add('inbox.message', { messageId: 'queued', text: 'Queued request remains readable', mode: 'next-turn' })
  a.add('plugin.validation.completed', { turnId, pluginId: 'warning-plugin', revisionId: 'revision', status: 'warning', diagnostics: [{ message: 'Review the permission warning' }] })
  a.add('plugin.run.stopped', { pluginId: 'stopped-plugin', revisionId: 'revision', runId: 'stopped-run' })
  a.add('session.error', { error: { message: 'Session recovery needs attention' } })
  a.add('plugin.revision.defined', { turnId, pluginId: 'finished-plugin', revisionId: 'revision', previousRevisionId: null })
  await withConversation({ sessions: { a: a.events } }, async ({ document, sent, resolvedApprovals, draftChanges }) => {
    assert.equal(groups(document).length, 2)
    for (const [tool, status] of [['failed.tool', 'failed'], ['running.tool', 'running'], ['cancelled.tool', 'cancelled'], ['waiting.tool', 'awaiting approval']]) {
      const record = [...document.querySelectorAll('.assistant-tool-event')].find(element => element.querySelector('code')?.textContent === tool)
      assert.ok(record)
      assert.equal(isPresented(record), true, `${tool} cannot disappear inside a completed group`)
      assert.equal(record.closest('.assistant-activity-group'), null)
      assert.equal(currentStatus(record), status)
    }
    const failed = [...document.querySelectorAll('.assistant-tool-event')].find(element => element.textContent?.includes('Required document is missing'))
    assert.ok(failed)
    for (const status of ['queued', 'warning', 'cancelled', 'failed']) {
      const lifecycle = document.querySelector(`.assistant-lifecycle-${status}`)
      assert.ok(lifecycle)
      assert.equal(isPresented(lifecycle), true)
      assert.equal(lifecycle.closest('.assistant-activity-group'), null)
    }
    const approval = document.querySelector('.assistant-approval')
    assert.ok(approval)
    assert.equal(isPresented(approval), true)
    assert.equal(approval.closest('.assistant-activity-group'), null)
    const approvalButtons = [...approval.querySelectorAll<HTMLButtonElement>('button')]
    assert.deepEqual(approvalButtons.map(button => button.textContent?.trim()), ['Allow once', 'Reject'])
    assert.equal(approvalButtons.every(button => !button.disabled), true)
    assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, draft)
    assert.deepEqual(sent, []); assert.deepEqual(resolvedApprovals, []); assert.deepEqual(draftChanges, [])
  })
})

test('run histories keep one stable card per run and approval decisions cannot overwrite another run or its completed terminal state', async () => {
  const a = eventList('a')
  const request = (id: string, operation: 'activate' | 'rollback' = 'activate') => {
    a.call(id, operation === 'rollback' ? 'plugins.rollback' : 'plugins.activate_revision')
    a.add('plugin.run.requested', { turnId, toolCallId: assistantToolCallId(id), pluginId: 'sample', revisionId: 'revision',
      runId: id, operation, ...(operation === 'rollback' ? { fromRevisionId: 'previous-revision' } : {}) })
    a.approval(`${id}-approval`, id)
  }
  request('succeeded-run', 'rollback')
  a.add('approval.resolved', { approvalId: assistantApprovalId('succeeded-run-approval'), decision: 'allowed-once' })
  a.add('plugin.run.started', { pluginId: 'sample', revisionId: 'revision', runId: 'succeeded-run' })
  a.add('plugin.run.succeeded', { pluginId: 'sample', revisionId: 'revision', runId: 'succeeded-run', epoch: 1 })
  a.result('succeeded-run', 'succeeded')
  request('failed-run')
  a.add('approval.resolved', { approvalId: assistantApprovalId('failed-run-approval'), decision: 'allowed-once' })
  a.add('plugin.run.started', { pluginId: 'sample', revisionId: 'revision', runId: 'failed-run' })
  a.add('plugin.run.failed', { pluginId: 'sample', revisionId: 'revision', runId: 'failed-run', error: { message: 'This separate run failed' } })
  a.result('failed-run', 'failed', { error: { message: 'This separate run failed' } })
  const pendingDecisions = [['allow', 'allowed-once', 'running'], ['reject', 'rejected', 'failed'],
    ['unavailable', 'unavailable', 'failed'], ['cancel', 'cancelled', 'cancelled']] as const
  for (const [id] of pendingDecisions) request(id)
  await withConversation({ sessions: { a: a.events } }, async ({ document, append, sent, resolvedApprovals }) => {
    const runs = [...document.querySelectorAll('.assistant-lifecycle-event')]
    assert.equal(runs.length, 6, 'requested, started and terminal facts aggregate by runId, not plugin or revision')
    assert.equal(currentStatus(runs[0]), 'succeeded')
    assert.ok(runs[0].closest('.assistant-activity-group'))
    assert.equal(currentStatus(runs[1]), 'failed')
    assert.equal(isPresented(runs[1]), true)
    assert.match(runs[1].textContent ?? '', /This separate run failed/)
    assert.match(runs[0].querySelector('.assistant-run-history')?.textContent ?? '', /requested.*started.*succeeded/i)
    assert.match(runs[1].querySelector('.assistant-run-history')?.textContent ?? '', /requested.*started.*failed/i)
    for (const run of runs.slice(2)) {
      assert.equal(currentStatus(run), 'awaiting approval')
      assert.equal(isPresented(run), true)
    }
    assert.equal(document.querySelectorAll('.assistant-approval').length, 4)
    const resolutions = pendingDecisions.map(([id, decision]) => a.add('approval.resolved', {
      approvalId: assistantApprovalId(`${id}-approval`), decision
    }))
    await append(resolutions)
    assert.equal(document.querySelectorAll('.assistant-approval').length, 0)
    const updated = [...document.querySelectorAll('.assistant-lifecycle-event')]
    assert.equal(updated.length, 6)
    assert.equal(updated[0], runs[0])
    assert.equal(updated[1], runs[1])
    assert.equal(currentStatus(updated[0]), 'succeeded', 'an already resolved approval cannot revive the completed run')
    assert.equal(currentStatus(updated[1]), 'failed', 'other runs with the same plugin and revision remain independent')
    for (const [index, [, , status]] of pendingDecisions.entries()) {
      assert.equal(updated[index + 2], runs[index + 2])
      assert.equal(currentStatus(updated[index + 2]), status)
      assert.equal(isPresented(updated[index + 2]), true)
      const tool = [...document.querySelectorAll('.assistant-tool-event')][index + 2]
      assert.equal(currentStatus(tool), status)
      assert.equal(tool.closest('.assistant-activity-group'), null)
    }
    await append([a.add('plugin.rollback.completed', { pluginId: 'sample', fromRevisionId: 'previous-revision',
      toRevisionId: 'revision', runId: 'succeeded-run' })])
    const afterRollback = [...document.querySelectorAll('.assistant-lifecycle-event')]
    assert.equal(afterRollback.length, 6)
    assert.equal(afterRollback[0], runs[0], 'rollback completion updates the same run card anchored at its first fact')
    assert.equal(currentStatus(afterRollback[0]), 'succeeded')
    assert.match(afterRollback[0].querySelector('.assistant-run-history')?.textContent ?? '', /rollback/i)
    assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, draft)
    assert.deepEqual(sent, []); assert.deepEqual(resolvedApprovals, [])
  })
})

test('successful validation tool transport cannot hide warning or failed validation diagnostics', async () => {
  const a = eventList('a')
  a.call('passing-validation', 'plugins.validate_revision')
  a.result('passing-validation', 'succeeded', { status: 'passed', diagnostics: [] })
  a.call('warning-validation', 'plugins.validate_revision')
  a.result('warning-validation', 'succeeded', { status: 'warning', diagnostics: [{ code: 'broad-permission', message: 'Review broad permission access' }] })
  a.call('failed-validation', 'plugins.validate_revision')
  a.result('failed-validation', 'succeeded', { status: 'failed', diagnostics: [{ code: 'forbidden-api', message: 'Forbidden API reference' }] })
  await withConversation({ sessions: { a: a.events } }, async ({ document }) => {
    assert.equal(groups(document).length, 1)
    const tools = [...document.querySelectorAll('.assistant-tool-event')]
    assert.equal(tools.length, 3)
    assert.equal(isPresented(tools[0]), false)
    for (const [index, status, detail] of [[1, 'warning', 'Review broad permission access'], [2, 'failed', 'Forbidden API reference']] as const) {
      assert.equal(isPresented(tools[index]), true)
      assert.equal(tools[index].closest('.assistant-activity-group'), null)
      assert.equal(currentStatus(tools[index]), status)
      assert.match(tools[index].textContent ?? '', new RegExp(detail))
    }
    assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, draft)
  })
})

test('completing an intervening activity preserves the later group identity, expansion, focus and reading intent across updates and task visibility', async () => {
  const a = eventList('a')
  for (let index = 0; index < 12; index++) a.message(`History ${index + 1}: ${'Read these earlier extension decisions. '.repeat(3)}`)
  a.call('A', 'A.success'); a.result('A', 'succeeded')
  a.call('B', 'B.running')
  a.call('C', 'C.success'); a.result('C', 'succeeded')
  const b = eventList('b')
  b.call('B-session', 'Other.session.success'); b.result('B-session', 'succeeded')
  await withConversation({ sessions: { a: a.events, b: b.events } },
    async ({ document, transcript, append, notify, scroll, toggle, setVisible, selectSession, deferNextRead, sent, resolvedApprovals, draftChanges }) => {
      const [earlier, later] = groups(document)
      assert.equal(groups(document).length, 2)
      const laterSummary = summary(later)
      const laterCard = later.querySelector('.assistant-tool-event')
      assert.ok(laterCard)
      await toggle(later, true)
      await scroll(300)
      laterSummary.focus()
      await append([a.result('B', 'succeeded')])
      assert.equal(groups(document).length, 2, 'completing the gap cannot merge away the reader\'s later group')
      assert.equal(groups(document)[0], earlier)
      assert.equal(groups(document)[1], later)
      assert.equal(summary(later), laterSummary)
      assert.equal(later.querySelector('.assistant-tool-event'), laterCard)
      assert.equal(later.open, true)
      assert.equal(document.activeElement, laterSummary)
      assert.match(earlier.textContent ?? '', /B\.running/)
      assert.match(summary(earlier).textContent ?? '', /2 completed actions/)
      assert.equal(transcript.scrollTop, 300)
      await notify('a')
      assert.equal(groups(document)[1], later)
      assert.equal(later.open, true)
      assert.equal(document.activeElement, laterSummary)

      await setVisible(false)
      await append([a.message('A background answer must preserve the expanded history')])
      await setVisible(true)
      assert.equal(groups(document)[1], later)
      assert.equal(later.open, true)
      assert.equal(transcript.scrollTop, 300)
      const pending = deferNextRead('a')
      await append([a.add('plugin.revision.defined', { turnId, pluginId: 'late-a-only', revisionId: 'revision', previousRevisionId: null })])
      await selectSession('b')
      const other = groups(document)[0]
      assert.equal(groups(document).length, 1)
      assert.equal(other.open, false)
      assert.notEqual(other, later)
      await toggle(other, true)
      summary(other).focus()
      await pending.resolve()
      assert.equal(groups(document)[0], other)
      assert.equal(other.open, true)
      assert.equal(document.activeElement, summary(other))
      assert.equal(transcript.textContent?.includes('late-a-only'), false)
      await selectSession('a')
      const fresh = groups(document)
      assert.equal(fresh.length, 2, 'a fresh selection combines the now-contiguous A, B and C successes, separated from the later revision by its answer')
      assert.equal(fresh.every(group => !group.open), true, 'a new selection starts a fresh expansion baseline')
      assert.match(summary(fresh[0]).textContent ?? '', /3 completed actions/)
      assert.deepEqual([...fresh[0].querySelectorAll('.assistant-tool-event > code')].map(node => node.textContent),
        ['A.success', 'B.running', 'C.success'])
      assert.match(summary(fresh[1]).textContent ?? '', /1 completed action/)
      assert.match(fresh[1].querySelector('.assistant-lifecycle-event')?.textContent ?? '', /late-a-only/)
      const separatingAnswer = [...document.querySelectorAll('.assistant-message')]
        .find(node => node.textContent?.includes('A background answer must preserve the expanded history'))
      assert.ok(separatingAnswer)
      assert.ok(fresh[0].compareDocumentPosition(separatingAnswer) & 4)
      assert.ok(separatingAnswer.compareDocumentPosition(fresh[1]) & 4)
      assert.equal(later.isConnected, false)
      assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight)
      assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, draft)
      assert.deepEqual(sent, []); assert.deepEqual(resolvedApprovals, []); assert.deepEqual(draftChanges, [])
    })
})

test('stopping the only completed run reveals its history and restores a removed summary focus without stealing composer focus', async () => {
  for (const focusOrigin of ['summary', 'composer', 'pinned-summary'] as const) {
    const a = eventList('a')
    for (let index = 0; index < 12; index++) a.message(`Reading history ${index + 1}: ${'Keep these earlier decisions in view. '.repeat(3)}`)
    a.add('plugin.run.requested', { turnId, toolCallId: assistantToolCallId('preview-call'), pluginId: 'preview-plugin',
      revisionId: 'preview-revision', runId: 'preview-run', operation: 'activate' })
    a.add('plugin.run.started', { pluginId: 'preview-plugin', revisionId: 'preview-revision', runId: 'preview-run' })
    a.add('plugin.run.succeeded', { pluginId: 'preview-plugin', revisionId: 'preview-revision', runId: 'preview-run', epoch: 1 })
    await withConversation({ sessions: { a: a.events } }, async ({ document, transcript, append, scroll, toggle, sent, resolvedApprovals, draftChanges }) => {
      const completed = groups(document)[0]
      assert.equal(groups(document).length, 1)
      assert.equal(completed.querySelectorAll(recordSelector).length, 1)
      const oldSummary = summary(completed)
      const composer = document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')!
      if (focusOrigin !== 'pinned-summary') {
        await scroll(300)
        await toggle(completed, true)
      } else {
        assert.equal(completed.open, false)
        assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight)
        assert.equal(document.querySelector('.assistant-latest-button'), null)
      }
      if (focusOrigin === 'composer') composer.focus()
      else oldSummary.focus()
      assert.equal(document.activeElement, focusOrigin === 'composer' ? composer : oldSummary)
      await append([a.add('plugin.run.stopped', { pluginId: 'preview-plugin', revisionId: 'preview-revision', runId: 'preview-run' })])
      assert.equal(groups(document).length, 0, 'a stopped preview is no longer a completed activity')
      assert.equal(oldSummary.isConnected, false)
      const records = [...document.querySelectorAll('.assistant-lifecycle-event')]
      assert.equal(records.length, 1)
      assert.equal(currentStatus(records[0]), 'cancelled')
      assert.equal(isPresented(records[0]), true)
      assert.match(records[0].querySelector('.assistant-run-history')?.textContent ?? '', /requested.*started.*succeeded.*stopped/i)
      assert.equal(document.activeElement, focusOrigin === 'composer' ? composer : transcript,
        focusOrigin === 'composer' ? 'background regrouping cannot take focus from the draft' : 'a removed focused disclosure returns focus even when the reader never opened or scrolled it')
      assert.equal(transcript.scrollTop, focusOrigin === 'pinned-summary' ? transcript.scrollHeight - transcript.clientHeight : 300)
      assert.equal(composer.value, draft)
      assert.deepEqual(sent, []); assert.deepEqual(resolvedApprovals, []); assert.deepEqual(draftChanges, [])
    })
  }
})

test('a rollback tool outcome supplies a missing run terminal state while an already committed success remains authoritative', async () => {
  for (const outcome of ['failed', 'cancelled', 'committed-success'] as const) {
    const a = eventList('a')
    a.call('rollback-call', 'plugins.rollback')
    a.add('plugin.run.requested', { turnId, toolCallId: assistantToolCallId('rollback-call'), pluginId: 'sample',
      revisionId: 'revision', runId: 'rollback-run', operation: 'rollback', fromRevisionId: 'previous-revision' })
    a.approval('rollback-approval', 'rollback-call')
    a.add('approval.resolved', { approvalId: assistantApprovalId('rollback-approval'), decision: 'allowed-once' })
    a.add('plugin.run.started', { pluginId: 'sample', revisionId: 'revision', runId: 'rollback-run' })
    if (outcome === 'committed-success') {
      a.add('plugin.run.succeeded', { pluginId: 'sample', revisionId: 'revision', runId: 'rollback-run', epoch: 1 })
    }
    await withConversation({ sessions: { a: a.events } }, async ({ document, append, sent, resolvedApprovals, draftChanges }) => {
      const originalRun = document.querySelector('.assistant-lifecycle-event')!
      assert.equal(document.querySelectorAll('.assistant-lifecycle-event').length, 1)
      assert.equal(currentStatus(originalRun), outcome === 'committed-success' ? 'succeeded' : 'running')
      const resultStatus = outcome === 'cancelled' ? 'cancelled' : 'failed'
      const detail = outcome === 'committed-success' ? 'The caller failed after activation committed' : 'Rollback preparation failed before activation'
      await append([a.result('rollback-call', resultStatus, { error: { message: detail } })])
      const run = document.querySelector('.assistant-lifecycle-event')!
      const tool = document.querySelector('.assistant-tool-event')!
      assert.equal(run, originalRun, 'the tool outcome updates the run anchored at its first lifecycle fact')
      assert.equal(currentStatus(tool), resultStatus)
      assert.equal(isPresented(tool), true)
      assert.equal(tool.closest('.assistant-activity-group'), null)
      assert.equal(document.querySelectorAll('.assistant-approval').length, 0)
      assert.equal(a.events.some(item => item.type === 'plugin.run.failed' || item.type === 'plugin.run.stopped'), false,
        'the regression fixture has no explicit lifecycle failure or cancellation to mask the missing outcome')
      if (outcome === 'committed-success') {
        assert.equal(currentStatus(run), 'succeeded', 'a real run success wins over a later failure reported by its caller')
        assert.match(run.querySelector('.assistant-run-history')?.textContent ?? '', /requested.*started.*succeeded/i)
      } else {
        assert.equal(currentStatus(run), resultStatus)
        assert.equal(isPresented(run), true)
        assert.equal(run.closest('.assistant-activity-group'), null)
        assert.match(run.querySelector('.assistant-run-history')?.textContent ?? '', /requested.*started.*Operation result/i)
        if (outcome === 'failed') assert.match(run.textContent ?? '', /Rollback preparation failed before activation/)
      }
      assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, draft)
      assert.deepEqual(sent, []); assert.deepEqual(resolvedApprovals, []); assert.deepEqual(draftChanges, [])
    })
  }
})

test('sending from history resumes following but immediately returning to that reading position pauses later streaming again', async () => {
  const a = eventList('a')
  for (let index = 0; index < 12; index++) a.message(`Saved answer ${index + 1}: ${'These earlier decisions are still worth reading. '.repeat(3)}`)
  a.call('finishing-tool', 'documents.search')
  await withConversation({ sessions: { a: a.events } }, async ({ document, transcript, append, scroll, sent, resolvedApprovals, draftChanges }) => {
    await scroll(300)
    await append([a.result('finishing-tool', 'succeeded')])
    assert.equal(transcript.scrollTop, 300)
    assert.equal(groups(document).length, 1)
    assert.equal(groups(document)[0].open, false)

    const sendButton = document.querySelector<HTMLButtonElement>('.assistant-composer button')!
    assert.equal(sendButton.disabled, false)
    await act(async () => sendButton.click())
    assert.deepEqual(sent, [{ sessionId: 'a', text: draft.trim(), mode: 'auto' }])
    assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, '')
    assert.deepEqual(draftChanges, [''])
    assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight)
    assert.equal(document.querySelector('.assistant-latest-button'), null)

    await scroll(300)
    assert.equal(transcript.scrollTop, 300)
    assert.match(document.querySelector('.assistant-latest-button')?.textContent ?? '', /Jump to latest/)
    assert.equal(document.querySelector('.assistant-latest-status')?.textContent, '')
    const sentTurn = assistantTurnId('sent-turn')
    const sentStep = assistantStepId('sent-stream')
    await append([a.add('assistant.chunk', { turnId: sentTurn, stepId: sentStep, text: 'A reply arrives after sending' })])
    assert.equal(transcript.scrollTop, 300, 'returning to the previous reading position is a new user choice after sending')
    assert.match(document.querySelector('.assistant-latest-status')?.textContent ?? '', /New content/)
    assert.match(document.querySelector('.assistant-latest-button')?.textContent ?? '', /New content.*Jump to latest/)
    await append([a.add('assistant.chunk', { turnId: sentTurn, stepId: sentStep, text: ' and continues streaming' })])
    assert.equal(transcript.scrollTop, 300)
    assert.match([...document.querySelectorAll('.assistant-message')].at(-1)?.textContent ?? '', /A reply arrives after sending and continues streaming/)
    assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, '')
    assert.equal(sent.length, 1)
    assert.deepEqual(resolvedApprovals, [])
  })
})

test('hidden completion above the paragraph being read restores its viewport position using the surviving content anchor', async () => {
  const a = eventList('a')
  a.message('Earlier context before the operations')
  a.call('first-hidden-tool', 'documents.get')
  a.call('second-hidden-tool', 'documents.search')
  const targetText = 'The paragraph being read must stay at the same place in the viewport. '.repeat(3).trim()
  a.message(targetText)
  for (let index = 0; index < 12; index++) a.message(`Later saved answer ${index + 1}: ${'Keep enough history below the reading anchor. '.repeat(3)}`)
  await withConversation({ sessions: { a: a.events }, verticalGeometry: true },
    async ({ document, transcript, append, scroll, setVisible, sent, resolvedApprovals, draftChanges }) => {
      const target = [...document.querySelectorAll<HTMLElement>('.assistant-message')]
        .find(node => node.textContent?.includes(targetText))
      assert.ok(target)
      const viewportY = () => target.getBoundingClientRect().top - transcript.getBoundingClientRect().top
      const targetContentTop = viewportY() + transcript.scrollTop
      await scroll(targetContentTop - 80)
      assert.equal(viewportY(), 80)
      const originalTop = transcript.scrollTop
      const tools = [...document.querySelectorAll('.assistant-tool-event')]
      assert.equal(tools.length, 2)
      const expandedOperationsHeight = tools.reduce((height, tool) => height + tool.getBoundingClientRect().height, 0)
      assert.ok(expandedOperationsHeight > 0)

      await setVisible(false)
      assert.equal(transcript.clientHeight, 0)
      assert.equal(target.getBoundingClientRect().height, 0)
      await append([a.result('first-hidden-tool', 'succeeded'), a.result('second-hidden-tool', 'succeeded')])
      assert.equal(groups(document).length, 1)
      assert.equal(groups(document)[0].open, false)
      await setVisible(true)

      const returnedTarget = [...document.querySelectorAll('.assistant-message')]
        .find(node => node.textContent?.includes(targetText))
      assert.equal(returnedTarget, target, 'the saved content anchor survives hidden regrouping')
      const completedSummaryHeight = summary(groups(document)[0]).getBoundingClientRect().height
      const removedHeight = expandedOperationsHeight - completedSummaryHeight
      assert.ok(removedHeight > 0, 'two full operation cards shrink to one closed disclosure summary')
      assert.equal(transcript.scrollTop, originalTop - removedHeight,
        'restoring the content requires changing the numeric offset by the height removed above it')
      assert.notEqual(transcript.scrollTop, originalTop)
      assert.equal(viewportY(), 80, 'the paragraph returns to the same viewport position rather than the former numeric scrollTop')
      assert.match(document.querySelector('.assistant-latest-button')?.textContent ?? '', /New content.*Jump to latest/)
      assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')?.value, draft)
      assert.deepEqual(sent, []); assert.deepEqual(resolvedApprovals, []); assert.deepEqual(draftChanges, [])
    })
})
