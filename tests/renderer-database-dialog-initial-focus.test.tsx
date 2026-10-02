import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, StrictMode, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import { useDatabaseDialogFocus } from '../src/renderer/src/features/database/hooks/useDatabaseDialogFocus'

type HarnessProps = {
  open: boolean
  autoFocusInput?: boolean
  initialDisabled?: boolean
  initialHidden?: boolean
  showInitial?: boolean
  allInputsDisabled?: boolean
  containerHidden?: boolean
  alternateReturnTarget?: boolean
  nativeContainer?: boolean
  insideNativeOwner?: boolean
  strict?: boolean
  instance?: string
}
type FocusCall = { element: HTMLElement; options?: FocusOptions }
type Context = {
  document: Document
  window: JSDOM['window']
  focusCalls: FocusCall[]
  compositions: { starts: number; ends: number }
  closeCount: () => number
  initial: () => HTMLButtonElement
  input: () => HTMLInputElement
  secondary: () => HTMLInputElement
  outside: () => HTMLInputElement
  dialog: () => HTMLElement
  change: (action: () => void) => Promise<void>
  render: (patch?: Partial<HarnessProps>) => Promise<void>
  open: (patch?: Partial<HarnessProps>) => Promise<void>
  fill: (value: string) => Promise<void>
  flushFrames: () => Promise<void>
  frameCount: () => number
  frameCallbacks: () => FrameRequestCallback[]
  foreground: (value: boolean) => void
  unmount: () => Promise<void>
}

async function withInitialFocus(run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<input id="outside" aria-label="Outside"><button id="return-target">Different return target</button><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame }
  const cancelFrame = (id: number) => { frames.delete(id) }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: requestFrame })
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: cancelFrame })
  let foreground = true
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => foreground })
  dom.window.document.body.tabIndex = -1
  // JSDOM has no layout. Connected, exposed elements have a measurable box.
  const visible = (element: HTMLElement) => element.isConnected && !element.closest('[hidden], [inert], [aria-hidden="true"]')
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rects = visible(this) ? [new dom.window.DOMRect(0, 0, 160, 32)] : []
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList
  }
  const focusCalls: FocusCall[] = []
  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) {
    focusCalls.push({ element: this, options })
    nativeFocus.call(this, options)
  }
  const compositions = { starts: 0, ends: 0 }
  let closeCount = 0
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let mounted = true
  let props: HarnessProps = { open: false, showInitial: true, instance: 'first' }
  function Harness({ open, autoFocusInput, initialDisabled, initialHidden, showInitial, allInputsDisabled, containerHidden, alternateReturnTarget, nativeContainer, insideNativeOwner }: HarnessProps) {
    const containerRef = useRef<HTMLElement | null>(null)
    const initialRef = useRef<HTMLButtonElement | null>(null)
    const [draft, setDraft] = useState('Original text')
    useDatabaseDialogFocus({ containerRef, initialFocusRef: initialRef, open, onClose: () => { closeCount++ },
      returnFocusTarget: alternateReturnTarget ? dom.window.document.getElementById('return-target') : undefined,
      // This suite isolates opening. Return-focus leases have their own existing tests.
      canReturnFocus: () => false })
    if (!open) return null
    const content = createElement(nativeContainer ? 'dialog' : 'section', { 'aria-label': 'Test database dialog', 'aria-modal': true, role: 'dialog', hidden: containerHidden, ref: containerRef, tabIndex: -1, open: nativeContainer ? true : undefined },
      showInitial ? createElement('button', { id: 'initial-close', disabled: initialDisabled, hidden: initialHidden, ref: initialRef, type: 'button' }, 'Close') : null,
      createElement('input', { id: 'draft-input', 'aria-label': 'Draft', autoFocus: autoFocusInput, disabled: allInputsDisabled, value: draft,
        onChange: (event: { target: HTMLInputElement }) => setDraft(event.target.value),
        onCompositionStart: () => { compositions.starts++ }, onCompositionEnd: () => { compositions.ends++ } }),
      createElement('input', { id: 'secondary-input', 'aria-label': 'Secondary', disabled: allInputsDisabled }))
    return insideNativeOwner ? createElement('dialog', { id: 'native-owner', open: true }, content) : content
  }
  const change = async (action: () => void) => { await act(async () => action()) }
  const render = async (patch: Partial<HarnessProps> = {}) => {
    props = { ...props, ...patch }
    await act(async () => {
      const content = createElement(Harness, { ...props, key: props.instance })
      root.render(props.strict ? createElement(StrictMode, null, content) : content)
    })
  }
  const initial = () => dom.window.document.getElementById('initial-close') as HTMLButtonElement
  const input = () => dom.window.document.getElementById('draft-input') as HTMLInputElement
  const secondary = () => dom.window.document.getElementById('secondary-input') as HTMLInputElement
  const outside = () => dom.window.document.getElementById('outside') as HTMLInputElement
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()) } }
  try {
    await render()
    await run({ document: dom.window.document, window: dom.window, focusCalls, compositions, closeCount: () => closeCount,
      initial, input, secondary, outside, dialog: () => dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!,
      change, render, unmount, frameCount: () => frames.size, frameCallbacks: () => [...frames.values()],
      foreground: value => { foreground = value },
      open: async patch => { await change(() => outside().focus()); await render({ ...patch, open: true }) },
      fill: async value => change(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
        input().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }),
      flushFrames: async () => change(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) }) })
  } finally {
    await unmount()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('the held initial focus frame preserves an input already focused, edited, selected and composing by the user', async () => {
  await withInitialFocus(async context => {
    await context.open()
    assert.equal(context.frameCount(), 1)
    const input = context.input()
    await context.change(() => input.focus())
    await context.fill('User draft before initial focus')
    await context.change(() => {
      input.setSelectionRange(5, 10)
      input.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true }))
    })
    assert.equal(context.document.activeElement === input, true)
    assert.equal(context.compositions.starts, 1)
    const before = context.focusCalls.length
    await context.flushFrames()
    assert.equal(context.document.activeElement === input, true, 'An overdue opening frame must not move the user from Draft to Close')
    assert.equal(context.focusCalls.length, before, 'Opening must not even attempt a second focus after user interaction')
    assert.equal(input.value, 'User draft before initial focus')
    assert.equal(input.selectionStart, 5)
    assert.equal(input.selectionEnd, 10)
    assert.equal(context.compositions.ends, 0)
  })
})

