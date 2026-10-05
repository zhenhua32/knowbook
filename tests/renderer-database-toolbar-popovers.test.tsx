import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { act, createElement, useState, type ComponentProps, type Dispatch, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseField, DatabaseRecord, DatabaseViewConfigV1 } from '../src/shared/contracts'
import { areDatabaseViewConfigsEqual, cloneDatabaseViewConfig, createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { DatabaseViewToolbar } from '../src/renderer/src/features/database/components/DatabaseViewToolbar'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { applyDatabaseView } from '../src/renderer/src/features/database/model/databaseFilters'
import { waitForRenderer } from './helpers/renderer-async'

type Locale = 'en-US' | 'zh-CN'
type Kind = 'filter' | 'sort'
const fields: DatabaseField[] = [
  { id: '__title__', name: 'Title', type: 'text', role: 'title', options: [], editable: true, hideable: false, deletable: false, sortOrder: 0 },
  { id: 'notes', name: 'Notes', type: 'text', role: 'property', options: [], editable: true, hideable: true, deletable: true, sortOrder: 1 }
]
const records: DatabaseRecord[] = [
  { id: 'alpha', databaseId: 'archive', documentId: null, title: 'Alpha', fieldValues: { notes: 'Original notes', hidden: 'Keep metadata' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' },
  { id: 'beta', databaseId: 'archive', documentId: null, title: 'Beta', fieldValues: { notes: 'Secondary notes' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' }
]
const initial = createDefaultDatabaseViewConfig('table', fields.map(field => field.id))
initial.query = ' Alpha '
initial.filters = { operator: 'and', rules: [{ id: 'original-filter', fieldId: 'notes', operator: 'contains', value: 'Original' }] }
initial.sorts = [{ fieldId: '__title__', direction: 'asc' }]
type Snapshot = {
  draft: DatabaseViewConfigV1; saved: DatabaseViewConfigV1; fields: DatabaseField[]; records: DatabaseRecord[]
  callbacks: { change: number; save: number; reset: number; saveAs: number; fields: number }; results: string
}
type Context = {
  document: Document; window: JSDOM['window']; focusCalls: HTMLElement[]
  menu: (kind: Kind) => HTMLDetailsElement; summary: (kind: Kind) => HTMLElement; control: (kind: Kind) => HTMLElement
  open: (kind: Kind) => Promise<void>; change: (callback: () => void) => Promise<void>
  key: (target: Element, init?: KeyboardEventInit, prevented?: boolean) => Promise<KeyboardEvent>
  fill: (raw: string) => Promise<void>; chooseSort: (direction: string) => Promise<void>
  snapshot: () => Snapshot; assertPreserved: (before: Snapshot) => void
  foreground: (value: boolean) => void; scope: (value: unknown) => Promise<void>; show: (value: boolean) => Promise<void>
}

async function withToolbar(locale: Locale, run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const { document } = dom.window
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  let foreground = true
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => foreground })
  // Geometry and dialog top-layer APIs are unavailable in JSDOM. Focus is native.
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(20, 20, 320, 40) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    if (!this.isConnected) return [] as unknown as DOMRectList
    let ancestor: HTMLElement | null = this
    while (ancestor) {
      const style = dom.window.getComputedStyle(ancestor)
      if (ancestor.hidden || ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || style.visibility === 'hidden'
        || ancestor instanceof dom.window.HTMLDialogElement && !ancestor.open
        || ancestor instanceof dom.window.HTMLDetailsElement && !ancestor.open && ancestor !== this
          && this.closest('summary')?.parentElement !== ancestor) return [] as unknown as DOMRectList
      ancestor = ancestor.parentElement
    }
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  }
  const focusCalls: HTMLElement[] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) { focusCalls.push(this); nativeFocus.call(this, options) }
  const source = structuredClone({ fields, records }), originalSource = structuredClone(source)
  const saved = cloneDatabaseViewConfig(initial), originalSaved = cloneDatabaseViewConfig(saved)
  const callbacks = { change: 0, save: 0, reset: 0, saveAs: 0, fields: 0 }
  let current!: DatabaseViewConfigV1
  let setScope!: Dispatch<SetStateAction<unknown>>, setShown!: Dispatch<SetStateAction<boolean>>
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const flushRendererWork = async () => { await act(async () => { await setImmediate() }); await act(async () => { await setImmediate() }) }
  function Harness() {
    const [draft, updateDraft] = useState(() => cloneDatabaseViewConfig(saved))
    const [scopeKey, updateScope] = useState<unknown>({ source: 'archive', view: 'primary' })
    const [shown, updateShown] = useState(true)
    current = draft; setScope = updateScope; setShown = updateShown
    // A named props value remains compatible with the old component at RED time.
    // scopeKey is the planned public prop, not a forced React remount/key.
    const props: ComponentProps<typeof DatabaseViewToolbar> & { scopeKey?: unknown } = {
      config: draft, fields: source.fields, text: getDatabaseWorkspaceText(locale), scopeKey,
      dirty: !areDatabaseViewConfigsEqual(draft, saved), recordCount: applyDatabaseView(source.records, source.fields, draft.query, draft.filters, draft.sorts).length,
      onChange: updater => { callbacks.change++; updateDraft(updater) },
      onSave: () => { callbacks.save++ }, onReset: () => { callbacks.reset++; updateDraft(cloneDatabaseViewConfig(saved)) },
      onSaveAs: () => { callbacks.saveAs++ }, onOpenFields: () => { callbacks.fields++ }
    }
    return createElement('div', null, shown ? createElement(DatabaseViewToolbar, props) : null,
      createElement('input', { id: 'outside', defaultValue: 'Keep external draft' }),
      createElement('output', { id: 'results' }, applyDatabaseView(source.records, source.fields, draft.query, draft.filters, draft.sorts).map(record => record.id).join(',')))
  }
  const menu = (kind: Kind) => {
    const element = document.querySelectorAll<HTMLDetailsElement>('.dbw-toolbar-menu')[kind === 'filter' ? 0 : 1]
    assert.ok(element); return element
  }
  const summary = (kind: Kind) => { const element = menu(kind).querySelector<HTMLElement>('summary'); assert.ok(element); return element }
  const control = (kind: Kind) => {
    const element = menu(kind).querySelector<HTMLElement>(kind === 'filter' ? '.dbw-filter-row input' : '.dbw-config-row select')
    assert.ok(element); return element
  }
  const snapshot = (): Snapshot => structuredClone({ draft: current, saved, fields: source.fields, records: source.records,
    callbacks, results: document.querySelector('#results')?.textContent ?? '' })
  const assertPreserved = (before: Snapshot) => {
    assert.deepEqual(snapshot(), before, 'Dismissal must preserve local query/filter/sort drafts and all action callbacks')
    assert.deepEqual(source, originalSource)
    assert.deepEqual(saved, originalSaved)
    assert.deepEqual({ save: callbacks.save, reset: callbacks.reset, saveAs: callbacks.saveAs, fields: callbacks.fields },
      { save: 0, reset: 0, saveAs: 0, fields: 0 }, 'Browsing/dismissal must not perform persistence or other actions')
  }
  try {
    await change(() => root.render(createElement(Harness)))
    await flushRendererWork()
    await run({ document, window: dom.window, focusCalls, menu, summary, control, change, snapshot, assertPreserved,
      foreground: value => { foreground = value }, scope: value => change(() => setScope(value)), show: value => change(() => setShown(value)),
      open: async kind => {
        await change(() => { summary(kind).focus(); summary(kind).click() })
        await waitForRenderer(() => menu(kind).open, 'Actual summary click must open the native details')
      },
      key: async (target, init = {}, prevented = false) => {
        const event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })
        if (prevented) event.preventDefault()
        await change(() => target.dispatchEvent(event))
        await flushRendererWork()
        return event as unknown as KeyboardEvent
      },
      fill: raw => change(() => {
        const input = control('filter') as HTMLInputElement
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, raw)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }),
      chooseSort: direction => change(() => {
        const select = menu('sort').querySelectorAll<HTMLSelectElement>('.dbw-config-row select')[1]
        select.value = direction; select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
    })
  } finally {
    await act(async () => root.unmount())
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

for (const locale of ['en-US', 'zh-CN'] as const) for (const kind of ['filter', 'sort'] as const) {
  test(`${kind} toolbar Escape closes and returns to its stable summary in ${locale}`, async testContext => {
    await withToolbar(locale, async context => {
      await context.open(kind)
      const menu = context.menu(kind), summary = context.summary(kind), owner = context.control(kind)
      await context.change(() => owner.focus())
      if (kind === 'filter') await context.fill('Original draft')
      else await context.chooseSort('desc')
      assert.equal(context.document.activeElement === owner, true)
      const before = context.snapshot()
      context.focusCalls.length = 0
      const event = await context.key(owner)
      testContext.diagnostic(JSON.stringify({ locale, kind, open: menu.open, activeTag: context.document.activeElement?.tagName,
        defaultPrevented: event.defaultPrevented, focusCalls: context.focusCalls.map(element => element.tagName), draft: context.snapshot().draft }))
      // Preserve four independent old-source business RED oracles.
      assert.equal(menu.open, false, 'Escape must close the native toolbar details')
      assert.equal(context.document.activeElement === summary, true)
      assert.equal(context.summary(kind) === summary, true)
      assert.equal(context.focusCalls.filter(element => element === summary).length, 1)
      assert.equal(event.defaultPrevented, true)
      context.assertPreserved(before)
      await context.open(kind)
      context.focusCalls.length = 0
      await context.key(summary)
      assert.equal(menu.open, false)
      assert.equal(context.document.activeElement === summary, true)
      assert.equal(context.focusCalls.length, 0, 'A focused summary must not receive a redundant focus call')
      context.assertPreserved(before)
    })
  })
}

test('toolbar Escape respects three IME sources, lifecycle blur reset and already-prevented keys', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) for (const kind of ['filter', 'sort'] as const) {
    await withToolbar(locale, async context => {
      for (const init of [{ isComposing: true }, { keyCode: 229 }] as KeyboardEventInit[]) {
        await context.open(kind)
        const owner = context.control(kind)
        await context.change(() => owner.focus())
        context.focusCalls.length = 0
        const before = context.snapshot(), event = await context.key(owner, init)
        assert.equal(context.menu(kind).open, true)
        assert.equal(event.defaultPrevented, false)
        assert.equal(context.document.activeElement === owner, true)
        assert.equal(context.focusCalls.length, 0)
        context.assertPreserved(before)
        await context.key(owner)
        assert.equal(context.menu(kind).open, false)
      }
      await context.open(kind)
      const owner = context.control(kind)
      await context.change(() => { owner.focus(); owner.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true })) })
      const before = context.snapshot()
      context.focusCalls.length = 0
      await context.key(owner)
      assert.equal(context.menu(kind).open, true)
      assert.equal(context.focusCalls.length, 0)
      await context.change(() => owner.dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true })))
      const prevented = await context.key(owner, {}, true)
      assert.equal(prevented.defaultPrevented, true)
      assert.equal(context.menu(kind).open, true)
      await context.key(owner)
      assert.equal(context.menu(kind).open, false)
      context.assertPreserved(before)
      await context.open(kind)
      await context.change(() => { owner.focus(); owner.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true })) })
      // Native focus moves inside this same menu: it resets composition but must not dismiss it.
      const other = context.menu(kind).querySelector<HTMLButtonElement>('.dbw-add-config-row')!
      await context.change(() => other.focus())
      assert.equal(context.menu(kind).open, true)
      await context.key(other)
      assert.equal(context.menu(kind).open, false)
      context.assertPreserved(before)
    })
  }
})

