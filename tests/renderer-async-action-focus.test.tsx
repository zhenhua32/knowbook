import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, useLayoutEffect, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import { useAsyncActionFocus } from '../src/renderer/src/hooks/useAsyncActionFocus'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
type ButtonId = 'first' | 'second'
type ScopeMode = 'visible' | 'hidden' | 'inert' | 'aria-hidden' | 'display-none' | 'visibility-hidden' | 'removed'
type Request = ReturnType<typeof deferred> & { id: ButtonId }
function assertFocused(document: Document, expected: Element | null, message?: string) {
  const label = (element: Element | null) => element ? `${element.tagName}#${element.id}` : 'null'
  assert.ok(document.activeElement === expected, `${message ?? 'Unexpected focus'}: ${label(document.activeElement)}; expected ${label(expected)}`)
}
type Context = {
  document: Document; window: Window & typeof globalThis; requests: Request[];
  trigger: (id?: ButtonId) => HTMLButtonElement;
  activate: (id?: ButtonId, focus?: boolean) => Promise<void>;
  settle: (action: () => void) => Promise<void>;
  focus: (element: HTMLElement) => Promise<void>;
  invoke: (trigger: HTMLElement, action: () => void | Promise<unknown>, fallback?: () => HTMLElement | null) => Promise<void>;
  held: (id: ButtonId, disabled: boolean) => Promise<void>;
  holdNow: (id: ButtonId, disabled: boolean) => void;
  scope: (mode: ScopeMode) => Promise<void>;
  modal: (visible: boolean) => Promise<void>;
  fallbackDisabled: (disabled: boolean) => Promise<void>;
  removeAfterSuccess: (id: ButtonId) => void;
  fallback: (target: 'url' | 'outside' | 'none') => void;
  mode: (mode: 'deferred' | 'resolved' | 'throw') => void;
  documentFocus: (focused: boolean) => void;
  commits: () => Promise<void>;
  unmount: () => Promise<void>;
  executed: () => number;
}

