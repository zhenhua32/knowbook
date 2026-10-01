import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { hasVisibleShortcutBlocker } from '../src/renderer/src/utils/shortcutBlocker'
import { openShortcutHelp } from '../src/renderer/src/openShortcutHelp'

const fixtureKey = '__knowbookShortcutHelpFixture'
const dialogStub = 'data:text/javascript,' + encodeURIComponent(`export async function showShortcutHelp(previous) { globalThis.${fixtureKey}(previous) }`)
// Load only the help controller and button in Node; real dialog behavior remains covered by Electron E2E.
register('data:text/javascript,' + encodeURIComponent(`export function resolve(specifier, context, nextResolve) {
  if (specifier === './components/ShortcutHelpDialog') return { shortCircuit: true, url: ${JSON.stringify(dialogStub)} }
  if (specifier.endsWith('.css')) return { shortCircuit: true, url: 'data:text/javascript,export%20default%20%7B%7D' }
  return nextResolve(specifier, context)
}`), import.meta.url)

test('shortcut blockers distinguish retained hidden and inert drafts from a visible modal', () => {
  const dom = new JSDOM('<section id="panel"><div data-block-shortcuts id="editor"><textarea>Retained draft</textarea></div></section><dialog data-block-shortcuts id="modal"></dialog>')
  const document = dom.window.document
  const panel = document.getElementById('panel')!, editor = document.getElementById('editor')!
  const modal = document.getElementById('modal')!
  let editorHasLayout = true
  Object.defineProperty(editor, 'getClientRects', { value: () => editorHasLayout ? [new dom.window.DOMRect(0, 0, 100, 100)] : [] })
  Object.defineProperty(modal, 'getClientRects', { value: () => modal.hasAttribute('open') ? [new dom.window.DOMRect(0, 0, 100, 100)] : [] })
  assert.equal(hasVisibleShortcutBlocker(document), true)
  panel.hidden = true
  assert.equal(hasVisibleShortcutBlocker(document), false)
  panel.hidden = false
  panel.setAttribute('inert', '')
  assert.equal(hasVisibleShortcutBlocker(document), false)
  panel.removeAttribute('inert')
  editor.hidden = true
  assert.equal(hasVisibleShortcutBlocker(document), false)
  editor.hidden = false
  editorHasLayout = false
  assert.equal(hasVisibleShortcutBlocker(document), false)
  modal.setAttribute('open', '')
  assert.equal(hasVisibleShortcutBlocker(document), true, 'a real visible modal remains protected beside a hidden editor')
  assert.equal(editor.querySelector('textarea')!.value, 'Retained draft')
  dom.window.close()
})

test('the help entry ignores hidden blockers, preserves visible modal protection and rechecks after lazy loading', async () => {
  const dom = new JSDOM('<button id="trigger">Shortcuts</button><section id="panel"><div data-block-shortcuts id="editor"><textarea>Retained draft</textarea></div></section>')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
  const shown: unknown[] = []
  Object.defineProperty(globalThis, fixtureKey, { configurable: true, value: (previous: unknown) => { shown.push(previous) } })
  const document = dom.window.document, panel = document.getElementById('panel')!, editor = document.getElementById('editor')!
  const trigger = document.getElementById('trigger')!
  Object.defineProperty(editor, 'getClientRects', { value: () => [new dom.window.DOMRect(0, 0, 100, 100)] })
  trigger.focus()
  try {
    await openShortcutHelp()
    assert.equal(shown.length, 0, 'visible editors still block the help entry')
    panel.hidden = true
    await openShortcutHelp()
    assert.deepEqual(shown, [trigger], 'hidden draft does not block help or lose its return focus target')
    panel.hidden = false
    panel.setAttribute('inert', '')
    await openShortcutHelp()
    assert.equal(shown.length, 2)
    panel.removeAttribute('inert')
    panel.hidden = true
    const opening = openShortcutHelp()
    panel.hidden = false
    await opening
    assert.equal(shown.length, 2, 'a blocker revealed while the help module loads prevents a nested help dialog')
    assert.equal(editor.querySelector('textarea')!.value, 'Retained draft')
  } finally {
    Reflect.deleteProperty(globalThis, fixtureKey)
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    dom.window.close()
  }
})

test('the sidebar help label is concise while retaining its complete accessible name and F1 hint', async () => {
  const { default: ShortcutHelpButton } = await import('../src/renderer/src/components/ShortcutHelpButton')
  for (const isZh of [true, false]) {
    const dom = new JSDOM(renderToStaticMarkup(createElement(ShortcutHelpButton, { isZh })))
    assert.equal(dom.window.document.querySelector('button')!.getAttribute('aria-label'), isZh ? '快捷键帮助' : 'Keyboard shortcuts')
    assert.equal(dom.window.document.querySelector('span')!.textContent, isZh ? '快捷键' : 'Shortcuts')
    assert.equal(dom.window.document.querySelector('kbd')!.textContent, 'F1')
    assert.equal(dom.window.document.querySelector('button')!.getAttribute('aria-keyshortcuts'), 'F1')
    dom.window.close()
  }
})
