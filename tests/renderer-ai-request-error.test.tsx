import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { AiRequestError } from '../src/renderer/src/components/AiRequestError'

const defaults = { isZh: true, error: '服务暂时不可用', failedPrompt: '之前提交的问题', busy: false, canRetry: true, onRetry: () => {} }

test('AI request failures have a named alert, readable message and safely rendered previous question', () => {
  const failedPrompt = '<img src="https://example.com" onerror="alert(1)">\n[链接](javascript:alert(1))\n' + '长问题'.repeat(120)
  const dom = new JSDOM(renderToStaticMarkup(createElement(AiRequestError, { ...defaults, failedPrompt,
    error: "Error invoking remote method 'knowbook:ask-ai-about-document': Error: <script>alert(1)</script>\n请稍后重试" })))
  const document = dom.window.document
  const alert = document.querySelector('[role="alert"]')!
  assert.equal(document.getElementById(alert.getAttribute('aria-labelledby')!)?.textContent, 'AI 请求失败')
  assert.equal(document.querySelector('.ai-request-error-message')?.textContent, '<script>alert(1)</script>\n请稍后重试')
  assert.equal(document.querySelector('.ai-request-failed-prompt p')?.textContent, failedPrompt)
  assert.equal(document.querySelectorAll('script, img, a, iframe, [onerror]').length, 0)
  assert.equal(document.querySelector('button')?.textContent, '重试上次问题')
  assert.equal(document.querySelector<HTMLButtonElement>('button')?.disabled, false)
  dom.window.close()
})

test('retry labels and disabled states describe the request availability in both languages', () => {
  for (const props of [{ busy: true, canRetry: true, failedPrompt: 'question' },
    { busy: false, canRetry: false, failedPrompt: 'question' }, { busy: false, canRetry: true, failedPrompt: '   ' }]) {
    const dom = new JSDOM(renderToStaticMarkup(createElement(AiRequestError, { ...defaults, ...props, isZh: false })))
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>('button')!.disabled, true)
    assert.equal(dom.window.document.querySelector('button')!.textContent, props.busy ? 'Retrying…' : 'Retry last question')
    assert.equal(dom.window.document.querySelector('.ai-request-error-title')?.textContent, 'AI request failed')
    dom.window.close()
  }
  assert.equal(renderToStaticMarkup(createElement(AiRequestError, { ...defaults, error: '  ' })), '')
})

test('retry invokes its callback once and preserves the current prompt outside the error card', async () => {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let retries = 0
  try {
    await act(async () => root.render(createElement('div', {},
      createElement('textarea', { defaultValue: '正在修改的新问题' }),
      createElement(AiRequestError, { ...defaults, onRetry: () => { retries += 1 } }))))
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(retries, 1)
    assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>('textarea')!.value, '正在修改的新问题')
    await act(async () => root.render(createElement(AiRequestError, { ...defaults, busy: true, onRetry: () => { retries += 1 } })))
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(retries, 1)
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