test('an untouched opening focuses the initial control once, while existing internal autoFocus is preserved', async () => {
  await withInitialFocus(async context => {
    await context.open()
    assert.equal(context.document.activeElement === context.outside(), true)
    assert.equal(context.frameCount(), 1)
    const before = context.focusCalls.length
    await context.flushFrames()
    assert.equal(context.document.activeElement === context.initial(), true)
    assert.equal(context.focusCalls.length, before + 1)
    await context.flushFrames()
    assert.equal(context.focusCalls.length, before + 1, 'The opening lease is consumed once')
  })
  await withInitialFocus(async context => {
    await context.open({ autoFocusInput: true })
    const input = context.input()
    assert.equal(context.document.activeElement === input, true)
    assert.equal(context.frameCount(), 0, 'Internal autoFocus should not schedule a competing initialization')
    const before = context.focusCalls.length
    await context.flushFrames()
    assert.equal(context.focusCalls.length, before)
    assert.equal(context.document.activeElement === input, true)
  })
})

test('focus ABA, pointer, key and composition activity permanently revoke a pending opening focus', async () => {
  for (const activity of ['focus-aba', 'pointer', 'key', 'composition']) {
    await withInitialFocus(async context => {
      await context.open()
      const held = context.frameCallbacks()[0]
      assert.ok(held)
      await context.change(() => {
        if (activity === 'focus-aba') {
          context.input().focus()
          context.outside().focus()
        } else if (activity === 'pointer') {
          context.document.body.dispatchEvent(new context.window.Event('pointerdown', { bubbles: true }))
        } else if (activity === 'key') {
          const event = new context.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
          context.outside().dispatchEvent(event)
          assert.equal(event.defaultPrevented, false, 'Opening protection does not consume the user key')
        } else {
          context.outside().dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true }))
          context.outside().dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true }))
        }
      })
      assert.equal(context.document.activeElement === context.outside(), true)
      const before = context.focusCalls.length
      await context.flushFrames()
      assert.equal(context.focusCalls.length, before, `${activity}: initialization stays cancelled even after active focus returns to its prior value`)
      // Also protect against a callback already copied into the renderer's frame queue.
      await context.change(() => held(0))
      assert.equal(context.focusCalls.length, before, `${activity}: a late callback cannot replay the revoked lease`)
      assert.equal(context.document.activeElement === context.outside(), true)
    })
  }
})

