import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import type { ImagePresentation } from '../src/shared/markdownMedia'
import type { MarkdownImageOccurrence } from '../src/shared/markdownMediaOccurrences'
import { serializeImageFigure } from '../src/shared/markdownMedia'
import { collectMarkdownImageOccurrences } from '../src/shared/markdownMediaOccurrences'
import { parseMarkdownDocumentBlocks } from '../src/shared/markdownDocument'

// Keep the real media component and controls. This wrapper only observes the
// contexts at its actual mount, so an independent createRoot fails this check.
const documentContext = new URL('../src/renderer/src/components/MarkdownDocumentContext.tsx', import.meta.url).href
const navigationContext = new URL('../src/renderer/src/components/MarkdownNavigationContext.ts', import.meta.url).href
const referencesContext = new URL('../src/renderer/src/components/MarkdownContent.tsx', import.meta.url).href
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    if (url.endsWith('/BlockImagePresentations.tsx')) return { format: 'module', shortCircuit: true, source:
      'import { createElement, useContext, useLayoutEffect } from "react";'
      + 'import { BlockImagePresentations as Actual } from ' + JSON.stringify(url + '?rich-media-original') + ';'
      + 'import { MarkdownDocumentContext, MarkdownBlockNodesContext } from ${JSON.stringify(documentContext)};'
      + 'import { MarkdownNavigationContext } from ${JSON.stringify(navigationContext)};'
      + 'import { MarkdownReferencesContext } from ${JSON.stringify(referencesContext)};'
      + 'export function BlockImagePresentations(props) {'
      + 'const document = useContext(MarkdownDocumentContext), nodes = useContext(MarkdownBlockNodesContext);'
      + 'const navigate = useContext(MarkdownNavigationContext), references = useContext(MarkdownReferencesContext);'
      + 'useLayoutEffect(() => { globalThis.__richMediaPortalObservations?.push({ ...props, document, nodes, references }); });'
      + 'return createElement("div", null, createElement("button", { "data-media-context-probe": true,'
      + '"data-footnote": document.footnoteId(7), onClick: () => navigate?.("Other.md#target") }, "Context"), createElement(Actual, props)); }'
    }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

const { DocumentRichTextEditor } = await import('../src/renderer/src/rich-text/DocumentRichTextEditor')
const { MarkdownDocumentContext } = await import('../src/renderer/src/components/MarkdownDocumentContext')
const { MarkdownNavigationContext } = await import('../src/renderer/src/components/MarkdownNavigationContext')
const { MarkdownReferencesContext } = await import('../src/renderer/src/components/MarkdownContent')

type Observation = {
  content: string
  onBegin: () => void
  onCommit: (occurrence: MarkdownImageOccurrence, next: ImagePresentation) => void
  document: { model?: ReturnType<typeof parseMarkdownDocumentBlocks> }
  nodes?: unknown[]
  references?: unknown
}
const image = (caption = 'Original caption') => serializeImageFigure({ src: 'https://example.test/image.png', alt: 'Accessible alt', caption, align: 'left' })
const noop = () => {}

