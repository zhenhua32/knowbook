import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useState, type ChangeEvent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { AiAnswerContent } from '../src/renderer/src/components/AiAnswerContent'
import { AiTaskSwitcher } from '../src/renderer/src/components/AiTaskSwitcher'
import { AssistantConversation } from '../src/renderer/src/components/AssistantConversation'

test('AI answers render headings, lists, tables and code without executing HTML or fetching images', () => {
  const html = renderToStaticMarkup(createElement(AiAnswerContent, { content: '# 要点\n\n**重点**\n\n- 第一点\n- 第二点\n\n| 项目 | 内容 |\n| --- | --- |\n| A | B |\n\n```js\nconst a = 1\n```\n\n<script>alert(1)</script>\n\n<img src="https://example.com/pixel" onerror="alert(1)">\n\n![远程图](https://example.com/image.png)\n\n[危险链接](javascript:alert(1))\n\n[安全链接](https://example.com)' }))
  const dom = new JSDOM(html)
  const document = dom.window.document
  assert.equal(document.querySelector('h1')?.textContent, '要点')
  assert.equal(document.querySelector('strong')?.textContent, '重点')
  assert.equal(document.querySelectorAll('li').length, 2)
  assert.equal(document.querySelector('table td')?.textContent, 'A')
  assert.equal(document.querySelector('pre code')?.textContent.trim(), 'const a = 1')
  assert.equal(document.querySelectorAll('script, img, iframe, [onerror], [onclick]').length, 0)
  assert.equal(document.querySelectorAll('[href^="javascript:"], [src^="javascript:"]').length, 0)
  assert.equal(document.querySelector('button[title="https://example.com"]')?.textContent, '安全链接')
  dom.window.close()
})

function session(id: string, lastSeq = 1) {
  return { id, workspaceId: 'workspace', title: id, activeDocumentId: null, modelConfig: {}, status: 'active', activeTurnId: null,
    lastSeq, createdAt: '2026-10-01T01:00:00Z', updatedAt: '2026-10-01T01:00:00Z' }
}
function message(sessionId: string, text: string) {
  return { id: sessionId + '-message', sessionId, workspaceId: 'workspace', seq: 1, createdAt: '2026-10-01T01:00:00Z', surface: 'conversation',
    type: 'assistant.message', payload: { turnId: sessionId + '-turn', stepId: sessionId + '-step', text } }
}

async function withWorkspace(api: Record<string, unknown>, run: (context: {
  document: Document; window: JSDOM['window']; render: (node: ReturnType<typeof createElement>) => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window, 'knowbook', { value: { onAssistantSessionChanged: () => () => {}, ...api } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  try {
    await run({ document: dom.window.document, window: dom.window, render: async node => { await act(async () => root.render(node)) } })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('task switching keeps document and extension drafts, conversation and approval controls mounted', async () => {
  const approval = { id: 'approval-event', sessionId: 'app', workspaceId: 'workspace', seq: 2, createdAt: '2026-10-01T01:00:00Z', surface: 'conversation',
    type: 'approval.requested', payload: { turnId: 'turn', toolCallId: 'call', approvalId: 'approval', pluginId: 'sample', revisionId: 'revision',
      scope: { kind: 'session', workspaceId: 'workspace', sessionId: 'app' }, permissions: [], summary: '请确认这个扩展', risk: 'low', expiresAt: '2099-01-01T00:00:00Z' } }
  await withWorkspace({ listAssistantSessions: async () => [session('app', 2)], getAssistantSessionEvents: async () => [message('app', '**现有对话**'), approval] },
    async ({ document, window, render }) => {
      function DocumentPrompt() {
        const [draft, setDraft] = useState('文档问题')
        return createElement('textarea', { className: 'document-prompt', value: draft, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.currentTarget.value) })
      }
      await render(createElement(AiTaskSwitcher, { isZh: true, documentContent: createElement(DocumentPrompt),
        extensionContent: createElement(AssistantConversation, { activeDocumentId: null, aiEnabled: true, hasApiKey: true, isZh: true }) }))
      const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      const panels = [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
      assert.equal(tabs[0].getAttribute('aria-selected'), 'true')
      assert.equal(panels[1].hidden, true)
      const documentPrompt = document.querySelector<HTMLTextAreaElement>('.document-prompt')!
      const extensionPrompt = document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(extensionPrompt, '尚未发送的扩展需求')
        extensionPrompt.dispatchEvent(new window.Event('input', { bubbles: true }))
        tabs[1].click()
      })
      assert.equal(panels[0].hidden, true)
      assert.equal(panels[1].hidden, false)
      assert.equal(document.querySelector('.assistant-message strong')?.textContent, '现有对话')
      assert.equal(document.querySelector('.assistant-approval strong')?.textContent, '插件激活审批')
      await act(async () => tabs[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })))
      assert.equal(document.activeElement, tabs[0])
      assert.equal(panels[0].hidden, false)
      assert.equal(document.querySelector('.document-prompt'), documentPrompt)
      assert.equal(documentPrompt.value, '文档问题')
      await act(async () => tabs[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })))
      assert.equal(document.activeElement, tabs[1])
      assert.equal(document.querySelector('.assistant-composer textarea'), extensionPrompt)
      assert.equal(extensionPrompt.value, '尚未发送的扩展需求')
      assert.equal(document.querySelectorAll('.assistant-approval button').length, 2)
      assert.equal(document.querySelector('.assistant-transcript')?.contains(document.querySelector('.assistant-approval')), true,
        'approval content scrolls with the conversation instead of pushing the composer away')
    })
})