test('background windows, blur, another visible modal and unavailable containers discard initial focus without replay', async () => {
  for (const blocker of ['background', 'window-blur', 'modal', 'hidden', 'inert', 'disconnected']) {
    await withInitialFocus(async context => {
      await context.open()
      const container = context.dialog()
      const foreignModal = context.document.createElement('section')
      await context.change(() => {
        if (blocker === 'background') context.foreground(false)
        if (blocker === 'window-blur') context.window.dispatchEvent(new context.window.Event('blur'))
        if (blocker === 'modal') {
          foreignModal.setAttribute('role', 'alertdialog')
          foreignModal.setAttribute('aria-modal', 'true')
          context.document.body.append(foreignModal)
          assert.equal(foreignModal.getClientRects().length > 0, true)
        }
        if (blocker === 'hidden') container.hidden = true
        if (blocker === 'inert') container.setAttribute('inert', '')
        if (blocker === 'disconnected') container.remove()
      })
      const retained = context.document.activeElement
      const before = context.focusCalls.length
      await context.flushFrames()
      assert.equal(context.focusCalls.length, before, `${blocker}: opening cannot attempt focus in an unavailable context`)
      assert.equal(context.document.activeElement === retained, true)
      await context.change(() => {
        context.foreground(true)
        foreignModal.remove()
        container.hidden = false
        container.removeAttribute('inert')
        if (!container.isConnected) context.document.getElementById('mount')!.append(container)
      })
      await context.render()
      await context.flushFrames()
      assert.equal(context.focusCalls.length, before, `${blocker}: removing the blocker does not restart initialization`)
      assert.equal(context.document.activeElement === retained, true)
    })
  }
})

test('closing, unmounting, reopening and keyed replacement revoke old callbacks before a new dialog initializes', async () => {
  for (const transition of ['close', 'unmount', 'reopen', 'replace']) {
    await withInitialFocus(async context => {
      await context.open()
      const oldInitial = context.initial()
      const held = context.frameCallbacks()[0]
      assert.ok(held)
      if (transition === 'unmount') await context.unmount()
      else if (transition === 'replace') await context.render({ instance: 'replacement' })
      else {
        await context.render({ open: false })
        if (transition === 'reopen') await context.open()
      }
      const retained = context.document.activeElement
      const before = context.focusCalls.length
      await context.change(() => held(0))
      assert.equal(context.focusCalls.length, before, `${transition}: a former dialog cannot focus the current context`)
      assert.equal(context.document.activeElement === retained, true)
      if (transition === 'reopen' || transition === 'replace') {
        const currentInitial = context.initial()
        assert.equal(currentInitial === oldInitial, false)
        await context.flushFrames()
        assert.equal(context.document.activeElement === currentInitial, true)
        assert.equal(context.focusCalls.slice(before).every(call => call.element === currentInitial), true)
      } else {
        await context.flushFrames()
        assert.equal(context.focusCalls.length, before)
        assert.equal(context.document.querySelectorAll('[role="dialog"]').length, 0)
      }
    })
  }
})

test('initialization excludes unavailable explicit targets and falls back to an exposed input or the dialog container', async () => {
  for (const target of ['hidden', 'disabled', 'disconnected', 'outside', 'absent', 'all-disabled']) {
    await withInitialFocus(async context => {
      await context.open({ initialHidden: target === 'hidden', initialDisabled: target === 'disabled' || target === 'all-disabled',
        showInitial: target !== 'absent', allInputsDisabled: target === 'all-disabled' })
      const unavailable = context.initial()
      await context.change(() => {
        if (target === 'disconnected') unavailable.remove()
        if (target === 'outside') context.document.body.append(unavailable)
      })
      const before = context.focusCalls.length
      await context.flushFrames()
      const expected = target === 'all-disabled' ? context.dialog() : context.input()
      assert.equal(context.document.activeElement === expected, true, `${target}: fallback must be usable and belong to the opening dialog`)
      assert.equal(context.focusCalls.length, before + 1)
      assert.equal(context.focusCalls.at(-1)!.element === expected, true)
      if (unavailable) assert.equal(context.focusCalls.slice(before).some(call => call.element === unavailable), false)
    })
  }
})

test('StrictMode opening effect replay leaves only one current initialization and preserves subsequent input interaction', async () => {
  await withInitialFocus(async context => {
    await context.open({ strict: true, instance: 'strict-dialog' })
    assert.equal(context.frameCount(), 1)
    const before = context.focusCalls.length
    await context.flushFrames()
    assert.equal(context.document.activeElement === context.initial(), true)
    assert.equal(context.focusCalls.length, before + 1)
    await context.render({ open: false })
    await context.open({ instance: 'strict-reopened' })
    await context.change(() => context.secondary().focus())
    const interacted = context.focusCalls.length
    await context.flushFrames()
    assert.equal(context.document.activeElement === context.secondary(), true)
    assert.equal(context.focusCalls.length, interacted)
  })
})

