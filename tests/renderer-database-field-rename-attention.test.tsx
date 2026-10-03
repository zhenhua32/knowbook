import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseField } from '../src/shared/contracts'
import { DatabaseFieldDrawer } from '../src/renderer/src/features/database/components/DatabaseFieldDrawer'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

const originalFields: DatabaseField[] = [
  { id: 'owner', name: 'Owner', type: 'text', role: 'property', options: [],
    editable: true, hideable: true, deletable: true, sortOrder: 0 },
  { id: 'stage', name: 'Stage', type: 'select', role: 'property', options: ['Draft', 'Published'],
    editable: true, hideable: true, deletable: true, sortOrder: 1 }
]

for (const locale of ['en-US', 'zh-CN']) {
  test(`field rename completion preserves the drawer focus acquired by pending Tab in ${locale}`, async context => {
    const dom = new JSDOM('<button id="opener">Fields</button><div id="mount"></div>', { url: 'http://localhost' })
    const { document } = dom.window
    const originals = new Map<string, PropertyDescriptor | undefined>()
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    for (const [key, value] of Object.entries({ window: dom.window, document, navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId },
      cancelAnimationFrame: (id: number) => frames.delete(id) })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, { configurable: true, value })
    }
    // JSDOM has no layout or OS foreground. Focus and blur themselves remain native.
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
    const prototype = dom.window.HTMLElement.prototype
    const rectsDescriptor = Object.getOwnPropertyDescriptor(prototype, 'getClientRects')
    Object.defineProperty(prototype, 'getClientRects', { configurable: true, value: function (this: HTMLElement) {
      return (this.isConnected && !this.closest('[hidden], [inert], [aria-hidden="true"]')
        ? [new dom.window.DOMRect(0, 0, 120, 32)] : []) as unknown as DOMRectList
    } })
    const nativeFocus = prototype.focus
    const focusCalls: HTMLElement[] = []
    prototype.focus = function (options?: FocusOptions) {
      focusCalls.push(this)
      nativeFocus.call(this, options)
    }
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(document.getElementById('mount')!)
    const config = { fieldOrder: ['owner', 'stage'], visibleFieldIds: ['owner', 'stage'], query: 'Keep query' }
    const configBefore = structuredClone(config)
    let storedFields = structuredClone(originalFields)
    const renames: { fieldId: string; name: string }[] = []
    let otherActions = 0
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    function Harness() {
      const [fields, setFields] = useState(storedFields)
      return createElement(DatabaseFieldDrawer, {
        fields, fieldOrder: config.fieldOrder, visibleFieldIds: config.visibleFieldIds,
        open: true, sourceSessionKey: 'isolated-custom-source', text: getDatabaseWorkspaceText(locale),
        onClose: () => { otherActions++ }, onDeleteField: () => { otherActions++ },
        onMoveField: () => { otherActions++ }, onToggleField: () => { otherActions++ },
        onCreateField: async () => { otherActions++; return true },
        onMoveDatabaseField: async () => { otherActions++; return true },
        onUpdateOptions: async () => { otherActions++; return true },
        onRenameField: async (fieldId, name) => {
          renames.push({ fieldId, name })
          await pending
          // A real callback outcome updates the server fixture and published field props.
          storedFields = storedFields.map(field => field.id === fieldId ? { ...field, name } : field)
          setFields(storedFields)
          return true
        }
      })
    }
    const activeDescription = () => {
      const active = document.activeElement
      return { tag: active?.tagName, label: active?.getAttribute('aria-label'), className: active?.getAttribute('class') }
    }
    try {
      await act(async () => root.render(createElement(Harness)))
      await act(async () => {
        const initialFrames = [...frames.values()]
        frames.clear()
        initialFrames.forEach(callback => callback(0))
      })
      const row = document.querySelector<HTMLElement>('.dbw-field-row')!
      await act(async () => row.querySelector<HTMLButtonElement>('.dbw-field-name')!.click())
      const input = row.querySelector<HTMLInputElement>('.dbw-field-copy input:not(.dbw-field-options)')!
      await act(async () => input.focus())
      assert.equal(document.activeElement === input, true)
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '  Accepted owner  ')
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      await act(async () => input.dispatchEvent(enter))
      const drawer = document.querySelector<HTMLElement>('.dbw-field-drawer')!
      assert.equal(enter.defaultPrevented, true)
      assert.deepEqual(renames, [{ fieldId: 'owner', name: 'Accepted owner' }])
      assert.equal(drawer.getAttribute('aria-busy'), 'true')
      assert.equal(input.disabled, true)
      assert.equal([...drawer.querySelectorAll('button, input, select, textarea')].every(control => control.matches(':disabled')), true)
      assert.deepEqual(storedFields, originalFields)
      const beforeTab = activeDescription()
      // JSDOM does not traverse Tab stops. The actual all-disabled drawer trap handles
      // this bubbling key and calls native aside.focus(); the test never focuses aside.
      const tab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      await act(async () => document.activeElement!.dispatchEvent(tab))
      assert.equal(tab.defaultPrevented, true)
      assert.equal(document.activeElement === drawer, true)
      const pendingFocus = activeDescription()
      focusCalls.length = 0
      await act(async () => release())
      const completedFocus = activeDescription()
      const fieldFocusCalls = focusCalls.filter(element => element === input || element.matches('.dbw-field-name')).length
      context.diagnostic(JSON.stringify({ locale, beforeTab, pendingFocus, completedFocus, fieldFocusCalls, renames }))
      assert.equal(drawer.getAttribute('aria-busy'), 'false')
      assert.equal(row.querySelector('.dbw-field-name')?.textContent, 'Accepted owner')
      assert.deepEqual(storedFields, originalFields.map(field => field.id === 'owner' ? { ...field, name: 'Accepted owner' } : field))
      assert.deepEqual(config, configBefore)
      assert.equal(otherActions, 0)
      assert.equal(document.activeElement === drawer, true, 'a newer Tab owner must keep focus after the rename completes')
      assert.equal(fieldFocusCalls, 0, 'completion must not attempt to focus the old editor or refreshed name button')
      assert.equal(renames.length, 1)
    } finally {
      await act(async () => release())
      await act(async () => root.unmount())
      prototype.focus = nativeFocus
      if (rectsDescriptor) Object.defineProperty(prototype, 'getClientRects', rectsDescriptor)
      else Reflect.deleteProperty(prototype, 'getClientRects')
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
      dom.window.close()
    }
  })
}