test('extension submission preserves IME composition and Shift+Enter before sending on Enter', async () => {
  const sent: unknown[] = []
  await withWorkspace({ listAssistantSessions: async () => [session('app', 0)], getAssistantSessionEvents: async () => [],
    sendAssistantMessage: async (input: unknown) => { sent.push(input) } }, async ({ document, window, render }) => {
    await render(createElement(AssistantConversation, { activeDocumentId: null, aiEnabled: true, hasApiKey: true,
      isZh: true, initialDraft: '中文扩展需求' }))
    const prompt = document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')!
    assert.equal(prompt.getAttribute('aria-label'), '扩展需求')
    await act(async () => {
      prompt.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }))
      prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.equal(sent.length, 0)
    assert.equal(prompt.value, '中文扩展需求')
    await act(async () => {
      prompt.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true }))
      prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))
      prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))
    })
    assert.equal(sent.length, 0)
    await act(async () => prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    assert.deepEqual(sent, [{ sessionId: 'app', text: '中文扩展需求', mode: 'auto' }])
    assert.equal(prompt.value, '')
  })
})

test('opening a restored hidden conversation reveals its approval and preserves an unpinned reading position', async () => {
  const approval = { id: 'approval-event', sessionId: 'app', workspaceId: 'workspace', seq: 21,
    createdAt: '2026-10-01T01:00:00Z', surface: 'conversation', type: 'approval.requested',
    payload: { turnId: 'turn', toolCallId: 'call', approvalId: 'approval', pluginId: 'sample', revisionId: 'revision',
      scope: { kind: 'session', workspaceId: 'workspace', sessionId: 'app' }, permissions: [],
      summary: 'Review the restored extension', risk: 'low', expiresAt: '2099-01-01T00:00:00Z' } }
  const history = Array.from({ length: 20 }, (_, index) => ({ ...message('app', 'History ' + index),
    id: 'message-' + index, seq: index + 1, payload: { turnId: 'turn', stepId: 'step-' + index, text: 'History ' + index } }))
  let events = [...history, approval]
  let notify!: (change: { sessionId: string; lastSeq: number }) => void
  await withWorkspace({ listAssistantSessions: async () => [session('app', events.at(-1)!.seq)],
    getAssistantSessionEvents: async (_id: string, afterSeq: number, limit: number) => events.filter(event => event.seq > afterSeq).slice(0, limit),
    onAssistantSessionChanged: (listener: typeof notify) => { notify = listener; return () => {} } },
  async ({ document, window, render }) => {
    let storedScrollTop = 0
    // Model a long transcript whose geometry disappears under a hidden panel.
    // Setting scrollTop while hidden clamps to zero, just as a non-laid-out box.
    Object.defineProperties(window.HTMLElement.prototype, {
      clientHeight: { configurable: true, get(this: HTMLElement) {
        return this.classList.contains('assistant-transcript') && !this.closest('[hidden]') ? 400 : 0
      } },
      scrollHeight: { configurable: true, get(this: HTMLElement) {
        return this.classList.contains('assistant-transcript') && !this.closest('[hidden]')
          ? this.querySelectorAll('.assistant-message').length * 300 + 200 : 0
      } },
      scrollTop: { configurable: true, get(this: HTMLElement) { return this.closest('[hidden]') ? 0 : storedScrollTop },
        set(this: HTMLElement, value: number) { storedScrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)) } }
    })
    await render(createElement(AiTaskSwitcher, { isZh: false, documentContent: createElement('p', null, 'Document task'),
      extensionContent: (isVisible: boolean) => createElement(AssistantConversation,
        { activeDocumentId: null, aiEnabled: true, hasApiKey: true, isZh: false, isVisible }) }))
    const transcript = document.querySelector<HTMLElement>('.assistant-transcript')!
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    assert.equal(transcript.querySelectorAll('.assistant-message').length, 20)
    assert.equal(transcript.querySelectorAll('.assistant-approval button').length, 2)
    assert.equal(transcript.scrollHeight, 0)
    assert.equal(storedScrollTop, 0)
    await act(async () => tabs[1].click())
    assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight,
      'the first visible layout must expose the pending approval at the end of a restored long conversation')
    await act(async () => {
      transcript.scrollTop = 220
      transcript.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      tabs[0].click()
    })
    await act(async () => {
      transcript.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      events = [...events, { ...message('app', 'New content while hidden'), id: 'new-message', seq: 22 }]
      notify({ sessionId: 'app', lastSeq: 22 })
    })
    await act(async () => tabs[1].click())
    assert.equal(transcript.querySelectorAll('.assistant-message').length, 21)
    assert.equal(transcript.scrollTop, 220, 'switching tasks must preserve the user\'s history-reading position')
    await act(async () => {
      transcript.scrollTop = transcript.scrollHeight
      transcript.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      tabs[0].click()
    })
    await act(async () => {
      events = [...events, { ...message('app', 'Another hidden update'), id: 'last-message', seq: 23,
        payload: { turnId: 'turn', stepId: 'last-step', text: 'Another hidden update' } }]
      notify({ sessionId: 'app', lastSeq: 23 })
    })
    await act(async () => tabs[1].click())
    assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight,
      'users who returned to the bottom still follow new conversation content')
  })
})

