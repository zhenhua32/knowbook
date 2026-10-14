import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { getRichTextHistoryBridge } from '../src/renderer/src/rich-text/history'
import { setRichTextDomSelection } from '../e2e-tests/helpers/rich-text-selection'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { DocumentRichTextEditor } = await import('../src/renderer/src/rich-text/DocumentRichTextEditor')

test('actual rich controls retain backward selection, separate colors, IME protection and stable block menu identities', async () => {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const rectangle = { top: 0, bottom: 20, left: 0, right: 100, x: 0, y: 0, width: 100, height: 20, toJSON: () => ({}) }
  dom.window.Range.prototype.getBoundingClientRect = () => rectangle
  dom.window.Range.prototype.getClientRects = () => [rectangle] as unknown as DOMRectList
  dom.window.scrollBy = () => {}
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const initial: DocumentBlockDraft[] = [{ id: 'first', type: 'paragraph', content: '**abcdef**', checked: false, depth: 0, parentBlockId: null },
    { id: 'second', type: 'paragraph', content: 'uvwxyz', checked: false, depth: 0, parentBlockId: null },
    { id: 'code', type: 'code', content: 'const x = 1', checked: false, depth: 0, parentBlockId: null }]
  let current = initial, checkpoints = 0
  const menus: Array<{ blockIds: string[]; x: number; y: number }> = []
  function Harness() {
    const [blocks, setBlocks] = useState(initial)
    return createElement(DocumentRichTextEditor, { documentId: 'one', blocks, visibleIndices: [0, 1, 2], isZh: false,
      checkpoint: () => { checkpoints++ }, onChange: next => { current = next; setBlocks(next) }, onUndo: () => {}, onRedo: () => {},
      onEditSource: () => {}, onRevealBlock: () => {}, onOpenBlockActions: request => menus.push(request) })
  }
  const click = async (label: string) => {
    const button = dom.window.document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    assert.ok(button, label)
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })); button.click() })
  }
  try {
    await act(async () => { root.render(createElement(Harness)) })
    const editor = dom.window.document.querySelector<HTMLElement>('.knowbook-rich-text-editor')!, bridge = getRichTextHistoryBridge(editor)!
    assert.ok(bridge)
    assert.equal(editor.querySelector('[data-block-id="first"]')?.textContent, 'abcdef')
    assert.equal(editor.querySelector('.rich-text-block-actions')?.textContent, '')
    await act(async () => { bridge.restore({ blockId: 'second', index: 1, start: 3, end: 2, direction: 'backward',
      richText: { anchor: { blockId: 'second', index: 1, offset: 3 }, head: { blockId: 'first', index: 0, offset: 2 } } }) })
    const before = bridge.capture()
    await click('Underline'); await click('Text color'); await click('Red'); await click('Background color'); await click('Blue')
    assert.equal(dom.window.document.activeElement, editor)
    assert.deepEqual(bridge.capture().richText, before.richText)
    assert.equal(bridge.capture().direction, 'backward')
    assert.equal(current[0].id, 'first'); assert.equal(current[1].id, 'second')
    assert.equal(editor.querySelector('[data-knowbook-text-color]')?.getAttribute('data-knowbook-text-color'), 'red')
    assert.equal(editor.querySelector('[data-knowbook-background-color]')?.getAttribute('data-knowbook-background-color'), 'blue')
    await click('Text color')
    const clear = dom.window.document.querySelector<HTMLButtonElement>('.rich-text-color-palette button')!
    await act(async () => { clear.click() })
    assert.equal(editor.querySelector('[data-knowbook-text-color]'), null)
    assert.ok(editor.querySelector('[data-knowbook-background-color="blue"]'))
    assert.ok(editor.querySelector('u strong, strong u'))
    assert.ok(checkpoints >= 8)
    const first = editor.querySelector<HTMLElement>('[data-block-id="first"]')!
    await act(async () => { first.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 25, clientY: 35 }));
      await new Promise<void>(resolve => dom.window.requestAnimationFrame(() => resolve())) })
    assert.deepEqual(menus.at(-1), { blockIds: ['first', 'second'], x: 25, y: 35 })
    assert.deepEqual(bridge.capture().richText, before.richText)
    const action = first.querySelector<HTMLButtonElement>('.rich-text-block-actions')!
    await act(async () => { action.click() })
    assert.deepEqual(menus.at(-1)?.blockIds, ['first', 'second'])
    const source = editor.querySelector<HTMLElement>('[data-block-id="code"]')!
    await act(async () => { source.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await new Promise<void>(resolve => dom.window.requestAnimationFrame(() => resolve())) })
    assert.deepEqual(menus.at(-1)?.blockIds, ['code'])
    const native = dom.window.document.createElement('input'); source.append(native)
    const nativeEvent = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }), count = menus.length
    native.dispatchEvent(nativeEvent)
    assert.equal(nativeEvent.defaultPrevented, false); assert.equal(menus.length, count)
    await act(async () => { bridge.restore({ blockId: 'first', index: 0, start: 2, end: 2, direction: 'none',
      richText: { anchor: { blockId: 'first', index: 0, offset: 2 }, head: { blockId: 'first', index: 0, offset: 2 } } }) })
    const prior = current
    await act(async () => { editor.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true })); editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'u', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true })) })
    await click('Underline')
    assert.equal(current, prior)
    await act(async () => { editor.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 40)) })
    await click('Text color')
    assert.ok(dom.window.document.querySelector('.rich-text-color-palette'))
    await act(async () => { editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    assert.equal(dom.window.document.querySelector('.rich-text-color-palette'), null)
  } finally {
    await act(async () => { root.unmount() })
    dom.window.close()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

type PendingContextApi = {
  document: Document; window: JSDOM['window']; editor: HTMLElement; first: HTMLElement; source: HTMLElement; outside: HTMLInputElement
  menus: Array<{ blockIds: string[]; x: number; y: number }>; frames: Map<number, FrameRequestCallback>; callbacks: FrameRequestCallback[]
  bridge: NonNullable<ReturnType<typeof getRichTextHistoryBridge>>
  flush: () => Promise<void>; open: (target?: HTMLElement) => void; remove: () => Promise<void>
}

async function withPendingContext(run: (api: PendingContextApi) => Promise<void>, visibleIndices = [0, 1, 2], tailType: DocumentBlockDraft['type'] = 'code') {
  const dom = new JSDOM('<input id="outside"><div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>(), frames = new Map<number, FrameRequestCallback>(), callbacks: FrameRequestCallback[] = []
  let frameId = 0, removed = false
  dom.window.requestAnimationFrame = callback => { callbacks.push(callback); frames.set(++frameId, callback); return frameId }
  dom.window.cancelAnimationFrame = id => { frames.delete(id) }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const rectangle = { top: 0, bottom: 20, left: 0, right: 100, x: 0, y: 0, width: 100, height: 20, toJSON: () => ({}) }
  dom.window.Range.prototype.getBoundingClientRect = () => rectangle
  dom.window.Range.prototype.getClientRects = () => [rectangle] as unknown as DOMRectList
  dom.window.scrollBy = () => {}
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  const blocks: DocumentBlockDraft[] = [{ id: 'first', type: 'paragraph', content: 'abcdef', checked: false, depth: 0 },
    { id: 'second', type: 'paragraph', content: 'uvwxyz', checked: false, depth: 0 },
    { id: 'source', type: tailType, content: 'const x = 1', checked: false, depth: 0 }]
  const menus: PendingContextApi['menus'] = []
  const noop = () => {}
  try {
    await act(async () => root.render(createElement(DocumentRichTextEditor, { documentId: 'pending', blocks, visibleIndices,
      isZh: false, checkpoint: noop, onChange: noop, onUndo: noop, onRedo: noop, onRevealBlock: noop, onEditSource: noop,
      onOpenBlockActions: request => menus.push(request) })))
    const document = dom.window.document, editor = document.querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    const first = editor.querySelector<HTMLElement>('[data-block-id="first"]')!, source = editor.querySelector<HTMLElement>('[data-block-id="source"]')!
    const bridge = getRichTextHistoryBridge(editor)!
    await act(async () => bridge.restore({ blockId: 'first', index: 0, start: 2, end: 2, direction: 'none',
      richText: { anchor: { blockId: 'first', index: 0, offset: 2 }, head: { blockId: 'first', index: 0, offset: 2 } } }))
    await run({ document, window: dom.window, editor, first, source, bridge, menus, frames, callbacks,
      outside: document.getElementById('outside') as HTMLInputElement,
      open: (target = first) => { target.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })) },
      flush: async () => { await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) }) },
      remove: async () => { await act(async () => root.unmount()); removed = true } })
  } finally {
    if (!removed) await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
}

