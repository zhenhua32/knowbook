import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useRef } from 'react'
import { JSDOM } from 'jsdom'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { BlockFormatToolbar, blockFormatToolbarTop } = await import('../src/renderer/src/components/BlockFormatToolbar')
const { MarkdownFormatToolbar } = await import('../src/renderer/src/components/MarkdownFormatToolbar')

test('block toolbar uses the outside edge of its textarea and keeps a wrapped toolbar inside the viewport', () => {
  assert.equal(blockFormatToolbarTop({ top: 200, bottom: 230 }, 32, { top: 20, bottom: 500 }), 162)
  assert.equal(blockFormatToolbarTop({ top: 20, bottom: 50 }, 32, { top: 20, bottom: 500 }), 56)
  assert.equal(blockFormatToolbarTop({ top: 462, bottom: 492 }, 64, { top: 20, bottom: 500 }), 392)
  assert.equal(blockFormatToolbarTop({ top: -20, bottom: 600 }, 64, { top: 20, bottom: 500 }, { top: 40, bottom: 64 }), 430)
  assert.equal(blockFormatToolbarTop({ top: -20, bottom: 600 }, 64, { top: 20, bottom: 500 }, { top: 450, bottom: 474 }), 26)
})

type Box = { top: number; left: number; width: number; height: number }
const rectangle = ({ top, left, width, height }: Box): DOMRect => ({ top, left, width, height,
  right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({ top, left, width, height }) })

test('floating block toolbar stays in its input column, follows scroll/resize, and preserves native formatting controls', async () => {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const originalRectangle = dom.window.HTMLElement.prototype.getBoundingClientRect
  let anchor: Box = { top: 200, left: 100, width: 240, height: 30 }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('preview-panel')) return rectangle({ top: 20, left: 80, width: 300, height: 480 })
    if (this.classList.contains('markdown-format-toolbar')) return rectangle({ top: 0, left: 0, width: 200,
      height: Number.parseFloat(this.style.maxWidth) < 200 ? 64 : 32 })
    return rectangle(anchor)
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let formatted: string | null = null
  function Harness() {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null)
    return createElement('div', { className: 'preview-panel' },
      createElement('div', { className: 'block-editor-input-column' },
        createElement('textarea', { ref: textareaRef, defaultValue: 'Draft 中文 😀 text' }),
        createElement(BlockFormatToolbar, { textareaRef, isZh: false, onFormat: format => { formatted = format },
          onReturnToEditor: () => textareaRef.current?.focus() })),
      createElement('div', { className: 'markdown-table-tools' }, createElement(MarkdownFormatToolbar,
        { isZh: false, onFormat: () => {}, onReturnToEditor: () => {} })))
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    const document = dom.window.document
    const column = document.querySelector('.block-editor-input-column')!
    const toolbar = column.querySelector<HTMLElement>(':scope > .markdown-format-toolbar')!
    const textarea = column.querySelector('textarea')!
    assert.equal(toolbar.parentElement, column)
    assert.equal(toolbar.style.visibility, 'visible')
    assert.equal(toolbar.style.top, '-38px')
    assert.equal(toolbar.style.left, '0px')
    assert.equal(toolbar.style.maxWidth, '240px')
    assert.equal(document.querySelector<HTMLElement>('.markdown-table-tools .markdown-format-toolbar')!.style.top, '')

    anchor = { ...anchor, top: 20 }
    await act(async () => document.querySelector('.preview-panel')!.dispatchEvent(new dom.window.Event('scroll')))
    assert.equal(toolbar.style.top, '36px', 'the upper edge places the toolbar below the text')
    anchor = { ...anchor, top: 462, width: 110 }
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('resize')))
    assert.equal(toolbar.style.maxWidth, '110px')
    assert.equal(toolbar.style.top, '-70px', 'wrapping still leaves the bottom text clear')

    const buttons = toolbar.querySelectorAll('button')
    textarea.focus(); textarea.setSelectionRange(6, 11)
    const mousedown = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => buttons[0].dispatchEvent(mousedown))
    assert.equal(mousedown.defaultPrevented, true)
    assert.deepEqual([textarea.selectionStart, textarea.selectionEnd], [6, 11])
    await act(async () => buttons[0].click())
    assert.equal(formatted, 'bold')
    buttons[0].focus()
    await act(async () => buttons[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
    assert.equal(document.activeElement, buttons[1])
    await act(async () => buttons[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    assert.equal(document.activeElement, textarea)
    assert.deepEqual([textarea.selectionStart, textarea.selectionEnd], [6, 11])

    anchor = { ...anchor, top: -200 }
    await act(async () => document.dispatchEvent(new dom.window.Event('scroll')))
    assert.equal(toolbar.style.visibility, 'hidden', 'offscreen blocks do not leave a detached toolbar')
    const top = toolbar.style.top
    await act(async () => root.unmount())
    anchor = { ...anchor, top: 200 }
    document.dispatchEvent(new dom.window.Event('scroll'))
    assert.equal(toolbar.style.top, top, 'scroll listeners are removed on unmount')
  } finally {
    await act(async () => root.unmount())
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRectangle
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