async function withFocus(run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  let documentFocused = true
  Object.defineProperty(dom.window.document, 'hasFocus', { value: () => documentFocused, configurable: true })
  // JSDOM has no layout. Give only connected, visibly rendered controls a rectangle.
  dom.window.HTMLElement.prototype.getClientRects = function () {
    let element: HTMLElement | null = this
    if (!element.isConnected) return [] as unknown as DOMRectList
    while (element) {
      const style = dom.window.getComputedStyle(element)
      if (element.hidden || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
        return [] as unknown as DOMRectList
      }
      element = element.parentElement
    }
    return [new dom.window.DOMRect(0, 0, 240, 32)] as unknown as DOMRectList
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const requests: Request[] = []
  const remove = new Set<ButtonId>()
  let fallbackTarget: 'url' | 'outside' | 'none' = 'url'
  let actionMode: 'deferred' | 'resolved' | 'throw' = 'deferred'
  let executed = 0
  let mounted = true
  let runWithFocus!: ReturnType<typeof useAsyncActionFocus>
  let setHeld!: React.Dispatch<React.SetStateAction<Record<ButtonId, boolean>>>
  let setScope!: React.Dispatch<React.SetStateAction<ScopeMode>>
  let setModal!: React.Dispatch<React.SetStateAction<boolean>>
  let setFallbackDisabled!: React.Dispatch<React.SetStateAction<boolean>>
  function Harness() {
    const scopeRef = useRef<HTMLElement | null>(null)
    runWithFocus = useAsyncActionFocus(scopeRef)
    const [busy, setBusy] = useState({ first: false, second: false })
    const [held, updateHeld] = useState({ first: false, second: false })
    const [present, setPresent] = useState({ first: true, second: true })
    const [scopeMode, updateScope] = useState<ScopeMode>('visible')
    const [modalVisible, updateModal] = useState(false)
    const [fallbackDisabled, updateFallbackDisabled] = useState(false)
    const [error, setError] = useState('')
    setHeld = updateHeld
    setScope = updateScope
    setModal = updateModal
    setFallbackDisabled = updateFallbackDisabled
    useLayoutEffect(() => {
      // Chrome blurs a focused control on disable; JSDOM needs this native-behaviour shim.
      const active = dom.window.document.activeElement
      if (active instanceof dom.window.HTMLElement && active.matches(':disabled')) {
        // JSDOM also skips blur() for disabled controls; make the native blur happen before restoring disabled.
        const disabled = active.hasAttribute('disabled')
        if (disabled) active.removeAttribute('disabled')
        active.blur()
        if (disabled) active.setAttribute('disabled', '')
      }
    })
    const action = (id: ButtonId): void | Promise<unknown> => {
      executed++
      setBusy(current => ({ ...current, [id]: true }))
      if (actionMode === 'throw') {
        setError('The provider handled a synchronous failure')
        setBusy(current => ({ ...current, [id]: false }))
        throw new Error('Synchronous action failure')
      }
      const pending = { ...deferred(), id }
      requests.push(pending)
      if (actionMode === 'resolved') pending.resolve()
      return pending.promise.then(() => {
        if (remove.has(id)) setPresent(current => ({ ...current, [id]: false }))
      }, error => {
        setError('The provider handled an asynchronous failure')
        throw error
      }).finally(() => setBusy(current => ({ ...current, [id]: false })))
    }
    const fallback = () => fallbackTarget === 'none' ? null : dom.window.document.getElementById(fallbackTarget)
    return <>
      {scopeMode !== 'removed' && <section id="scope" ref={scopeRef} hidden={scopeMode === 'hidden'} inert={scopeMode === 'inert'}
        aria-hidden={scopeMode === 'aria-hidden' ? true : undefined}
        style={{ display: scopeMode === 'display-none' ? 'none' : undefined, visibility: scopeMode === 'visibility-hidden' ? 'hidden' : undefined }}>
        {present.first && <button id="first" type="button" disabled={busy.first || held.first}
          onClick={event => runWithFocus(event.currentTarget, () => action('first'), fallback)}>Save</button>}
        {present.second && <button id="second" type="button" disabled={busy.second || held.second}
          onClick={event => runWithFocus(event.currentTarget, () => action('second'), fallback)}>Reload</button>}
        <input id="url" aria-label="URL" disabled={fallbackDisabled} />
      </section>}
      <input id="outside" aria-label="Editor outside this section" />
      {modalVisible && <div role="dialog" aria-modal="true"><input id="modal-input" aria-label="Modal field" /></div>}
      <output>{error}</output>
    </>
  }
  const trigger = (id: ButtonId = 'first') => dom.window.document.getElementById(id) as HTMLButtonElement
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  try {
    await act(async () => root.render(<Harness />))
    await run({ document: dom.window.document, window: dom.window as unknown as Window & typeof globalThis, requests, trigger, unmount,
      executed: () => executed,
      focus: async element => { await act(async () => element.focus()) },
      activate: async (id = 'first', focus = true) => { await act(async () => { if (focus) trigger(id).focus(); trigger(id).click() }) },
      settle: async action => { await act(async () => action()) },
      invoke: async (trigger, action, fallback) => { await act(async () => runWithFocus(trigger, action, fallback)) },
      held: async (id, disabled) => { await act(async () => setHeld(current => ({ ...current, [id]: disabled }))) },
      holdNow: (id, disabled) => { setHeld(current => ({ ...current, [id]: disabled })) },
      scope: async mode => { await act(async () => setScope(mode)) },
      modal: async visible => { await act(async () => setModal(visible)) },
      fallbackDisabled: async disabled => { await act(async () => setFallbackDisabled(disabled)) },
      removeAfterSuccess: id => { remove.add(id) }, fallback: target => { fallbackTarget = target },
      mode: mode => { actionMode = mode }, documentFocus: focused => { documentFocused = focused },
      commits: async () => { await act(async () => root.render(<Harness />)) }
    })
  } finally {
    await unmount()
    await act(async () => requests.forEach(request => request.resolve()))
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('a focused manual action restores its enabled trigger after native disable blur and either async outcome', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withFocus(async context => {
      await context.activate()
      assert.equal(context.trigger().disabled, true)
      assertFocused(context.document, context.document.body)
      await context.settle(() => outcome === 'success' ? context.requests[0].resolve() : context.requests[0].reject(new Error('Handled action failure')))
      assert.equal(context.trigger().disabled, false)
      assertFocused(context.document, context.trigger())
      if (outcome === 'failure') assert.match(context.document.querySelector('output')!.textContent!, /provider handled/)
    })
  }
})

test('an unfocused trigger executes its action without replacing input or another section focus', async () => {
  for (const target of ['url', 'outside'] as const) {
    await withFocus(async context => {
      const input = context.document.getElementById(target)!
      await context.focus(input)
      await context.activate('first', false)
      assert.equal(context.executed(), 1)
      await context.settle(() => context.requests[0].resolve())
      assertFocused(context.document, input)
    })
  }
})

test('focus moved to an input or modal while an action runs is retained after completion', async () => {
  for (const target of ['url', 'outside', 'modal-input'] as const) {
    await withFocus(async context => {
      await context.activate()
      if (target === 'modal-input') await context.modal(true)
      const input = context.document.getElementById(target)!
      await context.focus(input)
      await context.settle(() => context.requests[0].resolve())
      assertFocused(context.document, input)
    })
  }
})

test('a new pointer or keyboard operation abandons restoration even when it does not move focus', async () => {
  for (const event of ['pointerdown', 'keydown'] as const) {
    await withFocus(async context => {
      await context.activate()
      const outside = context.document.getElementById('outside')!
      await context.settle(() => outside.dispatchEvent(event === 'keydown'
        ? new context.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })
        : new context.window.Event('pointerdown', { bubbles: true })))
      assertFocused(context.document, context.document.body)
      await context.settle(() => context.requests[0].resolve())
      assertFocused(context.document, context.document.body)
    })
  }
})

