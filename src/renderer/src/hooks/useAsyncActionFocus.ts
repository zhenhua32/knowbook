import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

type PendingFocus = {
  trigger: HTMLElement
  fallback?: () => HTMLElement | null
  ready: boolean
  cleanup: () => void
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getClientRects().length) return false
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return style?.display !== 'none' && style?.visibility !== 'hidden' && style?.visibility !== 'collapse'
}

function hasModal(document: Document): boolean {
  return [...document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')].some(isVisible)
}

/** Return focus after a manual action disables its control, unless the user moves on. */
export function useAsyncActionFocus(scopeRef: RefObject<HTMLElement | null>) {
  const pendingRef = useRef<PendingFocus | null>(null)
  const mountedRef = useRef(false)
  const [, render] = useState(0)
  const cancel = useCallback(() => {
    pendingRef.current?.cleanup()
    pendingRef.current = null
  }, [])

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; cancel() }
  }, [cancel])

  useLayoutEffect(() => {
    const pending = pendingRef.current
    if (!pending) return
    const scope = scopeRef.current
    const document = pending.trigger.ownerDocument
    if (!scope || !isVisible(scope) || !document.hasFocus() || hasModal(document)
      || (document.activeElement !== document.body && document.activeElement !== pending.trigger)) {
      cancel()
      return
    }
    if (!pending.ready) return
    const target = pending.trigger.isConnected ? pending.trigger : pending.fallback?.()
    if (!target || !scope.contains(target) || !isVisible(target)) { cancel(); return }
    // Busy state can clear in a later parent commit than the action promise.
    if (target.matches(':disabled') || target.getAttribute('aria-disabled') === 'true') return
    cancel()
    target.focus({ preventScroll: true })
  })

  const runWithFocus = useCallback((trigger: HTMLElement, action: () => void | Promise<unknown>, fallback?: () => HTMLElement | null): void => {
    cancel()
    const document = trigger.ownerDocument
    const scope = scopeRef.current
    let pending: PendingFocus | null = null
    if (mountedRef.current && scope?.contains(trigger) && isVisible(scope) && isVisible(trigger)
      && document.activeElement === trigger && document.hasFocus() && !hasModal(document)) {
      const abandon = () => cancel()
      const focusMoved = (event: FocusEvent) => {
        if (event.target !== trigger && event.target !== document.body) cancel()
      }
      document.addEventListener('pointerdown', abandon, true)
      document.addEventListener('keydown', abandon, true)
      document.addEventListener('focusin', focusMoved, true)
      document.defaultView?.addEventListener('blur', abandon)
      pending = { trigger, fallback, ready: false, cleanup: () => {
        document.removeEventListener('pointerdown', abandon, true)
        document.removeEventListener('keydown', abandon, true)
        document.removeEventListener('focusin', focusMoved, true)
        document.defaultView?.removeEventListener('blur', abandon)
      } }
      pendingRef.current = pending
    }
    const finish = () => {
      if (pending && mountedRef.current && pendingRef.current === pending) {
        pending.ready = true
        render(value => value + 1)
      }
    }
    // Action providers own error feedback; either outcome releases the control.
    try { void Promise.resolve(action()).then(finish, finish) }
    catch { finish() }
  }, [cancel, scopeRef])

  return runWithFocus
}
