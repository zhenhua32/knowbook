import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { hasVisibleShortcutBlocker } from '../src/renderer/src/utils/shortcutBlocker'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
}`)}`, import.meta.url)
const { default: ColumnsControls } = await import('../src/renderer/src/components/ColumnsControls')
const fixture = (): DocumentBlockDraft[] => [
  { id: 'group', type: 'columns', content: '', checked: false, depth: 0, parentBlockId: null },
  { id: 'a', type: 'column', content: '', checked: false, depth: 1, parentBlockId: 'group', markdownFormat: { columnWeight: 4000 } },
  { id: 'text', type: 'paragraph', content: 'Preserve identity', checked: false, depth: 2, parentBlockId: 'a', tags: ['keep'] },
  { id: 'b', type: 'column', content: '', checked: false, depth: 1, parentBlockId: 'group', markdownFormat: { columnWeight: 6000 } }
]
async function withControls(run: (context: {
  dom: JSDOM; apply: DocumentBlockDraft[][]; current: () => DocumentBlockDraft[]; preview: () => number[] | null;
  separator: () => HTMLElement; change: (fn: () => void) => Promise<void>;
  pointer: (element: Element, type: string, x: number) => Promise<void>; rerender: (blocks: DocumentBlockDraft[], session?: string) => Promise<void>;
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const captures = new WeakMap<Element, number>()
  dom.window.HTMLElement.prototype.setPointerCapture = function (id) { captures.set(this, id) }
  dom.window.HTMLElement.prototype.hasPointerCapture = function (id) { return captures.get(this) === id }
  dom.window.HTMLElement.prototype.releasePointerCapture = function () { captures.delete(this) }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 1000, 80) }
  dom.window.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as unknown as DOMRectList }
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  const apply: DocumentBlockDraft[][] = []
  let current = fixture(), preview: number[] | null = null, replace!: (blocks: DocumentBlockDraft[], session?: string) => void
  function Harness() {
    const [value, setValue] = useState({ blocks: current, session: 'first' })
    current = value.blocks
    replace = (blocks, session = value.session) => setValue({ blocks, session })
    return createElement('div', { className: 'document-columns', 'data-columns-group': 'group' },
      createElement(ColumnsControls, { blocks: value.blocks, groupId: 'group', isZh: false, sessionKey: value.session,
        onApplyBlocks: next => { apply.push(next); setValue({ ...value, blocks: next }) }, onPreviewWeights: next => { preview = next } }),
      createElement('div', { className: 'document-columns-grid' }))
  }
  const change = async (fn: () => void) => { await act(async () => { fn() }) }
  await act(async () => root.render(createElement(Harness)))
  try {
    await run({ dom, apply, current: () => current, preview: () => preview,
      separator: () => dom.window.document.querySelector<HTMLElement>('[role="separator"]')!, change,
      pointer: async (element, type, x) => {
        const event = new dom.window.MouseEvent(type, { clientX: x, button: 0, bubbles: true, cancelable: true })
        Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true } })
        await change(() => element.dispatchEvent(event))
      }, rerender: (blocks, session) => change(() => replace(blocks, session)) })
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
}

test('real column ratio input writes one transaction and invalid/no-op submission writes none', async () => {
  await withControls(async ({ dom, apply, current, change }) => {
    const input = dom.window.document.querySelector<HTMLInputElement>('[aria-label="Column 1 width percent"]')!
    const fill = async (value: string) => {
      await change(() => input.focus())
      await change(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      await change(() => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    }
    await fill('35')
    assert.equal(apply.length, 1)
    assert.deepEqual(current().filter(block => block.type === 'column').map(block => block.markdownFormat?.columnWeight), [3500, 6500])
    await change(() => input.blur())
    await fill('35'); await change(() => input.blur()); await fill('100')
    assert.equal(apply.length, 1)
    assert.equal(input.value, '35')
  })
})

test('real pointer resize only previews before release and commits exactly once with conserved weights', async () => {
  await withControls(async ({ apply, current, preview, separator, pointer }) => {
    const handle = separator(), before = current()
    await pointer(handle, 'pointerdown', 400)
    await pointer(handle, 'pointermove', 480)
    assert.deepEqual(preview(), [4800, 5200]); assert.equal(apply.length, 0); assert.equal(current(), before)
    await pointer(handle, 'pointerup', 480)
    assert.equal(preview(), null); assert.equal(apply.length, 1)
    assert.deepEqual(current().filter(block => block.type === 'column').map(block => block.markdownFormat?.columnWeight), [4800, 5200])
    assert.deepEqual(current().find(block => block.id === 'text'), before.find(block => block.id === 'text'))
  })
})

for (const reason of ['Escape', 'blur', 'pointercancel', 'lostpointercapture', 'source', 'session'] as const) {
  test(`real pointer resize ${reason} cancels without any draft or history callback`, async () => {
    await withControls(async ({ dom, apply, current, preview, separator, pointer, change, rerender }) => {
      const handle = separator(), before = current()
      await pointer(handle, 'pointerdown', 400); await pointer(handle, 'pointermove', 500)
      assert.deepEqual(preview(), [5000, 5000])
      if (reason === 'Escape') await change(() => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
      else if (reason === 'blur') await change(() => dom.window.dispatchEvent(new dom.window.Event('blur')))
      else if (reason === 'source') await rerender(structuredClone(before))
      else if (reason === 'session') await rerender(before, 'second')
      else await change(() => handle.dispatchEvent(new dom.window.Event(reason)))
      await pointer(handle, 'pointerup', 500)
      assert.equal(preview(), null); assert.equal(apply.length, 0)
      assert.deepEqual(current(), before)
    })
  })
}

test('keyboard separator changes adjacent widths and last remaining column cannot be removed', async () => {
  await withControls(async ({ dom, apply, current, separator, change }) => {
    assert.equal(hasVisibleShortcutBlocker(dom.window.document), false, 'ordinary visible column controls must not disable document shortcuts')
    await change(() => separator().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
    assert.equal(apply.length, 1)
    assert.deepEqual(current().filter(block => block.type === 'column').map(block => block.markdownFormat?.columnWeight), [4100, 5900])
    const remove = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Remove column 2 and keep content"]')!
    await change(() => remove.click())
    const remaining = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Remove column 1 and keep content"]')!
    assert.equal(remaining.disabled, true)
    const count = apply.length; await change(() => remaining.click()); assert.equal(apply.length, count)
    assert.equal(current().find(block => block.type === 'column')!.markdownFormat!.columnWeight, 10_000)
  })
})

test('unmounting a live column resize releases its preview without committing', async () => {
  let commits: DocumentBlockDraft[][] = [], readPreview: () => number[] | null = () => null
  await withControls(async ({ apply, preview, separator, pointer }) => {
    commits = apply; readPreview = preview
    await pointer(separator(), 'pointerdown', 400); await pointer(separator(), 'pointermove', 520)
    assert.deepEqual(preview(), [5200, 4800])
  })
  assert.equal(commits.length, 0); assert.equal(readPreview(), null)
})