test('window blur or an unfocused document prevents a late action from restoring focus', async () => {
  for (const background of ['window-blur', 'document-unfocused'] as const) {
    await withFocus(async context => {
      await context.activate()
      if (background === 'window-blur') await context.settle(() => context.window.dispatchEvent(new context.window.Event('blur')))
      else context.documentFocus(false)
      await context.settle(() => context.requests[0].resolve())
      assertFocused(context.document, context.document.body)
      context.documentFocus(true)
      await context.commits()
      assertFocused(context.document, context.document.body, 'an abandoned background result cannot restore on a later commit')
    })
  }
})

test('an unavailable scope abandons the pending focus request and cannot resume it when shown again', async () => {
  for (const mode of ['hidden', 'inert', 'aria-hidden', 'display-none', 'visibility-hidden', 'removed'] as const) {
    await withFocus(async context => {
      await context.activate()
      await context.scope(mode)
      await context.settle(() => context.requests[0].resolve())
      assertFocused(context.document, context.document.body)
      await context.scope('visible')
      assertFocused(context.document, context.document.body)
    })
  }
})

test('a visible modal cancels a pending restoration even before its field receives focus', async () => {
  await withFocus(async context => {
    await context.activate()
    await context.modal(true)
    await context.settle(() => context.requests[0].resolve())
    assertFocused(context.document, context.document.body)
    await context.modal(false)
    assertFocused(context.document, context.document.body)
  })
})

test('an original trigger removed on successful retry restores the current fallback inside its scope', async () => {
  await withFocus(async context => {
    context.removeAfterSuccess('first')
    await context.activate()
    await context.settle(() => context.requests[0].resolve())
    assert.equal(context.document.getElementById('first'), null)
    assertFocused(context.document, context.document.getElementById('url'))
  })
})

