import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, useState, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { DocumentsAuxPanel } from '../src/renderer/src/components/DocumentsAuxPanel'
import { getUiText } from '../src/renderer/src/i18n'

type AuxProps = ComponentProps<typeof DocumentsAuxPanel>

function auxProps(isZh = true): AuxProps {
  const noop = () => undefined
  return { ui: getUiText(isZh ? 'zh-CN' : 'en-US'), isZh, isOpen: true, relationContent: null,
    webClipUrlDraft: '', webClipBusy: false, onWebClipUrlChange: noop, onClipWebPage: noop,
    pluginDocumentActions: [], pluginActionBusyKey: null, onRunPluginAction: noop,
    aiPromptDraft: '查找计划中的资料', onAiPromptChange: noop, aiAutomationsRunning: false,
    aiEnabled: true, hasApiKey: true, onRunEnabledAutomations: noop, aiContextSearching: false,
    aiContextHasSearched: false, onFindRelatedNotes: noop, aiAsking: false, onAskAi: noop,
    aiContextError: '', aiContextResults: [], onOpenDocument: noop, aiAnswer: '', aiAnsweredPrompt: '', aiAnswerError: '',
    aiFailedPrompt: '', documentReady: true, onRetryAi: noop, onOpenAiSettings: noop }
}

function findButton(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)
  assert.ok(button, `expected button: ${text}`)
  return button
}

test('auxiliary AI readiness gates network actions while keeping local note search and its question usable in both languages', () => {
  for (const isZh of [true, false]) {
    const props = auxProps(isZh)
    for (const [aiEnabled, hasApiKey] of [[false, false], [false, true], [true, false]]) {
      const dom = new JSDOM(renderToStaticMarkup(<DocumentsAuxPanel {...props} aiEnabled={aiEnabled} hasApiKey={hasApiKey} />))
      try {
        const region = dom.window.document.querySelector<HTMLElement>('.document-aux-ai-section')!
        assert.equal(region.getAttribute('aria-label'), isZh ? '文档 AI 助手' : 'Document AI assistant')
        const prompt = region.querySelector<HTMLTextAreaElement>('textarea')!
        const label = region.querySelector<HTMLLabelElement>('label')!
        assert.equal(label.htmlFor, prompt.id)
        assert.equal(label.textContent, isZh ? '文档问题' : 'Document question')
        assert.equal(prompt.disabled, false, 'the question also serves local search without AI setup')
        assert.equal(findButton(region, props.ui.askAiLabel).disabled, true)
        assert.equal(findButton(region, props.ui.runEnabledAutomations).disabled, true)
        assert.equal(findButton(region, props.ui.findRelatedNotes).disabled, false)
        assert.equal(findButton(region, isZh ? '配置 AI' : 'Configure AI').disabled, false)
        assert.match(region.querySelector('[role="status"]')!.textContent!, isZh ? /本地/ : /locally/)
      } finally { dom.window.close() }
    }
  }
})

test('auxiliary answer uses safe Markdown and keeps pending and failure states out of its answer container', () => {
  const props = auxProps()
  const content = '# 回答要点\n\n**重点**\n\n- 一条建议\n\n```js\nconst plan = true\n```\n\n<img src="https://example.invalid/pixel">\n\n![远程图片](https://example.invalid/image.png)'
  for (const [aiAsking, aiAnswerError] of [[false, ''], [true, ''], [false, '服务暂时不可用']] as const) {
    const dom = new JSDOM(renderToStaticMarkup(<DocumentsAuxPanel {...props} aiAnswer={content} aiAsking={aiAsking}
      aiAnswerError={aiAnswerError} aiFailedPrompt="保留原问题" />))
    try {
      const region = dom.window.document.querySelector('.document-aux-ai-section')!
      const answer = region.querySelector('.ai-answer')
      if (!aiAsking && !aiAnswerError) {
        assert.ok(answer)
        assert.equal(answer.querySelector('h1')!.textContent, '回答要点')
        assert.equal(answer.querySelector('strong')!.textContent, '重点')
        assert.equal(answer.querySelector('li')!.textContent, '一条建议')
        assert.equal(answer.querySelector('pre code')!.textContent.trim(), 'const plan = true')
        assert.equal(answer.querySelectorAll('img, script, iframe').length, 0)
      } else {
        assert.equal(answer, null)
        assert.ok(region.querySelector(aiAsking ? '[role="status"]' : '[role="alert"]'))
      }
    } finally { dom.window.close() }
  }
})

