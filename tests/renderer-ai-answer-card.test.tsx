import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { AiAnswerCard } from '../src/renderer/src/components/AiAnswerCard'

type CardProps = ComponentProps<typeof AiAnswerCard>
const defaults: CardProps = { content: '## Answer\n\n**A useful answer.**', prompt: 'The submitted question', isZh: false }

function deferredCopy(text: string) {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { text, promise, resolve, reject }
}

async function withCard(run: (context: {
  document: Document
  copies: Array<ReturnType<typeof deferredCopy>>
  render: (props?: Partial<CardProps>) => Promise<void>
  unmount: () => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const copies: Array<ReturnType<typeof deferredCopy>> = []
  Object.defineProperty(dom.window, 'knowbook', { value: { writeClipboardText: (text: string) => {
    const copy = deferredCopy(text)
    copies.push(copy)
    return copy.promise
  } } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let mounted = true
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  try {
    await run({ document: dom.window.document, copies,
      render: async props => { await act(async () => root.render(createElement(AiAnswerCard, { ...defaults, ...props }))) }, unmount })
  } finally {
    await unmount()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

const copyButton = (document: Document) => {
  const button = document.querySelector<HTMLButtonElement>('.ai-answer-copy')
  assert.ok(button, 'a native copy button must be reachable from the answer card')
  assert.equal(button.tagName, 'BUTTON')
  assert.equal(button.type, 'button')
  return button
}
const statusText = (document: Document) => document.querySelector('[role="status"]')?.textContent ?? ''
const copied = /已复制|Copied/i
const copying = /正在复制|复制中|Copying/i
const copyFailure = /复制失败|无法复制|未能复制|Could not copy|Copy failed|Unable to copy/i

test('an answer card keeps the submitted question as safe plain text and renders only the answer as Markdown', () => {
  const prompt = '<img src="https://example.invalid/question" onerror="alert(1)">\n**A question, not formatted content**\n<script>alert(1)</script>'
  const dom = new JSDOM(renderToStaticMarkup(createElement(AiAnswerCard, { ...defaults, prompt, isZh: true,
    className: 'document-aux-ai-answer', content: '# 回答\n\n**重点**\n\n<script>alert(1)</script>\n\n![远程图片](https://example.invalid/image.png)' })))
  try {
    const card = dom.window.document.querySelector('section.ai-answer.document-aux-ai-answer')!
    assert.ok(card)
    assert.equal(card.getAttribute('aria-label'), 'AI 回答')
    const question = card.querySelector('.ai-answer-question')!
    assert.ok(question)
    assert.ok(question.textContent!.includes(prompt), 'the immutable submitted question is visible verbatim')
    assert.equal(question.querySelectorAll('img, script, a, iframe, [onerror]').length, 0)
    assert.equal(card.querySelector('.ai-answer-content h1')!.textContent, '回答')
    assert.equal(card.querySelector('.ai-answer-content strong')!.textContent, '重点')
    assert.equal(card.querySelectorAll('img, script, iframe, [onerror], [href^="javascript:"]').length, 0)
    assert.equal(copyButton(dom.window.document).disabled, false)
  } finally { dom.window.close() }
})

test('copy sends the exact answer Markdown without the question and guards rapid repeated clicks', async () => {
  await withCard(async ({ document, copies, render }) => {
    const content = '## Heading\n\n**bold** and [source](https://example.com)\n\n```ts\nconst example = true\n```\n'
    await render({ content })
    const button = copyButton(document)
    button.focus()
    await act(async () => { button.click(); button.click() })
    assert.equal(copies.length, 1, 'a duplicate click before React renders must not start another copy')
    assert.equal(copies[0].text, content, 'copy preserves the original Markdown, including trailing newlines')
    assert.equal(button.disabled, true)
    assert.match(statusText(document), copying)
    await act(async () => copies[0].resolve())
    assert.equal(button.disabled, false)
    assert.match(statusText(document), copied)
    assert.equal(document.activeElement, button, 'copy completion must not move keyboard focus')
  })
})

test('copy failure is readable, excludes IPC details and allows retrying the same answer in both languages', async () => {
  for (const isZh of [true, false]) {
    await withCard(async ({ document, copies, render }) => {
      await render({ isZh })
      const button = copyButton(document)
      await act(async () => button.click())
      await act(async () => copies[0].reject(new Error("Error invoking remote method 'knowbook:write-clipboard-text': Error: sensitive-provider-detail")))
      assert.equal(button.disabled, false)
      assert.match(statusText(document), copyFailure)
      assert.equal(document.body.textContent!.includes('sensitive-provider-detail'), false)
      assert.equal(document.body.textContent!.includes('knowbook:write-clipboard-text'), false)
      await act(async () => button.click())
      assert.equal(copies.length, 2)
      assert.equal(copies[1].text, defaults.content)
      assert.match(statusText(document), copying)
      await act(async () => copies[1].resolve())
      assert.match(statusText(document), copied)
    })
  }
})

for (const changed of ['content', 'prompt'] as const) {
  for (const outcome of ['success', 'failure'] as const) {
    test(`changing the answer ${changed} ignores late copy ${outcome} without ending the new copy`, async () => {
      await withCard(async ({ document, copies, render }) => {
        await render()
        await act(async () => copyButton(document).click())
        const next = changed === 'content' ? { content: 'The next answer' } : { prompt: 'A different submitted question' }
        await render(next)
        assert.equal(copyButton(document).disabled, false)
        assert.doesNotMatch(statusText(document), copied)
        assert.doesNotMatch(statusText(document), copyFailure)
        await act(async () => copyButton(document).click())
        assert.equal(copies.length, 2)
        assert.equal(copies[1].text, next.content ?? defaults.content, 'the new action copies the currently displayed answer')
        await act(async () => {
          if (outcome === 'success') copies[0].resolve()
          else copies[0].reject(new Error('Old copy failed'))
        })
        assert.equal(copyButton(document).disabled, true, 'the old completion must not clear the new copy busy state')
        assert.match(statusText(document), copying)
        assert.doesNotMatch(statusText(document), copied)
        assert.doesNotMatch(statusText(document), copyFailure)
        await act(async () => copies[1].resolve())
        assert.equal(copyButton(document).disabled, false)
        assert.match(statusText(document), copied)
      })
    })
  }
}

test('a copy completing after its answer card unmounts cannot publish feedback into another answer', async () => {
  await withCard(async ({ document, copies, render, unmount }) => {
    await render()
    await act(async () => copyButton(document).click())
    await unmount()
    await act(async () => copies[0].resolve())
    assert.equal(document.querySelector('.ai-answer'), null)
    assert.equal(document.querySelector('[role="status"]'), null)
  })
})