test('a still-connected disabled original waits for a later commit instead of focusing its available fallback', async () => {
  await withFocus(async context => {
    await context.activate()
    await context.held('first', true)
    await context.settle(() => context.requests[0].resolve())
    assert.equal(context.trigger().disabled, true)
    assertFocused(context.document, context.document.body)
    await context.held('first', false)
    assertFocused(context.document, context.trigger())
  })
})

test('a removed trigger cannot use a disabled fallback until a subsequent enabled commit', async () => {
  await withFocus(async context => {
    context.removeAfterSuccess('first')
    await context.activate()
    await context.fallbackDisabled(true)
    await context.settle(() => context.requests[0].resolve())
    assertFocused(context.document, context.document.body)
    await context.fallbackDisabled(false)
    assertFocused(context.document, context.document.getElementById('url'))
  })
})

test('a later user focus move cancels restoration waiting for a disabled control to become enabled', async () => {
  await withFocus(async context => {
    await context.activate()
    await context.held('first', true)
    await context.settle(() => context.requests[0].resolve())
    const outside = context.document.getElementById('outside')!
    await context.focus(outside)
    await context.held('first', false)
    assertFocused(context.document, outside)
  })
})

test('removed-trigger fallback cannot move focus outside its scope or to a missing or hidden control', async () => {
  for (const invalid of ['outside', 'none', 'hidden'] as const) {
    await withFocus(async context => {
      context.removeAfterSuccess('first')
      if (invalid !== 'hidden') context.fallback(invalid)
      await context.activate()
      if (invalid === 'hidden') context.document.getElementById('url')!.hidden = true
      await context.settle(() => context.requests[0].resolve())
      assertFocused(context.document, context.document.body)
    })
  }
})

test('new manual actions supersede an earlier restoration and retain their own completion focus', async () => {
  await withFocus(async context => {
    await context.activate('first')
    await context.activate('second')
    await context.settle(() => context.requests[0].resolve())
    assertFocused(context.document, context.document.body)
    assert.equal(context.trigger('second').disabled, true)
    await context.settle(() => context.requests[1].resolve())
    assertFocused(context.document, context.trigger('second'))
  })
})

test('a new action without captured trigger focus also invalidates an older restoration', async () => {
  await withFocus(async context => {
    await context.activate('first')
    await context.activate('second', false)
    await context.settle(() => context.requests[0].resolve())
    assertFocused(context.document, context.document.body)
    await context.settle(() => context.requests[1].resolve())
    assertFocused(context.document, context.document.body)
  })
})

test('immediate promise success and synchronous action failure leave focus on the initiating control without unhandled errors', async () => {
  for (const mode of ['resolved', 'throw'] as const) {
    await withFocus(async context => {
      context.mode(mode)
      await context.activate()
      assert.equal(context.executed(), 1)
      assert.equal(context.trigger().disabled, false)
      assertFocused(context.document, context.trigger())
      if (mode === 'throw') assert.match(context.document.querySelector('output')!.textContent!, /synchronous failure/)
    })
  }
})

test('a void-returning action can restore after a later parent commit enables the initiating control', async () => {
  await withFocus(async context => {
    const trigger = context.trigger()
    await context.focus(trigger)
    await context.invoke(trigger, () => context.holdNow('first', true), () => context.document.getElementById('url'))
    assert.equal(trigger.disabled, true)
    assertFocused(context.document, context.document.body)
    await context.held('first', false)
    assertFocused(context.document, trigger)
  })
})

test('unmounting the scope prevents late success or failure from focusing another editor', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withFocus(async context => {
      await context.activate()
      await context.unmount()
      const editor = context.document.createElement('input')
      context.document.body.append(editor)
      editor.focus()
      await context.settle(() => outcome === 'success' ? context.requests[0].resolve() : context.requests[0].reject(new Error('Late action failure')))
      assertFocused(context.document, editor)
    })
  }
})
