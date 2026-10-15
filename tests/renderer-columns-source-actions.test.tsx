import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { useSlashCommandActions } from '../src/renderer/src/hooks/useSlashCommandActions'
import { useSingleBlockTreeActions } from '../src/renderer/src/hooks/useSingleBlockTreeActions'
import { normalizeDraftBlocks } from '../src/renderer/src/utils/draftTreeNormalization'

const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null, tags: ['keep'], highlight: 'blue' })
const noop = () => {}
async function withSource(initial: DocumentBlockDraft[], run: (context: {
  current: () => DocumentBlockDraft[]; history: DocumentBlockDraft[][]; invoke: () => void; replace: (blocks: DocumentBlockDraft[]) => void;
  enter: (index: number) => void; backspace: (index: number) => void;
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  const history: DocumentBlockDraft[][] = []
  let current = initial, invoke!: () => void, replace!: (blocks: DocumentBlockDraft[]) => void
  let enter!: (index: number) => void, backspace!: (index: number) => void
  function Harness() {
    const [blocks, setBlocks] = useState(initial), [active, setActive] = useState<number | null>(0)
    current = blocks; replace = setBlocks
    const actions = useSlashCommandActions({ activeBlockIndex: active, activeCursorPosition: initial[0].content.length,
      activeSlashContext: { start: initial[0].content.indexOf('/columns') }, draftBlocks: blocks,
      adjustBlockDepth: noop, buildBlockTypePatch: (type, content, checked = false, depth = 0, parentBlockId = null) => ({ type, content, checked, depth, parentBlockId }),
      clearBlockSelection: noop, duplicateDraftBlock: noop, endBlockDrag: noop, insertChildDraftBlock: noop,
      insertDraftBlockAt: noop, moveDraftBlockBySibling: () => false, pushToHistory: blocks => history.push(blocks),
      setActiveBlockIndex: setActive, setActiveCursorPosition: noop, setDraftBlocks: setBlocks, setPendingFocusBlockIndex: noop, updateDraftBlock: noop })
    invoke = () => actions.applySlashCommand({ id: 'columns', label: 'Two columns', description: '', keywords: [], kind: 'action', action: 'columns' })
    const tree = useSingleBlockTreeActions({ activeCursorPosition: 0, draftBlocks: blocks,
      buildBlockTypePatch: (type, content, checked = false, depth = 0, parentBlockId = null) => ({ type, content, checked, depth, parentBlockId }),
      clearBlockSelection: noop, endBlockDrag: noop, pushToHistory: blocks => history.push(blocks),
      setActiveBlockIndex: setActive, setActiveCursorPosition: noop, setDraftBlocks: next => setBlocks(previous => normalizeDraftBlocks(typeof next === 'function' ? next(previous) : next)),
      setPendingFocusBlockIndex: noop, splitDraftBlock: noop, updateDraftBlock: noop })
    enter = index => tree.continueBlockAt(index, 0); backspace = index => tree.downgradeBlockAt(index)
    return null
  }
  await act(async () => root.render(createElement(Harness)))
  try { await run({ current: () => current, history, invoke, replace, enter, backspace }) }
  finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
}

async function perform(invoke: () => void) {
  await act(async () => { invoke(); await import('../src/renderer/src/utils/columnOperations'); await Promise.resolve() })
}

test('real source slash creates two empty columns and retains the original linked host identity', async () => {
  const source = [paragraph('host', '/columns')]
  await withSource(source, async ({ current, history, invoke }) => {
    await perform(invoke)
    assert.deepEqual(current().map(block => block.type), ['columns', 'column', 'column'])
    assert.equal(current()[0].id, 'host'); assert.deepEqual(current()[0].tags, ['keep']); assert.equal(current()[0].highlight, 'blue')
    assert.deepEqual(current().map(block => block.content), ['', '', ''])
    assert.deepEqual(current().slice(1).map(block => block.markdownFormat?.columnWeight), [5000, 5000])
    assert.deepEqual(history, [source])
  })
})

test('real source slash wraps existing text rather than discarding its identity or metadata', async () => {
  await withSource([paragraph('host', 'Keep body\n/columns')], async ({ current, history, invoke }) => {
    await perform(invoke)
    assert.deepEqual(current().map(block => block.type), ['columns', 'column', 'paragraph', 'column'])
    const child = current().find(block => block.id === 'host')!
    assert.equal(child.content, 'Keep body\n'); assert.equal(child.depth, 2); assert.equal(child.parentBlockId, current()[1].id)
    assert.deepEqual(child.tags, ['keep']); assert.equal(history.length, 1)
  })
})

test('source navigation before the cold continuation completes prevents mutation and history changes', async () => {
  await withSource([paragraph('host', '/columns')], async ({ current, history, invoke, replace }) => {
    const foreign = [paragraph('foreign', 'New document wins')]
    const { flushSync } = await import('react-dom')
    await act(async () => {
      invoke(); flushSync(() => replace(foreign))
      await import('../src/renderer/src/utils/columnOperations'); await Promise.resolve()
    })
    assert.equal(current(), foreign); assert.equal(history.length, 0)
  })
})

for (const action of ['enter', 'backspace'] as const) test(`source ${action} converts an empty list item inside a column without escaping its ownership`, async () => {
  const source: DocumentBlockDraft[] = [
    { id: 'group', type: 'columns', content: '', checked: false, depth: 0, parentBlockId: null },
    { id: 'column', type: 'column', content: '', checked: false, depth: 1, parentBlockId: 'group', markdownFormat: { columnWeight: 10_000 } },
    { id: 'list', type: 'numbered-todo', content: '', checked: false, depth: 2, parentBlockId: 'column', listStart: 7, tags: ['list-tag'] }
  ]
  await withSource(source, async context => {
    await act(async () => context[action](2))
    assert.equal(context.history.length, 1)
    assert.deepEqual(context.current().map(block => block.id), ['group', 'column', 'list'])
    const child = context.current()[2]
    assert.equal(child.type, 'paragraph'); assert.equal(child.depth, 2); assert.equal(child.parentBlockId, 'column')
    assert.deepEqual(child.tags, ['list-tag']); assert.equal(child.listStart, undefined)
  })
})
