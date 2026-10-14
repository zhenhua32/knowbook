import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { markdownEngine } from '../src/shared/markdownEngine'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
}`)}`, import.meta.url)
const block = (id: string, type: string, content: string, depth = 0, parentBlockId: string | null = null): DocumentBlockDraft =>
  ({ id, type, content, depth, parentBlockId, checked: false, tags: ['source-private'], highlight: 'yellow' })
const forest = () => [
  { ...block('source-owner', 'callout', '**Notice**'), markdownFormat: { calloutKind: 'warning' as const, calloutIcon: 'pin' as const, calloutTone: 'red' as const } },
  block('source-body', 'paragraph', 'Mixed **body**', 1, 'source-owner'),
  { ...block('source-toggle', 'toggle', 'Details', 1, 'source-owner'), markdownFormat: { toggleDefaultOpen: true } },
  block('source-leaf', 'paragraph', 'Child 中文😀', 2, 'source-toggle')
]
const noop = () => {}
async function roundTrip(source: DocumentBlockDraft[], command: 'copy' | 'cut', verify: (clipboard: Map<string, string>, pasted: DocumentBlockDraft[]) => void) {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true, url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { value: () => true })
  const rectangle = { top: 0, bottom: 20, left: 0, right: 100, x: 0, y: 0, width: 100, height: 20, toJSON: () => ({}) }
  dom.window.Range.prototype.getBoundingClientRect = () => rectangle
  dom.window.Range.prototype.getClientRects = () => [rectangle] as unknown as DOMRectList
  dom.window.scrollBy = noop
  const { DocumentRichTextEditor } = await import('../src/renderer/src/rich-text/DocumentRichTextEditor')
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  let current = source, replace!: (blocks: DocumentBlockDraft[], documentId: string) => void
  function Harness() {
    const [blocks, setBlocks] = useState(source), [documentId, setDocumentId] = useState('source')
    replace = (next, id) => { current = next; setBlocks(next); setDocumentId(id) }
    return createElement(DocumentRichTextEditor, { blocks, documentId, visibleIndices: blocks.map((_block, index) => index), isZh: false,
      checkpoint: noop, onChange: next => { current = next; setBlocks(next) }, onUndo: noop, onRedo: noop, onRevealBlock: noop, onEditSource: noop })
  }
  const selectAll = async () => {
    await act(async () => {
      const editor = dom.window.document.querySelector<HTMLElement>('.knowbook-rich-text-editor')!
      editor.focus()
      const range = dom.window.document.createRange(); range.selectNodeContents(editor)
      const selection = dom.window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'))
      await new Promise<void>(resolve => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(() => resolve())))
    })
  }
  const clipboardEvent = (kind: 'copy' | 'cut' | 'paste', values: Map<string, string>) => {
    const event = new dom.window.Event(kind, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: (type: string) => values.get(type) ?? '',
      setData: (type: string, value: string) => values.set(type, value) } })
    dom.window.document.querySelector('.knowbook-rich-text-editor')!.dispatchEvent(event)
    return event
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await selectAll()
    const clipboard = new Map<string, string>()
    await act(async () => assert.equal(clipboardEvent(command, clipboard).defaultPrevented, true))
    assert.ok(clipboard.get('text/plain'))
    const withoutCustomMime = new Map([...clipboard].filter(([type]) => type === 'text/plain' || type === 'text/html'))
    assert.equal(withoutCustomMime.has('application/x-knowbook-markdown'), false)
    await act(async () => replace([{ id: 'destination', type: 'paragraph', content: 'Replace', checked: false, depth: 0 }], 'destination'))
    await selectAll()
    await act(async () => assert.equal(clipboardEvent('paste', withoutCustomMime).defaultPrevented, true))
    verify(clipboard, current)
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
}

for (const command of ['copy', 'cut'] as const) test(`actual rich ${command} emits a native fallback sentinel and HTML/plain-only paste preserves fresh mixed forests`, async () => {
  const source = forest()
  await roundTrip(source, command, (clipboard, pasted) => {
    assert.ok(clipboard.get('text/html')!.startsWith('<div data-knowbook-markdown-source="true">'))
    assert.equal(clipboard.get('application/x-knowbook-markdown'), clipboard.get('text/plain'))
    assert.deepEqual(pasted.map(({ type, content, depth, markdownFormat }) => ({ type, content, depth, markdownFormat })),
      source.map(({ type, content, depth, markdownFormat }) => ({ type, content, depth, markdownFormat })))
    assert.equal(pasted[1].parentBlockId, pasted[0].id)
    assert.equal(pasted[2].parentBlockId, pasted[0].id)
    assert.equal(pasted[3].parentBlockId, pasted[2].id)
    assert.equal(new Set(pasted.map(value => value.id)).size, source.length)
    for (const value of pasted) {
      assert.equal(source.some(original => original.id === value.id), false)
      assert.ok(!value.tags?.length)
      assert.equal(value.highlight, undefined)
    }
  })
})

test('actual rich layout table copy retains the bound directive through HTML/plain-only paste', async () => {
  const content = '<!-- knowbook:table-widths:v1 [160,null] -->\n| A | B |\n| --- | --- |\n| x | y |'
  await roundTrip([block('source-table', 'table', content)], 'copy', (clipboard, pasted) => {
    assert.ok(clipboard.get('text/html')!.startsWith('<div data-knowbook-markdown-source="true">'))
    assert.equal(pasted.length, 1)
    assert.equal(pasted[0].type, 'table')
    assert.equal(pasted[0].content, content)
    assert.notEqual(pasted[0].id, 'source-table')
    assert.ok(!pasted[0].tags?.length)
  })
})

test('actual rich ordinary HTML and fenced native/layout examples retain the existing external HTML path', async () => {
  await roundTrip([block('ordinary', 'paragraph', '**Ordinary**')], 'copy', (clipboard, pasted) => {
    assert.equal(clipboard.get('text/html'), markdownEngine.render(clipboard.get('text/plain')!))
    assert.equal(pasted[0].type, 'paragraph')
    assert.equal(pasted[0].content, '**Ordinary**')
  })
  const content = '<details data-knowbook-container="toggle-v1">\n<summary>Literal</summary>\n</details>\n<aside data-native-container="callout">Literal</aside>\n<!-- knowbook:table-widths:v1 [160] -->\n| A |\n| - |\n| B |'
  await roundTrip([{ ...block('literal', 'code', content), language: 'html' }], 'copy', (clipboard, pasted) => {
    assert.equal(clipboard.get('text/html'), markdownEngine.render(clipboard.get('text/plain')!))
    assert.equal(pasted.length, 1)
    assert.equal(pasted[0].type, 'code')
    assert.equal(pasted[0].content.trimEnd(), content)
    assert.equal(pasted[0].language, 'html')
  })
})