for (const outcome of ['success', 'failure'] as const) {
  test('late assistant session ' + outcome + ' cannot replace another session transcript', async () => {
    const requests: Array<{ id: string; resolve: (events: unknown[]) => void; reject: (error: Error) => void }> = []
    await withWorkspace({ listAssistantSessions: async () => [session('a'), session('b')],
      getAssistantSessionEvents: (id: string) => new Promise((resolve, reject) => { requests.push({ id, resolve, reject }) }) },
    async ({ document, window, render }) => {
      await render(createElement(AssistantConversation, { activeDocumentId: null, aiEnabled: true, hasApiKey: true, isZh: true }))
      assert.equal(requests[0].id, 'a')
      const select = document.querySelector<HTMLSelectElement>('select')!
      await act(async () => { select.value = 'b'; select.dispatchEvent(new window.Event('change', { bubbles: true })) })
      assert.equal(requests[1].id, 'b')
      await act(async () => requests[1].resolve([message('b', '当前会话 B')]))
      await act(async () => { if (outcome === 'success') requests[0].resolve([message('a', '过期会话 A')]); else requests[0].reject(new Error('过期会话错误')) })
      assert.equal(document.querySelector('.assistant-message')?.textContent?.includes('当前会话 B'), true)
      assert.equal(document.querySelector('.assistant-transcript')?.textContent?.includes('过期会话 A'), false)
      assert.equal(document.querySelector('.ai-context-error'), null)
    })
  })
}

