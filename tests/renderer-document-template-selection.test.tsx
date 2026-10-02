import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { CreateDocumentFromTemplateInput, DocumentTemplate, DocumentTreeNode } from '../src/shared/contracts'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: DocumentTemplateDialog } = await import('../src/renderer/src/components/DocumentTemplateDialog')
const { setActiveUiLanguage } = await import('../src/renderer/src/i18n')

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const template = (id: string, name: string, builtIn = false): DocumentTemplate => ({
  id, name, description: `Description for ${name}`, title: `${name} title`, summary: `Summary for ${name}`,
  blocks: [{ type: 'paragraph', content: `${name} body`, checked: false, depth: 0 }], builtIn
})
const alpha = template('a', 'Alpha', true), beta = template('b', 'Beta'), gamma = template('c', 'Gamma')
const tree: DocumentTreeNode[] = [{ id: 'parent', title: 'Parent', path: 'Parent', updatedAt: '2026-10-02', children: [] }]

type Context = {
  document: Document; window: JSDOM['window']; creates: CreateDocumentFromTemplateInput[]; deleted: string[]; languages: string[]
  closes: () => number; dialog: () => HTMLDialogElement; search: () => HTMLInputElement; title: () => HTMLInputElement
  parent: () => HTMLSelectElement; primary: () => HTMLButtonElement; items: () => HTMLButtonElement[]; preview: () => string
  change: (callback: () => void) => Promise<void>; fill: (input: HTMLInputElement, value: string) => Promise<void>
  category: (index: number) => Promise<void>; submit: () => Promise<void>; render: (isZh: boolean) => Promise<void>
}
type Options = {
  isZh?: boolean; templates?: DocumentTemplate[]; list?: (language: string) => Promise<DocumentTemplate[]>
  create?: (input: CreateDocumentFromTemplateInput) => Promise<void>; remove?: (id: string) => Promise<void>
}