for (const interruption of ['foreign-focus-return', 'window-blur', 'keyboard', 'pointer', 'composition'] as const) {
  test(`a pending rich context menu cancels on ${interruption} before claiming the native gesture`, async () => {
    await withPendingContext(async api => {
      await act(async () => {
        api.open(); assert.equal(api.frames.size, 1); assert.equal(api.menus.length, 0)
        if (interruption === 'foreign-focus-return') { api.outside.focus(); api.editor.focus() }
        else if (interruption === 'window-blur') { api.window.dispatchEvent(new api.window.Event('blur')); api.window.dispatchEvent(new api.window.Event('focus')) }
        else if (interruption === 'keyboard') api.editor.dispatchEvent(new api.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        else if (interruption === 'pointer') api.outside.dispatchEvent(new api.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
        else api.editor.dispatchEvent(new api.window.CompositionEvent('compositionstart', { bubbles: true }))
      })
      await api.flush()
      assert.equal(api.menus.length, 0); assert.equal(api.frames.size, 0)
      if (interruption === 'composition') await act(async () => api.editor.dispatchEvent(new api.window.CompositionEvent('compositionend', { bubbles: true })))
    })
  })
}

test('pending right-click restores the existing backward multi-block selection after Chromium moves its native caret', async () => {
  await withPendingContext(async api => {
    await act(async () => api.bridge.restore({ blockId: 'second', index: 1, start: 3, end: 2, direction: 'backward',
      richText: { anchor: { blockId: 'second', index: 1, offset: 3 }, head: { blockId: 'first', index: 0, offset: 2 } } }))
    const before = api.bridge.capture()
    await act(async () => {
      api.open()
      const text = [...api.first.childNodes].find(node => node.nodeType === api.window.Node.TEXT_NODE)!
      api.document.getSelection()!.collapse(text, 4)
      assert.equal(api.menus.length, 0)
    })
    await api.flush()
    assert.deepEqual(api.menus, [{ blockIds: ['first', 'second'], x: 20, y: 30 }])
    assert.deepEqual(api.bridge.capture().richText, before.richText); assert.equal(api.bridge.capture().direction, 'backward')
  })
})

test('unmount cancels the scheduled native context gesture and its late frame cannot open a menu', async () => {
  await withPendingContext(async api => {
    await act(async () => api.open())
    const callback = api.callbacks.at(-1)!
    assert.equal(api.frames.size, 1)
    await api.remove()
    assert.equal(api.frames.size, 0)
    await act(async () => callback(0))
    assert.equal(api.menus.length, 0)
  })
})

test('a selected source atom retains NodeSelection through its pending native context menu', async () => {
  await withPendingContext(async api => {
    const code = api.source.querySelector<HTMLElement>('code')!
    Object.defineProperty(api.document, 'elementFromPoint', { configurable: true, value: () => code })
    Object.defineProperty(api.document, 'caretRangeFromPoint', { configurable: true, value: () => {
      const range = api.document.createRange(); range.setStart(code.firstChild!, 0); range.collapse(true); return range
    } })
    await act(async () => {
      code.dispatchEvent(new api.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 }))
      code.dispatchEvent(new api.window.MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 }))
    })
    assert.ok(api.source.classList.contains('ProseMirror-selectednode'), 'The real ProseMirror pointer handler must select the source atom')
    const before = api.bridge.capture()
    await act(async () => api.open(api.source))
    await api.flush()
    assert.deepEqual(api.menus.at(-1)?.blockIds, ['source'])
    assert.ok(api.source.classList.contains('ProseMirror-selectednode'))
    assert.deepEqual(api.bridge.capture().richText, before.richText)
  })
})