async function withMedia(run: (api: {
  dom: JSDOM; current: () => DocumentBlockDraft[]; changes: () => number; checkpoints: () => number
  observations: Observation[]; navigated: string[]; render: (documentId?: string) => Promise<void>
  replace: (blocks: DocumentBlockDraft[]) => Promise<void>; unmount: () => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><input id="outside"><div id="mount"></div>', { pretendToBeVisual: true, url: 'https://fixture.local' })
  const originals = new Map<string, PropertyDescriptor | undefined>(), observations: Observation[] = [], navigated: string[] = []
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
    __richMediaPortalObservations: observations })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const rectangle = { top: 0, bottom: 20, left: 0, right: 100, x: 0, y: 0, width: 100, height: 20, toJSON: () => ({}) }
  dom.window.Range.prototype.getBoundingClientRect = () => rectangle
  dom.window.Range.prototype.getClientRects = () => [rectangle] as unknown as DOMRectList
  dom.window.scrollBy = noop
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  let current: DocumentBlockDraft[] = [{ id: 'media', type: 'paragraph', content: image(), checked: false, depth: 0, parentBlockId: null, tags: ['keep'] }]
  let changeCount = 0, checkpointCount = 0, removed = false
  let setBlocks!: (blocks: DocumentBlockDraft[]) => void
  function Harness({ documentId }: { documentId: string }) {
    const [blocks, update] = useState(current)
    setBlocks = update; current = blocks
    const model = parseMarkdownDocumentBlocks(blocks), references = model.environment.references
    return createElement(MarkdownNavigationContext.Provider, { value: href => navigated.push(href) },
      createElement(MarkdownReferencesContext.Provider, { value: references },
        createElement(MarkdownDocumentContext.Provider, { value: { model, isZh: false, footnoteId: id => `own-${documentId}-${id}`, navigateFootnote: noop } },
          createElement(DocumentRichTextEditor, { documentId, blocks, visibleIndices: blocks.map((_block, index) => index), references, isZh: false,
            checkpoint: () => { checkpointCount++ }, onChange: next => { changeCount++; current = next; update(next) },
            onUndo: noop, onRedo: noop, onEditSource: noop, onRevealBlock: noop }))))
  }
  const unmount = async () => { if (!removed) { await act(async () => root.unmount()); removed = true } }
  try {
    await run({ dom, current: () => current, changes: () => changeCount, checkpoints: () => checkpointCount, observations, navigated,
      render: async (documentId = 'media-owner') => { await act(async () => root.render(createElement(Harness, { documentId }))) },
      replace: async blocks => { await act(async () => setBlocks(blocks)) }, unmount })
  } finally {
    await unmount(); dom.window.close()
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
}

async function ready(dom: JSDOM) {
  await act(async () => {
    await import('../src/renderer/src/components/BlockImagePresentations')
    await import('../src/renderer/src/components/ImagePresentationEditor')
    await new Promise<void>(resolve => setImmediate(resolve))
  })
  assert.ok(dom.window.document.querySelector('.rich-text-source-media .image-presentation-frame'), dom.window.document.body.innerHTML)
}

test('rich media portal inherits document and navigation contexts while the real image controls keep stable block content and focus', async () => {
  await withMedia(async api => {
    await api.render(); await ready(api.dom)
    const document = api.dom.window.document, editor = document.querySelector('.knowbook-rich-text-editor')!
    assert.equal(document.querySelectorAll('.knowbook-rich-text-editor').length, 1)
    const probe = document.querySelector<HTMLButtonElement>('[data-media-context-probe]')!
    assert.equal(probe.dataset.footnote, 'own-media-owner-7')
    const observation = api.observations.at(-1)!
    assert.equal(observation.document.model?.blockIds[0], 'media')
    assert.ok(observation.nodes?.length)
    assert.equal(observation.references, observation.document.model?.environment.references)
    await act(async () => probe.click())
    assert.deepEqual(api.navigated, ['Other.md#target'])
    await act(async () => document.querySelector<HTMLElement>('.image-presentation-frame')!.click())
    const button = document.querySelector<HTMLButtonElement>('[data-image-align-button="right"]')!
    await act(async () => button.focus())
    await act(async () => button.click())
    assert.equal(api.changes(), 1)
    assert.ok(api.checkpoints() >= 1)
    assert.equal(collectMarkdownImageOccurrences(api.current()[0].content)[0].presentation.align, 'right')
    assert.equal(api.current()[0].id, 'media'); assert.deepEqual(api.current()[0].tags, ['keep'])
    assert.equal(document.activeElement, button, 'a media commit does not steal native focus into the outer PM editor')
    assert.equal(editor.querySelectorAll('[data-block-id="media"]').length, 1)
  })
})

test('rich media callbacks cannot mutate changed content, a recreated owner or a destroyed node view', async () => {
  await withMedia(async api => {
    await api.render(); await ready(api.dom)
    const stale = api.observations.at(-1)!, occurrence = collectMarkdownImageOccurrences(stale.content)[0]
    const next = { ...occurrence.presentation, caption: 'Late caption' }
    const outside = api.dom.window.document.getElementById('outside') as HTMLInputElement
    await act(async () => outside.focus())
    await api.replace([{ ...api.current()[0], content: image('External replacement') }])
    const changes = api.changes(), checkpoints = api.checkpoints()
    await act(async () => { stale.onBegin(); stale.onCommit(occurrence, next) })
    assert.equal(api.changes(), changes); assert.equal(api.checkpoints(), checkpoints)
    assert.equal(collectMarkdownImageOccurrences(api.current()[0].content)[0].presentation.caption, 'External replacement')
    assert.equal(api.dom.window.document.activeElement, outside)
    const previousOwner = api.observations.at(-1)!
    await api.render('other-owner'); await ready(api.dom)
    await act(async () => previousOwner.onCommit(collectMarkdownImageOccurrences(previousOwner.content)[0], next))
    assert.equal(api.changes(), changes)
    const removed = api.observations.at(-1)!
    await api.replace([])
    await act(async () => removed.onCommit(collectMarkdownImageOccurrences(removed.content)[0], next))
    assert.equal(api.changes(), changes)
    assert.equal(api.dom.window.document.querySelector('[data-block-image-presentations]'), null)
    await api.unmount()
    await act(async () => removed.onBegin())
    assert.equal(api.checkpoints(), checkpoints)
  })
})
