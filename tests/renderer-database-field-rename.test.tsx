import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useState, type Dispatch, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseField } from '../src/shared/contracts'
import { DatabaseFieldDrawer } from '../src/renderer/src/features/database/components/DatabaseFieldDrawer'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

const owner: DatabaseField = { id: 'owner', name: 'Owner', type: 'text', role: 'property', options: [],
  editable: true, hideable: true, deletable: true, sortOrder: 0 }
const stage: DatabaseField = { ...owner, id: 'stage', name: 'Stage', type: 'select', options: ['Draft', 'Published'], sortOrder: 1 }

async function withRenameDrawer(run: (context: {
  document: Document; window: JSDOM['window']; renames: { fieldId: string; name: string }[];
  closes: () => number; edit: (fieldId?: string) => Promise<HTMLInputElement>;
  fill: (input: HTMLInputElement, value: string) => Promise<void>;
  key: (input: HTMLInputElement, key: string, init?: KeyboardEventInit) => Promise<KeyboardEvent>;
  refreshName: (name: string) => Promise<void>; delayNextRename: () => (() => void)
}) => Promise<void>, locale = 'en-US') {
  const dom = new JSDOM('<button id="opener">Fields</button><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId },
    cancelAnimationFrame: (id: number) => frames.delete(id) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const renames: { fieldId: string; name: string }[] = []
  let closeCount = 0
  let setFields!: Dispatch<SetStateAction<DatabaseField[]>>
  let nextRenameDelay: Promise<void> | null = null
  function Harness() {
    const [fields, updateFields] = useState([owner, stage])
    setFields = updateFields
    return createElement(DatabaseFieldDrawer, {
      fields, fieldOrder: ['owner', 'stage'], open: true, sourceSessionKey: 'test-source', text: getDatabaseWorkspaceText(locale), visibleFieldIds: ['owner', 'stage'],
      onClose: () => closeCount++, onCreateField: async () => true, onDeleteField: () => {}, onMoveField: () => {},
      onMoveDatabaseField: async () => true, onToggleField: () => {}, onUpdateOptions: async () => true,
      onRenameField: async (fieldId, name) => {
        renames.push({ fieldId, name })
        const delay = nextRenameDelay
        nextRenameDelay = null
        if (delay) await delay
        setFields(previous => previous.map(field => field.id === fieldId ? { ...field, name } : field))
        return true
      }
    })
  }
  const fill = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => {
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach(callback => callback(0))
    })
    await run({ document: dom.window.document, window: dom.window, renames, closes: () => closeCount, fill,
      edit: async (fieldId = 'owner') => {
        const index = fieldId === 'owner' ? 0 : 1
        const row = dom.window.document.querySelectorAll('.dbw-field-row')[index]
        await act(async () => row.querySelector<HTMLButtonElement>('.dbw-field-name')!.click())
        const input = row.querySelector<HTMLInputElement>('.dbw-field-copy input:not(.dbw-field-options)')!
        assert.equal(dom.window.document.activeElement, input)
        return input
      },
      key: async (input, key, init = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        await act(async () => input.dispatchEvent(event))
        return event
      },
      refreshName: async name => {
        await act(async () => setFields(previous => previous.map(field => ({ ...field, ...(field.id === 'owner' ? { name } : {}) }))))
      },
      delayNextRename: () => {
        let resolve!: () => void
        nextRenameDelay = new Promise<void>(done => { resolve = done })
        return resolve
      }
    })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

const nameButton = (document: Document, index = 0) => document.querySelectorAll<HTMLButtonElement>('.dbw-field-name')[index]!
const drawer = (document: Document) => document.querySelector('[role="dialog"]')

test('field renaming leaves IME Enter and Escape intact for lifecycle, native composition and keyCode 229 in both languages', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    await withRenameDrawer(async ({ document, window, renames, closes, edit, fill, key }) => {
      const input = await edit()
      await fill(input, '中文候选')
      await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
      for (const candidateKey of ['Enter', 'Escape']) {
        assert.equal((await key(input, candidateKey)).defaultPrevented, false)
        assert.equal(document.activeElement, input)
        assert.equal(input.value, '中文候选')
        assert.equal(renames.length, 0)
        assert.equal(closes(), 0)
        assert.ok(drawer(document))
      }
      await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
      for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
        for (const candidateKey of ['Enter', 'Escape']) {
          assert.equal((await key(input, candidateKey, init)).defaultPrevented, false)
          assert.equal(document.activeElement, input)
          assert.equal(input.value, '中文候选')
          assert.equal(renames.length, 0)
          assert.equal(closes(), 0)
        }
      }
      assert.equal((await key(input, 'Enter')).defaultPrevented, true)
      assert.deepEqual(renames, [{ fieldId: 'owner', name: '中文候选' }])
      assert.equal(document.activeElement, nameButton(document))
      assert.equal(nameButton(document).textContent, '中文候选')
      assert.equal(closes(), 0)
    }, locale)
  }
})