async function withTemplates(run: (context: Context) => Promise<void>, options: Options = {}) {
  const dom = new JSDOM('<button id="opener">Open templates</button><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0, closes = 0
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
  const cancelFrame = (id: number) => { frames.delete(id) }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  dom.window.requestAnimationFrame = requestFrame
  dom.window.cancelAnimationFrame = cancelFrame
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  const creates: CreateDocumentFromTemplateInput[] = [], deleted: string[] = [], languages: string[] = []
  Object.defineProperty(dom.window, 'knowbook', { value: {
    listDocumentTemplates: (language: string) => {
      languages.push(language)
      return options.list ? options.list(language) : Promise.resolve(options.templates ?? [alpha, beta, gamma])
    },
    deleteDocumentTemplate: async (id: string) => { deleted.push(id); await options.remove?.(id) }
  } })
  const { createRoot } = await import('react-dom/client')
  // Preload the real confirmation module after a DOM exists so its dynamic import is not a test timing dependency.
  await import('../src/renderer/src/components/showConfirmation')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const render = async (isZh: boolean) => {
    setActiveUiLanguage(isZh ? 'zh-CN' : 'en-US')
    await act(async () => root.render(createElement(DocumentTemplateDialog, {
      isZh, documentTree: tree, onClose: () => { closes++ },
      onCreate: async input => { creates.push(input); await options.create?.(input) }
    })))
  }
  const dialog = () => dom.window.document.querySelector<HTMLDialogElement>('.document-template-dialog')!
  const search = () => dialog().querySelector<HTMLInputElement>('input[type="search"]')!
  const title = () => dialog().querySelector<HTMLInputElement>('[name="document-title"]')!
  const primary = () => dialog().querySelector<HTMLButtonElement>('.document-capture-footer .primary-button')!
  dom.window.document.getElementById('opener')!.focus()
  try {
    await render(options.isZh ?? false)
    await run({ document: dom.window.document, window: dom.window, creates, deleted, languages, closes: () => closes,
      dialog, search, title, primary, parent: () => dialog().querySelector<HTMLSelectElement>('select')!,
      items: () => [...dialog().querySelectorAll<HTMLButtonElement>('.document-template-item')],
      preview: () => dialog().querySelector('.document-template-preview')?.textContent ?? '', change, render,
      fill: (input, value) => change(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }),
      category: index => change(() => dialog().querySelectorAll<HTMLButtonElement>('.document-template-filters button')[index].click()),
      submit: () => change(() => {
        const form = dialog().querySelector('form')!
        const event = new dom.window.Event('submit', { bubbles: true, cancelable: true })
        form.dispatchEvent(event)
        assert.equal(event.defaultPrevented, true)
      })
    })
  } finally {
    const confirmation = dom.window.document.querySelector<HTMLButtonElement>('.app-confirm-dialog .secondary-button')
    if (confirmation && !confirmation.disabled) await change(() => confirmation.click())
    await act(async () => root.unmount())
    setActiveUiLanguage('zh-CN')
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('query filtering aligns the selected item, preview, automatic title and actual create payload in both languages', async () => {
  for (const isZh of [false, true]) await withTemplates(async context => {
    assert.equal(context.title().value, 'Alpha title')
    await context.fill(context.search(), '  bEtA  ')
    assert.equal(context.items().length, 1)
    assert.equal(context.items()[0].getAttribute('aria-pressed'), 'true', 'The visible fallback is the effective selection')
    assert.equal(context.preview().includes('Beta body'), true)
    assert.equal(context.preview().includes('Alpha body'), false)
    assert.equal(context.title().value, 'Beta title')
    await context.fill(context.search(), '')
    assert.equal(context.items().find(item => item.getAttribute('aria-pressed') === 'true')?.textContent?.includes('Alpha'), true)
    assert.equal(context.title().value, 'Alpha title', 'Clearing a query in the same category restores the remembered selection')
    await context.fill(context.search(), 'Beta')
    await context.submit()
    assert.deepEqual(context.creates, [{ templateId: 'b', title: 'Beta title', parentId: null, language: isZh ? 'zh-CN' : 'en-US' }])
  }, { isZh })
})

test('an empty filter cannot create or delete a hidden template and retains manual title, blank title and parent drafts', async () => {
  await withTemplates(async context => {
    await context.fill(context.title(), 'My manual document title')
    await context.change(() => {
      context.parent().value = 'parent'
      context.parent().dispatchEvent(new context.window.Event('change', { bubbles: true }))
    })
    await context.fill(context.search(), 'Beta')
    assert.equal(context.title().value, 'My manual document title')
    assert.equal(context.parent().value, 'parent')
    await context.fill(context.search(), 'No such template')
    assert.equal(context.preview(), '')
    assert.equal(context.dialog().querySelectorAll('.document-template-delete').length, 0)
    assert.equal(context.primary().disabled, true)
    await context.change(() => context.primary().click())
    assert.deepEqual(context.creates, [])
    assert.deepEqual(context.deleted, [])
    await context.fill(context.search(), '')
    assert.equal(context.title().value, 'My manual document title')
    assert.equal(context.parent().value, 'parent')
    await context.fill(context.title(), '')
    await context.fill(context.search(), 'No such template')
    await context.fill(context.search(), '')
    assert.equal(context.title().value, '', 'An intentionally blank title survives the hidden creation form')
    assert.equal(context.parent().value, 'parent')

    await context.category(2)
    assert.equal(context.items().find(item => item.getAttribute('aria-pressed') === 'true')?.textContent?.includes('Beta'), true)
    await context.fill(context.search(), 'Gamma')
    await context.fill(context.search(), '')
    assert.equal(context.items().find(item => item.getAttribute('aria-pressed') === 'true')?.textContent?.includes('Beta'), true)
    await context.category(1)
    assert.equal(context.items().length, 1)
    assert.equal(context.items()[0].textContent?.includes('Alpha'), true, 'Category changes retain the existing explicit category selection policy')
  })
})

test('deleting a filtered fallback targets the visible template, retains the filter and preserves an undeleted remembered selection', async () => {
  const deletion = deferred<void>()
  const customAlpha = { ...alpha, builtIn: false }, needleBeta = { ...beta, description: 'Needle match one' }, needleGamma = { ...gamma, description: 'Needle match two' }
  await withTemplates(async context => {
    await context.fill(context.search(), 'needle')
    await context.change(() => context.dialog().querySelector<HTMLButtonElement>('.document-template-delete')!.click())
    assert.equal(context.document.querySelector('.app-confirm-dialog h2')!.textContent?.includes('Beta'), true,
      'The confirmation describes the visible fallback rather than a hidden preferred template')
    await context.change(() => {
      const confirm = context.document.querySelector<HTMLButtonElement>('.app-confirm-dialog .danger-button')!
      confirm.click()
      confirm.click()
    })
    assert.deepEqual(context.deleted, ['b'])
    await context.change(() => deletion.resolve())
    assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
    assert.equal(context.search().value, 'needle')
    assert.equal(context.items().length, 1)
    assert.equal(context.items()[0].getAttribute('aria-pressed'), 'true')
    assert.equal(context.preview().includes('Gamma body'), true)
    await context.fill(context.search(), '')
    assert.equal(context.items().find(item => item.getAttribute('aria-pressed') === 'true')?.textContent?.includes('Alpha'), true)
    assert.equal(context.preview().includes('Alpha body'), true)
  }, { templates: [customAlpha, needleBeta, needleGamma], remove: () => deletion.promise })
})

test('retry and language reload use the current filter, while IME and synchronous creation locking retain their existing guards', async () => {
  const initial = deferred<DocumentTemplate[]>(), translated = deferred<DocumentTemplate[]>(), creation = deferred<void>()
  let reads = 0
  await withTemplates(async context => {
    assert.equal(context.primary().disabled, true)
    await context.change(() => initial.reject(new Error('Template list temporarily unavailable')))
    assert.equal(context.dialog().querySelector('[role="alert"]')!.textContent, 'Template list temporarily unavailable')
    await context.change(() => context.dialog().querySelector<HTMLButtonElement>('.document-capture-empty button')!.click())
    await context.fill(context.search(), 'Beta')
    await context.render(true)
    assert.equal(context.primary().disabled, true)
    await context.change(() => translated.resolve([{ ...beta, title: '中文 Beta title' }, { ...alpha, title: '中文 Alpha title' }]))
    assert.equal(context.items().length, 1)
    assert.equal(context.items()[0].getAttribute('aria-pressed'), 'true')
    assert.equal(context.title().value, '中文 Beta title')
    assert.deepEqual(context.languages, ['en-US', 'en-US', 'zh-CN'])

    await context.change(() => {
      context.dialog().dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true }))
      const escape = new context.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })
      context.search().dispatchEvent(escape)
      assert.equal(escape.defaultPrevented, true)
    })
    await context.submit()
    assert.equal(context.creates.length, 0)
    assert.equal(context.closes(), 0)
    await context.change(() => context.dialog().dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true })))
    await context.change(() => {
      const form = context.dialog().querySelector('form')!
      form.dispatchEvent(new context.window.Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new context.window.Event('submit', { bubbles: true, cancelable: true }))
    })
    assert.equal(context.creates.length, 1)
    assert.equal(context.creates[0].templateId, 'b')
    assert.equal(context.dialog().getAttribute('aria-busy'), 'true')
    assert.equal(context.search().disabled, true)
    const cancel = new context.window.Event('cancel', { bubbles: false, cancelable: true })
    await context.change(() => context.dialog().dispatchEvent(cancel))
    assert.equal(cancel.defaultPrevented, true)
    assert.equal(context.closes(), 0)
    await context.change(() => creation.resolve())
    assert.equal(context.closes(), 1)
  }, { list: () => ++reads === 1 ? initial.promise : reads === 2 ? Promise.resolve([alpha, beta, gamma]) : translated.promise,
    create: () => creation.promise })
})