test('a rich multi-block menu excludes hidden rows and refuses a hidden clicked block while retaining the backward text selection', async () => {
  await withPendingContext(async api => {
    await act(async () => api.bridge.restore({ blockId: 'source', index: 2, start: 3, end: 2, direction: 'backward',
      richText: { anchor: { blockId: 'source', index: 2, offset: 3 }, head: { blockId: 'first', index: 0, offset: 2 } } }))
    const before = api.bridge.capture()
    const hidden = api.editor.querySelector<HTMLElement>('[data-block-id="second"]')!
    assert.equal(hidden.getAttribute('aria-hidden'), 'true')
    assert.equal(hidden.style.display, 'none')
    assert.equal(hidden.querySelector('.rich-text-block-actions'), null)
    await act(async () => api.open())
    await api.flush()
    assert.deepEqual(api.menus.at(-1), { blockIds: ['first', 'source'], x: 20, y: 30 })
    assert.deepEqual(api.bridge.capture().richText, before.richText)
    assert.equal(api.bridge.capture().direction, 'backward')
    await act(async () => api.first.querySelector<HTMLButtonElement>('.rich-text-block-actions')!.click())
    assert.deepEqual(api.menus.at(-1)?.blockIds, ['first', 'source'])
    const count = api.menus.length
    await act(async () => api.open(hidden))
    await api.flush()
    assert.equal(api.menus.length, count, 'A hidden row must not be offered as an explicit menu target')
    assert.deepEqual(api.bridge.capture().richText, before.richText)
  }, [0, 2], 'paragraph')
})