test('ordinary Escape cancels before its synchronous blur, keeps the drawer open and restores the corresponding name button', async () => {
  await withRenameDrawer(async ({ document, renames, closes, edit, fill, key }) => {
    const input = await edit('stage')
    await fill(input, 'Discard this name')
    let blurCount = 0
    input.addEventListener('blur', () => blurCount++)
    assert.equal((await key(input, 'Escape')).defaultPrevented, true)
    assert.equal(blurCount, 1, 'the cancellation path really blurs the old input')
    assert.equal(renames.length, 0, 'the blur must observe cancellation synchronously')
    assert.equal(closes(), 0, 'Escape is consumed by the name editor before the drawer listener')
    assert.ok(drawer(document))
    assert.equal(document.activeElement, nameButton(document, 1))
    assert.equal(nameButton(document, 1).textContent, 'Stage')
    const next = await edit('stage')
    assert.equal(next.value, 'Stage')
    await fill(next, 'Keep next name')
    await key(next, 'Enter')
    assert.deepEqual(renames, [{ fieldId: 'stage', name: 'Keep next name' }])
    assert.equal(document.activeElement, nameButton(document, 1))
  })
})

test('ordinary Enter keeps its editor locked until submission succeeds, then restores the refreshed name button', async () => {
  await withRenameDrawer(async ({ document, window, renames, closes, edit, key, delayNextRename }) => {
    const input = await edit()
    const finishRename = delayNextRename()
    // Browser autofill can update the DOM immediately before blur without an input event.
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '  Accepted name  ')
    let blurCount = 0
    input.addEventListener('blur', () => blurCount++)
    await key(input, 'Enter')
    assert.equal(blurCount, 1)
    assert.deepEqual(renames, [{ fieldId: 'owner', name: 'Accepted name' }])
    assert.equal(document.querySelector('.dbw-field-row .dbw-field-copy')?.contains(input), true, 'the submitted editor remains visible until success')
    assert.equal(input.disabled, true)
    assert.equal(input.value, '  Accepted name  ')
    assert.equal(drawer(document)?.getAttribute('aria-busy'), 'true')
    assert.equal(closes(), 0)
    await act(async () => finishRename())
    assert.equal(document.activeElement, nameButton(document), 'refresh preserves the focused name button')
    assert.equal(nameButton(document).textContent, 'Accepted name')
    assert.equal(nameButton(document).disabled, false)
    assert.equal((await edit()).value, 'Accepted name')
  })
})

test('blank and unchanged names restore the existing name without a rename request', async () => {
  await withRenameDrawer(async ({ document, renames, edit, fill, key }) => {
    for (const value of ['   ', 'Owner']) {
      const input = await edit()
      await fill(input, value)
      await key(input, 'Enter')
      assert.equal(renames.length, 0)
      assert.equal(nameButton(document).textContent, 'Owner')
      assert.equal(document.activeElement, nameButton(document))
    }
    assert.equal((await edit()).value, 'Owner')
  })
})

test('ordinary blur ends a stale composition session and preserves the destination control focus', async () => {
  await withRenameDrawer(async ({ document, window, renames, closes, edit, fill, key }) => {
    const input = await edit()
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
    const destination = document.querySelector<HTMLButtonElement>('.dbw-field-row .dbw-field-visibility')!
    await act(async () => destination.focus())
    assert.equal(renames.length, 0)
    assert.equal(document.activeElement, destination, 'mouse or Tab blur must not steal focus back')
    const next = await edit()
    await fill(next, 'Next ordinary name')
    await key(next, 'Enter')
    assert.deepEqual(renames, [{ fieldId: 'owner', name: 'Next ordinary name' }])
    assert.equal(document.activeElement, nameButton(document))
    assert.equal(closes(), 0)
  })
})

test('ordinary blur commits a changed name once without returning focus from the next drawer control', async () => {
  await withRenameDrawer(async ({ document, renames, closes, edit, fill }) => {
    const input = await edit()
    await fill(input, 'Blur accepted name')
    const destination = document.querySelector<HTMLButtonElement>('.dbw-field-row .dbw-field-visibility')!
    await act(async () => destination.focus())
    assert.deepEqual(renames, [{ fieldId: 'owner', name: 'Blur accepted name' }])
    assert.equal(nameButton(document).textContent, 'Blur accepted name')
    assert.equal(document.activeElement, destination)
    assert.equal(closes(), 0)
  })
})

test('field name refreshes synchronize the displayed and reopened editor values, including during an edit', async () => {
  await withRenameDrawer(async ({ document, renames, edit, fill, key, refreshName }) => {
    await refreshName('Refreshed owner')
    assert.equal(nameButton(document).textContent, 'Refreshed owner')
    const input = await edit()
    assert.equal(input.value, 'Refreshed owner')
    await fill(input, 'Uncommitted local name')
    await refreshName('New server name')
    assert.equal(input.value, 'New server name')
    await key(input, 'Escape')
    assert.equal(renames.length, 0)
    assert.equal(nameButton(document).textContent, 'New server name')
    assert.equal(document.activeElement, nameButton(document))
    assert.equal((await edit()).value, 'New server name')
  })
})