test('outside pointer and real external focus dismiss toolbar popovers without returning focus; internal pointer does not', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) for (const kind of ['filter', 'sort'] as const) {
    await withToolbar(locale, async context => {
      await context.open(kind)
      const owner = context.control(kind), summary = context.summary(kind)
      await context.change(() => owner.focus())
      const before = context.snapshot()
      context.focusCalls.length = 0
      const internal = new context.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
      await context.change(() => owner.dispatchEvent(internal))
      assert.equal(context.menu(kind).open, true)
      assert.equal(internal.defaultPrevented, false)
      assert.equal(context.focusCalls.length, 0)
      const outside = context.document.querySelector<HTMLInputElement>('#outside')!
      const pointer = new context.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
      await context.change(() => outside.dispatchEvent(pointer))
      await waitForRenderer(() => !context.menu(kind).open, 'Outside pointerdown must dismiss the menu')
      assert.equal(pointer.defaultPrevented, false)
      assert.equal(context.focusCalls.filter(element => element === summary).length, 0)
      await context.change(() => outside.focus())
      assert.equal(context.document.activeElement === outside, true)
      assert.equal(outside.value, 'Keep external draft')
      context.assertPreserved(before)
      await context.open(kind)
      await context.change(() => owner.focus())
      context.focusCalls.length = 0
      await context.change(() => outside.focus())
      await waitForRenderer(() => !context.menu(kind).open, 'Actual focus leaving the menu must dismiss it')
      assert.equal(context.document.activeElement === outside, true)
      assert.equal(context.focusCalls.filter(element => element === summary).length, 0)
      context.assertPreserved(before)
    })
  }
})