type Outcome = true | false | 'throw'
type RenameRequest = {
  source: string; fieldId: string; name: string; settled: boolean
  resolve: (success: boolean) => void; reject: (reason: unknown) => void
}
type FocusCall = { element: HTMLElement; disabled: boolean; busy: string | null; activeAfter: boolean; options?: FocusOptions }

async function withAttentionDrawer(run: (context: {
  document: Document; window: JSDOM['window']; text: ReturnType<typeof getDatabaseWorkspaceText>
  requests: RenameRequest[]; focusCalls: FocusCall[]; drawer: () => HTMLElement; row: () => HTMLElement
  edit: (raw?: string) => Promise<HTMLInputElement>; enter: (input: HTMLInputElement) => Promise<void>
  key: (key: string) => Promise<KeyboardEvent>; finish: (index: number, outcome: Outcome) => Promise<void>
  setForeground: (value: boolean) => void; switchSource: (source: 'A' | 'B') => Promise<void>
  detach: () => Promise<void>; reopen: () => Promise<void>; repaint: () => Promise<void>; flushFrames: () => Promise<void>
  stored: (source?: 'A' | 'B') => DatabaseField[]; writes: () => number; assertConfiguration: () => void
}) => Promise<void>, locale = 'en-US') {
  const dom = new JSDOM('<button id="opener">Fields</button><input id="reader" aria-label="Outside reader"><div id="mount"></div>', { url: 'http://localhost' })
  const { document } = dom.window
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  for (const [key, value] of Object.entries({ window: dom.window, document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId },
    cancelAnimationFrame: (id: number) => frames.delete(id) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  let foreground = true
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => foreground })
  const prototype = dom.window.HTMLElement.prototype
  const rectsDescriptor = Object.getOwnPropertyDescriptor(prototype, 'getClientRects')
  Object.defineProperty(prototype, 'getClientRects', { configurable: true, value: function (this: HTMLElement) {
    return (this.isConnected && !this.closest('[hidden], [inert], [aria-hidden="true"]')
      ? [new dom.window.DOMRect(0, 0, 120, 32)] : []) as unknown as DOMRectList
  } })
  const nativeFocus = prototype.focus
  const focusCalls: FocusCall[] = []
  prototype.focus = function (options?: FocusOptions) {
    const call: FocusCall = { element: this, disabled: this.matches(':disabled, [aria-disabled="true"]'),
      busy: this.closest('.dbw-field-drawer')?.getAttribute('aria-busy') ?? null, activeAfter: false, options }
    focusCalls.push(call)
    nativeFocus.call(this, options)
    call.activeAfter = document.activeElement === this
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('mount')!)
  const text = getDatabaseWorkspaceText(locale)
  const config = { fieldOrder: ['owner', 'stage'], visibleFieldIds: ['owner', 'stage'], query: 'Keep query' }
  const configBefore = structuredClone(config)
  const storage = { A: structuredClone(originalFields), B: originalFields.map(field => ({ ...structuredClone(field), name: 'B ' + field.name })) }
  const requests: RenameRequest[] = []
  let source: 'A' | 'B' = 'A', generation = 0, instance = 0, attached = true, writes = 0, otherActions = 0
  const publish = () => {
    const acceptedSource = source, acceptedGeneration = generation, acceptedInstance = instance
    root.render(attached ? createElement(DatabaseFieldDrawer, {
      key: instance, fields: storage[source], fieldOrder: config.fieldOrder, visibleFieldIds: config.visibleFieldIds,
      open: true, sourceSessionKey: source, text,
      onClose: () => { otherActions++ }, onDeleteField: () => { otherActions++ },
      onMoveField: () => { otherActions++ }, onToggleField: () => { otherActions++ },
      onCreateField: async () => { otherActions++; return true },
      onMoveDatabaseField: async () => { otherActions++; return true },
      onUpdateOptions: async () => { otherActions++; return true },
      onRenameField: async (fieldId, name) => {
        let resolve!: (success: boolean) => void, reject!: (reason: unknown) => void
        const pending = new Promise<boolean>((yes, no) => { resolve = yes; reject = no })
        const request = { source: acceptedSource, fieldId, name, resolve, reject, settled: false }
        requests.push(request)
        try {
          const success = await pending
          if (success) {
            writes++
            storage[acceptedSource] = storage[acceptedSource].map(field => field.id === fieldId ? { ...field, name } : field)
            // Publish only to the still-current UI, as a source-scoped server refresh would.
            if (attached && source === acceptedSource && generation === acceptedGeneration && instance === acceptedInstance) publish()
          }
          return success
        } finally { request.settled = true }
      }
    }) : null)
  }
  const drawer = () => document.querySelector<HTMLElement>('.dbw-field-drawer')!
  const row = () => document.querySelector<HTMLElement>('.dbw-field-row')!
  const flushFrames = async () => {
    await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) })
  }
  const enter = async (input: HTMLInputElement) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => input.dispatchEvent(event))
    assert.equal(event.defaultPrevented, true)
    assert.equal(input.disabled, true)
    assert.equal(drawer().getAttribute('aria-busy'), 'true')
  }
  try {
    await act(async () => publish())
    await flushFrames()
    await run({ document, window: dom.window, text, requests, focusCalls, drawer, row, enter,
      edit: async (raw = '  Accepted owner  ') => {
        await act(async () => row().querySelector<HTMLButtonElement>('.dbw-field-name')!.click())
        const input = row().querySelector<HTMLInputElement>('.dbw-field-copy > input:not(.dbw-field-options)')!
        assert.equal(document.activeElement === input, true)
        await act(async () => {
          Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, raw)
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })
        return input
      },
      key: async key => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        await act(async () => document.activeElement!.dispatchEvent(event))
        return event
      },
      finish: async (index, outcome) => {
        await act(async () => outcome === 'throw' ? requests[index].reject(new Error('Private write failure')) : requests[index].resolve(outcome))
        assert.equal(requests[index].settled, true)
      },
      setForeground: value => { foreground = value },
      switchSource: async next => { source = next; generation++; await act(async () => publish()) },
      detach: async () => { attached = false; generation++; await act(async () => publish()) },
      reopen: async () => { attached = true; instance++; generation++; await act(async () => publish()); await flushFrames() },
      repaint: async () => { await act(async () => publish()) }, flushFrames,
      stored: (key = 'A') => structuredClone(storage[key]), writes: () => writes,
      assertConfiguration: () => {
        assert.deepEqual(config, configBefore)
        assert.equal(otherActions, 0)
        for (const key of ['A', 'B'] as const) {
          const expected = originalFields.map(field => ({ ...field, name: key === 'A' ? field.name : 'B ' + field.name }))
          assert.deepEqual(storage[key].map(field => field.id === 'owner' ? { ...field, name: expected[0].name } : field), expected)
        }
      }
    })
  } finally {
    await act(async () => { for (const request of requests) if (!request.settled) request.resolve(false) })
    await act(async () => root.unmount())
    prototype.focus = nativeFocus
    if (rectsDescriptor) Object.defineProperty(prototype, 'getClientRects', rectsDescriptor)
    else Reflect.deleteProperty(prototype, 'getClientRects')
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

// The label remains on a removed input, so an illegal late focus attempt is counted too.
const fieldFocusCalls = (calls: FocusCall[]) => calls.filter(call => call.element.matches('.dbw-field-name')
  || (call.element.tagName === 'INPUT' && call.element.getAttribute('aria-label')?.includes(' · ')))
const assertEnabledRestore = (call: FocusCall) => {
  assert.equal(call.disabled, false)
  assert.equal(call.busy, 'false')
  assert.equal(call.activeAfter, true)
  assert.equal(call.options?.preventScroll, true)
}

test('uninterrupted successful Enter restores the refreshed enabled name button exactly once', async () => {
  for (const locale of ['en-US', 'zh-CN']) await withAttentionDrawer(async fixture => {
    const input = await fixture.edit()
    await fixture.enter(input)
    assert.deepEqual(fixture.requests.map(({ fieldId, name }) => ({ fieldId, name })), [{ fieldId: 'owner', name: 'Accepted owner' }])
    fixture.focusCalls.length = 0
    await fixture.finish(0, true)
    const button = fixture.row().querySelector<HTMLButtonElement>('.dbw-field-name')!
    assert.equal(fixture.document.activeElement === button, true)
    assert.equal(button.textContent, 'Accepted owner')
    assert.equal(input.isConnected, false)
    const calls = fieldFocusCalls(fixture.focusCalls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].element === button, true)
    assertEnabledRestore(calls[0])
    await fixture.repaint()
    await fixture.flushFrames()
    assert.equal(fieldFocusCalls(fixture.focusCalls).length, 1)
    assert.equal(fixture.writes(), 1)
    fixture.assertConfiguration()
  }, locale)
})