async function withAux(run: (context: {
  document: Document; window: JSDOM['window']; render: (overrides: Partial<AuxProps>) => Promise<void>;
  calls: { ask: number; retry: number; configure: number; search: number }
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const calls = { ask: 0, retry: 0, configure: 0, search: 0 }
  function Harness({ overrides }: { overrides: Partial<AuxProps> }) {
    const [prompt, setPrompt] = useState('原始草稿问题')
    return <DocumentsAuxPanel {...auxProps()} onAskAi={() => calls.ask++} onRetryAi={() => calls.retry++}
      onOpenAiSettings={() => calls.configure++} onFindRelatedNotes={() => calls.search++} {...overrides}
      aiPromptDraft={prompt} onAiPromptChange={setPrompt} />
  }
  try {
    await run({ document: dom.window.document, window: dom.window, calls,
      render: async overrides => { await act(async () => root.render(<Harness overrides={overrides} />)) } })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('auxiliary actions respect configuration, document readiness, busy state, and IME-aware keyboard submission', async () => {
  await withAux(async ({ document, window, render, calls }) => {
    await render({ aiEnabled: false, hasApiKey: false })
    const region = document.querySelector('.document-aux-ai-section')!
    const prompt = region.querySelector<HTMLTextAreaElement>('textarea')!
    const key = async (keyInit: KeyboardEventInit) => { await act(async () => {
      prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true, ...keyInit }))
    }) }
    await act(async () => {
      findButton(region, '配置 AI').click()
      findButton(region, auxProps().ui.findRelatedNotes).click()
      findButton(region, auxProps().ui.askAiLabel).click()
    })
    await key({})
    assert.deepEqual(calls, { ask: 0, retry: 0, configure: 1, search: 1 })
    await render({})
    await act(async () => prompt.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
    await key({})
    assert.equal(calls.ask, 0)
    await act(async () => prompt.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
    await key({ keyCode: 229 })
    assert.equal(calls.ask, 0)
    await key({ ctrlKey: false, metaKey: true })
    await key({})
    assert.equal(calls.ask, 2)
    await render({ aiAsking: true })
    await key({})
    assert.equal(calls.ask, 2)
    assert.equal(findButton(region, auxProps().ui.thinking).disabled, true)
    await render({ documentReady: false })
    assert.equal(prompt.disabled, true)
    assert.equal(findButton(region, auxProps().ui.findRelatedNotes).disabled, true)
    await key({})
    assert.equal(calls.ask, 2)
  })
})

test('failure retries use their own action and retain edited question drafts while local search remains independent', async () => {
  await withAux(async ({ document, window, render, calls }) => {
    await render({})
    const region = document.querySelector('.document-aux-ai-section')!
    const prompt = region.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, '请求后修改的新问题')
      prompt.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const failure = { aiAnswerError: '请求失败，请重试', aiFailedPrompt: '真正失败的上次问题', aiContextHasSearched: true }
    await render(failure)
    assert.equal(prompt.value, '请求后修改的新问题')
    assert.match(region.querySelector('[role="alert"]')!.textContent!, /真正失败的上次问题/)
    assert.equal(region.querySelector('.ai-answer'), null)
    await act(async () => findButton(region, '重试上次问题').click())
    assert.equal(calls.retry, 1)
    assert.equal(calls.ask, 0)
    assert.equal(prompt.value, '请求后修改的新问题')
    await act(async () => findButton(region, auxProps().ui.findRelatedNotes).click())
    assert.equal(calls.search, 1)
    assert.match(region.textContent!, /没有找到相关笔记/)
    await render({ ...failure, aiAsking: true })
    assert.equal(findButton(region, '重试中…').disabled, true)
    await render({ ...failure, hasApiKey: false })
    assert.equal(findButton(region, '重试上次问题').disabled, true)
    assert.equal(findButton(region, auxProps().ui.findRelatedNotes).disabled, false)
    await render({ aiContextError: '本地检索失败', aiContextHasSearched: true, aiEnabled: false })
    const searchError = region.querySelector('.document-aux-ai-search-error')!
    assert.equal(searchError.getAttribute('role'), 'alert')
    await act(async () => findButton(searchError, '重试检索').click())
    assert.equal(calls.search, 2)
    assert.equal(region.querySelector('.ai-answer'), null)
  })
})