test('actual summary activations make toolbar menus mutually exclusive while preserving edited draft controls', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withToolbar(locale, async context => {
    await context.open('filter')
    const input = context.control('filter') as HTMLInputElement
    await context.change(() => input.focus())
    await context.fill('Draft notes')
    const before = context.snapshot()
    // JSDOM .click activates native details without synthesizing pointer focus.
    // Thus this proves mutual exclusion independently of the focus-out close path.
    await context.change(() => context.summary('sort').click())
    await waitForRenderer(() => context.menu('sort').open && !context.menu('filter').open, 'Opening Sort must close Filter')
    await context.change(() => context.summary('filter').click())
    await waitForRenderer(() => context.menu('filter').open && !context.menu('sort').open, 'Opening Filter must close Sort')
    assert.equal(context.control('filter') === input, true)
    assert.equal(input.value, 'Draft notes')
    context.assertPreserved(before)
  })
})

test('toolbar scope replacement and unavailable return owners close without stealing focus or replaying cleanup', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) for (const kind of ['filter', 'sort'] as const) {
    await withToolbar(locale, async context => {
      const before = context.snapshot()
      for (const scopeKey of [{ source: 'second', view: 'primary' }, { source: 'second', view: 'other' }, { source: 'archive', view: 'primary' }]) {
        await context.open(kind)
        const summary = context.summary(kind)
        await context.change(() => context.control(kind).focus())
        context.focusCalls.length = 0
        await context.scope(scopeKey)
        await waitForRenderer(() => !context.menu('filter').open && !context.menu('sort').open, 'A new source/view session must close both menus')
        assert.equal(context.summary(kind) === summary, true, 'Session replacement must use the same Toolbar DOM, not a forced remount')
        assert.equal(context.focusCalls.length, 0)
        context.assertPreserved(before)
      }
      for (const guard of ['background', 'hidden-summary', 'foreign-modal'] as const) {
        await context.open(kind)
        const summary = context.summary(kind), owner = context.control(kind)
        await context.change(() => owner.focus())
        let modal: HTMLDialogElement | undefined
        if (guard === 'background') context.foreground(false)
        else if (guard === 'hidden-summary') summary.hidden = true
        else {
          modal = context.document.createElement('dialog')
          modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true')
          context.document.body.append(modal); modal.showModal()
        }
        context.focusCalls.length = 0
        await context.key(owner)
        assert.equal(context.menu(kind).open, false)
        assert.equal(context.focusCalls.length, 0)
        context.foreground(true); summary.hidden = false; modal?.remove()
        context.assertPreserved(before)
      }
      await context.open(kind)
      await context.change(() => context.control(kind).focus())
      context.focusCalls.length = 0
      await context.show(false)
      assert.equal(context.document.querySelectorAll('.dbw-toolbar-menu').length, 0)
      assert.equal(context.focusCalls.length, 0)
      const outside = context.document.querySelector<HTMLInputElement>('#outside')!
      await context.change(() => outside.focus())
      await context.show(true)
      assert.equal(context.document.activeElement === outside, true)
      assert.equal(context.menu('filter').open, false)
      assert.equal(context.menu('sort').open, false)
      context.assertPreserved(before)
    })
  }
})