test('editor-wide clipboard events targeting an action widget reach the body while a genuinely focused action control keeps its boundary', async () => {
  for (const target of ['first', 'source'] as const) {
    for (const kind of ['copy', 'cut', 'paste'] as const) {
      await withPendingContext(async api => {
        const button = api[target].querySelector<HTMLButtonElement>('.rich-text-block-actions')!
        const selectAll = async () => {
          const key = new api.window.KeyboardEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true, bubbles: true, cancelable: true })
          await act(async () => { api.editor.focus(); api.editor.dispatchEvent(key) })
          assert.equal(key.defaultPrevented, true, 'The actual ProseMirror Mod-a keymap must select the body')
          assert.equal(api.document.activeElement, api.editor)
        }
        const clipboard = () => {
          const data = new Map<string, string>(kind === 'paste' ? [['text/plain', 'Replacement body']] : [])
          const event = new api.window.Event(kind, { bubbles: true, cancelable: true })
          Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: (type: string) => data.get(type) ?? '',
            setData: (type: string, value: string) => data.set(type, value), clearData: () => data.clear() } })
          return { event, data }
        }
        await selectAll()
        const selection = api.bridge.capture(), original = api.editor.textContent
        assert.notDeepEqual(selection.richText?.anchor, selection.richText?.head)
        await act(async () => button.focus())
        assert.equal(api.document.activeElement, button)
        const control = clipboard()
        await act(async () => button.dispatchEvent(control.event))
        assert.equal(control.event.defaultPrevented, false, `${target} ${kind}: a focused action control must not run the body clipboard handler`)
        assert.equal(api.editor.textContent, original)
        assert.deepEqual(api.bridge.capture().richText, selection.richText)
        if (kind !== 'paste') assert.equal(control.data.size, 0)

        await selectAll()
        const body = clipboard()
        await act(async () => button.dispatchEvent(body.event))
        assert.equal(body.event.defaultPrevented, true, `${target} ${kind}: a body selection's widget-targeted clipboard event must reach the editor`)
        if (kind === 'paste') assert.equal(api.editor.textContent, 'Replacement body')
        else {
          const markdown = body.data.get('text/plain')!
          assert.ok(markdown.includes('abcdef'))
          assert.ok(markdown.includes('uvwxyz'))
          assert.ok(markdown.includes('```\nconst x = 1\n```'))
          assert.equal(body.data.get('application/x-knowbook-markdown'), markdown)
          assert.equal(markdown.includes('Edit source'), false)
          assert.equal(markdown.includes('⋮'), false)
          assert.equal(markdown.includes('data-block-id'), false)
          const html = new api.window.DOMParser().parseFromString(body.data.get('text/html')!, 'text/html')
          assert.equal(html.querySelector('pre code')?.textContent?.trimEnd(), 'const x = 1')
          if (kind === 'cut') assert.equal(api.editor.textContent, '')
          else assert.equal(api.editor.textContent, original)
        }
      })
    }
  }
})

test('atomic public DOM focus and selection retain a nonfirst caret through the pending native focus repair', async () => {
  await withPendingContext(async api => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout')!, schedule = globalThis.setTimeout
    const repairs: Array<() => void> = []
    Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (...args: Parameters<typeof setTimeout>) => {
      const [callback, delay, ...values] = args
      if (delay === 20) { repairs.push(() => callback(...values)); return 0 as unknown as ReturnType<typeof setTimeout> }
      return schedule(callback, delay, ...values)
    } })
    const nativeBlock = () => {
      const anchor = api.window.getSelection()?.anchorNode
      return (anchor?.nodeType === api.window.Node.ELEMENT_NODE ? anchor as Element : anchor?.parentElement)?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId
    }
    try {
      await act(async () => {
        api.outside.focus(); api.editor.focus()
        const target = api.editor.querySelector('[data-block-id="second"]')!.lastChild!
        const range = api.document.createRange(); range.setStart(target, 3); range.collapse(true)
        const native = api.window.getSelection()!; native.removeAllRanges(); native.addRange(range)
        assert.equal(nativeBlock(), 'second')
        assert.ok(repairs.length, 'The actual editor must have a pending native focus correction')
        repairs.splice(0).forEach(repair => repair())
        assert.equal(nativeBlock(), 'first', 'The split-task window reproduces the focus repair overwriting an unobserved caret')
        api.outside.focus()
        setRichTextDomSelection(api.editor, { from: { blockId: 'second', offset: 3 } })
        // The selectionchange queued by this single DOM task precedes its later
        // focus-repair timer. Deliver both events with a controlled scheduler.
        api.document.dispatchEvent(new api.window.Event('selectionchange'))
        repairs.splice(0).forEach(repair => repair())
      })
      assert.equal(nativeBlock(), 'second')
      assert.deepEqual(api.bridge.capture().richText, {
        anchor: { blockId: 'second', index: 1, offset: 3 }, head: { blockId: 'second', index: 1, offset: 3 }
      })
    } finally { Object.defineProperty(globalThis, 'setTimeout', original) }
  })
})