test('false and rejected Enter retain the same draft input, restore once, and accept immediate keyboard retry', async () => {
  for (const locale of ['en-US', 'zh-CN']) for (const outcome of [false, 'throw'] as const) {
    await withAttentionDrawer(async fixture => {
      const input = await fixture.edit()
      await fixture.enter(input)
      fixture.focusCalls.length = 0
      await fixture.finish(0, outcome)
      assert.equal(fixture.row().querySelector('.dbw-field-copy > input') === input, true)
      assert.equal(fixture.document.activeElement === input, true)
      assert.equal(input.value, '  Accepted owner  ')
      assert.equal(input.disabled, false)
      assert.equal(fixture.row().querySelector('[role="alert"]')?.textContent, fixture.text.failed)
      assert.equal(fixture.document.body.textContent!.includes('Private write failure'), false)
      assert.deepEqual(fixture.stored(), originalFields)
      const calls = fieldFocusCalls(fixture.focusCalls)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].element === input, true)
      assertEnabledRestore(calls[0])
      // No click or corrective focus is needed: the failed editor owns the real Enter.
      await fixture.enter(input)
      assert.equal(fixture.requests.length, 2)
      assert.deepEqual(fixture.requests.map(({ fieldId, name }) => ({ fieldId, name })), [
        { fieldId: 'owner', name: 'Accepted owner' }, { fieldId: 'owner', name: 'Accepted owner' }
      ])
      fixture.focusCalls.length = 0
      await fixture.finish(1, true)
      assert.equal(fixture.document.activeElement === fixture.row().querySelector('.dbw-field-name'), true)
      assert.equal(fieldFocusCalls(fixture.focusCalls).length, 1)
      assertEnabledRestore(fieldFocusCalls(fixture.focusCalls)[0])
      assert.equal(fixture.row().querySelectorAll('[role="alert"]').length, 0)
      assert.equal(fixture.writes(), 1)
      fixture.assertConfiguration()
    }, locale)
  }
})

