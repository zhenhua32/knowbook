import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentDatabaseColumn, DocumentDatabaseFieldValue } from '../src/shared/contracts'
import { DatabaseValueEditor } from '../src/renderer/src/features/database/components/DatabaseValueEditor'

const column: DocumentDatabaseColumn = { id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 0 }

async function withValueEditor(
  options: { mode?: 'blur' | 'change'; initial?: DocumentDatabaseFieldValue },
  run: (context: {
    document: Document
    window: JSDOM['window']
    input: HTMLInputElement
    changes: DocumentDatabaseFieldValue[]
    drawerEscapes: () => number
    type: (value: string) => Promise<void>
    key: (key: string, init?: KeyboardEventInit) => Promise<KeyboardEvent>
  }) => Promise<void>
) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const changes: DocumentDatabaseFieldValue[] = []
  let escaped = 0
  // The actual database drawer listens for Escape on window, outside React's root.
  const closeDrawer = (event: KeyboardEvent) => { if (event.key === 'Escape') escaped++ }
  dom.window.addEventListener('keydown', closeDrawer)
  function Harness() {
    const [value, setValue] = useState<DocumentDatabaseFieldValue>(options.initial === undefined ? 'Saved value' : options.initial)
    return createElement('aside', { role: 'dialog', 'aria-label': 'Record details' },
      createElement(DatabaseValueEditor, { column, value, textCommitMode: options.mode ?? 'blur',
        onChangeValue: next => { changes.push(next); setValue(next) } }),
      createElement('button', { type: 'button' }, 'Another drawer control'))
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    const input = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!
    assert.ok(input)
    await run({ document: dom.window.document, window: dom.window, input, changes, drawerEscapes: () => escaped,
      type: async value => { await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      key: async (key, init = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        await act(async () => input.dispatchEvent(event))
        return event
      } })
  } finally {
    await act(async () => root.unmount())
    dom.window.removeEventListener('keydown', closeDrawer)
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('blur text editing leaves IME Enter and Escape intact without closing the drawer for lifecycle, native composition and keyCode 229', async () => {
  await withValueEditor({}, async ({ document, window, input, changes, drawerEscapes, type, key }) => {
    await act(async () => input.focus())
    await type('中文候选')
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
    for (const candidateKey of ['Enter', 'Escape']) {
      assert.equal((await key(candidateKey)).defaultPrevented, false)
      assert.equal(document.activeElement, input)
      assert.equal(input.value, '中文候选', 'IME candidate cancellation must retain the current draft')
      assert.deepEqual(changes, [])
      assert.equal(drawerEscapes(), 0, 'IME Escape must not reach the window-level drawer handler')
    }
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const candidateKey of ['Enter', 'Escape']) {
        assert.equal((await key(candidateKey, init)).defaultPrevented, false)
        assert.equal(document.activeElement, input)
        assert.equal(input.value, '中文候选')
        assert.deepEqual(changes, [])
        assert.equal(drawerEscapes(), 0)
      }
    }
    await key('Enter')
    assert.notEqual(document.activeElement, input)
    assert.deepEqual(changes, ['中文候选'])
    assert.equal(input.value, '中文候选')
  })
})

test('blur clears a stale composition flag so the same text control can submit its next edit', async () => {
  await withValueEditor({}, async ({ document, window, input, changes, type, key }) => {
    await act(async () => {
      input.focus()
      input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }))
      input.blur()
    })
    const commitsAfterBlur = changes.length
    await act(async () => input.focus())
    await type('Next ordinary edit')
    await key('Enter')
    assert.notEqual(document.activeElement, input)
    assert.deepEqual(changes.slice(commitsAfterBlur), ['Next ordinary edit'])
    assert.equal(input.value, 'Next ordinary edit')
  })
})

test('Escape cancels a blur-mode draft without committing or closing the drawer, then the field edits normally again', async () => {
  await withValueEditor({}, async ({ document, input, changes, drawerEscapes, type, key }) => {
    await act(async () => input.focus())
    await type('Discard this draft')
    assert.deepEqual(changes, [])
    const escape = await key('Escape')
    assert.equal(escape.defaultPrevented, true)
    assert.equal(drawerEscapes(), 0, 'field cancellation must stop the window-level drawer Escape handler')
    assert.notEqual(document.activeElement, input)
    assert.equal(input.value, 'Saved value')
    assert.deepEqual(changes, [], 'the blur triggered by cancellation must not commit the discarded draft')
    await act(async () => input.focus())
    await type('Keep this next edit')
    await key('Enter')
    assert.deepEqual(changes, ['Keep this next edit'])
    assert.equal(input.value, 'Keep this next edit')
  })
})

for (const initial of ['Saved value', null] as const) {
  test(`Escape restores the focus-time ${initial === null ? 'empty' : 'saved'} value after change-mode parent updates`, async () => {
    await withValueEditor({ mode: 'change', initial }, async ({ document, input, changes, drawerEscapes, type, key }) => {
      await act(async () => input.focus())
      await type('First changed draft')
      await type('Second changed draft')
      assert.deepEqual(changes, ['First changed draft', 'Second changed draft'])
      const escape = await key('Escape')
      assert.equal(escape.defaultPrevented, true)
      assert.equal(drawerEscapes(), 0)
      assert.notEqual(document.activeElement, input)
      assert.equal(input.value, initial ?? '')
      assert.deepEqual(changes, ['First changed draft', 'Second changed draft', initial],
        'cancel restores the value captured before parent props began following each keystroke')
      await act(async () => input.focus())
      await type('The next accepted value')
      await act(async () => input.blur())
      assert.deepEqual(changes, ['First changed draft', 'Second changed draft', initial, 'The next accepted value'])
      assert.equal(input.value, 'The next accepted value')
    })
  })
}

test('ordinary blur commits the current DOM text rather than a stale render draft and normalizes whitespace to null', async () => {
  await withValueEditor({}, async ({ window, input, changes }) => {
    await act(async () => input.focus())
    // No input event: autofill and a blur in the same turn can precede React's draft update.
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '  Current DOM text  ')
      input.blur()
    })
    assert.deepEqual(changes, ['Current DOM text'])
    assert.equal(input.value, 'Current DOM text')
    await act(async () => {
      input.focus()
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, ' \t ')
      input.blur()
    })
    assert.deepEqual(changes, ['Current DOM text', null])
    assert.equal(input.value, '')
    await act(async () => {
      input.focus()
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Fresh edit')
      input.blur()
    })
    assert.deepEqual(changes, ['Current DOM text', null, 'Fresh edit'])
    assert.equal(input.value, 'Fresh edit')
  })
})
