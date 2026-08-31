import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'

type GlobalOverrideKey = 'window' | 'document' | 'navigator' | 'HTMLElement' | 'HTMLTextAreaElement' | 'Event' | 'Node'

test('assistant conversation reports draft edits so a closing host can restore them', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  const previousGlobals = new Map<GlobalOverrideKey, PropertyDescriptor | undefined>()
  const overrideGlobal = (key: GlobalOverrideKey, value: unknown) => {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const restoreGlobal = (key: GlobalOverrideKey) => {
    const previous = previousGlobals.get(key)
    if (previous) Object.defineProperty(globalThis, key, previous)
    else Reflect.deleteProperty(globalThis, key)
  }

  let root: import('react-dom/client').Root | null = null
  try {
    overrideGlobal('window', dom.window)
    overrideGlobal('document', dom.window.document)
    overrideGlobal('navigator', dom.window.navigator)
    overrideGlobal('HTMLElement', dom.window.HTMLElement)
    overrideGlobal('HTMLTextAreaElement', dom.window.HTMLTextAreaElement)
    overrideGlobal('Event', dom.window.Event)
    overrideGlobal('Node', dom.window.Node)
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true })
    Object.defineProperty(dom.window, 'knowbook', {
      configurable: true,
      value: {
        listAssistantSessions: async () => [],
        getAssistantSessionEvents: async () => [],
        onAssistantSessionChanged: () => () => undefined
      }
    })

    const { createRoot } = await import('react-dom/client')
    const { AssistantConversation } = await import('../src/renderer/src/components/AssistantConversation.tsx')
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    root = createRoot(container)
    let savedDraft = ''
    const renderConversation = (key: string, initialDraft: string) => createElement(AssistantConversation, {
      key,
      activeDocumentId: null,
      aiEnabled: true,
      hasApiKey: true,
      isZh: true,
      initialDraft,
      onDraftChange: (draft: string) => { savedDraft = draft }
    })

    await act(async () => {
      root?.render(renderConversation('first', '初始模板'))
    })
    const textarea = container.querySelector('textarea')
    assert.ok(textarea)
    assert.equal(textarea.value, '初始模板')

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
      valueSetter?.call(textarea, '用户尚未发送的草稿')
      textarea.dispatchEvent(new dom.window.InputEvent('input', {
        bubbles: true,
        data: '用户尚未发送的草稿',
        inputType: 'insertText'
      }))
    })
    assert.equal(savedDraft, '用户尚未发送的草稿')

    await act(async () => {
      root?.render(renderConversation('reopened', savedDraft))
    })
    assert.equal(container.querySelector('textarea')?.value, '用户尚未发送的草稿')
  } finally {
    if (root) {
      await act(async () => { root?.unmount() })
    }
    restoreGlobal('Node')
    restoreGlobal('Event')
    restoreGlobal('HTMLTextAreaElement')
    restoreGlobal('HTMLElement')
    restoreGlobal('navigator')
    restoreGlobal('document')
    restoreGlobal('window')
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    dom.window.close()
  }
})