test('opening eligibility is decided at setup, independently of the configured return target', async () => {
  for (const blocker of ['background', 'hidden']) {
    await withInitialFocus(async context => {
      if (blocker === 'background') context.foreground(false)
      await context.open({ containerHidden: blocker === 'hidden' })
      assert.equal(context.frameCount(), 0, `${blocker}: an unavailable opening does not reserve future focus`)
      const before = context.focusCalls.length
      const retained = context.document.activeElement
      context.foreground(true)
      await context.render({ containerHidden: false })
      await context.flushFrames()
      assert.equal(context.focusCalls.length, before, `${blocker}: becoming available does not replay an abandoned opening`)
      assert.equal(context.document.activeElement === retained, true)
    })
  }
  await withInitialFocus(async context => {
    await context.open({ alternateReturnTarget: true })
    const returnTarget = context.document.getElementById('return-target')!
    assert.equal(context.document.activeElement === context.outside(), true)
    assert.equal(context.document.activeElement === returnTarget, false)
    assert.equal(context.frameCount(), 1)
    await context.flushFrames()
    assert.equal(context.document.activeElement === context.initial(), true, 'A separate return target must not make an untouched opening look like user movement')
  })
})

// JSDOM has no native top layer. Model only its modal-state predicate, leaving
// selector behavior and key defaults intact; Electron covers real cancel events.
function stubNativeModal(dialog: HTMLDialogElement, isModal: () => boolean) {
  const matches = dialog.matches.bind(dialog)
  Object.defineProperty(dialog, 'matches', { configurable: true, value: (selector: string) =>
    selector === ':modal' ? dialog.open && isModal() : matches(selector) })
}

test('a separate native modal owns BODY Escape and Tab without closing or focusing the database dialog underneath', async () => {
  await withInitialFocus(async context => {
    await context.open()
    await context.flushFrames()
    const nativeDialog = context.document.createElement('dialog')
    nativeDialog.open = true
    let isModal = true
    stubNativeModal(nativeDialog, () => isModal)
    context.document.body.append(nativeDialog)
    await context.change(() => context.document.body.focus())
    const before = context.focusCalls.length
    for (const key of ['Escape', 'Tab', 'Shift+Tab']) {
      const event = new context.window.KeyboardEvent('keydown', {
        key: key === 'Shift+Tab' ? 'Tab' : key, shiftKey: key === 'Shift+Tab', bubbles: true, cancelable: true
      })
      await context.change(() => context.document.body.dispatchEvent(event))
      assert.equal(event.defaultPrevented, false, `${key}: keep the native modal's default available`)
      assert.equal(context.closeCount(), 0, `${key}: the underlying form must stay open`)
      assert.equal(context.document.activeElement === context.document.body, true)
      assert.equal(context.focusCalls.length, before, `${key}: the underlying trap must not focus inert controls`)
    }

    nativeDialog.open = false
    const resumed = new context.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await context.change(() => context.document.body.dispatchEvent(resumed))
    assert.equal(resumed.defaultPrevented, true)
    assert.equal(context.closeCount(), 1, 'Closing the native modal returns Escape ownership to the existing form')

    nativeDialog.open = true
    isModal = false
    const nonmodal = new context.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await context.change(() => context.document.body.dispatchEvent(nonmodal))
    assert.equal(nonmodal.defaultPrevented, true)
    assert.equal(context.closeCount(), 2, 'An open nonmodal dialog must not disable the form Escape handler')
    const tab = new context.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await context.change(() => context.document.body.dispatchEvent(tab))
    assert.equal(tab.defaultPrevented, true)
    assert.equal(context.document.activeElement === context.initial(), true)
  })
})

test('a native modal containing the hook container retains its own Escape and Tab handlers', async () => {
  for (const nativeContainer of [true, false]) {
    await withInitialFocus(async context => {
      await context.open({ nativeContainer, insideNativeOwner: !nativeContainer })
      const nativeDialog = nativeContainer ? context.dialog() as HTMLDialogElement
        : context.document.getElementById('native-owner') as HTMLDialogElement
      stubNativeModal(nativeDialog, () => true)
      await context.change(() => context.document.body.focus())
      const escape = new context.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      await context.change(() => context.document.body.dispatchEvent(escape))
      assert.equal(escape.defaultPrevented, true)
      assert.equal(context.closeCount(), 1, 'A native container or its native ancestor is the current owner')
      const tab = new context.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      await context.change(() => context.document.body.dispatchEvent(tab))
      assert.equal(tab.defaultPrevented, true)
      assert.equal(context.document.activeElement === context.initial(), true)
    })
  }
})
