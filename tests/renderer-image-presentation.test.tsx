import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import type { ImagePresentation } from '../src/shared/markdownMedia'
import type { MarkdownEnvironment } from '../src/shared/markdownEngine'
import { replaceMarkdownImageOccurrence, type MarkdownImageOccurrence } from '../src/shared/markdownMediaOccurrences'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { ImagePresentationEditor } = await import('../src/renderer/src/components/ImagePresentationEditor')
const { BlockImagePresentations } = await import('../src/renderer/src/components/BlockImagePresentations')

const initial: ImagePresentation = { src: 'file:///fixture.svg', alt: 'Independent alt text', caption: 'Visible caption', width: 200, align: 'left' }
const bounds = (width: number, height: number): DOMRect => ({ x: 0, y: 0, left: 0, top: 0,
  width, height, right: width, bottom: height, toJSON: () => ({ width, height }) })

type Api = {
  document: Document
  commits: ImagePresentation[]
  occurrences: MarkdownImageOccurrence[]
  nextContents: string[]
  beginCount: () => number
  find: <T extends Element = HTMLElement>(selector: string) => T
  click: (selector: string) => Promise<void>
  pointer: (selector: string, type: string, x: number, y: number) => Promise<void>
  escape: () => Promise<void>
}

async function withImage(context: TestContext, run: (api: Api) => Promise<void>, blockContent?: string, references?: MarkdownEnvironment['references']) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'https://fixture.local', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const commits: ImagePresentation[] = []
  const occurrences: MarkdownImageOccurrence[] = []
  const nextContents: string[] = []
  let begins = 0
  function Harness() {
    const [value, setValue] = useState(initial)
    if (blockContent !== undefined) return createElement(BlockImagePresentations, { content: blockContent, references, isZh: false,
      onBegin: () => { begins++ }, onCommit: (occurrence, next, nextContent) => { occurrences.push(occurrence); commits.push(next); nextContents.push(nextContent) } })
    return createElement(ImagePresentationEditor, { value, isZh: false, editable: true, onBegin: () => { begins++ },
      onCommit: next => { commits.push(next); setValue(next) } })
  }
  context.after(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
  await act(async () => root.render(createElement(Harness)))
  // The block wrapper loads its editor as an independent chunk. Wait for the
  // real lazy module instead of interacting with its static image fallback.
  for (let attempt = 0; attempt < 100 && !dom.window.document.querySelector('.image-presentation-image'); attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  }
  const find = <T extends Element = HTMLElement>(selector: string): T => {
    const element = dom.window.document.querySelector<T>(selector)
    assert.ok(element, selector)
    return element
  }
  const image = find<HTMLImageElement>('.image-presentation-image')
  Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 200 } })
  await act(async () => image.dispatchEvent(new dom.window.Event('load')))
  Object.defineProperty(find('[data-image-presentation]'), 'clientWidth', { value: 600 })
  const frame = find('.image-presentation-frame')
  frame.getBoundingClientRect = () => bounds(Number.parseFloat(frame.style.width), Number.parseFloat(frame.style.width) / 2)
  const click = async (selector: string) => { await act(async () => find(selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))) }
  const captured = new WeakMap<HTMLElement, number>()
  const pointer = async (selector: string, type: string, x: number, y: number) => {
    const element = find<HTMLElement>(selector)
    element.setPointerCapture = id => { captured.set(element, id) }
    element.hasPointerCapture = id => captured.get(element) === id
    element.releasePointerCapture = () => { captured.delete(element) }
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    await act(async () => element.dispatchEvent(event))
  }
  await click('.image-presentation-frame')
  await run({ document: dom.window.document, commits, occurrences, nextContents, beginCount: () => begins, find, click, pointer,
    escape: async () => { await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))) } })
}

