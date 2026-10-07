import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import { renderToStaticMarkup } from 'react-dom/server'
import { DocumentSummaryCard } from '../src/renderer/src/components/DocumentSummaryCard'

test('an opening article title leaves a clearly labelled, editable document name in both languages', () => {
  for (const compactTitleLabel of ['文档名称', 'Document name']) {
    const html = renderToStaticMarkup(createElement(DocumentSummaryCard, {
      path: '文章', title: '文章', summary: '', updatedText: 'Updated now', titleLabel: 'Title', summaryLabel: 'Summary',
      compactTitleLabel, editLabel: 'Properties', collapseLabel: 'Collapse properties', onTitleChange: () => {}, onSummaryChange: () => {}
    }))
    const dom = new JSDOM(html)
    const input = dom.window.document.querySelector<HTMLTextAreaElement>('.document-title-input')!
    const label = dom.window.document.querySelector<HTMLLabelElement>('.document-title-label')!
    assert.equal(label.textContent, compactTitleLabel)
    assert.equal(label.htmlFor, input.id)
    assert.equal(input.getAttribute('aria-label'), compactTitleLabel)
    assert.equal(input.value, '文章')
    assert.equal(input.disabled, false)
    assert.equal(input.readOnly, false)
    assert.equal(dom.window.document.querySelector('.document-title-field-compact')?.contains(input), true)
    dom.window.close()
  }
})

async function withMetadata(run: (context: { document: Document; window: JSDOM['window']; changes: string[] }) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const changes: string[] = []
  function Harness() {
    const [title, setTitle] = useState('文档标题')
    const [summary, setSummary] = useState('用户摘要')
    return createElement(DocumentSummaryCard, { path: '工作区/文档标题', title, summary,
      updatedText: '刚刚更新', titleLabel: '标题', summaryLabel: '摘要', editLabel: '摘要与属性', collapseLabel: '收起属性',
      onTitleChange: value => { changes.push(value); setTitle(value) }, onSummaryChange: setSummary })
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ document: dom.window.document, window: dom.window, changes })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('the document title edits immediately while optional metadata stays collapsed', async () => {
  await withMetadata(async ({ document, window, changes }) => {
    const title = document.querySelector<HTMLTextAreaElement>('.document-title-input')!
    const toggle = document.querySelector<HTMLButtonElement>('.document-summary-edit-button')!
    assert.equal(title.value, '文档标题')
    assert.equal(title.getAttribute('aria-label'), '标题')
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(document.querySelector('.editor-textarea'), null)
    assert.equal(document.querySelector('.document-updated'), null)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(title, '直接修改标题')
      title.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.deepEqual(changes, ['直接修改标题'])
    assert.equal(title.value, '直接修改标题')
    await act(async () => toggle.click())
    const summary = document.querySelector<HTMLTextAreaElement>('.editor-textarea')!
    assert.equal(document.activeElement, summary, 'properties open at the summary because the title is already accessible')
    assert.equal(summary.value, '用户摘要')
    assert.equal(document.querySelector('.document-updated')!.textContent, '刚刚更新')
    await act(async () => summary.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    assert.equal(document.activeElement, toggle)
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(document.querySelector('.editor-textarea'), null)
    assert.equal(document.querySelector('.document-title-input'), title, 'closing properties does not remount or hide the title')
    assert.equal(title.value, '直接修改标题')
  })
})

test('Escape leaves title and summary IME candidates intact before closing properties', async () => {
  await withMetadata(async ({ document, window }) => {
    const toggle = document.querySelector<HTMLButtonElement>('.document-summary-edit-button')!
    await act(async () => toggle.click())
    for (const selector of ['.document-title-input', '.editor-textarea']) {
      const input = document.querySelector<HTMLElement>(selector)!
      await act(async () => {
        input.focus()
        input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }))
      })
      const candidateEscape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      await act(async () => input.dispatchEvent(candidateEscape))
      assert.equal(candidateEscape.defaultPrevented, false)
      assert.equal(toggle.getAttribute('aria-expanded'), 'true')
      assert.equal(document.activeElement, input)
      await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
      const fallbackEscape = new window.KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true })
      await act(async () => input.dispatchEvent(fallbackEscape))
      assert.equal(fallbackEscape.defaultPrevented, false)
      assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    }
    const summary = document.querySelector<HTMLTextAreaElement>('.editor-textarea')!
    await act(async () => summary.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(document.activeElement, toggle)
  })
})

test('a wrapping title retains a single-line name and Enter respects IME composition', async () => {
  await withMetadata(async ({ document, window, changes }) => {
    const title = document.querySelector<HTMLTextAreaElement>('.document-title-input')!
    assert.equal(title.tagName, 'TEXTAREA')
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(title, '粘贴的标题\n第二行\r\n第三行')
      title.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.deepEqual(changes, ['粘贴的标题 第二行 第三行'])
    assert.equal(title.value, '粘贴的标题 第二行 第三行')

    const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => title.dispatchEvent(enter))
    assert.equal(enter.defaultPrevented, true)
    await act(async () => title.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
    const candidateEnter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => title.dispatchEvent(candidateEnter))
    assert.equal(candidateEnter.defaultPrevented, false)
    await act(async () => title.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
    const fallbackEnter = new window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })
    await act(async () => title.dispatchEvent(fallbackEnter))
    assert.equal(fallbackEnter.defaultPrevented, false)
  })
})