test('category selection evaluates the remembered template rather than a temporary query fallback', async () => {
  const delta = template('d', 'Delta', true)
  await withTemplates(async context => {
    await context.change(() => context.items().find(item => item.textContent?.includes('Delta'))!.click())
    assert.equal(context.title().value, 'Delta title')
    await context.fill(context.search(), 'Beta')
    assert.equal(context.items().length, 1)
    assert.equal(context.items()[0].getAttribute('aria-pressed'), 'true')
    assert.equal(context.preview().includes('Beta body'), true)

    await context.category(1)
    assert.equal(context.items().length, 0)
    assert.equal(context.preview(), '')
    assert.equal(context.primary().disabled, true)
    await context.fill(context.search(), '')
    assert.equal(context.items().find(item => item.getAttribute('aria-pressed') === 'true')?.textContent?.includes('Delta'), true,
      'The remembered Delta already belongs to Built-in, so temporary Beta must not reset it to the first Alpha')
    assert.equal(context.preview().includes('Delta body'), true)
    assert.equal(context.preview().includes('Alpha body'), false)
    assert.equal(context.title().value, 'Delta title')
    await context.submit()
    assert.deepEqual(context.creates, [{ templateId: 'd', title: 'Delta title', parentId: null, language: 'en-US' }])
  }, { templates: [alpha, delta, beta] })
})