test('a delayed initial session list cannot replace a newly created session', async () => {
  let resolveList!: (sessions: unknown[]) => void
  await withWorkspace({ listAssistantSessions: () => new Promise(resolve => { resolveList = resolve }),
    createAssistantSession: async () => session('new'), getAssistantSessionEvents: async (id: string) => [message(id, '新会话内容')] },
  async ({ document, render }) => {
    await render(createElement(AssistantConversation, { activeDocumentId: null, aiEnabled: true, hasApiKey: true, isZh: true }))
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '新对话')!.click() })
    assert.equal(document.querySelector<HTMLSelectElement>('select')!.value, 'new')
    assert.equal(document.querySelector<HTMLSelectElement>('select')!.disabled, false)
    await act(async () => resolveList([session('old')]))
    assert.equal(document.querySelector<HTMLSelectElement>('select')!.value, 'new')
    assert.equal(document.querySelector('.assistant-message')?.textContent?.includes('新会话内容'), true)
  })
})

for (const action of ['message', 'approval'] as const) {
  test('a late ' + action + ' failure cannot enter another session or restore its draft', async () => {
    let rejectAction!: (error: Error) => void
    const pending = () => new Promise((_resolve, reject) => { rejectAction = reject })
    const approval = { id: 'approval-event', sessionId: 'a', workspaceId: 'workspace', seq: 2, createdAt: '2026-10-01T01:00:00Z', surface: 'conversation',
      type: 'approval.requested', payload: { turnId: 'turn', toolCallId: 'call', approvalId: 'approval', pluginId: 'sample', revisionId: 'revision',
        scope: { kind: 'session', workspaceId: 'workspace', sessionId: 'a' }, permissions: [], summary: '确认扩展', risk: 'low', expiresAt: '2099-01-01T00:00:00Z' } }
    await withWorkspace({ listAssistantSessions: async () => [session('a', 2), session('b')],
      getAssistantSessionEvents: async (id: string) => id === 'a' ? [message(id, '会话 A'), approval] : [message(id, '会话 B')],
      sendAssistantMessage: pending, resolveAssistantApproval: pending }, async ({ document, window, render }) => {
      await render(createElement(AssistantConversation, { activeDocumentId: null, aiEnabled: true, hasApiKey: true, isZh: true, initialDraft: 'A 的未发送问题' }))
      await act(async () => {
        const selector = action === 'message' ? '.assistant-composer button' : '.assistant-approval .secondary-button'
        document.querySelector<HTMLButtonElement>(selector)!.click()
      })
      assert.equal(typeof rejectAction, 'function')
      const select = document.querySelector<HTMLSelectElement>('select')!
      await act(async () => { select.value = 'b'; select.dispatchEvent(new window.Event('change', { bubbles: true })) })
      await act(async () => rejectAction(new Error('来自过期会话的失败')))
      assert.equal(document.querySelector('.ai-context-error'), null)
      assert.equal(document.querySelector('.assistant-message')?.textContent?.includes('会话 B'), true)
      assert.equal(document.querySelector<HTMLTextAreaElement>('.assistant-composer textarea')!.value, action === 'message' ? '' : 'A 的未发送问题')
    })
  })
}

test('a completed action from another session cannot invalidate the current transcript request', async () => {
  let resolveAction!: (value: unknown) => void
  let resolveCurrentEvents!: (events: unknown[]) => void
  await withWorkspace({ listAssistantSessions: async () => [session('a'), session('b')],
    getAssistantSessionEvents: (id: string) => id === 'a' ? Promise.resolve([message(id, '会话 A')])
      : new Promise(resolve => { resolveCurrentEvents = resolve }),
    sendAssistantMessage: () => new Promise(resolve => { resolveAction = resolve }) }, async ({ document, window, render }) => {
    await render(createElement(AssistantConversation, { activeDocumentId: null, aiEnabled: true, hasApiKey: true, isZh: true, initialDraft: 'A 的问题' }))
    await act(async () => document.querySelector<HTMLButtonElement>('.assistant-composer button')!.click())
    const select = document.querySelector<HTMLSelectElement>('select')!
    await act(async () => { select.value = 'b'; select.dispatchEvent(new window.Event('change', { bubbles: true })) })
    await act(async () => resolveAction({ status: 'completed' }))
    await act(async () => resolveCurrentEvents([message('b', '当前会话 B 的新内容')]))
    assert.equal(document.querySelector('.assistant-message')?.textContent?.includes('当前会话 B 的新内容'), true)
  })
})