test('new pending keyboard, pointer, IME, focus-to-BODY and window blur permanently abandon the old restoration', async context => {
  const activities: { kind: string; outcome: Outcome }[] = [
    { kind: 'tab', outcome: false }, { kind: 'key', outcome: false }, { kind: 'pointer', outcome: true },
    { kind: 'composition', outcome: 'throw' }, { kind: 'outside-focus-body', outcome: true },
    { kind: 'drawer-focus-body', outcome: false }, { kind: 'window-blur', outcome: true }
  ]
  for (const activity of activities) await withAttentionDrawer(async fixture => {
    const input = await fixture.edit()
    await fixture.enter(input)
    if (activity.kind === 'tab') {
      assert.equal((await fixture.key('Tab')).defaultPrevented, true)
      assert.equal(fixture.document.activeElement === fixture.drawer(), true)
    } else if (activity.kind === 'key') await fixture.key('ArrowRight')
    else if (activity.kind === 'pointer') await act(async () => input.dispatchEvent(new fixture.window.MouseEvent('pointerdown', { bubbles: true, button: 0 })))
    else if (activity.kind === 'composition') await act(async () => input.dispatchEvent(new fixture.window.CompositionEvent('compositionstart', { bubbles: true })))
    else if (activity.kind === 'outside-focus-body') await act(async () => {
      const reader = fixture.document.getElementById('reader')!
      reader.focus()
      assert.equal(fixture.document.activeElement === reader, true)
      reader.blur()
    })
    else if (activity.kind === 'drawer-focus-body') {
      await fixture.key('Tab')
      await act(async () => fixture.drawer().blur())
    } else await act(async () => {
      fixture.setForeground(false)
      fixture.window.dispatchEvent(new fixture.window.Event('blur'))
      fixture.setForeground(true)
      fixture.window.dispatchEvent(new fixture.window.Event('focus'))
    })
    const owner = fixture.document.activeElement
    if (activity.kind !== 'tab') assert.equal(owner === fixture.document.body, true, activity.kind)
    fixture.focusCalls.length = 0
    await fixture.finish(0, activity.outcome)
    context.diagnostic(JSON.stringify({ activity, activeTag: fixture.document.activeElement?.tagName, fieldFocusCalls: fieldFocusCalls(fixture.focusCalls).length }))
    assert.equal(fixture.document.activeElement === owner, true, activity.kind)
    assert.equal(fieldFocusCalls(fixture.focusCalls).length, 0, activity.kind)
    assert.equal(fixture.requests.length, 1)
    assert.equal(fixture.drawer().getAttribute('aria-busy'), 'false')
    if (activity.outcome === true) {
      assert.equal(fixture.row().querySelector('.dbw-field-name')?.textContent, 'Accepted owner')
      assert.equal(fixture.writes(), 1)
    } else {
      assert.equal(fixture.row().querySelector('.dbw-field-copy > input') === input, true)
      assert.equal(input.value, '  Accepted owner  ')
      assert.equal(input.disabled, false)
      assert.equal(fixture.row().querySelector('[role="alert"]')?.textContent, fixture.text.failed)
      assert.equal(fixture.writes(), 0)
      assert.deepEqual(fixture.stored(), originalFields)
    }
    await fixture.repaint()
    await fixture.flushFrames()
    assert.equal(fieldFocusCalls(fixture.focusCalls).length, 0)
    fixture.assertConfiguration()
  })
})

