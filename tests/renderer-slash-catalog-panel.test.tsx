import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'

type PanelProps = ComponentProps<typeof import('../src/renderer/src/components/FloatingSlashCommandPanel')['FloatingSlashCommandPanel']>
const command = { id: 'columns', label: 'Two columns', description: 'Create two columns with adjustable widths.' }
const base: PanelProps = {
  x: 30, y: 40, query: 'col', commands: [command], activeCommandId: 'columns',
  noMatchingLabel: 'No matching commands', retryLabel: 'Retry commands',
  onSelectCommand: () => {}, onHoverCommand: () => {}
}

async function withPanel(run: (context: {
  dom: JSDOM
  render: (props?: Partial<PanelProps>) => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="editor" contenteditable="true" tabindex="0"></div><div id="mount"></div>', {
    pretendToBeVisual: true, url: 'http://localhost'
  })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    ResizeObserver: undefined, IS_REACT_ACT_ENVIRONMENT: true
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  let root: import('react-dom/client').Root | undefined
  try {
    const { FloatingSlashCommandPanel } = await import('../src/renderer/src/components/FloatingSlashCommandPanel')
    const { createRoot } = await import('react-dom/client')
    root = createRoot(dom.window.document.getElementById('mount')!)
    await run({ dom, render: async (props = {}) => {
      await act(async () => root!.render(createElement(FloatingSlashCommandPanel, { ...base, ...props })))
    } })
  } finally {
    if (root) await act(async () => root!.unmount())
    dom.window.close()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('slash loading takes precedence over stale commands, errors and empty-result feedback', async () => {
  await withPanel(async ({ dom, render }) => {
    await render({ loadingLabel: 'Loading commands', errorLabel: 'Previous request failed', onRetry: () => {} })
    const document = dom.window.document
    assert.equal(document.querySelector('[role=status]')?.textContent, 'Loading commands')
    assert.equal(document.querySelector('[role=alert]'), null)
    assert.equal(document.querySelector('button'), null)
    assert.equal(document.querySelector('.slash-command-query')?.textContent, 'col')
    assert.equal(document.querySelector('.slash-command-list')?.textContent?.includes(base.noMatchingLabel), false)
  })
})

test('a failed slash catalog offers a real retry action while preserving the editor focus', async () => {
  await withPanel(async ({ dom, render }) => {
    let retries = 0
    await render({ errorLabel: 'Commands could not be loaded', onRetry: () => { retries++ } })
    const document = dom.window.document
    const alert = document.querySelector('[role=alert]')
    assert.ok(alert)
    assert.equal(alert.querySelector('p')?.textContent, 'Commands could not be loaded')
    assert.equal(document.querySelector('[role=status]'), null)
    assert.equal(document.querySelector('.slash-command-item'), null)
    assert.equal(alert.textContent?.includes(base.noMatchingLabel), false)
    const retry = alert.querySelector<HTMLButtonElement>('button')
    assert.ok(retry)
    assert.equal(retry.textContent, 'Retry commands')
    assert.equal(retry.type, 'button')
    const editor = document.getElementById('editor')!
    editor.focus()
    const mouseDown = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => { retry.dispatchEvent(mouseDown); retry.click() })
    assert.equal(mouseDown.defaultPrevented, true)
    assert.equal(document.activeElement, editor)
    assert.equal(retries, 1)
  })
})

test('loaded slash choices restore hover and selection, and only a completed empty search shows no matches', async () => {
  await withPanel(async ({ dom, render }) => {
    const selected: PanelProps['commands'] = []
    const hovered: number[] = []
    await render({ loadingLabel: 'Loading commands' })
    await render({ errorLabel: 'Load failed', onRetry: () => {} })
    await render({ onSelectCommand: value => selected.push(value), onHoverCommand: index => hovered.push(index) })
    const document = dom.window.document
    assert.equal(document.querySelector('[role=status]'), null)
    assert.equal(document.querySelector('[role=alert]'), null)
    const choice = document.querySelector<HTMLButtonElement>('.slash-command-item')
    assert.ok(choice)
    assert.equal(choice.classList.contains('slash-command-item-active'), true)
    assert.equal(choice.querySelector('strong')?.textContent, '/columns')
    assert.equal(choice.querySelector('span')?.textContent, command.label)
    assert.equal(choice.querySelector('small')?.textContent, command.description)
    const editor = document.getElementById('editor')!
    editor.focus()
    const mouseDown = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => {
      choice.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
      choice.dispatchEvent(mouseDown)
      choice.click()
    })
    assert.deepEqual(hovered, [0])
    assert.deepEqual(selected, [command])
    assert.equal(selected[0], command)
    assert.equal(mouseDown.defaultPrevented, true)
    assert.equal(document.activeElement, editor)

    await render({ commands: [], activeCommandId: null })
    assert.equal(document.querySelector('.slash-command-empty')?.textContent, base.noMatchingLabel)
    assert.equal(document.querySelector('[role=status]'), null)
    assert.equal(document.querySelector('[role=alert]'), null)
    assert.equal(document.querySelector('button'), null)
  })
})
