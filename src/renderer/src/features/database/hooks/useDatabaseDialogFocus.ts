import { useEffect, useRef, type RefObject } from 'react'
import { isImeKeyboardEvent } from '../../../utils/imeKeyboard'

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  'summary',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

export function useDatabaseDialogFocus({
  containerRef,
  initialFocusRef,
  onClose,
  open,
  returnFocusTarget,
  canReturnFocus
}: {
  containerRef: RefObject<HTMLElement | null>
  initialFocusRef?: RefObject<HTMLElement | null>
  onClose: () => void
  open: boolean
  returnFocusTarget?: HTMLElement | null
  canReturnFocus?: () => boolean
}) {
  const closeHandlerRef = useRef(onClose)
  closeHandlerRef.current = onClose
  const returnTargetRef = useRef(returnFocusTarget)
  returnTargetRef.current = returnFocusTarget
  const returnGuardRef = useRef(canReturnFocus)
  returnGuardRef.current = canReturnFocus
  const mounted = useRef(false)
  const cancelReturnFocusRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelReturnFocusRef.current?.()
      cancelReturnFocusRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!open) return
    cancelReturnFocusRef.current?.()
    cancelReturnFocusRef.current = null
    const container = containerRef.current
    const previousFocus = returnTargetRef.current === undefined
      ? document.activeElement instanceof HTMLElement ? document.activeElement : null
      : returnTargetRef.current
    const cancelInitialFocus = scheduleInitialFocus(containerRef, initialFocusRef)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeKeyboardEvent(event)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        closeHandlerRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = focusableElements(containerRef.current)
      if (focusable.length === 0) {
        event.preventDefault()
        containerRef.current?.focus()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement
      if (event.shiftKey && (active === first || !containerRef.current?.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !containerRef.current?.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      cancelInitialFocus()
      window.removeEventListener('keydown', handleKeyDown)
      if (!mounted.current || !previousFocus || returnGuardRef.current?.() === false || !document.hasFocus()) return
      const cancelReturnFocus = queueDialogFocus(() => {
        if (!mounted.current || returnGuardRef.current?.() === false || !document.hasFocus()) return
        if (!isVisible(previousFocus) || previousFocus.matches(':disabled, [aria-disabled="true"]')) return
        if ([...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
          .some(dialog => dialog !== container && isVisible(dialog))) return
        const active = document.activeElement
        if (active !== document.body && active !== previousFocus && !container?.contains(active)) return
        previousFocus.focus({ preventScroll: true })
      }, () => {
        if (cancelReturnFocusRef.current === cancelReturnFocus) cancelReturnFocusRef.current = null
      })
      cancelReturnFocusRef.current = cancelReturnFocus
    }
  }, [containerRef, initialFocusRef, open])
}

function scheduleInitialFocus(
  containerRef: RefObject<HTMLElement | null>,
  initialFocusRef?: RefObject<HTMLElement | null>
): () => void {
  const container = containerRef.current
  const openingActive = document.activeElement
  if (!container || !document.hasFocus() || !isVisible(container)
    || (openingActive instanceof HTMLElement && container.contains(openingActive)
      && isVisible(openingActive) && !openingActive.matches(':disabled, [aria-disabled="true"]'))) return () => {}

  return queueDialogFocus(() => {
    if (containerRef.current !== container || !document.hasFocus() || !isVisible(container)) return
    if ([...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [role="alertdialog"]')]
      .some(dialog => dialog !== container && isVisible(dialog))) return
    const active = document.activeElement
    if (active !== openingActive && active !== document.body) return
    const target = [initialFocusRef?.current, ...focusableElements(container), container]
      .find(element => element && container.contains(element) && isVisible(element)
        && !element.matches(':disabled, [aria-disabled="true"]'))
    target?.focus()
  })
}

function queueDialogFocus(focus: () => void, onEnd?: () => void): () => void {
  let pending = true
  let frame: number
  const cancel = () => {
    if (!pending) return
    pending = false
    cancelAnimationFrame(frame)
    document.removeEventListener('focusin', cancel, true)
    document.removeEventListener('pointerdown', cancel, true)
    document.removeEventListener('keydown', cancel, true)
    document.removeEventListener('compositionstart', cancel, true)
    window.removeEventListener('blur', cancel)
    onEnd?.()
  }
  // Deferred dialog focus yields permanently to any newer user interaction.
  document.addEventListener('focusin', cancel, true)
  document.addEventListener('pointerdown', cancel, true)
  document.addEventListener('keydown', cancel, true)
  document.addEventListener('compositionstart', cancel, true)
  window.addEventListener('blur', cancel)
  frame = requestAnimationFrame(() => {
    if (!pending) return
    cancel()
    focus()
  })
  return cancel
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  const style = window.getComputedStyle(element)
  return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return []
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
    if (element.matches(':disabled')) return false
    const style = window.getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none'
  })
}