test('read-only image presentation is SSR-safe and keeps caption separate from alt text', () => {
  const html = renderToStaticMarkup(createElement(ImagePresentationEditor, { value: initial, isZh: false, editable: false }))
  assert.match(html, /alt="Independent alt text"/)
  assert.match(html, /Visible caption/)
  assert.ok(!html.includes('data-image-controls'))
  assert.ok(!html.includes('data-image-resize'))
  assert.match(html, /image-presentation-frame block-rich-media-image-card/)
  assert.match(html, /image-presentation-image block-rich-media-image/)
  assert.equal(renderToStaticMarkup(createElement(BlockImagePresentations, { content: '`![code](file:///image.svg)`', isZh: false })), '')
})

test('resize keeps its aspect ratio and submits once on release, while Escape cancels the next drag', async context => {
  await withImage(context, async api => {
    await api.pointer('[data-image-resize]', 'pointerdown', 200, 100)
    await api.pointer('[data-image-resize]', 'pointermove', 250, 125)
    assert.equal(api.commits.length, 0)
    assert.equal(api.find('.image-presentation-frame').style.width, '250px')
    await api.pointer('[data-image-resize]', 'pointerup', 250, 125)
    assert.equal(api.commits.length, 1)
    assert.equal(api.commits[0].width, 250)
    assert.equal(api.commits[0].height, 125)
    assert.equal(api.beginCount(), 1)
    await api.pointer('[data-image-resize]', 'pointerdown', 250, 125)
    await api.pointer('[data-image-resize]', 'pointermove', 300, 150)
    await api.escape()
    assert.equal(api.commits.length, 1)
    assert.equal(api.find('.image-presentation-frame').style.width, '250px')
    assert.equal(api.find('[data-image-resize]').parentElement, api.find('.image-presentation-frame'))
    assert.equal(api.find('.image-presentation-frame').style.overflow, 'visible')
    assert.equal(api.find('[data-image-open-original]').textContent, 'Open original image')
  })
})

test('crop corner dragging uses normalized coordinates and an actual clipped translated image', async context => {
  await withImage(context, async api => {
    await api.click('[data-image-crop-toggle]')
    api.find('[data-image-crop-stage]').getBoundingClientRect = () => bounds(400, 200)
    await api.pointer('[data-image-crop-handle="nw"]', 'pointerdown', 0, 0)
    await api.pointer('[data-image-crop-handle="nw"]', 'pointermove', 20, 10)
    assert.equal(api.commits.length, 0)
    await api.pointer('[data-image-crop-handle="nw"]', 'pointerup', 20, 10)
    assert.equal(api.commits.length, 1)
    assert.deepEqual(api.commits[0].crop, { x: .05, y: .05, width: .95, height: .95 })
    const image = api.find('.image-presentation-image'), viewport = api.find('.image-presentation-viewport')
    assert.equal(viewport.style.position, 'absolute')
    assert.equal(image.parentElement, viewport)
    assert.equal(image.style.left, `${-100 * .05 / .95}%`)
    assert.equal(image.style.width, `${100 / .95}%`)
    await api.pointer('[data-image-crop-area]', 'pointerdown', 50, 50)
    await api.pointer('[data-image-crop-area]', 'pointermove', 70, 50)
    await api.escape()
    assert.equal(api.commits.length, 1)
    assert.equal(api.find('.image-presentation-image').style.left, `${-100 * .05 / .95}%`)
  })
})

test('original image opens only on request and the preview dialog keeps Escape', async context => {
  await withImage(context, async api => {
    assert.equal(api.document.querySelector('.attachment-image-dialog'), null)
    const view = api.document.defaultView!
    view.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
    await api.click('[data-image-open-original]')
    for (let attempt = 0; attempt < 100 && !api.document.querySelector('.attachment-image-dialog'); attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    }
    const modal = api.find<HTMLDialogElement>('.attachment-image-dialog')
    assert.equal(modal.querySelector('h2')!.textContent, initial.alt)
    assert.equal(new URL(modal.querySelector('img')!.getAttribute('src')!).searchParams.get('source'), initial.src)
    const escape = new view.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => modal.querySelector('button')!.dispatchEvent(escape))
    assert.equal(escape.defaultPrevented, false)
    await act(async () => modal.dispatchEvent(new view.Event('cancel', { bubbles: true, cancelable: true })))
    assert.equal(api.document.querySelector('.attachment-image-dialog'), null)
    assert.equal(api.commits.length, 0)
    assert.ok(api.document.querySelector('[data-image-controls]'))
  })
})

