import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { DocumentTreeNode } from '../src/shared/contracts'
import { DocumentTree } from '../src/renderer/src/components/DocumentTree'
import { setActiveUiLanguage } from '../src/renderer/src/i18n'

type TreeProps = ComponentProps<typeof DocumentTree>
const node = (id: string, children: DocumentTreeNode[] = []): DocumentTreeNode => ({
  id, title: `Document ${id}`, path: `Document ${id}`, updatedAt: '2026-10-01T00:00:00Z', children
})
const nested = [node('parent', [node('child', [node('leaf')]), node('sibling')]), node('other')]

async function withTree(run: (context: {
  dom: JSDOM; document: Document; render: (patch?: Partial<TreeProps>) => Promise<void>
  row: (id: string) => HTMLLIElement; key: (id: string, key: string, options?: KeyboardEventInit) => Promise<KeyboardEvent>
  opened: string[]; menus: Array<[string, number, number]>; scroll: () => HTMLDivElement
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><button id="before">Before</button><div id="mount"></div><input id="editor" /></body></html>', { pretendToBeVisual: true })
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const key of keys) Object.defineProperty(globalThis, key, {
    configurable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key]
  })
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const opened: string[] = [], menus: Array<[string, number, number]> = []
  let props: TreeProps = { nodes: nested, selectedDocumentId: 'leaf', onSelect: (id) => opened.push(id),
    onOpenContextMenu: (item, x, y) => menus.push([item.id, x, y]), draggingDocumentId: null, dragOverDocumentId: null,
    onDragStart: () => undefined, onDragEnd: () => undefined, onDragOverNode: () => undefined, onDropOnNode: async () => undefined }
  const render = async (patch: Partial<TreeProps> = {}) => {
    props = { ...props, ...patch }
    await act(async () => root.render(<DocumentTree {...props} />))
  }
  const row = (id: string) => dom.window.document.querySelector<HTMLLIElement>(`[role="treeitem"][aria-label="Document ${id}"]`)!
  try {
    setActiveUiLanguage('en-US')
    await run({ dom, document: dom.window.document, render, row, opened, menus,
      scroll: () => dom.window.document.querySelector<HTMLDivElement>('.tree-virtual-scroll')!,
      key: async (id, key, options = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
        await act(async () => row(id).dispatchEvent(event)); return event as unknown as KeyboardEvent
      } })
  } finally {
    await act(async () => root.unmount()); dom.window.close(); setActiveUiLanguage('en-US')
    for (const key of keys) {
      const descriptor = previous.get(key)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('tree has one named Tab entry and arrows move focus independently of document activation', async () => {
  await withTree(async ({ render, document, row, key, opened }) => {
    await render()
    assert.equal(document.querySelector('[role="tree"]')!.getAttribute('aria-label'), 'Document tree')
    assert.equal(document.querySelectorAll('[role="treeitem"][tabindex="0"]').length, 1)
    assert.equal(row('leaf').tabIndex, 0)
    assert.ok([...document.querySelectorAll<HTMLButtonElement>('[role="tree"] button')].every((button) => button.tabIndex === -1))
    assert.equal(row('child').getAttribute('aria-level'), '2')
    assert.equal(row('child').getAttribute('aria-posinset'), '1'); assert.equal(row('child').getAttribute('aria-setsize'), '2')
    assert.equal(row('other').getAttribute('aria-posinset'), '2'); assert.equal(row('other').getAttribute('aria-setsize'), '2')
    await act(async () => row('leaf').focus())
    await key('leaf', 'ArrowUp'); assert.equal(document.activeElement, row('child'))
    await key('child', 'ArrowDown'); assert.equal(document.activeElement, row('leaf'))
    await key('leaf', 'Home'); assert.equal(document.activeElement, row('parent'))
    await key('parent', 'ArrowUp'); assert.equal(document.activeElement, row('parent'))
    await key('parent', 'End'); assert.equal(document.activeElement, row('other'))
    assert.deepEqual(opened, []); assert.equal(row('leaf').getAttribute('aria-selected'), 'true')
    await key('other', 'Enter'); await key('other', ' ')
    assert.deepEqual(opened, ['other', 'other']); assert.equal(row('leaf').getAttribute('aria-selected'), 'true')
    assert.equal((await key('other', 'Enter', { isComposing: true })).defaultPrevented, false)
    assert.equal((await key('other', 'ArrowUp', { keyCode: 229 })).defaultPrevented, false)
    assert.deepEqual(opened, ['other', 'other'])
    setActiveUiLanguage('zh-CN'); await render({ nodes: [...nested] })
    assert.equal(document.querySelector('[role="tree"]')!.getAttribute('aria-label'), '文档树')
  })
})

test('hierarchy keys preserve selection and nested collapse, and native buttons activate once', async () => {
  await withTree(async ({ render, dom, document, row, key, opened }) => {
    await render(); await act(async () => row('child').focus())
    await key('child', 'ArrowLeft')
    assert.equal(row('leaf'), null); assert.equal(row('child').getAttribute('aria-expanded'), 'false')
    await key('child', 'ArrowLeft'); assert.equal(document.activeElement, row('parent'))
    await key('parent', 'ArrowLeft'); assert.equal(row('child'), null)
    await key('parent', 'ArrowRight'); assert.equal(document.activeElement, row('parent'))
    assert.equal(row('child').getAttribute('aria-expanded'), 'false')
    await key('parent', 'ArrowRight'); assert.equal(document.activeElement, row('child'))
    await key('child', 'ArrowRight'); assert.equal(document.activeElement, row('child'))
    await key('child', 'ArrowRight'); assert.equal(document.activeElement, row('leaf'))
    await key('leaf', 'ArrowRight'); assert.equal(document.activeElement, row('leaf')); assert.deepEqual(opened, [])
    const expand = row('child').querySelector<HTMLButtonElement>('.tree-expand-toggle')!
    const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => { expand.focus(); expand.dispatchEvent(enter) })
    assert.equal(enter.defaultPrevented, false, 'The row must not intercept native expand-button activation')
    await act(async () => expand.click()); assert.equal(row('leaf'), null); assert.deepEqual(opened, [])
    await act(async () => row('other').querySelector<HTMLButtonElement>('.tree-button')!.click())
    assert.deepEqual(opened, ['other']); assert.equal(document.activeElement, row('other'))
    await key('other', 'ArrowUp'); assert.equal(document.activeElement, row('sibling'))
    assert.equal(row('child').getAttribute('aria-selected'), 'false')
  })
})

test('virtual focus jumps mount their target immediately and wheel scrolling retains only one extra row', async () => {
  await withTree(async ({ render, dom, document, row, key, scroll }) => {
    const many = Array.from({ length: 10_000 }, (_, index) => node(String(index)))
    await render({ nodes: many, selectedDocumentId: '0' })
    Object.defineProperty(scroll(), 'clientHeight', { value: 432 })
    Object.defineProperty(scroll(), 'getBoundingClientRect', { value: () => ({ height: 431.625 }) })
    await act(async () => row('0').focus())
    await key('0', 'End')
    assert.equal(document.activeElement, row('9999')); assert.ok(scroll().scrollTop > 350_000)
    assert.ok(360_000 - scroll().scrollTop <= 431.625, 'Fractional viewports must not clip the focused final row')
    assert.ok(document.querySelectorAll('[role="treeitem"]').length <= 29)
    await act(async () => { scroll().scrollTop = 0; scroll().dispatchEvent(new dom.window.Event('scroll', { bubbles: true })) })
    assert.equal(document.activeElement, row('9999')); assert.equal(scroll().scrollTop, 0)
    assert.equal(document.querySelectorAll('[role="treeitem"]').length, 29)
    // Autosave refreshes often replace the tree objects while the user is scrolling.
    await render({ nodes: many.map((item) => ({ ...item })) })
    assert.equal(document.activeElement, row('9999')); assert.equal(scroll().scrollTop, 0)
    await key('9999', 'ArrowUp'); assert.equal(document.activeElement, row('9998')); assert.ok(scroll().scrollTop > 350_000)
    await key('9998', 'Home'); assert.equal(document.activeElement, row('0')); assert.equal(scroll().scrollTop, 0)
  })
})

test('external navigation reveals its target without taking editor focus or undoing manual collapse on refresh', async () => {
  await withTree(async ({ render, document, row, key }) => {
    await render(); await act(async () => row('parent').focus()); await key('parent', 'ArrowLeft')
    assert.equal(row('leaf'), null)
    await render({ nodes: [...nested] }); assert.equal(row('child'), null)
    const editor = document.getElementById('editor')!
    await act(async () => editor.focus())
    await render({ selectedDocumentId: 'other' })
    await render({ selectedDocumentId: 'leaf' })
    assert.equal(document.activeElement, editor); assert.equal(row('leaf').tabIndex, 0)
    assert.equal(row('parent').getAttribute('aria-expanded'), 'true')
    assert.equal(row('child').getAttribute('aria-expanded'), 'true')
  })
})

test('expanding an edited far descendant keeps the parent keyboard row and scroll position', async () => {
  await withTree(async ({ render, document, row, key, scroll, opened }) => {
    await render({ nodes: [node('parent', Array.from({ length: 200 }, (_, index) => node(`child-${index}`)))], selectedDocumentId: 'child-199' })
    await act(async () => row('child-199').focus())
    await key('child-199', 'Home'); assert.equal(scroll().scrollTop, 0)
    await key('parent', 'ArrowLeft'); assert.equal(row('child-199'), null)
    await key('parent', 'ArrowRight')
    assert.equal(document.activeElement, row('parent')); assert.equal(scroll().scrollTop, 0)
    assert.deepEqual(opened, [])
  })
})

test('a newly created selected child is revealed while its menu trigger retains DOM focus', async () => {
  await withTree(async ({ render, document, row, scroll }) => {
    const children = Array.from({ length: 200 }, (_, index) => node(`child-${index}`))
    await render({ nodes: [node('parent', children)], selectedDocumentId: 'parent' })
    await act(async () => row('parent').focus())
    await render({ nodes: [node('parent', [...children, node('created')])], selectedDocumentId: 'created' })
    assert.equal(document.activeElement, row('parent'))
    assert.ok(scroll().scrollTop > 6_000); assert.equal(row('created').getAttribute('aria-selected'), 'true')
    assert.equal(row('parent').tabIndex, 0); assert.equal(row('created').tabIndex, -1)
  })
})

test('collapse, removal and movement recover focus without opening a document or losing the next Tab entry', async () => {
  await withTree(async ({ render, document, row, key, opened }) => {
    await render(); await act(async () => row('leaf').focus())
    await render({ nodes: [node('parent', [node('child'), node('sibling')]), node('other')] })
    assert.equal(document.activeElement, row('child')); assert.deepEqual(opened, [])
    await act(async () => row('parent').focus()); await key('parent', 'ArrowLeft')
    await act(async () => row('other').focus())
    await render({ nodes: [node('parent', [node('child'), node('sibling'), node('other')])] })
    assert.equal(document.activeElement, row('parent')); assert.equal(row('other'), null)
    assert.equal(document.querySelectorAll('[role="treeitem"][tabindex="0"]').length, 1)
    assert.deepEqual(opened, [])
  })
})

test('keyboard context menus use the focused row and an on-screen anchor without selecting it', async () => {
  await withTree(async ({ render, row, key, menus, opened }) => {
    await render(); await act(async () => row('other').focus())
    Object.defineProperty(row('other'), 'getBoundingClientRect', { value: () => ({ left: 20, bottom: 136, width: 200 }) })
    assert.equal((await key('other', 'F10', { shiftKey: true })).defaultPrevented, true)
    assert.equal((await key('other', 'ContextMenu')).defaultPrevented, true)
    assert.deepEqual(menus, [['other', 44, 136], ['other', 44, 136]])
    assert.deepEqual(opened, [])
  })
})