test('completion requires a foreground visible enabled target and no foreign modal, without later resurrection', async () => {
  for (const guard of ['foreign-modal', 'background', 'hidden-row', 'inert-row', 'disabled-input'] as const) {
    await withAttentionDrawer(async fixture => {
      const input = await fixture.edit()
      await fixture.enter(input)
      const row = fixture.row()
      let modal: HTMLElement | null = null
      if (guard === 'foreign-modal') {
        modal = fixture.document.createElement('div')
        modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true')
        fixture.document.body.append(modal)
      } else if (guard === 'background') fixture.setForeground(false)
      else if (guard === 'hidden-row') row.hidden = true
      else if (guard === 'inert-row') row.setAttribute('inert', '')
      else input.setAttribute('aria-disabled', 'true')
      fixture.focusCalls.length = 0
      const outcome = guard === 'hidden-row' || guard === 'foreign-modal'
      await fixture.finish(0, outcome)
      assert.equal(fixture.document.activeElement === fixture.document.body, true, guard)
      assert.equal(fieldFocusCalls(fixture.focusCalls).length, 0, guard)
      assert.equal(fixture.requests.length, 1)
      assert.equal(fixture.drawer().getAttribute('aria-busy'), 'false')
      if (!outcome) {
        assert.equal(input.value, '  Accepted owner  ')
        assert.equal(fixture.row().querySelector('.dbw-field-copy > input') === input, true)
        assert.equal(row.querySelector('[role="alert"]')?.textContent, fixture.text.failed)
        assert.deepEqual(fixture.stored(), originalFields)
      }
      modal?.remove(); row.hidden = false; row.removeAttribute('inert'); input.removeAttribute('aria-disabled')
      fixture.setForeground(true)
      await fixture.repaint()
      await fixture.flushFrames()
      assert.equal(fieldFocusCalls(fixture.focusCalls).length, 0, guard)
      assert.equal(fixture.document.activeElement === fixture.document.body, true)
      fixture.assertConfiguration()
    })
  }
})