test('block image controls keep repeated asset occurrences separate and pass the original source snapshot', async context => {
  const source = '![First](file:///fixture.svg)\n\n![Second](file:///fixture.svg)'
  await withImage(context, async api => {
    assert.equal(api.document.querySelectorAll('[data-image-presentation]').length, 2)
    assert.equal(api.document.querySelectorAll('.image-presentation-image')[0].getAttribute('alt'), 'First')
    assert.equal(api.document.querySelectorAll('.image-presentation-image')[1].getAttribute('alt'), 'Second')
    const second = '[data-image-presentation]:nth-of-type(2)'
    await api.click(`${second} .image-presentation-frame`)
    await api.click(`${second} [data-image-align-button="right"]`)
    assert.equal(api.commits.length, 1)
    assert.equal(api.commits[0].alt, 'Second')
    assert.equal(api.occurrences[0].originalContent, source)
    assert.equal(api.occurrences[0].source, '![Second](file:///fixture.svg)')
    const updated = replaceMarkdownImageOccurrence(source, api.occurrences[0], api.commits[0])!
    assert.equal(api.nextContents[0], updated)
    assert.ok(updated.startsWith('![First](file:///fixture.svg)\n\n<figure'))
    assert.equal(replaceMarkdownImageOccurrence('prefix ' + source, api.occurrences[0], api.commits[0]), null)
  }, source)
})

test('block image controls resolve document reference definitions and commit a guarded source replacement synchronously', async context => {
  const source = '![Reference caption][asset]', references = { ASSET: { href: 'file:///fixture.svg', title: 'Shared reference title' } }
  assert.equal(renderToStaticMarkup(createElement(BlockImagePresentations, { content: source, isZh: false })), '')
  await withImage(context, async api => {
    assert.equal(api.find<HTMLImageElement>('.block-rich-media-image').alt, 'Reference caption')
    await api.click('[data-image-align-button="right"]')
    assert.equal(api.commits.length, 1)
    assert.equal(api.commits[0].title, 'Shared reference title')
    assert.equal(api.nextContents[0], replaceMarkdownImageOccurrence(source, api.occurrences[0], api.commits[0], references))
    assert.ok(api.nextContents[0].startsWith('<figure'))
    assert.equal(api.occurrences[0].source, source)
    assert.equal(replaceMarkdownImageOccurrence(source, api.occurrences[0], api.commits[0], { ASSET: { href: 'file:///changed.svg', title: '' } }), null)
  }, source, references)
})

test('unsupported HTML images remain visible beside editable linked images of the same asset', async context => {
  const source = '<img width="50%" alt="Unsupported" src="file:///fixture.svg">\n\n[![Linked](file:///fixture.svg)](https://example.test)'
  await withImage(context, async api => {
    const presentations = api.document.querySelectorAll('[data-image-presentation]')
    assert.equal(presentations.length, 2)
    assert.equal(presentations[0].querySelector('img')!.alt, 'Unsupported')
    assert.equal(presentations[0].querySelector('.image-presentation-frame')!.getAttribute('role'), null)
    const linked = '[data-image-presentation]:nth-of-type(2)'
    await api.click(`${linked} .image-presentation-frame`)
    await api.click(`${linked} [data-image-align-button="right"]`)
    assert.equal(api.commits.length, 1)
    assert.equal(api.occurrences[0].source, '![Linked](file:///fixture.svg)')
    assert.ok(api.nextContents[0].startsWith('<img width="50%"'))
    assert.ok(api.nextContents[0].includes('[<figure'))
    assert.ok(api.nextContents[0].endsWith('](https://example.test)'))
  }, source)
})
