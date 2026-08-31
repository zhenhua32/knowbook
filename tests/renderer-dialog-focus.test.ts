import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import {
  getDialogFocusableElements,
  trapFocusWithinDialog
} from '../src/renderer/src/utils/dialogFocus.ts'

test('dialog focus trap cycles in both directions and recovers focus from outside', () => {
  const dom = new JSDOM([
    '<!doctype html><html><body>',
    '<button id="outside">Outside</button>',
    '<aside id="dialog" tabindex="-1">',
    '<button id="first">First</button>',
    '<button disabled>Disabled</button>',
    '<textarea id="last"></textarea>',
    '</aside>',
    '</body></html>'
  ].join(''), { pretendToBeVisual: true })

  try {
    const document = dom.window.document
    const dialog = document.querySelector<HTMLElement>('#dialog')
    const outside = document.querySelector<HTMLElement>('#outside')
    const first = document.querySelector<HTMLElement>('#first')
    const last = document.querySelector<HTMLElement>('#last')
    assert.ok(dialog && outside && first && last)
    assert.deepEqual(getDialogFocusableElements(dialog).map((element) => element.id), ['first', 'last'])

    last.focus()
    const forward = new dom.window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    assert.equal(trapFocusWithinDialog(forward as unknown as KeyboardEvent, dialog), true)
    assert.equal(document.activeElement, first)
    assert.equal(forward.defaultPrevented, true)

    first.focus()
    const backward = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true })
    assert.equal(trapFocusWithinDialog(backward as unknown as KeyboardEvent, dialog), true)
    assert.equal(document.activeElement, last)

    outside.focus()
    const recover = new dom.window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    assert.equal(trapFocusWithinDialog(recover as unknown as KeyboardEvent, dialog), true)
    assert.equal(document.activeElement, first)
  } finally {
    dom.window.close()
  }
})