test('source A to B to A cannot let an old reply focus or unlock the fresh rename', async () => {
  for (const outcome of [true, false, 'throw'] as const) await withAttentionDrawer(async fixture => {
    const oldInput = await fixture.edit('Old source request')
    await fixture.enter(oldInput)
    await fixture.switchSource('B')
    assert.equal(fixture.row().querySelector('.dbw-field-name')?.textContent, 'B Owner')
    await fixture.switchSource('A')
    assert.equal(oldInput.isConnected, false)
    const freshInput = await fixture.edit('Fresh source draft')
    await fixture.enter(freshInput)
    fixture.focusCalls.length = 0
    await fixture.finish(0, outcome)
    assert.equal(fixture.drawer().getAttribute('aria-busy'), 'true')
    assert.equal(freshInput.disabled, true)
    assert.equal(freshInput.value, 'Fresh source draft')
    assert.equal(fixture.row().querySelector('.dbw-field-copy > input') === freshInput, true)
    assert.equal(fixture.row().querySelectorAll('[role="alert"]').length, 0)
    assert.equal(fieldFocusCalls(fixture.focusCalls).length, 0)
    assert.equal(fixture.requests.length, 2)
    assert.deepEqual(fixture.requests.map(({ source, fieldId, name }) => ({ source, fieldId, name })), [
      { source: 'A', fieldId: 'owner', name: 'Old source request' }, { source: 'A', fieldId: 'owner', name: 'Fresh source draft' }
    ])
    await fixture.finish(1, false)
    assert.equal(fixture.document.activeElement === freshInput, true)
    assert.equal(freshInput.value, 'Fresh source draft')
    assert.equal(fixture.row().querySelector('[role="alert"]')?.textContent, fixture.text.failed)
    assert.equal(fixture.writes(), outcome === true ? 1 : 0)
    assert.equal(fixture.stored('B')[0].name, 'B Owner')
    fixture.assertConfiguration()
  })
})

test('unmount and reopen isolate late success or failure from the new input and its accepted request', async () => {
  for (const outcome of [true, false, 'throw'] as const) await withAttentionDrawer(async fixture => {
    const oldInput = await fixture.edit('Unmounted request')
    await fixture.enter(oldInput)
    await fixture.detach()
    await fixture.reopen()
    assert.equal(oldInput.isConnected, false)
    const freshInput = await fixture.edit('Reopened draft')
    await fixture.enter(freshInput)
    fixture.focusCalls.length = 0
    await fixture.finish(0, outcome)
    await fixture.flushFrames()
    assert.equal(fixture.drawer().getAttribute('aria-busy'), 'true')
    assert.equal(freshInput.disabled, true)
    assert.equal(freshInput.value, 'Reopened draft')
    assert.equal(fixture.row().querySelector('.dbw-field-copy > input') === freshInput, true)
    assert.equal(fixture.row().querySelectorAll('[role="alert"]').length, 0)
    assert.equal(fieldFocusCalls(fixture.focusCalls).length, 0)
    assert.equal(fixture.requests.length, 2)
    assert.deepEqual(fixture.requests.map(({ source, fieldId, name }) => ({ source, fieldId, name })), [
      { source: 'A', fieldId: 'owner', name: 'Unmounted request' }, { source: 'A', fieldId: 'owner', name: 'Reopened draft' }
    ])
    await fixture.finish(1, true)
    const button = fixture.row().querySelector('.dbw-field-name')!
    assert.equal(fixture.document.activeElement === button, true)
    assert.equal(button.textContent, 'Reopened draft')
    assert.equal(fieldFocusCalls(fixture.focusCalls).length, 1)
    assertEnabledRestore(fieldFocusCalls(fixture.focusCalls)[0])
    assert.equal(fixture.writes(), outcome === true ? 2 : 1)
    assert.equal(fixture.stored()[0].name, 'Reopened draft')
    fixture.assertConfiguration()
  })
})
